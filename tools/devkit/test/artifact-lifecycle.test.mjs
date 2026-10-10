import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JobManager } from '../build/src/jobs.js';
import { verifyWindowsTrust } from '../build/src/windows-fs.js';
import { privateFixtureTree } from './fixtures/windows-private.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const day = 24 * 60 * 60 * 1000;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const code = expected => error => { assert.equal(error.code, expected, error.stack); return true; };
const input = { project: 'game', target: 'HTML5', profile: '2d-basic', variant: 'debug' };

// Quota admission must fail before attempting publication. This fixed worker
// supplies a candidate receipt, not compiler/runtime or successful-build evidence.
class CandidateManager extends JobManager {
    constructor(options) {
        super(options, new URL(`data:text/javascript,${encodeURIComponent(`
            import { parentPort, workerData } from 'node:worker_threads';
            parentPort.postMessage({ type: 'result', report: {
                profile: { sdkId: workerData.expectedSdkId, target: 'HTML5', id: '2d-basic', variant: 'debug', descriptorSha256: 'b'.repeat(64) },
                summary: 'Quota candidate only', items: [], validationLevels: [], artifacts: [{
                    artifactId: workerData.artifactId, sdkId: workerData.expectedSdkId,
                    target: 'HTML5', profile: '2d-basic', variant: 'debug', entry: 'index.html',
                    bytes: 1, files: 1, sha256: 'a'.repeat(64), validationLevels: [],
                    provenance: { releaseId: workerData.releaseId ?? null, profileSha256: 'b'.repeat(64) },
                }],
            } });
        `)}`));
    }
}

async function fixture(t, { version = 5, age = 0, count = 2 } = {}) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cocos4-artifact-lifecycle-'));
    const options = { workspace: path.join(root, 'workspace'), sdkRoot: path.join(root, 'sdk'),
        sdkId: 'sdk-one', stateRoot: path.join(root, 'state'), permissions: { mode: 'develop', preview: true, executeTests: false } };
    for (const directory of [options.workspace, options.sdkRoot, options.stateRoot]) await fs.mkdir(directory, { mode: 0o700 });
    const directory = path.join(options.stateRoot, hash(options.workspace));
    await fs.mkdir(directory, { mode: 0o700 });
    const metadataFile = path.join(directory, 'metadata.json');
    const metadata = { version, records: [] };
    const artifacts = [];
    for (let index = 0; index < count; index++) {
        const artifactId = randomUUID();
        const target = index % 2 ? 'BILIBILI' : 'HTML5';
        const sdkId = index % 2 ? 'sdk-two' : options.sdkId;
        const entry = target === 'HTML5' ? 'index.html' : 'game.js';
        const identity = { artifactId, sdkId, target, entry, profile: '2d-basic', variant: 'debug', validationLevels: ['fixture-only'] };
        if (version === 5) identity.provenance = { releaseId: null, profileSha256: 'b'.repeat(64) };
        const payload = Buffer.from(`/* preserved artifact ${index} */`);
        const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, ...identity,
            files: [{ path: entry, bytes: payload.length, sha256: hash(payload) }] }));
        const artifact = { ...identity, bytes: payload.length, files: 1, sha256: hash(raw) };
        const output = path.join(directory, `artifact-${artifactId}`);
        await fs.mkdir(output, { mode: 0o700 });
        await fs.writeFile(path.join(output, entry), payload, { mode: 0o400 });
        await fs.writeFile(path.join(output, 'artifact-inventory.json'), raw, { mode: 0o400 });
        const logs = 'retained build log\n';
        const createdAt = Date.now() - age - 1000;
        metadata.records.push({ sdkId, executesLogic: false, requestKeyDigest: hash(JSON.stringify([sdkId, `build-${index}`])),
            job: { jobId: artifactId, operation: 'game_build', project: 'game',
                inputDigest: hash(JSON.stringify({ sdkId, sdkRoot: options.sdkRoot, operation: 'game_build', input: { ...input, target }, timeoutMs: 60000 })),
                state: 'succeeded', phase: 'succeeded', createdAt, startedAt: createdAt + 100, finishedAt: createdAt + 200,
                deadline: createdAt + 60000, error: null, report: { summary: 'Persisted build fixture', items: [], validationLevels: [], artifacts: [artifact],
                    ...(version === 5 ? { profile: { sdkId, target, id: '2d-basic', variant: 'debug', descriptorSha256: 'b'.repeat(64) } } : {}) } },
            logs: version === 2 ? { text: logs, truncated: false } : { bytes: Buffer.byteLength(logs), generation: 0, truncated: false, discardedBytes: 0 } });
        if (version === 2) delete metadata.records.at(-1).executesLogic;
        else await fs.writeFile(path.join(directory, `log-${artifactId}.txt`), logs, { mode: 0o600 });
        artifacts.push({ artifact, output, payload, raw });
    }
    if (version >= 4) metadata.artifacts = structuredClone(metadata.records.flatMap(record => record.job.report.artifacts));
    const save = () => fs.writeFile(metadataFile, JSON.stringify(metadata), { mode: 0o600 });
    await save();
    await privateFixtureTree(root);
    const managers = [];
    t.after(async () => {
        for (const manager of managers.reverse()) await manager.close();
        await privateFixtureTree(root, { preserveReadonly: false });
        await fs.rm(root, { recursive: true, force: true });
    });
    return { options, directory, metadataFile, metadata, artifacts, save,
        async open(sdkId = options.sdkId, Manager = JobManager) {
            const manager = await Manager.open({ ...options, sdkId });
            managers.push(manager);
            return manager;
        } };
}

