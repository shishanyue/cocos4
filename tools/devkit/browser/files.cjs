const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const features = ['base', '2d', 'ui', 'audio', 'tween', 'gfx-webgl', 'gfx-webgl2', 'legacy-pipeline'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function safePath(name) {
    assert.equal(typeof name, 'string');
    assert.match(name, /^[a-zA-Z0-9_./@-]+$/);
    assert.ok(!path.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe path: ${name}`);
    return name;
}

async function inventory(directory, prefix = '', exclude = []) {
    const files = [];
    for (const entry of (await fs.readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + entry.name;
        if (exclude.includes(name)) continue;
        if (entry.isDirectory()) files.push(...await inventory(directory, `${name}/`, exclude));
        else {
            assert.ok(entry.isFile(), `Not a regular file: ${name}`);
            const bytes = await fs.readFile(path.join(directory, name));
            files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
        }
    }
    return files;
}

async function readAssets(directory, engine) {
    const reportBytes = await fs.readFile(path.join(directory, 'result.json'));
    const report = JSON.parse(reportBytes);
    assert.equal(report.profile, '2d-basic');
    assert.deepEqual(report.features, features);
    assert.equal(report.effects.length, 5);
    assert.equal(report.materials.length, 10);
    assert.equal(report.validation.compilerParser, true);
    assert.equal(report.validation.compilerWebGL1, true);
    const files = new Map();
    for (const record of report.files) {
        const name = safePath(record.path);
        assert.ok(name === 'settings.fragment.json' || name.startsWith('assets/internal/'));
        assert.ok(!files.has(name), `Duplicate asset: ${name}`);
        const bytes = await fs.readFile(path.join(directory, name));
        assert.equal(bytes.length, record.bytes, name);
        assert.equal(sha256(bytes), record.sha256, `Asset hash mismatch: ${name}`);
        files.set(name, bytes);
    }
    const actual = (await inventory(directory)).filter(file => file.path !== 'result.json');
    assert.deepEqual(actual.map(file => file.path).sort(), [...files.keys()].sort(), 'Unlisted asset files');
    assert.equal(files.size, 18);
    assert.ok(Object.keys(report.inputs).length > 0);
    for (const [name, digest] of Object.entries(report.inputs)) {
        assert.equal(sha256(await fs.readFile(path.join(engine, safePath(name)))), digest, `Stale asset source: ${name}`);
    }
    const settings = JSON.parse(files.get('settings.fragment.json'));
    assert.deepEqual([...settings.engine.builtinAssets].sort(), [...report.effects, ...report.materials].map(asset => asset.uuid).sort());
    assert.equal(settings.rendering.customPipeline, false);
    return { report, reportBytes, settings, files };
}

module.exports = { features, sha256, safePath, inventory, readAssets };
