import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compileWindowsSource, detectWindowsCompiler, inspectPeWin32 } from './build-supervisor-win32.mjs';

const run = promisify(execFile);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Maintainer toolchain only. Runtime publication never discovers or
// invokes a compiler. Keep the Windows helper interface equal to the Linux
// provenance interface so installation can verify either shipped binary.
export async function buildHostToolWin32(source, out, { compiler } = {}) {
    assert(path.isAbsolute(source) && path.isAbsolute(out));
    assert.equal(await fs.realpath(source), source);
    compiler ??= process.env.COCOS4_WINDOWS_COMPILER ?? await detectWindowsCompiler();
    assert(typeof compiler === 'string' && path.isAbsolute(compiler), 'Windows host helpers require a detected or explicit absolute supported compiler');
    const sourceBytes = await fs.readFile(source);
    const sharedBuildSource = path.join(devkit, 'scripts/build-supervisor-win32.mjs');
    const sharedBuildBytes = await fs.readFile(sharedBuildSource);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.host-build-'));
    let outputPublished = false, metadataPublished = false;
    try {
        await fs.writeFile(path.join(temporary, 'input.c'), sourceBytes, { flag: 'wx' });
        const compilation = await compileWindowsSource({ compiler, source: path.join(temporary, 'input.c'),
            output: path.join(temporary, 'output.exe'), reproducible: true });
        assert.deepEqual(await fs.readFile(source), sourceBytes, 'Host helper source changed during compilation');
        assert.deepEqual(await fs.readFile(sharedBuildSource), sharedBuildBytes, 'Shared host builder changed during compilation');
        const output = await fs.readFile(path.join(temporary, 'output.exe'));
        const pe = inspectPeWin32(output);
        const allowed = new Set(['kernel32.dll', 'msvcrt.dll', 'advapi32.dll', 'shell32.dll', 'userenv.dll']);
        assert(pe.imports.every(value => allowed.has(value.library.toLowerCase())), 'Host helper imported an unreviewed DLL');
        const relativeSource = path.relative(devkit, source).split(path.sep).join('/');
        if (relativeSource === 'runtime/publish-win32.c') {
            const symbols = new Set(pe.imports.flatMap(value => value.symbols));
            for (const symbol of ['CreateFileW', 'GetFileInformationByHandle', 'GetFinalPathNameByHandleW', 'SetFileInformationByHandle']) {
                assert(symbols.has(symbol), `Windows publisher must import ${symbol}`);
            }
            assert(!symbols.has('MoveFileExW') && !symbols.has('CopyFileW'), 'No overwrite or copy fallback');
        }
        const metadata = { schemaVersion: 1, target: 'win32-x64', linkage: 'windows-system-libraries',
            ...(relativeSource === 'runtime/publish-win32.c' ? { protocol: 'cocos4-publish-v1' } : {}),
            ...(relativeSource === 'runtime/mcp-launch-win32.c' ? { protocol: 'cocos4-mcp-launch-v1' } : {}),
            ...(relativeSource === 'runtime/fs-win32.c' ? { protocol: 'cocos4-fs-v1' } : {}),
            source: relativeSource, buildScriptSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
            buildDependencies: [{ path: 'scripts/build-supervisor-win32.mjs', sha256: hash(sharedBuildBytes) }],
            sourceSha256: hash(sourceBytes), binarySha256: hash(output), bytes: output.length,
            compiler: compilation.compiler, flags: compilation.flags, environment: compilation.environment,
            compilerArguments: compilation.arguments, compilerDiagnostics: compilation.diagnostics,
            sharedLibraries: pe.imports.map(value => value.library).sort(), requiredVersions: [], pe };
        await fs.writeFile(path.join(temporary, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
        await fs.link(path.join(temporary, 'output.exe'), out); outputPublished = true;
        await fs.link(path.join(temporary, 'metadata.json'), `${out}.build.json`); metadataPublished = true;
        return metadata;
    } catch (error) {
        if (metadataPublished) await fs.unlink(`${out}.build.json`);
        if (outputPublished) await fs.unlink(out);
        throw error;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export function buildPublisherWin32({ output = path.join(devkit, 'build/host/cocos4-publish.exe'), compiler } = {}) {
    return buildHostToolWin32(path.join(devkit, 'runtime/publish-win32.c'), output, { compiler });
}

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
    const options = new Map();
    for (let i = 0; i < args.length; i += 2) {
        assert(['--out', '--compiler'].includes(args[i]) && !options.has(args[i]) && path.isAbsolute(args[i + 1] ?? ''),
            'Usage: node scripts/build-publisher.mjs [--out ABSENT_ABSOLUTE_FILE] [--compiler ABSOLUTE_COMPILER]');
        options.set(args[i], args[i + 1]);
    }
    const windows = process.platform === 'win32' || options.has('--compiler');
    const out = options.get('--out') ?? path.join(devkit, `build/host/cocos4-publish${windows ? '.exe' : ''}`);
    const build = async () => {
        const source = path.join(devkit, windows ? 'runtime/publish-win32.c' : 'runtime/publish.c');
        const compile = file => windows ? buildHostToolWin32(source, file, { compiler: options.get('--compiler') }) : buildHostTool(source, file);
        if (options.has('--out')) return compile(out);
        await fs.mkdir(path.dirname(out), { recursive: true });
        const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.publisher-'));
        try {
            const file = path.join(temporary, path.basename(out));
            const metadata = await compile(file);
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
