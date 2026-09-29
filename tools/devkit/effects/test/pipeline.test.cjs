const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { promisify } = require('node:util');
const { prepareSource, verifySource, prepareCompiler, verifyCompiler } = require('../prepare-source.cjs');
const { applyCompilerPatch } = require('../compiler-patch.cjs');
const { collectBuiltinInputs } = require('../builtin-inputs.cjs');
const { probe } = require('../probe.cjs');
const { validateShaderMetadata } = require('../probe-worker.cjs');
const { buildOfflineMappings } = require('../../../../scripts/build-offline-mappings.cjs');
const lock = require('../source-lock.json');
const patchLock = require('../patch-lock.json');
const engine = path.resolve(__dirname, '../../../..');
let mappings;
let mappingFile;
let mappingDirectory;
before(async () => {
    mappingDirectory = await fs.mkdtemp(path.join(tmpdir(), 'cocos-effect-metadata-'));
    mappingFile = path.join(mappingDirectory, 'mappings.cjs');
    await buildOfflineMappings(mappingFile);
    mappings = require(mappingFile);
});
after(() => mappingDirectory && fs.rm(mappingDirectory, { recursive: true, force: true }));

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
    assert.equal(report.validation.shaderMetadata, true);
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
    const input = collectBuiltinInputs(engine, report.profile);
    for (const asset of input.assets) {
        const data = JSON.parse(await fs.readFile(path.join(output, `assets/internal/import/${asset.uuid.slice(0, 2)}/${asset.uuid}.json`)));
        const meta = JSON.parse(await fs.readFile(`${asset.file}.meta`));
        assert.equal(asset.uuid, meta.uuid);
        assert.equal(data._name, asset.name);
        if (asset.material) {
            assert.deepEqual(data, asset.material);
            continue;
        }
        assert.equal(data.__type__, 'cc.EffectAsset');
        assert.equal(report.effects.find(effect => effect.uuid === asset.uuid).name, asset.name);
        for (const shader of data.shaders) {
            assert.ok(shader.name.startsWith(`${asset.name}|`));
            validateShaderMetadata(shader, mappings);
            if (asset.name === 'builtin-unlit') {
                assert.deepEqual(shader.attributes.find(attribute => attribute.name === 'a_joints'), {
                    name: 'a_joints', defines: ['CC_USE_SKINNING'], format: mappings.getFormat('RGBA32UI'), location: 4,
                });
                assert.deepEqual(shader.attributes.find(attribute => attribute.name === 'a_jointAnimInfo'), {
                    name: 'a_jointAnimInfo', defines: ['USE_INSTANCING', 'CC_USE_BAKED_ANIMATION'],
                    format: mappings.getFormat('RGBA32F'), isInstanced: true, location: 6,
                });
                assert.match(shader.glsl4.vert, /in u32vec4 a_joints;/);
                assert.match(shader.glsl3.vert, /in vec4 a_joints;/);
                assert.match(shader.glsl1.vert, /attribute vec4 a_joints;/);
            }
        }
        for (const technique of data.techniques) {
            for (const pass of technique.passes) assert.ok(data.shaders.some(shader => shader.name === pass.program));
        }
    }
    return report;
}

