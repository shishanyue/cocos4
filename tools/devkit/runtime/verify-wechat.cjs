const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('../../../node_modules/@babel/parser');
const traverse = require('../../../node_modules/@babel/traverse').default;
const { profiles } = require('../effects/builtin-inputs.cjs');
const { assertAbsent, canonicalDirectory, inventory, readRegular, sha256 } = require('./files.cjs');
const { loaderPlatform } = require('./prepare-wechat.cjs');
const { exerciseWechat } = require('./wechat-local-host.cjs');

function inspectEngine(ast, variant) {
    assert.ok(['debug', 'release'].includes(variant));
    const register = ast.program.body.find(node => node.type === 'ExpressionStatement'
        && node.expression.type === 'CallExpression' && node.expression.callee.type === 'MemberExpression'
        && node.expression.callee.object.name === 'System' && node.expression.callee.property.name === 'register')?.expression;
    assert.equal(register?.arguments[0].type, 'ArrayExpression', 'Expected an anonymous SystemJS engine module');
    const exports = new Set();
    const globals = new Map();
    const expected = { CC_DEBUG: variant === 'debug', CC_BUILD: true, CC_JSB: false,
        CC_EDITOR: false, CC_PREVIEW: false, CC_WECHAT: true, CC_BILIBILI: false, CC_BYTEDANCE: false, CC_MINIGAME: true };
    traverse(ast, {
        Function(factory) {
            if (factory.node !== register.arguments[1]) return;
            const parameter = factory.node.params[0];
            assert.equal(parameter?.type, 'Identifier', 'Expected a SystemJS export callback');
            const binding = factory.scope.getBinding(parameter.name);
            assert.ok(binding, 'Missing SystemJS export callback binding');
            // Minified nested functions reuse names; only this lexical binding exports cc.
            for (const reference of binding.referencePaths) {
                const call = reference.parentPath;
                if (!call.isCallExpression() || call.node.callee !== reference.node) continue;
                const first = call.node.arguments[0];
                if (first?.type === 'StringLiteral') exports.add(first.value);
                else {
                    assert.equal(first?.type, 'ObjectExpression', 'Expected static export names');
                    for (const item of first.properties) {
                        assert.equal(item.type, 'ObjectProperty');
                        assert.equal(item.computed, false);
                        assert.ok(['Identifier', 'StringLiteral'].includes(item.key.type));
                        exports.add(item.key.name ?? item.key.value);
                    }
                }
            }
        },
        CallExpression(call) {
            const [name, value] = call.node.arguments;
            if (name?.type !== 'StringLiteral' || !Object.hasOwn(expected, name.value)) return;
            const actual = value?.type === 'BooleanLiteral' ? value.value : value?.type === 'UnaryExpression'
                && value.operator === '!' && value.argument.type === 'NumericLiteral' ? !value.argument.value : undefined;
            assert.equal(globals.has(name.value), false, `Duplicate compiled global constant: ${name.value}`);
            assert.equal(actual, expected[name.value], `Wrong compiled global constant: ${name.value}`);
            globals.set(name.value, actual);
        },
    });
    assert.equal(globals.size, Object.keys(expected).length, 'Missing compiled global constants');
    return { exports, globals };
}

