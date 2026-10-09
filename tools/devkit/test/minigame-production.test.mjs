import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const build = new URL(process.env.MINIGAME_PRODUCTION_TEST_BUILD_PREFIX ?? '../build/src/', import.meta.url);
const { validateMiniGamePackage, validateBilibiliPackage } = await import(new URL('bilibili.js', build));
const { reportSchema } = await import(new URL('contracts.js', build));
const engine = fileURLToPath(new URL('../../../', import.meta.url));
const runtime = path.join(engine, 'tools/devkit/runtime');
const rootRequire = createRequire(path.join(engine, 'package.json'));
const require = createRequire(import.meta.url);
const ts = rootRequire('typescript');
const { transformSync, transformFromAstSync } = rootRequire('@babel/core');
const { parse } = rootRequire('@babel/parser');
const traverse = rootRequire('@babel/traverse').default;
const targets = ['WECHAT', 'BYTEDANCE'];
const notices = {
    BILIBILI: [], WECHAT: ['WECHAT-ADAPTER-LICENSE'],
    BYTEDANCE: ['licenses/bytedance/package.json', 'licenses/bytedance/README.md',
        'licenses/bytedance/ENGINE-LICENSE', 'licenses/bytedance/NOTICE.txt'],
};
const adapterPins = {
    WECHAT: {
        debug: ['c0c19caf7480d07268580f9492d6376b88359eae74c5c865f01cd4cd47bbbdad', '4f3d6a3148449b899ae1b61e6b1387f8dcde8bbf4ce7422d2a8de0fff129942e'],
        release: ['77578e55a0cc02a82854ed2c64d437ff60747f2b255656b6776b8494f6f7f672', 'd0a14e7a4c8c282cbfebbdf21ab6ce1282e116c91677083c731fad09fbb9eae3'],
    },
    BYTEDANCE: {
        debug: ['6956a6256ae4a15a1b0c6dd41883acd1cba655e049681e0490f9a301f96443e3', '634012352eb5c560b26337c055ef836cd3726aba67e88e39b9afcb165ff2c56c'],
        release: ['c3b640462e708c030cb466c0c185071c09c4b67d7a1881fe04cf19b3a801b2ee', 'b26471141fa2e44f7a43106b535ac8a47dc1d1730f84e644cf58f7b1b4ee43fb'],
    },
};
const adapterNames = ['web-adapter.js', 'engine-adapter.js'];
const effect = '11111111-1111-4111-8111-111111111111';
const material = '22222222-2222-4222-8222-222222222222';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const record = (name, bytes) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) });
const fixtures = new Map();
let temporary;
let toolchainDirectory;

async function write(root, name, value) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytesOf(value), { mode: 0o600 });
}
async function contents(root, prefix = '') {
    const result = new Map();
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) for (const [file, bytes] of await contents(root, `${name}/`)) result.set(file, bytes);
        else result.set(name, await fs.readFile(path.join(root, name)));
    }
    return result;
}
async function copy(target = 'WECHAT') {
    const original = fixtures.get(target);
    const directory = await fs.mkdtemp(path.join(temporary, 'case-'));
    await fs.cp(original.directory, directory, { recursive: true });
    return { ...original, directory, expectedRuntimeFiles: original.expectedRuntimeFiles.map(item => ({ ...item })) };
}
async function rehash(options, name, value) {
    const bytes = bytesOf(value);
    await write(options.directory, name, bytes);
    const entry = options.expectedRuntimeFiles.find(item => item.path === name);
    assert.ok(entry, `Missing unit-fixture inventory entry: ${name}`);
    Object.assign(entry, record(name, bytes));
}
const json = async (options, file) => JSON.parse(await fs.readFile(path.join(options.directory, file), 'utf8'));
function rejected(code = 'ARTIFACT_INVALID', message) {
    return error => {
        assert.equal(error.code, code, error.stack);
        if (message) assert.match(error.message, message);
        assert.ok(error.message.length <= 2048);
        assert.doesNotMatch(error.message, /PROJECT_MUST_NOT_EXECUTE|SUBSTITUTE_EXECUTED|SECRET_INPUT/);
        if (error.report) {
            reportSchema.parse(error.report);
            assert.ok(Buffer.byteLength(JSON.stringify(error.report)) < 8192);
            assert.ok(error.report.items.some(item => item.status === 'failed'));
        }
        return true;
    };
}

