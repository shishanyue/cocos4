import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const build = new URL(process.env.BILIBILI_PACKAGE_TEST_BUILD_PREFIX ?? '../build/src/', import.meta.url);
const { validateBilibiliPackage } = await import(new URL('bilibili.js', build));
const { reportSchema } = await import(new URL('contracts.js', build));
const sourceSdk = process.env.BILIBILI_PACKAGE_SDK ?? fileURLToPath(new URL('../build/game-sdk', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../runtime/build/', import.meta.url));
const directories = process.env.BILIBILI_RUNTIME_DIRECTORIES?.split(path.delimiter).map(directory => path.resolve(directory))
    ?? ['2d', '3d'].map(profile => path.join(runtimeRoot, `bilibili-final-${profile}-20260918`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeNames = new Set(['game.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js',
    'loader.js', 'settings.json', 'import-map.json', 'internal-prerequisites.js', 'builtin-report.json', 'ENGINE-LICENSE']);
const runtimeFile = name => runtimeNames.has(name) || name.startsWith('cocos-js/') || name.startsWith('assets/internal/');
let temporary;
let toolchainDirectory;
let validatorFile;
let compileGame;
let ts;
const fixtures = [];
let unavailable;

async function write(root, name, value) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, name), value, { mode: 0o600 });
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
function exportsOf(bytes) {
    const ast = ts.createSourceFile('cc.js', bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(ast.parseDiagnostics.length, 0);
    const names = new Set();
    const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'exports') {
            const value = node.arguments[0];
            if (ts.isStringLiteral(value)) names.add(value.text);
            else if (ts.isObjectLiteralExpression(value)) for (const property of value.properties) names.add(property.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    return [...names].sort();
}

before(async () => {
    try {
        await fs.lstat(path.join(sourceSdk, 'manifest.json'));
        for (const directory of directories) await fs.lstat(path.join(directory, 'runtime.json'));
    } catch (error) {
        if (error.code !== 'ENOENT' || process.env.BILIBILI_PACKAGE_SDK || process.env.BILIBILI_RUNTIME_DIRECTORIES
            || process.env.GAME_SDK_INTEGRATION === '1') throw error;
        unavailable = 'Real game SDK and BILIBILI runtimes absent; set BILIBILI_PACKAGE_SDK and BILIBILI_RUNTIME_DIRECTORIES to require integration.';
        return;
    }
    temporary = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cocos4-bilibili-package-'));
    toolchainDirectory = path.join(temporary, 'toolchain');
    await fs.cp(path.join(sourceSdk, 'toolchain'), toolchainDirectory, { recursive: true });
    validatorFile = path.join(temporary, 'app/validate-bilibili.cjs');
    const canonical = await fs.readFile(path.join(sourceSdk, 'app/validate-bilibili.cjs'));
    await write(temporary, 'app/validate-bilibili.cjs', canonical);
    const manifest = JSON.parse(await fs.readFile(path.join(sourceSdk, 'manifest.json')));
    assert.equal(hash(canonical), manifest.files.find(file => file.path === 'app/validate-bilibili.cjs').sha256);
    const require = createRequire(path.join(toolchainDirectory, 'package.json'));
    ts = require(path.join(toolchainDirectory, 'node_modules/typescript/lib/typescript.js'));
    assert.equal(ts.version, '4.9.5');
    ({ compileGame } = require(path.join(toolchainDirectory, 'compiler/compile-game.cjs')));
    for (const directory of directories) {
        const descriptor = JSON.parse(await fs.readFile(path.join(directory, 'runtime.json')));
        const project = path.join(temporary, descriptor.profile, 'project');
        const types = path.join(temporary, descriptor.profile, 'types');
        await fs.cp(path.join(directory, 'template'), project, { recursive: true });
        await fs.cp(path.join(directory, 'types'), types, { recursive: true });
        // Real public-cc fixture source is compiled again; no old game/*.js is copied.
        await fs.appendFile(path.join(project, 'src/main.ts'), '\nexport const revision = "FRESH_PACKAGE_COMPILATION";\nthrow new Error("PROJECT_CODE_MUST_NOT_EXECUTE");\n');
        await fs.writeFile(path.join(project, 'assets/rules.json'), '{"customProjectData":true,"image":"not-a-fixture-rule"}');
        await fs.writeFile(path.join(project, 'assets/custom.txt'), 'fresh project asset');
        const ccExports = exportsOf(await fs.readFile(path.join(directory, 'cocos-js/cc.js')));
        const compiled = path.join(temporary, descriptor.profile, 'compiled');
        const metadata = await compileGame({ projectDirectory: project, typesDirectory: types,
            outDirectory: compiled, toolchainDirectory, availableCCExports: ccExports });
        assert.equal(metadata.profileChecked, true);
        assert.deepEqual(metadata.diagnostics, []);
        const output = path.join(temporary, descriptor.profile, 'payload');
        const expectedRuntimeFiles = descriptor.files.filter(file => runtimeFile(file.path));
        for (const file of expectedRuntimeFiles) {
            const bytes = await fs.readFile(path.join(directory, file.path));
            assert.equal(hash(bytes), file.sha256);
            await write(output, file.path, bytes);
        }
        await fs.cp(compiled, path.join(output, 'game'), { recursive: true });
        await fs.cp(path.join(project, 'assets'), path.join(output, 'assets/game'), { recursive: true });
        await write(output, 'game-compiler.json', JSON.stringify(metadata));
        await write(output, 'game.json', await fs.readFile(path.join(directory, 'game.json')));
        fixtures.push({ directory: output, toolchainDirectory, validatorFile, expectedRuntimeFiles,
            requiredCCExports: metadata.requiredCCExports, ccExports, profile: descriptor.profile });
    }
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

async function copy(fixture) {
    const directory = await fs.mkdtemp(path.join(temporary, 'package-'));
    await fs.cp(fixture.directory, directory, { recursive: true });
    return { ...fixture, directory, expectedRuntimeFiles: fixture.expectedRuntimeFiles.map(file => ({ ...file })) };
}
function rejected(expected = 'ARTIFACT_INVALID') {
    return error => {
        assert.equal(error.code, expected, error.stack);
        assert.ok(error.message.length <= 2048);
        assert.doesNotMatch(error.message, /\/tmp\/opencode|PROJECT_CODE_MUST_NOT_EXECUTE/);
        if (error.report) {
            reportSchema.parse(error.report);
            assert.ok(Buffer.byteLength(JSON.stringify(error.report)) < 8192);
            assert.ok(error.report.items.some(item => item.status === 'failed'));
        }
        return true;
    };
}
async function rehash(options, name, value) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    await write(options.directory, name, bytes);
    const record = options.expectedRuntimeFiles.find(file => file.path === name);
    assert.ok(record);
    record.bytes = bytes.length; record.sha256 = hash(bytes);
}

test('fresh actual 2D/3D source packages validate without executing project code or requiring fixture assets', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    for (const fixture of fixtures) await t.test(fixture.profile, async () => {
        const before = await contents(fixture.directory);
        assert.match(before.get('game/main.js').toString(), /FRESH_PACKAGE_COMPILATION/);
        for (const name of ['runtime.json', 'engine-build.json', 'template/src/main.ts', 'types/cc.d.ts', 'compiler-dependencies.json']) assert.equal(before.has(name), false);
        const result = await validateBilibiliPackage(fixture);
        reportSchema.parse({ summary: 'Package validation', ...result });
        assert.deepEqual(result.validationLevels, ['staticModuleClosure', 'bilibiliSourcePreflight', 'copiedResourceInventory']);
        assert.ok(result.items.some(item => item.code === 'RESOURCE_LOADING_UNVERIFIED' && item.status === 'warning'));
        assert.ok(result.items.some(item => item.name === 'BILIBILI source preflight' && item.status === 'passed'));
        assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24 * 1024);
        assert.deepEqual(await contents(fixture.directory), before);
        t.diagnostic(`${fixture.profile}: ${before.size} files; ${result.items.find(item => item.name === 'BILIBILI source preflight').bytes} source bytes; ${result.items.filter(item => item.status === 'warning').length} warnings`);
        for (const name of ['Static module closure', 'Copied resource inventory']) t.diagnostic(`${fixture.profile}: ${result.items.find(item => item.name === name).message}`);
    });
});

test('immutable runtime mutations and missing mandatory files fail before source acceptance', async t => {
    if (unavailable) return t.skip(unavailable);
    for (const name of [...runtimeNames, 'cocos-js/cc.js', 'assets/internal/config.json', 'assets/internal/index.js']) {
        const options = await copy(fixtures[0]);
        await fs.rm(path.join(options.directory, name));
        await assert.rejects(validateBilibiliPackage(options), rejected());
    }
    const options = await copy(fixtures[0]);
    await fs.appendFile(path.join(options.directory, 'cocos-js/cc.js'), '\n/* mutated runtime */');
    await assert.rejects(validateBilibiliPackage(options), rejected());
    const missingManifest = await copy(fixtures[0]);
    missingManifest.expectedRuntimeFiles = missingManifest.expectedRuntimeFiles.filter(file => file.path !== 'loader.js');
    await assert.rejects(validateBilibiliPackage(missingManifest), rejected('SDK_INCOMPLETE'));
});

test('closed static CommonJS and System imports resolve; unsafe, unknown and computed project requests fail', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    for (const [source, code] of [
        ['require("outside-package");', 'ARTIFACT_INVALID'],
        ['require("node:fs");', 'ARTIFACT_INVALID'],
        ['require("../../escape.js");', 'PATH_OUTSIDE_WORKSPACE'],
        ['require("./%2e%2e/escape.js");', 'ARTIFACT_INVALID'],
        ['require("./missing.js");', 'ARTIFACT_INVALID'],
        ['System.import("unmapped");', 'ARTIFACT_INVALID'],
        ['System["import"]("./missing.js");', 'ARTIFACT_INVALID'],
        ['(globalThis["System"])["import"](("./missing.js"));', 'ARTIFACT_INVALID'],
        ['(require)(("./missing.js"));', 'ARTIFACT_INVALID'],
        ['System.import("https://example.invalid/external.js");', 'ARTIFACT_INVALID'],
        ['require(globalThis.projectModuleName);', 'ARTIFACT_INVALID'],
        ['const = "invalid parser input";', 'ARTIFACT_INVALID'],
        ['const illegalAnnotation: number = 1;', 'ARTIFACT_INVALID'],
        ['import "./missing.js";', 'ARTIFACT_INVALID'],
    ]) await t.test(source, async () => {
        const options = await copy(fixtures[0]);
        await fs.appendFile(path.join(options.directory, 'game/main.js'), `\n${source}`);
        await assert.rejects(validateBilibiliPackage(options), rejected(code));
    });
    const missing = await copy(fixtures[0]);
    await fs.rm(path.join(missing.directory, 'game/world.js'));
    await assert.rejects(validateBilibiliPackage(missing), rejected());
    const valid = await copy(fixtures[0]);
    await fs.appendFile(path.join(valid.directory, 'game/main.js'), '\nrequire("../assets/game/rules"); System.import("./game/world.js");');
    await validateBilibiliPackage(valid);
});

test('fixed engine binaries and internal builtin/config/settings closure are required', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    await t.test('missing manifest-bound binary', async () => {
        const options = await copy(fixtures[0]);
        // Negative inventory fixture only, not a claim of generating a WASM engine feature.
        options.expectedRuntimeFiles.push({ path: 'cocos-js/external/missing.wasm', bytes: 8, sha256: hash(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) });
        await assert.rejects(validateBilibiliPackage(options), rejected());
    });
    await t.test('fixed binary reference outside inventory', async () => {
        const options = await copy(fixtures[0]);
        await rehash(options, 'cocos-js/cc.js', `${await fs.readFile(path.join(options.directory, 'cocos-js/cc.js'), 'utf8')}\nconst binary = 'external/missing.wasm';`);
        await assert.rejects(validateBilibiliPackage(options), rejected());
    });
    await t.test('missing builtin resource', async () => {
        const options = await copy(fixtures[0]);
        const record = options.expectedRuntimeFiles.find(file => file.path.startsWith('assets/internal/import/'));
        await fs.rm(path.join(options.directory, record.path));
        await assert.rejects(validateBilibiliPackage(options), rejected());
    });
    for (const [property, value, code] of [['uuids', [], 'ARTIFACT_INVALID'], ['importBase', '../escape', 'PATH_OUTSIDE_WORKSPACE']]) {
        await t.test(`invalid internal config ${property}`, async () => {
            const options = await copy(fixtures[0]);
            const config = JSON.parse(await fs.readFile(path.join(options.directory, 'assets/internal/config.json')));
            await rehash(options, 'assets/internal/config.json', { ...config, [property]: value });
            await assert.rejects(validateBilibiliPackage(options), rejected(code));
        });
    }
    await t.test('unresolved builtin UUID reference', async () => {
        const options = await copy(fixtures[0]);
        const report = JSON.parse(await fs.readFile(path.join(options.directory, 'builtin-report.json')));
        const id = report.materials[0].uuid;
        const file = `assets/internal/import/${id.slice(0, 2)}/${id}.json`;
        const material = JSON.parse(await fs.readFile(path.join(options.directory, file)));
        material._effectAsset.__uuid__ = '00000000-0000-4000-8000-000000000000';
        await rehash(options, file, material);
        Object.assign(report.files.find(record => record.path === file), options.expectedRuntimeFiles.find(record => record.path === file));
        await rehash(options, 'builtin-report.json', report);
        await assert.rejects(validateBilibiliPackage(options), rejected());
    });
    await t.test('settings reference an absent bundle', async () => {
        const options = await copy(fixtures[0]);
        const settings = JSON.parse(await fs.readFile(path.join(options.directory, 'settings.json')));
        settings.assets.preloadBundles.push('absent');
        await rehash(options, 'settings.json', settings);
        await assert.rejects(validateBilibiliPackage(options), rejected());
    });
});

test('package export inventory follows the renamed System callback binding, not shadowed names', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    const options = await copy(fixtures[0]);
    // A static validator fixture, not a runnable replacement for the real engine.
    const engine = names => `System.register([], function (t) {
        function onAccelerometerChange(t) { t('SHADOWED_EXPORT'); t({ x: 1, y: 2, z: 3 }); }
        const nested = { callback(t) { t('ANOTHER_SHADOW'); } };
        return { setters: [], execute: function () {
            t(${JSON.stringify(names[0])}, 0);
            t(${JSON.stringify(Object.fromEntries(names.slice(1).map(name => [name, 0])))});
        } };
    });`;
    await rehash(options, 'cocos-js/cc.js', engine(options.ccExports));
    const result = await validateBilibiliPackage(options);
    assert.ok(result.items.some(item => item.name === 'Static module closure' && item.status === 'passed'));
    await assert.rejects(validateBilibiliPackage({ ...options,
        ccExports: [...options.ccExports, 'SHADOWED_EXPORT', 'ANOTHER_SHADOW', 'x', 'y', 'z'] }), rejected('SDK_INCOMPLETE'));
    await rehash(options, 'cocos-js/cc.js', engine(options.ccExports.slice(1)));
    await assert.rejects(validateBilibiliPackage(options), rejected('SDK_INCOMPLETE'));
});

