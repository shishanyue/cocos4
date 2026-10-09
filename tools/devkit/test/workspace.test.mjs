import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import promises from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { inspectProject, inspectionSchema, validateRelativePath, withPackageSnapshot, readSdkValidator } from '../build/src/workspace.js';

const require = createRequire(import.meta.url);
const MiB = 1024 * 1024;
const validatorBytes = await fs.readFile(new URL('../../../scripts/validate-bilibili.cjs', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const code = (expected) => (error) => { assert.equal(error.code, expected, error.stack); return true; };

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos4-workspace-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const staging = path.join(root, 'state');
    await fs.mkdir(workspace);
    await fs.mkdir(staging, { mode: 0o700 });
    return { root, workspace, staging };
}

async function packageFixture(t, extra = {}) {
    const fixturePaths = await fixture(t);
    const out = path.join(fixturePaths.workspace, 'out');
    await fs.mkdir(out);
    for (const [name, contents] of Object.entries({
        'game.js': 'throw new Error("PROJECT CODE MUST NEVER EXECUTE");',
        'game.json': JSON.stringify({ appId: 'fixture', version: '1.0.0' }),
        'web-adapter.js': 'throw new Error("NO EXECUTION");',
        'engine-adapter.js': 'throw new Error("NO EXECUTION");',
        'fs-utils.js': 'throw new Error("NO EXECUTION");',
        ...extra,
    })) {
        await fs.mkdir(path.dirname(path.join(out, name)), { recursive: true });
        await fs.writeFile(path.join(out, name), contents);
    }
    return { ...fixturePaths, out };
}

function validate(paths, callback = (snapshot, script) => require(script).validateBilibili(snapshot)) {
    return withPackageSnapshot(paths.workspace, 'out', paths.staging, validatorBytes, callback);
}

async function duringDirectoryOpen(directory, phase, change, action) {
    const original = promises.open;
    let selected = false;
    let changed = false;
    promises.open = async (filename, flags, ...args) => {
        if (selected || !(flags & constants.O_DIRECTORY) || !filename.endsWith(`/${path.basename(directory)}`)) {
            return original(filename, flags, ...args);
        }
        assert.match(filename, /^\/proc\/self\/fd\/\d+\//);
        assert.equal(await fs.realpath(filename), directory);
        selected = true;
        if (phase === 'before-open') { await change(); changed = true; }
        const handle = await original(filename, flags, ...args);
        if (phase === 'after-stat') {
            const stat = handle.stat.bind(handle);
            handle.stat = async (...statArgs) => {
                const result = await stat(...statArgs);
                if (!changed) { await change(); changed = true; }
                return result;
            };
        }
        return handle;
    };
    syncBuiltinESMExports();
    try { await action(); assert.equal(changed, true); }
    finally { promises.open = original; syncBuiltinESMExports(); }
}

test('directory traversal tolerates unrelated ancestor and project sibling churn', async (t) => {
    for (const level of ['root', 'workspace']) {
        for (const phase of ['before-open', 'after-stat']) {
            await t.test(`${level} ${phase}`, async (t) => {
                const paths = await packageFixture(t);
                const directory = paths[level];
                const churn = () => fs.mkdtemp(path.join(directory, 'unrelated-'));
                await duringDirectoryOpen(directory, phase, churn, async () => {
                    const result = await inspectProject(paths.workspace, 'out');
                    assert.equal(result.complete, true);
                    assert.equal(result.files, 5);
                });
                await duringDirectoryOpen(directory, phase, churn, async () => {
                    assert.equal((await validate(paths)).appId, 'fixture');
                });
                await fs.link(path.join(paths.out, 'game.js'), path.join(paths.root, 'hardlink'));
                await duringDirectoryOpen(directory, phase, churn, () =>
                    assert.rejects(inspectProject(paths.workspace, 'out'), code('PERMISSION_DENIED')));
            });
        }
    }
});

test('directory opens still reject inode replacement and a renamed pinned ancestor', async (t) => {
    for (const phase of ['before-open', 'after-stat']) {
        await t.test(phase, async (t) => {
            const paths = await packageFixture(t);
            const change = async () => {
                await fs.rename(paths.workspace, path.join(paths.root, 'moved'));
                if (phase === 'before-open') await fs.mkdir(paths.workspace);
                else await fs.symlink('moved', paths.workspace);
            };
            await duringDirectoryOpen(paths.workspace, phase, change, () =>
                assert.rejects(inspectProject(paths.workspace, 'out'), code('INPUT_CHANGED')));
        });
    }
});

test('scanned project directory contents are still checked after the identity-only open', async (t) => {
    const paths = await packageFixture(t);
    await duringDirectoryOpen(paths.out, 'after-stat', () => fs.mkdir(path.join(paths.out, 'added-after-pin')), () =>
        assert.rejects(inspectProject(paths.workspace, 'out'), code('INPUT_CHANGED')));
});

test('relative path validation rejects traversal, alternate separators, URIs and reserved Windows names', () => {
    for (const value of ['.', 'project', 'a/b.ts', 'a-b/_asset@2.png', '.config/file']) assert.equal(validateRelativePath(value), value);
    for (const value of ['', '/absolute', '//server/share', '../p', 'a/../p', './p', 'a/./p', 'a//p', 'a/',
        'file:///etc/passwd', 'https://host/a', 'C:/p', 'C:p', 'p:secret', 'a\\b', '%2e%2e/p', 'a%252fb',
        'a\0b', 'a\nb', 'a?b', 'a*b', 'a|b', 'a<b', 'a>b', 'a"b', 'CON', 'nul.txt', 'COM1', 'lpt9.json',
        'CONIN$', 'COM\u00b9.txt', 'p/aux/x', 'CON .txt', 'a.', 'a ', 'a'.repeat(1025)]) {
        assert.throws(() => validateRelativePath(value), (error) => ['INVALID_ARGUMENTS', 'PATH_OUTSIDE_WORKSPACE'].includes(error.code), value);
    }
});

test('inspection parses data only, reports external configuration, and makes no feature/runtime guesses', async (t) => {
    const { workspace } = await fixture(t);
    const pkg = JSON.stringify({ main: 'index.js', creator: { version: '4.0.0' }, scripts: { postinstall: 'touch SENTINEL' },
        dependencies: { unknown: 'file:../../private' }, plugins: ['bad-plugin'] });
    await fs.writeFile(path.join(workspace, 'package.json'), pkg);
    await fs.writeFile(path.join(workspace, 'index.js'), 'throw new Error("NEVER EXECUTE");');
    await fs.writeFile(path.join(workspace, 'vite.config.js'), 'throw new Error("NEVER LOAD CONFIG");');
    await fs.writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ extends: '../outside/tsconfig.json',
        references: [{ path: '/outside' }], compilerOptions: { plugins: [{ name: 'execute-me' }], paths: { cc: ['../../outside/*'] } } }));
    await fs.writeFile(path.join(workspace, 'level.scene'), '{}');
    await fs.writeFile(path.join(workspace, 'texture.ktx2'), 'compressed');
    await fs.writeFile(path.join(workspace, '.env'), 'DO_NOT_RETURN_THIS_SECRET');
    await fs.mkdir(path.join(workspace, '.git'));
    await fs.symlink('/outside/nonexistent', path.join(workspace, '.git', 'ignored'));
    const before = await fs.stat(path.join(workspace, 'package.json'));
    const result = await inspectProject(workspace, '.');
    assert.deepEqual(inspectionSchema.parse(result), result);
    assert.equal(result.kind, 'creator');
    assert.equal(result.entry, 'index.js');
    assert.equal(result.files, 6);
    assert.equal(result.complete, true);
    assert.deepEqual(result.requiredFeatures, []);
    for (const diagnostic of ['DATA_ONLY', 'FEATURES_UNDETERMINED', 'EXTERNAL_TSCONFIG', 'UNTRUSTED_PLUGIN',
        'UNVERIFIED_DEPENDENCIES', 'SCRIPTS_NOT_RUN', 'NONSTANDARD_CONFIG', 'UNSUPPORTED_ASSET', 'PRIVATE_PATH_SKIPPED']) {
        assert.ok(result.diagnostics.some((item) => item.code === diagnostic), diagnostic);
    }
    assert.ok(!JSON.stringify(result).includes('DO_NOT_RETURN_THIS_SECRET'));
    assert.equal((await fs.stat(path.join(workspace, 'package.json'))).mtimeMs, before.mtimeMs);
    assert.equal(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'), pkg);
    assert.ok(!(await fs.readdir(workspace)).includes('SENTINEL'));
    assert.throws(() => inspectionSchema.parse({ ...result, unexpected: true }));
});

