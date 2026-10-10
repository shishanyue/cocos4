import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const engine = fileURLToPath(new URL('../../../', import.meta.url));
const runtime = join(engine, 'tools/devkit/runtime');
const rootRequire = createRequire(join(engine, 'package.json'));
const { transformSync, transformFromAstSync } = rootRequire('@babel/core');
const { parse } = rootRequire('@babel/parser');
const { prepareBytedance, loaderPlatform } = require('../runtime/prepare-bytedance.cjs');
const { prepareLoader } = require('../runtime/prepare-loader.cjs');
const { makeFixtureAssets } = require('../runtime/make-fixture-assets.cjs');
const { exerciseBytedance, startupFaults } = require('../runtime/bytedance-local-host.cjs');
const { inspectClosure, inspectScripts, readRuntime, verifyBytedance } = require('../runtime/verify-bytedance.cjs');
const { inventory } = require('../runtime/files.cjs');
const { profiles } = require('../effects/builtin-inputs.cjs');
const json = value => Buffer.from(JSON.stringify(value));

test('focused ByteDance bootstrap contracts, without engine/runtime/SDK builds', { timeout: 115000 }, async t => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'bytedance runtime-')));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const output = join(temporary, 'bootstrap');
    await mkdir(output);
    await cp(join(runtime, 'fixture'), join(output, 'template'), { recursive: true });
    const originalFixture = await readFile(join(runtime, 'fixture/src/main.ts'));
    assert.deepEqual(await prepareBytedance({ engine, output }), { loaderPlatform: 'bytedance-mini-game' });
    await makeFixtureAssets(join(output, 'template/assets'));

    await t.test('preparation copies genuine pinned adapters and ROOT configs, and preserves license metadata', async () => {
        for (const name of ['web-adapter.js', 'engine-adapter.js']) {
            assert.deepEqual(await readFile(join(output, name)), await readFile(join(engine, 'bin/adapter/minigame/bytedance', name)));
            assert.deepEqual(await readFile(join(output, name)), await readFile(join(engine, 'node_modules/@cocos/engine-platforms/bin/adapter/minigame/bytedance', name)));
        }
        const config = JSON.parse(await readFile(join(output, 'game.json')));
        assert.deepEqual(config, { ...JSON.parse(await readFile(join(engine, 'templates/bytedance-mini-game/game.json'))), deviceOrientation: 'landscape' });
        const project = JSON.parse(await readFile(join(output, 'project.config.json')));
        assert.equal(project.appid, 'tt0000000000000000');
        assert.equal(project.projectname, 'cocos4-local-validation-only');
        assert.deepEqual(project.setting, JSON.parse(await readFile(join(engine, 'templates/bytedance-mini-game/project.config.json'))).setting);
        await assert.rejects(readFile(join(output, 'platforms/bytedance/game.json')), { code: 'ENOENT' });
        assert.deepEqual(await readFile(join(output, 'licenses/bytedance/package.json')),
            await readFile(join(engine, 'node_modules/@cocos/engine-platforms/package.json')));
        assert.match(await readFile(join(output, 'licenses/bytedance/NOTICE.txt'), 'utf8'), /UNLICENSED/);
        assert.deepEqual(await readFile(join(output, 'licenses/bytedance/ENGINE-LICENSE')), await readFile(join(engine, 'LICENSE')));
        assert.deepEqual(await readFile(join(runtime, 'fixture/src/main.ts')), originalFixture);
        assert.match(await readFile(join(output, 'template/src/main.ts'), 'utf8'), /text.on\(Node.EventType.TOUCH_END/);
        assert.match(await readFile(join(output, 'fs-utils.js'), 'utf8'), /module.exports = window.fsUtils/);
        assert.doesNotMatch(await readFile(join(output, 'game.js'), 'utf8'), /\bwx\b|\bbl\b|launchSuccess/);
        const before = await inventory(output);
        await assert.rejects(prepareBytedance({ engine, output }), /already prepared/);
        assert.deepEqual(await inventory(output), before);
    });

    await t.test('preparation rejects stale adapters, changed package versions and template drift before writing', async () => {
        const snapshot = join(temporary, 'preparation-inputs');
        const target = join(temporary, 'rejected-output');
        await mkdir(target);
        const names = ['LICENSE', 'templates/bytedance-mini-game/game.ejs', 'node_modules/@cocos/engine-platforms/package.json',
            'node_modules/@cocos/engine-platforms/bin/adapter/minigame/bytedance/web-adapter.js',
            'bin/adapter/minigame/bytedance/web-adapter.js'];
        for (const name of names) {
            await mkdir(dirname(join(snapshot, name)), { recursive: true });
            await cp(join(engine, name), join(snapshot, name));
        }
        await writeFile(join(snapshot, names[4]), '// stale preparation\n');
        await assert.rejects(prepareBytedance({ engine: snapshot, output: target }), /Stale prepared ByteDance adapter/);
        await writeFile(join(snapshot, names[2]), json({ name: '@cocos/engine-platforms', version: '1.0.7' }));
        await assert.rejects(prepareBytedance({ engine: snapshot, output: target }), /before upgrading/);
        await cp(join(engine, names[2]), join(snapshot, names[2]));
        await writeFile(join(snapshot, names[1]), 'changed template');
        await assert.rejects(prepareBytedance({ engine: snapshot, output: target }), /changed Creator template/);
        assert.deepEqual(await inventory(target), []);
    });

    // Generate only the real pinned loader in an isolated copy, not a profile or engine build.
    const loaderWork = join(temporary, 'loader-work');
    await mkdir(loaderWork);
    const loader = await prepareLoader(loaderWork);
    const loaderOutput = join(temporary, 'loader.js');
    await t.test('the exact module-system platform generates the CommonJS-like warmup loader', async () => {
        const options = { out: loaderOutput, platform: loaderPlatform, minify: false, sourceMap: false, hmr: false, editor: false };
        const result = await promisify(execFile)(process.execPath,
            ['-e', `require(${JSON.stringify(join(loader, 'dist/build.js'))}).build(${JSON.stringify(options)}).catch(error => { console.error(error); process.exitCode = 1; });`],
            { cwd: loaderWork, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
        assert.doesNotMatch(result.stdout + result.stderr, /\bTS\d+\b/);
        assert.match(await readFile(loaderOutput, 'utf8'), /warmup/);
        assert.match(await readFile(loaderOutput, 'utf8'), /no-schema:/);
    });

    const files = new Map();
    for (const { path } of await inventory(output)) files.set(path, await readFile(join(output, path)));
    files.set('loader.js', await readFile(loaderOutput));
    files.set('internal-prerequisites.js', await readFile(join(runtime, 'internal-prerequisites.js')));
    files.set('import-map.json', json({ imports: { cc: './cocos-js/cc.js',
        'virtual:///prerequisite-imports/internal': './internal-prerequisites.js' } }));
    // Small contract data for the explicit cc mocks. There is deliberately no cc.js or SDK descriptor on disk.
    files.set('builtin-report.json', json({ effects: [{ uuid: 'mock-effect' }], materials: [{ uuid: 'mock-material' }] }));
    files.set('settings.json', json({ engine: { builtinAssets: ['mock-effect', 'mock-material'] }, assets: {} }));
    files.set('assets/internal/index.js', Buffer.from("'use strict';\n"));
    files.set('assets/internal/config.json', json({ name: 'internal' }));
    files.set('runtime.json', json({ profile: '2d-basic' }));
    const requiredCCExports = new Set();
    for (const file of ['main.ts', 'world.ts']) {
        const source = await readFile(join(output, 'template/src', file), 'utf8');
        const options = { filename: file, sourceType: 'module', babelrc: false, configFile: false, browserslistConfigFile: false };
        const intermediate = transformSync(source, { ...options, ast: true, code: false,
            presets: [[rootRequire.resolve('@cocos/babel-preset-cc'), { allowDeclareFields: true, onlyRemoveTypeImports: true, useDefineForClassFields: false }]] });
        for (const node of intermediate.ast.program.body) if (node.type === 'ImportDeclaration' && node.source.value === 'cc') {
            for (const specifier of node.specifiers) requiredCCExports.add(specifier.imported.name);
        }
        const { code } = transformFromAstSync(intermediate.ast, source, { ...options,
            plugins: [rootRequire.resolve('@babel/plugin-transform-modules-systemjs')] });
        files.set(`game/${file.replace('.ts', '.js')}`, Buffer.from(code));
    }
    // Emission only for these cc mocks: this test does not claim a game or engine typecheck.
    files.set('game-compiler.json', json({ requiredCCExports: [...requiredCCExports].sort() }));
    for (const name of ['rules.json', 'tile.png', 'click.wav']) files.set(`assets/game/${name}`, files.get(`template/assets/${name}`));
    assert.equal(files.has('cocos-js/cc.js'), false);

    for (const distinct of [false, true]) await t.test(`real loader/launcher/adapters/Application, ${distinct ? 'distinct' : 'shared'} globals`, async () => {
        const evidence = await exerciseBytedance(files, { distinct });
        for (const name of ['game.js', 'loader.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js',
            'game/main.js', 'game/world.js', 'assets/internal/index.js', 'internal-prerequisites.js']) assert.ok(evidence.loaded.includes(name), name);
        assert.equal(evidence.initCount, 1); assert.equal(evidence.runCount, 1);
        assert.equal(evidence.probe.restarts, 1);
        assert.ok(evidence.fileReads.includes('settings.json'));
        assert.ok(evidence.fileReads.includes('assets/game/rules.json'));
    });
    await t.test('the prepared devtools branch also bridges distinct globals', async () => {
        await exerciseBytedance(files, { distinct: true, devtools: true });
    });
    await t.test('the upstream default-wrapped import map is accepted', async () => {
        const copy = new Map(files);
        copy.set('import-map.json', json({ default: JSON.parse(files.get('import-map.json')) }));
        await exerciseBytedance(copy, { distinct: true });
    });
    await t.test('the actual loader fails without its distinct-global System bridge', async () => {
        const copy = new Map(files);
        copy.set('game.js', Buffer.from(files.get('game.js').toString().replace('if (globalThis.self !== globalThis)', 'if (false)')));
        await assert.rejects(exerciseBytedance(copy, { distinct: true }), /System is not defined/);
    });
    await t.test('startup rejects missing host, Application exports and a wrong engine import-map path', async () => {
        const errors = [];
        const context = vm.createContext({ require() { throw new Error('Host failure must precede module loading'); },
            console: { error: (...args) => errors.push(args) } });
        vm.runInContext(files.get('game.js').toString(), context);
        await assert.rejects(context.__bytedance.startup, /BYTEDANCE_HOST_REQUIRED/);
        assert.equal(context.__bytedance.state, 'failed');
        assert.equal(errors.length, 1);
        const noApplication = new Map(files);
        noApplication.set('application.js', Buffer.from('System.register([], function () { return { execute() {} }; });'));
        await assert.rejects(exerciseBytedance(noApplication), /APPLICATION_REQUIRED/);
        const wrongMap = new Map(files);
        wrongMap.set('import-map.json', json({ imports: { cc: './engine/cc.js' } }));
        await assert.rejects(exerciseBytedance(wrongMap), /BYTEDANCE_ENGINE_ENTRY_REQUIRED/);
    });
    for (const fault of Object.keys(startupFaults)) await t.test(`startup rejects the actual ${fault} failure`, async () => {
        const evidence = await exerciseBytedance(files, { distinct: true, fault });
        assert.equal(evidence.errors.length, 1);
    });

    await t.test('Application is idempotent and awaits void run plus the asynchronous main boundary', async () => {
        let Application;
        let initCount = 0;
        let startCount = 0;
        let callback;
        let releaseInit;
        let releaseStart;
        const main = { start() { ++startCount; return new Promise(resolve => { releaseStart = resolve; }); } };
        const context = { __bytedanceRequire: name => name === './game-compiler.json' ? { requiredCCExports: ['game'] } : { effects: [], materials: [] },
            System: { register(deps, declare) { declare((name, value) => { Application = value; }).execute(); }, import: async () => main } };
        vm.runInNewContext(files.get('application.js').toString(), context);
        const application = new Application();
        const cc = { game: { init() { ++initCount; return new Promise(resolve => { releaseInit = resolve; }); }, run(value) { callback = value; } } };
        const initialized = application.init(cc);
        assert.equal(application.init(cc), initialized);
        await Promise.resolve();
        assert.equal(initCount, 1);
        releaseInit(); await initialized;
        assert.equal(application.init(cc), initialized);
        let settled = false;
        const startup = application.start();
        assert.equal(application.start(), startup);
        startup.then(() => { settled = true; });
        await Promise.resolve(); assert.equal(settled, false);
        callback(); callback(); await Promise.resolve();
        assert.equal(settled, false); assert.equal(startCount, 1);
        releaseStart(); await startup;
        assert.equal(settled, true);
        assert.equal(initCount, 1);
        main.start = undefined;
        await assert.rejects(new Application().init({ game: { init() {} } }), /GAME_START_REQUIRED/);
        await assert.rejects(new Application().start(), /APPLICATION_NOT_INITIALIZED/);
    });

    // Source-only parser micro-fixtures. Never executed, written, passed to verifyBytedance or presented as engine builds.
    const flags = { CC_DEBUG: true, CC_BUILD: true, CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false,
        CC_BYTEDANCE: true, CC_MINIGAME: true, CC_WECHAT: false, CC_BILIBILI: false, CC_NODEJS: false, CC_RUNTIME_BASED: false };
    const engineSource = (values = flags, minified = false) => Buffer.from(`System.register([], function (out) {
        function defineGlobal(name, value) {}
        function shadow(out) { out('NotARealExport', null); }
        return { execute() {
            ${Object.entries(values).map(([key, value]) => `defineGlobal(${JSON.stringify(key)}, ${minified ? value ? '!0' : '!1' : value});`).join('\n')}
            out({${[...requiredCCExports].map(name => `${JSON.stringify(name)}: null`).join(',')}});
        } };
    });`);
    const scripts = new Map(files);
    scripts.set('cocos-js/cc.js', engineSource());
    const inspect = (copy = scripts, variant = 'debug', required = [...requiredCCExports]) => inspectScripts(copy, { variant, requiredCCExports: required });
    await t.test('release bootstrap formatting preserves real adapter execution and Browserify closure', async () => {
        const copy = new Map(files);
        for (const name of ['game.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js', 'internal-prerequisites.js']) {
            const { code } = transformSync(copy.get(name).toString(), { sourceType: 'script', babelrc: false, configFile: false,
                browserslistConfigFile: false, minified: true, compact: true, comments: false,
                shouldPrintComment: comment => /@license|@preserve|copyright|permission is hereby granted/i.test(comment) });
            copy.set(name, Buffer.from(code));
        }
        await exerciseBytedance(copy, { distinct: true });
        copy.set('cocos-js/cc.js', engineSource({ ...flags, CC_DEBUG: false }, true));
        assert.equal(inspect(copy, 'release').adapters['engine-adapter.js'].fsUtilsModule, 8);
    });
    await t.test('script closure includes root-bound imports and genuine Browserify fs-utils module', () => {
        const evidence = inspect();
        assert.equal(evidence.adapters['web-adapter.js'].modules, 34);
        assert.equal(evidence.adapters['engine-adapter.js'].fsUtilsModule, 8);
        assert.ok(evidence.moduleEdges.some(edge => edge.from === 'application.js' && edge.to === 'game-compiler.json'));
        assert.ok(evidence.moduleEdges.some(edge => edge.from === 'fs-utils.js' && edge.to === 'engine-adapter.js'));
        assert.throws(() => inspect(scripts, 'debug', ['NotARealExport']), /FEATURE_NOT_IN_PROFILE/);
        const release = new Map(scripts);
        release.set('cocos-js/cc.js', engineSource({ ...flags, CC_DEBUG: false }, true));
        inspect(release, 'release');
    });
    await t.test('wrong/missing/duplicate compiled target flags cannot masquerade as ByteDance', () => {
        for (const [flag, value] of [['CC_BYTEDANCE', false], ['CC_WECHAT', true], ['CC_BILIBILI', true], ['CC_JSB', true], ['CC_DEBUG', false]]) {
            const copy = new Map(scripts);
            copy.set('cocos-js/cc.js', engineSource({ ...flags, [flag]: value }));
            assert.throws(() => inspect(copy), /Wrong compiled global constant/);
        }
        const copy = new Map(scripts);
        const { CC_BYTEDANCE, ...missing } = flags;
        copy.set('cocos-js/cc.js', engineSource(missing));
        assert.throws(() => inspect(copy), /Missing compiled global constants/);
        copy.set('cocos-js/cc.js', Buffer.from(engineSource().toString().replace('function shadow', 'defineGlobal("CC_BYTEDANCE", true); function shadow')));
        assert.throws(() => inspect(copy), /Duplicate compiled global constant/);
    });
    await t.test('syntax, external modules, escaping imports, assets and embedded adapter closure fail closed', () => {
        for (const [mutate, expected] of [
            [copy => copy.set('game/world.js', Buffer.from('System.register(["unknown-package"], function () {});')), /UNKNOWN_MODULE/],
            [copy => copy.delete('game/world.js'), /MISSING_RESOURCE/],
            [copy => copy.delete('assets/game/tile.png'), /MISSING_RESOURCE/],
            [copy => copy.delete('game-compiler.json'), /MISSING_RESOURCE/],
            [copy => copy.set('game/main.js', Buffer.from('const =;')), /Unexpected token/],
            [copy => copy.set('game/main.js', Buffer.from('System.register(["../../escape.js"], function () {});')), /Unsafe module/],
            [copy => copy.set('game/main.js', Buffer.from('System.register([], function () { require("node:fs"); });')), /UNKNOWN_MODULE/],
            [copy => {
                const ast = parse(copy.get('engine-adapter.js').toString());
                const table = ast.program.body[0].expression.arguments[0];
                table.properties = table.properties.filter(property => property.key.value !== 8);
                copy.set('engine-adapter.js', Buffer.from(transformFromAstSync(ast, undefined, { babelrc: false, configFile: false }).code));
            }, /Missing bundled module 8/],
        ]) { const copy = new Map(scripts); mutate(copy); assert.throws(() => inspect(copy), expected); }
    });
    await t.test('descriptor target and ROOT config requirements reject before any engine inspection', () => {
        const descriptor = { schemaVersion: 1, kind: 'cocos4-bytedance-runtime', target: 'BYTEDANCE', mode: 'BUILD', moduleFormat: 'system',
            entry: 'game.js', engineEntry: './cocos-js/cc.js', tools: { loaderPlatform, moduleSystem: '0.0.21' }, variant: 'debug',
            compressed: false, sourceMap: false, profile: '2d-basic', features: profiles['2d-basic'],
            constants: { DEBUG: true, BUILD: true, MINIGAME: true, BYTEDANCE: true, USE_3D: false,
                HTML5: false, BILIBILI: false, WECHAT: false, NATIVE: false, JSB: false, NODEJS: false,
                EDITOR: false, PREVIEW: false, TEST: false, RUNTIME_BASED: false } };
        for (const name of ['game.json', 'project.config.json']) {
            const copy = new Map(files);
            copy.set('runtime.json', json(descriptor)); copy.delete(name);
            assert.throws(() => inspectClosure(copy), new RegExp(`MISSING_RESOURCE: ${name.replaceAll('.', '\\.')}`));
        }
        const copy = new Map(files);
        copy.set('runtime.json', json({ ...descriptor, target: 'WECHAT' }));
        assert.throws(() => inspectClosure(copy), /BYTEDANCE/);
    });
    await t.test('runtime inventory detects tampering, and missing prerequisites never produce a local report', async () => {
        const directory = join(temporary, 'inventory-input');
        await mkdir(directory);
        await writeFile(join(directory, 'payload.txt'), 'inventory fixture');
        await writeFile(join(directory, 'runtime.json'), json({ files: await inventory(directory) }));
        await readRuntime(directory);
        await writeFile(join(directory, 'payload.txt'), 'changed');
        await assert.rejects(readRuntime(directory), /integrity mismatch/);
        const report = join(temporary, 'must-not-exist');
        await assert.rejects(verifyBytedance({ runtimeDirectory: join(temporary, 'absent'), outDirectory: report }), error => {
            if (error.code === 'MODULE_NOT_FOUND') assert.match(error.message, /validate-minigame\.cjs/);
            else assert.equal(error.code, 'ENOENT');
            return true;
        });
        await assert.rejects(readFile(join(report, 'local-report.json')), { code: 'ENOENT' });
    });
});