test('SDK cc export linkage and fresh game compiler inventory cannot be fabricated', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    const options = await copy(fixtures[0]);
    await assert.rejects(validateBilibiliPackage({ ...options, requiredCCExports: [...options.requiredCCExports, 'UnavailableFeature'] }), rejected('FEATURE_NOT_IN_PROFILE'));
    await assert.rejects(validateBilibiliPackage({ ...options, ccExports: [...options.ccExports, 'UnavailableFeature'] }), rejected('SDK_INCOMPLETE'));
    const metadata = JSON.parse(await fs.readFile(path.join(options.directory, 'game-compiler.json')));
    await write(options.directory, 'game-compiler.json', JSON.stringify({ ...metadata, outputFiles: ['main.js'] }));
    await assert.rejects(validateBilibiliPackage(options), rejected());
    await write(options.directory, 'game-compiler.json', JSON.stringify({ ...metadata, requiredCCExports: [] }));
    await assert.rejects(validateBilibiliPackage(options), rejected());
    await write(options.directory, 'game-compiler.json', JSON.stringify({ ...metadata, typeChecked: false }));
    await assert.rejects(validateBilibiliPackage(options), rejected());
});

test('game.json is configurable but canonical failures and malformed JSON remain bounded', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    const options = await copy(fixtures[0]);
    await write(options.directory, 'game.json', JSON.stringify({ appId: 'local-config-override', version: '2.0.0', deviceOrientation: 'portrait' }));
    await validateBilibiliPackage(options);
    for (const config of [{ appId: '', version: '1' },
        ...[{ forbidden: {} }, null, true, false, 0, '', []].map(plugins => ({ appId: 'local', version: '1', plugins }))]) {
        await write(options.directory, 'game.json', JSON.stringify(config));
        await assert.rejects(validateBilibiliPackage(options), rejected());
    }
    await write(options.directory, 'game.json', '{"appId":' + 'SECRET_DO_NOT_ECHO'.repeat(10000));
    await assert.rejects(validateBilibiliPackage(options), error => {
        rejected()(error); assert.doesNotMatch(JSON.stringify(error.report), /SECRET_DO_NOT_ECHO/); return true;
    });
});

