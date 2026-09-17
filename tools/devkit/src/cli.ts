import { Application, type Options } from './app.js';
import { AppError, operationError, receiptSchema } from './contracts.js';
import { serve } from './server.js';

const usage = `Readonly Cocos4 development tools (Linux; not a portable game SDK).
Usage:
  node cli.js mcp --sdk-root PATH --workspace PATH --state-root PATH [--mode read-only]
  node cli.js tools --sdk-root PATH --workspace PATH --state-root PATH
  node cli.js call TOOL --input JSON --sdk-root PATH --workspace PATH --state-root PATH
  node cli.js doctor --sdk-root PATH --workspace PATH --state-root PATH
All roots must be absolute and disjoint. Private state is created outside the SDK/workspace.
CLI job calls wait for terminal state and emit all pages as NDJSON in the same session.
MCP calls return receipts; poll with cocos4_job_get. CLI cursors are not reusable across processes.
No arbitrary commands, project scripts, downloads, build or preview tools are enabled.
`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
        process.stdout.write(usage); return;
    }
    const command = args.shift();
    if (!['mcp', 'tools', 'call', 'doctor'].includes(command!)) throw new AppError('INVALID_ARGUMENTS', 'Unknown CLI command.');
    const tool = command === 'call' ? args.shift() : command === 'doctor' ? 'cocos4_doctor' : undefined;
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
        const [name, value] = [args[i], args[i + 1]];
        if (!['--sdk-root', '--workspace', '--state-root', '--mode', '--input'].includes(name) || flags.has(name)
            || !value || value.length > 32768 || (name === '--input' && command !== 'call')) {
            throw new AppError('INVALID_ARGUMENTS', 'Invalid, duplicate or oversized CLI option.');
        }
        flags.set(name, value);
    }
    if (!['--sdk-root', '--workspace', '--state-root'].every(name => flags.has(name))) {
        throw new AppError('INVALID_ARGUMENTS', 'Explicit --sdk-root, --workspace and --state-root are required.');
    }
    if (flags.has('--mode') && flags.get('--mode') !== 'read-only') throw new AppError('PERMISSION_DENIED', 'Only read-only mode is implemented.');
    const options: Options = { sdkRoot: flags.get('--sdk-root')!, workspace: flags.get('--workspace')!,
        stateRoot: flags.get('--state-root')!, mode: 'read-only' };
    let input: unknown = {};
    try { if (flags.has('--input')) input = JSON.parse(flags.get('--input')!); }
    catch { throw new AppError('INVALID_ARGUMENTS', '--input must be a JSON object.'); }
    const app = await Application.open(options);
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
            for (;;) {
                const job = app.jobs.get(receipt.data.jobId);
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
    } finally { await app.close(); }
}

main().catch(error => {
    process.stderr.write(`${JSON.stringify(operationError(error))}\n`);
    process.exitCode = 1;
});
