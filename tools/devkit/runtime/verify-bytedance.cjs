const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('../../../node_modules/@babel/parser');
const traverse = require('../../../node_modules/@babel/traverse').default;
const { profiles } = require('../effects/builtin-inputs.cjs');
const { assertAbsent, canonicalDirectory, inventory, readRegular, sha256 } = require('./files.cjs');
const { exerciseBytedance, startupFaults } = require('./bytedance-local-host.cjs');
const { loaderPlatform } = require('./prepare-bytedance.cjs');

// This is a source/closure inspection, never a substitute engine or simulated renderer.
// Kept separate so parser/constant negative tests need no fabricated runtime/SDK artifact.
function inspectScripts(files, { variant, requiredCCExports }) {
    assert.ok(['debug', 'release'].includes(variant));
    const read = name => { assert.ok(files.has(name), `MISSING_RESOURCE: ${name}`); return files.get(name).toString(); };
    const mapModule = JSON.parse(read('import-map.json'));
    const importMap = mapModule.default || mapModule;
    assert.deepEqual(Object.keys(importMap), ['imports'], 'Only the generated flat import map is supported');
    const imports = importMap.imports;
    assert.equal(imports.cc, './cocos-js/cc.js');
    const resolve = (name, parent, commonjs = false) => {
        if (!commonjs && Object.hasOwn(imports, name)) name = imports[name];
        else if (name.startsWith('.')) name = path.posix.join(path.posix.dirname(parent), name);
        else throw new Error(`UNKNOWN_MODULE: ${name} from ${parent}`);
        assert.equal(typeof name, 'string');
        if (commonjs && !path.posix.extname(name)) name += '.js';
        const file = path.posix.normalize(name).replace(/^\.\//, '');
        assert.ok(!file.startsWith('../') && !/[:\\\0]/.test(file) && !path.posix.isAbsolute(file), `Unsafe module: ${name}`);
        read(file);
        return file;
    };
    for (const name of Object.keys(imports)) resolve(name, 'game.js');
    const member = node => node?.type === 'MemberExpression'
        ? (node.computed ? node.property.type === 'StringLiteral' && node.property.value : node.property.name) : null;
    const exports = new Set();
    const moduleEdges = [];
    const resources = new Set();
    const globals = new Map();
    const adapters = {};
    const expectedGlobals = { CC_DEBUG: variant === 'debug', CC_BUILD: true, CC_JSB: false,
        CC_EDITOR: false, CC_PREVIEW: false, CC_BYTEDANCE: true, CC_MINIGAME: true,
        CC_WECHAT: false, CC_BILIBILI: false, CC_NODEJS: false, CC_RUNTIME_BASED: false };
    let parsedScripts = 0;
    let systemModules = 0;
    for (const [file, bytes] of files) {
        if (!file.endsWith('.js')) continue;
        const ast = parse(bytes.toString(), { sourceType: 'script' });
        ++parsedScripts;
        if (['web-adapter.js', 'engine-adapter.js'].includes(file)) {
            const call = ast.program.body[0]?.expression;
            assert.equal(call?.type, 'CallExpression', `Expected published Browserify adapter: ${file}`);
            const [table, cache, entries] = call.arguments;
            assert.equal(table?.type, 'ObjectExpression');
            assert.equal(cache?.type, 'ObjectExpression');
            assert.equal(entries?.type, 'ArrayExpression');
            const modules = new Map();
            const factories = new Map();
            for (const item of table.properties) {
                assert.equal(item.type, 'ObjectProperty');
                assert.equal(item.key.type, 'NumericLiteral');
                assert.equal(item.value.type, 'ArrayExpression');
                assert.equal(modules.has(item.key.value), false, 'Duplicate bundled module');
                const [factory, dependencies] = item.value.elements;
                assert.equal(factory.type, 'FunctionExpression');
                assert.equal(dependencies.type, 'ObjectExpression');
                const mapping = new Map();
                for (const dependency of dependencies.properties) {
                    assert.equal(dependency.type, 'ObjectProperty');
                    assert.equal(dependency.key.type, 'StringLiteral');
                    assert.equal(dependency.value.type, 'NumericLiteral');
                    mapping.set(dependency.key.value, dependency.value.value);
                }
                modules.set(item.key.value, mapping);
                factories.set(factory, mapping);
            }
            let edges = 0;
            for (const mapping of modules.values()) for (const id of mapping.values()) {
                assert.ok(modules.has(id), `Missing bundled module ${id}: ${file}`); ++edges;
            }
            for (const entry of entries.elements) assert.ok(entry.type === 'NumericLiteral' && modules.has(entry.value), `Missing adapter entry: ${file}`);
            traverse(ast, { Function(factory) {
                const mapping = factories.get(factory.node);
                if (!mapping) return;
                const binding = factory.scope.getBinding(factory.node.params[0].name);
                for (const reference of binding.referencePaths) {
                    const call = reference.parentPath;
                    if (!call.isCallExpression() || call.node.callee !== reference.node) continue;
                    const name = call.node.arguments[0];
                    if (name?.type === 'StringLiteral' && !mapping.has(name.value)) {
                        moduleEdges.push({ from: file, to: resolve(name.value, file, true) });
                    }
                }
            } });
            adapters[file] = { modules: modules.size, dependencies: edges, entries: entries.elements.map(node => node.value) };
            if (file === 'engine-adapter.js') {
                const fsUtils = [...modules.values()].map(mapping => mapping.get('../fs-utils')).filter(value => value !== undefined);
                assert.equal(fsUtils.length, 1, 'Expected one embedded ByteDance fs-utils');
                assert.equal(modules.get(fsUtils[0]).size, 0, 'Review embedded ByteDance fs-utils dependencies');
                adapters[file].fsUtilsModule = fsUtils[0];
            }
        }
        const register = ast.program.body.find(node => node.type === 'ExpressionStatement'
            && node.expression.type === 'CallExpression' && member(node.expression.callee) === 'register'
            && node.expression.callee.object.name === 'System')?.expression;
        if (register) {
            ++systemModules;
            assert.equal(register.arguments[0].type, 'ArrayExpression', `Expected anonymous System module: ${file}`);
            for (const dependency of register.arguments[0].elements) {
                assert.equal(dependency.type, 'StringLiteral');
                moduleEdges.push({ from: file, to: resolve(dependency.value, file) });
            }
            if (file === 'cocos-js/cc.js') traverse(ast, { Function(factory) {
                if (factory.node !== register.arguments[1]) return;
                const parameter = factory.node.params[0];
                assert.equal(parameter?.type, 'Identifier', 'Expected a SystemJS export callback');
                const binding = factory.scope.getBinding(parameter.name);
                assert.ok(binding, 'Missing SystemJS export callback binding');
                for (const reference of binding.referencePaths) {
                    const call = reference.parentPath;
                    if (!call.isCallExpression() || call.node.callee !== reference.node) continue;
                    const first = call.node.arguments[0];
                    if (first?.type === 'StringLiteral') exports.add(first.value);
                    else {
                        assert.equal(first?.type, 'ObjectExpression', 'Expected static export names');
                        for (const item of first.properties) {
                            assert.equal(item.type, 'ObjectProperty'); assert.equal(item.computed, false);
                            assert.ok(['Identifier', 'StringLiteral'].includes(item.key.type));
                            exports.add(item.key.name ?? item.key.value);
                        }
                    }
                }
                factory.stop();
            } });
        } else if (file === 'cocos-js/cc.js' || file === 'application.js' || file.startsWith('game/')) {
            assert.fail(`Missing System.register: ${file}`);
        }
        traverse(ast, {
            CallExpression(call) {
                const { node } = call;
                const name = node.arguments[0];
                if (name?.type !== 'StringLiteral') return;
                if (member(node.callee) === 'import') moduleEdges.push({ from: file, to: resolve(name.value, file) });
                const rootRequire = member(node.callee) === '__bytedanceRequire' && node.callee.object.name === 'globalThis';
                if (rootRequire || node.callee.type === 'Identifier' && node.callee.name === 'require') {
                    moduleEdges.push({ from: file, to: resolve(name.value, rootRequire ? 'game.js' : file, true) });
                }
                if (file === 'cocos-js/cc.js' && Object.hasOwn(expectedGlobals, name.value)) {
                    const value = node.arguments[1];
                    const actual = value?.type === 'BooleanLiteral' ? value.value : value?.type === 'UnaryExpression'
                        && value.operator === '!' && value.argument.type === 'NumericLiteral' ? !value.argument.value : undefined;
                    assert.equal(globals.has(name.value), false, `Duplicate compiled global constant: ${name.value}`);
                    assert.equal(actual, expectedGlobals[name.value], `Wrong compiled global constant: ${name.value}`);
                    globals.set(name.value, actual);
                }
            },
            StringLiteral({ node }) {
                if (/^assets\/game\//.test(node.value)) {
                    if (node.value !== 'assets/game/intentionally-missing.png') { read(node.value); resources.add(node.value); }
                    else assert.equal(files.has(node.value), false, 'Missing-asset negative fixture must stay absent');
                }
                if (/^external\/.*\.(?:wasm|mem|bin)$/.test(node.value)) {
                    read(`cocos-js/${node.value}`); resources.add(`cocos-js/${node.value}`);
                }
            },
        });
    }
    assert.equal(globals.size, Object.keys(expectedGlobals).length, 'Missing compiled global constants');
    for (const name of requiredCCExports) assert.ok(exports.has(name), `FEATURE_NOT_IN_PROFILE: ${name}`);
    return { parsedScripts, systemModules, moduleEdges, resourceCount: resources.size, adapters,
        engineExportCount: exports.size, requiredCCExportCount: requiredCCExports.length };
}

function inspectClosure(files) {
    const read = name => { assert.ok(files.has(name), `MISSING_RESOURCE: ${name}`); return files.get(name).toString(); };
    const json = name => JSON.parse(read(name));
    const descriptor = json('runtime.json');
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.kind, 'cocos4-bytedance-runtime');
    assert.equal(descriptor.target, 'BYTEDANCE');
    assert.equal(descriptor.mode, 'BUILD');
    assert.equal(descriptor.moduleFormat, 'system');
    assert.equal(descriptor.entry, 'game.js');
    assert.equal(descriptor.engineEntry, './cocos-js/cc.js');
    assert.equal(descriptor.tools.loaderPlatform, loaderPlatform);
    assert.equal(descriptor.tools.moduleSystem, '0.0.21');
    assert.ok(['debug', 'release'].includes(descriptor.variant));
    assert.equal(descriptor.constants.DEBUG, descriptor.variant === 'debug');
    assert.equal(descriptor.compressed, descriptor.variant === 'release');
    assert.equal(descriptor.sourceMap, false);
    assert.ok(Object.hasOwn(profiles, descriptor.profile));
    assert.deepEqual(descriptor.features, profiles[descriptor.profile]);
    assert.equal(descriptor.constants.USE_3D, descriptor.profile === '3d-basic');
    for (const name of ['MINIGAME', 'BYTEDANCE', 'BUILD']) assert.equal(descriptor.constants[name], true, name);
    for (const name of ['HTML5', 'BILIBILI', 'WECHAT', 'NATIVE', 'JSB', 'NODEJS', 'EDITOR', 'PREVIEW', 'TEST', 'RUNTIME_BASED']) {
        assert.equal(descriptor.constants[name], false, name);
    }
    for (const name of ['game.js', 'game.json', 'project.config.json', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js',
        'loader.js', 'import-map.json', 'settings.json', 'internal-prerequisites.js', 'cocos-js/cc.js',
        'assets/internal/index.js', 'assets/internal/config.json', 'builtin-report.json', 'game-compiler.json',
        'ENGINE-LICENSE', 'engine-build.json', 'compiler-dependencies.json', 'template/tsconfig.json',
        'template/src/main.ts', 'template/src/world.ts', 'game/main.js', 'game/world.js',
        'licenses/bytedance/package.json', 'licenses/bytedance/README.md', 'licenses/bytedance/ENGINE-LICENSE', 'licenses/bytedance/NOTICE.txt']) read(name);
    assert.equal(descriptor.typeFiles.length, 3);
    for (const name of descriptor.typeFiles) read(name);
    assert.ok(!files.has('index.html') && !files.has('boot.js'), 'ByteDance runtime must not contain a browser launcher');
    assert.ok(![...files.keys()].some(name => name.endsWith('.ejs')), 'Runtime must not ship EJS templates');
    const compiler = json('compiler-dependencies.json');
    assert.ok(!compiler.packages.some(pkg => pkg.name === 'ejs'), 'EJS must not enter the end-user compiler closure');
    const adapters = json('licenses/bytedance/package.json');
    assert.equal(adapters.name, '@cocos/engine-platforms'); assert.equal(adapters.version, '1.0.6');
    assert.equal(adapters.license, 'UNLICENSED');
    assert.equal(read('ENGINE-LICENSE'), read('licenses/bytedance/ENGINE-LICENSE'));
    const game = json('game-compiler.json');
    assert.equal(game.typeChecked, true);
    assert.deepEqual(game.diagnostics, []);
    for (const file of game.outputFiles) read(`game/${file}`);
    const scripts = inspectScripts(files, { variant: descriptor.variant, requiredCCExports: game.requiredCCExports });
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
    const builtinResources = builtin.files.filter(file => file.path.startsWith('assets/'));
    for (const file of builtinResources) {
        read(file.path);
        assert.equal(sha256(files.get(file.path)), file.sha256, `Builtin integrity: ${file.path}`);
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
        read(emitted); assert.ok(data.equals(files.get(emitted)), `Template asset mismatch: ${file}`);
    }
    const rules = json('assets/game/rules.json');
    for (const name of [rules.image, rules.audio]) read(`assets/game/${name}`);
    return { ...scripts, resourceCount: scripts.resourceCount + builtinResources.length,
        builtinEffects: builtin.effects.length, builtinMaterials: builtin.materials.length };
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

async function verifyBytedance({ runtimeDirectory, outDirectory }) {
    // Supplied by the shared exporter owner. Missing it is an error, never an optional gate.
    const { validateMiniGame } = require('../../../scripts/validate-minigame.cjs');
    const { root, descriptorBytes, descriptor, files } = await readRuntime(runtimeDirectory);
    const requestedOutput = path.resolve(outDirectory ?? `${root}-local`);
    const output = path.join(await canonicalDirectory(path.dirname(requestedOutput)), path.basename(requestedOutput));
    const relative = path.relative(root, output);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        'Evidence output must be outside the runtime');
    await assertAbsent(output);
    const closure = inspectClosure(files);
    const preflight = await validateMiniGame(root, 'BYTEDANCE');
    for (const warning of preflight.warnings) console.warn(`[BYTEDANCE preflight] ${warning}`);
    const shared = await exerciseBytedance(files);
    const distinct = await exerciseBytedance(files, { distinct: true });
    const failures = [];
    for (const fault of Object.keys(startupFaults)) failures.push(await exerciseBytedance(files, { distinct: true, fault }));
    assert.equal(sha256(await readRegular(root, 'runtime.json')), sha256(descriptorBytes));
    assert.deepEqual((await inventory(root)).filter(file => file.path !== 'runtime.json'), descriptor.files);
    const report = { schemaVersion: 1, kind: 'cocos4-bytedance-local-report', profile: descriptor.profile,
        runtimeSha256: sha256(descriptorBytes), success: true,
        ...(descriptor.buildOptions ? { build: { target: descriptor.target, variant: descriptor.variant,
            optionsSha256: sha256(JSON.stringify(descriptor.buildOptions)),
            engineSha256: descriptor.files.find(file => file.path === descriptor.engineEntry.slice(2)).sha256 } } : {}),
        checks: { moduleClosure: true, canonicalPreflight: true, loaderBootstrapSharedGlobal: true,
            loaderBootstrapDistinctGlobal: true, entryLifecycle: true, startupFailure: true },
        validationLevels: { vendorBuild: false, device: false },
        notes: ['Maintainer-only trusted artifact verifier, not a sandbox for untrusted game code',
            'Real generated loader, launcher, prepared ByteDance adapters, Application and game modules; engine inspected statically only',
            'cc, legacy window.cc, scene/component lifecycle, builtin instances, media wrappers and tt host services are explicit contract mocks',
            'ByteDance fs-utils is embedded in the published engine adapter; fs-utils.js exposes the same instance',
            'Static module/resource closure plus exercised local bundle loading; remote services, plugins and subpackage delivery remain unverified',
            'No engine execution, GL, rendering, media decoding/playback, vendor build or real-device validation',
            '@cocos/engine-platforms declares UNLICENSED; preserved metadata/engine license do not establish redistribution rights'],
        evidence: { closure, preflight, shared, distinct, failures },
    };
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'local-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return { output, report: path.join(output, 'local-report.json'), runtimeSha256: report.runtimeSha256, checks: report.checks };
}

module.exports = { verifyBytedance, inspectClosure, inspectScripts, readRuntime };
if (require.main === module) {
    if (![3, 4].includes(process.argv.length)) {
        console.error('Usage: node verify-bytedance.cjs <runtime-directory> [absent-evidence-directory]');
        process.exitCode = 1;
    } else verifyBytedance({ runtimeDirectory: process.argv[2], outDirectory: process.argv[3] })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
