const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('../../../node_modules/@babel/parser');
const traverse = require('../../../node_modules/@babel/traverse').default;
const { validateBilibili } = require('../../../scripts/validate-bilibili.cjs');
const { profiles } = require('../effects/builtin-inputs.cjs');
const { assertAbsent, canonicalDirectory, inventory, readRegular, sha256 } = require('./files.cjs');
const { exerciseBilibili } = require('./bilibili-local-host.cjs');

// Source inspection only: never execute the engine bundle to simulate a renderer.
function inspectClosure(files) {
    const read = name => { assert.ok(files.has(name), `MISSING_RESOURCE: ${name}`); return files.get(name).toString(); };
    const json = name => JSON.parse(read(name));
    const descriptor = json('runtime.json');
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.kind, 'cocos4-bilibili-runtime');
    assert.equal(descriptor.target, 'BILIBILI');
    assert.equal(descriptor.entry, 'game.js');
    assert.equal(descriptor.engineEntry, './cocos-js/cc.js');
    assert.equal(descriptor.tools.loaderPlatform, 'bilibili');
    assert.equal(descriptor.tools.moduleSystem, '0.0.21');
    assert.ok(['debug', 'release'].includes(descriptor.variant));
    assert.equal(descriptor.constants.DEBUG, descriptor.variant === 'debug');
    assert.equal(descriptor.compressed, descriptor.variant === 'release');
    assert.equal(descriptor.sourceMap, false);
    assert.deepEqual(descriptor.features, profiles[descriptor.profile]);
    for (const name of ['MINIGAME', 'BILIBILI', 'BUILD']) assert.equal(descriptor.constants[name], true, name);
    for (const name of ['HTML5', 'WECHAT', 'NATIVE', 'JSB']) assert.equal(descriptor.constants[name], false, name);
    for (const name of ['game.js', 'game.json', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js',
        'loader.js', 'import-map.json', 'settings.json', 'internal-prerequisites.js', 'cocos-js/cc.js',
        'assets/internal/index.js', 'assets/internal/config.json', 'builtin-report.json', 'game-compiler.json',
        'ENGINE-LICENSE', 'engine-build.json', 'compiler-dependencies.json', 'template/tsconfig.json',
        'template/src/main.ts', 'template/src/world.ts', 'game/main.js', 'game/world.js']) read(name);
    assert.equal(descriptor.typeFiles.length, 3);
    for (const name of descriptor.typeFiles) read(name);
    assert.ok(![...files.keys()].some(name => name.endsWith('.ejs')), 'Runtime must not ship EJS templates');
    const compiler = json('compiler-dependencies.json');
    assert.ok(!compiler.packages.some(pkg => pkg.name === 'ejs'), 'EJS must not enter the end-user compiler closure');
    const imports = json('import-map.json').imports;
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
    const exports = new Set();
    const moduleEdges = [];
    const resources = new Set();
    const globals = new Map();
    const expectedGlobals = { CC_DEBUG: descriptor.variant === 'debug', CC_BUILD: true, CC_JSB: false,
        CC_EDITOR: false, CC_PREVIEW: false, CC_BILIBILI: true, CC_MINIGAME: true };
    let parsedScripts = 0;
    let systemModules = 0;
    for (const [file, bytes] of files) {
        if (!file.endsWith('.js')) continue;
        // No error recovery: all parser diagnostics must fail this gate.
        const ast = parse(bytes.toString(), { sourceType: 'script' });
        ++parsedScripts;
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
            if (file === 'cocos-js/cc.js') traverse(ast, {
                Function(factory) {
                    if (factory.node !== register.arguments[1]) return;
                    const parameter = factory.node.params[0];
                    assert.equal(parameter?.type, 'Identifier', 'Expected a SystemJS export callback');
                    const binding = factory.scope.getBinding(parameter.name);
                    assert.ok(binding, 'Missing SystemJS export callback binding');
                    // Minified nested functions reuse names; only this binding exports cc.
                    for (const reference of binding.referencePaths) {
                        const call = reference.parentPath;
                        if (!call.isCallExpression() || call.node.callee !== reference.node) continue;
                        const first = call.node.arguments[0];
                        if (first?.type === 'StringLiteral') exports.add(first.value);
                        else {
                            assert.equal(first?.type, 'ObjectExpression', 'Expected static export names');
                            for (const item of first.properties) {
                                assert.equal(item.type, 'ObjectProperty', 'Expected a static export property');
                                assert.equal(item.computed, false, 'Computed export names are unsupported');
                                assert.ok(['Identifier', 'StringLiteral'].includes(item.key.type));
                                exports.add(item.key.name ?? item.key.value);
                            }
                        }
                    }
                    factory.stop();
                },
            });
        }
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'CallExpression') {
                if (node.callee.type === 'MemberExpression' && node.callee.property.name === 'import'
                    && node.arguments[0]?.type === 'StringLiteral') {
                    moduleEdges.push({ from: file, to: resolve(node.arguments[0].value, file) });
                }
                if (file === 'cocos-js/cc.js' && node.arguments[0]?.type === 'StringLiteral' && Object.hasOwn(expectedGlobals, node.arguments[0].value)) {
                    const name = node.arguments[0].value;
                    const value = node.arguments[1];
                    const actual = value?.type === 'BooleanLiteral' ? value.value : value?.type === 'UnaryExpression'
                        && value.operator === '!' && value.argument.type === 'NumericLiteral' ? !value.argument.value : undefined;
                    assert.equal(globals.has(name), false, `Duplicate compiled global constant: ${name}`);
                    assert.equal(actual, expectedGlobals[name], `Wrong compiled global constant: ${name}`);
                    globals.set(name, actual);
                }
                if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'StringLiteral') {
                    let name = node.arguments[0].value;
                    if (!path.posix.extname(name)) name += '.js';
                    moduleEdges.push({ from: file, to: resolve(name, file) });
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
    assert.equal(globals.size, Object.keys(expectedGlobals).length, 'Missing compiled global constants');
    const game = json('game-compiler.json');
    assert.equal(game.typeChecked, true);
    assert.deepEqual(game.diagnostics, []);
    for (const name of game.requiredCCExports) assert.ok(exports.has(name), `FEATURE_NOT_IN_PROFILE: ${name}`);
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
        read(emitted); assert.ok(data.equals(files.get(emitted)), `Template asset mismatch: ${file}`);
    }
    const rules = json('assets/game/rules.json');
    for (const name of [rules.image, rules.audio]) read(`assets/game/${name}`);
    return { parsedScripts, systemModules, moduleEdges, resourceCount: resources.size,
        engineExportCount: exports.size, requiredCCExportCount: game.requiredCCExports.length,
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

async function verifyBilibili({ runtimeDirectory, outDirectory }) {
    const { root, descriptorBytes, descriptor, files } = await readRuntime(runtimeDirectory);
    const requestedOutput = path.resolve(outDirectory ?? `${root}-local`);
    const output = path.join(await canonicalDirectory(path.dirname(requestedOutput)), path.basename(requestedOutput));
    const relative = path.relative(root, output);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        'Evidence output must be outside the runtime');
    await assertAbsent(output);
    const closure = inspectClosure(files);
    const preflight = validateBilibili(root);
    for (const warning of preflight.warnings) console.warn(`[BILIBILI preflight] ${warning}`);
    const shared = await exerciseBilibili(files);
    const distinct = await exerciseBilibili(files, { distinct: true });
    const failures = [];
    for (const fault of ['missing-settings', 'missing-export', 'missing-builtin', 'invalid-material', 'init', 'run', 'start-sync', 'start-async', 'missing-asset']) {
        failures.push(await exerciseBilibili(files, { distinct: true, fault }));
    }
    // Recheck the raw descriptor and payload after verification before binding evidence to them.
    assert.equal(sha256(await readRegular(root, 'runtime.json')), sha256(descriptorBytes));
    assert.deepEqual((await inventory(root)).filter(file => file.path !== 'runtime.json'), descriptor.files);
    const report = { schemaVersion: 1, kind: 'cocos4-bilibili-local-report', profile: descriptor.profile,
        runtimeSha256: sha256(descriptorBytes), success: true,
        ...(descriptor.buildOptions ? { build: { target: descriptor.target, variant: descriptor.variant,
            optionsSha256: sha256(JSON.stringify(descriptor.buildOptions)),
            engineSha256: descriptor.files.find(file => file.path === descriptor.engineEntry.slice(2)).sha256 } } : {}),
        checks: { moduleClosure: true, canonicalPreflight: true, loaderBootstrapSharedGlobal: true,
            loaderBootstrapDistinctGlobal: true, entryLifecycle: true, startupFailure: true },
        validationLevels: { vendorBuild: false, device: false },
        notes: ['Maintainer-only trusted artifact verifier, not a sandbox for untrusted game code',
            'Real generated loader, launcher, adapters, Application and game modules; engine exports/resources inspected statically',
            'cc game, scene/component lifecycle, builtin instances, asset wrappers and bl host services are explicit contract mocks',
            'No engine execution, GL, rendering, media decoding/playback, vendor build or real-device validation'],
        evidence: { closure, preflight, shared, distinct, failures },
    };
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'local-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return { output, report: path.join(output, 'local-report.json'), runtimeSha256: report.runtimeSha256, checks: report.checks };
}

module.exports = { verifyBilibili, inspectClosure, readRuntime };
if (require.main === module) {
    if (![3, 4].includes(process.argv.length)) {
        console.error('Usage: node verify-bilibili.cjs <runtime-directory> [absent-evidence-directory]');
        process.exitCode = 1;
    } else verifyBilibili({ runtimeDirectory: process.argv[2], outDirectory: process.argv[3] })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
