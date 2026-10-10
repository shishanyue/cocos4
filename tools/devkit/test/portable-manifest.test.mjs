import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { archiveRelease } from '../scripts/prepare-release.mjs';
import { archiveChecksums } from '../scripts/verify-portable.mjs';

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
