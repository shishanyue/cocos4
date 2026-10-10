import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// A complete local game can be hundreds of MiB; receipt creation should stream it.
export async function describeApk(filename) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) { bytes += chunk.length; hash.update(chunk); }
    return { bytes, sha256: hash.digest('hex') };
}
