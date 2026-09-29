const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const profiles = {
    '2d-basic': ['base', '2d', 'ui', 'audio', 'tween', 'gfx-webgl', 'gfx-webgl2', 'legacy-pipeline'],
    '3d-basic': ['base', '2d', 'ui', 'audio', 'tween', 'gfx-webgl', 'gfx-webgl2', 'legacy-pipeline',
        '3d', 'animation', 'skeletal-animation', 'primitive'],
};

function collectBuiltinInputs(engine, profile) {
    assert.ok(Object.hasOwn(profiles, profile), `Unknown builtin profile: ${profile}`);
    const inputs = new Map();
    const read = (file) => {
        assert.ok(fs.lstatSync(file).isFile(), `Expected a regular builtin input: ${file}`);
        const bytes = fs.readFileSync(file);
        inputs.set(path.relative(engine, file).replaceAll('\\', '/'), createHash('sha256').update(bytes).digest('hex'));
        return bytes.toString('utf8');
    };
    const config = JSON.parse(read(path.join(engine, 'cc.config.json')));
    const uuids = new Set();
    for (const feature of profiles[profile]) {
        assert.ok(Object.hasOwn(config.features, feature), `Missing profile feature: ${feature}`);
        for (const uuid of config.features[feature].dependentAssets || []) uuids.add(uuid);
    }
    const assets = new Map();
    const chunks = new Map();
    const walk = (directory, visit) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const file = path.join(directory, entry.name);
            assert.ok(!entry.isSymbolicLink(), `Symlink in builtin inputs: ${file}`);
            if (entry.isDirectory()) walk(file, visit);
            else if (entry.isFile()) visit(file);
            else throw new Error(`Special file in builtin inputs: ${file}`);
        }
    };
    for (const directory of ['effects', 'default_materials']) {
        walk(path.join(engine, 'editor/assets', directory), (file) => {
            if (!file.endsWith('.meta')) return;
            const meta = JSON.parse(read(file));
            if (!meta.uuid) return;
            assert.ok(!assets.has(meta.uuid), `Duplicate builtin UUID: ${meta.uuid}`);
            assets.set(meta.uuid, { uuid: meta.uuid, file: file.slice(0, -5), importer: meta.importer });
        });
    }
    const selected = [];
    for (const uuid of uuids) {
        const asset = assets.get(uuid);
        assert.ok(asset, `Unresolved builtin UUID: ${uuid}`);
        assert.ok(['.effect', '.mtl'].includes(path.extname(asset.file)), `Unsupported builtin: ${asset.file}`);
        const content = read(asset.file);
        if (asset.file.endsWith('.mtl')) {
            const name = path.basename(asset.file, '.mtl');
            const material = JSON.parse(content);
            assert.equal(material.__type__, 'cc.Material');
            assert.equal(typeof material._effectAsset?.__uuid__, 'string');
            uuids.add(material._effectAsset.__uuid__);
            material._name = name;
            selected.push({ uuid, name, material, file: asset.file });
        } else {
            const name = path.relative(path.join(engine, 'editor/assets/effects'), asset.file).replaceAll('\\', '/').slice(0, -7);
            selected.push({ uuid, name, content, file: asset.file });
        }
    }
    walk(path.join(engine, 'editor/assets/chunks'), (file) => {
        if (!file.endsWith('.chunk')) return;
        const name = path.relative(path.join(engine, 'editor/assets/chunks'), file).replaceAll('\\', '/').slice(0, -6);
        chunks.set(name, read(file));
    });
    return { profile, features: profiles[profile], assets: selected.sort((a, b) => a.uuid < b.uuid ? -1 : 1), chunks, inputs };
}

module.exports = { profiles, collectBuiltinInputs };
