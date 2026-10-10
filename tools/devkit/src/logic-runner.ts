import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { run } from 'node:test';
import type { TestEvent } from 'node:test/reporters';
import { logicResultSchema, type LogicResult } from './contracts.js';
import { logicPlanSchema } from './logic.js';

// This fixed adapter consumes node:test's structured events. Project tests run
// in Node's test children; they cannot forge this adapter's result via stdout.
// It is still trusted code, not an OS sandbox or a network permission boundary.
async function main(): Promise<void> {
    if (!process.send || process.argv.length !== 3) throw new Error('Expected a supervised logic runner.');
    const directory = process.argv[2];
    const raw = await readFile(path.join(directory, 'plan.json'));
    if (raw.length > 256 * 1024) throw new Error('Oversized logic plan.');
    const plan = logicPlanSchema.parse(JSON.parse(raw.toString('utf8')));
    if (new Set(plan.files).size !== plan.files.length || plan.files.some(file => !file.startsWith('tests/')
        || !file.endsWith('.cjs') || /[\\:\0]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Unsafe logic plan.');
    const result: LogicResult = { summary: { runner: 'node:test', files: plan.files.length, passed: 0, failed: 0,
        skipped: 0, todo: 0, durationMs: 0, omitted: 0 }, items: [] };
    const started = performance.now();
    const tests = run({ files: plan.files.map(file => path.join(directory, file)), concurrency: 1 });
    let bytes = 0;
    // Node 18 declares TestsStream as a byte stream despite its documented
    // object-mode TestEvent iterator; keep the official event union here.
    for await (const { type, data } of tests as unknown as AsyncIterable<TestEvent>) {
        if (type === 'test:stdout' || type === 'test:stderr') {
            const stream = type === 'test:stdout' ? process.stdout : process.stderr;
            if (!stream.write(data.message)) await once(stream, 'drain');
            continue;
        }
        if (type !== 'test:pass' && type !== 'test:fail') continue;
        // node:test allows an empty reason string for both directives. Their
        // presence still marks a skipped/TODO test, even when it is falsy.
        const skipped = data.skip !== undefined && data.skip !== false;
        const todo = data.todo !== undefined && data.todo !== false;
        const failed = type === 'test:fail' && !skipped && !todo;
        if (skipped) result.summary.skipped++;
        else if (todo) result.summary.todo++;
        else if (failed) result.summary.failed++;
        else result.summary.passed++;
        const file = typeof data.file === 'string' ? path.relative(directory, data.file).split(path.sep).join('/') : undefined;
        const item: LogicResult['items'][number] = { name: String(data.name).slice(0, 256),
            status: failed ? 'failed' : skipped || todo ? 'warning' : 'passed', code: failed ? 'TEST_FAILED' : 'LOGIC_TEST',
            message: (failed && type === 'test:fail' ? String(data.details.error?.message ?? 'node:test reported a failure.')
                : skipped ? 'Skipped by the trusted test.' : todo ? 'Marked TODO by the trusted test.' : 'node:test result passed.').slice(0, 512),
            ...(file && !file.startsWith('../') && !path.isAbsolute(file) ? { file: file.slice(0, 512),
                ...(typeof data.line === 'number' && Number.isInteger(data.line) && data.line > 0 ? { line: data.line } : {}),
                ...(typeof data.column === 'number' && Number.isInteger(data.column) && data.column > 0 ? { column: data.column } : {}) } : {}) };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (result.items.length < 24 && bytes + size < 16 * 1024) { result.items.push(item); bytes += size; }
        else result.summary.omitted++;
        const line = `[node:test] ${item.status}: ${item.name}${failed ? ': ' + item.message : ''}\n`;
        if (!process.stdout.write(line)) await once(process.stdout, 'drain');
    }
    result.summary.durationMs = Math.max(0, performance.now() - started);
    if (!result.summary.passed && !result.summary.failed && !result.summary.skipped && !result.summary.todo) throw new Error('node:test returned no results.');
    await new Promise<void>((resolve, reject) => process.send!({ type: 'logic_result', result: logicResultSchema.parse(result) }, (error: Error | null) => error ? reject(error) : resolve()));
    process.exitCode = result.summary.failed ? 1 : 0;
    process.disconnect();
}
main().catch(() => {
    process.stderr.write('Logic runner infrastructure failed; no success result was recorded.\n');
    process.exitCode = 2;
    if (process.connected) process.disconnect();
});