test('the real joint declaration uses unsigned 32-bit arithmetic but WebGL float inputs with 16-bit storage', () => {
    const { chunks } = collectBuiltinInputs(engine, '2d-basic');
    const declaration = chunks.get('legacy/decode-base').replace('#include <common/common-define>',
        () => chunks.get('common/common-define'));
    const preprocessor = process.env.COCOS_EFFECT_GLSLANG || '/usr/bin/glslangValidator';
    for (const version of ['100', '300 es', '460']) {
        const source = `#version ${version}\n`
            + (version === '460' ? '#extension GL_EXT_shader_explicit_arithmetic_types_int32 : require\n' : '')
            + '#define CC_USE_SKINNING 1\n#define USE_INSTANCING 0\n#define CC_USE_MORPH 0\n'
            + `${declaration}\nvoid main() { gl_Position = vec4(a_joints); }\n`;
        const options = { input: source, encoding: 'utf8', timeout: 10000 };
        const preprocessed = execFileSync(preprocessor, ['--stdin', '-S', 'vert', '-E'], options);
        if (version === '460') {
            assert.match(preprocessed, /in u32vec4 a_joints\s*;/);
            assert.doesNotMatch(preprocessed, /#pragma format\(RGBA16UI\)/);
        } else {
            assert.match(preprocessed, /#pragma format\(RGBA16UI\)\s+layout\(location\s*=\s*4\) in vec4 a_joints\s*;/);
            assert.doesNotMatch(preprocessed, /u32vec4/);
        }
        // The chunk precedes GLSL100 lowering; GLSL300/460 can be linked directly for type reflection.
        if (version !== '100') {
            const reflection = execFileSync(preprocessor, ['--stdin', '-S', 'vert', '-l', '-q'], options);
            // GL_UNSIGNED_INT_VEC4 (0x8dc8), not GL_FLOAT_VEC4 (0x8b52) or a 16-bit arithmetic type.
            assert.match(reflection, new RegExp(`^a_joints: .*type ${version === '460' ? '8dc8' : '8b52'},`, 'm'));
        }
    }
});

test('shader metadata rejects unknown formats and malformed conditional reflection, including disabled attributes', () => {
    const shader = {
        name: 'metadata-regression',
        defines: [
            { name: 'CC_USE_SKINNING', type: 'boolean', defines: [] },
            { name: 'USE_INSTANCING', type: 'boolean', defines: [] },
            { name: 'COUNT', type: 'number', range: [0, 4], defines: ['!USE_INSTANCING'] },
            { name: 'CHANNEL', type: 'string', options: ['r', 'a'], defines: [] },
        ],
        attributes: [{ name: 'a_joints', format: mappings.getFormat('RGBA32UI'), location: 4, defines: ['CC_USE_SKINNING'] }],
    };
    assert.doesNotThrow(() => validateShaderMetadata(shader, mappings));
    for (const format of [undefined, null, 0, -1, NaN, Infinity, -Infinity, 1.5, '52', mappings.getFormat('COUNT'), 9999]) {
        const invalid = structuredClone(shader);
        invalid.attributes[0].format = format;
        assert.throws(() => validateShaderMetadata(invalid, mappings), /Invalid attribute format: metadata-regression\/a_joints/);
    }
    for (const defines of [undefined, null, 'CC_USE_SKINNING', [1], [''], ['!'], ['UNKNOWN'], ['!UNKNOWN'],
        ['!!CC_USE_SKINNING'], ['CC_USE_SKINNING || USE_INSTANCING'], ['CC_USE_SKINNING', 'CC_USE_SKINNING'],
        ['CC_USE_SKINNING', '!CC_USE_SKINNING']]) {
        const invalid = structuredClone(shader);
        invalid.attributes[0].defines = defines;
        assert.throws(() => validateShaderMetadata(invalid, mappings), /conditional metadata/);
    }
    for (const mutate of [
        value => { delete value.defines; },
        value => { value.defines.push(value.defines[0]); },
        value => { value.defines[0].type = 'unknown'; },
        value => { value.defines[0].defines = ['!']; },
        value => { value.defines[2].range = [4, 0]; },
        value => { value.defines[2].range = [0, Infinity]; },
        value => { value.defines[3].options = []; },
        value => { value.defines[3].options = ['r', 'r']; },
        value => { delete value.attributes; },
        value => { value.attributes.push({ ...value.attributes[0], location: 5 }); },
        value => { value.attributes.push({ ...value.attributes[0], name: 'duplicateLocation' }); },
        value => { value.attributes[0].name = ''; },
        value => { value.attributes[0].location = -1; },
        value => { value.attributes[0].location = 1.5; },
        value => { value.attributes[0].isNormalized = 1; },
        value => { value.attributes[0].isInstanced = 'true'; },
        value => { value.attributes[0].isInstanced = true; },
        value => { value.attributes[0].defines = ['USE_INSTANCING']; },
    ]) {
        const invalid = structuredClone(shader);
        mutate(invalid);
        assert.throws(() => validateShaderMetadata(invalid, mappings), /Invalid|Missing/);
    }
    shader.attributes[0].defines = ['CC_USE_SKINNING', '!USE_INSTANCING'];
    shader.defines[0].defines = ['SOURCE_CONSTANT'];
    assert.doesNotThrow(() => validateShaderMetadata(shader, mappings));
    shader.attributes[0].defines = ['CC_USE_SKINNING', 'USE_INSTANCING'];
    shader.attributes[0].isInstanced = true;
    assert.doesNotThrow(() => validateShaderMetadata(shader, mappings));
});

test('real compiler output with damaged conditional joint metadata fails before any resource or success report is written',
    { timeout: 120000 }, async (t) => {
        const directory = await fs.mkdtemp(path.join(__dirname, '../build/metadata-rejection-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const cc = path.join(directory, 'node_modules/cc');
        await fs.mkdir(cc, { recursive: true });
        await fs.copyFile(mappingFile, path.join(cc, 'mappings.cjs'));
        await fs.writeFile(path.join(cc, 'package.json'), JSON.stringify({
            name: 'cc', exports: { './editor/offline-mappings': './mappings.cjs' },
        }));
        const compiler = path.join(directory, 'compiler');
        await prepareCompiler(path.join(__dirname, '../build/compiler'), compiler);
        // Corrupt reflection after real compilation; never change the pinned compiler or its preprocessing.
        const preload = path.join(directory, 'damage.cjs');
        await fs.writeFile(preload, `
            const compiler = require(${JSON.stringify(compiler)});
            const buildEffect = compiler.buildEffect;
            compiler.buildEffect = (...args) => {
                const effect = buildEffect(...args);
                const attribute = effect.shaders.flatMap(shader => shader.attributes).find(attribute => attribute.name === 'a_joints');
                if (attribute) delete attribute[process.env.DAMAGE_FIELD];
                return effect;
            };
        `);
        for (const [field, message] of [
            ['format', /Invalid attribute format: builtin-unlit[^\n]*\/a_joints/],
            ['defines', /Missing conditional metadata: builtin-unlit[^\n]*\/a_joints/],
        ]) {
            const output = path.join(directory, field);
            await fs.mkdir(output);
            await assert.rejects(promisify(execFile)(process.execPath, ['--require', preload,
                path.join(__dirname, '../probe-worker.cjs'), engine, '2d-basic', output, compiler], {
                env: { ...process.env, DAMAGE_FIELD: field }, timeout: 60000,
            }), message);
            assert.deepEqual(await fs.readdir(output), []);
        }
    });

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
        assert.equal(asset.name, path.basename(asset.file, '.mtl'));
        assert.ok(input.assets.some(effect => effect.uuid === asset.material._effectAsset.__uuid__));
    }
    assert.ok(input.chunks.has('builtin/uniforms/cc-global'));
    assert.ok(input.features.includes('legacy-pipeline'));
    const full = collectBuiltinInputs(engine, '3d-basic');
    assert.equal(full.assets.length, 18);
    assert.deepEqual(full.assets.filter(asset => !asset.material).map(asset => asset.name).sort(), [
        'builtin-unlit', 'for2d/builtin-sprite', 'internal/builtin-clear-stencil', 'internal/builtin-graphics',
        'pipeline/deferred-lighting', 'pipeline/planar-shadow', 'pipeline/skybox', 'util/splash-screen',
    ]);
    assert.equal(full.assets.find(asset => asset.name === 'util/splash-screen').uuid, '970b0598-bcb0-4714-91fb-2e81440dccd8');
    assert.equal(full.assets.find(asset => asset.name === 'builtin-unlit').uuid, 'a3cd009f-0ab0-420d-9278-b9fdab939bbc');
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
