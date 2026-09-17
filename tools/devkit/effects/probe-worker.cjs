const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { collectBuiltinInputs } = require('./builtin-inputs.cjs');
const { compilerRegressions } = require('./test/compiler-regressions.cjs');

const [engine, profile, directory, compilerDirectory] = process.argv.slice(2);
const input = collectBuiltinInputs(engine, profile);
const gl = require('gl')(16, 16);
assert.ok(gl, 'HOST_GL_UNAVAILABLE: a working host GL context is required.');
const graphics = { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER) };
gl.getExtension('STACKGL_destroy_context').destroy();
const compiler = require(compilerDirectory);
const preprocessorPath = fs.realpathSync(process.env.COCOS_EFFECT_GLSLANG || '/usr/bin/glslangValidator');
const preprocessor = {
    path: preprocessorPath,
    version: execFileSync(preprocessorPath, ['--version'], { encoding: 'utf8', timeout: 10000 }),
    sha256: createHash('sha256').update(fs.readFileSync(preprocessorPath)).digest('hex'),
};
// This upstream revision gates both warnings and errors on throwOnWarning.
Object.assign(compiler.options, { throwOnError: true, throwOnWarning: true, skipParserTest: false, noSource: false });
for (const [name, content] of input.chunks) compiler.addChunk(name, content);

const records = [];
const effects = new Map();
for (const asset of input.assets.filter(asset => !asset.material)) {
    const effect = compiler.buildEffect(asset.name, asset.content);
    assert.ok(effect?.shaders?.length > 0, `No shaders generated: ${asset.name}`);
    assert.ok(effect.techniques.length > 0, `No techniques generated: ${asset.name}`);
    for (const shader of effect.shaders) {
        assert.ok(Number.isInteger(shader.hash), `Missing shader hash: ${asset.name}`);
        for (const version of ['glsl1', 'glsl3', 'glsl4']) {
            for (const stage of ['vert', 'frag']) {
                assert.ok(shader[version][stage].includes('void main'), `Missing ${version}/${stage}: ${asset.name}`);
                assert.doesNotMatch(shader[version][stage], /^\s*#include\b/m);
            }
        }
    }
    for (const technique of effect.techniques) {
        for (const pass of technique.passes) assert.ok(effect.shaders.some(shader => shader.name === pass.program));
    }
    effects.set(asset.uuid, effect);
    records.push({ uuid: asset.uuid, name: asset.name, shaders: effect.shaders.length, chunks: effect.dependencies });
}

const regressions = compilerRegressions(compiler);
assert.equal(createHash('sha256').update(fs.readFileSync(preprocessorPath)).digest('hex'), preprocessor.sha256,
    'GLSL preprocessor changed during compilation');

const files = [];
const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: 'wx' });
    files.push({ path: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
};
for (const asset of input.assets) {
    const compiled = effects.get(asset.uuid);
    const data = asset.material || {
        __type__: 'cc.EffectAsset', _name: asset.name, _objFlags: 0, _native: '',
        techniques: compiled.techniques, shaders: compiled.shaders, combinations: [],
    };
    if (asset.material) assert.ok(effects.has(asset.material._effectAsset.__uuid__));
    write(`assets/internal/import/${asset.uuid.slice(0, 2)}/${asset.uuid}.json`, JSON.stringify(data));
}
write('assets/internal/config.json', JSON.stringify({
    name: 'internal', importBase: 'import', nativeBase: 'native',
    uuids: input.assets.map(asset => asset.uuid), paths: {}, scenes: {}, packs: {}, deps: [],
    versions: { import: [], native: [] }, redirect: [], types: [], extensionMap: {}, debug: true,
}));
write('assets/internal/index.js', "'use strict';\n");
write('settings.fragment.json', JSON.stringify({
    engine: { builtinAssets: input.assets.map(asset => asset.uuid) }, rendering: { customPipeline: false },
}));
for (const [relative, hash] of input.inputs) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(engine, relative))).digest('hex'), hash,
        `INPUT_CHANGED: ${relative}`);
}
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({
    profile, features: input.features, graphics, preprocessor, effects: records,
    materials: input.assets.filter(asset => asset.material).map(asset => ({ uuid: asset.uuid, name: asset.name })),
    inputs: Object.fromEntries([...input.inputs].sort(([a], [b]) => a < b ? -1 : 1)), files,
    validation: { compilerParser: true, compilerWebGL1: true, invalidShaderRejected: true, regressions,
        options: { skipParserTest: compiler.options.skipParserTest, throwOnError: compiler.options.throwOnError,
            throwOnWarning: compiler.options.throwOnWarning },
        browser: false, webGL2Driver: false, runtimeBundleLoading: false },
}, null, 2), { flag: 'wx' });
