import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { deflateRawSync } from 'node:zlib';
import { archiveWindows, verifyWindowsArchive, extractWindowsArchive, readZipMembers, readPinnedNodeArchive,
    WINDOWS_ARCHIVE_LIMITS as limits } from '../scripts/windows-archive.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function symlink(target, filename) {
    const directory = (await fs.lstat(target).catch(() => undefined))?.isDirectory();
    await fs.symlink(target, filename, process.platform === 'win32' && directory ? 'junction' : directory ? 'dir' : 'file');
}

async function fixture(t, files = {}) {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'cocos4-winzip-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const archive = path.join(root, 'out.zip');
    await fs.mkdir(source);
    for (const [name, bytes] of Object.entries(files)) {
        const filename = path.join(source, name);
        await fs.mkdir(bytes === null ? filename : path.dirname(filename), { recursive: true });
        if (bytes !== null) await fs.writeFile(filename, bytes);
    }
    return { root, source, archive };
}

async function absent(filename) {
    await assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
}

// Test-side ZIP layout inspection does not call the production parser.
function layout(bytes) {
    const end = bytes.length - 22;
    let central = bytes.readUInt32LE(end + 16);
    const directory = central;
    const entries = [];
    for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
        const local = bytes.readUInt32LE(central + 42);
        const nameLength = bytes.readUInt16LE(central + 28);
        const name = bytes.subarray(central + 46, central + 46 + nameLength).toString('utf8');
        const size = bytes.readUInt32LE(central + 24);
        entries.push({ central, local, name, nameLength, size, data: local + 30 + nameLength });
        central += 46 + nameLength;
    }
    return { end, directory, entries };
}

function rename(bytes, entry, name) {
    assert.equal(Buffer.byteLength(name), entry.nameLength);
    bytes.write(name, entry.central + 46);
    bytes.write(name, entry.local + 30);
}

