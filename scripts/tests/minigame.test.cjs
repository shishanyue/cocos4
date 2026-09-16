const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ts = require('typescript');
const { patchCcbuild, patches, tfigPatches } = require('../patch-ccbuild.cjs');
const { spreadPal } = require('../spread-pal.cjs');
const { spreadAdapter } = require('../spread-adapter.cjs');
const { setupExternal, required } = require('../setup-external.cjs');
const { normalizePackageLock } = require('../normalize-package-lock.cjs');
const root = path.resolve(__dirname, '../..');
const config = require('../../cc.config.json');
const ccbuildRoot = path.join(root, 'node_modules/@cocos/ccbuild');
const tfigRoot = path.dirname(require.resolve('@cocos/tfig/package.json', { paths: [path.join(ccbuildRoot, 'modules/dts-bundler/lib')] }));

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-minigame-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function snapshot(dir, prefix = '') {
    const entries = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = path.join(prefix, entry.name);
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) Object.assign(entries, snapshot(file, name));
        else entries[name] = fs.readFileSync(file).toString('base64');
    }
    return entries;
}

test('the engine source tree contains no native application or JSB implementation', () => {
    for (const relative of ['native', 'cocos/native-binding', 'cocos/physics-2d/box2d-jsb', 'scripts/native-pack-tool',
        'templates/android', 'templates/ios', 'templates/windows', 'templates/mac', 'templates/linux']) {
        assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
    }
    const pending = [path.join(root, 'cocos')];
    while (pending.length) {
        const dir = pending.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
            else assert.ok(!entry.name.endsWith('.jsb.ts'), path.join(dir, entry.name));
        }
    }
});

test('ccbuild patches cover both resource loaders and declaration discovery, and are idempotent', t => {
    const dir = fixture(t);
    write(path.join(dir, 'package.json'), JSON.stringify({ version: '2.3.21' }));
    write(path.join(dir, 'tfig/package.json'), JSON.stringify({ version: '3.3.4' }));
    for (const [source, prefix, edits] of [[ccbuildRoot, '', patches], [tfigRoot, 'tfig', tfigPatches]]) {
        for (const file of new Set(edits.map(([file]) => file))) {
            const target = path.join(dir, prefix, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(source, file), target);
        }
    }
    const allPatches = [...patches, ...tfigPatches.map(([file, ...edit]) => [path.join('tfig', file), ...edit])];
    // Test fresh-package matching even when prepare:engine already patched node_modules.
    for (const [file, before, after] of allPatches) {
        write(path.join(dir, file), fs.readFileSync(path.join(dir, file), 'utf8').replaceAll(after, before));
    }
    const pristine = snapshot(dir);
    patchCcbuild(dir, path.join(dir, 'tfig'));
    const patched = snapshot(dir);
    assert.notDeepEqual(patched, pristine);
    patchCcbuild(dir, path.join(dir, 'tfig'));
    assert.deepEqual(snapshot(dir), patched);
    for (const [file, , after, count = 1] of allPatches) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.equal(text.split(after).length - 1, count, file);
        assert.doesNotMatch(text, /native\/external/);
    }
    write(path.join(dir, 'package.json'), JSON.stringify({ version: '2.3.22' }));
    assert.throws(() => patchCcbuild(dir, path.join(dir, 'tfig')), /Review ccbuild patches/);
    write(path.join(dir, 'package.json'), JSON.stringify({ version: '2.3.21' }));
    write(path.join(dir, 'tfig/package.json'), JSON.stringify({ version: '3.3.5' }));
    assert.throws(() => patchCcbuild(dir, path.join(dir, 'tfig')), /Review tfig patches/);
    write(path.join(dir, 'tfig/package.json'), JSON.stringify({ version: '3.3.4' }));
    const [file, , after] = allPatches.at(-1);
    write(path.join(dir, file), fs.readFileSync(path.join(dir, file), 'utf8').replace(after, '// changed upstream\n'));
    const changed = snapshot(dir);
    assert.throws(() => patchCcbuild(dir, path.join(dir, 'tfig')), /patch no longer matches/);
    assert.deepEqual(snapshot(dir), changed);
});

