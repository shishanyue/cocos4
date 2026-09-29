import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError, releaseIdSchema } from './contracts.js';
import { parseJson } from './sdk.js';

// Discover only the executing application's release, never a caller-selected
// manifest or environment override. Direct CLI and AI-spawned MCP use this too.
export async function loadReleaseIdentity(sdkId: string): Promise<string | null> {
    const app = fileURLToPath(new URL('../', import.meta.url));
    if (path.basename(app) !== 'app') return null;
    try {
        const root = path.dirname(app.replace(/\/$/, ''));
        let packaged = false;
        try { await lstat(path.join(root, 'release.json')); packaged = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!packaged) {
            const file = await open(path.join(app, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
                .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (!file) return null;
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Invalid application manifest.');
                const bytes = Buffer.alloc(65537);
                let length = 0;
                while (length < bytes.length) {
                    const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
                    if (!bytesRead) break;
                    length += bytesRead;
                }
                if (length > 65536) throw new Error('Oversized application manifest.');
                const data = z.object({ cocos4Portable: z.boolean().optional() }).parse(parseJson(bytes.toString('utf8', 0, length)));
                packaged = data.cocos4Portable === true;
            } finally { await file.close(); }
            if (!packaged) return null;
        }
        const verifier = new URL('../verify-portable.mjs', import.meta.url);
        const filename = fileURLToPath(verifier);
        const stat = await lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022)
            || (stat.uid !== 0 && stat.uid !== process.getuid!()) || await realpath(filename) !== filename) {
            throw new Error('Unsafe release verifier.');
        }
        const module: { verifyInventory(root: string): Promise<unknown>; verifyHost(root: string, manifest: unknown): Promise<unknown> } = await import(verifier.href);
        const manifest = await module.verifyInventory(root);
        await module.verifyHost(root, manifest);
        const release = z.object({ releaseId: releaseIdSchema, sdk: z.object({ sdkId: z.literal(sdkId) }) })
            .parse(manifest);
        return release.releaseId;
    } catch {
        throw new AppError('SDK_INCOMPLETE', 'The executing application release could not be verified for this SDK.');
    }
}
