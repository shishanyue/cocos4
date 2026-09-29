// Maintainer-only Linux namespace acceptance, not a substitute for a fresh VM.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hash, readRegular, safePath, verifyInventory } from './verify-portable.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const json = value => JSON.stringify(value, null, 2) + '\n';
const args = process.argv.slice(2);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.notEqual(process.getuid(), 0, 'Run acceptance without administrator privileges');

if (args[0] !== '--run') {
    assert(args[0] === '--release' && path.isAbsolute(args[1])
        && (args.length === 2 || (args.length === 4 && args[2] === '--browser' && path.isAbsolute(args[3]))),
        'Usage: node scripts/verify-portable-host.mjs --release ABSOLUTE [--browser ABSOLUTE_CHROMIUM]');
    const release = await fs.realpath(args[1]);
    const root = await fs.mkdtemp(path.join(devkit, 'build/portable-host-'));
    const source = path.join(root, 'source');
    await fs.mkdir(source, { mode: 0o700 });
    const inputs = [];
    for (const name of ['verify-portable-host.mjs', 'verify-portable.mjs']) {
        const bytes = await fs.readFile(path.join(path.dirname(script), name));
        await fs.writeFile(path.join(source, name), bytes, { flag: 'wx', mode: 0o400 });
        inputs.push({ name, sha256: hash(bytes) });
    }
    await fs.writeFile(path.join(root, 'command.json'), json({ release, executable: process.execPath,
        node: process.version, inputs, browser: args[3], devkit, timeoutMs: 1800000 }), { flag: 'wx', mode: 0o600 });
    const log = await fs.open(path.join(root, 'runner.log'), 'wx', 0o600);
    try {
        const child = spawn(process.execPath, [path.join(source, 'verify-portable-host.mjs'), '--run', root],
            { env, detached: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
        child.unref();
        console.log(JSON.stringify({ state: 'running', pid: child.pid, evidence: root, result: path.join(root, 'result.json') }));
    } finally { await log.close(); }
} else {
    assert(args.length === 2 && path.isAbsolute(args[1]));
    const root = args[1];
    const command = JSON.parse(await fs.readFile(path.join(root, 'command.json')));
    const result = { startedAt: new Date().toISOString(), success: false, node: process.version,
        scope: 'Non-admin Linux mount/PID/user/network namespaces; not a new VM, other OS or AI-model acceptance. Browser rendering requires the explicit browser option.' };
    try {
        const manifest = await verifyInventory(command.release);
        result.releaseId = manifest.releaseId;
        result.sdkId = manifest.sdk.sdkId;
        const receipt = JSON.parse(await fs.readFile(`${command.release}.build.json`));
        assert.equal(receipt.releaseId, manifest.releaseId);
        const archive = `${command.release}.tar.gz`;
        const archiveHash = async () => hash(await readRegular(path.dirname(archive), path.basename(archive), 2 * 1024 ** 3));
        result.archiveSha256 = await archiveHash();
        assert.equal(result.archiveSha256, receipt.archiveSha256);
        const archiveRoot = `cocos4-devkit-${manifest.kitVersion}-linux-x64`;
        const expected = new Set([archiveRoot + '/']);
        for (const file of [...manifest.files.map(item => item.path), 'release.json']) {
            expected.add(`${archiveRoot}/${file}`);
            for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) {
                expected.add(`${archiveRoot}/${parent}/`);
            }
        }
        const listing = (await exec('/usr/bin/tar', ['-tzf', archive], { env, timeout: 60000, maxBuffer: 4 * 1024 ** 2 })).stdout.trimEnd().split('\n');
        assert.equal(new Set(listing).size, listing.length, 'Duplicate archive members');
        assert(listing.every(name => safePath(name.replace(/\/$/, ''))), 'Unsafe archive member');
        assert.deepEqual([...listing].sort(), [...expected].sort(), 'Archive differs from the release inventory');
        const relocated = path.join(root, `relocated kit \u4e2d\u6587 ${'long-path-'.repeat(8)}`);
        await fs.mkdir(relocated, { mode: 0o700 });
        await exec('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '--same-permissions', '-C', relocated],
            { env, timeout: 120000, maxBuffer: 1024 * 1024 });
        await fs.chmod(relocated, 0o555);
        assert.equal((await verifyInventory(relocated)).releaseId, manifest.releaseId);
        const isolated = path.join(root, 'isolated');
        await fs.mkdir(isolated, { mode: 0o700 });
        const mount = '/opt/Cocos4 relocated \u4e2d\u6587 ' + 'long-path-'.repeat(8);
        const namespaceArgs = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
            '--ro-bind', '/usr/lib', '/usr/lib', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', relocated, mount,
            '--bind', isolated, '/evidence', '--chdir', '/tmp', '--clearenv', '--setenv', 'PATH', '',
            '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8'];
        for (const name of ['/usr/lib/node_modules', '/usr/lib/node']) {
            try { if ((await fs.stat(name)).isDirectory()) namespaceArgs.push('--tmpfs', name); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (command.browser) {
            const browser = await fs.realpath(command.browser);
            const harness = path.join(root, 'harness');
            for (const name of ['test', 'runtime/node_modules', 'build']) await fs.mkdir(path.join(harness, name), { recursive: true, mode: 0o700 });
            const browserTest = await fs.readFile(path.join(command.devkit, 'test/browser-game.mjs'));
            await fs.writeFile(path.join(harness, 'test/browser-game.mjs'), browserTest, { flag: 'wx', mode: 0o400 });
            await fs.writeFile(path.join(harness, 'runtime/package.json'), '{"private":true}\n', { flag: 'wx', mode: 0o400 });
            const require = createRequire(path.join(command.devkit, 'runtime/package.json'));
            const drivers = [];
            for (const name of ['playwright-core', 'pngjs']) {
                const directory = await fs.realpath(path.dirname(require.resolve(`${name}/package.json`)));
                const bytes = await fs.readFile(path.join(directory, 'package.json')), pkg = JSON.parse(bytes);
                assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'Review and copy any new harness dependency closure');
                await fs.cp(directory, path.join(harness, 'runtime/node_modules', name), { recursive: true, dereference: false });
                drivers.push({ name, version: pkg.version, packageSha256: hash(bytes) });
            }
            const output = path.join(isolated, 'browser');
            await fs.mkdir(output, { mode: 0o700 });
            namespaceArgs.push('--ro-bind', harness, '/harness', '--bind', output, '/harness/build',
                '--ro-bind', path.dirname(browser), '/browser', '--ro-bind', '/usr/share/fonts', '/usr/share/fonts',
                '--ro-bind', '/etc/fonts', '/etc/fonts', '--ro-bind', '/usr/share/fontconfig', '/usr/share/fontconfig');
            result.browser = { executableSha256: hash(await fs.readFile(browser)),
                testSha256: hash(browserTest), drivers, executable: `/browser/${path.basename(browser)}`,
                driver: 'Separate explicit test harness; not an installed application dependency or a source checkout mount.' };
        }
        // Only OS shared libraries and this package are readable. No host root,
        // executables, checkout, user home, credentials or dependency cache mounts.
        const probe = async (kit, original, browser) => {
            const assert = (await import('node:assert/strict')).default;
            const fs = await import('node:fs/promises');
            const os = await import('node:os');
            const { pathToFileURL } = await import('node:url');
            assert.notEqual(process.getuid(), 0);
            assert.equal(process.env.PATH, '');
            assert.equal(process.version, 'v24.21.0');
            assert.equal(await fs.realpath(process.execPath), `${kit}/runtime/node`);
            const absent = ['/home', '/root', '/usr/bin', '/bin', '/etc/passwd', '/etc/resolv.conf', original];
            for (const name of absent) await assert.rejects(fs.stat(name), { code: 'ENOENT' });
            for (const name of ['/usr/lib/node_modules', '/usr/lib/node']) {
                try { assert.deepEqual(await fs.readdir(name), []); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            const interfaces = os.networkInterfaces();
            assert(Object.values(interfaces).flat().every(address => address.internal), 'External network interface visible');
            await assert.rejects(fetch('http://203.0.113.1', { signal: AbortSignal.timeout(1000) }));
            await assert.rejects(fs.writeFile(`${kit}/not-allowed`, 'test', { flag: 'wx' }), { code: 'EROFS' });
            await fs.writeFile('/evidence/isolation.json', JSON.stringify({ uid: process.getuid(), execPath: process.execPath,
                interfaces, absent, emptyPath: true, readOnlyMount: true, fullVM: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            const { verifyWorkflow } = await import(pathToFileURL(`${kit}/app/verify-portable.mjs`).href);
            const verifyBrowser = browser ? (await import('file:///harness/test/browser-game.mjs')).verifyBrowserGame : undefined;
            await verifyWorkflow(kit, '/evidence/workflow', verifyBrowser && (options => verifyBrowser({ ...options, executablePath: browser })));
        };
        namespaceArgs.push(`${mount}/runtime/node`, '-e', `(${probe.toString()})(...process.argv.slice(1)).catch(error => { console.error(error); process.exitCode = 1; });`, mount, command.release, result.browser?.executable ?? '');
        await fs.writeFile(path.join(root, 'namespace-command.json'), json({ executable: '/usr/bin/bwrap', args: namespaceArgs }), { flag: 'wx', mode: 0o600 });
        const log = await fs.open(path.join(root, 'workflow.log'), 'wx', 0o600);
        try {
            result.process = await new Promise((resolve, reject) => {
                const child = spawn('/usr/bin/bwrap', namespaceArgs, { env, detached: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
                let interrupted = false, killTimer;
                const stop = () => {
                    interrupted = true;
                    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                    killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 5000);
                };
                const timer = setTimeout(stop, command.timeoutMs);
                process.once('SIGINT', stop); process.once('SIGTERM', stop);
                child.once('error', error => { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); reject(error); });
                child.once('close', (code, signal) => {
                    clearTimeout(timer); clearTimeout(killTimer);
                    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
                    resolve({ code, signal, interrupted });
                });
            });
        } finally { await log.close(); }
        assert.deepEqual(result.process, { code: 0, signal: null, interrupted: false });
        const workflow = JSON.parse(await fs.readFile(path.join(isolated, 'workflow/report.json')));
        assert.equal(workflow.success, true); assert.equal(workflow.payloadUnchanged, true); assert.equal(workflow.stderr, '');
        assert.equal(workflow.releaseId, manifest.releaseId);
        assert.equal(workflow.jobs.filter(page => page.job.operation === 'game_build').length, 8);
        assert.equal(workflow.previews.length, 4);
        if (command.browser) {
            assert.equal(workflow.browserRenderingTested, true);
            assert.equal(workflow.browsers.length, 4);
            assert(workflow.browsers.every(item => item.report.success), 'Every browser report must pass');
        }
        assert.equal((await verifyInventory(relocated)).releaseId, manifest.releaseId);
        assert.equal((await verifyInventory(command.release)).releaseId, manifest.releaseId);
        assert.equal(await archiveHash(), result.archiveSha256);
        result.success = true;
    } catch (error) { result.error = error.stack ?? String(error); }
    result.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(root, 'result.json'), json(result), { flag: 'wx', mode: 0o600 });
    process.exitCode = result.success ? 0 : 1;
}