test('declaration bundling preserves PAL aliases, cross-module private imports, templates and accessors', t => {
    const dir = fixture(t);
    const sources = {
        'pal/audio/type.d.ts': 'export interface Options { volume: number; } export enum State { PLAYING = 1 }',
        'editor.d.ts': `import { Base } from './helper';
export type InputKey = readonly [string, number];
export type KeyName = 'alpha' | 'beta';
export class Motion { name: string; }
export class Editor extends Base {}
export namespace op { function key(): import('./editor').InputKey; }`,
        'helper.d.ts': `export class Base {
motion: import('./editor').Motion;
key: import('./editor').InputKey;
state: import('pal/audio/type').State;
}`,
        'runtime.d.ts': `export interface Toggle { get enable(): boolean; set enable(value: boolean); }
export type Token = \`#\${import('./editor').KeyName}\`;
export class Player { static load(options: import('pal/audio/type').Options): void; }`,
    };
    for (const [file, text] of Object.entries(sources)) write(path.join(dir, file), text);
    const output = path.join(dir, 'bundle.d.ts');
    const { bundle } = require(tfigRoot);
    const result = bundle({
        input: Object.keys(sources).map(file => path.join(dir, file)), rootDir: dir, output,
        entries: { 'cc/editor/test': path.join(dir, 'editor.d.ts'), cc: path.join(dir, 'runtime.d.ts') },
        nonExportedSymbolDistribution: [{ sourceModule: /helper/, targetModule: 'cc' }],
    });
    write(output, result.groups[0].code);
    const consumer = path.join(dir, 'consumer.ts');
    write(consumer, `import { Toggle, Token, Player } from 'cc';
import { Editor, Motion, op } from 'cc/editor/test';
declare let toggle: Toggle;
toggle.enable = true;
const enabled: boolean = toggle.enable;
const token: Token = '#alpha';
// @ts-expect-error Template literal union must not widen.
const invalidToken: Token = '#other';
Player.load({ volume: 1 });
// @ts-expect-error PAL options must retain their real shape.
Player.load({ volume: 'loud' });
declare const editor: Editor;
const motion: Motion = editor.motion;
const key: readonly [string, number] = op.key();
// @ts-expect-error Imported tuple aliases must not become any.
const invalidKey: number = op.key();
`);
    const program = ts.createProgram([output, consumer], { target: ts.ScriptTarget.ES2017, types: [], strict: true, noEmit: true });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], result.groups[0].code);
});

test('all constant entry points reject unlisted targets and native flags', () => {
    const { StatsQuery } = require('@cocos/ccbuild');
    const manager = new StatsQuery.ConstantManager(root);
    for (const method of ['genBuildTimeConstants', 'genCCEnvConstants', 'exportStaticConstants', 'exportDynamicConstants']) {
        for (const platform of config.platforms) {
            const result = manager[method]({ platform, mode: 'BUILD', flags: { NATIVE: false, JSB: false } });
            if (typeof result === 'string') {
                assert.match(result, /export const NATIVE = false;/);
                assert.match(result, /export const JSB = false;/);
            } else {
                assert.equal(result.NATIVE, false);
                assert.equal(result.JSB, false);
                assert.equal(result[platform], true);
            }
        }
        for (const platform of ['NATIVE', 'ANDROID', 'IOS', 'OPEN_HARMONY', 'BAIDU', 'WEB_EDITOR', 'DEBUG', 'constructor']) {
            assert.throws(() => manager[method]({ platform, mode: 'BUILD' }), /Unsupported platform/);
        }
        for (const key of ['NATIVE', 'JSB']) {
            for (const value of [true, 1, 'false', null, undefined]) {
                assert.throws(() => manager[method]({ platform: 'WECHAT', mode: 'BUILD', flags: { [key]: value } }), /native flags/);
            }
            assert.throws(() => manager[method]({ platform: 'WECHAT', mode: key }), /native flags/);
        }
    }
});

