import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { exportAndroid, verifyAndroidProject } from '../android/export-apk.mjs';
import { buildDirect } from '../android/direct-build.mjs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { normalizeZipEntryNames, readZipEntryNames } from '../android/zip-name-normalizer.mjs';

const root = process.env.COCOS4_ANDROID_TEST_WORK_ROOT ? path.resolve(process.env.COCOS4_ANDROID_TEST_WORK_ROOT) : path.resolve(fileURLToPath(new URL('../build/android-direct-tests/', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

// Minimal single-disk ZIP writer for normalizer tests: stored and deflated entries, optional
// data descriptors, real CRC-32 values, real directory offsets and a real end record.
function buildZip(entries) {
    const chunks = [];
    const records = [];
    let offset = 0;
    const push = bytes => { chunks.push(Buffer.from(bytes)); offset += bytes.length; };
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const raw = Buffer.from(entry.data);
        const method = entry.deflate ? 8 : 0;
        const compressed = entry.deflate ? deflateRawSync(raw, { level: 6 }) : raw;
        const descriptor = entry.descriptor === true;
        const checksum = crc32(raw);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(descriptor ? 0x0008 : 0, 6);
        header.writeUInt16LE(method, 8);
        header.writeUInt32LE(descriptor ? 0 : checksum, 14);
        header.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
        header.writeUInt32LE(descriptor ? 0 : raw.length, 22);
        header.writeUInt16LE(name.length, 26);
        header.writeUInt16LE(0, 28);
        const localOffset = offset;
        push(header);
        push(name);
        push(compressed);
        if (descriptor) {
            const trailer = Buffer.alloc(16);
            trailer.writeUInt32LE(0x08074b50, 0);
            trailer.writeUInt32LE(checksum, 4);
            trailer.writeUInt32LE(compressed.length, 8);
            trailer.writeUInt32LE(raw.length, 12);
            push(trailer);
        }
        records.push({ name, raw, compressed, method, descriptor, checksum, localOffset });
    }
    const directoryOffset = offset;
    for (const record of records) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(record.descriptor ? 0x0008 : 0, 8);
        header.writeUInt16LE(record.method, 10);
        header.writeUInt32LE(record.checksum, 16);
        header.writeUInt32LE(record.compressed.length, 20);
        header.writeUInt32LE(record.raw.length, 24);
        header.writeUInt16LE(record.name.length, 28);
        header.writeUInt16LE(0, 30);
        header.writeUInt16LE(0, 32);
        header.writeUInt16LE(0, 34);
        header.writeUInt16LE(0, 36);
        header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        header.writeUInt32LE(record.localOffset, 42);
        push(header);
        push(record.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(records.length, 8);
    end.writeUInt16LE(records.length, 10);
    end.writeUInt32LE(offset - directoryOffset, 12);
    end.writeUInt32LE(directoryOffset, 16);
    push(end);
    return { bytes: Buffer.concat(chunks), records, directoryOffset };
}

async function zipFixture(t, bytes) {
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'zip-'));
    t.after(async () => {
        assert.equal(path.dirname(directory), root);
        await fs.rm(directory, { recursive: true, force: true });
    });
    const filename = path.join(directory, 'fixture.apk');
    await fs.writeFile(filename, bytes);
    return filename;
}

function assertOnlyNameBytesChanged(before, after, expectedBackslashes) {
    assert.equal(after.length, before.length, 'normalization must not resize the archive');
    const changed = [];
    for (let index = 0; index < before.length; index += 1) if (before[index] !== after[index]) changed.push(index);
    assert.equal(changed.length, expectedBackslashes * 2, 'expected one local and one central rewrite per backslash name');
    for (const index of changed) {
        assert.equal(before[index], 0x5c);
        assert.equal(after[index], 0x2f);
    }
}
async function fixture(t, config = {}) {
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'case-'));
    t.after(async () => {
        assert.equal(path.dirname(directory), root);
        await fs.rm(directory, { recursive: true, force: true });
    });
    const input = path.join(directory, 'web');
    const project = path.join(directory, 'project');
    const work = path.join(directory, 'work');
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, 'index.html'), '<!doctype html><html><head></head><body>Android APK fixture</body></html>');
    await exportAndroid({ input, output: project, config: { appId: 'org.cocos4.fixture', appName: 'Cocos4 测试', ...config } });
    return { directory, project, work };
}

