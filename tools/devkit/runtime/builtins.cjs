const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { collectBuiltinInputs, profiles } = require('../effects/builtin-inputs.cjs');
const { readRegular, sha256 } = require('./files.cjs');

async function readBuiltins({ engine, profile, builtinDirectory }) {
    assert.ok(Object.hasOwn(profiles, profile), `PROFILE_NOT_AVAILABLE: ${profile}`);
    const root = await fs.realpath(builtinDirectory);
    const reportBytes = await readRegular(root, 'result.json');
    const report = JSON.parse(reportBytes);
    assert.equal(report.profile, profile, 'Builtin profile mismatch');
    assert.deepEqual(report.features, profiles[profile], 'Builtin features mismatch');
    for (const check of ['compilerParser', 'compilerWebGL1', 'invalidShaderRejected']) {
        assert.equal(report.validation?.[check], true, `Builtin compilation not successful: ${check}`);
    }
    const inputs = collectBuiltinInputs(engine, profile);
    assert.deepEqual(report.inputs, Object.fromEntries(inputs.inputs), 'Builtin source inputs changed; rebuild builtins');
    const uuids = inputs.assets.map(asset => asset.uuid).sort();
    assert.deepEqual([...report.effects, ...report.materials].map(asset => asset.uuid).sort(), uuids);
    const expected = ['assets/internal/config.json', 'assets/internal/index.js', 'settings.fragment.json',
        ...uuids.map(uuid => `assets/internal/import/${uuid.slice(0, 2)}/${uuid}.json`)].sort();
    assert.deepEqual(report.files.map(file => file.path).sort(), expected, 'Unexpected builtin file closure');
    const files = new Map();
    for (const file of report.files) {
        const bytes = await readRegular(root, file.path);
        assert.equal(bytes.length, file.bytes, `Builtin size mismatch: ${file.path}`);
        assert.equal(sha256(bytes), file.sha256, `Builtin integrity mismatch: ${file.path}`);
        files.set(file.path, bytes);
    }
    const settings = JSON.parse(files.get('settings.fragment.json'));
    assert.deepEqual([...settings.engine.builtinAssets].sort(), uuids);
    assert.equal(settings.rendering.customPipeline, false);
    const config = JSON.parse(files.get('assets/internal/config.json'));
    assert.equal(config.name, 'internal');
    assert.deepEqual([...config.uuids].sort(), uuids);
    return { files, settings, report, reportBytes, reportSha256: sha256(reportBytes) };
}

module.exports = { readBuiltins };
