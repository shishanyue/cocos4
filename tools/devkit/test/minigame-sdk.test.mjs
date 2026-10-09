import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as sdk from '../build/src/sdk.js';
import { extractRuntimeExports, generateApiIndex } from '../build/src/api-index.js';

const require = createRequire(import.meta.url);
const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const { buildRuntime } = require('../scripts/build-runtime.cjs');
const targets = ['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE'];
const digest = '0'.repeat(64);
const record = path => ({ path, bytes: 1, sha256: digest });
const loaderPlatforms = { BILIBILI: 'bilibili', WECHAT: 'wechatgame', BYTEDANCE: 'bytedance-mini-game' };

function runtimeContract(target, profile = '2d-basic', variant = 'debug') {
    const release = variant === 'release';
    const world3d = profile === '3d-basic';
    const features = ['base', '2d', 'ui', 'audio', 'tween', 'gfx-webgl', 'gfx-webgl2', 'legacy-pipeline',
        ...(world3d ? ['3d', 'animation', 'skeletal-animation', 'primitive'] : [])];
    const assets = [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'effect' }, { uuid: '22222222-2222-4222-8222-222222222222', name: 'material' }];
    const sharedPins = release ? sdk.bilibiliReleaseBootstrapHashes : sdk.bilibiliBootstrapHashes;
    const pins = target === 'BILIBILI' ? sharedPins : { ...sdk.minigameBootstrapHashes[target][variant],
        ...Object.fromEntries(['loader.js', 'import-map.json', 'internal-prerequisites.js'].map(file => [file, sharedPins[file]])) };
    const files = ['game.js', 'game.json', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js', 'loader.js',
        'cocos-js/cc.js', 'internal-prerequisites.js', 'import-map.json', 'settings.json', 'builtin-report.json',
        'engine-build.json', 'compiler-dependencies.json', 'ENGINE-LICENSE', 'game-compiler.json', 'game/main.js', 'game/world.js',
        'assets/internal/config.json', 'assets/internal/index.js', 'assets/game/tile.png', 'assets/game/click.wav', 'assets/game/rules.json',
        'template/package.json', 'template/tsconfig.json', 'template/src/main.ts', 'template/src/world.ts', 'template/tests/contract.mjs',
        'template/assets/tile.png', 'template/assets/click.wav', 'template/assets/rules.json', 'types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts',
        ...(target === 'BILIBILI' ? [] : ['project.config.json']), ...(target === 'WECHAT' ? ['WECHAT-ADAPTER-LICENSE'] : []),
        ...(target === 'BYTEDANCE' ? ['licenses/bytedance/package.json', 'licenses/bytedance/README.md', 'licenses/bytedance/ENGINE-LICENSE', 'licenses/bytedance/NOTICE.txt'] : []),
        ...assets.map(asset => `assets/internal/import/${asset.uuid.slice(0, 2)}/${asset.uuid}.json`)]
        .map(path => ({ ...record(path), bytes: ['types/cc.d.ts', 'cocos-js/cc.js'].includes(path) ? 1024 * 1024 : 1, sha256: pins[path] ?? digest }));
    const constants = Object.fromEntries(['HTML5', 'BILIBILI', 'WECHAT', 'WECHAT_MINI_PROGRAM', 'NATIVE', 'JSB', 'EDITOR', 'EDITOR_NOT_IN_PREVIEW', 'PREVIEW', 'TEST', 'NODEJS',
        'XIAOMI', 'ALIPAY', 'TAOBAO', 'TAOBAO_MINIGAME', 'BYTEDANCE', 'OPPO', 'VIVO', 'HUAWEI', 'MIGU', 'HONOR',
        'COCOS_RUNTIME', 'SUD', 'SUDV2', 'RUNTIME_BASED', 'SUPPORT_JIT', 'SERVER_MODE', 'DEV'].map(name => [name, name === target]));
    Object.assign(constants, { MINIGAME: true, BUILD: true, USE_3D: world3d, DEBUG: !release });
    const emission = { variant, sourceMaps: false, minified: release, compact: release, comments: release ? 'license-only' : 'preserve' };
    const descriptor = { schemaVersion: 1, kind: `cocos4-${target.toLowerCase()}-runtime`, profile, target, mode: 'BUILD', variant,
        moduleFormat: 'system', sourceMap: false, compressed: release, features, constants, engineVersion: '4.0.0-alpha.34', rootLockSha256: digest, delivery: 'PREBUILT',
        entry: 'game.js', engineEntry: './cocos-js/cc.js', types: 'types/cc.d.ts', typeFiles: ['types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts'], template: 'template',
        buildOptions: { engine: { platform: target, mode: 'BUILD', moduleFormat: 'system', features,
            flags: { ...(world3d ? { USE_3D: true } : {}), DEBUG: !release, NATIVE: false, JSB: false, EDITOR: false, PREVIEW: false },
            compress: release, sourceMap: false, split: false, targets: { chrome: '100' } },
        loader: { platform: loaderPlatforms[target], sourceMap: false, minify: release, hmr: false, editor: false, minifierWorkers: 1 }, game: emission,
        bootstrap: { minified: release, sourceMaps: false, comments: emission.comments } },
        tools: { typeChecked: true, requiredCCExports: ['Node'], typescript: '4.9.5', babel: '7.19.6', preset: '@cocos/babel-preset-cc@2.2.0',
            typeChecking: { strict: true, skipLibCheck: false, skipDefaultLibCheck: false }, emission, loaderPlatform: loaderPlatforms[target], moduleSystem: '0.0.21', ccbuild: '2.3.21' },
        builtins: { report: 'builtin-report.json', reportSha256: digest, effects: [assets[0]], materials: [assets[1]] },
        gameCompiler: { dependencies: 'compiler-dependencies.json', dependencyCount: 4, entry: 'tools/devkit/runtime/compile-game.cjs', export: 'compileGame',
            sourceFiles: ['tools/devkit/runtime/compile-game.cjs', 'tools/devkit/runtime/files.cjs'], requiresEngineCheckout: true },
        validationLevels: Object.fromEntries(['engineTypecheck', 'engineBuild', 'builtinIntegrity', 'gameTypecheck', 'loaderTypecheck',
            'browserFirstFrame', 'browserInteraction', 'vendorBuild', 'device', 'portableSDK'].map((name, i) => [name, i < 5])), files };
    const probe = { ready: true, score: 0, restarts: 1, starts: 2, clicks: 0, decoratedDefault: 7, classRegistered: true,
        imageLoaded: true, jsonLoaded: true, audioLoaded: true, audioStarted: 1, audioEnded: 1, missingRejected: true, world3d, error: '' };
    const loaded = ['game.js', 'web-adapter.js', 'fs-utils.js', 'loader.js', 'application.js', 'cocos-js/cc.js', 'engine-adapter.js', 'game/main.js', 'game/world.js',
        ...(target === 'WECHAT' ? ['game.json', 'import-map.json', 'game-compiler.json', 'builtin-report.json', 'assets/internal/index.js'] : []),
        ...(target === 'BYTEDANCE' ? ['assets/internal/index.js', 'internal-prerequisites.js'] : [])];
    const reads = ['settings.json', 'assets/internal/config.json', 'assets/game/rules.json', ...(target === 'WECHAT'
        ? assets.map(asset => `assets/internal/import/${asset.uuid.slice(0, 2)}/${asset.uuid}.json`) : [])];
    const lifecycle = distinct => ({ distinct, loaded: [...loaded], errors: [], probe: { ...probe }, negativeGates: ['unknown-module', 'missing-module', 'missing-asset'],
        ...(target === 'BILIBILI' ? { launchSuccessCount: 1 } : target === 'WECHAT'
            ? { separateSelf: distinct, platform: 'android', reads: [...reads], warnings: [], initCalls: 1, runCalls: 1, phase: 'running', adapterTouchEvents: 1 }
            : { devtools: false, fileReads: [...reads], warnings: [], initCount: 1, runCount: 1 }) });
    const schema = target === 'WECHAT' ? sdk.wechatReportSchema : target === 'BYTEDANCE' ? sdk.bytedanceReportSchema : sdk.bilibiliReportSchema;
    const faults = schema.shape.evidence.shape.failures.element.shape.fault.options;
    const moduleEdges = [...(target === 'BILIBILI' ? [['application.js', 'game/main.js'], ['engine-adapter.js', 'fs-utils.js']]
        : [['application.js', 'game-compiler.json'], ['application.js', 'builtin-report.json'], ['application.js', 'game/main.js'],
            ['fs-utils.js', target === 'WECHAT' ? 'web-adapter.js' : 'engine-adapter.js']]), ['game/main.js', 'cocos-js/cc.js'], ['game/main.js', 'game/world.js'],
    ...(world3d ? [['game/world.js', 'cocos-js/cc.js']] : []),
    ...['game.json', 'web-adapter.js', ...(target === 'WECHAT' ? ['fs-utils.js'] : []), 'loader.js', 'import-map.json', 'application.js', 'cocos-js/cc.js', 'engine-adapter.js',
        ...(target === 'BYTEDANCE' ? ['fs-utils.js'] : [])].map(to => ['game.js', to]), ...(target === 'BILIBILI' ? [['web-adapter.js', 'fs-utils.js']] : [])]
        .map(([from, to]) => ({ from, to }));
    const report = { schemaVersion: 1, kind: `cocos4-${target.toLowerCase()}-local-report`, profile, runtimeSha256: digest, success: true,
        build: { target, variant, optionsSha256: sdk.hash(JSON.stringify(descriptor.buildOptions)), engineSha256: digest },
        checks: Object.fromEntries(['moduleClosure', 'canonicalPreflight', 'loaderBootstrapSharedGlobal', 'loaderBootstrapDistinctGlobal', 'entryLifecycle', 'startupFailure'].map(name => [name, true])),
        validationLevels: { vendorBuild: false, device: false }, notes: schema.shape.notes.items.map(item => item.value),
        evidence: { closure: { parsedScripts: 11, systemModules: 5, moduleEdges, resourceCount: assets.length + 5,
            engineExportCount: 1, requiredCCExportCount: 1, builtinEffects: 1, builtinMaterials: 1,
            ...(target === 'WECHAT' ? { adapterModules: { 'web-adapter.js': 35, 'engine-adapter.js': 7 },
                compiledGlobals: { CC_DEBUG: !release, CC_BUILD: true, CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false,
                    CC_WECHAT: true, CC_BILIBILI: false, CC_BYTEDANCE: false, CC_MINIGAME: true } } : {}),
            ...(target === 'BYTEDANCE' ? { adapters: { 'web-adapter.js': { modules: 34, dependencies: 54, entries: [27] },
                'engine-adapter.js': { modules: 8, dependencies: 7, entries: [7], fsUtilsModule: 8 } } } : {}) },
        preflight: { appId: 'cocos4-local-validation-only', ...(target === 'BILIBILI' ? { version: '0.0.0-local-validation' } : { target }),
            packages: [{ name: 'main', root: '', bytes: 1 }], totalBytes: 1, warnings: [] },
        shared: lifecycle(false), distinct: lifecycle(true), failures: faults.map(fault => {
            const init = Number(!['missing-host', 'missing-fs', 'missing-export', 'missing-game-config', 'invalid-game-config', 'web-adapter', 'loader', 'engine-adapter'].includes(fault));
            const run = Number(['run', 'start-sync', 'start-async', 'missing-asset'].includes(fault));
            return { fault, errors: [`[${target}] Game startup failed: expected contract failure`],
                ...(target === 'BILIBILI' ? {} : target === 'WECHAT' ? { warnings: [], loaded: ['game.js'], initCalls: init, runCalls: run, phase: 'failed' }
                    : { warnings: [], initCount: init, runCount: run }) };
        }) } };
    const rebind = () => {
        const bytes = Buffer.from(JSON.stringify(descriptor));
        report.runtimeSha256 = sdk.hash(bytes);
        report.evidence.preflight.totalBytes = report.evidence.preflight.packages[0].bytes = descriptor.files.reduce((sum, file) => sum + file.bytes, bytes.length);
        return { descriptorSha256: report.runtimeSha256, descriptorBytes: bytes.length };
    };
    return { descriptor, report, rebind, ...rebind() };
}