test('STORE ZIP roundtrip: Unicode/spaces, explicit empty directories, bytes, CRC and inventory', async t => {
    const files = { 'space here.txt': '123456789', '\u6d4b\u8bd5/\u96ea \u2603.txt': 'unicode payload',
        'binary.dat': Buffer.from([0, 255, 1, 128]), 'empty.dat': '', 'empty directory': null };
    const { root, source, archive } = await fixture(t, files);
    assert.equal(path.dirname(root), tmpdir());
    const inventory = await archiveWindows(source, archive, 'root');
    assert.deepEqual(await verifyWindowsArchive(archive, 'root', inventory), inventory);
    assert.deepEqual(inventory.map(item => item.name), [...inventory.map(item => item.name)]
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.equal(inventory[0].name, 'root/');
    assert.equal(inventory.find(item => item.name === 'root/space here.txt').crc32, 0xcbf43926);
    const zip = await fs.readFile(archive);
    for (const entry of layout(zip).entries) {
        assert.equal(zip.readUInt32LE(entry.local), 0x04034b50);
        assert.equal(zip.readUInt16LE(entry.local + 6), 0x800);
        assert.equal(zip.readUInt16LE(entry.local + 8), 0);
        assert.equal(zip.readUInt16LE(entry.local + 10), 0);
        assert.equal(zip.readUInt16LE(entry.local + 12), 33);
        assert.equal(zip.readUInt16LE(entry.local + 28), 0);
        assert(!entry.name.includes('\\'));
        const data = zip.subarray(entry.data, entry.data + entry.size);
        assert.deepEqual(data, entry.name.endsWith('/') ? Buffer.alloc(0) : Buffer.from(files[entry.name.slice(5)]));
        assert.equal(inventory.find(item => item.name === entry.name).sha256, hash(data));
    }
    assert(inventory.some(item => item.name === 'root/empty directory/' && item.type === 'directory'));
});

test('byte determinism ignores source basename, enumeration order, modes and mtimes', async t => {
    const a = await fixture(t, { 'z.txt': 'last', 'a/b.txt': 'first', 'empty': null });
    const b = await fixture(t, { 'empty': null, 'a/b.txt': 'first', 'z.txt': 'last' });
    const renamed = path.join(b.root, 'different basename');
    await fs.rename(b.source, renamed);
    for (const name of ['', 'a', 'a/b.txt', 'empty', 'z.txt']) {
        await fs.utimes(path.join(renamed, name), new Date(1_000_000), new Date(2_000_000));
        await fs.chmod(path.join(renamed, name), name.endsWith('.txt') ? 0o600 : 0o700);
    }
    await archiveWindows(a.source, a.archive, 'fixed-root');
    await archiveWindows(renamed, b.archive, 'fixed-root');
    assert.deepEqual(await fs.readFile(a.archive), await fs.readFile(b.archive));
    await verifyWindowsArchive(b.archive, 'fixed-root');
});

test('an empty source still has one canonical root directory', async t => {
    const { source, archive } = await fixture(t);
    const inventory = await archiveWindows(source, archive, 'root');
    assert.deepEqual(inventory, [{ name: 'root/', type: 'directory', size: 0, crc32: 0, sha256: hash('') }]);
    await verifyWindowsArchive(archive, 'root', inventory);
});

test('existing files, directories, symlinks and hardlinks are retained', async t => {
    const { root, source, archive } = await fixture(t, { payload: 'source' });
    await archiveWindows(source, archive, 'root');
    const original = await fs.readFile(archive);
    await assert.rejects(archiveWindows(source, archive, 'root'), /exists/);
    assert.deepEqual(await fs.readFile(archive), original);
    const target = path.join(root, 'target');
    await fs.writeFile(target, 'retain target');
    for (const kind of ['directory', 'symlink', 'dangling', 'hardlink']) {
        const output = path.join(root, kind);
        if (kind === 'directory') await fs.mkdir(output);
        else if (kind === 'hardlink') await fs.link(target, output);
        else await symlink(kind === 'dangling' ? path.join(root, 'missing') : target, output);
        const before = await fs.lstat(output, { bigint: true });
        await assert.rejects(archiveWindows(source, output, 'root'), /exists/);
        const after = await fs.lstat(output, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.mode, before.mode);
    }
    assert.equal(await fs.readFile(target, 'utf8'), 'retain target');
});

test('concurrent exclusive writers have exactly one winner', async t => {
    const { source, archive } = await fixture(t, { payload: 'data' });
    const results = await Promise.allSettled([archiveWindows(source, archive, 'root'), archiveWindows(source, archive, 'root')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    await verifyWindowsArchive(archive, 'root', results.find(result => result.status === 'fulfilled').value);
});

test('failure cleanup retains an output replaced after exclusive creation', async t => {
    const { root, source, archive } = await fixture(t, { payload: 'data' });
    const open = fs.open;
    t.mock.method(fs, 'open', async (filename, ...args) => {
        if (filename === path.join(source, 'payload')) {
            await fs.rename(archive, path.join(root, 'moved.zip'));
            await fs.writeFile(archive, 'retain replacement');
            throw new Error('Injected source open failure');
        }
        return open(filename, ...args);
    });
    await assert.rejects(archiveWindows(source, archive, 'root'), /Injected/);
    assert.equal(await fs.readFile(archive, 'utf8'), 'retain replacement');
});

test('output cannot be inside the source, including via a parent alias', async t => {
    const { root, source } = await fixture(t, { nested: null });
    await symlink(source, path.join(root, 'alias'));
    for (const archive of [source, path.join(source, 'out.zip'), path.join(root, 'alias/nested/out.zip')]) {
        await assert.rejects(archiveWindows(source, archive, 'root'), /outside the source/);
    }
    await absent(path.join(source, 'out.zip'));
    await absent(path.join(source, 'nested/out.zip'));
});

test('archive roots reject absolute paths, traversal, DOS/ADS names and malformed Unicode', async t => {
    const { source, archive } = await fixture(t);
    for (const root of ['', '.', '..', '../escape', '/absolute', 'x/y', 'x\\y', 'C:pkg', 'NUL', 'COM1.log',
        'LPT\u00b9.log', 'name.', 'name ', 'bad\nname', '\ud800', 'x'.repeat(256)]) {
        await assert.rejects(archiveWindows(source, archive, root), undefined, JSON.stringify(root));
        await absent(archive);
    }
});

test('source names reject Windows reserved/forbidden names and invalid UTF-8 bytes', async t => {
    const { source, archive } = await fixture(t);
    const readdir = fs.readdir;
    let entry;
    t.mock.method(fs, 'readdir', (filename, options) => filename === source ? Promise.resolve([entry]) : readdir(filename, options));
    for (const name of ['CON', 'con.txt', 'CON .txt', 'prn', 'AUX', 'NUL.log', 'com9', 'lpt1.a',
        'COM\u00b2.log', 'LPT\u00b3', 'CLOCK$', 'CONIN$', 'CONOUT$', 'ads:stream', 'trailing.', 'trailing ',
        'back\\slash', 'new\nline', 'bad\x01name', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
        entry = Buffer.from(name);
        await assert.rejects(archiveWindows(source, archive, 'root'), /Windows/);
        await absent(archive);
    }
    entry = Buffer.from([0xff]);
    await assert.rejects(archiveWindows(source, archive, 'root'), /encoded data|UTF-8/i);
    await absent(archive);
});

test('case and normalization collisions cover files AND directories', async t => {
    // NTFS already merges case-only names; the verifier mutation cases below
    // still exercise every collision on all hosts. NFC collisions exist on NTFS.
    const cases = process.platform === 'win32' ? [] : [{ Readme: '', README: '' }, { Data: '', 'data/a': '' },
        { 'Dir/a': '', 'dir/b': '' }, { Empty: null, empty: null }];
    for (const files of [...cases, { '\u00e9.txt': '', 'e\u0301.txt': '' }]) {
        const { source, archive } = await fixture(t, files);
        await assert.rejects(archiveWindows(source, archive, 'root'), /collision/);
        await absent(archive);
    }
});

test('source root, nested symlinks, hardlinks and special files are rejected', async t => {
    const { root, source, archive } = await fixture(t, { 'nested/good': 'safe' });
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, 'outside');
    await symlink(source, path.join(root, 'source-link'));
    for (const input of [outside, path.join(root, 'source-link')]) {
        await assert.rejects(archiveWindows(input, archive, 'root'), /Source root/);
    }
    const bad = path.join(source, 'nested/bad');
    for (const target of [outside, source, path.join(source, 'nested/good'), path.join(root, 'missing')]) {
        await symlink(target, bad);
        await assert.rejects(archiveWindows(source, archive, 'root'), /regular file|reparse point/);
        await fs.unlink(bad);
    }
    for (const target of [outside, path.join(source, 'nested/good')]) {
        await fs.link(target, bad);
        await assert.rejects(archiveWindows(source, archive, 'root'), /hardlinks/);
        await fs.unlink(bad);
    }
    if (process.platform !== 'win32') {
        const server = createServer();
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(bad, resolve); });
        try {
            await assert.rejects(archiveWindows(source, archive, 'root'), /special files/);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    }
    await absent(archive);
});

test('per-file and total source budgets reject sparse files before reading/opening output', async t => {
    for (const sizes of [[limits.fileBytes + 1], Array(Math.floor(limits.totalBytes / limits.fileBytes) + 1).fill(limits.fileBytes)]) {
        const { source, archive } = await fixture(t);
        for (let i = 0; i < sizes.length; i++) {
            const handle = await fs.open(path.join(source, `sparse-${i}`), 'wx');
            try { await handle.truncate(sizes[i]); } finally { await handle.close(); }
        }
        const original = fs.open;
        const mock = t.mock.method(fs, 'open', async () => { throw new Error('Must reject at preflight, before open'); });
        try {
            await assert.rejects(archiveWindows(source, archive, 'root'), /size budget/);
            assert.equal(mock.mock.callCount(), 0);
        } finally { fs.open = original; }
        await absent(archive);
    }
});

test('path byte/depth budgets reject otherwise legal source components', async t => {
    for (const name of [Array(5).fill('x'.repeat(250)).join('/'), Array(limits.depth).fill('a').join('/')]) {
        const { source, archive } = await fixture(t, { [name]: null });
        await assert.rejects(archiveWindows(source, archive, 'root'), /name\/depth budget/);
        await absent(archive);
    }
});

test('entry count and cumulative name budgets bound actual source walks', async t => {
    for (const budget of ['entries', 'total names']) {
        await t.test(budget, async t => {
            const { source, archive } = await fixture(t);
            const prefix = budget === 'entries' ? '' : Array(3).fill('x'.repeat(240)).join('/');
            const parent = path.join(source, prefix);
            await fs.mkdir(parent, { recursive: true });
            const nameLength = Buffer.byteLength(`root/${prefix}/entry-00000/`);
            const count = budget === 'entries' ? limits.entries : Math.ceil(limits.totalNameBytes / nameLength) + 1;
            for (let start = 0; start < count; start += 64) {
                await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, index) =>
                    fs.mkdir(path.join(parent, `entry-${String(start + index).padStart(5, '0')}`))));
            }
            await assert.rejects(archiveWindows(source, archive, 'root'), budget === 'entries' ? /entry budget/ : /total name budget/);
            await absent(archive);
        });
    }
});

