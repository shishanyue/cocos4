import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = join(engine, 'tools/devkit/runtime');
const rootRequire = createRequire(join(engine, 'package.json'));
const { prepareWechat, loaderPlatform } = require('../runtime/prepare-wechat.cjs');
const { prepareLoader } = require('../runtime/prepare-loader.cjs');
const { makeFixtureAssets } = require('../runtime/make-fixture-assets.cjs');
const { inventory } = require('../runtime/files.cjs');
const { exerciseWechat } = require('../runtime/wechat-local-host.cjs');
const { inspectClosure, inspectEngine } = require('../runtime/verify-wechat.cjs');
const execute = promisify(execFile);
let temporary;
let output;
let files;

before(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'wechat bootstrap-')));
    output = join(temporary, 'bootstrap');
    await mkdir(output);
    await cp(join(runtime, 'fixture'), join(output, 'template'), { recursive: true });
    await makeFixtureAssets(join(output, 'template/assets'));
    await prepareWechat({ engine, output });

    // Generate only the real pinned loader for this bootstrap unit test, never an engine/profile/SDK.
    const work = join(temporary, 'loader-work');
    await mkdir(work);
    const loader = await prepareLoader(work);
    const result = await execute(process.execPath, [join(runtime, 'build-stage.cjs'), 'loader', JSON.stringify({ loader,
        buildOptions: { platform: loaderPlatform, out: join(output, 'loader.js'), sourceMap: false, minify: false, hmr: false, editor: false } })],
    { cwd: work, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.doesNotMatch(result.stdout + result.stderr, /\bTS\d+\b/, 'Pinned loader compilation diagnostics');
    files = new Map();
    for (const file of await inventory(output)) files.set(file.path, await readFile(join(output, file.path)));
    for (const [file, bytes] of [...files]) if (file.startsWith('template/assets/')) files.set(file.replace('template/assets/', 'assets/game/'), bytes);

    // Syntax emission for explicit cc mocks is not a game typecheck or runtime profile build.
    const babel = rootRequire('@babel/core');
    for (const file of ['main.ts', 'world.ts']) {
        const source = files.get(`template/src/${file}`).toString();
        const options = { filename: file, sourceType: 'module', babelrc: false, configFile: false, browserslistConfigFile: false, sourceMaps: false };
        const intermediate = await babel.transformAsync(source, { ...options, ast: true, code: false,
            presets: [[rootRequire.resolve('@cocos/babel-preset-cc'), { allowDeclareFields: true, onlyRemoveTypeImports: true, useDefineForClassFields: false }]] });
        const result = await babel.transformFromAstAsync(intermediate.ast, source, { ...options,
            plugins: [rootRequire.resolve('@babel/plugin-transform-modules-systemjs')] });
        files.set(`game/${file.replace('.ts', '.js')}`, Buffer.from(result.code));
    }
    const json = (name, value) => files.set(name, Buffer.from(JSON.stringify(value)));
    // These in-memory test doubles cannot pass inspectClosure or be presented as engine evidence.
    json('runtime.json', { schemaVersion: 1, kind: 'cocos4-wechat-bootstrap-test-fixture', target: 'WECHAT', profile: '2d-basic' });
    files.set('cocos-js/cc.js', Buffer.from('throw new Error("TEST_ONLY_CC_CONTRACT_MUST_NOT_EXECUTE");'));
    json('game-compiler.json', { requiredCCExports: ['Sprite'], typeChecked: false });
    json('import-map.json', { imports: { cc: './cocos-js/cc.js' } });
    json('builtin-report.json', { effects: [{ uuid: 'test-effect' }], materials: [{ uuid: 'test-material' }] });
    json('settings.json', { engine: { builtinAssets: ['test-effect', 'test-material'] }, assets: { projectBundles: ['internal'] } });
    files.set('assets/internal/index.js', Buffer.from("'use strict';"));
    json('assets/internal/config.json', { name: 'internal', importBase: 'import', uuids: ['test-effect', 'test-material'] });
    json('assets/internal/import/te/test-effect.json', { __type__: 'cc.EffectAsset' });
    json('assets/internal/import/te/test-material.json', { __type__: 'cc.Material' });
}, { timeout: 90000 });

