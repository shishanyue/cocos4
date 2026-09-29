// Polling contracts only: no SDK, candidate, browser or game build is started.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForJob } from '../scripts/verify-portable.mjs';

function start(t, pages, preview = false) {
    let now = pages[0].at, index = 0;
    t.mock.method(Date, 'now', () => now);
    const receipt = { jobId: 'fixture-job' };
    const report = { releaseId: 'fixture-release', jobs: [] };
    const result = waitForJob(async (name, args) => {
        assert.equal(name, 'job_get');
        assert.deepEqual(args, { jobId: receipt.jobId, limit: 100 });
        const page = pages[index++];
        assert(page, 'Unexpected extra poll');
        now = page.at;
        return { job: { jobId: receipt.jobId, releaseId: report.releaseId, deadline: 600000, ...page.job },
            report: { items: page.items ?? [] } };
    }, receipt, report, preview);
    return { result, report };
}

test('portable polling follows the job deadline instead of abandoning a build after four minutes', async t => {
    const { result, report } = start(t, [
        { at: 0, job: { state: 'running' } },
        { at: 240001, job: { state: 'running' } },
        { at: 300000, job: { state: 'succeeded' } },
    ]);
    assert.equal((await result).job.state, 'succeeded');
    assert.equal(report.jobs.length, 1);
});

test('deadline cleanup retains the actual terminal failure rather than hiding it behind a polling timeout', async t => {
    const { result, report } = start(t, [
        { at: 590000, job: { state: 'running' } },
        { at: 600001, job: { state: 'cancelling' } },
        { at: 620000, job: { state: 'timed_out' } },
    ]);
    await assert.rejects(result, { code: 'ERR_ASSERTION' });
    assert.equal(report.jobs.length, 1);
    assert.equal(report.jobs[0].job.state, 'timed_out');
});

test('an unterminated job cannot outlive its deadline and bounded cleanup grace', async t => {
    const { result, report } = start(t, [
        { at: 590000, job: { state: 'running' } },
        { at: 630000, job: { state: 'cancelling' } },
    ]);
    await assert.rejects(result, /Job deadline: fixture-job/);
    assert.deepEqual(report.jobs, []);
});

test('status updates cannot silently extend the original job deadline', async t => {
    const { result } = start(t, [
        { at: 0, job: { state: 'running' } },
        { at: 100, job: { state: 'running', deadline: 700000 } },
    ]);
    await assert.rejects(result, /Job deadline changed/);
});

test('polling still rejects a foreign release and failed validation items', async t => {
    const foreign = start(t, [{ at: 0, job: { state: 'succeeded', releaseId: 'another-release' } }]);
    await assert.rejects(foreign.result, /Job must identify the executing release/);
    assert.deepEqual(foreign.report.jobs, []);
    const failed = start(t, [{ at: 0, job: { state: 'succeeded' }, items: [{ status: 'failed' }] }]);
    await assert.rejects(failed.result, { code: 'ERR_ASSERTION' });
    assert.equal(failed.report.jobs.length, 1);
});

test('preview readiness returns without claiming a terminal job success', async t => {
    const { result, report } = start(t, [{ at: 0, job: { state: 'running', phase: 'ready' } }], true);
    assert.equal((await result).job.state, 'running');
    assert.deepEqual(report.jobs, []);
});