test('bounded handle reads tolerate short reads and independently verify the result', async t => {
    const { source, archive } = await fixture(t, { payload: Buffer.alloc(140000, 42) });
    const open = fs.open;
    let reads = 0;
    t.mock.method(fs, 'open', async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (filename === path.join(source, 'payload')) {
            const read = handle.read.bind(handle);
            handle.read = async (buffer, offset, length, position) => {
                assert(length <= 64 * 1024);
                reads++;
                return read(buffer, offset, Math.min(length, 997), position);
            };
        }
        return handle;
    });
    const inventory = await archiveWindows(source, archive, 'root');
    assert(reads > 100);
    await verifyWindowsArchive(archive, 'root', inventory);
});

test('validator streams payloads in bounded short reads and detects archive mutation', async t => {
    const { source, archive } = await fixture(t, { payload: Buffer.alloc(300000, 42) });
    const inventory = await archiveWindows(source, archive, 'root');
    const open = fs.open;
    let reads = 0;
    let mutate = false;
    t.mock.method(fs, 'open', async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (filename === archive) {
            const read = handle.read.bind(handle);
            handle.read = async (buffer, offset, length, position) => {
                assert(length <= 64 * 1024);
                reads++;
                if (mutate) { mutate = false; await fs.utimes(archive, 1, 1); }
                return read(buffer, offset, Math.min(length, 997), position);
            };
        }
        return handle;
    });
    await verifyWindowsArchive(archive, 'root', inventory);
    assert(reads > 300);
    mutate = true;
    await assert.rejects(verifyWindowsArchive(archive, 'root'), /changed/);
});

