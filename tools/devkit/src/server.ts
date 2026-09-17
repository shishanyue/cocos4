import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Application } from './app.js';

// Keep the official SDK framing/validation. Only bound memory and wire output here.
class BoundedStdioTransport extends StdioServerTransport {
    private queued = 0;
    override async send(message: JSONRPCMessage): Promise<void> {
        const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
        if (bytes > 65536 || this.queued + bytes > 262144) {
            await this.close();
            throw new Error('MCP output byte budget exceeded.');
        }
        this.queued += bytes;
        try { await super.send(message); } finally { this.queued -= bytes; }
    }
}

export async function serve(app: Application): Promise<void> {
    const server = new Server({ name: 'cocos4-devkit', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
    const transport = new BoundedStdioTransport(process.stdin, process.stdout, { maxBufferSize: 65536 });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let closing: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
        if (closing) return closing;
        closing = Promise.resolve().then(async () => {
            const timer = setTimeout(() => process.exit(1), 10_000);
            timer.unref();
            try { await app.close(); await server.close(); }
            catch { process.stderr.write('cocos4: shutdown failed; private state was not marked successful.\n'); process.exitCode = 1; }
            finally { clearTimeout(timer); finish(); }
        });
        return closing;
    };
    const stop = (): void => { void shutdown(); };
    const protocolParams = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> => {
        const result = schema.safeParse(value);
        if (!result.success) throw new McpError(ErrorCode.InvalidParams, 'Invalid MCP request parameters.');
        return result.data;
    };
    let calls = 0;
    let initialized = false;
    // SDK request schemas strip unknown parameters and can throw before our
    // error routing. Dispatch by method, then validate the original parameters.
    const dispatch = <T extends string>(method: T) => z.object({ method: z.literal(method) }).passthrough();
    const metadata = z.object({ progressToken: z.union([z.string(), z.number()]).optional() }).passthrough().optional();
    server.oninitialized = () => { initialized = true; };
    server.setRequestHandler(dispatch('tools/list'), request => {
        protocolParams(z.object({ _meta: metadata }).strict(), request.params === undefined ? {} : request.params);
        return { tools: app.tools };
    });
    server.setRequestHandler(dispatch('resources/list'), request => {
        protocolParams(z.object({ _meta: metadata }).strict(), request.params === undefined ? {} : request.params);
        return { resources: app.sdk.resources() };
    });
    server.setRequestHandler(dispatch('resources/read'), request => {
        const input = protocolParams(z.object({ uri: z.string().max(1024), _meta: metadata }).strict(), request.params);
        const resource = app.sdk.resources().find(resource => resource.uri === input.uri);
        if (!resource) throw new McpError(ErrorCode.InvalidParams, 'Unknown resource URI.');
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: app.sdk.resource(resource.uri) }] };
    });
    server.setRequestHandler(dispatch('tools/call'), async (request, extra) => {
        const input = protocolParams(z.object({ name: z.string().max(128), arguments: z.record(z.unknown()).optional(),
            _meta: metadata }).strict(), request.params);
        if (!initialized) throw new McpError(ErrorCode.InvalidRequest, 'Initialize the MCP session first.');
        if (!app.hasTool(input.name)) throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool.');
        if (calls >= 16) throw new McpError(ErrorCode.InvalidRequest, 'Too many simultaneous tool calls.');
        calls++;
        try {
            if (extra.signal.aborted || closing) throw new McpError(ErrorCode.InvalidRequest, 'Request cancelled.');
            const result = await app.call(input.name, input.arguments ?? {});
            if (extra.signal.aborted) {
                const data = result.structuredContent?.data;
                const receipt = z.object({ jobId: z.string().uuid() }).passthrough().safeParse(data);
                if (receipt.success) await app.jobs.cancel(receipt.data.jobId);
                throw new McpError(ErrorCode.InvalidRequest, 'Request cancelled.');
            }
            return result;
        } finally { calls--; }
    });
    server.onclose = stop;
    server.onerror = () => { process.stderr.write('cocos4: MCP transport/protocol error.\n'); stop(); };
    process.stdin.once('end', stop);
    process.stdin.once('error', stop);
    process.stdout.once('error', stop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        await server.connect(transport);
        const receive = transport.onmessage;
        transport.onmessage = message => {
            if ('id' in message && typeof message.id === 'string' && message.id.length > 128) { stop(); return; }
            receive?.(message);
        };
        if (process.stdin.readableEnded) stop();
        await finished;
    } finally {
        await shutdown();
        process.stdin.off('end', stop);
        process.stdin.off('error', stop);
        process.stdout.off('error', stop);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