test('direct packaging rejects unsupported variants and missing SDK tools before creating work', async t => {
    const { directory, project, work } = await fixture(t);
    const sdk = path.join(directory, 'sdk');
    const javaHome = path.join(directory, 'jdk');
    await fs.mkdir(sdk);
    await fs.mkdir(javaHome);
    await assert.rejects(buildDirect({ project, sdk, javaHome, work, variant: 'custom' }), { code: 'CONFIG_INVALID' });
    await assert.rejects(buildDirect({ project, sdk, javaHome, work }), { code: 'TOOLCHAIN_MISSING' });
    await assert.rejects(fs.stat(work), { code: 'ENOENT' });
    await assert.rejects(buildDirect({ project, sdk, javaHome, work: path.join(project, 'build') }), { code: 'PATH_OVERLAP' });
});

test('a configurable backend is restricted to debug APKs before invoking the SDK', async t => {
    const { directory, project, work } = await fixture(t, { dynamicBackend: true, allowCleartext: true });
    const sdk = path.join(directory, 'sdk');
    const javaHome = path.join(directory, 'jdk');
    await fs.mkdir(sdk);
    await fs.mkdir(javaHome);
    await assert.rejects(buildDirect({ project, sdk, javaHome, work, variant: 'release' }), { code: 'CONFIG_INVALID' });
    await assert.rejects(fs.stat(work), { code: 'ENOENT' });
});

test('direct packaging detects changed project files before invoking Android executables', async t => {
    const { directory, project, work } = await fixture(t);
    const sdk = path.join(directory, 'sdk');
    const javaHome = path.join(directory, 'jdk');
    await fs.mkdir(sdk);
    await fs.mkdir(javaHome);
    await fs.appendFile(path.join(project, 'app/src/main/AndroidManifest.xml'), '<!-- changed -->');
    await assert.rejects(buildDirect({ project, sdk, javaHome, work }), { code: 'PROJECT_CHANGED' });
});


test('zip name normalization rewrites only name fields and preserves payload CRCs, descriptors and offsets', async t => {
    const entries = [
        { name: 'assets/www/index.html', data: Buffer.from('<html>fixture</html>'), deflate: true },
        { name: 'assets/www/js\\app.js', data: Buffer.from('console.log("fixture payload");'), deflate: true, descriptor: true },
        { name: 'assets/www/__cocos4_host\\index.html', data: Buffer.alloc(2048, 0x5a), deflate: false, descriptor: true },
    ];
    const fixture = buildZip(entries);
    const filename = await zipFixture(t, fixture.bytes);
    const before = await fs.readFile(filename);
    const result = await normalizeZipEntryNames(filename);
    const after = await fs.readFile(filename);
    assertOnlyNameBytesChanged(before, after, 2);
    assert.deepEqual(result.names, ['assets/www/index.html', 'assets/www/js/app.js', 'assets/www/__cocos4_host/index.html']);
    assert.equal(result.entries, 3);
    assert.equal(result.backslashNamesBefore, 2);
    assert.equal(result.backslashNamesRemaining, 0);
    assert.equal(result.patchedEntries, 2);
    assert.equal(result.patchedLocalNames, 2);
    assert.equal(result.patchedCentralNames, 2);
    for (const record of fixture.records) {
        const header = after.subarray(record.localOffset, record.localOffset + 30);
        assert.equal(header.readUInt32LE(0), 0x04034b50);
        const nameLength = header.readUInt16LE(26);
        const payloadAt = record.localOffset + 30 + nameLength;
        if (record.descriptor) {
            assert.equal(header.readUInt32LE(14), 0, 'descriptor entries keep the local CRC field empty');
            const trailerAt = payloadAt + record.compressed.length;
            assert.equal(after.readUInt32LE(trailerAt), 0x08074b50);
            assert.equal(after.readUInt32LE(trailerAt + 4), record.checksum);
        } else {
            assert.equal(header.readUInt32LE(14), record.checksum);
        }
        const payload = after.subarray(record.localOffset + 30 + nameLength,
            record.localOffset + 30 + nameLength + record.compressed.length);
        assert.deepEqual(record.method === 8 ? inflateRawSync(payload) : payload, record.raw);
    }
    const verified = await readZipEntryNames(filename);
    assert.equal(verified.backslashNames.length, 0);
    assert.ok(verified.names.includes('assets/www/index.html'));
    assert.ok(verified.names.includes('assets/www/js/app.js'));
});

