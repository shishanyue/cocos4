import { parentPort, workerData } from 'node:worker_threads';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { privateFixtureTree } from './windows-private.mjs';

const mode = workerData.input.project;
if (workerData.operation === 'doctor') {
    if (mode === 'flood') {
        process.stdout.write('pass');
        process.stdout.write('word="split secret"\nhttps://user:url-secret@example.test/?token=query-secret\n');
        process.stderr.write('Authorization: Bearer bearer-secret\n');
        for (let index = 0; index < 24 * 1024; index++) {
            if (!process.stdout.write('x'.repeat(1023) + '\n')) await once(process.stdout, 'drain');
        }
    }
    parentPort.postMessage({ type: 'result', report: { summary: 'Fixture complete', validationLevels: ['fixture'],
        items: mode === 'failed-report' ? [{ name: 'check', status: 'failed', message: 'Failure is not success.' }] : [] } });
    parentPort.close();
} else {
    const directory = path.join(workerData.staging, 'logic');
    await fs.mkdir(path.join(directory, 'tests'), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify({ version: 1, files: ['tests/lifetime.test.cjs'] }), { mode: 0o400 });
    await fs.writeFile(path.join(directory, 'tests/lifetime.test.cjs'), `
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
test('live tree', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
        { detached: true, env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise(resolve => child.once('message', resolve));
    fs.writeFileSync(path.join(process.cwd(), 'pids.json'), JSON.stringify([process.pid, child.pid]));
    console.log('TREE_READY');
    await new Promise(() => {});
});
`, { mode: 0o400 });
    await privateFixtureTree(workerData.staging, { preserveReadonly: false });
    parentPort.postMessage({ type: 'execute_logic' });
    if (mode === 'worker-crash') {
        const timer = setInterval(async () => {
            try { await fs.stat(path.join(directory, 'pids.json')); } catch { return; }
            clearInterval(timer);
            throw new Error('Intentional real worker crash with live descendant processes.');
        }, 10);
    }
    parentPort.once('message', result => {
        parentPort.postMessage(result.error ? { type: 'error', error: result.error }
            : { type: 'result', report: { summary: 'Fixture runner completed', validationLevels: ['fixture'], items: [] } });
        parentPort.close();
    });
}
