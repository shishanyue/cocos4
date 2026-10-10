// Trusted-maintainer, offline data preparation only. No engine build or lifecycle hooks.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, TextDecoder } from 'node:util';
import JSON5 from 'json5';

const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
    return JSON.stringify(value);
}

// Windows TEMP often uses an 8.3 spelling. Resolve it only after rejecting every
// symlink/junction in the supplied chain; canonicalization must not hide links.
export async function realDirectory(absolute) {
    if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || path.resolve(absolute) !== absolute || absolute.includes('\0')) {
        throw new Error('Expected an absolute directory path.');
    }
    for (let current = absolute;; current = path.dirname(current)) {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Directory symlinks and junctions are not allowed.');
        if (current === path.dirname(current)) break;
    }
    const resolved = await realpath(absolute);
    if (process.platform !== 'win32' && resolved !== absolute) throw new Error('Directory must be canonical.');
    return resolved;
}

// Maintainer-only: both backends provide kernel no-replace directory renames.
// Do not substitute fs.rename/MoveFileEx or a check-then-rename fallback.
// These host helpers are preparation tools, not generated SDK dependencies.
export async function publishSdk(staging, out, { publisher } = {}) {
    if (!path.isAbsolute(staging) || !path.isAbsolute(out) || path.resolve(staging) !== staging
        || path.resolve(out) !== out || path.dirname(staging) !== path.dirname(out)) {
        throw new Error('Atomic publication requires absolute sibling staging and output directories.');
    }
    if (process.platform === 'win32') {
        const parent = await realDirectory(path.dirname(out));
        return publishWindowsSdk(path.join(parent, path.basename(staging)), path.join(parent, path.basename(out)), publisher);
    }
    if (publisher !== undefined) throw new Error('An explicit publisher is supported only for Windows preparation.');
    if (process.platform !== 'linux') throw new Error('Atomic preparation requires a qualified Windows x64 publisher or Linux with libc renameat2.');
    await run('/usr/bin/python3', ['-I', '-S', '-X', 'utf8', '-c', `
import ctypes, errno, os, sys
try:
    renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
except AttributeError:
    sys.exit('ATOMIC_PUBLISH_UNAVAILABLE: libc renameat2 is required; no fallback is allowed.')
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
parent = os.open(os.path.dirname(sys.argv[1]), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    result = renameat2(parent, os.fsencode(os.path.basename(sys.argv[1])),
                       parent, os.fsencode(os.path.basename(sys.argv[2])), 1)  # RENAME_NOREPLACE
    if result != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            sys.exit('OUTPUT_CONFLICT: destination already exists, even if empty.')
        sys.exit('ATOMIC_PUBLISH_FAILED: ' + os.strerror(error) + '; no fallback is allowed.')
finally:
    os.close(parent)
`, staging, out], { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, maxBuffer: 8192 });
}

