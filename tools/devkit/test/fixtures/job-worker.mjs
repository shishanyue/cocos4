import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Tool-owned test code only. No project modules, scripts or subprocesses run in
// a worker. The main-thread branch is a disposable cross-process lock owner.
if (isMainThread) {
    const { JobManager } = await import('../../build/src/jobs.js');
    class FixtureManager extends JobManager {
        constructor(options) { super(options, new URL(import.meta.url)); }
    }
    try {
        const manager = await FixtureManager.open(JSON.parse(process.argv[3]));
        const mode = process.argv[2];
        const project = mode === 'logs-owner' ? 'logs' : mode === 'staging-owner' ? 'staging-hang' : 'hang';
        const receipt = mode !== 'contender' ? await manager.submit('doctor', { project }, 'crash-key') : null;
        if (mode === 'logs-owner' || mode === 'staging-owner') {
            while (mode === 'logs-owner' ? manager.get(receipt.jobId).state === 'running'
                : !manager.logs(receipt.jobId).text.includes('fixture:staging')) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        }
        process.send({ type: 'ready', jobId: receipt?.jobId });
        process.on('message', async (message) => {
            if (message !== 'close') return;
            try { await manager.close(); process.send({ type: 'closed' }); }
            catch { process.send({ type: 'close-error' }); }
            process.disconnect();
        });
    } catch (error) {
        process.send({ type: 'error', code: error.code });
        process.disconnect();
    }
} else {
    const mode = workerData.input.project ?? workerData.input.directory;
    const report = { summary: 'Readonly fixture completed', validationLevels: ['fixture-only'], items: [
        { name: workerData.operation, status: 'info', message: JSON.stringify({
            workspace: workerData.workspace, sdkRoot: workerData.sdkRoot, staging: workerData.staging,
            input: workerData.input, execArgv: process.execArgv, environment: Object.keys(process.env),
        }) },
    ] };
    const done = () => parentPort.postMessage({ type: 'result', report });
    parentPort.postMessage({ type: 'log', text: 'fixture:start\n' });
    if (mode?.startsWith('staging-')) {
        await mkdir(workerData.staging, { mode: 0o700 });
        await mkdir(join(workerData.staging, 'snapshot'), { mode: 0o700 });
        await writeFile(join(workerData.staging, 'snapshot', 'data.json'), '{}', { mode: 0o600 });
        parentPort.postMessage({ type: 'log', text: 'fixture:staging\n' });
    }
    switch (mode) {
    case 'hang':
    case 'staging-hang':
        setInterval(() => parentPort.postMessage({ type: 'log', text: 'fixture:heartbeat\n' }), 20);
        break;
    case 'spin':
        while (true) { /* Deliberately block this worker, not the server. */ }
    case 'slow':
    case 'staging-slow':
        setTimeout(done, 250);
        break;
    case 'staging-gated': {
        const timer = setInterval(async () => {
            try { await readFile(join(workerData.staging, 'release')); } catch { return; }
            clearInterval(timer);
            done();
        }, 10);
        break;
    }
    case 'race':
        setTimeout(done, 5);
        break;
    case 'crash':
        throw new Error('password=worker-crash-secret');
    case 'empty':
        break;
    case 'exit-code':
        process.exit(7);
    case 'result-crash':
        done();
        throw new Error('token=post-result-secret');
    case 'duplicate':
        done(); done();
        break;
    case 'invalid':
        parentPort.postMessage({ type: 'result', report: { summary: 'missing required fields' } });
        break;
    case 'invalid-envelope':
        parentPort.postMessage({ type: 'result', report, unexpected: 'token=extra-secret' });
        break;
    case 'invalid-error':
        parentPort.postMessage({ type: 'error', error: { code: 'invented', message: 'password=error-secret' } });
        break;
    case 'oversized':
        report.items = Array.from({ length: 100 }, () => ({ name: 'large', status: 'info', message: 'x'.repeat(1000) }));
        done();
        break;
    case 'error':
        parentPort.postMessage({ type: 'error', error: { code: 'ARTIFACT_INVALID', retryable: false,
            message: 'password="error secret" Authorization: Bearer bearer-secret\u001b[31m',
            nextSteps: ['https://username:url-secret@example.test/?api_key=query-secret'] } });
        break;
    case 'redaction-boundary':
        report.summary = 'x'.repeat(2041) + 'token=x';
        report.items[0].name = 'y'.repeat(1017) + 'token=x';
        done();
        break;
    case 'logs':
        process.stdout.write('pass');
        await new Promise(resolve => setTimeout(resolve, 10));
        process.stdout.write('word="split secret"\nAuthorization: Bearer bearer-secret\n');
        process.stderr.write('https://user:url-secret@example.test/?api_key=query-secret\n');
        parentPort.postMessage({ type: 'log', text: 'client_secret=message-secret\n' });
        parentPort.postMessage({ type: 'log', text: '-----BEGIN PRIVATE KEY-----\n' });
        parentPort.postMessage({ type: 'log', text: 'private-payload-secret\n' });
        parentPort.postMessage({ type: 'log', text: '-----END PRIVATE KEY-----\n' });
        process.stdout.write('oversized-line-secret'.repeat(1000) + '\n');
        process.stdout.write('ghp_1234567890secret\n');
        for (let index = 0; index < 1024; index++) {
            process.stdout.write(`stdout ${'x'.repeat(1016)}\n`);
            process.stderr.write(`stderr ${'y'.repeat(1016)}\n`);
        }
        done();
        break;
    default:
        done();
    }
}