test('private files, links, traversal, development payloads and excessive sizes fail closed', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    for (const name of ['.env', '.git/config', 'assets/game/private.key']) {
        const options = await copy(fixtures[0]);
        await write(options.directory, name, 'private content');
        await assert.rejects(validateBilibiliPackage(options), rejected('PERMISSION_DENIED'));
    }
    for (const name of ['runtime.json', 'engine-build.json', 'types/cc.d.ts', 'template/src/main.ts', 'docs/readme.txt', 'game/MAIN.js']) {
        const options = await copy(fixtures[0]);
        await write(options.directory, name, '{}');
        await assert.rejects(validateBilibiliPackage(options), rejected());
    }
    const symlink = await copy(fixtures[0]);
    await fs.symlink(validatorFile, path.join(symlink.directory, 'assets/game/linked.txt'));
    await assert.rejects(validateBilibiliPackage(symlink), rejected('PATH_OUTSIDE_WORKSPACE'));
    const hardlink = await copy(fixtures[0]);
    await fs.link(path.join(hardlink.directory, 'assets/game/custom.txt'), path.join(hardlink.directory, 'assets/game/hardlink.txt'));
    await assert.rejects(validateBilibiliPackage(hardlink), rejected('PERMISSION_DENIED'));
    const huge = await copy(fixtures[0]);
    const handle = await fs.open(path.join(huge.directory, 'assets/game/huge.bin'), 'w');
    try { await handle.truncate(140 * 1024 * 1024); } finally { await handle.close(); }
    await assert.rejects(validateBilibiliPackage(huge), rejected('LIMIT_EXCEEDED'));
});