// Metadata-only schema inputs. No declarations, engine bundles or SDK payloads are fabricated.
function manifest(targets = ['HTML5', 'BILIBILI'], variants = ['debug'], validator = targets.some(target => ['WECHAT', 'BYTEDANCE'].includes(target))) {
    const guides = ['README.md', 'AGENTS.md', 'docs/bilibili_minigame/README.md', 'docs/plans/cocos4-mcp-devkit.md'];
    const profiles = targets.flatMap(target => variants.flatMap(variant => ['2d-basic', '3d-basic'].map(id => {
        const directory = `engine/profiles/${target}/${id}/${variant}`;
        return { id, target, variant, directory, descriptor: `${directory}/runtime.json`, exports: `${directory}/cc-exports.json`,
            features: ['base'], delivery: 'PREBUILT', validationLevels: [...sdk.runtimeValidationLevels[target]],
            [target === 'HTML5' ? 'browserReport' : 'localReport']: `${directory}/evidence/${target === 'HTML5' ? 'browser' : 'local'}-report.json` };
    })));
    return {
        schemaVersion: 1, sdkId: `sha256-${digest}`, kind: 'portable-development', engineVersion: '4.0.0-alpha.34', description: 'Contract metadata only',
        capabilities: { catalog: true, docs: true, packageValidation: validator ? ['BILIBILI', 'WECHAT', 'BYTEDANCE'] : ['BILIBILI'],
            gameDevelopment: true, gameBuild: true, preview: true, export: true },
        source: { sha256: digest, attribution: 'Contract metadata only', files: ['package.json', 'cc.config.json', 'LICENSE',
            'scripts/validate-bilibili.cjs', ...(validator ? ['scripts/validate-minigame.cjs'] : []), ...guides].map(record) },
        license: { path: 'LICENSE', spdx: 'MIT' },
        files: ['LICENSE', 'app/validate-bilibili.cjs', ...(validator ? ['app/validate-minigame.cjs'] : []),
            ...guides.map((_, i) => `docs/guide-${i}.md`)].map(record),
        catalog: { platforms: ['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE'].map(id => ({ id, engineTargetAllowed: true,
            prebuiltAvailable: targets.includes(id), exportAvailable: targets.includes(id), validationLevels: targets.includes(id) ? [...sdk.runtimeValidationLevels[id]] : [] })),
        features: [{ id: 'base', modules: ['base'], dependentModules: [], dependentAssets: [], prebuiltAvailable: true }], profiles,
        templates: profiles.map(({ id, target, variant, directory }) => ({ id: `${target === 'HTML5' ? '' : `${target.toLowerCase()}-`}${id}${variant === 'release' ? '-release' : ''}-starter`,
            profile: id, target, variant, directory: `${directory}/template` })) },
        docs: guides.map((sourcePath, i) => ({ id: `guide-${i}`, kind: 'guide', title: sourcePath, path: `docs/guide-${i}.md`, sourcePath, sourceOffset: 0 })),
        apiIndex: { ...record('docs/api-index.json'), schemaVersion: 1, symbols: 1, examples: profiles.length },
        development: { baseSdkId: `sha256-${digest}`, baseManifest: 'provenance/readonly-manifest.json', directory: 'toolchain',
            compiler: 'toolchain/compiler/compile-game.cjs', dependencies: 'toolchain/compiler-dependencies.json', inventory: 'toolchain/inventory.json', sourceLock: 'toolchain/source-lock.json',
            sourceFiles: ['compile-game.cjs', 'files.cjs'].map(name => ({ ...record(`toolchain/compiler/${name}`), sourcePath: `tools/devkit/runtime/${name}` })),
            licenseReview: 'required', missingLicenseFiles: [], node: { bundled: false, minimum: '18.20.8' } },
    };
}

