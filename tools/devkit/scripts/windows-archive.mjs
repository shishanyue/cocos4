// Component qualification only: Linux maintainer-owned, quiescent source/output
// trees. Path-based ancestor checks are NOT a pinned general workspace reader.
// This is a canonical STORE-only ZIP subset, not an extractor, Windows ACL policy,
// general ZIP/Node-distribution reader, or operational Windows release tooling.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const WINDOWS_ARCHIVE_LIMITS = Object.freeze({
    entries: 16384, // Includes the explicit root and all directories; no ZIP64.
    fileBytes: 128 * 1024 ** 2,
    totalBytes: 512 * 1024 ** 2,
    archiveBytes: 544 * 1024 ** 2,
    nameBytes: 1024,
    totalNameBytes: 4 * 1024 ** 2,
    componentBytes: 255,
    depth: 32,
});
const limits = WINDOWS_ARCHIVE_LIMITS;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const statFields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}

function record(name, bytes) {
    return { name, type: name.endsWith('/') ? 'directory' : 'file', size: bytes.length,
        crc32: crc32(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function component(name) {
    assert(typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= limits.componentBytes,
        'Windows component name budget');
    assert.equal(utf8.decode(Buffer.from(name)), name, 'Invalid UTF-8 name');
    assert(!/[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) && !/[. ]$/u.test(name), 'Unsafe Windows name');
    const stem = name.split('.')[0].replace(/[. ]+$/u, '').toUpperCase();
    assert(!/^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/u.test(stem),
        'Reserved Windows name');
}

function inventoryCheck(root) {
    component(root); // Exactly one component, independent of the source basename.
    const names = new Set();
    const directories = new Set();
    let totalBytes = 0;
    let totalNameBytes = 0;
    return (name, size) => {
        const directory = name.endsWith('/');
        const bare = directory ? name.slice(0, -1) : name;
        const parts = bare.split('/');
        const bytes = Buffer.from(name);
        assert(parts.length <= limits.depth && bytes.length <= limits.nameBytes, 'ZIP name/depth budget');
        for (const part of parts) component(part);
        assert(parts[0] === root && (parts.length > 1 || directory), 'ZIP archive root mismatch');
        // Conservative Unicode/case collision screening, not an NTFS equivalence claim.
        const key = bare.normalize('NFC').toUpperCase().normalize('NFC');
        assert(!names.has(key), 'ZIP name collision');
        assert(names.size < limits.entries, 'ZIP entry budget');
        if (parts.length > 1) assert(directories.has(parts.slice(0, -1).join('/')), 'Missing ZIP directory ancestor');
        assert(Number.isSafeInteger(size) && size >= 0 && size <= limits.fileBytes, 'ZIP per-file size budget');
        assert(!directory || size === 0, 'Nonempty ZIP directory');
        totalBytes += size;
        totalNameBytes += bytes.length;
        assert(totalBytes <= limits.totalBytes, 'ZIP total size budget');
        assert(totalNameBytes <= limits.totalNameBytes, 'ZIP total name budget');
        names.add(key);
        if (directory) directories.add(bare);
        return bytes;
    };
}

function unchanged(before, after) {
    assert(statFields.every(field => before[field] === after[field]), 'Source changed during archive operation');
}

function regular(stat, maximum) {
    assert(stat.isFile() && stat.nlink === 1n, 'Expected regular file without symlinks, special files or hardlinks');
    assert(stat.size >= 0n && stat.size <= BigInt(maximum), 'File size budget');
}

// Shared by the Linux component assembler; trusted paths, not ancestor pinning.
export async function readStable(filename, maximum, before = undefined) {
    before ??= await fs.lstat(filename, { bigint: true });
    regular(before, maximum);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await handle.stat({ bigint: true });
        regular(opened, maximum);
        unchanged(before, opened);
        const bytes = Buffer.alloc(Number(opened.size));
        for (let offset = 0; offset < bytes.length;) {
            const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
            assert(bytesRead > 0, 'Source shortened during read');
            offset += bytesRead;
        }
        assert.equal((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead, 0, 'Source grew during read');
        unchanged(opened, await handle.stat({ bigint: true }));
        unchanged(opened, await fs.lstat(filename, { bigint: true }));
        return bytes;
    } finally {
        await handle.close();
    }
}

/** Write an absent archive exclusively; return sorted {name,type,size,crc32,sha256} records. */
export async function archiveWindows(source, archive, archiveRoot) {
    assert.equal(process.platform, 'linux', 'ZIP source validation requires a Linux maintainer host');
    const check = inventoryCheck(archiveRoot);
    source = path.resolve(source);
    archive = path.resolve(archive);
    const rootStat = await fs.lstat(source, { bigint: true });
    assert(rootStat.isDirectory(), 'Source root must be a directory, not a symlink');
    const target = path.join(await fs.realpath(path.dirname(archive)), path.basename(archive));
    const relative = path.relative(await fs.realpath(source), target);
    assert(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        'Archive output must be outside the source tree');
    await fs.lstat(archive).then(() => { throw new Error('Archive output already exists'); }, error => {
        if (error.code !== 'ENOENT') throw error;
    });

    const entries = [];
    const directories = new Map();
    async function walk(filename, name, stat) {
        const directory = stat.isDirectory();
        if (!directory) regular(stat, limits.fileBytes);
        const nameBytes = check(name, directory ? 0 : Number(stat.size));
        entries.push({ filename, name, nameBytes, stat, directory });
        if (!directory) return;
        directories.set(filename, stat);
        const stream = await fs.opendir(filename, { encoding: 'buffer' });
        for await (const entry of stream) {
            const child = utf8.decode(entry.name);
            component(child);
            const childPath = path.join(filename, child);
            const childStat = await fs.lstat(childPath, { bigint: true });
            await walk(childPath, `${name}${child}${childStat.isDirectory() ? '/' : ''}`, childStat);
        }
        unchanged(stat, await fs.lstat(filename, { bigint: true }));
    }
    await walk(source, `${archiveRoot}/`, rootStat);
    entries.sort((a, b) => Buffer.compare(a.nameBytes, b.nameBytes));
    const totalSize = 22 + entries.reduce((sum, entry) => sum + 76 + 2 * entry.nameBytes.length
        + (entry.directory ? 0 : Number(entry.stat.size)), 0);
    assert(totalSize <= limits.archiveBytes, 'ZIP archive size budget');

    const output = await fs.open(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let created;
    const inventory = [];
    const central = [];
    let offset = 0;
    try {
        created = await output.stat({ bigint: true });
        for (const entry of entries) {
            // Recheck every in-tree ancestor before a path-based file open.
            for (let parent = entry.directory ? entry.filename : path.dirname(entry.filename);; parent = path.dirname(parent)) {
                unchanged(directories.get(parent), await fs.lstat(parent, { bigint: true }));
                if (parent === source) break;
            }
            const bytes = entry.directory ? Buffer.alloc(0) : await readStable(entry.filename, limits.fileBytes, entry.stat);
            const item = record(entry.name, bytes);
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(0x800, 6); // UTF-8, STORE, no descriptor; DOS 1980-01-01 00:00:00.
            local.writeUInt16LE(33, 12);
            local.writeUInt32LE(item.crc32, 14);
            local.writeUInt32LE(item.size, 18);
            local.writeUInt32LE(item.size, 22);
            local.writeUInt16LE(entry.nameBytes.length, 26);
            const header = Buffer.alloc(46);
            header.writeUInt32LE(0x02014b50, 0);
            header.writeUInt16LE(20, 4); // DOS host; fixed attributes, no source modes/ACLs.
            local.copy(header, 6, 4, 30);
            header.writeUInt32LE(entry.directory ? 0x10 : 0x20, 38);
            header.writeUInt32LE(offset, 42);
            central.push(header, entry.nameBytes);
            await output.writeFile(local);
            await output.writeFile(entry.nameBytes);
            await output.writeFile(bytes);
            offset += local.length + entry.nameBytes.length + bytes.length;
            inventory.push(item);
        }
        for (const entry of entries) unchanged(entry.stat, await fs.lstat(entry.filename, { bigint: true }));
        const directory = Buffer.concat(central);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(entries.length, 8);
        end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(directory.length, 12);
        end.writeUInt32LE(offset, 16);
        await output.writeFile(directory);
        await output.writeFile(end);
        assert.equal(Number((await output.stat()).size), totalSize, 'ZIP write size mismatch');
        await output.close();
        return inventory;
    } catch (error) {
        await output.close().catch(() => {});
        // Best-effort cleanup of our inode only, in the trusted maintainer output parent.
        const current = await fs.lstat(archive, { bigint: true }).catch(() => undefined);
        if (created && current?.dev === created.dev && current?.ino === created.ino) await fs.unlink(archive);
        throw error;
    }
}

/** Verify this canonical ZIP subset independently, without extraction. Optional
 * expectedInventory requires exact ordered inventory equality (including SHA-256).
 * Reads at most archiveBytes into memory, plus bounded inventory metadata.
 * Input archives must be regular, single-link files.
 */
export async function verifyWindowsArchive(archive, archiveRoot, expectedInventory = undefined) {
    assert.equal(process.platform, 'linux', 'ZIP verification requires a Linux maintainer host');
    const check = inventoryCheck(archiveRoot);
    const bytes = await readStable(archive, limits.archiveBytes);
    const end = bytes.length - 22;
    assert(end >= 0 && bytes.readUInt32LE(end) === 0x06054b50, 'Missing ZIP end record');
    assert(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
        && bytes.readUInt16LE(end + 20) === 0, 'ZIP disks/comments unsupported');
    const count = bytes.readUInt16LE(end + 10);
    assert(count > 0 && count <= limits.entries && count === bytes.readUInt16LE(end + 8), 'ZIP entry budget/count');
    const directorySize = bytes.readUInt32LE(end + 12);
    const directoryOffset = bytes.readUInt32LE(end + 16);
    assert(directoryOffset + directorySize === end, 'ZIP central directory bounds');
    let central = directoryOffset;
    let local = 0;
    let previous = Buffer.alloc(0);
    const inventory = [];
    for (let index = 0; index < count; index++) {
        assert(central + 46 <= end && bytes.readUInt32LE(central) === 0x02014b50, 'Invalid ZIP central header');
        assert(bytes.readUInt16LE(central + 4) === 20 && bytes.readUInt16LE(central + 6) === 20
            && bytes.readUInt16LE(central + 8) === 0x800 && bytes.readUInt16LE(central + 10) === 0
            && bytes.readUInt16LE(central + 12) === 0 && bytes.readUInt16LE(central + 14) === 33,
        'Noncanonical ZIP version/flags/method/time');
        assert(bytes.readUInt16LE(central + 30) === 0 && bytes.readUInt16LE(central + 32) === 0
            && bytes.readUInt16LE(central + 34) === 0 && bytes.readUInt16LE(central + 36) === 0,
        'ZIP extras/comments/disks/attributes unsupported');
        const crc = bytes.readUInt32LE(central + 16);
        const size = bytes.readUInt32LE(central + 24);
        const nameLength = bytes.readUInt16LE(central + 28);
        assert(bytes.readUInt32LE(central + 20) === size && size !== 0xffffffff, 'ZIP STORE size mismatch/ZIP64');
        assert(nameLength > 0 && nameLength <= limits.nameBytes && central + 46 + nameLength <= end, 'ZIP name budget/bounds');
        const nameBytes = bytes.subarray(central + 46, central + 46 + nameLength);
        const name = utf8.decode(nameBytes);
        check(name, size);
        assert(Buffer.compare(previous, nameBytes) < 0, 'ZIP entries not sorted/unique');
        previous = nameBytes;
        assert.equal(bytes.readUInt32LE(central + 38), name.endsWith('/') ? 0x10 : 0x20, 'Unsupported ZIP file attributes');
        assert.equal(bytes.readUInt32LE(central + 42), local, 'ZIP local offset mismatch');
        const dataOffset = local + 30 + nameLength;
        assert(dataOffset + size <= directoryOffset && bytes.readUInt32LE(local) === 0x04034b50, 'Invalid ZIP local bounds/header');
        assert(bytes.subarray(local + 4, local + 30).equals(bytes.subarray(central + 6, central + 32))
            && bytes.subarray(local + 30, dataOffset).equals(nameBytes), 'ZIP local/central header mismatch');
        const item = record(name, bytes.subarray(dataOffset, dataOffset + size));
        assert.equal(item.crc32, crc, 'ZIP CRC mismatch');
        inventory.push(item);
        local = dataOffset + size;
        central += 46 + nameLength;
    }
    assert(local === directoryOffset && central === end, 'Uninventoried ZIP bytes/entries');
    if (expectedInventory !== undefined) assert.deepEqual(inventory, expectedInventory, 'ZIP inventory mismatch');
    return inventory;
}