test('verified extraction preserves contents and requires an absent root', async t => {
    const { root, source, archive } = await fixture(t, { 'nested/space file': Buffer.alloc(140000, 42), empty: null });
    const inventory = await archiveWindows(source, archive, 'root');
    const destination = path.join(root, 'extracted');
    assert.deepEqual(await extractWindowsArchive(archive, 'root', destination, inventory), inventory);
    assert.deepEqual(await fs.readFile(path.join(destination, 'nested/space file')), Buffer.alloc(140000, 42));
    assert((await fs.stat(path.join(destination, 'empty'))).isDirectory());
    await assert.rejects(extractWindowsArchive(archive, 'root', destination), { code: 'EEXIST' });
    const tampered = await fs.readFile(archive);
    tampered[layout(tampered).entries.find(entry => entry.size > 0).data] ^= 1;
    await fs.writeFile(archive, tampered);
    const rejected = path.join(root, 'rejected');
    await assert.rejects(extractWindowsArchive(archive, 'root', rejected), /CRC/);
    await absent(rejected);
});

test('extraction rejects a directory replaced between output writes', async t => {
    const { root, source, archive } = await fixture(t, { 'nested/aa': 'one', 'nested/bb': 'two' });
    await archiveWindows(source, archive, 'root');
    const destination = path.join(root, 'extracted');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const open = fs.open;
    t.mock.method(fs, 'open', async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (filename === path.join(destination, 'nested/aa')) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
                await close();
                await fs.rename(path.join(destination, 'nested'), path.join(root, 'moved'));
                await symlink(outside, path.join(destination, 'nested'));
            };
        }
        return handle;
    });
    await assert.rejects(extractWindowsArchive(archive, 'root', destination), /directory changed/);
    await absent(path.join(outside, 'bb'));
});