async function publishWindowsSdk(staging, out, publisher) {
    if (process.arch !== 'x64') throw new Error('ATOMIC_PUBLISH_UNAVAILABLE: Windows SDK preparation requires the qualified x64 publisher.');
    // A copied maintainer tool can itself be launched through Windows TEMP's
    // 8.3 alias. Expand that directory before comparing its pinned files.
    const devkit = await realDirectory(fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, ''));
    const executable = publisher ?? path.join(devkit, 'build/host/cocos4-publish.exe');
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.resolve(executable) !== executable || executable.includes('\0')) {
        throw new Error('ATOMIC_PUBLISH_UNAVAILABLE: the qualified publisher must be an absolute canonical path.');
    }
    const read = async (absolute, maximum) => {
        const before = await lstat(absolute, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > maximum || await realpath(absolute) !== absolute) {
            throw new Error('ATOMIC_PUBLISH_UNAVAILABLE: publisher source, binary and provenance must be ordinary bounded files.');
        }
        const bytes = await readFile(absolute);
        const after = await lstat(absolute, { bigint: true });
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || BigInt(bytes.length) !== before.size) {
            throw new Error('ATOMIC_PUBLISH_UNAVAILABLE: publisher files changed while being verified.');
        }
        return bytes;
    };
    try {
        const binary = await read(executable, 4 * 1024 * 1024);
        const metadata = JSON.parse(await read(`${executable}.build.json`, 256 * 1024));
        if (metadata.schemaVersion !== 1 || metadata.target !== 'win32-x64' || metadata.protocol !== 'cocos4-publish-v1'
            || metadata.source !== 'runtime/publish-win32.c' || metadata.binarySha256 !== hash(binary) || metadata.bytes !== binary.length
            || metadata.sourceSha256 !== hash(await read(path.join(devkit, 'runtime/publish-win32.c'), 256 * 1024))
            || metadata.buildScriptSha256 !== hash(await read(path.join(devkit, 'scripts/build-publisher.mjs'), 256 * 1024))
            || canonical(metadata.buildDependencies) !== canonical([{ path: 'scripts/build-supervisor-win32.mjs',
                sha256: hash(await read(path.join(devkit, 'scripts/build-supervisor-win32.mjs'), 256 * 1024)) }])) {
            throw new Error('Publisher binary, source and build provenance do not match.');
        }
    } catch (error) {
        throw new Error(`ATOMIC_PUBLISH_UNAVAILABLE: build and verify the Windows publisher before SDK preparation. ${error.message}`);
    }
    const chain = async absolute => {
        const paths = [];
        for (let current = absolute;; current = path.dirname(current)) {
            paths.unshift(current);
            if (path.dirname(current) === current) break;
        }
        const pins = [];
        for (const current of paths) {
            const stat = await lstat(current, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) {
                throw new Error('Unsafe publisher directory chain.');
            }
            pins.push([current, stat.dev.toString(), stat.ino.toString(), stat.mode.toString()]);
        }
        return pins;
    };
    try {
        const source = await chain(staging);
        const destination = await chain(path.dirname(out));
        await run(executable, ['cocos4-prepare-publish-v1', String(source.length), path.basename(out), ...source.flat(), ...destination.flat()],
            { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 8192,
                env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: '' } });
    } catch (error) {
        if (error.code === 70) throw new Error('OUTPUT_CONFLICT: destination already exists, even if empty.');
        throw new Error(`ATOMIC_PUBLISH_FAILED: ${error.message}; no fallback is allowed.`);
    }
}