// Inspect the real engine statically. Local host execution substitutes only the cc contract.
function inspectClosure(files) {
    const read = name => {
        assert.ok(files.get(name)?.length, `MISSING_RESOURCE: ${name}`);
        return files.get(name).toString();
    };
    const json = name => JSON.parse(read(name));
    const descriptor = json('runtime.json');
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.kind, 'cocos4-wechat-runtime');
    assert.equal(descriptor.target, 'WECHAT');
    assert.equal(descriptor.mode, 'BUILD');
    assert.equal(descriptor.moduleFormat, 'system');
    assert.equal(descriptor.entry, 'game.js');
    assert.equal(descriptor.engineEntry, './cocos-js/cc.js');
    assert.equal(descriptor.tools.loaderPlatform, loaderPlatform);
    assert.equal(descriptor.tools.moduleSystem, '0.0.21');
    assert.ok(Object.hasOwn(profiles, descriptor.profile), 'Unknown WeChat runtime profile');
    assert.ok(['debug', 'release'].includes(descriptor.variant));
    assert.equal(descriptor.constants.DEBUG, descriptor.variant === 'debug');
    assert.equal(descriptor.constants.USE_3D, descriptor.profile === '3d-basic');
    assert.equal(descriptor.compressed, descriptor.variant === 'release');
    assert.equal(descriptor.sourceMap, false);
    assert.deepEqual(descriptor.features, profiles[descriptor.profile]);
    for (const name of ['MINIGAME', 'WECHAT', 'BUILD']) assert.equal(descriptor.constants[name], true, name);
    for (const name of ['HTML5', 'WECHAT_MINI_PROGRAM', 'BILIBILI', 'BYTEDANCE', 'NATIVE', 'JSB', 'EDITOR', 'PREVIEW', 'NODEJS', 'TEST']) {
        assert.equal(descriptor.constants[name], false, name);
    }
    assert.equal(descriptor.buildOptions.engine.platform, 'WECHAT');
    assert.equal(descriptor.buildOptions.engine.mode, 'BUILD');
    assert.equal(descriptor.buildOptions.engine.moduleFormat, 'system');
    assert.equal(descriptor.buildOptions.engine.compress, descriptor.compressed);
    assert.deepEqual(descriptor.buildOptions.engine.features, descriptor.features);
    assert.equal(descriptor.buildOptions.loader.platform, loaderPlatform);
    assert.equal(descriptor.buildOptions.loader.minify, descriptor.compressed);
    for (const name of ['NATIVE', 'JSB', 'EDITOR', 'PREVIEW', 'DEBUG']) {
        assert.equal(descriptor.buildOptions.engine.flags[name], descriptor.constants[name], `Build identity: ${name}`);
    }
    for (const name of ['game.js', 'game.json', 'project.config.json', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js',
        'loader.js', 'import-map.json', 'settings.json', 'internal-prerequisites.js', 'cocos-js/cc.js',
        'assets/internal/index.js', 'assets/internal/config.json', 'builtin-report.json', 'game-compiler.json',
        'ENGINE-LICENSE', 'WECHAT-ADAPTER-LICENSE', 'engine-build.json', 'compiler-dependencies.json', 'template/tsconfig.json',
        'template/src/main.ts', 'template/src/world.ts', 'game/main.js', 'game/world.js']) read(name);
    assert.match(read('WECHAT-ADAPTER-LICENSE'), /@cocos\/engine-platforms 1\.0\.6/);
    assert.match(read('WECHAT-ADAPTER-LICENSE'), /Declared package license: UNLICENSED/);
    assert.equal(descriptor.typeFiles.length, 3);
    for (const name of descriptor.typeFiles) read(name);
    assert.ok(!files.has('index.html') && !files.has('boot.js'), 'WeChat must not ship an HTML5 entry');
    assert.ok(![...files.keys()].some(name => name.endsWith('.ejs')), 'Runtime must not ship EJS templates');
    const compiler = json('compiler-dependencies.json');
    assert.ok(!compiler.packages.some(pkg => pkg.name === 'ejs'), 'EJS must not enter the end-user compiler closure');
    const imports = json('import-map.json').imports;
    assert.equal(imports.cc, './cocos-js/cc.js');
    assert.equal(imports['virtual:///prerequisite-imports/internal'], './internal-prerequisites.js');
    const resolve = (name, parent) => {
        if (Object.hasOwn(imports, name)) name = imports[name];
        else if (name.startsWith('.')) name = path.posix.join(path.posix.dirname(parent), name);
        else throw new Error(`UNKNOWN_MODULE: ${name} from ${parent}`);
        const file = path.posix.normalize(name).replace(/^\.\//, '');
        assert.ok(!file.startsWith('../') && !/[:\\]/.test(file) && !path.posix.isAbsolute(file), `Unsafe module: ${name}`);
        read(file);
        return file;
    };
    for (const name of Object.keys(imports)) resolve(name, 'game.js');
    let engine;
    const moduleEdges = [];
    const adapterModules = {};
    const resources = new Set();
    let parsedScripts = 0;
    let systemModules = 0;
    for (const [file, bytes] of files) {
        if (!file.endsWith('.js')) continue;
        const ast = parse(bytes.toString(), { sourceType: 'script' });
        ++parsedScripts;
        if (file === 'cocos-js/cc.js') engine = inspectEngine(ast, descriptor.variant);
        if (file === 'web-adapter.js' || file === 'engine-adapter.js') {
            const bundle = ast.program.body[0]?.expression;
            const table = bundle?.arguments?.[0];
            assert.equal(table?.type, 'ObjectExpression', `Expected pinned Browserify adapter: ${file}`);
            const ids = new Set(table.properties.map(item => item.key.value));
            for (const item of table.properties) {
                assert.equal(item.value.type, 'ArrayExpression');
                assert.equal(item.value.elements[0].type, 'FunctionExpression');
                assert.equal(item.value.elements[1].type, 'ObjectExpression');
                for (const dependency of item.value.elements[1].properties) {
                    assert.ok(ids.has(dependency.value.value), `Missing embedded adapter module: ${file}/${dependency.key.value}`);
                }
            }
            assert.equal(bundle.arguments[2]?.type, 'ArrayExpression');
            for (const entry of bundle.arguments[2].elements) assert.ok(ids.has(entry.value), `Missing adapter entry: ${file}`);
            adapterModules[file] = ids.size;
        }
        const register = ast.program.body.find(node => node.type === 'ExpressionStatement'
            && node.expression.type === 'CallExpression' && node.expression.callee.type === 'MemberExpression'
            && node.expression.callee.object.name === 'System' && node.expression.callee.property.name === 'register')?.expression;
        if (register) {
            ++systemModules;
            assert.equal(register.arguments[0].type, 'ArrayExpression', `Expected anonymous System module: ${file}`);
            for (const dependency of register.arguments[0].elements) {
                assert.equal(dependency.type, 'StringLiteral');
                moduleEdges.push({ from: file, to: resolve(dependency.value, file) });
            }
        }
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'CallExpression') {
                const property = node.callee.type === 'MemberExpression'
                    ? node.callee.property.name ?? node.callee.property.value : undefined;
                if (property === 'import' && node.arguments[0]?.type === 'StringLiteral') {
                    moduleEdges.push({ from: file, to: resolve(node.arguments[0].value, file) });
                }
                const commonjs = node.callee.type === 'Identifier' && node.callee.name === 'require';
                if ((commonjs || property === '__wechatRequire' || property === '__wxRequire') && node.arguments[0]?.type === 'StringLiteral') {
                    let name = node.arguments[0].value;
                    if (!path.posix.extname(name)) name += '.js';
                    moduleEdges.push({ from: file, to: resolve(name, commonjs ? file : 'game.js') });
                }
            }
            if (node.type === 'StringLiteral' && /^assets\/game\//.test(node.value)) {
                if (node.value !== 'assets/game/intentionally-missing.png') { read(node.value); resources.add(node.value); }
                else assert.equal(files.has(node.value), false, 'Missing-asset negative fixture must stay absent');
            }
            if (node.type === 'StringLiteral' && /^external\/.*\.(?:wasm|mem|bin)$/.test(node.value)) {
                read(`cocos-js/${node.value}`); resources.add(`cocos-js/${node.value}`);
            }
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) for (const child of value) visit(child);
                else if (value && typeof value === 'object') visit(value);
            }
        };
        visit(ast.program);
    }
    assert.ok(engine, 'Missing engine module');
    const game = json('game-compiler.json');
    assert.equal(game.typeChecked, true);
    assert.deepEqual(game.diagnostics, []);
    for (const name of [...game.requiredCCExports, 'cclegacy', 'game', 'assetManager', 'Material', 'isValid']) {
        assert.ok(engine.exports.has(name), `FEATURE_NOT_IN_PROFILE: ${name}`);
    }
    for (const file of game.outputFiles) read(`game/${file}`);
    const result = json('engine-build.json');
    assert.equal(result.hasCriticalWarns, false);
    assert.equal(result.exports.cc, 'cc.js');
    for (const graph of [result.chunkDepGraph, result.assetDepGraph]) {
        for (const [file, dependencies] of Object.entries(graph)) {
            read(`cocos-js/${file}`);
            for (const dependency of dependencies) read(`cocos-js/${dependency}`);
        }
    }
    const builtin = json('builtin-report.json');
    assert.equal(sha256(files.get('builtin-report.json')), descriptor.builtins.reportSha256);
    assert.ok(builtin.effects.length && builtin.materials.length, 'Real builtin effects and materials are required');
    for (const file of builtin.files.filter(file => file.path.startsWith('assets/'))) {
        read(file.path);
        assert.equal(sha256(files.get(file.path)), file.sha256, `Builtin integrity: ${file.path}`);
        resources.add(file.path);
    }
    const uuids = [...builtin.effects, ...builtin.materials].map(asset => asset.uuid).sort();
    const settings = json('settings.json');
    assert.deepEqual([...settings.engine.builtinAssets].sort(), uuids);
    assert.deepEqual(settings.assets.projectBundles, ['internal']);
    const config = json('assets/internal/config.json');
    assert.deepEqual([...config.uuids].sort(), uuids);
    for (const uuid of uuids) read(`assets/internal/${config.importBase}/${uuid.slice(0, 2)}/${uuid}.json`);
    for (const [file, data] of files) if (file.startsWith('template/assets/')) {
        const emitted = file.replace('template/assets/', 'assets/game/');
        read(emitted);
        assert.ok(data.equals(files.get(emitted)), `Template asset mismatch: ${file}`);
    }
    const rules = json('assets/game/rules.json');
    for (const name of [rules.image, rules.audio]) read(`assets/game/${name}`);
    return { parsedScripts, systemModules, adapterModules, moduleEdges, resourceCount: resources.size,
        compiledGlobals: Object.fromEntries(engine.globals), engineExportCount: engine.exports.size,
        requiredCCExportCount: game.requiredCCExports.length, builtinEffects: builtin.effects.length, builtinMaterials: builtin.materials.length };
}

