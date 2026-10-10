// Online preparation is deliberately separate from offline portable assembly.
// Only the reviewed official Windows x64 Node input can be downloaded here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireWindowsNodePin } from './prepare-windows-components.mjs';
import { readStable, WINDOWS_ARCHIVE_LIMITS } from './windows-archive.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WINDOWS_NODE_DOWNLOAD_DIRECTORY = path.join(root, 'build', 'downloads');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function requireDirectory(directory) {
    const stat = await fs.lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Download cache must contain real directories');
    assert.equal(await fs.realpath(directory), directory, 'Download cache aliases are not allowed');
}

function getOfficialBytes(url, maximum) {
    const parsed = new URL(url);
    assert(parsed.origin === 'https://nodejs.org' && !parsed.username && !parsed.password
        && !parsed.search && !parsed.hash, 'Only the reviewed official HTTPS origin is accepted');
    return new Promise((resolve, reject) => {
        let timer;
        const request = https.get(parsed, { rejectUnauthorized: true, headers: { 'Accept-Encoding': 'identity' } }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                request.destroy(new Error(`Node download returned HTTP ${response.statusCode}; redirects are not accepted`));
                return;
            }
            const declared = response.headers['content-length'];
            if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
                request.destroy(new Error('Node download content-length exceeds the fixed limit'));
                return;
            }
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                request.destroy(new Error('Unexpected HTTP content encoding'));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > maximum) request.destroy(new Error('Node download exceeds the fixed limit'));
                else chunks.push(chunk);
            });
            response.once('error', reject);
            response.once('end', () => {
                if (!response.complete || (declared !== undefined && size !== Number(declared))) {
                    reject(new Error('Incomplete Node download'));
                    return;
                }
                resolve(Buffer.concat(chunks, size));
            });
        });
        timer = setTimeout(() => request.destroy(new Error('Node download exceeded five minutes')), 5 * 60 * 1000);
        request.setTimeout(30000, () => request.destroy(new Error('Node download stalled')));
        request.once('error', reject);
        request.once('close', () => clearTimeout(timer));
    });
}

/** Return the hash-verified fixed cache entry, downloading it only when absent.
 * Existing corrupt/conflicting cache entries are retained and rejected.
 */
export async function downloadWindowsNode() {
    const pin = requireWindowsNodePin(JSON.parse(await readStable(path.join(root, 'packaging/node-win32-lock.json'), 64 * 1024)));
    // Walk existing ancestors first, then create only our two known cache levels.
    for (let parent = root;; parent = path.dirname(parent)) {
        await requireDirectory(parent);
        if (path.dirname(parent) === parent) break;
    }
    for (const directory of [path.join(root, 'build'), WINDOWS_NODE_DOWNLOAD_DIRECTORY]) {
        await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await requireDirectory(directory);
    }
    const filename = `${pin.archiveRoot}.zip`;
    const archive = path.join(WINDOWS_NODE_DOWNLOAD_DIRECTORY, filename);
    const cached = await fs.lstat(archive).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (cached) {
        const bytes = await readStable(archive, WINDOWS_ARCHIVE_LIMITS.fileBytes);
        assert.equal(hash(bytes), pin.sha256, 'NODE_ARCHIVE_HASH_MISMATCH: existing cache retained');
        return { archive, version: pin.version, bytes: bytes.length, sha256: pin.sha256, cached: true };
    }
    const sums = (await getOfficialBytes(pin.checksumsUrl, 1024 ** 2)).toString('utf8');
    const expected = `${pin.sha256}  ${filename}`;
    assert.equal(sums.split(/\r?\n/).filter(line => line.endsWith(`  ${filename}`)).join('\n'), expected,
        'Official Node checksums do not match the reviewed pin');
    const bytes = await getOfficialBytes(pin.url, WINDOWS_ARCHIVE_LIMITS.fileBytes);
    assert.equal(hash(bytes), pin.sha256, 'NODE_ARCHIVE_HASH_MISMATCH: downloaded bytes not published');
    await requireDirectory(WINDOWS_NODE_DOWNLOAD_DIRECTORY);
    const temporary = await fs.mkdtemp(path.join(WINDOWS_NODE_DOWNLOAD_DIRECTORY, '.node-download-'));
    const staged = path.join(temporary, filename);
    try {
        await fs.writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
        assert.equal(hash(await readStable(staged, WINDOWS_ARCHIVE_LIMITS.fileBytes)), pin.sha256, 'Staged Node archive changed');
        // Hardlink publication is atomic and cannot replace an existing file.
        await fs.link(staged, archive);
        await fs.unlink(staged);
        await fs.rmdir(temporary);
    } catch (error) {
        // Retain our bounded temporary evidence if publication or cleanup failed.
        throw new Error(`${error.message}; download staging retained at ${temporary}`, { cause: error });
    }
    return { archive, version: pin.version, bytes: bytes.length, sha256: pin.sha256, cached: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/download-node-win32.mjs');
    downloadWindowsNode().then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