test('inspection does not evaluate JSONC, unknown configs, or an external package main', async (t) => {
    const { workspace } = await fixture(t);
    await fs.writeFile(path.join(workspace, 'package.json'), '{"main":"../escape.js"}');
    await fs.writeFile(path.join(workspace, 'tsconfig.json'), '{ // not strict JSON\n "compilerOptions": {} }');
    await fs.writeFile(path.join(workspace, 'cocos.config.json'), '{}');
    const result = await inspectProject(workspace, '.');
    assert.equal(result.entry, null);
    for (const expected of ['INVALID_JSON', 'NONSTANDARD_CONFIG', 'EXTERNAL_ENTRY']) assert.ok(result.diagnostics.some((item) => item.code === expected));
});

test('inspection is partial and bounded at 1000 entries, 8 MiB, 1 MiB per JSON and depth 32', async (t) => {
    const { workspace } = await fixture(t);
    await Promise.all(Array.from({ length: 1001 }, (_, index) => fs.writeFile(path.join(workspace, `f${index}`), 'x')));
    const count = await inspectProject(workspace, '.');
    assert.equal(count.complete, false);
    assert.ok(count.files <= 1000);
    assert.ok(count.diagnostics.some((item) => item.code === 'LIMIT_EXCEEDED'));
    for (const [folder, name, size] of [['bytes', 'large.bin', 8 * MiB + 1], ['json', 'package.json', MiB + 1]]) {
        await fs.mkdir(path.join(workspace, folder));
        const handle = await fs.open(path.join(workspace, folder, name), 'w');
        await handle.truncate(size);
        await handle.close();
        const result = await inspectProject(workspace, folder);
        assert.equal(result.complete, false);
        assert.equal(result.files, 0);
        assert.equal(result.bytes, 0);
    }
    await fs.mkdir(path.join(workspace, 'deep', ...Array(33).fill('d')), { recursive: true });
    const depth = await inspectProject(workspace, 'deep');
    assert.equal(depth.complete, false);
    assert.ok(depth.diagnostics.some((item) => item.code === 'LIMIT_EXCEEDED'));
});