test('manifest contracts retain shipped two-target shapes and accept all sixteen delivered identities', () => {
    const legacy = manifest();
    assert.equal(sdk.manifestSchema.parse(legacy).source.files.length, 8);
    const html5 = manifest(['HTML5']);
    delete html5.apiIndex;
    sdk.manifestSchema.parse(html5);
    const expanded = sdk.manifestSchema.parse(manifest(targets, ['debug', 'release']));
    assert.equal(expanded.catalog.profiles.length, 16);
    assert.equal(expanded.catalog.templates.length, 16);
    assert(expanded.catalog.templates.some(item => item.id === 'wechat-2d-basic-starter'));
    assert(expanded.catalog.templates.some(item => item.id === 'bytedance-3d-basic-release-starter'));
    assert.equal(expanded.source.files.length, 9);
    const tooMany = structuredClone(expanded);
    tooMany.catalog.profiles.push(tooMany.catalog.profiles[0]);
    assert.equal(sdk.manifestSchema.safeParse(tooMany).success, false);
});

test('every delivered target/variant needs its own 2D/3D pair and source-bound API index', () => {
    for (const target of targets) for (const variant of ['debug', 'release']) {
        const value = manifest(targets, ['debug', 'release']);
        value.catalog.profiles = value.catalog.profiles.filter(item => !(item.target === target && item.variant === variant && item.id === '3d-basic'));
        assert.equal(sdk.manifestSchema.safeParse(value).success, false, `${target}/${variant}`);
    }
    for (const selection of [['HTML5', 'BILIBILI'], ['HTML5', 'WECHAT'], ['HTML5', 'BYTEDANCE']]) {
        const value = manifest(selection);
        delete value.apiIndex;
        assert.equal(sdk.manifestSchema.safeParse(value).success, false, selection.join('/'));
    }
});