before(async () => {
    temporary = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cocos4-production-unit-'));
    toolchainDirectory = path.join(temporary, 'toolchain');
    const parser = await fs.readFile(rootRequire.resolve('typescript'));
    assert.equal(ts.version, '4.9.5');
    assert.equal(hash(parser), '2e78d8d8d3b631646830e478dbee1ca109474840fe5ed7ca6c5b418f2e20b1a2');
    await write(toolchainDirectory, 'node_modules/typescript/lib/typescript.js', parser);
    for (const name of ['validate-bilibili.cjs', 'validate-minigame.cjs']) {
        await write(temporary, `app/${name}`, await fs.readFile(path.join(engine, 'scripts', name)));
    }
    for (const target of ['BILIBILI', ...targets]) {
        const directory = path.join(temporary, target, 'payload');
        const files = new Map();
        const set = (name, value) => files.set(name, bytesOf(value));
        // Deliberately small static-validation unit doubles, NOT an SDK/runtime profile,
        // declarations, engine build, renderer or evidence of game type checking.
        set('game.js', "require('./web-adapter.js'); require('./fs-utils.js'); require('./engine-adapter.js'); require('./loader.js'); System.import('./application.js');");
        set('application.js', "System.register([], function (exports) { return { execute() { System.import('./game/main.js'); } }; });");
        for (const name of [...adapterNames, 'fs-utils.js', 'loader.js']) set(name, "'use strict';");
        set('cocos-js/cc.js', "System.register([], function (exports) { return { execute() { exports('Node', function Node() {}); } }; });");
        set('internal-prerequisites.js', 'System.register([], function () { return { execute() {} }; });');
        set('import-map.json', { imports: { cc: './cocos-js/cc.js', 'virtual:///prerequisite-imports/internal': './internal-prerequisites.js' } });
        set('settings.json', { engine: { builtinAssets: [effect, material] },
            assets: { projectBundles: ['internal'], preloadBundles: [], preloadAssets: [] }, scripting: { scriptPackages: [] } });
        set('assets/internal/config.json', { name: 'internal', importBase: 'import', nativeBase: 'native', uuids: [effect, material], deps: [] });
        set('assets/internal/index.js', "'use strict';");
        set(`assets/internal/import/11/${effect}.json`, { __type__: 'cc.EffectAsset', _native: '.bin' });
        set(`assets/internal/native/11/${effect}.bin`, 'unit-test resource bytes');
        set(`assets/internal/import/22/${material}.json`, { __type__: 'cc.Material', _effectAsset: { __uuid__: effect } });
        set('builtin-report.json', { effects: [{ uuid: effect }], materials: [{ uuid: material }],
            files: [...files].filter(([name]) => name.startsWith('assets/')).map(([name, bytes]) => record(name, bytes)) });
        set('ENGINE-LICENSE', await fs.readFile(path.join(engine, 'LICENSE')));
        if (target !== 'BILIBILI') {
            // Use the genuine preparation path for launcher, Application, notices and the
            // published Browserify adapters; no package/project source is ever executed.
            const prepared = path.join(temporary, target, 'prepared');
            await fs.mkdir(prepared, { recursive: true });
            await fs.cp(path.join(runtime, 'fixture'), path.join(prepared, 'template'), { recursive: true });
            const helper = require(`../runtime/prepare-${target.toLowerCase()}.cjs`);
            await helper[target === 'WECHAT' ? 'prepareWechat' : 'prepareBytedance']({ engine, output: prepared });
            for (const name of ['game.js', 'application.js', 'fs-utils.js', ...adapterNames, ...notices[target]]) {
                set(name, await fs.readFile(path.join(prepared, name)));
            }
            for (const [index, name] of adapterNames.entries()) assert.equal(hash(files.get(name)), adapterPins[target].debug[index]);
        }
        const expectedRuntimeFiles = [...files].map(([name, bytes]) => record(name, bytes));
        set('game.json', target === 'BILIBILI' ? { appId: 'unit-fixture', version: '1.0' } : { deviceOrientation: 'portrait' });
        if (target !== 'BILIBILI') set('project.config.json', {
            appid: target === 'WECHAT' ? 'wxUnitFixture' : 'ttUnitFixture', compileType: 'game', miniprogramRoot: './',
        });
        const compilerOptions = { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.System };
        set('game/main.js', ts.transpileModule(`import { Node } from 'cc'; import { seed } from './world.js';
            export function start() { return new Node(seed); }
            globalThis.__productionProjectExecuted = true;
            throw new Error('PROJECT_MUST_NOT_EXECUTE');`, { compilerOptions }).outputText);
        set('game/world.js', ts.transpileModule('export const seed = 1;', { compilerOptions }).outputText);
        set('game-compiler.json', { requiredCCExports: ['Node'], outputFiles: ['main.js', 'world.js'],
            typeChecked: true, profileChecked: true, emitted: true, checkOnly: false });
        set('assets/game/custom.json', { applicationData: 'Not fixture-specific rules' });
        set('assets/game/custom.txt', 'project resource');
        for (const [name, bytes] of files) await write(directory, name, bytes);
        fixtures.set(target, { target, directory, toolchainDirectory,
            validatorFile: path.join(temporary, 'app', target === 'BILIBILI' ? 'validate-bilibili.cjs' : 'validate-minigame.cjs'),
            expectedRuntimeFiles, requiredCCExports: ['Node'], ccExports: ['Node'] });
    }
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

test('both targets accept genuine debug/release Browserify adapters without executing project or renderer source', { timeout: 120000 }, async t => {
    for (const target of targets) for (const variant of ['debug', 'release']) await t.test(`${target}/${variant}`, async () => {
        const options = await copy(target);
        if (variant === 'release') for (const name of ['game.js', 'application.js', 'fs-utils.js', ...adapterNames]) {
            const { code } = transformSync(await fs.readFile(path.join(options.directory, name), 'utf8'), {
                sourceType: 'script', babelrc: false, configFile: false, browserslistConfigFile: false,
                sourceMaps: false, minified: true, compact: true, comments: false,
                shouldPrintComment: comment => /@license|@preserve|copyright|permission is hereby granted/i.test(comment),
            });
            await rehash(options, name, code);
        }
        for (const [index, name] of adapterNames.entries()) {
            assert.equal(hash(await fs.readFile(path.join(options.directory, name))), adapterPins[target][variant][index]);
        }
        const before = await contents(options.directory);
        const result = await validateMiniGamePackage(options);
        reportSchema.parse({ summary: 'Static unit-fixture validation', ...result });
        assert.deepEqual(result.validationLevels, ['staticModuleClosure', `${target.toLowerCase()}SourcePreflight`, 'copiedResourceInventory']);
        assert.ok(result.items.some(item => item.name === `Immutable ${target} runtime` && item.status === 'passed'));
        const preflight = result.items.find(item => item.name === `${target} source preflight`);
        assert.equal(preflight.bytes, [...before.values()].reduce((sum, bytes) => sum + bytes.length, 0));
        assert.match(result.items.find(item => item.name === 'Static module closure').message, /42 bundled adapter modules; \d+ internal dependency mappings/);
        assert.match(result.items.find(item => item.code === 'RUNTIME_UNVERIFIED').message, /No project code, renderer, browser, vendor compiler or device was executed/);
        assert.ok(result.items.some(item => item.code === 'RESOURCE_LOADING_UNVERIFIED'));
        assert.equal(globalThis.__productionProjectExecuted, undefined);
        assert.deepEqual(await contents(options.directory), before);
    });
});

test('BILIBILI wrapper delegates without changing legacy levels, configuration or reporting', async () => {
    const options = fixtures.get('BILIBILI');
    const result = await validateMiniGamePackage(options);
    assert.deepEqual(await validateBilibiliPackage(options), result);
    assert.deepEqual(result.validationLevels, ['staticModuleClosure', 'bilibiliSourcePreflight', 'copiedResourceInventory']);
    const changed = await copy('BILIBILI');
    await write(changed.directory, 'project.config.json', { appid: 'wxWrongTarget' });
    await assert.rejects(validateBilibiliPackage(changed), rejected());
    await assert.rejects(validateBilibiliPackage(null), rejected('INVALID_ARGUMENTS'));
});

test('target, private tool selection and builtin-only validator dependencies fail closed', async () => {
    for (const target of [undefined, null, '', 'wechat', 'HTML5', 'WECHAT_MINI_PROGRAM', 'toString']) {
        await assert.rejects(validateMiniGamePackage({ ...fixtures.get('WECHAT'), target }), rejected('INVALID_ARGUMENTS'));
    }
    await assert.rejects(validateMiniGamePackage(null), rejected('INVALID_ARGUMENTS'));
    for (const target of targets) {
        const options = fixtures.get(target);
        for (const changes of [{ validatorFile: fixtures.get('BILIBILI').validatorFile },
            { validatorFile: path.join(options.directory, 'validate-minigame.cjs') }, { toolchainDirectory: options.directory }]) {
            await assert.rejects(validateMiniGamePackage({ ...options, ...changes }), rejected('SDK_INCOMPLETE'));
        }
    }
    const parser = path.join(temporary, 'substitute-parser');
    await write(parser, 'node_modules/typescript/lib/typescript.js', 'throw new Error("SUBSTITUTE_EXECUTED");');
    await assert.rejects(validateMiniGamePackage({ ...fixtures.get('WECHAT'), toolchainDirectory: parser }), rejected('SDK_INCOMPLETE'));
    const validatorFile = path.join(temporary, 'substitute/validate-minigame.cjs');
    for (const source of ['require("ancestor-only-package");', 'exports.validateBilibili = () => ({});']) {
        await write(path.dirname(validatorFile), path.basename(validatorFile), source);
        await assert.rejects(validateMiniGamePackage({ ...fixtures.get('WECHAT'), validatorFile }), rejected('SDK_INCOMPLETE'));
    }
    await write(path.dirname(validatorFile), path.basename(validatorFile), `exports.validateMiniGame = () => ({ target: 'BYTEDANCE', totalBytes: 0, packages: [], warnings: [] });`);
    await assert.rejects(validateMiniGamePackage({ ...fixtures.get('WECHAT'), validatorFile }), rejected('ARTIFACT_INVALID', /Canonical WeChat preflight/));
});

test('all target notices and mandatory runtime files are immutable, target-specific and inventory-bound', async t => {
    for (const target of targets) await t.test(target, async () => {
        for (const name of ['game.js', 'loader.js', 'cocos-js/cc.js', 'assets/internal/config.json', ...notices[target]]) {
            const omitted = await copy(target);
            omitted.expectedRuntimeFiles = omitted.expectedRuntimeFiles.filter(item => item.path !== name);
            await assert.rejects(validateMiniGamePackage(omitted), rejected('SDK_INCOMPLETE'));
            const missing = await copy(target);
            await fs.rm(path.join(missing.directory, name));
            await assert.rejects(validateMiniGamePackage(missing), rejected());
            const changed = await copy(target);
            await fs.appendFile(path.join(changed.directory, name), '\nchanged');
            await assert.rejects(validateMiniGamePackage(changed), rejected());
        }
        const other = target === 'WECHAT' ? 'BYTEDANCE' : 'WECHAT';
        const wrongNotice = notices[other][0];
        const options = await copy(target);
        await write(options.directory, wrongNotice, '{}');
        options.expectedRuntimeFiles.push(record(wrongNotice, Buffer.from('{}')));
        await assert.rejects(validateMiniGamePackage(options), rejected('SDK_INCOMPLETE'));
    });
});

test('project.config.json is mutable but mandatory and canonically checked for the requested target', async t => {
    for (const target of targets) await t.test(target, async () => {
        const options = await copy(target);
        const original = await json(options, 'project.config.json');
        assert.equal(options.expectedRuntimeFiles.some(item => item.path === 'project.config.json'), false);
        await write(options.directory, 'project.config.json', { ...original, projectname: 'Updated project', appid: `${target === 'WECHAT' ? 'wx' : 'tt'}Changed` });
        await write(options.directory, 'game.json', { deviceOrientation: 'landscape', networkTimeout: { request: 3000 } });
        await validateMiniGamePackage(options);
        for (const config of [{ ...original, appid: target === 'WECHAT' ? 'ttWrong' : 'wxWrong' },
            { ...original, appid: '' }, { ...original, compileType: 'miniprogram' }, { ...original, plugins: { unknown: {} } },
            { ...original, subPackages: [{ root: 'assets/game' }] }, { ...original, gameRoot: './other' },
            `{"appid":"${original.appid}","appid":"${original.appid}"}`, '{"appid":"SECRET_INPUT']) {
            await write(options.directory, 'project.config.json', config);
            await assert.rejects(validateMiniGamePackage(options), rejected('ARTIFACT_INVALID', new RegExp(`Canonical ${target === 'WECHAT' ? 'WeChat' : 'ByteDance'} preflight`)));
        }
        await fs.rm(path.join(options.directory, 'project.config.json'));
        await assert.rejects(validateMiniGamePackage(options), rejected());
        await write(options.directory, 'project.config.json', original);
        options.expectedRuntimeFiles.push(record('project.config.json', bytesOf(original)));
        await assert.rejects(validateMiniGamePackage(options), rejected('SDK_INCOMPLETE'));
    });
});

test('production allowlist rejects development payloads, wrong notices, ambiguous files and unsafe links', async () => {
    for (const name of ['runtime.json', 'engine-build.json', 'compiler-dependencies.json', 'game/main.js.map',
        'template/src/main.ts', 'types/cc.d.ts', 'node_modules/tool/index.js', 'toolchain/compiler.js', 'game/MAIN.js',
        'licenses/bytedance/NOTICE.txt', 'project.private.config.json']) {
        const options = await copy();
        await write(options.directory, name, '{}');
        await assert.rejects(validateMiniGamePackage(options), rejected());
    }
    for (const name of ['.env', 'assets/game/private.key']) {
        const options = await copy();
        await write(options.directory, name, 'private');
        await assert.rejects(validateMiniGamePackage(options), rejected('PERMISSION_DENIED'));
    }
    const symlink = await copy();
    await fs.symlink(fixtures.get('WECHAT').validatorFile, path.join(symlink.directory, 'assets/game/link.txt'));
    await assert.rejects(validateMiniGamePackage(symlink), rejected('PATH_OUTSIDE_WORKSPACE'));
    const hardlink = await copy();
    await fs.link(path.join(hardlink.directory, 'assets/game/custom.txt'), path.join(hardlink.directory, 'assets/game/link.txt'));
    await assert.rejects(validateMiniGamePackage(hardlink), rejected('PERMISSION_DENIED'));
});

test('SystemJS/CommonJS and target host aliases enforce static closure on project modules', { timeout: 120000 }, async t => {
    for (const target of targets) await t.test(target, async () => {
        for (const source of ['require("node:fs");', 'require("./missing.js");', 'require(globalThis.name);',
            'System.import("unknown");', 'System["import"]("./missing.js");', 'System.import(globalThis.name);',
            'System.import("./game/world.js", "custom-parent");', 'import("./missing.js");',
            'import "./world.js";', 'const annotation: number = 1;',
            `System.register([globalThis.name], function () { return { execute() {} }; });`,
            ...[target === 'WECHAT' ? '__wechatRequire' : '__bytedanceRequire', ...(target === 'WECHAT' ? ['__wxRequire'] : [])]
                .flatMap(name => [`globalThis.${name}('./missing.js');`, `GameGlobal[${JSON.stringify(name)}](globalThis.name);`, `${name}('./missing.js');`])]) {
            const options = await copy(target);
            await fs.appendFile(path.join(options.directory, 'game/main.js'), `\n${source}`);
            await assert.rejects(validateMiniGamePackage(options), rejected());
        }
        const valid = await copy(target);
        await fs.appendFile(path.join(valid.directory, 'game/main.js'), `\nrequire('../assets/game/custom'); System.import('./game/world.js');
            globalThis.${target === 'WECHAT' ? '__wxRequire' : '__bytedanceRequire'}('./game/world.js');`);
        await validateMiniGamePackage(valid);
        const context = await copy(target);
        await write(context.directory, 'game/main.js', 'System.register([], function (exports, context) { return { execute() { context.import("./missing.js"); } }; });');
        await assert.rejects(validateMiniGamePackage(context), rejected());
        const missing = await copy(target);
        await fs.rm(path.join(missing.directory, 'game/world.js'));
        await assert.rejects(validateMiniGamePackage(missing), rejected());
    });
});

test('Browserify mappings use lexical require bindings and cannot be rescued by external files', { timeout: 120000 }, async t => {
    for (const target of targets) await t.test(target, async () => {
        const file = 'engine-adapter.js';
        const source = await fs.readFile(path.join(fixtures.get(target).directory, file), 'utf8');
        const renamed = parse(source, { sourceType: 'script' });
        const factories = new Set(renamed.program.body[0].expression.arguments[0].properties.map(item => item.value.elements[0]));
        traverse(renamed, { Function(factory) {
            if (factories.has(factory.node)) factory.scope.rename(factory.node.params[0].name, 'require');
        } });
        const valid = await copy(target);
        const emitted = transformFromAstSync(renamed, source, { babelrc: false, configFile: false }).code;
        // Test-only mutation after the genuine pinned-adapter acceptance test above.
        await rehash(valid, file, emitted);
        await validateMiniGamePackage(valid);
        const shadow = await copy(target);
        await rehash(shadow, file, `${emitted}\n(function (require) { require('not-a-module'); })(function () {});`);
        await assert.rejects(validateMiniGamePackage(shadow), rejected());
        for (const change of ['missing-map-target', 'missing-entry', 'duplicate-module', 'unmapped-external', 'outside-factory']) {
            const options = await copy(target);
            const ast = parse(emitted, { sourceType: 'script' });
            const call = ast.program.body[0].expression;
            const table = call.arguments[0];
            const module = table.properties.find(item => item.value.elements[1].properties.length);
            const dependency = module.value.elements[1].properties[0];
            if (change === 'missing-map-target') {
                dependency.value.value = 99999;
                dependency.key.value = './assets/game/decoy.js';
                await write(options.directory, 'assets/game/decoy.js', "'use strict';");
            }
            if (change === 'missing-entry') call.arguments[2].elements[0].value = 99999;
            if (change === 'duplicate-module') table.properties.push(table.properties[0]);
            if (change === 'unmapped-external') module.value.elements[0].body.body.push(...parse('require("absent-package");').program.body);
            if (change === 'outside-factory') ast.program.body.push(...parse('require("./missing.js");').program.body);
            await rehash(options, file, transformFromAstSync(ast, emitted, { babelrc: false, configFile: false }).code);
            await assert.rejects(validateMiniGamePackage(options), rejected('ARTIFACT_INVALID',
                change === 'missing-map-target' ? /bundled dependency/ : undefined), `${target}: ${change}`);
        }
        const project = await copy(target);
        // A project-owned Browserify-looking file cannot claim trusted SDK dynamic requests.
        await fs.appendFile(path.join(project.directory, 'game/main.js'), '\n(function(require) { require(globalThis.name); })(globalThis.require);');
        await assert.rejects(validateMiniGamePackage(project), rejected());
    });
});

test('fresh compiler inventory and required/available engine exports must agree', async t => {
    for (const target of targets) await t.test(target, async () => {
        const base = fixtures.get(target);
        await assert.rejects(validateMiniGamePackage({ ...base, requiredCCExports: ['Unavailable'] }), rejected('FEATURE_NOT_IN_PROFILE'));
        await assert.rejects(validateMiniGamePackage({ ...base, ccExports: ['Node', 'Unavailable'] }), rejected('SDK_INCOMPLETE'));
        const metadata = await json(base, 'game-compiler.json');
        for (const change of [{ outputFiles: ['main.js'] }, { outputFiles: ['main.js', 'world.js', 'world.js'] },
            { requiredCCExports: [] }, { requiredCCExports: ['Node', 'Node'] }, { typeChecked: false }, { profileChecked: false },
            { emitted: false }, { checkOnly: true }]) {
            const options = await copy(target);
            await write(options.directory, 'game-compiler.json', { ...metadata, ...change });
            await assert.rejects(validateMiniGamePackage(options), rejected());
        }
        const stale = await copy(target);
        await write(stale.directory, 'game/stale.js', 'System.register([], function () { return { execute() {} }; });');
        await assert.rejects(validateMiniGamePackage(stale), rejected('ARTIFACT_INVALID', /fresh compiler inventory/));
    });
});

test('immutable resources, builtin references and fixed engine binaries remain closed; project assets stay inventoried', async t => {
    for (const target of targets) await t.test(target, async () => {
        const base = fixtures.get(target);
        const missing = await copy(target);
        await fs.rm(path.join(missing.directory, `assets/internal/native/11/${effect}.bin`));
        await assert.rejects(validateMiniGamePackage(missing), rejected());
        const invalid = await copy(target);
        const name = `assets/internal/import/22/${material}.json`;
        await rehash(invalid, name, { _effectAsset: { __uuid__: '33333333-3333-4333-8333-333333333333' } });
        const report = await json(invalid, 'builtin-report.json');
        Object.assign(report.files.find(item => item.path === name), invalid.expectedRuntimeFiles.find(item => item.path === name));
        await rehash(invalid, 'builtin-report.json', report);
        await assert.rejects(validateMiniGamePackage(invalid), rejected('ARTIFACT_INVALID', /absent asset/));
        const binary = await copy(target);
        await rehash(binary, 'cocos-js/cc.js', `${await fs.readFile(path.join(binary.directory, 'cocos-js/cc.js'), 'utf8')}\nconst binary = 'external/missing.wasm';`);
        await assert.rejects(validateMiniGamePackage(binary), rejected('ARTIFACT_INVALID', /fixed engine binary/));
        const config = await copy(target);
        const settings = await json(config, 'settings.json');
        settings.assets.preloadBundles.push('absent');
        await rehash(config, 'settings.json', settings);
        await assert.rejects(validateMiniGamePackage(config), rejected());
        const before = await validateMiniGamePackage(base);
        const custom = await copy(target);
        await write(custom.directory, 'assets/game/arbitrary.json', { url: 'https://example.invalid/dynamic-data' });
        const after = await validateMiniGamePackage(custom);
        assert.notEqual(before.items.find(item => item.name === 'Copied resource inventory').message,
            after.items.find(item => item.name === 'Copied resource inventory').message);
        assert.ok(after.items.some(item => item.code === 'RESOURCE_LOADING_UNVERIFIED'));
    });
});
