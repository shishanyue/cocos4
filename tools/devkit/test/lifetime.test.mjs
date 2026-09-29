import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JobManager } from '../build/src/jobs.js';
import { processIdentity } from '../build/src/process.js';
import { fixture, connect, starter, write, check, finished, terminal, until, sdkRoot } from './fixtures/logic-client.mjs';

class FixtureManager extends JobManager {
    constructor(options) { super(options, new URL('./fixtures/lifetime-worker.mjs', import.meta.url)); }
}

test('real worker crash, terminate, deadline and disk-full failure reap an actual escaped runner tree', { timeout: 90000 }, async t => {
    for (const mode of ['worker-crash', 'worker-kill', 'deadline', 'disk-full']) await t.test(mode, async t => {
        const env = await fixture(t, mode);
        const manager = await FixtureManager.open({ workspace: env.workspace, stateRoot: env.stateRoot, sdkRoot, sdkId: 'lifetime-fixture',
            permissions: { mode: 'develop', preview: false, executeTests: true } });
        env.cleanup.push(async () => { try { await manager.close(); } catch (error) { if (mode !== 'disk-full') throw error; } });
        const receipt = await manager.submit('project_check', { project: mode, target: 'HTML5', profile: '2d-basic', checks: ['logic'] }, randomUUID(), mode === 'deadline' ? 2000 : 30000);
        const pids = await until(async () => {
            try { return JSON.parse(await fs.readFile(path.join(env.stateDirectory, `staging-${receipt.jobId}`, 'logic/pids.json'), 'utf8')); } catch { return false; }
        });
        if (mode === 'worker-kill') await manager.active.get(receipt.jobId).worker.terminate();
        if (mode === 'disk-full') {
            const original = manager.flushLogFiles.bind(manager);
            // /dev/full supplies a real ENOSPC write, injected at the storage
            // boundary while genuine worker/runner/escaped descendants are live.
            manager.flushLogFiles = async () => { await fs.writeFile('/dev/full', 'durability probe'); };
            await assert.rejects(manager.persist(), error => error.code === 'PROCESS_FAILED');
            manager.flushLogFiles = original;
        }
        const job = await until(() => { const value = manager.get(receipt.jobId); return terminal.has(value.state) && value; });
        assert.equal(job.state, mode === 'deadline' ? 'timed_out' : 'failed', JSON.stringify(job));
        assert.equal(job.error.code, mode === 'deadline' ? 'TIMEOUT' : 'PROCESS_FAILED');
        assert.equal(job.exitCode, null);
        assert(job.signal === 'SIGTERM' || job.signal === 'SIGKILL', JSON.stringify(job));
        for (const pid of pids) assert.equal((await processIdentity(pid))?.alive ?? false, false, `Leaked PID ${pid}`);
        assert(!(await fs.readdir(env.stateDirectory)).some(name => name.startsWith('staging-')));
    });
});

test('official MCP lifetime: startup cancellation, timeout, stdin EOF, SIGTERM, server SIGKILL and restart keys', { timeout: 240000 }, async t => {
    const env = await fixture(t, 'mcp-lifetime');
    let session = await connect(env);
    await starter(session);
    await write(env, 'tests/lifetime.test.js', `import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
test('trusted lifetime', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"], { detached: true, env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise(resolve => child.once('message', resolve));
    writeFileSync(path.join(process.cwd(), 'pids.json'), JSON.stringify([process.pid, child.pid]));
    console.log('TREE_READY');
    await new Promise(() => {});
});`);
    await t.test('cancel during worker startup; duplicate cancellation has one terminal outcome', async () => {
        const receipt = await session.call('project_check', check());
        const result = await session.call('job_cancel', { jobId: receipt.jobId });
        assert.equal(result.accepted, true);
        assert.equal((await finished(session, receipt)).job.state, 'cancelled');
        assert.equal((await session.call('job_cancel', { jobId: receipt.jobId })).accepted, false);
    });
    for (const reason of ['cancel', 'deadline', 'EOF', 'SIGTERM', 'SIGKILL']) await t.test(reason, async () => {
        // The deadline includes SDK loading, snapshotting and strict compilation.
        // Leave those real stages time to finish so this case reaches a live tree.
        const args = check('game', ['logic'], { timeoutMs: reason === 'deadline' ? 30000 : 60000 });
        const receipt = await session.call('project_check', args);
        const pids = await until(async () => {
            const page = await session.call('job_get', { jobId: receipt.jobId });
            assert(!terminal.has(page.job.state), `Runner stopped before ready: ${JSON.stringify(page)}`);
            try { return JSON.parse(await fs.readFile(path.join(env.stateDirectory, `staging-${receipt.jobId}`, 'logic/pids.json'), 'utf8')); } catch { return false; }
        }, 60000);
        if (reason === 'cancel') {
            const start = performance.now();
            const result = await session.call('job_cancel', { jobId: receipt.jobId });
            assert.equal(result.accepted, true);
            assert(performance.now() - start < 1500, 'Cancellation blocked on five-second grace');
            assert.equal(result.state, 'cancelling');
        } else if (reason !== 'deadline') {
            await session.close(reason);
            session = await connect(env);
        }
        const page = await finished(session, receipt);
        assert.equal(page.job.state, reason === 'deadline' ? 'timed_out' : reason === 'SIGKILL' ? 'interrupted' : 'cancelled', JSON.stringify(page));
        if (reason !== 'SIGKILL') assert(page.job.signal === 'SIGTERM' || page.job.signal === 'SIGKILL');
        assert.equal((await session.call('project_check', args)).jobId, receipt.jobId);
        for (const pid of pids) await until(async () => !(await processIdentity(pid))?.alive, 10000);
        assert(!(await fs.readdir(env.stateDirectory)).some(name => name.startsWith('staging-')));
    });
    await session.close();
});