async function until(predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(10); }
    assert.fail('Artifact lifecycle did not reach the expected state.');
}
async function preview(manager, artifactId, key) {
    const receipt = await manager.submit('preview_start', { artifactId, ttlSeconds: 60 }, key, 120000);
    return until(() => {
        const job = manager.get(receipt.jobId);
        assert(!terminal.has(job.state), JSON.stringify(job));
        return job.phase === 'ready' && job;
    });
}
async function served(job, payload) {
    await new Promise((resolve, reject) => {
        const request = http.get(job.preview.url, { agent: false }, response => {
            const chunks = [];
            response.on('data', bytes => chunks.push(bytes));
            response.on('error', reject);
            response.on('end', () => {
                try { assert.equal(response.statusCode, 200); assert.deepEqual(Buffer.concat(chunks), payload); resolve(); }
                catch (error) { reject(error); }
            });
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('Preview request timed out.')));
    });
}
async function preserved(env) {
    for (const { artifact, output, payload, raw } of env.artifacts) {
        assert.deepEqual(await fs.readFile(path.join(output, artifact.entry)), payload);
        assert.deepEqual(await fs.readFile(path.join(output, 'artifact-inventory.json')), raw);
        const filename = path.join(output, artifact.entry);
        if (process.platform === 'win32') {
            await verifyWindowsTrust(filename, true);
            assert.equal((await fs.stat(filename)).mode & 0o222, 0);
        } else assert.equal((await fs.stat(filename)).mode & 0o777, 0o400);
    }
}

test('expired v2/v3/v4/v5 build jobs lose logs and keys, not published artifacts or SDK-scoped preview access', async t => {
    for (const version of [2, 3, 4, 5]) await t.test(`metadata v${version}`, async t => {
        const env = await fixture(t, { version, age: 8 * day });
        let manager = await env.open();
        await preserved(env);
        assert.deepEqual(manager.list(), []);
        const metadata = JSON.parse(await fs.readFile(env.metadataFile, 'utf8'));
        assert.equal(metadata.version, 5);
        assert.deepEqual(metadata.artifacts, env.artifacts.map(item => item.artifact));
        for (const artifact of metadata.artifacts) assert.deepEqual(artifact.provenance,
            version === 5 ? { releaseId: null, profileSha256: 'b'.repeat(64) } : undefined, 'Legacy provenance must not be invented.');
        for (const { artifact } of env.artifacts) {
            assert.throws(() => manager.logs(artifact.artifactId), code('JOB_NOT_FOUND'));
            await assert.rejects(fs.stat(path.join(env.directory, `log-${artifact.artifactId}.txt`)), { code: 'ENOENT' });
        }
        const own = env.artifacts[0];
        assert.deepEqual(manager.artifact(own.artifact.artifactId), own.artifact);
        manager.artifact(own.artifact.artifactId).sha256 = '0'.repeat(64);
        assert.deepEqual(manager.artifact(own.artifact.artifactId), own.artifact);
        await manager.close();
        const foreign = await env.open('sdk-two');
        assert.throws(() => foreign.artifact(own.artifact.artifactId), code('ARTIFACT_INVALID'));
        assert.deepEqual(foreign.artifact(env.artifacts[1].artifact.artifactId), env.artifacts[1].artifact);
        await assert.rejects(foreign.submit('preview_start', { artifactId: env.artifacts[1].artifact.artifactId }, 'bilibili-preview'), code('UNSUPPORTED_PROJECT'));
        await foreign.close();
        manager = await env.open();
        const viewing = await preview(manager, own.artifact.artifactId, 'after-expiry');
        await served(viewing, own.payload);
        await manager.cancel(viewing.jobId);
        const retry = await manager.submit('game_build', input, 'build-0');
        assert.notEqual(retry.jobId, own.artifact.artifactId, 'Expired keys must admit a new job, not pin the old build forever.');
        const failed = await until(() => { const job = manager.get(retry.jobId); return terminal.has(job.state) && job; });
        assert.equal(failed.state, 'failed', 'The fixture has no compiler SDK; the new build must not succeed.');
        await preserved(env);
    });
});

