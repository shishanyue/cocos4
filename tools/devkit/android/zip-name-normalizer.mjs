#!/usr/bin/env node
// Bounded ZIP entry-name normalizer for the HTML5 -> Android WebView shell.
//
// Windows aapt2 stores asset and resource paths with backslash separators
// ("assets/www\index.html"). Android AssetManager2 resolves "www/index.html" as an exact
// "assets/www/index.html" lookup, so a backslash archive 404s every local asset on device.
// direct-build.mjs calls normalizeZipEntryNames() after the last ZIP-writing tool (aapt2 link
// plus `jar --update`) and before zipalign/signing, so the signed APK carries portable names.
//
// Only the 1-byte name fields of each local header and central-directory record are rewritten
// (0x5C -> 0x2F). Entry offsets, CRC-32 values, compressed/uncompressed sizes, compression
// methods, data descriptors, payload bytes and the signing-block position are untouched.
// Parsing is bounded (EOCD tail, ZIP64 records, per-record headers) and every record is
// validated before the first write; malformed archives and names that collide after
// normalization fail with a stable code instead of producing a half-normalized archive.
//
// CLI: node zip-name-normalizer.mjs <apk> [--verify-only]
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const EOCD_SEARCH_BYTES = 0xffff + EOCD_BYTES;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EOCD_BYTES = 56;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const EOCD_TAIL = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const decoder = new TextDecoder('utf-8', { fatal: false });

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const decodeName = bytes => decoder.decode(bytes);
const keyName = bytes => bytes.toString('latin1');
const safeNumber = (value, label) => {
    if (value > MAX_SAFE_INTEGER) fail('ZIP_MALFORMED', `${label} exceeds the supported archive range.`);
    return Number(value);
};

async function readExactly(handle, length, position, label) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) fail('ZIP_MALFORMED', `Truncated archive while reading ${label}.`);
    return buffer;
}

async function readDirectoryEnd(handle, size) {
    if (!Number.isSafeInteger(size) || size < EOCD_BYTES) fail('ZIP_MALFORMED', 'Archive is too small to contain an end record.');
    const tailBytes = Math.min(size, EOCD_SEARCH_BYTES);
    const tailStart = size - tailBytes;
    const tail = await readExactly(handle, tailBytes, tailStart, 'end record');
    let searchEnd = tail.length - EOCD_BYTES;
    let eocdAt = -1;
    while (searchEnd >= 0) {
        const found = tail.lastIndexOf(EOCD_TAIL, searchEnd);
        if (found < 0) break;
        if (found + EOCD_BYTES + tail.readUInt16LE(found + 20) === tail.length) { eocdAt = found; break; }
        searchEnd = found - 1;
    }
    if (eocdAt < 0) fail('ZIP_MALFORMED', 'No valid end-of-central-directory record found.');
    const eocdOffset = tailStart + eocdAt;
    const diskNumber = tail.readUInt16LE(eocdAt + 4);
    const directoryDisk = tail.readUInt16LE(eocdAt + 6);
    const diskEntries = tail.readUInt16LE(eocdAt + 8);
    const entries = tail.readUInt16LE(eocdAt + 10);
    const directoryBytes = tail.readUInt32LE(eocdAt + 12);
    const directoryOffset = tail.readUInt32LE(eocdAt + 16);
    const zip64 = diskEntries === 0xffff || entries === 0xffff || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff;
    let result = { entries, directoryBytes, directoryOffset };
    if (zip64) {
        const locatorOffset = eocdOffset - ZIP64_LOCATOR_BYTES;
        if (locatorOffset < 0) fail('ZIP_MALFORMED', 'ZIP64 locator is missing.');
        const locator = await readExactly(handle, ZIP64_LOCATOR_BYTES, locatorOffset, 'ZIP64 locator');
        if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
            fail('ZIP_MALFORMED', 'ZIP64 locator is invalid or spans multiple disks.');
        }
        const recordOffset = safeNumber(locator.readBigUInt64LE(8), 'ZIP64 directory offset');
        const record = await readExactly(handle, ZIP64_EOCD_BYTES, recordOffset, 'ZIP64 end record');
        if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) fail('ZIP_MALFORMED', 'ZIP64 end record signature is invalid.');
        const recordBytes = safeNumber(record.readBigUInt64LE(4), 'ZIP64 end record size');
        if (recordBytes < 44 || recordOffset + 12 + recordBytes > size) fail('ZIP_MALFORMED', 'ZIP64 end record size is invalid.');
        if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) fail('ZIP_MALFORMED', 'Multi-disk ZIP64 archives are not supported.');
        const zip64DiskEntries = safeNumber(record.readBigUInt64LE(24), 'ZIP64 entry count');
        const zip64Entries = safeNumber(record.readBigUInt64LE(32), 'ZIP64 entry count');
        if (zip64DiskEntries !== zip64Entries) fail('ZIP_MALFORMED', 'ZIP64 entry counts disagree.');
        result = { entries: zip64Entries, directoryBytes: safeNumber(record.readBigUInt64LE(40), 'ZIP64 directory size'),
            directoryOffset: safeNumber(record.readBigUInt64LE(48), 'ZIP64 directory offset') };
    } else if (diskEntries !== entries) {
        fail('ZIP_MALFORMED', 'End record entry counts disagree.');
    }
    if (diskNumber !== 0 || directoryDisk !== 0) fail('ZIP_MALFORMED', 'Multi-disk archives are not supported.');
    if (result.entries > Math.floor(result.directoryBytes / CENTRAL_HEADER_BYTES)) fail('ZIP_MALFORMED', 'Entry count exceeds the central directory size.');
    if (result.directoryOffset + result.directoryBytes > size) fail('ZIP_MALFORMED', 'Central directory lies outside the archive.');
    return result;
}