test('stable reads reject growth, truncation, same-size writes, replacement and new hardlinks', async t => {
    for (const change of ['grow', 'shrink', 'rewrite', 'replace', 'hardlink']) {
        await t.test(change, async t => {
            const { root, source, archive } = await fixture(t, { payload: '123456789' });
            const filename = path.join(source, 'payload');
            const open = fs.open;
            t.mock.method(fs, 'open', async (name, ...args) => {
                const handle = await open(name, ...args);
                if (name === filename) {
                    const read = handle.read.bind(handle);
                    let changed = false;
                    handle.read = async (...readArgs) => {
                        if (!changed) {
                            changed = true;
                            if (change === 'grow') await fs.appendFile(filename, 'x');
                            if (change === 'shrink') await fs.truncate(filename, 1);
                            if (change === 'rewrite') {
                                await fs.writeFile(filename, '987654321');
                                await fs.utimes(filename, 1, 1);
                            }
                            if (change === 'replace') {
                                await fs.rename(filename, path.join(root, 'old'));
                                await fs.writeFile(filename, '123456789');
                            }
                            if (change === 'hardlink') await fs.link(filename, path.join(root, 'link'));
                        }
                        return read(...readArgs);
                    };
                }
                return handle;
            });
            await assert.rejects(archiveWindows(source, archive, 'root'), /grew|shortened|changed/);
            await absent(archive);
        });
    }
});

test('in-tree ancestors are rechecked before file opens', async t => {
    const { root, source, archive } = await fixture(t, { 'a/b/payload': 'safe' });
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'payload'), 'outside');
    const open = fs.open;
    t.mock.method(fs, 'open', async (filename, ...args) => {
        assert.notEqual(filename, path.join(source, 'a/b/payload'), 'Must detect the changed ancestor before file open');
        const handle = await open(filename, ...args);
        if (filename === archive) {
            await fs.rename(path.join(source, 'a/b'), path.join(root, 'moved'));
            await symlink(outside, path.join(source, 'a/b'));
        }
        return handle;
    });
    await assert.rejects(archiveWindows(source, archive, 'root'), /changed/);
    await absent(archive);
    assert.equal(await fs.readFile(path.join(outside, 'payload'), 'utf8'), 'outside');
});