test('live retention expires build metadata even during preview without modifying its immutable payload', async t => {
    const env = await fixture(t);
    const manager = await env.open();
    const own = env.artifacts[0];
    assert.equal((await manager.submit('game_build', input, 'build-0')).jobId, own.artifact.artifactId);
    const viewing = await preview(manager, own.artifact.artifactId, 'live-preview');
    await served(viewing, own.payload);
    for (const { artifact } of env.artifacts) {
        const record = manager.records.get(artifact.artifactId);
        const job = { ...record.job };
        for (const field of ['createdAt', 'startedAt', 'finishedAt', 'deadline']) job[field] -= 8 * day;
        manager.records.set(artifact.artifactId, { ...record, job });
    }
    await manager.enqueue(() => manager.persist(manager.retained()));
    assert.throws(() => manager.get(own.artifact.artifactId), code('JOB_NOT_FOUND'));
    assert.throws(() => manager.logs(own.artifact.artifactId), code('JOB_NOT_FOUND'));
    await preserved(env);
    await served(viewing, own.payload);
    await manager.cancel(viewing.jobId);
    await manager.close();
    const reopened = await env.open();
    await served(await preview(reopened, own.artifact.artifactId, 'reopened-preview'), own.payload);
});

test('crash recovery preserves unregistered published output, removes failed staging and never auto-adopts the output', async t => {
    const env = await fixture(t, { count: 1 });
    const orphanId = randomUUID();
    const orphan = path.join(env.directory, `artifact-${orphanId}`);
    await fs.mkdir(orphan, { mode: 0o700 });
    await fs.writeFile(path.join(orphan, 'keep'), 'already published', { mode: 0o400 });
    await privateFixtureTree(orphan);
    const record = structuredClone(env.metadata.records[0]);
    record.requestKeyDigest = null;
    Object.assign(record.job, { jobId: orphanId, state: 'running', phase: 'committing', report: null, finishedAt: null });
    record.logs = { bytes: 0, generation: 0, truncated: false, discardedBytes: 0 };
    env.metadata.records.push(record);
    await env.save();
    const staging = path.join(env.directory, `staging-${orphanId}`);
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.writeFile(path.join(staging, 'partial'), 'discardable staging', { mode: 0o600 });
    await privateFixtureTree(staging);
    const manager = await env.open(env.options.sdkId, CandidateManager);
    assert.equal(manager.get(orphanId).state, 'interrupted');
    assert.equal(await fs.readFile(path.join(orphan, 'keep'), 'utf8'), 'already published');
    await assert.rejects(fs.stat(staging), { code: 'ENOENT' });
    assert.throws(() => manager.artifact(orphanId), code('ARTIFACT_INVALID'));
    const receipt = await manager.submit('game_build', input, 'ambiguous-quota');
    const failed = await until(() => { const job = manager.get(receipt.jobId); return terminal.has(job.state) && job; });
    assert.equal(failed.error.code, 'ARTIFACT_INVALID');
    assert.match(failed.error.message, /unregistered/i);
    await manager.close();
    const reopened = await env.open();
    assert.throws(() => reopened.artifact(orphanId), code('ARTIFACT_INVALID'));
    assert.equal(await fs.readFile(path.join(orphan, 'keep'), 'utf8'), 'already published');
    await preserved(env);
});