test('symlinks are rejected at the root, ancestors, project directories and files', async (t) => {
    const { root, workspace } = await fixture(t);
    await fs.mkdir(path.join(workspace, 'real'));
    await fs.writeFile(path.join(workspace, 'real', 'file.js'), 'data');
    await fs.symlink(workspace, path.join(root, 'alias'));
    await assert.rejects(inspectProject(path.join(root, 'alias'), '.'), code('PATH_OUTSIDE_WORKSPACE'));
    await assert.rejects(inspectProject(path.join(root, 'alias', 'real'), '.'), code('PATH_OUTSIDE_WORKSPACE'));
    await fs.symlink('real', path.join(workspace, 'link'));
    await assert.rejects(inspectProject(workspace, 'link'), code('PATH_OUTSIDE_WORKSPACE'));
    await fs.symlink('/etc/passwd', path.join(workspace, 'real', 'outside'));
    await assert.rejects(inspectProject(workspace, 'real'), code('PATH_OUTSIDE_WORKSPACE'));
});

test('hardlinks and special files are rejected without opening a blocking stream', async (t) => {
    const { root, workspace } = await fixture(t);
    await fs.writeFile(path.join(root, 'outside'), 'secret');
    await fs.link(path.join(root, 'outside'), path.join(workspace, 'linked'));
    await assert.rejects(inspectProject(workspace, '.'), code('PERMISSION_DENIED'));
    await fs.unlink(path.join(workspace, 'linked'));
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(path.join(workspace, 'socket'), resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await assert.rejects(inspectProject(workspace, '.'), code('UNSUPPORTED_PROJECT'));
});

test('snapshot validation reuses the canonical rules on a copy and never executes project JS', async (t) => {
    const paths = await packageFixture(t, { 'sub/game.js': 'throw new Error("NO EXECUTION");',
        'game.json': JSON.stringify({ appId: 'fixture', version: '1', subpackages: [{ name: 'sub', root: 'sub' }] }) });
    const original = await fs.readFile(path.join(paths.out, 'game.js'));
    const before = await fs.stat(path.join(paths.out, 'game.js'));
    const result = await validate(paths, async (snapshot, script) => {
        assert.notEqual(snapshot, paths.out);
        assert.ok(snapshot.startsWith(`${paths.staging}/validation-`));
        assert.equal(digest(await fs.readFile(script)), digest(validatorBytes));
        assert.equal((await fs.stat(script)).mode & 0o777, 0o400);
        assert.notEqual((await fs.stat(path.join(snapshot, 'game.js'))).ino, before.ino);
        return require(script).validateBilibili(snapshot);
    });
    assert.equal(result.appId, 'fixture');
    assert.deepEqual(result.packages.map((item) => item.name), ['main', 'sub']);
    assert.deepEqual(await fs.readFile(path.join(paths.out, 'game.js')), original);
    assert.equal((await fs.stat(path.join(paths.out, 'game.js'))).mtimeMs, before.mtimeMs);
    assert.deepEqual(await fs.readdir(paths.workspace), ['out']);
});

test('canonical validator rejects unsupported package formats, without a duplicate rule implementation', async (t) => {
    const paths = await packageFixture(t, { 'config.json': '{"isZip":true}' });
    await assert.rejects(validate(paths), /uncompressed Bilibili/);
    await fs.unlink(path.join(paths.out, 'config.json'));
    await fs.writeFile(path.join(paths.out, 'engine.wasm.br'), 'x');
    await assert.rejects(validate(paths), /WASM Brotli/);
    await fs.unlink(path.join(paths.out, 'engine.wasm.br'));
    await fs.writeFile(path.join(paths.out, 'game.json'), JSON.stringify({ appId: 'x', version: '1', plugins: { bad: {} } }));
    await assert.rejects(validate(paths), /plugins/);
});

test('inspection and validation work with a read-only workspace and read-only input files', async (t) => {
    const paths = await packageFixture(t);
    const files = await fs.readdir(paths.out);
    for (const name of files) await fs.chmod(path.join(paths.out, name), 0o444);
    await fs.chmod(paths.out, 0o555);
    await fs.chmod(paths.workspace, 0o555);
    try {
        assert.equal((await inspectProject(paths.workspace, 'out')).complete, true);
        assert.equal((await validate(paths)).appId, 'fixture');
        assert.deepEqual(await fs.readdir(paths.out), files);
        for (const name of files) assert.equal((await fs.stat(path.join(paths.out, name))).mode & 0o777, 0o444);
    } finally {
        await fs.chmod(paths.workspace, 0o755);
        await fs.chmod(paths.out, 0o755);
        for (const name of files) await fs.chmod(path.join(paths.out, name), 0o644);
    }
});

test('snapshots reject private files and directories instead of copying them', async (t) => {
    const paths = await packageFixture(t);
    for (const name of ['.env', '.env.production', '.envrc', '.git-credentials', 'server.key', 'id_ed25519', 'key.json', 'credentials.json', '.npmrc']) {
        await fs.writeFile(path.join(paths.out, name), 'DO_NOT_COPY');
        let called = false;
        await assert.rejects(validate(paths, () => { called = true; }), code('PERMISSION_DENIED'));
        assert.equal(called, false);
        await fs.unlink(path.join(paths.out, name));
    }
    await fs.mkdir(path.join(paths.out, '.git'));
    await assert.rejects(validate(paths), code('PERMISSION_DENIED'));
});

test('snapshot bounds reject oversized JSON, total bytes, depth and entry count before validation', async (t) => {
    const paths = await packageFixture(t);
    for (const [name, size] of [['large.json', MiB + 1], ['large.bin', 64 * MiB + 1]]) {
        const handle = await fs.open(path.join(paths.out, name), 'w');
        await handle.truncate(size);
        await handle.close();
        await assert.rejects(validate(paths), code('LIMIT_EXCEEDED'));
        await fs.unlink(path.join(paths.out, name));
    }
    for (const name of ['one.bin', 'two.bin']) {
        const handle = await fs.open(path.join(paths.out, name), 'w');
        await handle.truncate(33 * MiB);
        await handle.close();
    }
    await assert.rejects(validate(paths), code('LIMIT_EXCEEDED'));
    await fs.unlink(path.join(paths.out, 'one.bin'));
    await fs.unlink(path.join(paths.out, 'two.bin'));
    await fs.mkdir(path.join(paths.out, ...Array(33).fill('d')), { recursive: true });
    await assert.rejects(validate(paths), code('LIMIT_EXCEEDED'));
    await fs.rm(path.join(paths.out, 'd'), { recursive: true });
    await Promise.all(Array.from({ length: 10000 }, (_, index) => fs.writeFile(path.join(paths.out, `f${index}`), '')));
    await assert.rejects(validate(paths), code('LIMIT_EXCEEDED'));
});

test('snapshots require private owned staging outside the workspace and never follow staging symlinks', async (t) => {
    const paths = await packageFixture(t);
    await fs.mkdir(path.join(paths.workspace, 'state'), { mode: 0o700 });
    await assert.rejects(validate({ ...paths, staging: path.join(paths.workspace, 'state') }), code('PERMISSION_DENIED'));
    await fs.chmod(paths.staging, 0o755);
    await assert.rejects(validate(paths), code('PERMISSION_DENIED'));
    await fs.chmod(paths.staging, 0o700);
    await fs.symlink(paths.staging, path.join(paths.root, 'state-link'));
    await assert.rejects(validate({ ...paths, staging: path.join(paths.root, 'state-link') }), code('PATH_OUTSIDE_WORKSPACE'));
    assert.deepEqual(await fs.readdir(path.join(paths.workspace, 'state')), []);
});

test('input changes, including same-length writes with restored mtime, prevent snapshot success', async (t) => {
    const paths = await packageFixture(t);
    const file = path.join(paths.out, 'game.js');
    const stat = await fs.stat(file);
    await assert.rejects(validate(paths, async (snapshot, script) => {
        const result = require(script).validateBilibili(snapshot);
        await fs.writeFile(file, 'x'.repeat(stat.size));
        await fs.utimes(file, stat.atime, stat.mtime);
        return result;
    }), code('INPUT_CHANGED'));
    await assert.rejects(validate(paths, async () => {
        await fs.writeFile(path.join(paths.out, 'added'), 'new');
        return 'must not succeed';
    }), code('INPUT_CHANGED'));
});

test('replacing a project ancestor or mutating the private snapshot prevents success', async (t) => {
    const paths = await packageFixture(t);
    await assert.rejects(validate(paths, async () => {
        await fs.rename(paths.out, path.join(paths.workspace, 'moved'));
        await fs.mkdir(paths.out);
        return 'must not succeed';
    }), code('INPUT_CHANGED'));
    await fs.rmdir(paths.out);
    await fs.rename(path.join(paths.workspace, 'moved'), paths.out);
    await assert.rejects(validate(paths, async (snapshot) => {
        await fs.chmod(path.join(snapshot, 'game.js'), 0o600);
        await fs.writeFile(path.join(snapshot, 'game.js'), 'changed');
        return 'must not succeed';
    }), code('INPUT_CHANGED'));
});

test('the packaged validator is rehashed with pinned no-follow reads before use', async (t) => {
    const { root } = await fixture(t);
    const sdk = path.join(root, 'sdk');
    await fs.mkdir(path.join(sdk, 'app'), { recursive: true });
    const file = path.join(sdk, 'app', 'validate-bilibili.cjs');
    await fs.writeFile(file, validatorBytes);
    assert.deepEqual(await readSdkValidator(sdk, digest(validatorBytes)), validatorBytes);
    await assert.rejects(readSdkValidator(sdk, 'f'.repeat(64)), code('SDK_INCOMPLETE'));
    await assert.rejects(readSdkValidator(sdk, ''), code('SDK_INCOMPLETE'));
    await fs.unlink(file);
    await fs.symlink(new URL('../../../scripts/validate-bilibili.cjs', import.meta.url), file);
    await assert.rejects(readSdkValidator(sdk, digest(validatorBytes)), code('PATH_OUTSIDE_WORKSPACE'));
});

test('file replacement between lstat and open cannot redirect a pinned read', async (t) => {
    const { root, workspace } = await fixture(t);
    const input = path.join(workspace, 'file.js');
    await fs.writeFile(input, 'safe');
    await fs.writeFile(path.join(root, 'outside'), 'NEVER_READ');
    const original = promises.open;
    let swapped = false;
    promises.open = async (filename, flags, ...args) => {
        if (filename.endsWith('/file.js')) {
            assert.match(filename, /^\/proc\/self\/fd\/\d+\/file\.js$/);
            assert.ok(flags & constants.O_NOFOLLOW);
            assert.ok(flags & constants.O_NONBLOCK);
            swapped = true;
            await fs.unlink(input);
            await fs.symlink(path.join(root, 'outside'), input);
        }
        return original(filename, flags, ...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(inspectProject(workspace, '.'), code('PATH_OUTSIDE_WORKSPACE')); }
    finally { promises.open = original; syncBuiltinESMExports(); }
    assert.equal(swapped, true);
});

test('unverified hosts fail closed and a spent inspection time budget yields a partial diagnostic', async (t) => {
    const { workspace } = await fixture(t);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try { await assert.rejects(inspectProject(workspace, '.'), code('SDK_INCOMPLETE')); }
    finally { Object.defineProperty(process, 'platform', platform); }
    let calls = 0;
    Object.defineProperty(performance, 'now', { value: () => calls++ ? 6000 : 0, configurable: true });
    try {
        const result = await inspectProject(workspace, '.');
        assert.equal(result.complete, false);
        assert.equal(result.files, 0);
        assert.ok(result.diagnostics.some((item) => item.code === 'TIMEOUT'));
    } finally { delete performance.now; }
});

test('a renamed ancestor is detected before the pinned file handle is read', async (t) => {
    const { workspace } = await fixture(t);
    const project = path.join(workspace, 'project');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'file.js'), 'safe');
    const original = promises.open;
    let swapped = false;
    let read = false;
    promises.open = async (filename, flags, ...args) => {
        if (filename.endsWith('/file.js')) {
            swapped = true;
            await fs.rename(project, path.join(workspace, 'moved'));
            await fs.mkdir(project);
            await fs.writeFile(path.join(project, 'file.js'), 'UNAUTHORIZED');
        }
        const handle = await original(filename, flags, ...args);
        if (filename.endsWith('/file.js')) {
            const originalRead = handle.read.bind(handle);
            handle.read = (...readArgs) => { read = true; return originalRead(...readArgs); };
        }
        return handle;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(inspectProject(workspace, 'project'), code('INPUT_CHANGED')); }
    finally { promises.open = original; syncBuiltinESMExports(); }
    assert.equal(swapped, true);
    assert.equal(read, false);
});