test('validator rejects tampered headers, payloads, names, offsets, budgets and ZIP64', async t => {
    const { root, source, archive } = await fixture(t, { 'aa.txt': '123456789', 'bb.txt': 'two' });
    await archiveWindows(source, archive, 'root');
    const original = await fs.readFile(archive);
    const { end, entries } = layout(original);
    const a = entries[1];
    const b = entries[2];
    const both16 = (bytes, offset, value) => {
        bytes.writeUInt16LE(value, a.local + offset);
        bytes.writeUInt16LE(value, a.central + offset + 2);
    };
    const both32 = (bytes, offset, value) => {
        bytes.writeUInt32LE(value, a.local + offset);
        bytes.writeUInt32LE(value, a.central + offset + 2);
    };
    const mutations = {
        payload: bytes => { bytes[a.data] ^= 1; },
        crc: bytes => both32(bytes, 14, 0),
        'local-only CRC': bytes => bytes.writeUInt32LE(0, a.local + 14),
        'central-only size': bytes => bytes.writeUInt32LE(8, a.central + 24),
        'store size': bytes => both32(bytes, 18, 8),
        'per-file budget': bytes => { both32(bytes, 18, limits.fileBytes + 1); both32(bytes, 22, limits.fileBytes + 1); },
        ZIP64: bytes => { both32(bytes, 18, 0xffffffff); both32(bytes, 22, 0xffffffff); },
        'ZIP64 version': bytes => both16(bytes, 4, 45),
        encryption: bytes => both16(bytes, 6, 0x801),
        descriptor: bytes => both16(bytes, 6, 0x808),
        'non-UTF8 flag': bytes => both16(bytes, 6, 0),
        deflate: bytes => both16(bytes, 8, 8),
        time: bytes => both16(bytes, 10, 1),
        date: bytes => both16(bytes, 12, 0),
        extras: bytes => both16(bytes, 28, 1),
        'name budget': bytes => both16(bytes, 26, 65535),
        'local signature': bytes => bytes.writeUInt32LE(0, a.local),
        'central signature': bytes => bytes.writeUInt32LE(0, a.central),
        'local name mismatch': bytes => { bytes[a.local + 30] = 120; },
        'local offset overlap': bytes => bytes.writeUInt32LE(0, a.central + 42),
        'Unix creator': bytes => bytes.writeUInt16LE(0x314, a.central + 4),
        'symlink attributes': bytes => bytes.writeUInt32LE(0xa1ff0000, a.central + 38),
        comment: bytes => bytes.writeUInt16LE(1, a.central + 32),
        disk: bytes => bytes.writeUInt16LE(1, a.central + 34),
        'internal attributes': bytes => bytes.writeUInt16LE(1, a.central + 36),
        duplicate: bytes => rename(bytes, b, 'root/aa.txt'),
        'case collision': bytes => rename(bytes, b, 'root/AA.txt'),
        traversal: bytes => rename(bytes, a, 'root/../bad'),
        absolute: bytes => rename(bytes, a, '/oot/aa.txt'),
        backslash: bytes => rename(bytes, a, 'root\\aa.txt'),
        ADS: bytes => rename(bytes, a, 'root/a:.txt'),
        reserved: bytes => rename(bytes, a, 'root/CON.tx'),
        'trailing dot': bytes => rename(bytes, a, 'root/aa.tx.'),
        unsorted: bytes => rename(bytes, a, 'root/cc.txt'),
        'wrong root': bytes => rename(bytes, a, 'roox/aa.txt'),
        'invalid UTF8': bytes => { bytes[a.central + 46] = 255; bytes[a.local + 30] = 255; },
        'end count mismatch': bytes => bytes.writeUInt16LE(1, end + 8),
        'entry budget': bytes => { bytes.writeUInt16LE(limits.entries + 1, end + 8); bytes.writeUInt16LE(limits.entries + 1, end + 10); },
        'ZIP64 count': bytes => { bytes.writeUInt16LE(65535, end + 8); bytes.writeUInt16LE(65535, end + 10); },
        'central directory bounds': bytes => bytes.writeUInt32LE(0xffffffff, end + 16),
        'end disk': bytes => bytes.writeUInt16LE(1, end + 4),
        'end comment': bytes => bytes.writeUInt16LE(1, end + 20),
    };
    const tampered = path.join(root, 'tampered.zip');
    for (const [name, mutate] of Object.entries(mutations)) {
        const bytes = Buffer.from(original);
        mutate(bytes);
        await fs.writeFile(tampered, bytes);
        await assert.rejects(verifyWindowsArchive(tampered, 'root'), undefined, name);
    }
    for (const bytes of [Buffer.alloc(0), original.subarray(0, 21), original.subarray(0, -1),
        Buffer.concat([original, Buffer.from([0])])]) {
        await fs.writeFile(tampered, bytes);
        await assert.rejects(verifyWindowsArchive(tampered, 'root'));
    }
    // Insert an unindexed byte while repairing EOCD bounds: contiguous inventory must still fail.
    const { directory } = layout(original);
    const gap = Buffer.concat([original.subarray(0, directory), Buffer.from([0]), original.subarray(directory)]);
    gap.writeUInt32LE(directory + 1, gap.length - 6);
    await fs.writeFile(tampered, gap);
    await assert.rejects(verifyWindowsArchive(tampered, 'root'), /Uninventoried/);
});

