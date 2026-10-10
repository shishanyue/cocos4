import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { archiveRelease, deliverAndroidReleaseInputs, readAndroidReleaseInputs } from '../scripts/prepare-release.mjs';
import { androidToolFiles, archiveChecksums, verifyAndroidTools } from '../scripts/verify-portable.mjs';

const devkitRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const androidFixtureBase = path.join(devkitRoot, 'build');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function androidFixture(t, copySources = true) {
    await fs.mkdir(androidFixtureBase, { recursive: true });
    const root = await fs.mkdtemp(path.join(androidFixtureBase, 'android-release-test-'));
    t.after(async () => {
        assert.equal(path.dirname(root), androidFixtureBase, 'Cleanup must stay inside the devkit build directory');
        assert(/^android-release-test-[A-Za-z0-9]+$/.test(path.basename(root)), 'Only this generated fixture may be removed');
        await fs.rm(root, { recursive: true, force: true });
    });
    if (copySources) {
        await fs.mkdir(path.join(root, 'android'));
        for (const name of androidToolFiles) {
            await fs.copyFile(path.join(devkitRoot, 'android', name), path.join(root, 'android', name));
        }
    }
    return root;
}

function androidManifest(inputs) {
    return {
        tools: { android: { schemaVersion: 1, directory: 'app/android', files: inputs.map(input => input.name).sort() } },
        files: [
            ...inputs.map(input => ({ path: `app/android/${input.name}`, bytes: input.data.length,
                sha256: sha256(input.data), mode: '0444', origin: { kind: 'reviewed-source', path: input.source.path } })),
            { path: 'app/src/android-cli.js', bytes: 1, mode: '0444', origin: { kind: 'compiled-typescript' } },
        ],
    };
}

test('portable Android delivery preserves every reviewed source byte, digest and provenance', async t => {
    const inputs = await readAndroidReleaseInputs(devkitRoot);
    const actualNames = (await fs.readdir(path.join(devkitRoot, 'android'))).sort();
    assert.deepEqual(inputs.map(input => input.name), actualNames, 'The release reader must include the complete Android directory');
    assert(androidToolFiles.includes('cli.mjs'), 'The portable CLI is part of the mandatory tool closure');
    for (const input of inputs) {
        const bytes = await fs.readFile(path.join(devkitRoot, 'android', input.name));
        assert(Buffer.isBuffer(input.data));
        assert.deepEqual(input.data, bytes);
        assert.deepEqual(input.source, { path: `android/${input.name}`, bytes: bytes.length, sha256: sha256(bytes) });
    }

    const root = await androidFixture(t, false);
    const delivered = [];
    await deliverAndroidReleaseInputs(inputs, async (relative, bytes, origin) => {
        assert(/^app\/android\/(?:README\.md|[a-z0-9-]+\.mjs)$/.test(relative));
        const filename = path.resolve(root, relative);
        assert(filename.startsWith(root + path.sep), 'The delivery callback must only write inside this fixture');
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o444 });
        delivered.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes), mode: '0444', origin });
    });
    assert.deepEqual(delivered, androidManifest(inputs).files.filter(file => file.path.startsWith('app/android/')));
    assert.deepEqual((await fs.readdir(path.join(root, 'app/android'))).sort(), actualNames);
    for (const input of inputs) {
        const bytes = await fs.readFile(path.join(root, 'app/android', input.name));
        assert.deepEqual(bytes, await fs.readFile(path.join(devkitRoot, 'android', input.name)));
        assert.equal(sha256(bytes), input.source.sha256);
        if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, 'app/android', input.name))).mode & 0o777, 0o444);
    }
    const manifest = androidManifest(inputs);
    manifest.files = [...delivered, manifest.files.at(-1)];
    assert.doesNotThrow(() => verifyAndroidTools(manifest));
});