test('staging cannot be created beneath a world-writable non-sticky ancestor', async (t) => {
    const paths = await packageFixture(t);
    await fs.mkdir(path.join(paths.root, 'unsafe'));
    await fs.chmod(path.join(paths.root, 'unsafe'), 0o777);
    await assert.rejects(validate({ ...paths, staging: path.join(paths.root, 'unsafe', 'job') }), code('PERMISSION_DENIED'));
    assert.deepEqual(await fs.readdir(path.join(paths.root, 'unsafe')), []);
});

test('inspection returns at its wall deadline even while a filesystem call is stalled', async (t) => {
    const { workspace } = await fixture(t);
    const original = promises.open;
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    let resumed;
    const finished = new Promise((resolve) => { resumed = resolve; });
    promises.open = async (...args) => {
        await blocked;
        resumed();
        throw Object.assign(new Error('Simulated stalled filesystem failure.'), { code: 'EIO' });
    };
    syncBuiltinESMExports();
    const started = performance.now();
    try {
        const result = await inspectProject(workspace, '.');
        assert.equal(result.complete, false);
        assert.ok(result.diagnostics.some((item) => item.code === 'TIMEOUT'));
        assert.ok(performance.now() - started < 6000);
    } finally {
        promises.open = original;
        syncBuiltinESMExports();
        release();
        await finished;
    }
});

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    return JSON.stringify(value);
}

