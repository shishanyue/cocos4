import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { JobManager } from '../build/src/jobs.js';
import { AppError, jobSchema, receiptSchema } from '../build/src/contracts.js';

const fixture = new URL('./fixtures/job-worker.mjs', import.meta.url);
class FixtureManager extends JobManager {
    constructor(options) { super(options, fixture); }
}
// Probe actual Worker limits without loading a fake SDK or bypassing production checks.
const resourceWorker = new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort, resourceLimits } from 'node:worker_threads';
    parentPort.postMessage({ type: 'log', text: JSON.stringify(resourceLimits) });
    setInterval(() => {}, 1000);
`)}`);
class ResourceManager extends JobManager {
    constructor(options) { super(options, resourceWorker); }
}
const ended = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const code = expected => error => error instanceof AppError && error.code === expected;

async function setup(t) {
    const base = await mkdtemp(join(await realpath(tmpdir()), 'cocos4-jobs-'));
    const cleanup = [];
    t.after(async () => {
        // A terminal job can still have a pending log flush. All state owners
        // must finish shutdown before removal; separate after hooks ran rm first.
        const results = await Promise.allSettled(cleanup.map(async dispose => dispose()));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Job fixture shutdown failed; temporary state was preserved.');
        await rm(base, { recursive: true, force: true });
    });
    const options = { workspace: join(base, 'workspace'), sdkRoot: join(base, 'sdk'), sdkId: 'sdk-one', stateRoot: join(base, 'state') };
    await Promise.all([options.workspace, options.sdkRoot, options.stateRoot].map(path => mkdir(path, { mode: 0o700 })));
    const directory = join(options.stateRoot, createHash('sha256').update(options.workspace).digest('hex'));
    return { base, options, directory, onCleanup: dispose => cleanup.push(dispose), open: async (override = {}, expectedCloseError) => {
        const manager = await FixtureManager.open({ ...options, ...override });
        cleanup.push(async () => {
            if (expectedCloseError) await assert.rejects(manager.close(), code(expectedCloseError));
            else await manager.close();
        });
        return manager;
    } };
}

async function until(predicate, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await delay(5);
    }
    assert.fail('Timed out waiting for fixture state');
}

async function finished(manager, jobId) {
    return until(() => { const job = manager.get(jobId); return ended.has(job.state) && job; });
}

test('metadata expiry and cross-SDK startup never delete delivered or unreferenced artifacts', async t => {
    const env = await setup(t);
    const first = await env.open();
    const receipt = await first.submit('doctor', {}, 'retention-seed');
    await finished(first, receipt.jobId);
    await first.close();
    const filename = join(env.directory, 'metadata.json');
    const metadata = JSON.parse(await readFile(filename, 'utf8'));
    const record = metadata.records[0];
    const artifactId = receipt.jobId;
    const bytes = Buffer.from('Previously delivered artifact bytes; not a runnable game fixture.');
    record.job.operation = 'game_build';
    record.job.report.artifacts = [{ artifactId, sdkId: env.options.sdkId, target: 'HTML5', profile: '2d-basic', variant: 'debug',
        entry: 'index.html', bytes: bytes.length, files: 1, sha256: createHash('sha256').update(bytes).digest('hex'), validationLevels: ['fixture-only'] }];
    metadata.artifacts = record.job.report.artifacts;
    for (const field of ['createdAt', 'startedAt', 'finishedAt', 'deadline']) if (record.job[field] !== null) record.job[field] -= 8 * 24 * 60 * 60 * 1000;
    await writeFile(filename, JSON.stringify(metadata));
    const artifacts = [artifactId, randomUUID()].map(id => join(env.directory, `artifact-${id}`));
    for (const directory of artifacts) {
        await mkdir(directory, { mode: 0o700 });
        await writeFile(join(directory, 'index.html'), bytes, { mode: 0o400 });
    }
    const staging = join(env.directory, `staging-${receipt.jobId}`);
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, 'partial-output'), 'failed staging', { mode: 0o600 });
    for (const sdkId of [env.options.sdkId, 'another-sdk']) {
        const current = await env.open({ sdkId });
        assert.throws(() => current.get(receipt.jobId), code('JOB_NOT_FOUND'));
        for (const directory of artifacts) assert.deepEqual(await readFile(join(directory, 'index.html')), bytes);
        await assert.rejects(lstat(staging), { code: 'ENOENT' });
        await assert.rejects(lstat(join(env.directory, `log-${receipt.jobId}.txt`)), { code: 'ENOENT' });
        await current.close();
    }
});

test('abandoned foreign-SDK preview metadata cannot occupy the current workspace preview slot', async t => {
    const env = await setup(t);
    const first = await env.open();
    const receipt = await first.submit('doctor', {});
    await finished(first, receipt.jobId);
    await first.close();
    const filename = join(env.directory, 'metadata.json');
    const metadata = JSON.parse(await readFile(filename, 'utf8'));
    const foreign = metadata.records[0];
    const own = structuredClone(foreign);
    foreign.job = { ...foreign.job, operation: 'preview_start', state: 'running', finishedAt: null, report: null };
    const artifactId = randomUUID();
    own.sdkId = 'sdk-two';
    own.job.jobId = artifactId;
    own.job.operation = 'game_build';
    own.job.report.artifacts = [{ artifactId, sdkId: 'sdk-two', target: 'HTML5', profile: '2d-basic', variant: 'debug',
        entry: 'index.html', bytes: 1, files: 1, sha256: 'a'.repeat(64), validationLevels: ['fixture-only'] }];
    metadata.records.push(own);
    metadata.artifacts = own.job.report.artifacts;
    await writeFile(filename, JSON.stringify(metadata));
    const current = await env.open({ sdkId: 'sdk-two', permissions: { mode: 'develop', preview: true, executeTests: false } });
    assert.throws(() => current.get(foreign.job.jobId), code('JOB_NOT_FOUND'));
    const preview = await current.submit('preview_start', { artifactId, ttlSeconds: 1 }, 'own-preview');
    assert.equal(current.get(preview.jobId).operation, 'preview_start');
    await current.cancel(preview.jobId);
    assert.throws(() => current.get(foreign.job.jobId), code('JOB_NOT_FOUND'));
});

