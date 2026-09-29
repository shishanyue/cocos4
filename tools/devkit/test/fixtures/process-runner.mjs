import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2];
const mode = JSON.parse(await fs.readFile(path.join(directory, 'mode.json'), 'utf8')).mode;
const role = process.argv[3] ?? 'runner';
if (role !== 'runner') {
    process.on('SIGTERM', () => {});
    process.on('SIGHUP', () => {});
    let descendants = [];
    if (role === 'child') {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), directory, 'grandchild'], { detached: true,
            env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        descendants = await new Promise(resolve => child.once('message', resolve));
        if (mode === 'double-fork') child.disconnect();
        child.unref();
    }
    process.send([process.pid, ...descendants]);
    if (mode === 'double-fork' && role === 'child') process.disconnect();
    else setInterval(() => {}, 1000);
} else if (['tree', 'double-fork', 'exit-tree'].includes(mode)) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), directory, 'child'], { detached: true,
        env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const descendants = await new Promise(resolve => child.once('message', resolve));
    process.send({ type: 'tree_ready', runner: process.pid, descendants });
    child.unref();
    if (mode === 'exit-tree') { child.disconnect(); process.disconnect(); }
    else { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
} else if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
else {
    process.send({ type: 'fixture', runner: process.pid });
    process.disconnect();
    process.exitCode = mode === 'fail' ? 7 : 0;
}
