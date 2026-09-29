import { Application, type Options } from './app.js';
import { AppError, operationError, receiptSchema } from './contracts.js';
import { serve } from './server.js';

const usage = `Cocos4 development tools (Linux; default read-only; not a complete portable release).
Usage:
  node cli.js mcp --sdk-root PATH --workspace PATH --state-root PATH [--mode read-only|develop] [--preview true|false] [--execute-tests true|false]
  node cli.js tools --sdk-root PATH --workspace PATH --state-root PATH
  node cli.js call TOOL --input JSON --sdk-root PATH --workspace PATH --state-root PATH
  node cli.js doctor --sdk-root PATH --workspace PATH --state-root PATH
  node cli.js ai --client opencode --executable ABSOLUTE_PATH --sdk-root PATH --workspace PATH --state-root PATH [--mode read-only|develop] [--preview true|false]
All roots must be absolute and disjoint. Private state is created outside the SDK/workspace.
CLI job calls wait for terminal state and emit all pages as NDJSON in the same session.
MCP calls return receipts; poll with cocos4_job_get. CLI cursors are not reusable across processes.
Develop mode enables SDK project creation, type checks and game builds; --preview true separately enables loopback serving.
--execute-tests true separately authorizes conventional pure logic tests in tests/; requires develop. Also accepted by tools/call/doctor.
Trusted test code is NOT sandboxed: it can access host files, spawn children and use the network. Use OS isolation for untrusted projects.
No arbitrary command/config/npm script selection or automatic downloads/installs. Logic does not execute game_build or an engine/headless renderer.
Logic requires the packaged Linux supervisor and pinned Node typings; no host compiler runs at runtime. Publication requires the packaged Linux publisher helper.
CLI preview calls emit the ready job URL, then stay alive until TTL or SIGINT/SIGTERM; closing the process closes the preview.
AI launches only installed, version-checked OpenCode with private temporary child config and bundled skills.
AI preserves provider auth environment, not stored credentials/config/plugins. Shell tools remain denied in develop mode.
`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
        process.stdout.write(usage); return;
    }
    const command = args.shift();
    if (command === 'ai') { await (await import('./ai.js')).launchAi(args); return; }
    if (!['mcp', 'tools', 'call', 'doctor'].includes(command!)) throw new AppError('INVALID_ARGUMENTS', 'Unknown CLI command.');
    const tool = command === 'call' ? args.shift() : command === 'doctor' ? 'cocos4_doctor' : undefined;
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
        const [name, value] = [args[i], args[i + 1]];
        if (!['--sdk-root', '--workspace', '--state-root', '--mode', '--preview', '--execute-tests', '--input'].includes(name) || flags.has(name)
            || !value || value.length > 32768 || (name === '--input' && command !== 'call')) {
            throw new AppError('INVALID_ARGUMENTS', 'Invalid, duplicate or oversized CLI option.');
        }
        flags.set(name, value);
    }
    if (!['--sdk-root', '--workspace', '--state-root'].every(name => flags.has(name))) {
        throw new AppError('INVALID_ARGUMENTS', 'Explicit --sdk-root, --workspace and --state-root are required.');
    }
    const mode = flags.get('--mode') ?? 'read-only';
    if (!['read-only', 'develop'].includes(mode) || ['--preview', '--execute-tests'].some(name => flags.has(name) && !['true', 'false'].includes(flags.get(name)!))) {
        throw new AppError('PERMISSION_DENIED', 'Invalid startup mode, preview or test-execution permission. Use literal true or false.');
    }
    const options: Options = { sdkRoot: flags.get('--sdk-root')!, workspace: flags.get('--workspace')!,
        stateRoot: flags.get('--state-root')!, mode: mode as Options['mode'], preview: flags.get('--preview') === 'true',
        executeTests: flags.get('--execute-tests') === 'true' };
    let input: unknown = {};
    try { if (flags.has('--input')) input = JSON.parse(flags.get('--input')!); }
    catch { throw new AppError('INVALID_ARGUMENTS', '--input must be a JSON object.'); }
    const app = await Application.open(options);
    // Keep readonly job queries available until the CLI prints the terminal
    // envelope; stopping jobs already closes every worker and preview socket.
    const stop = (): void => { void app.jobs.close().catch(() => { process.exitCode = 1; }); };
    if (command !== 'mcp') { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
    try {
        if (command === 'mcp') {
            await serve(app);
            // EOF also closes stalled transport writes after all owned workers stop.
            process.exit(process.exitCode ?? 0);
        }
        if (command === 'tools') { process.stdout.write(`${JSON.stringify({ tools: app.tools })}\n`); return; }
        if (!tool || !app.hasTool(tool)) throw new AppError('INVALID_ARGUMENTS', 'Unknown tool.');
        let pageTool = tool;
        let pageInput = input;
        let result = await app.call(pageTool, pageInput);
        const receipt = receiptSchema.safeParse(result.structuredContent?.data);
        if (!result.isError && receipt.success) {
            let announced = false;
            for (;;) {
                const job = app.jobs.get(receipt.data.jobId);
                if (job.operation === 'preview_start' && job.phase === 'ready' && !announced) {
                    const ready = await app.call('cocos4_job_get', { jobId: job.jobId });
                    process.stdout.write(`${JSON.stringify(ready.structuredContent)}\n`);
                    announced = true;
                }
                if (['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(job.state)) {
                    pageTool = 'cocos4_job_get';
                    pageInput = { jobId: job.jobId };
                    result = await app.call(pageTool, pageInput);
                    if (job.state !== 'succeeded' || job.report?.items.some(item => item.status === 'failed')) process.exitCode = 1;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        const cursors = new Set<string>();
        for (;;) {
            process.stdout.write(`${JSON.stringify(result.structuredContent)}\n`);
            if (result.isError) { process.exitCode = 1; break; }
            const data = result.structuredContent?.data;
            if (data === null || typeof data !== 'object' || !('nextCursor' in data) || typeof data.nextCursor !== 'string') break;
            if ('hasMore' in data && data.hasMore === false) break;
            if (cursors.has(data.nextCursor) || cursors.size >= 10000) throw new AppError('CURSOR_INVALID', 'Pagination did not make bounded progress.');
            cursors.add(data.nextCursor);
            pageInput = { ...(pageInput as Record<string, unknown>), cursor: data.nextCursor };
            result = await app.call(pageTool, pageInput);
        }
    } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        await app.close();
    }
}

main().catch(error => {
    process.stderr.write(`${JSON.stringify(operationError(error))}\n`);
    process.exitCode = 1;
});