async function main() {
    const options = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        const value = process.argv[index + 1];
        if (!['--out', '--engine-root'].includes(key) || options.has(key) || !value || !path.isAbsolute(value)) {
            throw new Error('Usage: node scripts/prepare-sdk.mjs --out <absolute absent directory> [--engine-root <absolute trusted engine root>]');
        }
        options.set(key, value);
    }
    if (!options.has('--out')) throw new Error('--out must name an absent absolute directory.');
    const requestedOut = path.resolve(options.get('--out'));
    const parent = await realDirectory(path.dirname(requestedOut));
    const out = path.join(parent, path.basename(requestedOut));
    const engine = await realpath(options.get('--engine-root') ?? fileURLToPath(new URL('../../../', import.meta.url)));
    const absent = async () => {
        try { await lstat(out); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw new Error('OUTPUT_CONFLICT: destination already exists, even if empty.');
    };
    await absent();

    const paths = ['package.json', 'cc.config.json', 'scripts/validate-bilibili.cjs', 'scripts/validate-minigame.cjs', 'LICENSE',
        'README.md', 'AGENTS.md', 'docs/bilibili_minigame/README.md', 'docs/plans/cocos4-mcp-devkit.md'].sort();
    const sources = new Map();
    for (const relative of paths) {
        const absolute = path.join(engine, relative);
        if (await realpath(absolute) !== absolute) throw new Error(`Source symlinks are not allowed: ${relative}`);
        const before = await lstat(absolute, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 1024 * 1024) {
            throw new Error(`Invalid source file: ${relative}`);
        }
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await handle.stat({ bigint: true });
            if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.nlink !== 1n) {
                throw new Error(`Source replaced while preparing: ${relative}`);
            }
            const bytes = Buffer.alloc(Number(stat.size) + 1);
            let length = 0;
            while (length < bytes.length) {
                const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
                if (!bytesRead) break;
                length += bytesRead;
            }
            const after = await handle.stat({ bigint: true });
            const final = await lstat(absolute, { bigint: true });
            if (BigInt(length) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
                || !final.isFile() || final.dev !== stat.dev || final.ino !== stat.ino || final.nlink !== 1n
                || final.size !== stat.size || final.mtimeNs !== stat.mtimeNs || final.ctimeNs !== stat.ctimeNs
                || await realpath(absolute) !== absolute) {
                throw new Error(`Source changed while preparing: ${relative}`);
            }
            const data = bytes.subarray(0, length);
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
            sources.set(relative, data);
        } finally { await handle.close(); }
    }
    const config = JSON5.parse(sources.get('cc.config.json').toString('utf8'));
    const pkg = JSON.parse(sources.get('package.json').toString('utf8'));
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
    const ids = (values, max) => Array.isArray(values) && values.length <= max && values.every(validId)
        && new Set(values.map(value => value.toLowerCase())).size === values.length;
    if (typeof pkg.version !== 'string' || !pkg.version || pkg.version.length > 128 || pkg.license !== 'MIT') throw new Error('Invalid source package version/license.');
    if (!ids(config.platforms, 128) || !['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE'].every(target => config.platforms.includes(target))
        || !config.features || Array.isArray(config.features) || typeof config.features !== 'object'
        || !ids(Object.keys(config.features), 256) || !Object.keys(config.features).length) throw new Error('Invalid source catalog.');
    const features = Object.entries(config.features).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, feature]) => {
        if (!feature || !ids(feature.modules, 128) || !ids(feature.dependentModules ?? [], 128) || !ids(feature.dependentAssets ?? [], 128)) {
            throw new Error(`Invalid source feature: ${id}`);
        }
        return { id, modules: feature.modules, dependentModules: feature.dependentModules ?? [],
            dependentAssets: feature.dependentAssets ?? [], prebuiltAvailable: false };
    });
    const payload = new Map([['LICENSE', sources.get('LICENSE')], ['app/validate-bilibili.cjs', sources.get('scripts/validate-bilibili.cjs')],
        ['app/validate-minigame.cjs', sources.get('scripts/validate-minigame.cjs')]]);
    const docs = [];
    for (const [sourcePath, name, title] of [
        ['README.md', 'readme', 'Engine README'], ['AGENTS.md', 'boundaries', 'Engine maintenance boundaries'],
        ['docs/bilibili_minigame/README.md', 'bilibili', 'Bilibili integration guide'],
        ['docs/plans/cocos4-mcp-devkit.md', 'plan', 'MCP devkit plan (not implemented capabilities)'],
    ]) {
        const bytes = sources.get(sourcePath);
        for (let offset = 0, part = 1; offset < bytes.length; ++part) {
            let end = Math.min(offset + 8192, bytes.length);
            while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) --end;
            const id = `guide-${name}-${String(part).padStart(3, '0')}`;
            const file = `docs/${id}.md`;
            payload.set(file, bytes.subarray(offset, end));
            docs.push({ id, kind: 'guide', title: `${title}, part ${part}`, path: file, sourcePath, sourceOffset: offset });
            offset = end;
        }
    }
    const sourceFiles = paths.map(file => ({ path: file, bytes: sources.get(file).length, sha256: hash(sources.get(file)) }));
    const files = [...payload].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: hash(bytes) }));
    const manifest = {
        schemaVersion: 1, kind: 'readonly-development', engineVersion: pkg.version,
        description: 'Readonly source catalog, selected source guides and BILIBILI/WECHAT/BYTEDANCE source-package preflight only. No game development, engine profiles, templates, API index, runnable examples, build, preview or export capability.',
        capabilities: { catalog: true, docs: true, packageValidation: ['BILIBILI', 'WECHAT', 'BYTEDANCE'], gameDevelopment: false, gameBuild: false, preview: false, export: false },
        source: { sha256: hash(canonical(sourceFiles)), files: sourceFiles,
            attribution: 'SHA-256 records selected source bytes, not a full checkout revision or authenticity. Verify separately distributed provenance. Guides retain source-tree links and maintainer instructions; linked files are not necessarily bundled.' },
        license: { path: 'LICENSE', spdx: 'MIT' }, files,
        catalog: { platforms: [...config.platforms].sort().map(id => ({ id, engineTargetAllowed: true, prebuiltAvailable: false, exportAvailable: false, validationLevels: [] })),
            features, profiles: [], templates: [] }, docs,
    };
    manifest.sdkId = `sha256-${hash(canonical(manifest))}`;
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (docs.length > 96 || files.length > 128 || files.some(file => file.bytes > 32 * 1024)
        || manifestBytes.length > 256 * 1024 || files.reduce((sum, file) => sum + file.bytes, manifestBytes.length) > 2 * 1024 * 1024) {
        throw new Error('Generated pack exceeds the readonly SDK bounds.');
    }
    let staging = await mkdtemp(path.join(parent, '.cocos4-sdk-staging-'));
    try {
        await mkdir(path.join(staging, 'app'));
        await mkdir(path.join(staging, 'docs'));
        for (const [file, bytes] of payload) await writeFile(path.join(staging, file), bytes, { flag: 'wx', mode: 0o644 });
        await writeFile(path.join(staging, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 });
        await absent();
        await publishSdk(staging, out);
        staging = undefined;
        process.stdout.write(`${JSON.stringify({ sdkId: manifest.sdkId, root: out, kind: manifest.kind })}\n`);
    } finally { if (staging) await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
