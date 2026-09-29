import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHostTool } from './build-publisher.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));

// Maintainer-only compilation. Source and portable layouts both ship this pair
// beside src/, under host/. No runtime compilation or environment fallback.
export async function buildMcpLauncher(out) {
    return buildHostTool(path.join(devkit, 'runtime/mcp-launch.c'), out, true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--out' && path.isAbsolute(args[1])),
        'Usage: node scripts/build-mcp-launch.mjs [--out ABSENT_ABSOLUTE_FILE]');
    const out = args[1] ?? path.join(devkit, 'build/host/cocos4-mcp-launch');
    const build = async () => {
        if (args.length) return buildMcpLauncher(out);
        await fs.mkdir(path.dirname(out), { recursive: true });
        const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.mcp-launch-'));
        try {
            const file = path.join(temporary, 'cocos4-mcp-launch');
            const metadata = await buildMcpLauncher(file);
            await fs.rename(file, out);
            await fs.rename(`${file}.build.json`, `${out}.build.json`);
            return metadata;
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    };
    build().then(metadata => process.stdout.write(`${JSON.stringify({ out, ...metadata })}\n`))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
