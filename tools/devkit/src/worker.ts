import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { AppError, authorize, logicExecutionSchema, operationError, parseWorkerRequest, permissionsSchema, reportSchema, type LogicExecution } from './contracts.js';
import { runOperation } from './operations.js';
import { startPreview } from './preview.js';

if (!isMainThread && parentPort) {
    const port = parentPort;
    try {
        const request = parseWorkerRequest(workerData);
        authorize(request, permissionsSchema.parse(request.permissions ?? {}));
        let report;
        if (request.operation === 'preview_start') {
            if (!request.artifactsRoot || !request.artifact || request.artifact.artifactId !== request.input.artifactId
                || request.artifact.sdkId !== request.expectedSdkId) throw new AppError('ARTIFACT_INVALID', 'Preview requires an owned build receipt.');
            const preview = await startPreview({ artifactDirectory: path.join(request.artifactsRoot, `artifact-${request.artifact.artifactId}`),
                artifact: request.artifact, ttlSeconds: request.input.ttlSeconds });
            port.postMessage({ type: 'ready', preview: preview.preview });
            await preview.closed;
            report = reportSchema.parse({ summary: 'Loopback preview closed. Serving an artifact does not establish browser rendering or vendor-device validation.',
                validationLevels: ['artifactIntegrity', 'loopbackServing'], items: [] });
        } else report = await runOperation(request, (text) => port.postMessage({ type: 'log', text }), () => new Promise<LogicExecution>((resolve, reject) => {
            // Fixed workers never run project code. Only the parent can admit a
            // runner, record its identity durably, and supervise its whole tree.
            port.once('message', (message: unknown) => {
                const parsed = logicExecutionSchema.safeParse(message);
                if (parsed.success) resolve(parsed.data);
                else reject(new AppError('PROCESS_FAILED', 'Invalid supervised logic result.'));
            });
            port.postMessage({ type: 'execute_logic' });
        }));
        port.postMessage({ type: 'result', report });
    } catch (error) {
        port.postMessage({ type: 'error', error: operationError(error), ...(error instanceof AppError && error.report ? { report: reportSchema.parse(error.report) } : {}) });
    } finally { port.close(); }
}