async function sdkFixture(root) {
    // Synthetic catalog data, but the actual canonical executable validator.
    const sdkRoot = path.join(root, 'sdk');
    await fs.mkdir(path.join(sdkRoot, 'app'), { recursive: true });
    await fs.mkdir(path.join(sdkRoot, 'docs'));
    const sources = new Map([
        ['package.json', Buffer.from('{}')], ['cc.config.json', Buffer.from('{}')],
        ['scripts/validate-bilibili.cjs', validatorBytes], ['LICENSE', Buffer.from('MIT fixture')],
        ['README.md', Buffer.from('Read-only catalog fixture.')], ['AGENTS.md', Buffer.from('Never run project scripts.')],
        ['docs/bilibili_minigame/README.md', Buffer.from('Preflight only.')],
        ['docs/plans/cocos4-mcp-devkit.md', Buffer.from('Not a portable release.')],
    ]);
    const payload = new Map([['LICENSE', sources.get('LICENSE')], ['app/validate-bilibili.cjs', validatorBytes]]);
    const docs = [...sources.keys()].filter((name) => name.endsWith('.md')).map((sourcePath, index) => {
        const id = `guide-fixture-${index}`;
        const filename = `docs/${id}.md`;
        payload.set(filename, sources.get(sourcePath));
        return { id, kind: 'guide', title: `Fixture ${index}`, path: filename, sourcePath, sourceOffset: 0 };
    });
    const records = (map) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([filename, bytes]) => ({ path: filename, bytes: bytes.length, sha256: digest(bytes) }));
    const sourceFiles = records(sources);
    const manifest = {
        schemaVersion: 1, kind: 'readonly-development', engineVersion: 'test', description: 'Synthetic readonly catalog.',
        capabilities: { catalog: true, docs: true, packageValidation: ['BILIBILI'], gameDevelopment: false, gameBuild: false, preview: false, export: false },
        source: { sha256: digest(canonical(sourceFiles)), files: sourceFiles, attribution: 'Test data, not release provenance.' },
        license: { path: 'LICENSE', spdx: 'MIT' }, files: records(payload), docs,
        catalog: { platforms: [{ id: 'BILIBILI', engineTargetAllowed: true, prebuiltAvailable: false, exportAvailable: false, validationLevels: [] }],
            features: [{ id: 'base', modules: ['base'], dependentModules: [], dependentAssets: [], prebuiltAvailable: false }], profiles: [], templates: [] },
    };
    manifest.sdkId = `sha256-${digest(canonical(manifest))}`;
    await fs.writeFile(path.join(sdkRoot, 'manifest.json'), JSON.stringify(manifest));
    for (const [filename, bytes] of payload) await fs.writeFile(path.join(sdkRoot, filename), bytes);
    return sdkRoot;
}