test('SDK-only parser pin and require guard reject tool substitution and ancestor dependencies', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    const fake = path.join(temporary, 'fake-toolchain');
    await write(fake, 'node_modules/typescript/lib/typescript.js', 'throw new Error("SUBSTITUTE_PARSER_EXECUTED");');
    await assert.rejects(validateBilibiliPackage({ ...fixtures[0], toolchainDirectory: fake }), error => {
        rejected('SDK_INCOMPLETE')(error); assert.doesNotMatch(error.message, /SUBSTITUTE_PARSER_EXECUTED/); return true;
    });
    const poisoned = path.join(temporary, 'poisoned/validate-bilibili.cjs');
    await write(path.dirname(poisoned), path.basename(poisoned), 'require("ancestor-only-package"); exports.validateBilibili = () => ({});');
    await write(temporary, 'node_modules/ancestor-only-package/index.js', 'globalThis.__bilibiliAncestorExecuted = true; throw new Error("ANCESTOR_EXECUTED");');
    await assert.rejects(validateBilibiliPackage({ ...fixtures[0], validatorFile: poisoned }), rejected('SDK_INCOMPLETE'));
    assert.equal(globalThis.__bilibiliAncestorExecuted, undefined);
    await assert.rejects(validateBilibiliPackage({ ...fixtures[0], toolchainDirectory: fixtures[0].directory }), rejected('SDK_INCOMPLETE'));
    const linked = path.join(temporary, 'linked-toolchain');
    await fs.mkdir(path.join(linked, 'node_modules'), { recursive: true });
    await fs.symlink(path.join(toolchainDirectory, 'node_modules/typescript'), path.join(linked, 'node_modules/typescript'));
    await assert.rejects(validateBilibiliPackage({ ...fixtures[0], toolchainDirectory: linked }), rejected('SDK_INCOMPLETE'));
});