test('every non-preview task worker receives the 512 MiB SDK heap budget', async t => {
    const env = await setup(t);
    const manager = await ResourceManager.open({ ...env.options, permissions: { mode: 'develop', preview: false, executeTests: false } });
    env.onCleanup(() => manager.close());
    const requests = [
        ['doctor', {}],
        ['project_create', { directory: 'created', templateId: 'fixture', projectName: 'created' }],
        ['package_validate', { directory: 'package' }],
        ['project_check', { project: 'project', target: 'HTML5', profile: '2d-basic', checks: ['types'] }],
        ['game_build', { project: 'project', target: 'BILIBILI', profile: '2d-basic', variant: 'debug' }],
    ];
    for (const [operation, input] of requests) {
        if (!['doctor', 'package_validate'].includes(operation)) {
            await assert.rejects(manager.submit(operation, input), code('INVALID_ARGUMENTS'));
        }
        const task = await manager.submit(operation, input, operation);
        const limits = JSON.parse(await until(() => manager.logs(task.jobId).text));
        assert.equal(limits.maxOldGenerationSizeMb, 512, operation);
        assert.equal(limits.maxYoungGenerationSizeMb, 16, operation);
        await manager.cancel(task.jobId);
    }
});

test('owned BILIBILI receipts cannot consume a preview slot; one task and one 128 MiB preview can run together', async t => {
    const env = await setup(t);
    const first = await env.open();
    await finished(first, (await first.submit('doctor', {})).jobId);
    await first.close();
    const filename = join(env.directory, 'metadata.json');
    const metadata = JSON.parse(await readFile(filename, 'utf8'));
    const seed = metadata.records[0];
    metadata.records = ['HTML5', 'BILIBILI', 'BILIBILI'].map((target, index) => {
        const record = structuredClone(seed);
        const artifactId = randomUUID();
        if (index === 2) record.sdkId = 'foreign-sdk';
        record.job.jobId = artifactId;
        record.job.operation = 'game_build';
        record.job.report.artifacts = [{ artifactId, sdkId: record.sdkId, target, profile: '2d-basic', variant: 'debug',
            entry: target === 'HTML5' ? 'index.html' : 'game.js', bytes: 1, files: 1, sha256: 'a'.repeat(64), validationLevels: ['fixture-only'] }];
        return record;
    });
    metadata.artifacts = metadata.records.flatMap(record => record.job.report.artifacts);
    await writeFile(filename, JSON.stringify(metadata));
    const [html, bilibili, foreign] = metadata.records.map(record => record.job.jobId);
    const manager = await ResourceManager.open({ ...env.options, permissions: { mode: 'develop', preview: true, executeTests: false } });
    env.onCleanup(() => manager.close());
    const before = manager.list();
    const persisted = await readFile(filename, 'utf8');
    assert.equal(manager.artifact(bilibili).target, 'BILIBILI');
    assert.equal(manager.get(bilibili).state, 'succeeded');
    await assert.rejects(manager.submit('preview_start', { artifactId: foreign }, 'foreign-preview'), code('ARTIFACT_INVALID'));
    await assert.rejects(manager.submit('preview_start', { artifactId: randomUUID() }, 'missing-preview'), code('ARTIFACT_INVALID'));
    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(manager.submit('preview_start', { artifactId: bilibili }, 'preview-key'), code('UNSUPPORTED_PROJECT'));
    }
    assert.deepEqual(manager.list(), before);
    assert.equal(manager.active.size, 0);
    assert.equal(manager.pending.size, 0);
    assert.equal(await readFile(filename, 'utf8'), persisted);

    const preview = await manager.submit('preview_start', { artifactId: html }, 'preview-key');
    const previewLimits = JSON.parse(await until(() => manager.logs(preview.jobId).text));
    assert.equal(previewLimits.maxOldGenerationSizeMb, 128);
    assert.equal(previewLimits.maxYoungGenerationSizeMb, 16);
    await assert.rejects(manager.submit('preview_start', { artifactId: html }, 'extra-preview'), code('WORKSPACE_BUSY'));
    await assert.rejects(manager.submit('preview_start', { artifactId: bilibili }, 'bilibili-preview'), code('UNSUPPORTED_PROJECT'));
    const task = await manager.submit('doctor', {});
    await until(() => manager.logs(task.jobId).text);
    assert.equal(manager.get(preview.jobId).state, 'running');
    assert.equal(manager.list().filter(job => job.state === 'running').length, 2);
    const queued = await manager.submit('doctor', {});
    assert.equal(manager.get(queued.jobId).state, 'queued');
    assert.equal(manager.get(queued.jobId).startedAt, null);
    assert.equal(manager.logs(queued.jobId).text, '');
    await manager.cancel(task.jobId);
    await until(() => manager.logs(queued.jobId).text);
    assert.equal(manager.get(preview.jobId).state, 'running');
    assert.equal(manager.get(queued.jobId).state, 'running');
    await manager.close();

    for (const [target, entry] of [['HTML5', 'game.js'], ['BILIBILI', 'index.html']]) {
        const malformed = structuredClone(metadata);
        Object.assign(malformed.records[0].job.report.artifacts[0], { target, entry });
        const raw = JSON.stringify(malformed);
        await writeFile(filename, raw);
        await assert.rejects(env.open(), code('ARTIFACT_INVALID'));
        assert.equal(await readFile(filename, 'utf8'), raw);
    }
});

