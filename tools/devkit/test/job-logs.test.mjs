import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { JobManager } from '../build/src/jobs.js';
import { fixture, until, terminal, sdkRoot } from './fixtures/logic-client.mjs';

class FixtureManager extends JobManager {
    constructor(options) { super(options, new URL('./fixtures/lifetime-worker.mjs', import.meta.url)); }
}
async function manager(t) {
    const env = await fixture(t, 'log-retention');
    const options = { workspace: env.workspace, stateRoot: env.stateRoot, sdkRoot, sdkId: 'log-fixture' };
    const manager = await FixtureManager.open(options);
    env.cleanup.push(() => manager.close());
    return { env, manager, options };
}
async function done(manager, receipt) { return until(() => { const job = manager.get(receipt.jobId); return terminal.has(job.state) && job; }); }

test('24 MiB real worker stdout backpressure drains into 8 MiB logs with redaction, paging and durable counters', { timeout: 60000 }, async t => {
    const { env, manager: jobs, options } = await manager(t);
    const receipt = await jobs.submit('doctor', { project: 'flood' }, 'flood-key');
    const job = await done(jobs, receipt);
    assert.equal(job.state, 'succeeded');
    const info = jobs.logInfo(job.jobId);
    assert(info.totalBytes > 7.9 * 1024 * 1024 && info.totalBytes <= 8 * 1024 * 1024);
    assert.equal(info.truncated, true);
    assert(info.discardedLogBytes > 15 * 1024 * 1024);
    assert.equal(job.discardedLogBytes, info.discardedLogBytes);
    const first = jobs.logBytes(job.jobId, 0, 16384).toString();
    for (const secret of ['split secret', 'url-secret', 'query-secret', 'bearer-secret']) assert(!first.includes(secret));
    assert(first.includes('[REDACTED]'));
    for (let offset = 0; offset < info.totalBytes; offset += 16384) assert.equal(jobs.logBytes(job.jobId, offset, 16384).length, Math.min(16384, info.totalBytes - offset));
    assert((await fs.stat(path.join(env.stateDirectory, 'metadata.json'))).size < 8192, 'Log text leaked into metadata JSON');
    const saved = jobs.logs(job.jobId);
    await jobs.close();
    const restored = await FixtureManager.open(options);
    env.cleanup.push(() => restored.close());
    assert.deepEqual(restored.logs(job.jobId), saved);
    assert.equal((await restored.submit('doctor', { project: 'flood' }, 'flood-key')).jobId, job.jobId);
});

test('256 MiB workspace eviction preserves seven-day keys and bounded metadata admission; v2 keys migrate', { timeout: 120000 }, async t => {
    const { env, manager: jobs, options } = await manager(t);
    const receipts = [];
    const block = 'v'.repeat(8191) + '\n';
    for (let index = 0; index < 34; index++) {
        const receipt = await jobs.submit('doctor', {}, `retained-${index}`);
        await done(jobs, receipt);
        receipts.push(receipt);
        // Exercise the actual storage/quota implementation without launching 34
        // extra producers of 256 MiB of redundant stdout for each pinned Node.
        for (let count = 0; count < 1023; count++) jobs.appendLog(receipt.jobId, block);
        await jobs.enqueue(() => jobs.persist());
    }
    const info = jobs.logInfo(receipts[0].jobId);
    assert(info.truncated && info.generation > 0 && info.totalBytes < 256);
    assert(info.discardedLogBytes > 7 * 1024 * 1024);
    assert.equal((await jobs.submit('doctor', {}, 'retained-0')).jobId, receipts[0].jobId);
    await assert.rejects(jobs.submit('doctor', { project: 'changed' }, 'retained-0'), error => error.code === 'REQUEST_CONFLICT');
    const storedBytes = (await Promise.all((await fs.readdir(env.stateDirectory)).filter(name => name.startsWith('log-'))
        .map(async name => (await fs.stat(path.join(env.stateDirectory, name))).size))).reduce((a, b) => a + b, 0);
    assert(storedBytes <= 256 * 1024 * 1024 && storedBytes > 248 * 1024 * 1024);
    for (let index = 34; index < 64; index++) await done(jobs, await jobs.submit('doctor', {}, `retained-${index}`));
    await assert.rejects(jobs.submit('doctor', {}, 'new-key'), error => error.code === 'LIMIT_EXCEEDED');
    assert.equal((await jobs.submit('doctor', {}, 'retained-0')).jobId, receipts[0].jobId);
    await jobs.close();
    const restored = await FixtureManager.open(options);
    env.cleanup.push(() => restored.close());
    assert.equal(restored.list().length, 64);
    assert.equal((await restored.submit('doctor', {}, 'retained-0')).jobId, receipts[0].jobId);
    assert.deepEqual(restored.logInfo(receipts[0].jobId), info);
    await restored.close();
    const file = path.join(env.stateDirectory, 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(file, 'utf8'));
    const record = metadata.records[0];
    for (const field of ['createdAt', 'startedAt', 'finishedAt', 'deadline']) if (record.job[field] !== null) record.job[field] -= 8 * 24 * 60 * 60 * 1000;
    await fs.writeFile(file, JSON.stringify(metadata));
    const expired = await FixtureManager.open(options);
    env.cleanup.push(() => expired.close());
    assert.throws(() => expired.get(receipts[0].jobId), error => error.code === 'JOB_NOT_FOUND');
    assert.notEqual((await expired.submit('doctor', {}, 'retained-0')).jobId, receipts[0].jobId);
});

test('legacy inline logs and accepted v2 keys migrate without inventing successful execution observations', async t => {
    const { env, manager: jobs, options } = await manager(t);
    const receipt = await jobs.submit('doctor', {}, 'legacy-key');
    await done(jobs, receipt);
    await jobs.close();
    const file = path.join(env.stateDirectory, 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(file, 'utf8'));
    metadata.version = 2;
    delete metadata.artifacts;
    for (const record of metadata.records) {
        delete record.executesLogic; delete record.supervisor;
        delete record.job.exitCode; delete record.job.signal; delete record.job.workerExitCode; delete record.job.discardedLogBytes; delete record.job.releaseId;
        record.logs = { text: 'legacy retained text\n', truncated: false };
    }
    await fs.writeFile(file, JSON.stringify(metadata));
    const restored = await FixtureManager.open(options);
    env.cleanup.push(() => restored.close());
    assert.equal((await restored.submit('doctor', {}, 'legacy-key')).jobId, receipt.jobId);
    assert(restored.logs(receipt.jobId).text.includes('legacy retained text'));
    assert.equal(restored.get(receipt.jobId).exitCode, null);
    assert.equal(restored.get(receipt.jobId).discardedLogBytes, null);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 5);
});

test('failed report items never become a successful job', async t => {
    const { manager: jobs } = await manager(t);
    const job = await done(jobs, await jobs.submit('doctor', { project: 'failed-report' }));
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, 0, 'Worker completion is not check success');
});