async function readCentralDirectory(handle, end) {
    const records = [];
    const directoryEnd = end.directoryOffset + end.directoryBytes;
    let cursor = end.directoryOffset;
    for (let index = 0; index < end.entries; index += 1) {
        if (cursor + CENTRAL_HEADER_BYTES > directoryEnd) fail('ZIP_MALFORMED', `Central directory record ${index} is truncated.`);
        const header = await readExactly(handle, CENTRAL_HEADER_BYTES, cursor, `central directory record ${index}`);
        if (header.readUInt32LE(0) !== CENTRAL_SIGNATURE) fail('ZIP_MALFORMED', `Central directory record ${index} has an invalid signature.`);
        const flags = header.readUInt16LE(8);
        const nameLength = header.readUInt16LE(28);
        const extraLength = header.readUInt16LE(30);
        const commentLength = header.readUInt16LE(32);
        const localOffset = header.readUInt32LE(42);
        if ((flags & 0x0001) !== 0) fail('ZIP_MALFORMED', `Encrypted entries are not supported (record ${index}).`);
        if (nameLength === 0) fail('ZIP_MALFORMED', `Central directory record ${index} has an empty name.`);
        if (cursor + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength > directoryEnd) {
            fail('ZIP_MALFORMED', `Central directory record ${index} overruns the directory.`);
        }
        if (localOffset === 0xffffffff) fail('ZIP_MALFORMED', `ZIP64 per-entry local offsets are not supported (record ${index}).`);
        const name = await readExactly(handle, nameLength, cursor + CENTRAL_HEADER_BYTES, `entry name ${index}`);
        if (name.includes(0)) fail('ZIP_MALFORMED', `Entry name ${index} contains NUL bytes.`);
        records.push({ index, nameOffset: cursor + CENTRAL_HEADER_BYTES, name, localOffset, localNameOffset: 0, localName: null });
        cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    }
    if (cursor !== directoryEnd) fail('ZIP_MALFORMED', 'Central directory size does not match its records.');
    return records;
}

function assertDistinctNormalizedNames(records) {
    const seen = new Map();
    for (const record of records) {
        const normalized = keyName(record.name).replaceAll('\\', '/');
        const previous = seen.get(normalized);
        if (previous !== undefined) {
            fail('ZIP_NAME_COLLISION', `Entry names ${previous.index} (${decodeName(previous.name)}) and ${record.index} (${decodeName(record.name)}) collide after slash normalization.`);
        }
        seen.set(normalized, record);
    }
    return seen;
}

async function readLocalHeaders(handle, size, end, records) {
    for (const record of records) {
        if (record.localOffset + LOCAL_HEADER_BYTES > size || record.localOffset >= end.directoryOffset) {
            fail('ZIP_MALFORMED', `Local header ${record.index} lies outside the payload area.`);
        }
        const header = await readExactly(handle, LOCAL_HEADER_BYTES, record.localOffset, `local header ${record.index}`);
        if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) fail('ZIP_MALFORMED', `Local header ${record.index} has an invalid signature.`);
        const nameLength = header.readUInt16LE(26);
        const extraLength = header.readUInt16LE(28);
        if (nameLength !== record.name.length) fail('ZIP_MALFORMED', `Local and central name lengths differ for entry ${record.index}.`);
        if (record.localOffset + LOCAL_HEADER_BYTES + nameLength + extraLength > end.directoryOffset) {
            fail('ZIP_MALFORMED', `Local header ${record.index} overruns the payload area.`);
        }
        const name = await readExactly(handle, nameLength, record.localOffset + LOCAL_HEADER_BYTES, `local entry name ${record.index}`);
        if (!name.equals(record.name)) fail('ZIP_MALFORMED', `Local and central names differ for entry ${record.index}.`);
        record.localNameOffset = record.localOffset + LOCAL_HEADER_BYTES;
        record.localName = name;
    }
    return records;
}

