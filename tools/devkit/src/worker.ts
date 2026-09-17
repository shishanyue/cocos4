import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { operationError, type WorkerRequest } from './contracts.js';
import { runOperation } from './operations.js';

if (!isMainThread && parentPort) {
    const port = parentPort;
    try {
        const report = await runOperation(workerData as WorkerRequest, (text) => port.postMessage({ type: 'log', text }));
        port.postMessage({ type: 'result', report });
    } catch (error) {
        port.postMessage({ type: 'error', error: operationError(error) });
    } finally { port.close(); }
}
