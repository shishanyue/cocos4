import { serve } from '../../build/src/server.js';

const mode = process.argv[2];
await serve({
    tools: [{ name: 'output_failure_fixture', inputSchema: { type: 'object',
        properties: { payload: { const: 'x'.repeat(32768) } } } }],
    sdk: { resources: () => [] },
    async close() {
        process.stderr.write('CLOSE_ENTERED\n');
        if (mode === 'throw') throw new Error('Intentional shutdown failure');
        if (mode === 'hang') await new Promise(() => {});
        else throw new Error('Unsupported shutdown failure fixture');
    },
});
process.exit(process.exitCode ?? 0);