test('zip name normalization is a verified no-op for forward-slash archives', async t => {
    const fixture = buildZip([
        { name: 'assets/www/index.html', data: Buffer.from('<html>clean</html>'), deflate: true },
        { name: 'assets/www/js/app.js', data: Buffer.from('export default 1;'), deflate: false },
    ]);
    const filename = await zipFixture(t, fixture.bytes);
    const before = await fs.readFile(filename);
    const result = await normalizeZipEntryNames(filename);
    assert.deepEqual(await fs.readFile(filename), before);
    assert.equal(result.backslashNamesBefore, 0);
    assert.equal(result.patchedEntries, 0);
    const verified = await readZipEntryNames(filename);
    assert.equal(verified.backslashNames.length, 0);
});

test('zip name normalization rejects collisions after slash normalization without writing', async t => {
    const fixture = buildZip([
        { name: 'assets/www/a\\b.js', data: Buffer.from('one'), deflate: false },
        { name: 'assets/www/a/b.js', data: Buffer.from('two'), deflate: true },
    ]);
    const filename = await zipFixture(t, fixture.bytes);
    const before = await fs.readFile(filename);
    await assert.rejects(normalizeZipEntryNames(filename), { code: 'ZIP_NAME_COLLISION' });
    assert.deepEqual(await fs.readFile(filename), before);
});

test('zip name normalization rejects malformed and mismatched archives without writing', async t => {
    const garbage = await zipFixture(t, Buffer.from('not a zip archive at all'));
    await assert.rejects(normalizeZipEntryNames(garbage), { code: 'ZIP_MALFORMED' });
    assert.deepEqual(await fs.readFile(garbage), Buffer.from('not a zip archive at all'));

    const fixture = buildZip([
        { name: 'assets/www/index.html', data: Buffer.from('<html>mismatch</html>'), deflate: true },
    ]);
    const truncated = await zipFixture(t, fixture.bytes.subarray(0, fixture.bytes.length - 7));
    await assert.rejects(normalizeZipEntryNames(truncated), { code: 'ZIP_MALFORMED' });

    const mismatched = buildZip([
        { name: 'assets/www/index.html', data: Buffer.from('<html>mismatch</html>'), deflate: false },
    ]);
    const localNameAt = mismatched.records[0].localOffset + 30;
    mismatched.bytes[localNameAt] = 0x78;
    const filename = await zipFixture(t, mismatched.bytes);
    const before = await fs.readFile(filename);
    await assert.rejects(normalizeZipEntryNames(filename), { code: 'ZIP_MALFORMED' });
    assert.deepEqual(await fs.readFile(filename), before);
});

test('zip name verify-only reports remaining backslash names for pre-fix archives', async t => {
    const fixture = buildZip([
        { name: 'assets/www\\index.html', data: Buffer.from('<html>legacy</html>'), deflate: true },
    ]);
    const filename = await zipFixture(t, fixture.bytes);
    const before = await fs.readFile(filename);
    const report = await readZipEntryNames(filename);
    assert.equal(report.entries, 1);
    assert.deepEqual(report.backslashNames, ['assets/www\\index.html']);
    assert.deepEqual(await fs.readFile(filename), before, 'verify-only must not write');
});

