import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const cli = path.join(root, 'build/src/cli.js');
export const sdkRoot = path.resolve(process.env.LOGIC_TEST_SDK_ROOT ?? path.join(root, 'build/game-sdk'));
export const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function until(predicate, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(20); }
    assert.fail('Timed out waiting for observed state.');
}
export async function fixture(t, label = 'logic') {
    const directory = await fs.mkdtemp(path.join(process.env.LOGIC_EVIDENCE_ROOT ?? path.join(root, 'build'), `${label}-`));
    const env = { directory, workspace: path.join(directory, 'workspace'), stateRoot: path.join(directory, 'state'), cleanup: [] };
    await fs.mkdir(env.workspace, { mode: 0o700 });
    env.stateDirectory = path.join(env.stateRoot, hash(env.workspace));
    t.after(async () => { for (const close of env.cleanup.reverse()) await close(); });
    return env;
}
export async function connect(env, executeTests = true) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--sdk-root', sdkRoot,
        '--workspace', env.workspace, '--state-root', env.stateRoot, '--mode', 'develop', '--execute-tests', String(executeTests)],
    env: { PATH: '', NODE_OPTIONS: '', NODE_PATH: '', LANG: 'C.UTF-8' }, cwd: env.workspace, stderr: 'pipe' });
    const validator = new AjvJsonSchemaValidator();
    const client = new Client({ name: 'cocos4-logic-lifetime-regression', version: '1.0.0' }, { jsonSchemaValidator: validator });
    const errors = [];
    let stderr = '', closed;
    client.onerror = error => errors.push(error);
    transport.stderr.on('data', bytes => { stderr += bytes; });
    await client.connect(transport, { timeout: 60000 });
    const child = transport._process;
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const { tools } = await client.listTools();
    const schemas = new Map(tools.map(tool => [tool.name, validator.getValidator(tool.outputSchema)]));
    const close = async (signal = 'EOF') => {
        if (closed) return closed;
        closed = (async () => {
            if (child.exitCode === null && child.signalCode === null) signal === 'EOF' ? child.stdin.end() : child.kill(signal);
            const result = await Promise.race([exited, delay(12000).then(() => { child.kill('SIGKILL'); throw new Error('Server shutdown exceeded 12s.'); })]);
            if (signal !== 'SIGKILL') { assert.deepEqual(result, { code: 0, signal: null }, stderr); assert.equal(stderr, ''); }
            await client.close();
        })();
        return closed;
    };
    env.cleanup.push(close);
    return { client, transport, child, tools, close, errors, async call(name, args = {}, expected = null) {
        name = `cocos4_${name}`;
        const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 15000 });
        assert(Buffer.byteLength(JSON.stringify(result)) < 65536, 'MCP byte budget');
        assert.equal(result.isError, expected !== null, JSON.stringify(result.structuredContent));
        const value = result.structuredContent;
        assert(schemas.get(name)(value).valid, JSON.stringify(value));
        assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(value) }]);
        assert.equal(value.error?.code ?? null, expected, JSON.stringify(value));
        return value.data;
    } };
}
export async function finished(session, receipt, timeout = 120000) {
    return until(async () => { const page = await session.call('job_get', { jobId: receipt.jobId, limit: 100 }); return terminal.has(page.job.state) && page; }, timeout);
}
export function check(project = 'game', checks = ['logic'], extra = {}) {
    return { project, target: 'HTML5', profile: '2d-basic', checks, requestKey: randomUUID(), ...extra };
}
export async function starter(session) {
    const manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, 'manifest.json'), 'utf8'));
    const template = manifest.catalog.templates.find(item => item.profile === '2d-basic' && item.target === 'HTML5' && item.variant === 'debug');
    assert(template);
    const page = await finished(session, await session.call('project_create', { directory: 'game', projectName: 'logic-game', templateId: template.id, requestKey: 'create-game' }));
    assert.equal(page.job.state, 'succeeded', JSON.stringify(page));
}
export async function write(env, name, source) {
    const filename = path.join(env.workspace, 'game', name);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, source, { mode: 0o600 });
}