test('Android release inputs reject files outside the reviewed flat ESM closure', async t => {
    for (const name of ['unreviewed.json', 'Uppercase.mjs', 'bad_name.mjs', 'nested/tool.mjs',
        'build/tool.mjs', 'node_modules/tool.mjs', '.git/tool.mjs']) {
        await t.test(name, async child => {
            const root = await androidFixture(child);
            const filename = path.join(root, 'android', name);
            await fs.mkdir(path.dirname(filename), { recursive: true });
            await fs.writeFile(filename, 'unreviewed fixture\n');
            await assert.rejects(readAndroidReleaseInputs(root), /Only reviewed Android ESM tools/);
        });
    }
    await t.test('mandatory source cannot be replaced by another valid ESM file', async child => {
        const root = await androidFixture(child);
        await fs.unlink(path.join(root, 'android/cli.mjs'));
        await fs.writeFile(path.join(root, 'android/extra.mjs'), 'export {};\n');
        await assert.rejects(readAndroidReleaseInputs(root), /Missing Android tool source: cli\.mjs/);
    });
    await t.test('empty source', async child => {
        const root = await androidFixture(child);
        await fs.writeFile(path.join(root, 'android/cli.mjs'), '');
        await assert.rejects(readAndroidReleaseInputs(root), /Empty Android tool source: cli\.mjs/);
    });
    await t.test('symbolic source link', async child => {
        const root = await androidFixture(child);
        const link = path.join(root, 'android/linked.mjs');
        await fs.symlink(path.join(root, 'android/cli.mjs'), link, 'file');
        try {
            assert((await fs.lstat(link)).isSymbolicLink());
            await assert.rejects(readAndroidReleaseInputs(root), /Only reviewed Android ESM tools/);
        } finally { await fs.unlink(link); }
    });
});

test('Android delivery detects mutated source snapshots before writing the affected file', async t => {
    const inputs = await readAndroidReleaseInputs(devkitRoot);
    for (const [name, mutate] of [
        ['bytes', input => { input.data[0] ^= 1; }],
        ['source path', input => { input.source.path = 'android/other.mjs'; }],
        ['source length', input => { input.source.bytes++; }],
        ['source digest', input => { input.source.sha256 = '0'.repeat(64); }],
    ]) {
        await t.test(name, async () => {
            const input = { ...inputs[0], data: Buffer.from(inputs[0].data), source: { ...inputs[0].source } };
            mutate(input);
            let writes = 0;
            await assert.rejects(deliverAndroidReleaseInputs([input], async () => { writes++; }), /Android tool source changed before delivery/);
            assert.equal(writes, 0);
        });
    }
});

test('portable Android metadata requires the source closure, readonly provenance and CLI bridge', async t => {
    const inputs = await readAndroidReleaseInputs(devkitRoot);
    const valid = androidManifest(inputs);
    assert.doesNotThrow(() => verifyAndroidTools(valid));
    for (const [name, mutate, expected] of [
        ['schema', manifest => { manifest.tools.android.schemaVersion = 2; }, /Unsupported Android tool layout/],
        ['directory', manifest => { manifest.tools.android.directory = 'android'; }, /Unsupported Android tool layout/],
        ['null metadata', manifest => { manifest.tools.android = null; }, /Unsupported Android tool layout/],
        ['nested name', manifest => { manifest.tools.android.files.push('nested/tool.mjs'); }, /reviewed ESM files/],
        ['unsorted inventory', manifest => { manifest.tools.android.files.reverse(); }, /sorted without duplicates/],
        ['duplicate inventory', manifest => { manifest.tools.android.files.push(manifest.tools.android.files[0]); }, /sorted without duplicates/],
        ['missing required CLI', manifest => {
            manifest.tools.android.files = manifest.tools.android.files.filter(name => name !== 'cli.mjs').concat('extra.mjs').sort();
        }, /Missing Android tool: cli\.mjs/],
        ['missing payload', manifest => { manifest.files = manifest.files.filter(file => file.path !== 'app/android/cli.mjs'); }, /Android tool payload mismatch/],
        ['extra payload', manifest => { manifest.files.push({ ...manifest.files[0], path: 'app/android/extra.mjs' }); }, /Android tool payload mismatch/],
        ['empty payload', manifest => { manifest.files[0].bytes = 0; }, /Invalid Android tool provenance/],
        ['writable mode', manifest => { manifest.files[0].mode = '0644'; }, /Invalid Android tool provenance/],
        ['unreviewed origin', manifest => { manifest.files[0].origin.kind = 'generated'; }, /Invalid Android tool provenance/],
        ['wrong source path', manifest => { manifest.files[0].origin.path = manifest.files[0].path; }, /Invalid Android tool provenance/],
        ['missing origin', manifest => { delete manifest.files[0].origin; }, /Invalid Android tool provenance/],
        ['missing CLI bridge', manifest => { manifest.files = manifest.files.filter(file => file.path !== 'app/src/android-cli.js'); }, /Missing portable Android CLI bridge/],
    ]) {
        await t.test(name, () => {
            const manifest = structuredClone(valid);
            mutate(manifest);
            assert.throws(() => verifyAndroidTools(manifest), expected);
        });
    }
});