test('validator enforces explicit ancestors and directory/file collisions', async t => {
    const { root, source, archive } = await fixture(t, { 'aa/cc': 'x', zz: 'x' });
    await archiveWindows(source, archive, 'root');
    const original = await fs.readFile(archive);
    const { entries } = layout(original);
    const tampered = path.join(root, 'tampered.zip');
    for (const [oldName, newName, error] of [['root/aa/cc', 'root/qq/cc', /ancestor/],
        ['root/zz', 'root/aa', /collision/], ['root/zz', 'root/AA', /collision/]]) {
        const bytes = Buffer.from(original);
        rename(bytes, entries.find(entry => entry.name === oldName), newName);
        await fs.writeFile(tampered, bytes);
        await assert.rejects(verifyWindowsArchive(tampered, 'root'), error);
    }
});

test('validator requires exact optional inventory and bounds its own input file', async t => {
    const { root, source, archive } = await fixture(t, { payload: 'data' });
    const inventory = await archiveWindows(source, archive, 'root');
    for (const expected of [[], inventory.slice(1), [...inventory].reverse(), [...inventory, inventory[0]],
        inventory.map(item => ({ ...item, sha256: '0'.repeat(64) }))]) {
        await assert.rejects(verifyWindowsArchive(archive, 'root', expected), /inventory mismatch/);
    }
    await assert.rejects(verifyWindowsArchive(archive, 'other'), /root mismatch/);
    const link = path.join(root, 'link.zip');
    await symlink(archive, link);
    await assert.rejects(verifyWindowsArchive(link, 'root'), /regular file/);
    await fs.unlink(link);
    await fs.link(archive, link);
    await assert.rejects(verifyWindowsArchive(archive, 'root'), /hardlinks/);
    await fs.unlink(link);
    const handle = await fs.open(path.join(root, 'huge.zip'), 'wx');
    try { await handle.truncate(limits.archiveBytes + 1); } finally { await handle.close(); }
    await assert.rejects(verifyWindowsArchive(path.join(root, 'huge.zip'), 'root'), /size budget/);
});

test('Windows Node pin records the separately reviewed official HTTPS checksum, not release qualification', async () => {
    const pin = JSON.parse(await fs.readFile(new URL('../packaging/node-win32-lock.json', import.meta.url), 'utf8'));
    assert.equal(pin.schemaVersion, 1);
    assert.equal(pin.version, '24.21.0');
    assert.equal(pin.target, 'win-x64');
    assert.equal(pin.url, 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip');
    assert.equal(pin.checksumsUrl, 'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt');
    assert.equal(pin.sha256, '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541');
    assert.equal(pin.archiveRoot, 'node-v24.21.0-win-x64');
    assert.deepEqual(pin.files, ['node.exe', 'LICENSE', 'README.md']);
    assert.match(pin.authentication, /HTTPS/);
    assert.match(pin.authentication, /no detached-signature verification was performed/);
    assert.match(pin.scope, /Component qualification.*not an operational Windows release/);
});
