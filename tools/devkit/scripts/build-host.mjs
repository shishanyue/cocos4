import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Maintainer preparation only. Installed kits ship these helpers and never
// discover compilers or build host code while serving CLI/MCP requests.
assert(['linux', 'win32'].includes(process.platform), 'Host tools support Linux and Windows only.');
assert.equal(process.arch, 'x64', 'Host tools support x64 only.');
const scripts = ['build-publisher.mjs', 'build-supervisor.mjs', 'build-mcp-launch.mjs'];
if (process.platform === 'win32') scripts.push('build-fs-win32.mjs');
for (const script of scripts) {
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))],
            { stdio: 'inherit', shell: false, windowsHide: true });
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve()
            : reject(new Error(`${script} failed (${code ?? signal}).`)));
    });
}
