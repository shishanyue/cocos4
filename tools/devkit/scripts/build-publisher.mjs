import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Also used for the portable launcher. This is a maintainer compiler, never a
// runtime dependency. Fixed flags, no shell, inherited build flags or PATH lookup.
export async function buildHostTool(source, out, freestanding = false) {
    assert.equal(process.platform, 'linux', 'Host helpers are verified only on Linux/procfs.');
    assert.equal(process.arch, 'x64', 'Only Linux x64 host helpers are built.');
    assert(path.isAbsolute(source) && path.isAbsolute(out));
    assert.equal(await fs.realpath(source), source);
    const bytes = await fs.readFile(source);
    const compiler = await fs.realpath('/usr/bin/cc');
    const compilerBytes = await fs.readFile(compiler);
    const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SOURCE_DATE_EPOCH: '0' };
    const { stdout: version } = await run(compiler, ['--version'], { env, shell: false, timeout: 10000, maxBuffer: 16384 });
    await fs.mkdir(path.dirname(out), { recursive: true });
    const flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fno-ident',
        ...(freestanding ? ['-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-nostdlib', '-static']
            : ['-Wpedantic', '-Wconversion', '-Wsign-conversion', '-Wshadow', '-Wformat=2', '-Wstrict-prototypes',
                '-Wmissing-prototypes', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-fPIE', '-pie', '-Wl,-z,relro,-z,now']),
        '-Wl,--build-id=none', '-Wl,-z,noexecstack', '-s'];
    const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.host-build-'));
    try {
        await fs.writeFile(path.join(temporary, 'input.c'), bytes, { flag: 'wx' });
        await run(compiler, [...flags, 'input.c', '-o', 'output'], { cwd: temporary, env, shell: false, timeout: 60000, maxBuffer: 65536 });
        assert.deepEqual(await fs.readFile(source), bytes, 'Host helper source changed during compilation');
        assert.deepEqual(await fs.readFile(compiler), compilerBytes, 'Host compiler changed during compilation');
        const output = await fs.readFile(path.join(temporary, 'output'));
        const { stdout: elf } = await run('/usr/bin/readelf', ['-h', '-l', '-d', '-V', path.join(temporary, 'output')],
            { env, shell: false, timeout: 10000, maxBuffer: 65536 });
        assert.match(elf, /Advanced Micro Devices X86-64/);
        if (freestanding) assert.doesNotMatch(elf, /INTERP|DYNAMIC|\(NEEDED\)/, 'Launcher must not load libraries before environment filtering');
        const metadata = { schemaVersion: 1, target: 'linux-x64', linkage: freestanding ? 'static-no-libc' : 'dynamic',
            ...(source === path.join(devkit, 'runtime/publish.c') ? { protocol: 'cocos4-publish-v1' } : {}),
            ...(source === path.join(devkit, 'runtime/mcp-launch.c') ? { protocol: 'cocos4-mcp-launch-v1' } : {}),
            source: path.relative(devkit, source), buildScriptSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
            sourceSha256: hash(bytes), binarySha256: hash(output), bytes: output.length,
            compiler: { path: compiler, version: version.trim(), sha256: hash(compilerBytes) }, flags, environment: env,
            sharedLibraries: [...elf.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1]).sort(),
            requiredVersions: [...new Set(elf.match(/\b(?:GLIBC|GLIBCXX|CXXABI)_[0-9.]+/g))].sort() };
        await fs.writeFile(out, output, { mode: 0o755, flag: 'wx' });
        await fs.chmod(out, 0o755);
        await fs.writeFile(`${out}.build.json`, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
        return metadata;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--out' && path.isAbsolute(args[1])),
        'Usage: node scripts/build-publisher.mjs [--out ABSENT_ABSOLUTE_FILE]');
    const out = args[1] ?? path.join(devkit, 'build/host/cocos4-publish');
    const build = async () => {
        const source = path.join(devkit, 'runtime/publish.c');
        if (args.length) return buildHostTool(source, out);
        await fs.mkdir(path.dirname(out), { recursive: true });
        const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.publisher-'));
        try {
            const file = path.join(temporary, 'cocos4-publish');
            const metadata = await buildHostTool(source, file);
            // Only the fixed generated host files are replaced. A reader during
            // the two renames fails its hash check; no existing SDK is modified.
            await fs.rename(file, out);
            await fs.rename(`${file}.build.json`, `${out}.build.json`);
            return metadata;
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    };
    build()
        .then(metadata => process.stdout.write(`${JSON.stringify({ out, ...metadata })}\n`))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
