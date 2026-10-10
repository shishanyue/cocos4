// Maintainer-only host acceptance. Windows relocation and Linux namespaces are
// separate evidence scopes; neither establishes acceptance on a fresh VM.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hash, portablePaths, readRegular, safePath, verifyInventory } from './verify-portable.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const json = value => JSON.stringify(value, null, 2) + '\n';
const args = process.argv.slice(2);

async function verifyWindowsHost() {
    const flags = new Map();
    for (let index = 0; index < args.length; index += 2) {
        assert(['--release', '--browser', '--evidence'].includes(args[index]) && !flags.has(args[index])
            && args[index + 1] && path.isAbsolute(args[index + 1]),
        'Usage: node scripts/verify-portable-host.mjs --release ABSOLUTE [--browser ABSOLUTE_CHROMIUM] [--evidence ABSENT_ABSOLUTE_DIRECTORY]');
        flags.set(args[index], args[index + 1]);
    }
    assert(flags.has('--release'));
    assert.equal(process.arch, 'x64', 'Windows portable acceptance requires an x64 host process');
    const release = await fs.realpath(flags.get('--release'));
    const root = flags.get('--evidence') ? path.resolve(flags.get('--evidence'))
        : await fs.mkdtemp(path.join(await fs.realpath(process.env.USERPROFILE), 'cocos4-portable-'));
    if (flags.has('--evidence')) await fs.mkdir(root, { mode: 0o700 });
    const result = { schemaVersion: 1, startedAt: new Date().toISOString(), success: false, node: process.version,
        scope: 'Windows archive relocation, pinned runtime and full delivered-profile workflow. Host source and network remain available; not a clean VM or vendor/device/model approval.',
        isolation: { fullVM: false, networkIsolated: false, sourceHidden: false, readOnlyMount: false,
            emptyPath: true, relocated: true, userProfileIsolated: true } };
    const write = (name, value) => fs.writeFile(path.join(root, name), json(value), { flag: 'wx', mode: 0o600 });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ['systemroot', 'windir', 'temp', 'tmp'].includes(key.toLowerCase())));
    environment.PATH = '';
    let interrupted = false, active;
    const stop = () => { interrupted = true; active?.kill(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
        const manifest = await verifyInventory(release);
        assert.equal(manifest.host.platform, 'win32');
        result.releaseId = manifest.releaseId; result.sdkId = manifest.sdk.sdkId;
        const receipt = JSON.parse(await fs.readFile(`${release}.build.json`));
        assert.equal(receipt.releaseId, manifest.releaseId);
        const archive = `${release}.zip`, archiveRoot = `cocos4-devkit-${manifest.kitVersion}-win32-x64`;
        const { verifyWindowsArchive } = await import('./windows-archive.mjs');
        const archiveHash = async () => hash(await readRegular(path.dirname(archive), path.basename(archive), 2 * 1024 ** 3));
        result.archiveSha256 = await archiveHash();
        assert.equal(result.archiveSha256, receipt.archiveSha256);
        const inventory = await verifyWindowsArchive(archive, archiveRoot);
        assert.deepEqual(inventory.filter(item => item.type === 'file').map(item => item.name.slice(archiveRoot.length + 1)).sort(),
            [...manifest.files.map(item => item.path), 'release.json'].sort());
        const powershell = path.join(process.env.SystemRoot ?? process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const identity = (await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
            '$id=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=[Security.Principal.WindowsPrincipal]::new($id); @{sid=$id.User.Value; elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress'],
        { env: environment, timeout: 10000, windowsHide: true })).stdout;
        result.identity = JSON.parse(identity);
        result.isolation.nonAdministrator = result.identity.elevated === false;
        // A fresh evidence root belongs only to this run. Protect it before the
        // delivered helper validates its own relocated chain and private jobs.
        // Do not change permissions on the caller's release or parent folders.
        const icacls = path.join(process.env.SystemRoot ?? process.env.WINDIR, 'System32/icacls.exe');
        assert.match(result.identity.sid, /^S-1-5-21-(?:\d+-){3}\d+$/);
        await exec(icacls, [root, '/inheritance:r', '/grant:r',
            `*${result.identity.sid}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)'],
        { env: environment, timeout: 10000, windowsHide: true });
        const relocatedParent = path.join(root, `relocated kit 中文 ${'long-path-'.repeat(8)}`);
        // PowerShell 5.1 extraction retains its legacy MAX_PATH limit. Extract
        // normally to a short path, then test the unchanged kit after relocation.
        const extractedParent = path.join(root, 'extracted');
        const quote = value => `'${value.replaceAll("'", "''")}'`;
        const extractionStarted = Date.now(), extractionTimeoutMs = 600000;
        result.extraction = { tool: 'Windows PowerShell Expand-Archive', initialDestination: extractedParent,
            timeoutMs: extractionTimeoutMs, completed: false };
        await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extractedParent)} -ErrorAction Stop`],
        { env: environment, timeout: extractionTimeoutMs, windowsHide: true });
        await fs.mkdir(relocatedParent);
        const relocated = path.join(relocatedParent, archiveRoot);
        await fs.rename(path.join(extractedParent, archiveRoot), relocated);
        assert.equal((await verifyInventory(relocated)).releaseId, manifest.releaseId);
        result.extraction = { tool: 'Windows PowerShell Expand-Archive', initialDestination: extractedParent,
            timeoutMs: extractionTimeoutMs, elapsedMs: Date.now() - extractionStarted, completed: true,
            relocation: 'node:fs.rename to Unicode/long path', fileAttributesRepaired: false,
            legacyExtractorLongPathsSupported: false };
        const beforeDoctor = await fs.readdir(root);
        const doctorProcess = await exec(path.join(relocated, portablePaths('win32').launcher), ['doctor'], {
            cwd: relocated, env: { ...environment, HOME: '', USERPROFILE: '', APPDATA: '', LOCALAPPDATA: '' },
            timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024,
        });
        assert.equal(doctorProcess.stderr, '');
        const doctor = JSON.parse(doctorProcess.stdout);
        assert.equal(doctor.success, true); assert.equal(doctor.scope, 'sdk-only');
        assert.equal(doctor.releaseId, manifest.releaseId); assert.equal(doctor.sdkId, manifest.sdk.sdkId);
        assert.deepEqual(await fs.readdir(root), beforeDoctor, 'SDK-only doctor must not create private state');
        result.sdkOnlyDoctor = { success: true, homeRequired: false, privateStateCreated: false };
        await write('doctor.json', doctor);
        const home = path.join(root, 'driver-home');
        await fs.mkdir(home, { mode: 0o700 });
        Object.assign(environment, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'),
            LOCALAPPDATA: path.join(home, 'Local'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
        let browserHarness;
        let browserEnvironment, browserProfiles;
        if (flags.has('--browser')) {
            const browser = await fs.realpath(flags.get('--browser'));
            const harness = path.join(root, 'harness');
            for (const directory of ['test', 'runtime/node_modules', 'build']) await fs.mkdir(path.join(harness, directory), { recursive: true });
            const bytes = await fs.readFile(path.join(devkit, 'test/browser-game.mjs'));
            await fs.writeFile(path.join(harness, 'test/browser-game.mjs'), bytes, { flag: 'wx' });
            await fs.writeFile(path.join(harness, 'runtime/package.json'), '{"private":true}\n', { flag: 'wx' });
            const require = createRequire(path.join(devkit, 'runtime/package.json'));
            const drivers = [];
            for (const name of ['playwright-core', 'pngjs']) {
                const directory = await fs.realpath(path.dirname(require.resolve(`${name}/package.json`)));
                const bytes = await fs.readFile(path.join(directory, 'package.json')), pkg = JSON.parse(bytes);
                assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'Review any new browser harness dependencies');
                await fs.cp(directory, path.join(harness, 'runtime/node_modules', name), { recursive: true, dereference: false });
                drivers.push({ name, version: pkg.version, packageSha256: hash(bytes) });
            }
            result.browser = { executable: browser, executableSha256: hash(await fs.readFile(browser)),
                testSha256: hash(bytes), drivers, scope: 'Explicit external browser/test harness; not a shipped application dependency.' };
            browserEnvironment = {};
            for (const name of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
                'HOMEDRIVE', 'HOMEPATH', 'SystemDrive', 'COMSPEC']) {
                const source = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
                if (source) browserEnvironment[name] = process.env[source];
            }
            browserEnvironment.PATH = path.join(browserEnvironment.SystemRoot, 'System32');
            browserProfiles = path.join(root, 'browser-profiles');
            await fs.mkdir(browserProfiles);
            result.browser.environment = browserEnvironment;
            result.browser.userDataDirectoryRoot = browserProfiles;
            result.isolation.browserUsesRealWindowsEnvironment = true;
            browserHarness = pathToFileURL(path.join(harness, 'test/browser-game.mjs')).href;
        }
        const node = path.join(relocated, portablePaths('win32').node);
        const workflowDirectory = path.join(root, 'workflow');
        const workflowTimeoutMs = 5400000;
        const probe = `const [kit,evidence,harness,browser,browserEnv,profiles]=process.argv.slice(1);const {pathToFileURL}=await import('node:url');const path=await import('node:path');const {verifyWorkflow}=await import(pathToFileURL(path.join(kit,'app/verify-portable.mjs')));const verifyBrowser=harness?(await import(harness)).verifyBrowserGame:undefined;await verifyWorkflow(kit,evidence,verifyBrowser&&(options=>verifyBrowser({...options,executablePath:browser,browserEnvironment:JSON.parse(browserEnv),userDataDirectory:path.join(profiles,options.artifact.profile+'-'+options.artifact.variant)})));`;
        const argv = ['--no-global-search-paths', '--input-type=module', '-e', probe, relocated, workflowDirectory,
            browserHarness ?? '', result.browser?.executable ?? '', JSON.stringify(browserEnvironment ?? {}), browserProfiles ?? ''];
        await write('command.json', { executable: node, args: argv, environment, sourceExecutable: process.execPath,
            node: process.version, release, timeoutMs: workflowTimeoutMs });
        const log = await fs.open(path.join(root, 'workflow.log'), 'wx', 0o600);
        try {
            assert(!interrupted, 'Acceptance interrupted');
            result.process = await new Promise((resolve, reject) => {
                active = spawn(node, argv, { cwd: home, env: environment, shell: false, windowsHide: true,
                    stdio: ['ignore', log.fd, log.fd] });
                const timer = setTimeout(stop, workflowTimeoutMs);
                active.once('error', error => { clearTimeout(timer); reject(error); });
                active.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, interrupted }); });
            });
        } finally { active = undefined; await log.close(); }
        assert.deepEqual(result.process, { code: 0, signal: null, interrupted: false });
        const workflow = JSON.parse(await fs.readFile(path.join(workflowDirectory, 'report.json')));
        assert.equal(workflow.success, true); assert.equal(workflow.payloadUnchanged, true); assert.equal(workflow.stderr, '');
        assert.equal(workflow.releaseId, manifest.releaseId);
        assert.equal(workflow.jobs.filter(page => page.job.operation === 'game_build').length, manifest.sdk.profiles.length);
        assert.equal(workflow.exports.length, manifest.sdk.profiles.length);
        assert.equal(workflow.previews.length, 4);
        result.browserRenderingTested = workflow.browserRenderingTested;
        if (flags.has('--browser')) {
            assert.equal(workflow.browserRenderingTested, true);
            assert.equal(workflow.browsers.length, 4);
            assert(workflow.browsers.every(item => item.report.success));
        }
        assert.equal((await verifyInventory(relocated)).releaseId, manifest.releaseId);
        assert.equal((await verifyInventory(release)).releaseId, manifest.releaseId);
        assert.equal(await archiveHash(), result.archiveSha256);
        assert(!interrupted, 'Acceptance interrupted');
        result.success = true;
    } catch (error) {
        result.error = error.stack ?? String(error);
        if ('killed' in error) result.failedProcess = { code: error.code, signal: error.signal, killed: error.killed,
            stderr: typeof error.stderr === 'string' ? error.stderr.slice(0, 4096) : null };
    }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    result.interrupted = interrupted;
    result.finishedAt = new Date().toISOString();
    await write('result.json', result);
    process.stdout.write(json({ success: result.success, evidence: root, result: path.join(root, 'result.json') }));
    process.exitCode = result.success ? 0 : 1;
}

if (process.platform === 'win32') {
    await verifyWindowsHost();
} else {
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
        assert.equal(workflow.jobs.filter(page => page.job.operation === 'game_build').length, manifest.sdk.profiles.length);
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
}