test('publication rechecks deadline and shutdown after committing-state persistence', async t => {
    for (const reason of ['deadline', 'shutdown']) await t.test(reason, async t => {
        const env = await setup(t);
        const manager = await env.open({ permissions: { mode: 'develop', preview: false, executeTests: false } });
        const update = manager.update.bind(manager);
        let entered = false;
        let closed;
        manager.update = async (jobId, fields) => {
            await update(jobId, fields);
            if (fields.phase !== 'committing') return;
            entered = true;
            if (reason === 'deadline') await delay(Math.max(1, manager.get(jobId).deadline - Date.now() + 30));
            else closed = manager.close();
        };
        const receipt = await manager.submit('project_create', { directory: 'new-project', templateId: 'fixture', projectName: 'new-project' }, 'create-key', 2000);
        const job = await finished(manager, receipt.jobId);
        if (closed) await closed;
        assert.equal(entered, true);
        assert.equal(job.state, reason === 'deadline' ? 'timed_out' : 'cancelled');
        assert.equal(job.error.code, reason === 'deadline' ? 'TIMEOUT' : 'CANCELLED');
        await assert.rejects(lstat(join(env.options.workspace, 'new-project')), { code: 'ENOENT' });
    });
});

test('worker exit observations and discarded byte counts survive persistence without inventing legacy success', async t => {
    const env = await setup(t);
    const manager = await env.open();
    const success = await finished(manager, (await manager.submit('doctor', { project: 'valid' })).jobId);
    assert.equal(success.exitCode, 0);
    assert.equal(success.signal, null, 'Worker threads do not exit with OS process signals');
    assert.equal(success.discardedLogBytes, 0);
    const failed = await finished(manager, (await manager.submit('doctor', { project: 'exit-code' })).jobId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.exitCode, 7);
    const active = await manager.submit('doctor', { project: 'spin' });
    await until(() => manager.logs(active.jobId).text.includes('fixture:start'));
    const queued = await manager.submit('doctor', {});
    await manager.cancel(queued.jobId);
    assert.equal(manager.get(queued.jobId).exitCode, null);
    await manager.cancel(active.jobId);
    assert.equal(manager.get(active.jobId).exitCode, 1);
    await manager.close();
    const filename = join(env.directory, 'metadata.json');
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    const legacy = stored.records.find(record => record.job.jobId === success.jobId);
    for (const field of ['exitCode', 'signal', 'discardedLogBytes']) delete legacy.job[field];
    delete legacy.logs.discardedBytes;
    await writeFile(filename, JSON.stringify(stored));
    const restored = await env.open();
    assert.equal(restored.get(failed.jobId).exitCode, 7);
    assert.equal(restored.get(success.jobId).exitCode, null);
    assert.equal(restored.get(success.jobId).discardedLogBytes, null);
    assert.equal(restored.logs(success.jobId).discardedLogBytes, null);
});

test('game/check deadlines accept the frozen one-hour maximum and bind request-key deduplication', async t => {
    const env = await setup(t);
    const manager = await ResourceManager.open({ ...env.options, permissions: { mode: 'develop', preview: false, executeTests: false } });
    env.onCleanup(() => manager.close());
    for (const [operation, input] of [
        ['project_check', { project: 'game', target: 'HTML5', profile: '2d-basic', checks: ['types'] }],
        ['game_build', { project: 'game', target: 'HTML5', profile: '2d-basic', variant: 'release' }],
    ]) {
        await assert.rejects(manager.submit(operation, input, operation, 3600001), code('INVALID_ARGUMENTS'));
        const receipt = await manager.submit(operation, input, operation, 3600000);
        const job = manager.get(receipt.jobId);
        assert.equal(job.deadline - job.createdAt, 3600000);
        assert.equal((await manager.submit(operation, input, operation, 3600000)).jobId, receipt.jobId);
        await assert.rejects(manager.submit(operation, input, operation, 600000), code('REQUEST_CONFLICT'));
        await manager.cancel(receipt.jobId);
    }
});

test('release-scoped request keys survive relocation but never reuse another release or unknown legacy producer', async t => {
    const env = await setup(t);
    const releases = ['a', 'b'].map(value => `sha256-${value.repeat(64)}`);
    const relocated = join(env.base, 'relocated-sdk');
    await mkdir(relocated, { mode: 0o700 });
    await assert.rejects(env.open({ releaseId: 'unverified-version-name' }), code('INVALID_ARGUMENTS'));
    const legacy = await env.open();
    const before = await finished(legacy, (await legacy.submit('doctor', { project: 'valid' }, 'same-key')).jobId);
    assert.equal(before.releaseId, null);
    await legacy.close();
    const first = await env.open({ releaseId: releases[0] });
    const original = await finished(first, (await first.submit('doctor', { project: 'valid' }, 'same-key')).jobId);
    assert.notEqual(original.jobId, before.jobId);
    assert.equal(original.releaseId, releases[0]);
    await first.close();
    const moved = await env.open({ releaseId: releases[0], sdkRoot: relocated });
    assert.equal((await moved.submit('doctor', { project: 'valid' }, 'same-key')).jobId, original.jobId);
    await assert.rejects(moved.submit('doctor', { project: 'other' }, 'same-key'), code('REQUEST_CONFLICT'));
    await moved.close();
    const upgraded = await env.open({ releaseId: releases[1], sdkRoot: relocated });
    const after = await finished(upgraded, (await upgraded.submit('doctor', { project: 'valid' }, 'same-key')).jobId);
    assert.notEqual(after.jobId, original.jobId);
    assert.equal(after.releaseId, releases[1]);
    assert.deepEqual(upgraded.get(original.jobId), original, 'Historical output keeps its original producer rather than being relabeled.');
});

