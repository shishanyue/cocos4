import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function listeningSockets(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Expected the owned server PID');
    if (process.platform === 'win32') {
        const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const { stdout, stderr } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            `ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort)`],
        { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
        assert.equal(stderr, '');
        const rows = JSON.parse(stdout);
        assert.ok(Array.isArray(rows));
        return rows.map(row => `${row.LocalAddress}:${row.LocalPort}`).sort();
    }
    const sockets = new Set();
    for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
        try {
            const link = await fs.readlink(`/proc/${pid}/fd/${fd}`);
            const match = /^socket:\[(\d+)\]$/.exec(link);
            if (match) sockets.add(match[1]);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const listeners = [];
    for (const table of ['tcp', 'tcp6']) {
        const rows = (await fs.readFile(`/proc/${pid}/net/${table}`, 'utf8')).trim().split('\n').slice(1);
        for (const row of rows) {
            const fields = row.trim().split(/\s+/);
            if (fields[3] === '0A' && sockets.has(fields[9])) listeners.push(`${table}:${fields[1]}`);
        }
    }
    return listeners.sort();
}