async function workerRequest(t, request) {
    const worker = new Worker(new URL('../build/src/worker.js', import.meta.url), { workerData: request, execArgv: [], env: {}, stdout: true, stderr: true });
    t.after(() => worker.terminate());
    let output = '';
    worker.stdout.on('data', (data) => { output += data; });
    worker.stderr.on('data', (data) => { output += data; });
    const messages = [];
    await new Promise((resolve, reject) => {
        worker.on('message', (message) => messages.push(message));
        worker.on('error', reject);
        worker.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`Worker exited ${status}`)));
    });
    assert.equal(output, '');
    assert.equal(messages.filter((item) => item.type === 'result' || item.type === 'error').length, 1);
    for (const message of messages.filter((item) => item.type === 'log')) assert.equal(typeof message.text, 'string');
    return messages.at(-1);
}

test('real worker runs doctor and canonical snapshot preflight with exact result/log contracts', async (t) => {
    const paths = await packageFixture(t);
    const sdkRoot = await sdkFixture(paths.root);
    const request = { workspace: paths.workspace, staging: path.join(paths.staging, 'new-job'), sdkRoot };
    for (const depth of ['quick', 'full']) {
        const result = await workerRequest(t, { ...request, operation: 'doctor', input: { project: 'out', depth } });
        assert.equal(result.type, 'result', JSON.stringify(result));
        assert.match(result.report.summary, /not a portable game-development release/);
        assert.ok(result.report.items.some((item) => item.code === 'PROFILE_NOT_AVAILABLE'));
        assert.ok(result.report.validationLevels.includes('bounded-project-data'));
    }
    const result = await workerRequest(t, { ...request, operation: 'package_validate', input: { directory: 'out', target: 'BILIBILI' } });
    assert.equal(result.type, 'result', JSON.stringify(result));
    assert.ok(result.report.validationLevels.includes('bilibili-source-preflight'));
    assert.ok((await fs.readdir(request.staging)).some((name) => name.startsWith('validation-')));
    assert.deepEqual(await fs.readdir(paths.workspace), ['out']);
});