after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

test('preparation retains pinned adapter bytes, embedded fs-utils, test-only configs and license terms', async () => {
    assert.equal(loaderPlatform, 'wechatgame');
    assert.equal(require('@cocos/module-system/package.json').version, '0.0.21');
    for (const name of ['web-adapter.js', 'engine-adapter.js']) {
        const published = await readFile(join(engine, 'node_modules/@cocos/engine-platforms/bin/adapter/minigame/wechat', name));
        assert.ok(published.equals(files.get(name)));
        assert.ok(published.equals(await readFile(join(engine, 'bin/adapter/minigame/wechat', name))));
    }
    const game = JSON.parse(files.get('game.json'));
    const project = JSON.parse(files.get('project.config.json'));
    assert.equal(game.deviceOrientation, 'landscape');
    assert.equal(game.appId, undefined);
    assert.equal(project.compileType, 'game');
    assert.equal(project.miniprogramRoot, './');
    assert.equal(project.appid, 'wx0000000000000000');
    assert.match(project.description, /TEST_ONLY/);
    assert.equal(project.setting.useIsolateContext, true);
    assert.match(files.get('WECHAT-ADAPTER-LICENSE').toString(), /Declared package license: UNLICENSED/);
    assert.ok(files.get('WECHAT-ADAPTER-LICENSE').toString().endsWith(
        await readFile(join(engine, 'node_modules/@cocos/engine-platforms/README.md'), 'utf8')));
    assert.match(files.get('fs-utils.js').toString(), /module\.exports = fsUtils/);
    assert.match(files.get('template/src/main.ts').toString(), /text.on\(Node.EventType.TOUCH_END/);
    assert.doesNotMatch(await readFile(join(runtime, 'fixture/src/main.ts'), 'utf8'), /text.on\(Node.EventType.TOUCH_END/);
    assert.doesNotMatch(files.get('game.js').toString(), /launchSuccess|\bbl\b|requirePlugin|\.ejs/);
    const core = rootRequire('@babel/parser').parse(await readFile(join(engine, 'cocos/core/index.ts'), 'utf8'),
        { sourceType: 'module', plugins: ['typescript'] });
    assert.ok(core.program.body.some(node => node.type === 'ExportNamedDeclaration' && node.source?.value === './global-exports'
        && node.specifiers.some(item => item.exported.name === 'cclegacy')), 'Review the real engine namespace export');
    assert.throws(() => inspectClosure(files), /cocos4-wechat-runtime/, 'A mock bootstrap is not a verified engine runtime');
});

test('preparation refuses stale/missing adapters and unsupported pinned versions without emitting a launcher', async () => {
    const fake = join(temporary, 'stale-engine');
    const destination = join(temporary, 'stale-output');
    const packageRoot = join(fake, 'node_modules/@cocos/engine-platforms');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(destination);
    await cp(join(engine, 'node_modules/@cocos/engine-platforms/package.json'), join(packageRoot, 'package.json'));
    await mkdir(join(packageRoot, 'bin/adapter/minigame'), { recursive: true });
    await cp(join(engine, 'node_modules/@cocos/engine-platforms/bin/adapter/minigame/wechat'),
        join(packageRoot, 'bin/adapter/minigame/wechat'), { recursive: true });
    await mkdir(join(fake, 'bin/adapter/minigame/wechat'), { recursive: true });
    await writeFile(join(fake, 'bin/adapter/minigame/wechat/web-adapter.js'), '// stale unit fixture\n');
    await assert.rejects(prepareWechat({ engine: fake, output: destination }), /Stale prepared WeChat adapter/);
    await cp(join(packageRoot, 'bin/adapter/minigame/wechat/web-adapter.js'), join(fake, 'bin/adapter/minigame/wechat/web-adapter.js'));
    await assert.rejects(prepareWechat({ engine: fake, output: destination }), /ENOENT.*engine-adapter/);
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json')));
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...metadata, version: '999.0.0' }));
    await assert.rejects(prepareWechat({ engine: fake, output: destination }), /Review the pinned WeChat adapters/);
    await assert.rejects(readFile(join(destination, 'game.js')), { code: 'ENOENT' });
});