test('validator capabilities are source-bound, not claims of prebuilt profiles or vendor export', () => {
    const readonly = manifest(['HTML5'], ['debug'], true);
    readonly.kind = 'readonly-development';
    delete readonly.development;
    delete readonly.apiIndex;
    for (const name of ['gameDevelopment', 'gameBuild', 'preview', 'export']) readonly.capabilities[name] = false;
    readonly.catalog.profiles = [];
    readonly.catalog.templates = [];
    for (const platform of readonly.catalog.platforms) Object.assign(platform, { prebuiltAvailable: false, exportAvailable: false, validationLevels: [] });
    readonly.catalog.features[0].prebuiltAvailable = false;
    sdk.manifestSchema.parse(readonly);
    for (const change of [
        value => { value.files = value.files.filter(file => file.path !== 'app/validate-minigame.cjs'); },
        value => { value.source.files = value.source.files.filter(file => file.path !== 'scripts/validate-minigame.cjs'); },
        value => { value.source.files[0] = value.source.files[1]; },
        value => { value.capabilities.packageValidation = ['BILIBILI']; },
        value => { value.capabilities.packageValidation.push('WECHAT'); },
        value => { value.catalog.platforms[2].prebuiltAvailable = true; },
        value => { value.catalog.platforms[3].exportAvailable = true; },
    ]) {
        const value = structuredClone(readonly); change(value);
        assert.equal(sdk.manifestSchema.safeParse(value).success, false);
    }
    assert.equal(sdk.manifestSchema.safeParse(manifest(['HTML5', 'WECHAT'], ['debug'], false)).success, false);
});