test('artifact byte and count quotas still include successful outputs whose jobs expired, across SDKs', async t => {
    for (const limit of ['bytes', 'count']) await t.test(limit, async t => {
        const env = await fixture(t, { count: limit === 'bytes' ? 4 : 64, age: 8 * day });
        // Persisted receipts are the quota input; no large payload or compiler is needed.
        if (limit === 'bytes') {
            for (const record of env.metadata.records) record.job.report.artifacts[0].bytes = 128 * 1024 * 1024;
            for (const artifact of env.metadata.artifacts) artifact.bytes = 128 * 1024 * 1024;
            await env.save();
        }
        const manager = await env.open(env.options.sdkId, CandidateManager);
        const receipt = await manager.submit('game_build', input, 'over-quota');
        const failed = await until(() => { const job = manager.get(receipt.jobId); return terminal.has(job.state) && job; });
        assert.equal(failed.state, 'failed');
        assert.equal(failed.error.code, 'LIMIT_EXCEEDED');
        assert.equal(failed.report, null);
        await preserved(env);
        assert.equal((await fs.readdir(env.directory)).filter(name => name.startsWith('artifact-')).length, env.artifacts.length);
    });
});

test('moving output frees its quota without resurrecting ownership from retained jobs or later directories', async t => {
    const env = await fixture(t, { count: 4 });
    for (const record of env.metadata.records) record.job.report.artifacts[0].bytes = 128 * 1024 * 1024;
    for (const artifact of env.metadata.artifacts) artifact.bytes = 128 * 1024 * 1024;
    await env.save();
    let manager = await env.open(env.options.sdkId, CandidateManager);
    async function attempt(key) {
        const receipt = await manager.submit('game_build', input, key);
        return until(() => { const job = manager.get(receipt.jobId); return terminal.has(job.state) && job; });
    }
    assert.equal((await attempt('full-quota')).error.code, 'LIMIT_EXCEEDED');
    const own = env.artifacts[0];
    const original = own.output;
    own.output = path.join(path.dirname(env.options.workspace), 'exported-artifact');
    await fs.rename(original, own.output);
    const failed = await attempt('freed-quota');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error.code, 'INPUT_CHANGED', 'The quota candidate has no staging and must fail actual publication.');
    assert.equal(failed.report, null);
    assert.throws(() => manager.artifact(own.artifact.artifactId), code('ARTIFACT_INVALID'));
    assert.equal(manager.get(own.artifact.artifactId).state, 'succeeded', 'Historical reports are independent of retained output.');
    assert.deepEqual(JSON.parse(await fs.readFile(env.metadataFile, 'utf8')).artifacts.map(artifact => artifact.artifactId),
        env.artifacts.slice(1).map(item => item.artifact.artifactId));
    await preserved(env);
    await manager.close();
    manager = await env.open(env.options.sdkId, CandidateManager);
    assert.throws(() => manager.artifact(own.artifact.artifactId), code('ARTIFACT_INVALID'));
    await fs.rename(own.output, original);
    own.output = original;
    const unregistered = await attempt('do-not-adopt');
    assert.equal(unregistered.error.code, 'ARTIFACT_INVALID');
    assert.match(unregistered.error.message, /unregistered/i);
    await preserved(env);
});

test('malformed ownership and producing release/profile cannot be silently migrated, overwritten or exposed', async t => {
    const changes = {
        'missing registry': metadata => { delete metadata.artifacts; },
        'duplicate ID': metadata => { metadata.artifacts.push(structuredClone(metadata.artifacts[0])); },
        'different SDK': metadata => { metadata.artifacts[0].sdkId = 'another-sdk'; },
        'different inventory': metadata => { metadata.artifacts[0].sha256 = '0'.repeat(64); },
        'oversized receipt': metadata => { metadata.artifacts[0].bytes = 128 * 1024 * 1024 + 1; },
        'excess file count': metadata => { metadata.artifacts[0].files = 10001; },
        'path instead of ID': metadata => { metadata.artifacts[0].artifactId = '../outside'; },
        'unexpected field': metadata => { metadata.artifacts[0].directory = '/outside'; },
        'different producing release': metadata => { metadata.artifacts[0].provenance.releaseId = `sha256-${'c'.repeat(64)}`; },
        'different producing profile': metadata => { metadata.records[0].job.report.profile.descriptorSha256 = 'c'.repeat(64); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const env = await fixture(t);
        change(env.metadata);
        await env.save();
        const raw = await fs.readFile(env.metadataFile);
        await assert.rejects(env.open(), code('ARTIFACT_INVALID'));
        assert.deepEqual(await fs.readFile(env.metadataFile), raw);
        await assert.rejects(fs.stat(path.join(env.directory, 'lock')), { code: 'ENOENT' });
        await preserved(env);
    });
});