const sdk = process.env.COCOS4_ANDROID_TEST_SDK;
const javaHome = process.env.COCOS4_ANDROID_TEST_JAVA_HOME;
test('installed Android tools produce signed update-compatible debug APKs and an unsigned release', {
    skip: !(sdk && javaHome) && 'Set COCOS4_ANDROID_TEST_SDK and COCOS4_ANDROID_TEST_JAVA_HOME to build real APKs.',
}, async t => {
    const { project, work } = await fixture(t);
    const options = { project, sdk, javaHome, work,
        platform: Number(process.env.COCOS4_ANDROID_TEST_PLATFORM ?? 36), buildTools: process.env.COCOS4_ANDROID_TEST_BUILD_TOOLS ?? '36.0.0' };
    const debug = await buildDirect(options);
    assert.equal(debug.success, true, JSON.stringify(debug));
    assert.equal(debug.signed, true);
    assert.equal(debug.deviceTested, false);
    assert.ok(debug.steps.some(step => step.name === 'Verify APK signature' && step.success));
    assert.ok(debug.steps.some(step => step.name === 'Verify APK alignment' && step.success));
    assert.equal(debug.sha256, hash(await fs.readFile(debug.apk)));
    assert.ok(debug.steps.some(step => step.name === 'Normalize ZIP entry names' && step.success));
    for (const key of ['entries', 'backslashNamesBefore', 'patchedEntries', 'patchedLocalNames', 'patchedCentralNames']) {
        assert.equal(typeof debug.zipNames[key], 'number', key);
    }
    assert.ok(debug.zipNames.entries > 0);
    assert.equal(debug.zipNames.patchedLocalNames, debug.zipNames.patchedEntries);
    assert.equal(debug.zipNames.patchedCentralNames, debug.zipNames.patchedEntries);
    const debugZip = await readZipEntryNames(debug.apk);
    assert.equal(debugZip.backslashNames.length, 0, JSON.stringify(debugZip.backslashNames.slice(0, 5)));
    assert.ok(debugZip.names.includes('assets/www/index.html'), JSON.stringify(debugZip.names.slice(0, 20)));
    const wwwNames = debugZip.names.filter(name => name.startsWith('assets/www/'));
    assert.ok(wwwNames.includes('assets/www/cocos4-shell-config.js'), JSON.stringify(wwwNames));
    assert.ok(wwwNames.length >= 2, JSON.stringify(wwwNames));
    const identity = await fs.readFile(debug.keystore);
    const updated = await buildDirect(options);
    assert.equal(updated.success, true, JSON.stringify(updated));
    assert.equal(updated.keystore, debug.keystore);
    assert.deepEqual(await fs.readFile(updated.keystore), identity);
    assert.ok(!updated.steps.some(step => step.name === 'Generate testing-only debug key'));
    const release = await buildDirect({ ...options, variant: 'release' });
    assert.equal(release.success, true, JSON.stringify(release));
    assert.equal(release.signed, false);
    assert.ok(release.apk.endsWith('app-release-unsigned.apk'));
    assert.ok(!release.steps.some(step => step.name === 'Sign debug APK'));
    assert.ok(release.steps.some(step => step.name === 'Normalize ZIP entry names' && step.success));
    assert.equal((await readZipEntryNames(release.apk)).backslashNames.length, 0);
    assert.equal((await verifyAndroidProject(project)).success, true);
    const dynamic = await fixture(t, { backendUrl: 'https://backend.invalid', dynamicBackend: true,
        allowCleartext: true, configGlobal: '__TEST_CONFIG__' });
    const configurable = await buildDirect({ ...options, project: dynamic.project, work: dynamic.work });
    assert.equal(configurable.success, true, JSON.stringify(configurable));
    assert.equal(configurable.signed, true);
    assert.ok(configurable.steps.some(step => step.name === 'Compile Java shell' && step.success));
});