test('mini-game profile inventory stays target-specific, bounded and separate from browser layout', () => {
    for (const target of ['BILIBILI', 'WECHAT', 'BYTEDANCE']) {
        for (const name of ['game.js', 'game.json', 'cocos-js/cc.js', 'application.js', 'fs-utils.js', 'assets/game/tile.png']) assert(sdk.runtimeFileAllowed(name, target), `${target}: ${name}`);
        assert.equal(sdk.runtimeFileAllowed('project.config.json', target), target !== 'BILIBILI');
        for (const name of ['engine/cc.js', 'index.html', 'cocos-js/fake.js', 'assets/game/unlisted.png', 'template/src/injected.ts',
            'platforms/wechat/project.config.json', '../game.js', 'Game.js', 'node_modules/foo.js', 'game.js.map']) {
            assert.equal(sdk.runtimeFileAllowed(name, target), false, `${target}: ${name}`);
        }
    }
    assert(sdk.runtimeFileAllowed('WECHAT-ADAPTER-LICENSE', 'WECHAT'));
    assert(sdk.runtimeFileAllowed('licenses/bytedance/NOTICE.txt', 'BYTEDANCE'));
    assert.equal(sdk.runtimeFileAllowed('licenses/bytedance/NOTICE.txt', 'WECHAT'), false);
    assert.equal(sdk.runtimeFileAllowed('project.config.json', 'HTML5'), false);
    assert(sdk.runtimeFileAllowed('engine/cc.js', 'HTML5'));
});

test('runtime selection rejects unsupported targets and variants before filesystem or engine work', async () => {
    for (const target of targets) await assert.rejects(buildRuntime({ target, variant: 'invalid' }), /VARIANT_NOT_AVAILABLE/);
    for (const target of ['ANDROID', 'NATIVE', 'JSB', 'OPPO', 'WECHAT_MINI_PROGRAM', 'wechat', '', null]) {
        await assert.rejects(buildRuntime({ target }), /TARGET_NOT_AVAILABLE/);
    }
});