async function patchNames(handle, records) {
    let patchedEntries = 0;
    let patchedLocalNames = 0;
    let patchedCentralNames = 0;
    for (const record of records) {
        if (!record.name.includes(BACKSLASH)) continue;
        const normalized = Buffer.from(record.name);
        for (let offset = 0; offset < normalized.length; offset += 1) if (normalized[offset] === BACKSLASH) normalized[offset] = SLASH;
        const local = await handle.write(normalized, 0, normalized.length, record.localNameOffset);
        if (local.bytesWritten !== normalized.length) fail('ZIP_WRITE_FAILED', `Short local-name write for entry ${record.index}.`);
        patchedLocalNames += 1;
        const central = await handle.write(normalized, 0, normalized.length, record.nameOffset);
        if (central.bytesWritten !== normalized.length) fail('ZIP_WRITE_FAILED', `Short central-name write for entry ${record.index}.`);
        patchedCentralNames += 1;
        patchedEntries += 1;
    }
    return { patchedEntries, patchedLocalNames, patchedCentralNames };
}

function summarize(records) {
    const backslash = records.filter(record => record.name.includes(BACKSLASH));
    return { entries: records.length, names: records.map(record => decodeName(record.name)),
        backslashNames: backslash.map(record => decodeName(record.name)) };
}

export async function readZipEntryNames(filename) {
    const handle = await open(filename, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) fail('ZIP_MALFORMED', `Not an ordinary archive file: ${filename}`);
        const end = await readDirectoryEnd(handle, stat.size);
        const records = await readCentralDirectory(handle, end);
        assertDistinctNormalizedNames(records);
        return summarize(records);
    } finally {
        await handle.close();
    }
}

export async function normalizeZipEntryNames(filename) {
    const handle = await open(filename, 'r+');
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) fail('ZIP_MALFORMED', `Not an ordinary archive file: ${filename}`);
        const before = await readDirectoryEnd(handle, stat.size);
        const records = await readCentralDirectory(handle, before);
        assertDistinctNormalizedNames(records);
        await readLocalHeaders(handle, stat.size, before, records);
        const backslashNamesBefore = records.filter(record => record.name.includes(BACKSLASH)).length;
        const patched = await patchNames(handle, records);
        const after = await readDirectoryEnd(handle, stat.size);
        const verified = await readCentralDirectory(handle, after);
        assertDistinctNormalizedNames(verified);
        await readLocalHeaders(handle, stat.size, after, verified);
        if (verified.some(record => record.name.includes(BACKSLASH) || record.localName.includes(BACKSLASH))) {
            fail('ZIP_MALFORMED', 'Backslash entry names remain after normalization.');
        }
        return { entries: verified.length, backslashNamesBefore, backslashNamesRemaining: 0, ...patched,
            names: verified.map(record => decodeName(record.name)) };
    } finally {
        await handle.close();
    }
}

async function main(args) {
    const [filename, ...flags] = args;
    if (!filename || flags.some(flag => flag !== '--verify-only')) {
        console.error('usage: zip-name-normalizer.mjs <apk> [--verify-only]');
        process.exitCode = 2;
        return;
    }
    const verifyOnly = flags.includes('--verify-only');
    const result = verifyOnly ? await readZipEntryNames(filename) : await normalizeZipEntryNames(filename);
    const summary = { apk: filename, mode: verifyOnly ? 'verify-only' : 'patched', entries: result.entries,
        ...(verifyOnly ? {} : { backslashNamesBefore: result.backslashNamesBefore, patchedEntries: result.patchedEntries,
            patchedLocalNames: result.patchedLocalNames, patchedCentralNames: result.patchedCentralNames }),
        backslashNamesRemaining: result.backslashNames.length, backslashSample: result.backslashNames.slice(0, 5) };
    console.log(JSON.stringify(summary, null, 2));
    if (result.backslashNames.length !== 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => {
        console.error(JSON.stringify({ success: false, code: error.code ?? 'ZIP_IO_FAILED', detail: error.message }));
        process.exitCode = 1;
    });
}