import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Node 18 and the Windows command shell do not expand test/*.test.mjs.
// Enumerate the same complete suite without relying on either implementation.
const devkit = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(new URL('../test/', import.meta.url)))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), 'build/probes/mcp-client.js', ...files],
    { cwd: devkit, stdio: 'inherit', shell: false, windowsHide: true });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