test('new local reports bind target, variant, complete inventory, flags, adapter closure and lifecycle', () => {
    for (const target of ['WECHAT', 'BYTEDANCE']) for (const variant of ['debug', 'release']) {
        const original = runtimeContract(target, variant === 'debug' ? '2d-basic' : '3d-basic', variant);
        const validate = (descriptor = original.descriptor, report = original.report) =>
            sdk.validateMiniGameRuntime(descriptor, report, original.descriptorSha256, original.descriptorBytes);
        validate();
        for (const change of [
            value => { value.target = 'BILIBILI'; }, value => { value.kind = 'cocos4-html5-runtime'; },
            value => { value.tools.loaderPlatform = 'bilibili'; }, value => { value.buildOptions.loader.platform = 'web-desktop'; },
            value => { value.constants[target] = false; }, value => { value.constants.NATIVE = true; }, value => { value.constants.JSB = true; },
            value => { value.constants[target === 'WECHAT' ? 'BYTEDANCE' : 'WECHAT'] = true; },
            value => { value.constants.USE_3D = !value.constants.USE_3D; }, value => { value.constants.DEBUG = !value.constants.DEBUG; },
            value => { value.tools.typeChecking.skipLibCheck = true; }, value => { value.tools.typeChecking.skipDefaultLibCheck = true; },
            value => { delete value.buildOptions; },
            value => { value.files = value.files.filter(file => file.path !== 'project.config.json'); },
            value => { value.files = value.files.filter(file => file.path !== (target === 'WECHAT' ? 'WECHAT-ADAPTER-LICENSE' : 'licenses/bytedance/NOTICE.txt')); },
            value => { value.files.push(record('cocos-js/fake.js')); }, value => { value.files[0].sha256 = digest; },
            value => { value.validationLevels.device = true; }, value => { value.compressed = !value.compressed; },
        ]) { const value = structuredClone(original.descriptor); change(value); assert.throws(() => validate(value), target); }
        for (const change of [
            value => { value.kind = 'cocos4-bilibili-local-report'; }, value => { delete value.build; },
            value => { value.build.target = 'HTML5'; }, value => { value.build.variant = variant === 'debug' ? 'release' : 'debug'; },
            value => { value.runtimeSha256 = digest; }, value => { value.checks.canonicalPreflight = false; },
            value => { value.validationLevels.device = true; }, value => { value.validationLevels.browserFirstFrame = true; },
            value => { value.evidence.preflight.target = target === 'WECHAT' ? 'BYTEDANCE' : 'WECHAT'; },
            value => { value.evidence.preflight.totalBytes++; }, value => { value.evidence.closure.requiredCCExportCount++; },
            value => { value.evidence.closure.moduleEdges[0].to = 'engine/cc.js'; }, value => { value.evidence.closure.resourceCount++; },
            value => { value.evidence.closure.resourceCount = 3; },
            value => { value.evidence.shared.loaded.push('game/missing-local-negative.js'); },
            value => { value.evidence.distinct.loaded.pop(); }, value => { value.evidence.shared.probe.world3d = !value.evidence.shared.probe.world3d; },
            value => { value.evidence.failures[0] = value.evidence.failures[1]; }, value => { value.notes[0] = 'Real devices passed'; },
            value => { value.evidence.shared[target === 'WECHAT' ? 'reads' : 'fileReads'].push('outside.json'); },
            value => { value.evidence.shared[target === 'WECHAT' ? 'initCalls' : 'initCount'] = 2; },
        ]) { const value = structuredClone(original.report); change(value); assert.throws(() => validate(undefined, value), target); }
    }
});

test('legacy Bilibili descriptors keep their original optional debug evidence and exact source pins', () => {
    const value = runtimeContract('BILIBILI');
    delete value.descriptor.buildOptions;
    delete value.descriptor.tools.emission;
    delete value.report.build;
    const binding = value.rebind();
    sdk.validateBilibiliRuntime(value.descriptor, value.report, binding.descriptorSha256, binding.descriptorBytes);
    value.descriptor.files.find(file => file.path === 'loader.js').sha256 = digest;
    assert.throws(() => sdk.validateBilibiliRuntime(value.descriptor, value.report, binding.descriptorSha256, binding.descriptorBytes));
});