test('portable Android verification preserves compatibility with releases without Android metadata', () => {
    assert.doesNotThrow(() => verifyAndroidTools({ files: [] }));
    assert.doesNotThrow(() => verifyAndroidTools({ tools: {}, files: [] }));
    assert.doesNotThrow(() => verifyAndroidTools({ tools: { other: { schemaVersion: 1 } }, files: [] }));
});

test('SPDX archive checksums decode locked SRI rather than substituting a package.json digest', () => {
    for (const [algorithm, bytes] of [['sha1', 20], ['sha256', 32], ['sha512', 64]]) {
        const digest = Buffer.alloc(bytes, 0xab);
        assert.deepEqual(archiveChecksums(`${algorithm}-${digest.toString('base64')}`),
            [{ algorithm: algorithm.toUpperCase(), checksumValue: digest.toString('hex') }]);
    }
    assert.equal(archiveChecksums(undefined), undefined, 'Unarchived components do not invent a package checksum');
    for (const integrity of ['', 'a'.repeat(64), 'md5-YWJj', 'sha256-YWJj', 'sha512-a'.repeat(32),
        `sha1-${Buffer.alloc(20).toString('base64').replace(/=$/, '')}`, null]) {
        assert.throws(() => archiveChecksums(integrity));
    }
});

test('release archive bytes do not depend on staging names, long-path PAX headers or timestamps',
    { skip: process.platform !== 'linux' ? 'GNU tar packaging belongs to the Linux target; Windows ZIP reproducibility is tested separately.' : false }, async t => {
    const root = await fs.mkdtemp(fileURLToPath(new URL('../build/archive-test-', import.meta.url)));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const outputs = [];
    for (const [index, name] of ['candidate-a', 'different parent \u4e2d\u6587'].entries()) {
        const directory = path.join(root, name);
        const long = path.join(directory, 'long-directory-'.repeat(10));
        await fs.mkdir(long, { recursive: true });
        await fs.writeFile(path.join(long, 'file.txt'), 'Deterministic archive test payload.\n', { mode: 0o444 });
        await fs.utimes(long, 1000 + index, 2000 + index);
        const archive = path.join(root, `${index}.tar.gz`);
        await archiveRelease(directory, archive, 'cocos4-fixture-linux-x64');
        outputs.push(await fs.readFile(archive));
        await assert.rejects(archiveRelease(directory, archive, 'cocos4-fixture-linux-x64'), /OUTPUT_CONFLICT/);
        assert.deepEqual(await fs.readFile(archive), outputs[index], 'An existing archive must not be replaced');
    }
    const [first, second] = outputs.map(bytes => gunzipSync(bytes));
    const pax = bytes => {
        const entries = [];
        for (let offset = 0; offset + 512 <= bytes.length && bytes[offset];) {
            const size = parseInt(bytes.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, '').trim(), 8);
            if (bytes[offset + 156] === 120) entries.push(bytes.subarray(offset, offset + 100).toString().replace(/\0.*$/, ''));
            offset += 512 + Math.ceil(size / 512) * 512;
        }
        return entries;
    };
    assert(pax(first).length, 'Fixture must exercise POSIX extended headers');
    assert.deepEqual(pax(first), pax(second), 'PAX header names must not retain the original parent path');
    assert(first.equals(second), 'Uncompressed tar must be reproducible');
    assert(outputs[0].equals(outputs[1]), 'Gzip archive must be reproducible');
});
