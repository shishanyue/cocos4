import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** APK packaging is a separate CLI permission route, not an engine target or MCP job. */
export async function runAndroidCli(args: string[]): Promise<void> {
    const app = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
    const packaged = path.basename(app) === 'app';
    if (packaged) {
        const verifier: { verifyInventory(root: string): Promise<unknown>; verifyHost(root: string, manifest: unknown): Promise<unknown> }
            = await import(new URL('../verify-portable.mjs', import.meta.url).href);
        const root = path.dirname(app);
        await verifier.verifyHost(root, await verifier.verifyInventory(root));
    }
    const entry = new URL(packaged ? '../android/cli.mjs' : '../../android/cli.mjs', import.meta.url);
    const filename = fileURLToPath(entry);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(filename) !== filename) {
        throw Object.assign(new Error('The APK CLI tools are missing or aliased.'), { code: 'SDK_INCOMPLETE' });
    }
    const cli: { runAndroidCli(args: string[]): Promise<void> } = await import(entry.href);
    await cli.runAndroidCli(args);
}