test('module query classifies every configured mini-game, including WeChat, Xiaomi and Migu', async t => {
    const { ModuleQuery } = require(path.join(ccbuildRoot, 'modules/modularize/lib/module-query.js'));
    const engine = fixture(t);
    write(path.join(engine, 'cc.config.json'), JSON.stringify(config));
    write(path.join(engine, 'package.json'), JSON.stringify({ workspaces: ['module'] }));
    write(path.join(engine, 'module/package.json'), JSON.stringify({
        name: '@test/platform',
        exports: { '.': { web: './web.js', minigame: './minigame.js', native: './native.js' } },
    }));
    for (const platform of config.platforms) {
        const query = new ModuleQuery({ engine, platform });
        const group = ['HTML5', 'NODEJS'].includes(platform) ? 'web' : 'minigame';
        assert.equal(await query.resolveExport('@test/platform'), path.join(engine, 'module', `${group}.js`));
    }
    for (const platform of ['NATIVE', 'ANDROID', 'WEB_EDITOR', 'DEBUG', '0', 'constructor', 'UNKNOWN']) {
        assert.throws(() => new ModuleQuery({ engine, platform }), /Unsupported platform/);
    }
});

test('editor and preview dynamic constants are valid code and cannot enable native bindings', () => {
    const { StatsQuery } = require('@cocos/ccbuild');
    const manager = new StatsQuery.ConstantManager(root);
    for (const mode of ['EDITOR', 'PREVIEW']) {
        const source = manager.exportDynamicConstants({ platform: 'HTML5', mode });
        const host = { jsb: {}, CC_JSB: true, CC_NATIVE: true, CC_EDITOR: mode === 'EDITOR' };
        const context = { window: host, global: host };
        const script = new vm.Script(`${source.replace(/\bexport\s+/g, '')}\nglobalThis.result = { NATIVE, JSB, HTML5 };`);
        script.runInNewContext(context);
        assert.equal(context.result.NATIVE, false);
        assert.equal(context.result.JSB, false);
        assert.equal(context.result.HTML5, true);
    }
});

test('PAL and adapters cannot refill native directories; preparation is repeatable', t => {
    const engine = fixture(t);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(engine, 'node_modules'), 'dir');
    write(path.join(engine, 'pal/input/native/stale.js'), 'stale');
    write(path.join(engine, 'bin/adapter/native/stale.js'), 'stale');
    spreadPal(engine);
    spreadAdapter(engine);
    const pal = snapshot(path.join(engine, 'pal'));
    const adapters = snapshot(path.join(engine, 'bin/adapter'));
    spreadPal(engine);
    spreadAdapter(engine);
    assert.deepEqual(snapshot(path.join(engine, 'pal')), pal);
    assert.deepEqual(snapshot(path.join(engine, 'bin/adapter')), adapters);
    assert.equal(fs.existsSync(path.join(engine, 'native')), false);
    for (const file of [...Object.keys(pal), ...Object.keys(adapters)]) {
        assert.doesNotMatch(file, /(^|[\/\\])native([\/\\]|$)|(?:pacer|wasm)-native\./);
    }
    for (const group of ['minigame', 'runtime', 'nodejs']) assert.ok(fs.existsSync(path.join(engine, 'bin/adapter', group)));
    for (const group of ['web', 'minigame', 'runtime', 'nodejs']) assert.ok(fs.existsSync(path.join(engine, 'pal/env', group, 'env.js')));
    assert.match(fs.readFileSync(path.join(engine, 'pal/input/nodejs/keyboard-input.d.ts'), 'utf8'), /Pick<KeyboardEvent, 'keyCode'>/);
    assert.match(fs.readFileSync(path.join(engine, 'pal/wasm/wasm-nodejs.js'), 'utf8'), /enginePath\}\/external\//);
    assert.match(fs.readFileSync(path.join(engine, 'pal/wasm/wasm-web.js'), 'utf8'), /info\.typescript\.path/);
    const options = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions;
    const parsed = ts.convertCompilerOptionsFromJson({ ...options, allowJs: true }, root).options;
    for (const [file, content] of Object.entries(pal)) {
        if (!/\.(js|ts)$/.test(file)) continue;
        const text = Buffer.from(content, 'base64').toString();
        assert.doesNotMatch(text, /native\/external|info\.native\.path|jsb\.KeyboardEvent/);
        for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
            if (!specifier.startsWith('.') && !specifier.startsWith('@cocos/engine/')) continue;
            const resolved = ts.resolveModuleName(specifier, path.join(root, 'pal', file), parsed, ts.sys).resolvedModule;
            assert.ok(resolved, `${file} imports missing ${specifier}`);
            assert.doesNotMatch(resolved.resolvedFileName, /[\/\\]native[\/\\]|\.jsb\./);
        }
    }
});

