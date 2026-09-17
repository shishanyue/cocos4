import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// A fixed fixture, not a production tool surface or a workspace authorization layer.
const sdkId = 'p0-probe';
const documentUri = `cocos4://sdk/${sdkId}/probe`;
const document = 'P0 protocol fixture only. No engine, project, or publishing capability.';
const inputSchema = z.object({ value: z.string().min(1).max(256) }).strict();
const outputSchema = z.object({
    schemaVersion: z.literal(1),
    sdkId: z.literal(sdkId),
    ok: z.boolean(),
    data: z.object({ value: z.string() }).strict().nullable(),
    warnings: z.array(z.never()),
    error: z.object({
        code: z.literal('PROBE_REJECTED'),
        message: z.string(),
        retryable: z.literal(false),
        nextSteps: z.array(z.string()),
    }).strict().nullable(),
}).strict();

const server = new McpServer({ name: 'cocos4-p0-probe', version: '0.0.0' });
server.registerTool('p0_echo', {
    description: 'Fixed SDK compatibility fixture; value "reject" tests a business failure.',
    inputSchema,
    outputSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, ({ value }): CallToolResult => {
    const rejected = value === 'reject';
    const structuredContent: z.infer<typeof outputSchema> = {
        schemaVersion: 1,
        sdkId,
        ok: !rejected,
        data: rejected ? null : { value },
        warnings: [],
        error: rejected ? {
            code: 'PROBE_REJECTED',
            message: 'Intentional P0 business failure.',
            retryable: false,
            nextSteps: ['Use a value other than "reject".'],
        } : null,
    };
    return {
        isError: rejected,
        structuredContent,
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    };
});
server.registerResource('p0-document', documentUri, {
    mimeType: 'text/plain',
    description: 'Fixed in-memory fixture; no file access.',
}, (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: document }] }));

process.stderr.write('cocos4 P0 fixture, not a devkit server\n');
await server.connect(new StdioServerTransport());
