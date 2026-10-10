import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHostTool } from './build-publisher.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));

// Maintainer-only compilation. Source and portable layouts both ship this pair
// beside src/, under host/. No runtime compilation or environment fallback.
export async function buildMcpLauncher(out, options = {}) {
    if (process.platform === 'win32') {
        const { buildHostToolWin32 } = await import('./build-publisher.mjs');
        return buildHostToolWin32(path.join(devkit, 'runtime/mcp-launch-win32.c'), out, options);
    }
    return buildHostTool(path.join(devkit, 'runtime/mcp-launch.c'), out, true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
        assert(['--out', '--compiler'].includes(args[i]) && !flags.has(args[i]) && args[i + 1] && path.isAbsolute(args[i + 1]),
            'Usage: node scripts/build-mcp-launch.mjs [--out ABSENT_ABSOLUTE_FILE] [--compiler ABSOLUTE_COMPILER_EXE]');
        flags.set(args[i], args[i + 1]);
    }
    assert(process.platform === 'win32' || !flags.has('--compiler'), '--compiler is supported only for Windows host builds');
    const name = `cocos4-mcp-launch${process.platform === 'win32' ? '.exe' : ''}`;
    const out = flags.get('--out') ?? path.join(devkit, 'build/host', name);
    const options = flags.has('--compiler') ? { compiler: flags.get('--compiler') } : {};
    const build = async () => {
        if (flags.has('--out')) return buildMcpLauncher(out, options);
        await fs.mkdir(path.dirname(out), { recursive: true });
        const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.mcp-launch-'));
        try {
            const file = path.join(temporary, name);
            const metadata = await buildMcpLauncher(file, options);
            await fs.rename(file, out);
            await fs.rename(`${file}.build.json`, `${out}.build.json`);
            return metadata;
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    };
    build().then(metadata => process.stdout.write(`${JSON.stringify({ out, ...metadata })}\n`))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