test('configured PAL overrides exist for every platform', async () => {
    const { StatsQuery } = require('@cocos/ccbuild');
    const stats = await StatsQuery.create(root);
    for (const platform of config.platforms) {
        const context = { platform, mode: 'BUILD', buildTimeConstants: stats.constantManager.genBuildTimeConstants({ platform, mode: 'BUILD' }) };
        for (const [name, file] of Object.entries(stats.evaluateModuleOverrides(context))) {
            if (!name.startsWith('pal/')) continue;
            assert.ok(fs.existsSync(file), `${platform}: ${name} -> ${file}`);
            assert.doesNotMatch(file, /[\/\\]native[\/\\]|-native\./);
        }
    }
});

test('external offline setup replaces artifacts only, preserves source, and rejects incomplete input without changes', t => {
    const engine = fixture(t);
    const source = fixture(t);
    write(path.join(engine, 'external-config.json'), JSON.stringify(require('../../external-config.json')));
    for (const group of ['compression', 'deserialize']) write(path.join(engine, 'external', group, 'shared.js'), 'shared source');
    write(path.join(engine, 'external/emscripten/old.txt'), 'old artifact');
    write(path.join(engine, 'external/.version'), 'old version');
    // Filesystem fixtures only, never used as engine declarations or instantiated WASM.
    for (const file of required) write(path.join(source, 'emscripten', file), `fixture: ${file}`);
    write(path.join(source, 'LICENSE'), 'fixture license');
    write(path.join(source, 'compression/shared.js'), 'must not be copied');
    const original = snapshot(source);
    setupExternal({ root: engine, source });
    const installed = snapshot(path.join(engine, 'external'));
    setupExternal({ root: engine, source });
    assert.deepEqual(snapshot(path.join(engine, 'external')), installed);
    assert.deepEqual(snapshot(source), original);
    for (const group of ['compression', 'deserialize']) assert.equal(fs.readFileSync(path.join(engine, 'external', group, 'shared.js'), 'utf8'), 'shared source');
    assert.equal(fs.existsSync(path.join(engine, 'external/emscripten/old.txt')), false);
    assert.equal(fs.existsSync(path.join(engine, 'native')), false);
    assert.equal(fs.readFileSync(path.join(engine, 'external/licenses/LICENSE'), 'utf8'), 'fixture license');
    assert.match(fs.readFileSync(path.join(engine, 'external/.version'), 'utf8'), /^source:/);
    for (const relative of ['box2d/box2d.release.wasm.wasm', 'physx/phy.d.ts', 'box2d/b2.d.ts']) {
        const artifact = path.join(source, 'emscripten', relative);
        for (const invalid of ['missing', 'empty', 'directory', 'symlink']) {
            fs.rmSync(artifact, { recursive: true, force: true });
            if (invalid === 'empty') write(artifact, '');
            if (invalid === 'directory') fs.mkdirSync(artifact);
            if (invalid === 'symlink') fs.symlinkSync(path.join(source, 'LICENSE'), artifact);
            assert.throws(() => setupExternal({ root: engine, source }), /Incomplete Web external|must not contain symlinks/);
            assert.deepEqual(snapshot(path.join(engine, 'external')), installed);
        }
        fs.rmSync(artifact, { recursive: true, force: true });
        write(artifact, `fixture: ${relative}`);
    }
});

