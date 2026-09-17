const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { prepareSource, verifySource, prepareCompiler, verifyCompiler } = require('../prepare-source.cjs');
const { applyCompilerPatch } = require('../compiler-patch.cjs');
const { collectBuiltinInputs } = require('../builtin-inputs.cjs');
const { probe } = require('../probe.cjs');
const lock = require('../source-lock.json');
const patchLock = require('../patch-lock.json');
const engine = path.resolve(__dirname, '../../../..');

async function verifyArtifact(output) {
    const report = JSON.parse(await fs.readFile(path.join(output, 'result.json')));
    for (const file of report.files) {
        const bytes = await fs.readFile(path.join(output, file.path));
        assert.equal(bytes.length, file.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    assert.equal(report.validation.compilerWebGL1, true);
    assert.equal(report.validation.compilerParser, true);
    assert.equal(report.validation.invalidShaderRejected, true);
    assert.deepEqual(report.validation.regressions, [
        'conditional-expression', 'disabled-glsl3-branch', 'active-glsl3-rejected-in-glsl1',
        'active-invalid-branch', 'preprocessor-error', 'preprocessor-warning', 'compiler-warning',
        'malformed-shader-driver-failure',
    ]);
    assert.deepEqual(report.validation.options, { skipParserTest: false, throwOnError: true, throwOnWarning: true });
    assert.equal(report.validation.browser, false);
    assert.equal(report.validation.runtimeBundleLoading, false);
    assert.equal(report.validation.webGL2Driver, false);
    assert.deepEqual(report.compiler, { ...lock, patch: patchLock });
    assert.match(report.preprocessor.version, /^Glslang Version: 11:16\.4\.0\n/);
    assert.match(report.preprocessor.sha256, /^[a-f0-9]{64}$/);
    return report;
}

test('source preparation is pinned, repeatable and does not replace a valid compiler on tampering', async (t) => {
    const files = await verifySource(path.join(__dirname, '../build/compiler'));
    const temporary = await fs.mkdtemp(path.join(tmpdir(), 'cocos-effect-source-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const checkout = path.join(temporary, 'checkout');
    const destination = path.join(temporary, 'prepared');
    for (const [name, bytes] of files) {
        const file = path.join(checkout, lock.files[name][0]);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
    }
    await prepareSource(checkout, destination);
    await prepareSource(checkout, destination);
    assert.deepEqual(await verifySource(destination), files);
    await fs.appendFile(path.join(checkout, lock.files['index.js'][0]), '\n// altered\n');
    await assert.rejects(prepareSource(checkout, destination), /Compiler input changed/);
    assert.deepEqual(await verifySource(destination), files);
    await fs.rm(path.join(destination, 'index.js'));
    await assert.rejects(verifySource(destination), /ENOENT/);
});

test('audited patch is deterministic, repeatable, and rejects modified sources or prepared output', async (t) => {
    const source = path.join(__dirname, '../build/compiler');
    const original = await verifySource(source);
    const temporary = await fs.mkdtemp(path.join(tmpdir(), 'cocos-effect-patch-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const destination = path.join(temporary, 'patched');
    const files = await prepareCompiler(source, destination);
    assert.deepEqual(await prepareCompiler(source, destination), files);
    await verifyCompiler(destination, files);
    assert.equal(createHash('sha256').update(files.get('shdc-lib.js')).digest('hex'), patchLock.outputSha256);
    assert.deepEqual(JSON.parse(files.get('patch-manifest.json')), patchLock);
    for (const [name, bytes] of original) {
        if (name !== 'shdc-lib.js') assert.deepEqual(files.get(name), bytes);
    }
    assert.throws(() => applyCompilerPatch('unreviewed compiler'), /Missing validation define policy/);
    assert.throws(() => applyCompilerPatch(files.get('shdc-lib.js').toString()), /Missing validation define policy/);
    const alteredSource = path.join(temporary, 'source');
    await fs.cp(source, alteredSource, { recursive: true });
    await fs.appendFile(path.join(alteredSource, 'shdc-lib.js'), '\n// altered\n');
    await assert.rejects(prepareCompiler(alteredSource, path.join(temporary, 'must-not-exist')), /Compiler input changed/);
    await assert.rejects(fs.lstat(path.join(temporary, 'must-not-exist')), /ENOENT/);
    await fs.appendFile(path.join(destination, 'shdc-lib.js'), '\n// altered\n');
    const tampered = await fs.readFile(path.join(destination, 'shdc-lib.js'));
    await assert.rejects(prepareCompiler(source, destination), /Patched compiler input changed/);
    assert.deepEqual(await fs.readFile(path.join(destination, 'shdc-lib.js')), tampered);
    assert.deepEqual(await verifySource(source), original);
});

test('patch revision, script digest and output digest guards fail before creating a compiler', async (t) => {
    const temporary = await fs.mkdtemp(path.join(tmpdir(), 'cocos-effect-guards-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    for (const [field, value, message] of [
        ['revision', 'unreviewed-revision', /Compiler patch revision changed/],
        ['scriptSha256', '0'.repeat(64), /Compiler patch changed/],
        ['outputSha256', '0'.repeat(64), /Patched compiler changed/],
    ]) {
        const sandbox = path.join(temporary, field);
        await fs.mkdir(sandbox);
        for (const file of ['prepare-source.cjs', 'source-lock.json', 'compiler-patch.cjs']) {
            await fs.copyFile(path.join(__dirname, '..', file), path.join(sandbox, file));
        }
        await fs.writeFile(path.join(sandbox, 'patch-lock.json'), JSON.stringify({ ...patchLock, [field]: value }));
        const destination = path.join(sandbox, 'must-not-exist');
        const { prepareCompiler: guardedPrepare } = require(path.join(sandbox, 'prepare-source.cjs'));
        await assert.rejects(guardedPrepare(path.join(__dirname, '../build/compiler'), destination), message);
        await assert.rejects(fs.lstat(destination), /ENOENT/);
    }
});

test('configured builtin roots resolve to real source UUIDs, materials and shader chunks', () => {
    const input = collectBuiltinInputs(engine, '2d-basic');
    assert.equal(input.assets.length, 15);
    assert.equal(input.assets.filter(asset => !asset.material).length, 5);
    for (const asset of input.assets.filter(asset => asset.material)) {
        assert.equal(asset.material._name, asset.name);
        assert.ok(input.assets.some(effect => effect.uuid === asset.material._effectAsset.__uuid__));
    }
    assert.ok(input.chunks.has('builtin/uniforms/cc-global'));
    assert.ok(input.features.includes('legacy-pipeline'));
    const full = collectBuiltinInputs(engine, '3d-basic');
    assert.equal(full.assets.length, 18);
    assert.deepEqual(full.assets.filter(asset => !asset.material).map(asset => asset.name).sort(), [
        'builtin-clear-stencil', 'builtin-graphics', 'builtin-sprite', 'builtin-unlit',
        'deferred-lighting', 'planar-shadow', 'skybox', 'splash-screen',
    ]);
    assert.throws(() => collectBuiltinInputs(engine, '../unknown'), /Unknown builtin profile/);
});

test('real 2D compilation is reproducible; preprocessor failure cannot replace successful artifacts',
    { timeout: 240000 }, async (t) => {
        const first = await probe('2d-basic');
        t.after(() => fs.rm(first.output, { recursive: true, force: true }));
        const firstBytes = await fs.readFile(path.join(first.output, 'result.json'));
        const report = await verifyArtifact(first.output);
        assert.equal(report.effects.length, 5);
        assert.equal(report.materials.length, 10);
        assert.equal(report.effects.reduce((sum, effect) => sum + effect.shaders, 0), 6);
        const second = await probe('2d-basic');
        t.after(() => fs.rm(second.output, { recursive: true, force: true }));
        const repeated = await verifyArtifact(second.output);
        assert.deepEqual(repeated.files, report.files);
        assert.deepEqual(repeated.inputs, report.inputs);
        assert.equal(repeated.mappings.sha256, report.mappings.sha256);
        assert.deepEqual(repeated.preprocessor, report.preprocessor);
        // A missing real preprocessor must fail closed; no fallback to the old token filter.
        const build = path.join(__dirname, '../build');
        const before = new Set(await fs.readdir(build));
        await assert.rejects(promisify(execFile)(process.execPath, [path.join(__dirname, '../probe.cjs'), '3d-basic'], {
            env: { ...process.env, COCOS_EFFECT_GLSLANG: path.join(build, 'missing-glslang') }, timeout: 120000,
        }), /Effect probe failed/);
        const failures = (await fs.readdir(build)).filter(name => !before.has(name));
        assert.equal(failures.length, 1);
        assert.match(failures[0], /^failure-.*\.log$/);
        assert.match(await fs.readFile(path.join(build, failures[0]), 'utf8'), /GLSL preprocessing failed:.*ENOENT/);
        t.after(() => fs.rm(path.join(build, failures[0])));
        assert.deepEqual(await fs.readFile(path.join(first.output, 'result.json')), firstBytes);
        await verifyArtifact(first.output);
        const entries = await fs.readdir(path.join(__dirname, '../build'));
        assert.equal(entries.some(name => name.startsWith('artifact-staging-')), false);
    });

test('full configured 3D compilation passes parser/host GL regressions and is reproducible',
    { timeout: 240000 }, async (t) => {
        const first = await probe('3d-basic');
        t.after(() => fs.rm(first.output, { recursive: true, force: true }));
        const report = await verifyArtifact(first.output);
        const input = collectBuiltinInputs(engine, '3d-basic');
        assert.deepEqual(report.effects.map(effect => effect.uuid), input.assets.filter(asset => !asset.material).map(asset => asset.uuid));
        assert.equal(report.effects.length, 8);
        assert.equal(report.effects.reduce((sum, effect) => sum + effect.shaders, 0), 9);
        assert.equal(report.materials.length, 10);
        assert.equal(report.files.length, 21);
        const second = await probe('3d-basic');
        t.after(() => fs.rm(second.output, { recursive: true, force: true }));
        const repeated = await verifyArtifact(second.output);
        assert.deepEqual(repeated.files, report.files);
        assert.deepEqual(repeated.inputs, report.inputs);
        assert.equal(repeated.mappings.sha256, report.mappings.sha256);
        assert.deepEqual(repeated.preprocessor, report.preprocessor);
    });