test('worker returns typed argument, artifact, and SDK-integrity errors rather than executing project code', async (t) => {
    const paths = await packageFixture(t);
    const sdkRoot = await sdkFixture(paths.root);
    const request = { workspace: paths.workspace, staging: paths.staging, sdkRoot, operation: 'package_validate' };
    const invalid = await workerRequest(t, { ...request, input: { directory: 'out', target: 'OPPO' } });
    assert.equal(invalid.type, 'error');
    assert.equal(invalid.error.code, 'INVALID_ARGUMENTS');
    const traversal = await workerRequest(t, { ...request, input: { directory: '../out' } });
    assert.equal(traversal.error.code, 'PATH_OUTSIDE_WORKSPACE');
    await fs.writeFile(path.join(paths.out, 'game.json'), '{}');
    const artifact = await workerRequest(t, { ...request, input: { directory: 'out' } });
    assert.equal(artifact.type, 'error');
    assert.equal(artifact.error.code, 'ARTIFACT_INVALID');
    await fs.writeFile(path.join(sdkRoot, 'app', 'validate-bilibili.cjs'), 'throw new Error("CORRUPT SDK MUST NOT EXECUTE");');
    const corrupt = await workerRequest(t, { ...request, input: { directory: 'out' } });
    assert.equal(corrupt.type, 'error');
    assert.equal(corrupt.error.code, 'SDK_INCOMPLETE');
});