test('root mini-game configs are mutable metadata but must match local preflight and the root game layout', () => {
    for (const target of ['WECHAT', 'BYTEDANCE']) {
        const game = { deviceOrientation: 'landscape', openDataContext: '' };
        const project = { appid: 'local-app', projectname: 'editable', compileType: 'game', miniprogramRoot: './' };
        sdk.validateMiniGameConfigs(target, game, project, 'local-app');
        sdk.validateMiniGameConfigs(target, { ...game, deviceOrientation: 'portrait' }, { ...project, projectname: 'changed' }, 'local-app');
        for (const change of [value => { value.appid = 'different'; }, value => { value.appid = ' '; },
            value => { value.miniprogramRoot = 'nested/'; }, value => { value.gameRoot = '../'; }, value => { value.compileType = 'miniprogram'; }]) {
            const value = structuredClone(project); change(value);
            assert.throws(() => sdk.validateMiniGameConfigs(target, game, value, 'local-app'));
        }
        for (const changed of [{ ...game, plugins: { unsupported: {} } }, { ...game, openDataContext: 'domain' },
            { ...game, subpackages: [{ name: 'subpackage', root: 'sub' }] }, { ...game, subPackages: [{}] }, { deviceOrientation: 'diagonal' }]) {
            assert.throws(() => sdk.validateMiniGameConfigs(target, changed, project, 'local-app'));
        }
    }
});

test('compiled target constants and lexical export bindings cannot be substituted', () => {
    const ts = require('typescript');
    for (const target of ['WECHAT', 'BYTEDANCE']) {
        const globals = { CC_DEBUG: true, CC_BUILD: true, CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false,
            CC_BILIBILI: false, CC_WECHAT: target === 'WECHAT', CC_BYTEDANCE: target === 'BYTEDANCE', CC_MINIGAME: true, CC_NODEJS: false, CC_RUNTIME_BASED: false };
        const source = `System.register([],function(e){return{execute:function(){${Object.entries(globals).map(([key, value]) => `g(${JSON.stringify(key)},${value});`).join('')}
            e('Node',class{});function shadow(e){e('NotAnExport',0)}}}});`;
        assert.deepEqual(extractRuntimeExports(ts, source, globals), ['Node']);
        for (const name of [`CC_${target}`, 'CC_MINIGAME', 'CC_JSB']) {
            assert.throws(() => extractRuntimeExports(ts, source.replace(`g("${name}",${globals[name]});`, `g("${name}",${!globals[name]});`), globals));
        }
        assert.throws(() => extractRuntimeExports(ts, source + source, globals));
    }
    for (const text of ['{"target":"WECHAT","target":"BYTEDANCE"}', '{"target":"WECHAT","\\u0074arget":"WECHAT"}']) {
        assert.throws(() => sdk.parseJson(text), error => error.code === 'SDK_INCOMPLETE');
    }
});

test('API index generation checks the actual mini-game target before accepting linked exports', async () => {
    const parser = await readFile(rootRequire.resolve('typescript/lib/typescript.js'));
    // Genuine compiler declaration bytes, not a fabricated cc declaration. Stop
    // before declaration indexing; this tests only target/engine/export binding.
    const declaration = await readFile(rootRequire.resolve('typescript/lib/typescript.d.ts'));
    const reachedExports = new Error('Reached export inventory after target inspection');
    for (const target of ['WECHAT', 'BYTEDANCE']) for (const variant of ['debug', 'release']) {
        const directory = `engine/profiles/${target}/2d-basic/${variant}`;
        const profile = { id: '2d-basic', target, variant, directory, engineEntry: './cocos-js/cc.js', exports: `${directory}/cc-exports.json` };
        const globals = { CC_DEBUG: variant === 'debug', CC_BUILD: true, CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false,
            CC_BILIBILI: false, CC_WECHAT: target === 'WECHAT', CC_BYTEDANCE: target === 'BYTEDANCE', CC_MINIGAME: true, CC_NODEJS: false, CC_RUNTIME_BASED: false };
        const source = Buffer.from(`System.register([],function(e){return{execute:function(){${Object.entries(globals)
            .map(([name, value]) => `g(${JSON.stringify(name)},${value});`).join('')}e('Node',class{});}}});`);
        const inspect = (engine, engineEntry = profile.engineEntry) => {
            const bytes = new Map([['toolchain/node_modules/typescript/lib/typescript.js', parser], [`${directory}/types/cc.d.ts`, declaration],
                [`${directory}/cocos-js/cc.js`, engine], [profile.exports, Buffer.from('{}')]]);
            return generateApiIndex({ profiles: [{ ...profile, engineEntry }], templates: [],
                files: [...bytes].map(([path, value]) => ({ path, bytes: value.length, sha256: sdk.hash(value) })),
                read: async path => { if (path === profile.exports) throw reachedExports; return bytes.get(path); } });
        };
        await assert.rejects(inspect(source), error => error === reachedExports);
        await assert.rejects(inspect(Buffer.from(source.toString().replace('"CC_MINIGAME",true', '"CC_MINIGAME",false'))), /Invalid declaration API index/);
        await assert.rejects(inspect(source, './engine/cc.js'), /Invalid declaration API index/);
    }
});

