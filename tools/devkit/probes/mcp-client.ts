import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
    CallToolResultSchema, EmptyResultSchema, ErrorCode, McpError,
    type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

const serverPath = fileURLToPath(new URL('./mcp-server.js', import.meta.url));
const documentUri = 'cocos4://sdk/p0-probe/probe';

class ObservedTransport extends StdioClientTransport {
    readonly messages: JSONRPCMessage[] = [];

    override async start(): Promise<void> {
        const receive = this.onmessage;
        this.onmessage = (message): void => {
            this.messages.push(message);
            receive?.(message);
        };
        await super.start();
    }
}

test('official SDK stdio: handshake, strict schemas, resources and documented high-level API gaps',
    { timeout: 15_000 }, async (t) => {
        const transport = new ObservedTransport({
            command: process.execPath,
            args: [serverPath],
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            stderr: 'pipe',
        });
        const client = new Client({ name: 'cocos4-p0-client', version: '0.0.0' });
        const errors: Error[] = [];
        const closeOnAbort = (): void => { client.close().catch((error: Error) => errors.push(error)); };
        // SDK 1.30 retains per-request abort listeners; close once to reject all pending requests.
        t.signal.addEventListener('abort', closeOnAbort, { once: true });
        t.after(async () => {
            t.signal.removeEventListener('abort', closeOnAbort);
            await client.close();
        });
        const options = { timeout: 3000 };
        let stderr = '';
        client.onerror = (error): void => { errors.push(error); };
        transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        try {
            await client.connect(transport, options);
            assert.deepEqual(client.getServerVersion(), { name: 'cocos4-p0-probe', version: '0.0.0' });
            const handshake = transport.messages.find((message) => 'result' in message
                && 'protocolVersion' in message.result);
            assert.ok(handshake && 'result' in handshake);
            assert.equal(handshake.result.protocolVersion, '2025-11-25');
            assert.deepEqual(client.getServerCapabilities(), {
                tools: { listChanged: true }, resources: { listChanged: true },
            });

            const { tools } = await client.listTools(undefined, options);
            assert.equal(tools.length, 1);
            const tool = tools[0];
            assert.equal(tool.name, 'p0_echo');
            assert.equal(tool.inputSchema.additionalProperties, false);
            assert.equal(tool.outputSchema?.additionalProperties, false);
            assert.deepEqual(tool.annotations, {
                readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
            });
            for (const value of ['hello', 'reject']) {
                const result = CallToolResultSchema.parse(await client.callTool(
                    { name: tool.name, arguments: { value } }, CallToolResultSchema, options,
                ));
                const rejected = value === 'reject';
                assert.equal(result.isError, rejected);
                assert.equal(result.content.length, 1);
                const text = result.content[0];
                assert.equal(text.type, 'text');
                assert.ok(text.type === 'text');
                assert.deepEqual(JSON.parse(text.text), result.structuredContent);
                assert.deepEqual(result.structuredContent, {
                    schemaVersion: 1, sdkId: 'p0-probe', ok: !rejected,
                    data: rejected ? null : { value }, warnings: [],
                    error: rejected ? {
                        code: 'PROBE_REJECTED', message: 'Intentional P0 business failure.',
                        retryable: false, nextSteps: ['Use a value other than "reject".'],
                    } : null,
                });
                assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
            }

            for (const args of [{ value: '' }, { value: 1 }, { value: 'x', extra: true }, {}]) {
                const result = await client.callTool({ name: tool.name, arguments: args }, CallToolResultSchema, options);
                assert.equal(result.isError, true);
                assert.equal(result.structuredContent, undefined);
                assert.match(JSON.stringify(result.content), /Input validation error/);
            }
            const unknown = await client.callTool({ name: 'absent', arguments: {} }, CallToolResultSchema, options);
            assert.equal(unknown.isError, true);
            assert.equal(unknown.structuredContent, undefined);
            t.diagnostic('McpServer defaults are not the planned P3 contract: listChanged=true; unknown tools and invalid inputs return text-only tool errors.');

            await assert.rejects(client.request({ method: 'p0/unknown' }, EmptyResultSchema, options),
                (error: unknown) => error instanceof McpError && error.code === ErrorCode.MethodNotFound);
            const { resources } = await client.listResources(undefined, options);
            assert.equal(resources.length, 1);
            assert.equal(resources[0].uri, documentUri);
            const { contents } = await client.readResource({ uri: documentUri }, options);
            assert.deepEqual(contents, [{
                uri: documentUri, mimeType: 'text/plain',
                text: 'P0 protocol fixture only. No engine, project, or publishing capability.',
            }]);
            await assert.rejects(client.readResource({ uri: 'file:///not-authorized' }, options),
                (error: unknown) => error instanceof McpError && error.code === ErrorCode.InvalidParams);
            await client.ping(options);
        } finally {
            await client.close();
        }
        assert.equal(transport.pid, null);
        assert.deepEqual(errors, []);
        assert.equal(stderr, 'cocos4 P0 fixture, not a devkit server\n');
    });

test('fixture emits no unsolicited stdout and exits on stdin EOF without a termination signal',
    { timeout: 5000 }, async () => {
        const child = spawn(process.execPath, [serverPath], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT } : {},
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        const closed = once(child, 'close');
        const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
        try {
            child.stdin.end();
            const [code, signal] = await closed;
            assert.equal(code, 0);
            assert.equal(signal, null);
            assert.equal(stdout, '');
            assert.equal(stderr, 'cocos4 P0 fixture, not a devkit server\n');
        } finally {
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
    });