function launch(env, mode = 'owner') {
    const child = fork(fileURLToPath(fixture), [mode, JSON.stringify(env.options)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    const message = once(child, 'message').then(([value]) => value);
    env.onCleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    return { child, message, exited, output: () => ({ stdout, stderr }) };
}

test('readonly JobManager: real worker thread scheduling, persistence and containment', { timeout: 60_000 }, async t => {
    await t.test('fixture teardown awaits all state owners before deleting their state', async t => {
        let env;
        let manager;
        let receipt;
        let owner;
        await t.test('leave live workers, a child owner and pending log flushes for automatic cleanup', async t => {
            env = await setup(t);
            const workspace = join(env.base, 'other-workspace');
            await mkdir(workspace, { mode: 0o700 });
            manager = await env.open({ workspace });
            receipt = await manager.submit('doctor', { project: 'staging-hang' });
            await until(() => manager.logs(receipt.jobId).text.includes('fixture:heartbeat'));
            owner = launch(env, 'staging-owner');
            assert.equal((await owner.message).type, 'ready');
            env.onCleanup(async () => {
                await Promise.all([manager.close(), owner.exited]);
                assert.equal(manager.get(receipt.jobId).state, 'cancelled');
                assert.ok((await lstat(env.base)).isDirectory());
            });
        });
        assert.equal(manager.get(receipt.jobId).state, 'cancelled');
        assert.equal(owner.child.signalCode, 'SIGKILL');
        await manager.close();
        await assert.rejects(lstat(env.base), error => error.code === 'ENOENT');
        const logs = manager.logs(receipt.jobId);
        await delay(150);
        assert.deepEqual(manager.logs(receipt.jobId), logs);
        await assert.rejects(lstat(env.base), error => error.code === 'ENOENT');
    });

    await t.test('validated receipts, immutable queries, durable SDK-scoped jobs and request keys', async t => {
        const env = await setup(t);
        const manager = await env.open();
        const input = { project: 'valid' };
        const submission = manager.submit('doctor', input, 'private-request-key');
        input.project = 'mutated-after-submit';
        const receipt = receiptSchema.parse(await submission);
        const job = jobSchema.parse(await finished(manager, receipt.jobId));
        assert.equal(job.state, 'succeeded');
        assert.equal(job.project, 'valid');
        const details = JSON.parse(job.report.items[0].message);
        assert.equal(details.workspace, env.options.workspace);
        assert.equal(details.sdkRoot, env.options.sdkRoot);
        assert.deepEqual(details.input, { project: 'valid', depth: 'quick' });
        assert.deepEqual(details.execArgv, []);
        assert.deepEqual(details.environment, []);
        assert.ok(details.staging.startsWith(env.directory));
        assert.equal((await manager.submit('doctor', { depth: 'quick', project: 'valid' }, 'private-request-key')).jobId, receipt.jobId);
        await assert.rejects(manager.submit('doctor', { project: 'other' }, 'private-request-key'), code('REQUEST_CONFLICT'));
        await assert.rejects(manager.submit('doctor', { project: 'valid' }, 'private-request-key', 5000), code('REQUEST_CONFLICT'));
        manager.list()[0].report.summary = 'mutated copy';
        manager.get(receipt.jobId).state = 'failed';
        assert.equal(manager.get(receipt.jobId).state, 'succeeded');
        assert.notEqual(manager.get(receipt.jobId).report.summary, 'mutated copy');
        assert.deepEqual(await manager.cancel(receipt.jobId), { jobId: receipt.jobId, state: 'succeeded', accepted: false });
        assert.throws(() => manager.get('missing'), code('JOB_NOT_FOUND'));
        assert.throws(() => manager.logs('missing'), code('JOB_NOT_FOUND'));
        await assert.rejects(manager.cancel('missing'), code('JOB_NOT_FOUND'));
        await manager.close();
        assert.equal((await lstat(join(env.directory, 'metadata.json'))).mode & 0o777, 0o600);
        const metadata = await readFile(join(env.directory, 'metadata.json'), 'utf8');
        assert.ok(!metadata.includes('private-request-key'));
        assert.equal(JSON.parse(metadata).records[0].sdkId, env.options.sdkId);
        assert.ok(!('sdkId' in job));
        const reopened = await env.open();
        assert.deepEqual(reopened.get(receipt.jobId), job);
        assert.equal((await reopened.submit('doctor', { project: 'valid' }, 'private-request-key')).jobId, receipt.jobId);
        await reopened.close();
        const upgraded = await env.open({ sdkId: 'sdk-two' });
        assert.deepEqual(upgraded.list(), []);
        assert.throws(() => upgraded.get(receipt.jobId), code('JOB_NOT_FOUND'));
        assert.throws(() => upgraded.logs(receipt.jobId), code('JOB_NOT_FOUND'));
        await assert.rejects(upgraded.cancel(receipt.jobId), code('JOB_NOT_FOUND'));
        const sameKey = await upgraded.submit('doctor', { project: 'valid' }, 'private-request-key');
        assert.notEqual(sameKey.jobId, receipt.jobId);
        assert.equal((await finished(upgraded, sameKey.jobId)).state, 'succeeded');
        const next = await upgraded.submit('package_validate', { directory: 'valid' });
        assert.equal((await finished(upgraded, next.jobId)).state, 'succeeded');
        assert.deepEqual(upgraded.list().map(job => job.jobId), [sameKey.jobId, next.jobId]);
        await upgraded.close();
        const originalSdk = await env.open();
        assert.deepEqual(originalSdk.list(), [job]);
        assert.throws(() => originalSdk.get(sameKey.jobId), code('JOB_NOT_FOUND'));
        assert.equal((await originalSdk.submit('doctor', { project: 'valid' }, 'private-request-key')).jobId, receipt.jobId);
    });

    await t.test('request keys accept only 1..128 ASCII letters, digits, dots, underscores and hyphens', async t => {
        const env = await setup(t);
        const manager = await env.open();
        for (const key of ['', 'with space', 'a/b', 'a:b', 'a\\b', 'a\t', 'a\n', 'a\r\n', 'a\u2028', 'a\u0000', '\u00e9', 'a'.repeat(129), null, 1]) {
            await assert.rejects(manager.submit('doctor', {}, key), code('INVALID_ARGUMENTS'), JSON.stringify(key));
        }
        assert.deepEqual(manager.list(), []);
        for (const key of ['A', 'Az09._-', 'a'.repeat(128)]) {
            const receipt = await manager.submit('doctor', { project: 'valid' }, key);
            assert.equal((await finished(manager, receipt.jobId)).state, 'succeeded');
            assert.equal((await manager.submit('doctor', { project: 'valid' }, key)).jobId, receipt.jobId);
        }
    });

    await t.test('one running worker, eight queued jobs, duplicate admission and queued deadline/cancel', async t => {
        const env = await setup(t);
        const manager = await env.open();
        const active = await manager.submit('doctor', { project: 'hang' });
        await until(() => manager.logs(active.jobId).text.includes('fixture:start'));
        const queued = await Promise.all(Array.from({ length: 8 }, (_, index) => manager.submit('doctor', { project: 'valid' }, `queue-${index}`)));
        assert.equal(manager.list().filter(job => job.state === 'running').length, 1);
        assert.equal(manager.list().filter(job => job.state === 'queued').length, 8);
        assert.ok(queued.every(job => manager.logs(job.jobId).text === ''));
        assert.equal((await manager.submit('doctor', { project: 'valid' }, 'queue-0')).jobId, queued[0].jobId);
        await assert.rejects(manager.submit('doctor', { project: 'valid' }), code('LIMIT_EXCEEDED'));
        assert.equal((await manager.cancel(queued[0].jobId)).accepted, true);
        assert.equal(manager.get(queued[0].jobId).startedAt, null);
        const timed = await manager.submit('doctor', { project: 'valid' }, 'queued-timeout', 50);
        assert.equal((await finished(manager, timed.jobId)).state, 'timed_out');
        assert.equal(manager.get(timed.jobId).startedAt, null);
        assert.equal(manager.logs(timed.jobId).text, '\n[job] timed_out (TIMEOUT)\n');
        assert.equal((await manager.cancel(active.jobId)).state, 'cancelled');
        for (const receipt of queued.slice(1)) assert.equal((await finished(manager, receipt.jobId)).state, 'succeeded');
        const jobs = queued.slice(1).map(receipt => manager.get(receipt.jobId));
        for (let index = 1; index < jobs.length; index++) assert.ok(jobs[index].startedAt >= jobs[index - 1].finishedAt);
    });

    await t.test('production worker URL is fixed and reports an incomplete SDK through its real protocol', async t => {
        const env = await setup(t);
        await assert.rejects(JobManager.open({ ...env.options, workerUrl: fixture }), code('INVALID_ARGUMENTS'));
        const manager = await JobManager.open(env.options);
        try {
            const receipt = await manager.submit('doctor', {});
            const job = await finished(manager, receipt.jobId);
            assert.equal(job.state, 'failed');
            assert.equal(job.error.code, 'SDK_INCOMPLETE');
            assert.equal(job.report, null);
        } finally { await manager.close(); }
    });

    await t.test('busy-loop workers remain cancellable and deadlines include worker startup', async t => {
        const env = await setup(t);
        const manager = await env.open();
        const timed = await manager.submit('doctor', { project: 'spin' }, undefined, 100);
        assert.equal((await finished(manager, timed.jobId)).state, 'timed_out');
        const running = await manager.submit('doctor', { project: 'spin' });
        await until(() => manager.logs(running.jobId).text.includes('fixture:start'));
        const started = Date.now();
        const result = await manager.cancel(running.jobId);
        assert.equal(result.accepted, true);
        assert.equal(result.state, 'cancelled');
        assert.ok(Date.now() - started < 2000);
        assert.equal((await manager.cancel(running.jobId)).accepted, false);
        const next = await manager.submit('doctor', { project: 'valid' });
        assert.equal((await finished(manager, next.jobId)).state, 'succeeded');
    });

    await t.test('accepted cancellation never promotes to success when results race', async t => {
        const env = await setup(t);
        const manager = await env.open();
        for (let index = 0; index < 12; index++) {
            const receipt = await manager.submit('doctor', { project: 'race' });
            if (index % 2) await until(() => manager.logs(receipt.jobId).text.includes('fixture:start'));
            const cancel = await manager.cancel(receipt.jobId);
            const job = await finished(manager, receipt.jobId);
            if (cancel.accepted) assert.equal(job.state, 'cancelled');
            else assert.equal(job.state, 'succeeded');
        }
    });

    await t.test('terminal messages from sources holding handles cannot release the worker slot or hide timeout/cancel logs', async t => {
        const env = await setup(t);
        const source = `
            import { parentPort, workerData } from 'node:worker_threads';
            const mode = workerData.input.project;
            if (mode === 'hold-error') parentPort.postMessage({ type: 'error', error: {
                code: 'ARTIFACT_INVALID', message: 'Fixture error', retryable: false, nextSteps: [],
            } });
            else parentPort.postMessage({ type: 'result', report: { summary: 'Fixture result', items: [], validationLevels: [] } });
            process.stdout.write('stdout after terminal message\\n');
            process.stderr.write('stderr after terminal message\\n');
            parentPort.postMessage({ type: 'log', text: 'fixture:terminal-sent' });
            if (mode.startsWith('hold-')) setInterval(() => parentPort.postMessage({ type: 'log', text: 'fixture:still-live' }), 10);
        `;
        class HoldingManager extends JobManager {
            constructor(options) { super(options, new URL(`data:text/javascript,${encodeURIComponent(source)}`)); }
        }
        const manager = await HoldingManager.open(env.options);
        try {
            const result = await manager.submit('doctor', { project: 'hold-result' });
            await until(() => manager.logs(result.jobId).text.includes('fixture:still-live'));
            const queued = await manager.submit('doctor', { project: 'valid' });
            assert.equal(manager.get(result.jobId).state, 'running');
            assert.equal(manager.get(queued.jobId).state, 'queued');
            assert.ok(!manager.logs(result.jobId).text.includes('[job] succeeded'));
            assert.equal((await manager.cancel(result.jobId)).accepted, true);
            assert.equal((await finished(manager, queued.jobId)).state, 'succeeded');
            assert.match(manager.logs(result.jobId).text, /\[job\] cancelled \(CANCELLED\)\n$/);
            const stoppedLogs = manager.logs(result.jobId);
            await delay(50);
            assert.deepEqual(manager.logs(result.jobId), stoppedLogs);
            const successLogs = manager.logs(queued.jobId).text;
            assert.ok(successLogs.includes('stdout after terminal message'));
            assert.ok(successLogs.includes('stderr after terminal message'));
            assert.match(successLogs, /\[job\] succeeded\n$/);

            const error = await manager.submit('doctor', { project: 'hold-error' }, undefined, 1000);
            await until(() => manager.logs(error.jobId).text.includes('fixture:still-live'));
            assert.equal(manager.get(error.jobId).state, 'running');
            assert.equal((await finished(manager, error.jobId)).state, 'timed_out');
            assert.match(manager.logs(error.jobId).text, /\[job\] timed_out \(TIMEOUT\)\n$/);
            await manager.close();
            const reopened = await env.open();
            assert.equal(reopened.logs(queued.jobId).text, successLogs);
            assert.deepEqual(reopened.logs(result.jobId), stoppedLogs);
        } finally { await manager.close(); }
    });

    await t.test('crashes, empty exits, duplicate results, invalid schemas and oversized reports fail closed', async t => {
        const env = await setup(t);
        const manager = await env.open();
        for (const mode of ['crash', 'empty', 'result-crash', 'duplicate', 'invalid', 'invalid-envelope', 'invalid-error', 'oversized']) {
            const receipt = await manager.submit('doctor', { project: mode });
            const job = await finished(manager, receipt.jobId);
            assert.equal(job.state, 'failed', mode);
            assert.equal(job.error.code, 'PROCESS_FAILED', mode);
            assert.equal(job.report, null, mode);
            assert.ok(!JSON.stringify(job).includes('-secret'), mode);
            assert.match(manager.logs(receipt.jobId).text, /\[job\] failed \(PROCESS_FAILED\)\n$/, mode);
        }
        const receipt = await manager.submit('doctor', { project: 'error' });
        const job = await finished(manager, receipt.jobId);
        assert.equal(job.state, 'failed');
        assert.equal(job.error.code, 'ARTIFACT_INVALID');
        assert.ok(!JSON.stringify(job.error).includes('secret'));
        assert.ok(!job.error.message.includes('\u001b'));
        const boundary = await manager.submit('doctor', { project: 'redaction-boundary' });
        assert.equal((await finished(manager, boundary.jobId)).state, 'succeeded');
    });

    await t.test('stdout/stderr and message logs are redacted, bounded, drained and persisted', async t => {
        const env = await setup(t);
        const manager = await env.open();
        const receipt = await manager.submit('doctor', { project: 'logs' });
        assert.equal((await finished(manager, receipt.jobId)).state, 'succeeded');
        const logs = manager.logs(receipt.jobId);
        assert.equal(logs.truncated, true);
        // The oversized secret-bearing line is discarded; the ordinary 2 MiB
        // output now fits the 8 MiB contract (quota flooding has its own test).
        assert(logs.discardedLogBytes >= 16384 && logs.discardedLogBytes < 32768);
        assert.equal(manager.get(receipt.jobId).discardedLogBytes, logs.discardedLogBytes);
        assert(Buffer.byteLength(logs.text) > 2 * 1024 * 1024 && Buffer.byteLength(logs.text) <= 8 * 1024 * 1024);
        for (const secret of ['split secret', 'bearer-secret', 'url-secret', 'query-secret', 'message-secret', 'private-payload-secret', 'oversized-line-secret', 'ghp_1234567890secret']) {
            assert.ok(!logs.text.includes(secret), secret);
        }
        assert.ok(logs.text.includes('[REDACTED]'));
        assert.match(logs.text, /\[job\] succeeded\n$/);
        logs.text = 'caller mutation';
        await manager.close();
        const reopened = await env.open();
        assert.equal(reopened.logs(receipt.jobId).discardedLogBytes, logs.discardedLogBytes);
        assert.equal(reopened.get(receipt.jobId).discardedLogBytes, logs.discardedLogBytes);
        assert.notEqual(reopened.logs(receipt.jobId).text, 'caller mutation');
        assert.ok((await lstat(join(env.directory, 'metadata.json'))).size < 128 * 1024);
        assert.deepEqual((await readdir(env.directory)).sort(), ['lock', `log-${receipt.jobId}.txt`, 'metadata.json']);
    });

    await t.test('close stops active and queued workers, persists cancellation, and releases ownership', async t => {
        const env = await setup(t);
        const manager = await env.open();
        const active = await manager.submit('doctor', { project: 'hang' });
        const queued = await manager.submit('doctor', { project: 'valid' });
        await until(() => manager.logs(active.jobId).text.includes('fixture:heartbeat'));
        await Promise.all([manager.close(), manager.close()]);
        const before = manager.logs(active.jobId);
        await delay(80);
        assert.deepEqual(manager.logs(active.jobId), before);
        assert.equal(manager.get(active.jobId).state, 'cancelled');
        assert.equal(manager.get(queued.jobId).state, 'cancelled');
        assert.equal(manager.get(queued.jobId).startedAt, null);
        assert.match(manager.logs(queued.jobId).text, /\[job\] cancelled \(CANCELLED\)\n$/);
        await assert.rejects(manager.submit('doctor', {}), code('PROCESS_FAILED'));
        const reopened = await env.open();
        assert.equal(reopened.get(active.jobId).state, 'cancelled');
    });

    await t.test('live cross-process lock is independent of SDK and canonical workspace spelling; worker stdout stays off server stdout', async t => {
        const env = await setup(t);
        const owner = launch(env, 'logs-owner');
        assert.equal((await owner.message).type, 'ready');
        await assert.rejects(env.open({ sdkId: 'sdk-two' }), code('WORKSPACE_BUSY'));
        const alias = join(env.base, 'alias');
        await symlink(env.options.workspace, alias);
        await assert.rejects(env.open({ workspace: alias }), code('WORKSPACE_BUSY'));
        const response = once(owner.child, 'message');
        owner.child.send('close');
        assert.equal((await response)[0].type, 'closed');
        await owner.exited;
        assert.deepEqual(owner.output(), { stdout: '', stderr: '' });
        await env.open({ sdkId: 'sdk-two' });
    });

    await t.test('SIGKILL recovery marks interrupted jobs and concurrent stale recoverers cannot steal a new lock', async t => {
        const env = await setup(t);
        const owner = launch(env, 'staging-owner');
        const ready = await owner.message;
        assert.equal(ready.type, 'ready');
        assert.ok((await readdir(env.directory)).includes(`staging-${ready.jobId}`));
        owner.child.kill('SIGKILL');
        await owner.exited;
        const contenders = Array.from({ length: 4 }, () => launch(env, 'contender'));
        const outcomes = await Promise.all(contenders.map(contender => contender.message));
        assert.equal(outcomes.filter(outcome => outcome.type === 'ready').length, 1, JSON.stringify(outcomes));
        assert.ok(outcomes.filter(outcome => outcome.type !== 'ready').every(outcome => outcome.code === 'WORKSPACE_BUSY'));
        const winner = contenders[outcomes.findIndex(outcome => outcome.type === 'ready')];
        await assert.rejects(env.open(), code('WORKSPACE_BUSY'));
        winner.child.send('close');
        await winner.exited;
        const recovered = await env.open();
        assert.equal(recovered.get(ready.jobId).state, 'interrupted');
        assert.equal(recovered.get(ready.jobId).report, null);
        assert.equal((await recovered.submit('doctor', { project: 'staging-hang' }, 'crash-key')).jobId, ready.jobId);
        assert.ok(!(await readdir(env.directory)).some(name => name.startsWith('staging-')));
        assert.equal((await readdir(env.directory)).filter(name => name.startsWith('.retired-')).length, 1);
    });

    await t.test('opening another SDK neither exposes nor runs old jobs; reopening their SDK safely recovers them', async t => {
        const env = await setup(t);
        const owner = launch(env, 'staging-owner');
        const ready = await owner.message;
        assert.equal(ready.type, 'ready');
        owner.child.kill('SIGKILL');
        await owner.exited;
        const path = join(env.directory, 'metadata.json');
        const metadata = JSON.parse(await readFile(path, 'utf8'));
        // Include a durable queued job to catch accidentally pumping another
        // SDK's queue, in addition to recovering a real killed worker owner.
        const queued = structuredClone(metadata.records[0]);
        queued.job = { ...queued.job, jobId: randomUUID(), state: 'queued', phase: 'queued', startedAt: null };
        queued.requestKeyDigest = null;
        queued.logs = { bytes: 0, generation: 0, truncated: false, discardedBytes: 0 };
        metadata.records.push(queued);
        await writeFile(path, JSON.stringify(metadata));

        const upgraded = await env.open({ sdkId: 'sdk-two' });
        assert.deepEqual(upgraded.list(), []);
        for (const id of [ready.jobId, queued.job.jobId]) {
            assert.throws(() => upgraded.get(id), code('JOB_NOT_FOUND'));
            assert.throws(() => upgraded.logs(id), code('JOB_NOT_FOUND'));
            await assert.rejects(upgraded.cancel(id), code('JOB_NOT_FOUND'));
        }
        await assert.rejects(env.open(), code('WORKSPACE_BUSY'));
        assert.ok(!(await readdir(env.directory)).some(name => name.startsWith('staging-')));
        const ownJob = await upgraded.submit('doctor', { project: 'valid' }, 'crash-key');
        assert.equal((await finished(upgraded, ownJob.jobId)).state, 'succeeded');
        await upgraded.close();
        const afterUpgrade = JSON.parse(await readFile(path, 'utf8'));
        assert.deepEqual(afterUpgrade.records.filter(record => record.sdkId === env.options.sdkId), metadata.records);

        const recovered = await env.open();
        assert.deepEqual(recovered.list().map(job => job.state), ['interrupted', 'interrupted']);
        assert.throws(() => recovered.get(ownJob.jobId), code('JOB_NOT_FOUND'));
        assert.equal((await recovered.submit('doctor', { project: 'staging-hang' }, 'crash-key')).jobId, ready.jobId);
        assert.equal(recovered.logs(queued.job.jobId).text, '\n[job] interrupted (PROCESS_FAILED)\n');
    });

    await t.test('symlink, public, foreign-owned and in-workspace state roots are rejected without chmod or following links', async t => {
        const env = await setup(t);
        await chmod(env.options.stateRoot, 0o755);
        await assert.rejects(env.open(), code('PERMISSION_DENIED'));
        assert.equal((await lstat(env.options.stateRoot)).mode & 0o777, 0o755);
        await chmod(env.options.stateRoot, 0o700);
        const alias = join(env.base, 'state-alias');
        await symlink(env.options.stateRoot, alias);
        await assert.rejects(env.open({ stateRoot: alias }), code('PERMISSION_DENIED'));
        await assert.rejects(env.open({ stateRoot: join(alias, 'nested') }), code('PERMISSION_DENIED'));
        await assert.rejects(env.open({ stateRoot: join(env.options.workspace, 'state') }), code('PERMISSION_DENIED'));
        if (process.getuid() === 0) {
            await chown(env.options.stateRoot, 65534, 65534);
            await assert.rejects(env.open(), code('PERMISSION_DENIED'));
            await chown(env.options.stateRoot, 0, 0);
        } else {
            await assert.rejects(env.open({ stateRoot: '/root' }), code('PERMISSION_DENIED'));
        }
        await mkdir(env.directory, { mode: 0o700 });
        const external = join(env.base, 'external.json');
        await writeFile(external, '{"doNotTouch":true}', { mode: 0o600 });
        await symlink(external, join(env.directory, 'metadata.json'));
        await assert.rejects(env.open(), code('PERMISSION_DENIED'));
        assert.equal(await readFile(external, 'utf8'), '{"doNotTouch":true}');
        assert.ok(!(await readdir(env.directory)).includes('lock'));
    });

    await t.test('invalid/oversized metadata fails closed and initialization releases its lock', async t => {
        const env = await setup(t);
        await mkdir(env.directory, { mode: 0o700 });
        const path = join(env.directory, 'metadata.json');
        await writeFile(path, '{broken', { mode: 0o600 });
        await assert.rejects(env.open(), code('ARTIFACT_INVALID'));
        assert.equal(await readFile(path, 'utf8'), '{broken');
        assert.ok(!(await readdir(env.directory)).includes('lock'));
        await writeFile(path, 'x'.repeat(8 * 1024 * 1024 + 1));
        await assert.rejects(env.open(), code('LIMIT_EXCEEDED'));
        const legacy = JSON.stringify({ version: 1, records: [] });
        await writeFile(path, legacy);
        await assert.rejects(env.open(), code('ARTIFACT_INVALID'));
        assert.equal(await readFile(path, 'utf8'), legacy);
        await rm(path);
        await env.open();
    });

    await t.test('persistence failure cannot publish worker success, stops the manager and cleans up on close', async t => {
        const env = await setup(t);
        const manager = await env.open({}, 'PROCESS_FAILED');
        const receipt = await manager.submit('doctor', { project: 'staging-gated' });
        await until(() => manager.logs(receipt.jobId).text.includes('fixture:staging'));
        const path = join(env.directory, 'metadata.json');
        const saved = join(env.base, 'saved-metadata.json');
        // Let the log flush finish first so the injected failure is specifically
        // the terminal result commit, not an earlier background log write.
        await manager.enqueue(() => manager.persist());
        assert((await readFile(join(env.directory, `log-${receipt.jobId}.txt`), 'utf8')).includes('fixture:staging'));
        await rename(path, saved);
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(env.directory, `staging-${receipt.jobId}`, 'release'), '', { mode: 0o600 });
        const job = await finished(manager, receipt.jobId);
        assert.equal(job.state, 'failed');
        assert.equal(job.error.code, 'PROCESS_FAILED');
        assert.equal(job.report, null);
        assert.match(manager.logs(receipt.jobId).text, /\[job\] failed \(PROCESS_FAILED\)\n$/);
        assert.ok(!manager.logs(receipt.jobId).text.includes('[job] succeeded'));
        await assert.rejects(manager.submit('doctor', {}), code('PROCESS_FAILED'));
        await rm(path, { recursive: true });
        await rename(saved, path);
        await assert.rejects(manager.close(), code('PROCESS_FAILED'));
        assert.deepEqual((await readdir(env.directory)).sort(), [`log-${receipt.jobId}.txt`, 'metadata.json']);
        const reopened = await env.open();
        assert.equal(reopened.get(receipt.jobId).state, 'failed');
    });

    await t.test('private package staging is removed after completion, cancellation and close', async t => {
        const env = await setup(t);
        const manager = await env.open();
        const complete = await manager.submit('package_validate', { directory: 'staging-valid' });
        assert.equal((await finished(manager, complete.jobId)).state, 'succeeded');
        assert.ok(!(await readdir(env.directory)).some(name => name.startsWith('staging-')));
        const cancelled = await manager.submit('doctor', { project: 'staging-hang' });
        await until(() => manager.logs(cancelled.jobId).text.includes('fixture:staging'));
        const external = join(env.base, 'not-job-data');
        await mkdir(external, { mode: 0o700 });
        await writeFile(join(external, 'sentinel'), 'untouched', { mode: 0o600 });
        await symlink(external, join(env.directory, `staging-${cancelled.jobId}`, 'external-link'));
        await manager.cancel(cancelled.jobId);
        assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'untouched');
        assert.ok(!(await readdir(env.directory)).some(name => name.startsWith('staging-')));
        const closing = await manager.submit('doctor', { project: 'staging-hang' });
        await until(() => manager.logs(closing.jobId).text.includes('fixture:staging'));
        await manager.close();
        assert.deepEqual((await readdir(env.directory)).sort(),
            [complete, cancelled, closing].map(receipt => `log-${receipt.jobId}.txt`).concat('metadata.json').sort());
    });

    await t.test('seven-day expiry removes metadata, logs and keys without replay', async t => {
        const env = await setup(t);
        const manager = await env.open();
        const receipt = await manager.submit('doctor', { project: 'valid' }, 'expired-key');
        await finished(manager, receipt.jobId);
        await manager.close();
        const path = join(env.directory, 'metadata.json');
        const metadata = JSON.parse(await readFile(path, 'utf8'));
        const job = metadata.records[0].job;
        for (const field of ['createdAt', 'startedAt', 'finishedAt', 'deadline']) job[field] -= 8 * 24 * 60 * 60 * 1000;
        await writeFile(path, JSON.stringify(metadata));
        const reopened = await env.open();
        assert.deepEqual(reopened.list(), []);
        assert.throws(() => reopened.logs(receipt.jobId), code('JOB_NOT_FOUND'));
        assert.notEqual((await reopened.submit('doctor', { project: 'valid' }, 'expired-key')).jobId, receipt.jobId);
    });

    await t.test('smaller documented record capacity retains keys and rejects invalid arguments', async t => {
        const env = await setup(t);
        const manager = await env.open();
        for (const args of [ ['doctor', { extra: true }], ['unknown', {}], ['package_validate', {}], ['doctor', {}, ''],
            ['doctor', {}, 'x'.repeat(129)], ['doctor', {}, undefined, 0], ['doctor', {}, undefined, 600001],
            ['doctor', {}, undefined, NaN], ['doctor', {}, undefined, 1.5] ]) {
            await assert.rejects(manager.submit(...args), code('INVALID_ARGUMENTS'));
        }
        for (let index = 0; index < 64; index++) {
            const receipt = await manager.submit('doctor', { project: 'hang' }, `capacity-${index}`);
            await manager.cancel(receipt.jobId);
        }
        assert.equal(manager.list().length, 64);
        await assert.rejects(manager.submit('doctor', {}), code('LIMIT_EXCEEDED'));
        assert.equal((await manager.submit('doctor', { project: 'hang' }, 'capacity-0')).jobId, manager.list()[0].jobId);
    });
});