test('external setup rejects shared destination symlinks', t => {
    const engine = fixture(t);
    const source = fixture(t);
    write(path.join(engine, 'external-config.json'), JSON.stringify(require('../../external-config.json')));
    for (const file of required) write(path.join(source, 'emscripten', file), 'filesystem fixture');
    fs.symlinkSync(source, path.join(engine, 'external'), 'dir');
    const original = snapshot(source);
    assert.throws(() => setupExternal({ root: engine, source }), /shared external symlink/);
    assert.deepEqual(snapshot(source), original);
});

test('CLIs reject native targets, unknown features and unsupported flags before building', () => {
    for (const args of [['NATIVE'], ['DEBUG'], ['HTML5'], ['WECHAT', 'does-not-exist'], ['WECHAT', 'base', '--flags.NATIVE=true']]) {
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-minigame.cjs'), ...args], { encoding: 'utf8' });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Not a mini-game target|Unknown feature|Usage:/);
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/setup-external.cjs'), '--source'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
});

test('lockfile canonicalization preserves integrity and root dependencies are synchronized', () => {
    const lock = require('../../package-lock.json');
    const pkg = require('../../package.json');
    assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
    assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
    assert.deepEqual(normalizePackageLock(structuredClone(lock)), lock);
    for (const entry of Object.values(lock.packages)) {
        if (!entry.resolved) continue;
        assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\/(@[^/]+\/)?[^/]+\/-\/[^/?]+\.tgz$/);
        assert.ok(entry.integrity);
    }
    for (const name of ['@cocos/cannon', 'jest-extended', 'jest-matcher-deep-close-to']) {
        const entry = { version: '1.2.3', integrity: 'unchanged', resolved: `https://registry.npmmirror.com/${name}/download/${name}-1.2.3.tgz?cache=0` };
        const normalized = normalizePackageLock({ packages: { [`node_modules/${name}`]: entry } });
        assert.equal(normalized.packages[`node_modules/${name}`].integrity, 'unchanged');
        assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-1.2.3.tgz`);
    }
});

test('WASM test helper preserves Buffer offsets and reports the original read error', async () => {
    const filename = path.join(root, 'tests/utils/pal-wasm-testing.ts');
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const exports = {};
    const buffer = Buffer.from([9, 1, 2, 3, 9]).subarray(1, 4);
    let readError;
    vm.runInNewContext(code, {
        exports, __dirname: path.dirname(filename),
        require(name) {
            if (name === '../../pal/integrity-check') return { checkPalIntegrity() {}, withImpl() {} };
            if (name === 'node:fs') return { readFileSync(file) {
                assert.equal(file, path.join(root, 'external/fixture.wasm'));
                if (readError) throw readError;
                return buffer;
            } };
            return require(name);
        },
    });
    assert.deepEqual([...new Uint8Array(await exports.fetchBuffer('external:fixture.wasm'))], [1, 2, 3]);
    assert.equal(await exports.fetchUrl('external:fixture.wasm'), path.join(root, 'external/fixture.wasm'));
    readError = new Error('original read failure');
    await assert.rejects(exports.fetchBuffer('external:fixture.wasm'), /original read failure/);
});