for (const options of [
    { distinct: false },
    { distinct: true },
    { distinct: true, separateSelf: true },
    { distinct: true, platform: 'ios' },
    { distinct: false, platform: 'devtools' },
    { distinct: true, platform: 'devtools' },
]) test(`actual WeChat loader/launcher/adapters/Application bootstrap: ${JSON.stringify(options)}`, { timeout: 15000 }, async () => {
    const result = await exerciseWechat(files, options);
    for (const file of ['game.js', 'loader.js', 'web-adapter.js', 'fs-utils.js', 'engine-adapter.js', 'application.js',
        'assets/internal/index.js', 'game/main.js', 'game/world.js']) assert.ok(result.loaded.includes(file), file);
    for (const file of ['settings.json', 'assets/internal/config.json', 'assets/game/rules.json', 'assets/game/tile.png', 'assets/game/click.wav']) {
        assert.ok(result.reads.includes(file), file);
    }
    assert.equal(result.initCalls, 1);
    assert.equal(result.runCalls, 1);
    assert.equal(result.probe.restarts, 1);
    assert.equal(result.adapterTouchEvents, 1);
    assert.deepEqual(result.errors, []);
});

test('compact launcher, Application and pinned adapters preserve the distinct-global bootstrap', async () => {
    const copy = new Map(files);
    for (const file of ['game.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js']) {
        const result = rootRequire('@babel/core').transformSync(copy.get(file).toString(), { sourceType: 'script',
            babelrc: false, configFile: false, browserslistConfigFile: false, sourceMaps: false, minified: true, compact: true, comments: false });
        assert.ok(result.code && !result.map);
        copy.set(file, Buffer.from(result.code));
    }
    const result = await exerciseWechat(copy, { distinct: true, separateSelf: true });
    assert.equal(result.phase, 'running');
    assert.equal(result.probe.restarts, 1);
});

test('engine inspection rejects wrong/missing/duplicate compiled flags and honors lexical export bindings', () => {
    const parse = source => rootRequire('@babel/parser').parse(source, { sourceType: 'script' });
    for (const variant of ['debug', 'release']) {
        const flags = { CC_DEBUG: variant === 'debug', CC_BUILD: true, CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false,
            CC_WECHAT: true, CC_BILIBILI: false, CC_BYTEDANCE: false, CC_MINIGAME: true };
        // Isolated AST inputs, never runtime files or claimed engine builds.
        const source = values => `System.register([], function (e) {
            function shadow(e) { e('NOT_A_CC_EXPORT', 1); }
            return { execute() {
                ${Object.entries(values).map(([name, value]) => `define('${name}', ${variant === 'release' ? value ? '!0' : '!1' : value});`).join('\n')}
                e({ cclegacy: {}, game: {}, assetManager: {} }); e('Sprite', class {});
            } };
        });`;
        const result = inspectEngine(parse(source(flags)), variant);
        assert.deepEqual(Object.fromEntries(result.globals), flags);
        assert.deepEqual([...result.exports].sort(), ['Sprite', 'assetManager', 'cclegacy', 'game']);
        for (const name of Object.keys(flags)) {
            assert.throws(() => inspectEngine(parse(source({ ...flags, [name]: !flags[name] })), variant),
                new RegExp(`Wrong compiled global constant: ${name}`));
        }
        const missing = { ...flags };
        delete missing.CC_WECHAT;
        assert.throws(() => inspectEngine(parse(source(missing)), variant), /Missing compiled global constants/);
        assert.throws(() => inspectEngine(parse(`${source(flags)} define('CC_WECHAT', true);`), variant), /Duplicate compiled global constant/);
        assert.throws(() => inspectEngine(parse(source(flags).replace("e('Sprite', class {})", 'e(computedExports)')), variant), /Expected static export names/);
    }
});