async function readRuntime(runtimeDirectory) {
    const root = await canonicalDirectory(runtimeDirectory);
    const descriptorBytes = await readRegular(root, 'runtime.json');
    const descriptor = JSON.parse(descriptorBytes);
    const actual = await inventory(root);
    assert.deepEqual(actual.filter(file => file.path !== 'runtime.json'), descriptor.files, 'Runtime descriptor/file integrity mismatch');
    const files = new Map();
    for (const file of actual) files.set(file.path, await readRegular(root, file.path));
    return { root, descriptorBytes, descriptor, files };
}

async function verifyWechat({ runtimeDirectory, outDirectory }) {
    // Owned by the parent integration. Missing preparation is an error, never a weaker fallback validator.
    const { validateMiniGame } = require('../../../scripts/validate-minigame.cjs');
    const { root, descriptorBytes, descriptor, files } = await readRuntime(runtimeDirectory);
    const output = path.resolve(outDirectory ?? `${root}-local`);
    await canonicalDirectory(path.dirname(output));
    assert.ok(!output.startsWith(`${root}${path.sep}`), 'Evidence output must be outside the runtime');
    await assertAbsent(output);
    const closure = inspectClosure(files);
    const preflight = await validateMiniGame(root, 'WECHAT');
    for (const warning of preflight.warnings) console.warn(`[WECHAT preflight] ${warning}`);
    const shared = await exerciseWechat(files);
    const distinct = await exerciseWechat(files, { distinct: true, separateSelf: true });
    const failures = [];
    for (const fault of ['missing-host', 'missing-fs', 'missing-settings', 'missing-export', 'missing-builtin', 'invalid-material',
        'init', 'run', 'start-sync', 'start-async', 'missing-asset']) {
        failures.push(await exerciseWechat(files, { distinct: true, fault }));
    }
    assert.equal(sha256(await readRegular(root, 'runtime.json')), sha256(descriptorBytes));
    assert.deepEqual((await inventory(root)).filter(file => file.path !== 'runtime.json'), descriptor.files);
    const report = { schemaVersion: 1, kind: 'cocos4-wechat-local-report', profile: descriptor.profile,
        runtimeSha256: sha256(descriptorBytes), success: true,
        build: { target: 'WECHAT', variant: descriptor.variant, optionsSha256: sha256(JSON.stringify(descriptor.buildOptions)),
            engineSha256: descriptor.files.find(file => file.path === descriptor.engineEntry.slice(2)).sha256 },
        checks: { moduleClosure: true, canonicalPreflight: true, loaderBootstrapSharedGlobal: true,
            loaderBootstrapDistinctGlobal: true, entryLifecycle: true, startupFailure: true },
        validationLevels: { vendorBuild: false, device: false },
        notes: ['Maintainer-only trusted artifact verifier, not a sandbox for untrusted game code',
            'Real generated loader, launcher, pinned adapters, Application and game modules; engine flags/exports/resources inspected statically',
            'cc lifecycle, builtin instances, asset/media wrappers and wx host services are explicit contract mocks',
            'No engine execution, GL, rendering, media decoding/playback, vendor build or real-device validation',
            '@cocos/engine-platforms 1.0.6 declares UNLICENSED; redistribution authorization remains a separate requirement'],
        evidence: { closure, preflight, shared, distinct, failures },
    };
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'local-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return { output, report: path.join(output, 'local-report.json'), runtimeSha256: report.runtimeSha256, checks: report.checks };
}

module.exports = { verifyWechat, inspectClosure, inspectEngine, readRuntime };
if (require.main === module) {
    if (![3, 4].includes(process.argv.length)) {
        console.error('Usage: node verify-wechat.cjs <runtime-directory> [absent-evidence-directory]');
        process.exitCode = 1;
    } else verifyWechat({ runtimeDirectory: process.argv[2], outDirectory: process.argv[3] })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