test('fake artifact options produce bounded errors, not schema dumps', async t => {
    if (unavailable) return t.skip(unavailable);
    await assert.rejects(validateBilibiliPackage(null), rejected('INVALID_ARGUMENTS'));
    await assert.rejects(validateBilibiliPackage({ ...fixtures[0], directory: 'relative' }), rejected('INVALID_ARGUMENTS'));
    for (const values of [
        { expectedRuntimeFiles: [] },
        { expectedRuntimeFiles: [{ path: 'untrusted', bytes: -1, sha256: 'PRIVATE_INPUT'.repeat(10000) }] },
        { requiredCCExports: ['PRIVATE_INPUT'.repeat(10000)] },
        { ccExports: Array(5000).fill('Unavailable') },
    ]) await assert.rejects(validateBilibiliPackage({ ...fixtures[0], ...values }), error => {
        rejected()(error); assert.doesNotMatch(JSON.stringify(error.report), /PRIVATE_INPUT/); return true;
    });
});

test('custom project dynamic resource URLs are reported unverified, not checked against fixture rules', { timeout: 180000 }, async t => {
    if (unavailable) return t.skip(unavailable);
    const project = path.join(temporary, 'custom-project');
    await write(project, 'src/main.ts', `import { assetManager, JsonAsset } from 'cc';
        export async function start(): Promise<void> {
            const name = String(Date.now());
            assetManager.loadRemote<JsonAsset>('assets/game/' + name + '.json', () => {});
        }
        throw new Error('PROJECT_CODE_MUST_NOT_EXECUTE');`);
    const compiled = path.join(temporary, 'custom-compiled');
    const metadata = await compileGame({ projectDirectory: project, typesDirectory: path.join(temporary, fixtures[0].profile, 'types'),
        toolchainDirectory, outDirectory: compiled, availableCCExports: fixtures[0].ccExports });
    const options = await copy(fixtures[0]);
    await fs.rm(path.join(options.directory, 'game'), { recursive: true });
    await fs.rm(path.join(options.directory, 'assets/game'), { recursive: true });
    await fs.cp(compiled, path.join(options.directory, 'game'), { recursive: true });
    await write(options.directory, 'assets/game/project-data.json', '{"url":"this is application data, not package configuration"}');
    await write(options.directory, 'game-compiler.json', JSON.stringify(metadata));
    options.requiredCCExports = metadata.requiredCCExports;
    const result = await validateBilibiliPackage(options);
    assert.ok(result.items.some(item => item.code === 'RESOURCE_LOADING_UNVERIFIED'));
    assert.ok(result.items.every(item => item.status !== 'failed'));
});
