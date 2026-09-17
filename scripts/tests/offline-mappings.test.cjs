const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { buildOfflineMappings } = require('../build-offline-mappings.cjs');

test('real offline mappings compile and load without an engine host', { timeout: 120000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cocos-offline-mappings-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const out = path.join(directory, 'mappings.cjs');
    const { modules } = await buildOfflineMappings(out);
    assert.ok(modules.includes('editor/exports/offline-mappings.ts'));
    assert.ok(modules.includes('cocos/rendering/rendering-enums.ts'));
    const script = `
        const assert = require('node:assert/strict');
        const m = require(${JSON.stringify(out)});
        assert.equal(globalThis.cc, undefined);
        assert.equal(globalThis.nodeEnv, undefined);
        assert.equal(m.passParams.DEFAULT, 100);
        assert.equal(m.passParams.UI, 200);
        assert.equal(m.passParams[100], 'DEFAULT');
        assert.deepEqual(m.RenderPriority, { MIN: 0, MAX: 255, DEFAULT: 128, 0: 'MIN', 255: 'MAX', 128: 'DEFAULT' });
        assert.deepEqual(m.SetIndex, { GLOBAL: 0, MATERIAL: 1, LOCAL: 2, COUNT: 3, 0: 'GLOBAL', 1: 'MATERIAL', 2: 'LOCAL', 3: 'COUNT' });
        assert.equal(m.murmurhash2_32_gc('abcde', 3339675911), 730143326);
        assert.equal(m.GetTypeSize(m.typeMap.vec4), 16);
        assert.equal(m.typeMap[m.typeMap.vec4], 'vec4');
        const info = new m.SamplerInfo(2, 1, 0, 3, 2, 1, 15, 6);
        const unpacked = m.Sampler.unpackFromHash(m.Sampler.computeHash(info));
        for (const key of ['minFilter', 'magFilter', 'mipFilter', 'addressU', 'addressV', 'addressW', 'maxAnisotropy', 'cmpFunc']) {
            assert.equal(unpacked[key], info[key]);
        }
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--eval', script], {
        cwd: directory, timeout: 5000, env: process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT } : {},
    });
    assert.equal(stdout, '');
    assert.equal(stderr, '');
});
