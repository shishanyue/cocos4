const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { PNG } = require('pngjs');
const { features, inventory, readAssets, safePath, sha256 } = require('../files.cjs');
const { serveArtifact } = require('../server.cjs');
const { assertPixels } = require('../verify.cjs');

const root = path.resolve(__dirname, '..');
async function temporary(t) {
    await fs.mkdir(path.join(root, 'build'), { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'build/test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('runtime paths reject traversal, absolute paths and ambiguous separators', () => {
    for (const name of ['../source.ts', '/etc/passwd', 'assets/../game.ts', 'a\\b', 'a//b', './a']) {
        assert.throws(() => safePath(name));
    }
    assert.equal(safePath('assets/internal/import/aa/id.json'), 'assets/internal/import/aa/id.json');
    assert.ok(features.includes('legacy-pipeline'));
    assert.ok(!features.includes('gfx-empty'));
});

test('pixel assertions reject clear-only and wrong-colour screenshots', () => {
    const image = new PNG({ width: 640, height: 480 });
    for (let i = 0; i < image.data.length; i += 4) image.data.set([16, 24, 40, 255], i);
    assert.throws(() => assertPixels(PNG.sync.write(image), false), /Image light half/);
    image.data.fill(255);
    assert.throws(() => assertPixels(PNG.sync.write(image), false), /Camera clear/);
});

test('artifact server rejects modified bytes and serves only an immutable runtime snapshot', async t => {
    const directory = await temporary(t);
    const artifact = path.join(directory, 'artifact');
    await fs.mkdir(artifact);
    await fs.writeFile(path.join(artifact, 'index.html'), '<!doctype html><title>fixture</title>');
    const report = { kind: 'cocos4-browser-bootstrap', files: await inventory(artifact) };
    await fs.writeFile(path.join(directory, 'build-report.json'), JSON.stringify(report));
    await fs.writeFile(path.join(directory, 'source.ts'), 'not runtime');
    const server = await serveArtifact(artifact);
    t.after(server.close);
    await fs.writeFile(path.join(artifact, 'index.html'), 'changed after snapshot');
    assert.match(await (await fetch(server.url)).text(), /fixture/);
    for (const name of ['source.ts', 'build-report.json', 'game.js.map', 'cocos/game/game.ts', '%2e%2e%2fsource.ts']) {
        assert.equal((await fetch(server.url + name)).status, 404, name);
    }
    await assert.rejects(serveArtifact(artifact), /Runtime artifact changed/);
});

test('asset selection fails closed on mismatched hashes before executing build tools', async t => {
    const directory = await temporary(t);
    const source = path.join(directory, 'source');
    const assets = path.join(directory, 'assets');
    await fs.mkdir(source);
    await fs.mkdir(assets);
    const record = { path: 'settings.fragment.json', bytes: 2, sha256: sha256('{}') };
    const report = { profile: '2d-basic', features, effects: Array(5).fill({}), materials: Array(10).fill({}),
        validation: { compilerParser: true, compilerWebGL1: true }, files: [record] };
    await fs.writeFile(path.join(assets, 'result.json'), JSON.stringify(report));
    await fs.writeFile(path.join(assets, record.path), '[]');
    await assert.rejects(readAssets(assets, source), /Asset hash mismatch/);
});