test('reviewed bootstrap source pins use the actual platform helper and pinned commonjs-like loader', async () => {
    const { transformAsync } = rootRequire('@babel/core');
    const { parse } = rootRequire('@babel/parser');
    const traverse = rootRequire('@babel/traverse').default;
    const literalString = node => {
        if (node.type === 'StringLiteral') return node.value;
        if (node.type === 'BinaryExpression' && node.operator === '+') return literalString(node.left) + literalString(node.right);
        assert.equal(node.type, 'CallExpression');
        assert.equal(node.callee.property.name, 'join');
        assert.equal(node.callee.object.type, 'ArrayExpression');
        return node.callee.object.elements.map(literalString).join(literalString(node.arguments[0]));
    };
    const pins = {};
    for (const [target, platform] of [['WECHAT', 'wechatgame'], ['BYTEDANCE', 'bytedance-mini-game']]) {
        const name = target.toLowerCase();
        assert.equal(require(`../runtime/prepare-${name}.cjs`).loaderPlatform, platform);
        let fsUtils;
        traverse(parse(await readFile(new URL(`../runtime/prepare-${name}.cjs`, import.meta.url), 'utf8')), { CallExpression({ node }) {
            if (node.callee.property?.name !== 'set' || node.arguments[0]?.value !== 'fs-utils.js') return;
            assert.equal(fsUtils, undefined);
            assert.equal(node.arguments[1].callee.object.name, 'Buffer');
            assert.equal(node.arguments[1].callee.property.name, 'from');
            fsUtils = literalString(node.arguments[1].arguments[0]);
        } });
        assert.equal(typeof fsUtils, 'string');
        const inputs = {
            'game.js': await readFile(new URL(`../runtime/${name}-game.js`, import.meta.url), 'utf8'),
            'application.js': await readFile(new URL(`../runtime/${name}-application.js`, import.meta.url), 'utf8'),
            'web-adapter.js': await readFile(new URL(`../../../node_modules/@cocos/engine-platforms/bin/adapter/minigame/${name}/web-adapter.js`, import.meta.url), 'utf8'),
            'engine-adapter.js': await readFile(new URL(`../../../node_modules/@cocos/engine-platforms/bin/adapter/minigame/${name}/engine-adapter.js`, import.meta.url), 'utf8'),
            'fs-utils.js': fsUtils,
        };
        pins[target] = { debug: {}, release: {} };
        for (const [file, source] of Object.entries(inputs)) {
            pins[target].debug[file] = sdk.hash(source);
            if (file === 'web-adapter.js' || file === 'engine-adapter.js') {
                const [table, , entries] = parse(source).program.body[0].expression.arguments;
                const actual = { modules: table.properties.length,
                    dependencies: table.properties.reduce((sum, item) => sum + item.value.elements[1].properties.length, 0),
                    entries: entries.elements.map(item => item.value) };
                const expected = target === 'WECHAT' ? file === 'web-adapter.js' ? { modules: 35, dependencies: 55, entries: [27] }
                    : { modules: 7, dependencies: 6, entries: [6] } : file === 'web-adapter.js' ? { modules: 34, dependencies: 54, entries: [27] }
                    : { modules: 8, dependencies: 7, entries: [7] };
                assert.deepEqual(actual, expected);
            }
            const { code, map } = await transformAsync(source, { sourceType: 'script', babelrc: false, configFile: false, browserslistConfigFile: false,
                sourceMaps: false, minified: true, compact: true, comments: false,
                shouldPrintComment: comment => /@license|@preserve|copyright|permission is hereby granted/i.test(comment) });
            assert(code && !map);
            pins[target].release[file] = sdk.hash(code);
        }
    }
    assert.equal(require('@cocos/module-system/package.json').version, '0.0.21');
    assert.equal(rootRequire('@cocos/engine-platforms/package.json').version, '1.0.6');
    const builder = await readFile(require.resolve('@cocos/module-system/dist/build.js'), 'utf8');
    assert.equal(sdk.hash(builder), '880a011b579340bae96033d49d936a1f6e529a9350227c23c066fc230af079b4');
    assert.deepEqual(pins, sdk.minigameBootstrapHashes);
});