for (const fault of ['missing-host', 'missing-fs', 'missing-settings', 'missing-export', 'missing-builtin', 'invalid-material',
    'init', 'run', 'start-sync', 'start-async', 'missing-asset']) {
    test(`actual WeChat startup preserves rejection: ${fault}`, { timeout: 15000 }, async () => {
        const result = await exerciseWechat(files, { distinct: true, fault });
        assert.equal(result.phase, 'failed');
        assert.equal(result.errors.length, 1);
    });
}

test('actual loader fails without its pre-evaluation System bridge', async () => {
    const copy = new Map(files);
    const source = files.get('game.js').toString();
    const anchor = 'if (root === loaderGlobal) continue;';
    assert.equal(source.split(anchor).length, 2);
    copy.set('game.js', Buffer.from(source.replace(anchor, 'continue;')));
    await assert.rejects(exerciseWechat(copy, { distinct: true }), /System is not defined/);
});

test('launcher refuses to overwrite a non-configurable System binding', async () => {
    const copy = new Map(files);
    copy.set('game.js', Buffer.from("Object.defineProperty(globalThis, 'System', { value: null, configurable: false });\n" + files.get('game.js')));
    await assert.rejects(exerciseWechat(copy, { distinct: true }), /WECHAT_SYSTEM_BINDING_NOT_CONFIGURABLE/);
});

test('startup also retains non-Error rejection values without an unhandled error in its observer', async () => {
    const copy = new Map(files);
    copy.set('game.js', Buffer.from(files.get('game.js').toString().replace('await application.start();', 'await Promise.reject(null);')));
    await assert.rejects(exerciseWechat(copy), reason => reason === null);
});

test('the actual Application rejects a game module without start', async () => {
    const copy = new Map(files);
    copy.set('game/main.js', Buffer.from('System.register([], function () { return { execute() {} }; });'));
    await assert.rejects(exerciseWechat(copy), /GAME_START_REQUIRED/);
});

test('Application initializes once and keeps a Promise<void> boundary across a deferred void game.run', async () => {
    let Application;
    let callback;
    let release;
    let initCalls = 0;
    let starts = 0;
    const required = [];
    const main = { start() { ++starts; return new Promise(resolve => { release = resolve; }); } };
    vm.runInNewContext(await readFile(join(runtime, 'wechat-application.js'), 'utf8'), {
        __wechatRequire(name) {
            required.push(name);
            return name === './game-compiler.json' ? { requiredCCExports: ['game'] } : { effects: [], materials: [] };
        },
        require() { throw new Error('Application must use the root-bound __wechatRequire'); },
        System: { register(deps, declare) { declare((name, value) => { Application = value; }).execute(); }, import: async () => main },
    });
    const app = new Application();
    const cc = { game: { async init() { ++initCalls; }, run(value) { callback = value; } } };
    assert.equal(app.init(cc), app.init(cc));
    await app.init(cc);
    assert.equal(initCalls, 1);
    assert.deepEqual(required, ['./game-compiler.json', './builtin-report.json']);
    const startup = app.start();
    assert.equal(app.start(), startup);
    let settled = false;
    startup.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    callback();
    callback();
    await Promise.resolve();
    assert.equal(starts, 1);
    assert.equal(settled, false);
    release('must not escape the void boundary');
    assert.equal(await startup, undefined);
    assert.equal(settled, true);
});
