import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHostToolWin32 } from './build-publisher.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const helperName = 'cocos4-fs.exe';

// Maintainer-only compilation. The application consumes the shipped helper and
// its verified provenance; it never discovers or invokes a compiler at runtime.
export async function buildFsWin32({ output = path.join(devkit, 'build/host', helperName), compiler } = {}) {
    assert.equal(process.platform, 'win32', 'The Windows filesystem helper is built only on Windows');
    assert(compiler === undefined || (typeof compiler === 'string' && path.isAbsolute(compiler)),
        'The Windows host compiler must be an absolute executable path');
    return buildHostToolWin32(path.join(devkit, 'runtime/fs-win32.c'), output, { compiler });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
        assert(['--out', '--compiler'].includes(args[i]) && !flags.has(args[i]) && path.isAbsolute(args[i + 1] ?? ''),
            'Usage: node scripts/build-fs-win32.mjs [--out ABSENT_ABSOLUTE_FILE] [--compiler ABSOLUTE_COMPILER_EXE]');
        flags.set(args[i], args[i + 1]);
    }
    const out = flags.get('--out') ?? path.join(devkit, 'build/host', helperName);
    const options = { compiler: flags.get('--compiler') };
    const build = async () => {
        assert.equal(process.platform, 'win32', 'The Windows filesystem helper is built only on Windows');
        if (flags.has('--out')) return buildFsWin32({ output: out, ...options });
        await fs.mkdir(path.dirname(out), { recursive: true });
        const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.fs-win32-'));
        try {
            const file = path.join(temporary, helperName);
            const metadata = await buildFsWin32({ output: file, ...options });
            const manifest = { version: 1, platform: 'win32', arch: 'x64', file: helperName,
                bytes: metadata.bytes, sha256: metadata.binarySha256, sourceSha256: metadata.sourceSha256 };
            await fs.writeFile(path.join(temporary, 'fs.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
            // Replace only these generated host files. Readers reject a mixed
            // binary/metadata pair through the existing provenance hash check.
            await fs.rename(file, out);
            await fs.rename(`${file}.build.json`, `${out}.build.json`);
            await fs.rename(path.join(temporary, 'fs.json'), path.join(path.dirname(out), 'fs.json'));
            return metadata;
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    };
    build().then(metadata => process.stdout.write(`${JSON.stringify({ out, ...metadata })}\n`))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
