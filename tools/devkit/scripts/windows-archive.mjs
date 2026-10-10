// Maintainer-owned, quiescent source/output trees on Linux and Windows.
// Path-based ancestor checks are NOT a pinned general workspace reader or ACL
// policy. The release writer/verifier uses a canonical STORE-only ZIP subset.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

export const WINDOWS_ARCHIVE_LIMITS = Object.freeze({
    entries: 60000, // Includes the explicit root and all directories; no ZIP64.
    fileBytes: 256 * 1024 ** 2,
    totalBytes: 1984 * 1024 ** 2,
    archiveBytes: 2047 * 1024 ** 2,
    nameBytes: 1024,
    totalNameBytes: 16 * 1024 ** 2,
    componentBytes: 255,
    depth: 32,
});
const limits = WINDOWS_ARCHIVE_LIMITS;
const run = promisify(execFile);
const chunkBytes = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const statFields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});

function updateCrc32(crc, bytes) {
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return crc;
}

const crc32 = bytes => (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

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

// Node's lstat reports symlinks and junctions, but not every Windows reparse tag.
// Run a fixed script with data in environment variables, never shell interpolation.
// This is a bounded check of trusted, quiescent maintainer paths, not a race-proof
// replacement for the application's handle-based filesystem authority layer.
async function noWindowsReparse(filename, recursive = false) {
    if (process.platform !== 'win32') return;
    const systemRoot = process.env.SystemRoot;
    assert(systemRoot && path.isAbsolute(systemRoot), 'Windows SystemRoot is required');
    const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
function LongPath([string]$value) {
  if ($value.StartsWith('\\?\')) { return $value }
  if ($value.StartsWith('\\')) { return '\\?\UNC\' + $value.Substring(2) }
  return '\\?\' + $value
}
$item=[IO.Path]::GetFullPath($env:COCOS4_ARCHIVE_PATH);
$parent=$item;
while ($parent) {
  if (([IO.File]::GetAttributes((LongPath $parent)) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Windows reparse point is unsupported' }
  $parent=[IO.Path]::GetDirectoryName($parent);
}
if ($env:COCOS4_ARCHIVE_RECURSE -eq '1') {
  $pending=New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push($item); $count=0;
  while ($pending.Count -gt 0) {
    $current=$pending.Pop(); $count++;
    if ($count -gt ${limits.entries}) { throw 'ZIP entry budget' }
    $attributes=[IO.File]::GetAttributes((LongPath $current));
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Windows reparse point is unsupported' }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      foreach ($child in [IO.Directory]::EnumerateFileSystemEntries((LongPath $current))) {
        if ($count + $pending.Count -ge ${limits.entries}) { throw 'ZIP entry budget' }
        $pending.Push($child)
      }
    }
  }
}`;
    await run(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: { SystemRoot: systemRoot, COCOS4_ARCHIVE_PATH: path.resolve(filename),
            COCOS4_ARCHIVE_RECURSE: recursive ? '1' : '0' }, windowsHide: true, timeout: 120000, maxBuffer: 4096 });
}

async function readExactly(handle, length, position) {
    const bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length;) {
        const { bytesRead } = await handle.read(bytes, offset, Math.min(chunkBytes, length - offset), position + offset);
        assert(bytesRead > 0, 'Source shortened during read');
        offset += bytesRead;
    }
    return bytes;
}

async function withStableFile(filename, maximum, action, before = undefined) {
    const independent = before === undefined;
    before ??= await fs.lstat(filename, { bigint: true });
    regular(before, maximum);
    if (independent) await noWindowsReparse(filename);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await handle.stat({ bigint: true });
        regular(opened, maximum);
        unchanged(before, opened);
        const result = await action(handle, Number(opened.size));
        assert.equal((await handle.read(Buffer.alloc(1), 0, 1, Number(opened.size))).bytesRead, 0, 'Source grew during read');
        unchanged(opened, await handle.stat({ bigint: true }));
        unchanged(opened, await fs.lstat(filename, { bigint: true }));
        if (independent) await noWindowsReparse(filename);
        return result;
    } finally {
        await handle.close();
    }
}

// Shared by maintainer assemblers; trusted paths, not ancestor pinning. Supplying
// before is internal tree-preflight reuse, and still checks file identity/links.
export async function readStable(filename, maximum, before = undefined) {
    return withStableFile(filename, maximum, (handle, size) => readExactly(handle, size, 0), before);
}

/** Write an absent archive exclusively; return sorted {name,type,size,crc32,sha256} records. */
export async function archiveWindows(source, archive, archiveRoot) {
    assert(['linux', 'win32'].includes(process.platform), 'ZIP source validation requires a Linux or Windows maintainer host');
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
    await noWindowsReparse(source, true);
    await noWindowsReparse(path.dirname(archive));

    const entries = [];
    const directories = new Map();
    async function walk(filename, name, stat) {
        const directory = stat.isDirectory();
        if (!directory) regular(stat, limits.fileBytes);
        const nameBytes = check(name, directory ? 0 : Number(stat.size));
        entries.push({ filename, name, nameBytes, stat, directory });
        if (!directory) return;
        directories.set(filename, stat);
        // opendir({encoding:'buffer'}) attempts to join a Buffer Dirent name to a
        // string path on supported Node releases. readdir keeps the raw bytes so
        // malformed UTF-8 cannot be replaced silently by U+FFFD on Linux.
        const children = await fs.readdir(filename, { encoding: 'buffer' });
        assert(entries.length + children.length <= limits.entries, 'ZIP entry budget');
        for (const entry of children) {
            const child = utf8.decode(entry);
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
        await noWindowsReparse(source, true);
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

async function inspectCanonicalArchive(handle, archiveSize, archiveRoot, expectedInventory) {
    const check = inventoryCheck(archiveRoot);
    const end = archiveSize - 22;
    assert(end >= 0, 'Missing ZIP end record');
    const eocd = await readExactly(handle, 22, end);
    assert(eocd.readUInt32LE(0) === 0x06054b50, 'Missing ZIP end record');
    assert(eocd.readUInt16LE(4) === 0 && eocd.readUInt16LE(6) === 0
        && eocd.readUInt16LE(20) === 0, 'ZIP disks/comments unsupported');
    const count = eocd.readUInt16LE(10);
    assert(count > 0 && count <= limits.entries && count === eocd.readUInt16LE(8), 'ZIP entry budget/count');
    const directorySize = eocd.readUInt32LE(12);
    const directoryOffset = eocd.readUInt32LE(16);
    assert(directoryOffset + directorySize === end, 'ZIP central directory bounds');
    assert(directorySize <= count * 46 + limits.totalNameBytes, 'ZIP central directory size budget');
    const directory = await readExactly(handle, directorySize, directoryOffset);
    let central = 0;
    let local = 0;
    let previous = Buffer.alloc(0);
    const inventory = [];
    const positions = [];
    const chunk = Buffer.alloc(chunkBytes);
    for (let index = 0; index < count; index++) {
        assert(central + 46 <= directory.length && directory.readUInt32LE(central) === 0x02014b50, 'Invalid ZIP central header');
        assert(directory.readUInt16LE(central + 4) === 20 && directory.readUInt16LE(central + 6) === 20
            && directory.readUInt16LE(central + 8) === 0x800 && directory.readUInt16LE(central + 10) === 0
            && directory.readUInt16LE(central + 12) === 0 && directory.readUInt16LE(central + 14) === 33,
        'Noncanonical ZIP version/flags/method/time');
        assert(directory.readUInt16LE(central + 30) === 0 && directory.readUInt16LE(central + 32) === 0
            && directory.readUInt16LE(central + 34) === 0 && directory.readUInt16LE(central + 36) === 0,
        'ZIP extras/comments/disks/attributes unsupported');
        const crc = directory.readUInt32LE(central + 16);
        const size = directory.readUInt32LE(central + 24);
        const nameLength = directory.readUInt16LE(central + 28);
        assert(directory.readUInt32LE(central + 20) === size && size !== 0xffffffff, 'ZIP STORE size mismatch/ZIP64');
        assert(nameLength > 0 && nameLength <= limits.nameBytes && central + 46 + nameLength <= directory.length, 'ZIP name budget/bounds');
        const nameBytes = directory.subarray(central + 46, central + 46 + nameLength);
        const name = utf8.decode(nameBytes);
        check(name, size);
        assert(Buffer.compare(previous, nameBytes) < 0, 'ZIP entries not sorted/unique');
        previous = nameBytes;
        assert.equal(directory.readUInt32LE(central + 38), name.endsWith('/') ? 0x10 : 0x20, 'Unsupported ZIP file attributes');
        assert.equal(directory.readUInt32LE(central + 42), local, 'ZIP local offset mismatch');
        const dataOffset = local + 30 + nameLength;
        assert(dataOffset + size <= directoryOffset, 'Invalid ZIP local bounds/header');
        const header = await readExactly(handle, 30 + nameLength, local);
        assert(header.readUInt32LE(0) === 0x04034b50, 'Invalid ZIP local bounds/header');
        assert(header.subarray(4, 30).equals(directory.subarray(central + 6, central + 32))
            && header.subarray(30).equals(nameBytes), 'ZIP local/central header mismatch');
        let checksum = 0xffffffff;
        const sha = createHash('sha256');
        for (let position = dataOffset; position < dataOffset + size;) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, dataOffset + size - position), position);
            assert(bytesRead > 0, 'Source shortened during read');
            const bytes = chunk.subarray(0, bytesRead);
            checksum = updateCrc32(checksum, bytes);
            sha.update(bytes);
            position += bytesRead;
        }
        const item = { name, type: name.endsWith('/') ? 'directory' : 'file', size,
            crc32: (checksum ^ 0xffffffff) >>> 0, sha256: sha.digest('hex') };
        assert.equal(item.crc32, crc, 'ZIP CRC mismatch');
        inventory.push(item);
        positions.push(dataOffset);
        local = dataOffset + size;
        central += 46 + nameLength;
    }
    assert(local === directoryOffset && central === directory.length, 'Uninventoried ZIP bytes/entries');
    if (expectedInventory !== undefined) assert.deepEqual(inventory, expectedInventory, 'ZIP inventory mismatch');
    return { inventory, positions };
}

/** Verify canonical ZIP bytes with bounded metadata and 64 KiB payload buffers.
 * Optional expectedInventory requires exact ordered equality, including SHA-256.
 * Input archives must be stable regular files without hardlinks or reparse points.
 */
export async function verifyWindowsArchive(archive, archiveRoot, expectedInventory = undefined) {
    assert(['linux', 'win32'].includes(process.platform), 'ZIP verification requires a Linux or Windows maintainer host');
    return withStableFile(archive, limits.archiveBytes, async (handle, size) =>
        (await inspectCanonicalArchive(handle, size, archiveRoot, expectedInventory)).inventory);
}

/** Extract a verified release into an absent directory. destination represents
 * the ZIP root itself, not its parent. Maintainer parent paths must be trusted and
 * quiescent; an incomplete extraction is retained for explicit inspection/cleanup.
 */
export async function extractWindowsArchive(archive, archiveRoot, destination, expectedInventory = undefined) {
    assert(['linux', 'win32'].includes(process.platform), 'ZIP extraction requires a Linux or Windows maintainer host');
    destination = path.resolve(destination);
    const parent = path.dirname(destination);
    await noWindowsReparse(parent);
    return withStableFile(archive, limits.archiveBytes, async (handle, size) => {
        const { inventory, positions } = await inspectCanonicalArchive(handle, size, archiveRoot, expectedInventory);
        await fs.mkdir(destination); // No recursive creation and no overwrite.
        const rootStat = await fs.lstat(destination, { bigint: true });
        const createdDirectories = new Map([[destination, rootStat]]);
        const chunk = Buffer.alloc(chunkBytes);
        for (const [index, item] of inventory.entries()) {
            const relative = item.name.slice(archiveRoot.length + 1);
            if (relative === '') continue;
            const filename = path.join(destination, ...relative.split('/'));
            for (let ancestor = path.dirname(filename);; ancestor = path.dirname(ancestor)) {
                const previous = createdDirectories.get(ancestor);
                const current = await fs.lstat(ancestor, { bigint: true });
                assert(previous && current.isDirectory() && current.dev === previous.dev && current.ino === previous.ino,
                    'Extraction directory changed');
                if (ancestor === destination) break;
            }
            if (item.type === 'directory') {
                await fs.mkdir(filename);
                createdDirectories.set(filename, await fs.lstat(filename, { bigint: true }));
                continue;
            }
            const output = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                let checksum = 0xffffffff;
                const sha = createHash('sha256');
                for (let offset = 0; offset < item.size;) {
                    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, item.size - offset), positions[index] + offset);
                    assert(bytesRead > 0, 'Source shortened during extraction');
                    const bytes = chunk.subarray(0, bytesRead);
                    checksum = updateCrc32(checksum, bytes); sha.update(bytes);
                    await output.writeFile(bytes);
                    offset += bytesRead;
                }
                assert.equal((checksum ^ 0xffffffff) >>> 0, item.crc32, 'ZIP changed during extraction');
                assert.equal(sha.digest('hex'), item.sha256, 'ZIP changed during extraction');
            } finally { await output.close(); }
        }
        await noWindowsReparse(destination, true);
        return inventory;
    });
}

// Separate input limits: the official Node archive is not the release ZIP.
export const WINDOWS_NODE_ARCHIVE_LIMITS = Object.freeze({
    archiveBytes: 256 * 1024 ** 2,
    fileBytes: 256 * 1024 ** 2,
    totalBytes: 1024 * 1024 ** 2,
    selectedBytes: 256 * 1024 ** 2,
    entries: 30000,
    nameBytes: 1024,
    totalNameBytes: 16 * 1024 ** 2,
    depth: 32,
});

function nodeZipName(name, root, directory) {
    const bare = directory ? name.slice(0, -1) : name;
    const parts = bare.split('/');
    assert(parts.length <= WINDOWS_NODE_ARCHIVE_LIMITS.depth
        && Buffer.byteLength(name) <= WINDOWS_NODE_ARCHIVE_LIMITS.nameBytes, 'Node ZIP name/depth budget');
    for (const part of parts) component(part);
    assert(parts[0] === root && (parts.length > 1 || directory), 'Node ZIP archive root mismatch');
    return { bare, parts, key: bare.normalize('NFC').toUpperCase().normalize('NFC') };
}

function nodeZipExtra(bytes) {
    for (let at = 0; at < bytes.length;) {
        assert(at + 4 <= bytes.length, 'Invalid Node ZIP extra header');
        const tag = bytes.readUInt16LE(at);
        const length = bytes.readUInt16LE(at + 2);
        assert(at + 4 + length <= bytes.length, 'Invalid Node ZIP extra bounds');
        // Alternate path and encryption metadata has no role in this reader.
        assert(![0x0001, 0x0017, 0x7075, 0x9901].includes(tag), 'Unsupported Node ZIP extra/ZIP64');
        at += 4 + length;
    }
}

/** Read selected members of a bounded classic STORE/DEFLATE ZIP into memory.
 * Validate every name, local/central header and byte range before inflating any
 * member. Unselected members are not inflated: their CRC fields must agree,
 * while full input authentication belongs to readPinnedNodeArchive.
 */
export async function readZipMembers(bytes, archiveRoot, members) {
    const bound = WINDOWS_NODE_ARCHIVE_LIMITS;
    assert(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= bound.archiveBytes,
        'Node ZIP archive size budget');
    component(archiveRoot);
    assert(Array.isArray(members) && members.length > 0 && members.length <= bound.entries,
        'Node ZIP selected member budget');
    const requested = new Set();
    for (const member of members) {
        assert(typeof member === 'string' && !member.endsWith('/'), 'Expected Node ZIP file member');
        nodeZipName(`${archiveRoot}/${member}`, archiveRoot, false);
        assert(!requested.has(member), 'Duplicate selected Node ZIP member');
        requested.add(member);
    }
    const end = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'Missing Node ZIP end record');
    assert(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0
        && bytes.readUInt16LE(end + 20) === 0, 'Node ZIP disks/comments unsupported');
    const count = bytes.readUInt16LE(end + 10);
    assert(count > 0 && count <= bound.entries && count === bytes.readUInt16LE(end + 8),
        'Node ZIP entry budget/count');
    const directorySize = bytes.readUInt32LE(end + 12);
    const directoryOffset = bytes.readUInt32LE(end + 16);
    assert(directoryOffset !== 0xffffffff && directorySize !== 0xffffffff
        && directoryOffset + directorySize === end, 'Node ZIP central directory bounds/ZIP64');
    let central = directoryOffset;
    let local = 0;
    let totalBytes = 0;
    let selectedBytes = 0;
    let totalNameBytes = 0;
    const names = new Map();
    const entries = [];
    const selected = new Map();
    for (let index = 0; index < count; index++) {
        assert(central + 46 <= end && bytes.readUInt32LE(central) === 0x02014b50,
            'Invalid Node ZIP central header');
        const madeBy = bytes.readUInt16LE(central + 4);
        const version = bytes.readUInt16LE(central + 6);
        const flags = bytes.readUInt16LE(central + 8);
        const method = bytes.readUInt16LE(central + 10);
        assert((method === 0 || method === 8) && (version === 10 || version === 20)
            && (method !== 8 || version === 20), 'Unsupported Node ZIP method/version');
        assert((flags & ~(method === 8 ? 0x806 : 0x800)) === 0,
            'Unsupported Node ZIP flags/encryption/descriptor');
        const crc = bytes.readUInt32LE(central + 16);
        const packed = bytes.readUInt32LE(central + 20);
        const size = bytes.readUInt32LE(central + 24);
        const nameLength = bytes.readUInt16LE(central + 28);
        const extraLength = bytes.readUInt16LE(central + 30);
        const commentLength = bytes.readUInt16LE(central + 32);
        assert(bytes.readUInt16LE(central + 34) === 0, 'Node ZIP disk unsupported');
        const attributes = bytes.readUInt32LE(central + 38);
        const host = madeBy >>> 8;
        assert(host === 0 || host === 3, 'Unsupported Node ZIP host attributes');
        assert((attributes & 0xffff & ~0x31) === 0, 'Unsupported Node ZIP file attributes');
        assert(host === 3 || (attributes >>> 16) === 0, 'Unsupported Node ZIP DOS attributes');
        assert(size <= bound.fileBytes && packed <= bound.archiveBytes
            && (method !== 0 || packed === size), 'Node ZIP per-file size budget/STORE size');
        totalBytes += size;
        totalNameBytes += nameLength;
        assert(totalBytes <= bound.totalBytes && totalNameBytes <= bound.totalNameBytes,
            'Node ZIP aggregate size/name budget');
        const centralEnd = central + 46 + nameLength + extraLength + commentLength;
        assert(nameLength > 0 && nameLength <= bound.nameBytes && centralEnd <= end,
            'Node ZIP name/central bounds');
        const nameBytes = bytes.subarray(central + 46, central + 46 + nameLength);
        // Non-UTF8 encodings are intentionally limited to their ASCII overlap.
        assert((flags & 0x800) !== 0 || nameBytes.every(byte => byte < 128), 'Unsupported Node ZIP name encoding');
        const name = utf8.decode(nameBytes);
        const directory = name.endsWith('/');
        const { bare, parts, key } = nodeZipName(name, archiveRoot, directory);
        assert(!names.has(key), 'Node ZIP name collision');
        names.set(key, { bare, directory });
        entries.push({ bare, parts });
        const unixType = (attributes >>> 16) & 0xf000;
        assert(host !== 3 || unixType === 0 || unixType === (directory ? 0x4000 : 0x8000),
            'Node ZIP symlink/special file unsupported');
        assert(!directory || (attributes & 0x10) !== 0, 'Node ZIP directory attributes mismatch');
        assert(directory || (attributes & 0x10) === 0, 'Node ZIP file attributes mismatch');
        assert(!directory || (size === 0 && packed === 0 && crc === 0 && method === 0),
            'Nonempty Node ZIP directory');
        nodeZipExtra(bytes.subarray(central + 46 + nameLength, central + 46 + nameLength + extraLength));
        const offset = bytes.readUInt32LE(central + 42);
        assert(offset === local && offset + 30 <= directoryOffset
            && bytes.readUInt32LE(offset) === 0x04034b50, 'Node ZIP local offset/bounds/header');
        assert(bytes.subarray(offset + 4, offset + 28).equals(bytes.subarray(central + 6, central + 30)),
            'Node ZIP local/central header mismatch');
        const localExtraLength = bytes.readUInt16LE(offset + 28);
        const data = offset + 30 + nameLength + localExtraLength;
        assert(data + packed <= directoryOffset, 'Node ZIP local data bounds');
        assert(bytes.subarray(offset + 30, offset + 30 + nameLength).equals(nameBytes),
            'Node ZIP local/central name mismatch');
        nodeZipExtra(bytes.subarray(offset + 30 + nameLength, data));
        const relative = parts.slice(1).join('/');
        if (requested.has(relative)) {
            assert(!directory, 'Selected Node ZIP member is a directory');
            selectedBytes += size;
            assert(selectedBytes <= bound.selectedBytes, 'Node ZIP selected output budget');
            selected.set(relative, { method, size, crc, data, packed });
        }
        local = data + packed;
        central = centralEnd;
    }
    assert(local === directoryOffset && central === end, 'Uninventoried Node ZIP bytes/entries');
    for (const { parts } of entries) {
        for (let length = 1; length < parts.length; length++) {
            const parentName = parts.slice(0, length).join('/');
            const parent = names.get(parentName.normalize('NFC').toUpperCase().normalize('NFC'));
            assert(parent && parent.directory && parent.bare === parentName,
                'Missing/conflicting Node ZIP directory ancestor');
        }
    }
    assert.equal(selected.size, requested.size, 'Missing selected Node ZIP member');
    const result = new Map();
    for (const member of members) {
        const entry = selected.get(member);
        const compressed = bytes.subarray(entry.data, entry.data + entry.packed);
        let content;
        if (entry.method === 0) content = Buffer.from(compressed);
        else {
            const inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1), info: true });
            assert.equal(inflated.engine.bytesWritten, entry.packed, 'Trailing Node ZIP compressed data');
            content = inflated.buffer;
        }
        assert.equal(content.length, entry.size, 'Node ZIP inflated size mismatch');
        assert.equal(crc32(content), entry.crc, 'Node ZIP CRC mismatch');
        result.set(member, content);
    }
    return result;
}

/** Authenticate the entire reviewed Node ZIP before decoding selected files. */
export async function readPinnedNodeArchive(bytes, pin) {
    assert(Buffer.isBuffer(bytes) && bytes.length <= WINDOWS_NODE_ARCHIVE_LIMITS.archiveBytes,
        'Node ZIP archive size budget');
    assert(pin && typeof pin.sha256 === 'string' && /^[0-9a-f]{64}$/.test(pin.sha256), 'Invalid Node ZIP SHA-256 pin');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256,
        'NODE_ARCHIVE_HASH_MISMATCH: no extraction performed');
    return readZipMembers(bytes, pin.archiveRoot, pin.files);
}
