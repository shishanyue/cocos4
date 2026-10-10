import * as fs from 'node:fs/promises';
import path from 'node:path';
import { enforceWindowsPrivate, enforceWindowsReadOnly } from '../../build/src/windows-fs.js';

// Elevated Windows children inherit ACLs, but default to Administrators ownership.
// Apply the same creation-time ownership contract as production private writers.
export async function privateFixturePath(filename) {
    if (process.platform !== 'win32') return;
    const info = await fs.lstat(filename);
    const readonly = info.isFile() && (info.mode & 0o200) === 0;
    await enforceWindowsPrivate(filename);
    if (readonly) await enforceWindowsReadOnly(filename);
}

export async function privateFixtureTree(root, { preserveReadonly = true } = {}) {
    if (process.platform !== 'win32') return;
    let count = 0;
    const walk = async filename => {
        if (++count > 10000) throw new Error('Private fixture tree exceeds its entry budget');
        const info = await fs.lstat(filename);
        if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
            throw new Error('Only owned regular fixture entries can receive private permissions');
        }
        if (preserveReadonly) await privateFixturePath(filename);
        else await enforceWindowsPrivate(filename);
        if (info.isDirectory()) for (const name of await fs.readdir(filename)) await walk(path.join(filename, name));
    };
    await walk(root);
}
