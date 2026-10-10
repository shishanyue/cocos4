// Maintainer verification with retained evidence. A running marker is never a pass.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hostEnvironmentKeys = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'ProgramFiles', 'ProgramFiles(x86)', 'WindowsSdkDir', 'COCOS4_WINDOWS_COMPILER'];
const environmentKeys = new Set([...hostEnvironmentKeys,
    'GAME_OPERATION_SDK_ROOT', 'GAME_SDK_INTEGRATION', 'GAME_CHROME_EXECUTABLE', 'GAME_SDK_RUNTIME_ROOT', 'GAME_TEST_BUILD_PREFIX',
    'COCOS4_PREVIEW_BROWSER',
    'COMBINED_SDK_ROOT', 'LEGACY_HTML5_SDK_ROOT', 'API_DOCS_SDK_ROOT', 'API_DOCS_LEGACY_SDK_ROOT', 'AI_TEST_SDK_ROOT', 'AI_TEST_EVIDENCE_ROOT',
    'BILIBILI_PACKAGE_SDK', 'BILIBILI_SDK_BASE_ROOT', 'BILIBILI_RUNTIME_DIRECTORIES', 'BILIBILI_SDK_2D_RUNTIME', 'BILIBILI_SDK_3D_RUNTIME',
    'BILIBILI_DEVELOPMENT_TEST_BUILD_PREFIX', 'BILIBILI_PACKAGE_TEST_BUILD_PREFIX',
    'LOGIC_TEST_SDK_ROOT', 'LOGIC_EVIDENCE_ROOT',
    'RUNTIME_INTEGRATION', 'RUNTIME_COMPILER_FIXTURES', 'RUNTIME_TOOLCHAIN', 'RUNTIME_CHROME', 'RUNTIME_BUILTINS_2D', 'RUNTIME_BUILTINS_3D',
    'RELEASE_GAME_SDK_ROOT', 'RELEASE_GAME_INTEGRATION', 'RELEASE_RUNTIME_ROOT', 'RELEASE_LOCAL_REPORT_ROOT',
    'PORTABLE_STARTUP_RELEASE', 'PORTABLE_STARTUP_NODE']);
const testArguments = ['--test', '--test-reporter=tap', '--test-concurrency=2', 'build/probes/mcp-client.js'];
// The complete compiler/browser matrix shares CI's two-hour allowance; job deadlines are independent.
const maximumTimeout = 7200000;
const graceMs = 5000;
const cleanupScope = process.platform === 'win32'
    ? 'Own Job Object only; creation-time association, no breakaway, observed runner exit and zero active processes. Not an OS sandbox.'
    : 'Own process group only; setsid escapes and orphan descendant reaping are not established.';
const json = (root, name, value) => fs.writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const testFiles = async () => (await fs.readdir(path.join(devkit, 'test'))).filter(file => file.endsWith('.test.mjs')).sort().map(file => `test/${file}`);

export function testEnvironment(source, strict = false) {
    const canonical = new Map([...environmentKeys].map(key => [key.toUpperCase(), key]));
    const environment = Object.fromEntries(Object.entries(source).flatMap(([key, value]) => {
        const name = process.platform === 'win32' ? canonical.get(key.toUpperCase()) : environmentKeys.has(key) && key;
        return name ? [[name, value]] : [];
    }));
    if (strict) {
        const required = [...environmentKeys].filter(key => ![...hostEnvironmentKeys,
            'GAME_TEST_BUILD_PREFIX', 'BILIBILI_DEVELOPMENT_TEST_BUILD_PREFIX', 'BILIBILI_PACKAGE_TEST_BUILD_PREFIX',
            'AI_TEST_EVIDENCE_ROOT', 'LOGIC_EVIDENCE_ROOT', 'PORTABLE_STARTUP_NODE', 'COCOS4_PREVIEW_BROWSER'].includes(key));
        const missing = required.filter(key => !environment[key]
            || (key.endsWith('_INTEGRATION') && environment[key] !== '1'));
        assert.equal(missing.length, 0, `Missing strict integration inputs: ${missing.join(', ')}`);
    }
    return environment;
}

export function auditTap(output) {
    const totals = {};
    for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
        const matches = [...output.matchAll(new RegExp(`^# ${field} (\\d+)\\r?$`, 'gm'))];
        totals[field] = matches.length === 1 ? Number(matches[0][1]) : null;
    }
    const complete = Object.values(totals).every(Number.isSafeInteger) && totals.tests > 0
        && totals.tests === totals.pass + totals.fail + totals.cancelled + totals.skipped + totals.todo
        && /# todo \d+\r?\n# duration_ms [\d.]+\s*$/.test(output);
    return { totals, complete, allPassed: complete && totals.pass === totals.tests };
}

async function readCommand(root) {
    const command = JSON.parse(await fs.readFile(path.join(root, 'command.json')));
    // Retained commands are evidence, not an arbitrary executable/argument interface.
    assert.equal(command.executable, process.execPath);
    assert.equal(command.node, process.version);
    assert.equal(command.cwd, devkit);
    assert.deepEqual(command.args.slice(0, testArguments.length), testArguments);
    const files = command.args.slice(testArguments.length);
    assert(files.length && new Set(files).size === files.length);
    for (const file of files) {
        assert(/^test\/[A-Za-z0-9.-]+\.test\.mjs$/.test(file), 'Selection must contain test files only');
        assert((await fs.lstat(path.join(devkit, file))).isFile(), `Not a regular test file: ${file}`);
    }
    assert(Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0 && command.timeoutMs <= maximumTimeout);
    assert(Object.entries(command.environment).every(([key, value]) => environmentKeys.has(key) && typeof value === 'string'));
    if (command.strict) {
        assert.equal(command.fullMatrix, true, '--strict requires the full test matrix');
        assert.deepEqual(files, await testFiles());
    }
    return command;
}

async function supervise(command) {
    assert.equal(process.platform, 'linux');
    assert(process.send, 'Internal supervisor requires IPC');
    const stat = await fs.readFile('/proc/self/stat', 'utf8');
    assert.equal(Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]), process.pid, 'Supervisor must own its process group');
    const send = message => { if (process.connected) process.send(message, () => {}); };
    let stopping = false;
    let finishing = false;
    // The live supervisor anchors the PGID. Never signal a saved/reused PGID from
    // the parent, even if this supervisor unexpectedly dies.
    const finish = () => {
        if (finishing) return;
        finishing = true;
        const kill = () => process.kill(-process.pid, 'SIGKILL');
        setTimeout(kill, 1000);
        if (process.connected) process.send({ type: 'cleanup', signal: 'SIGKILL' }, kill);
        else kill();
    };
    const stop = trigger => {
        if (stopping || finishing) return;
        stopping = true;
        send({ type: 'interruption', trigger, at: new Date().toISOString() });
        setTimeout(finish, graceMs);
        process.kill(-process.pid, 'SIGTERM');
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('disconnect', () => stop('parent-disconnect'));
    process.on('message', message => { if (message.type === 'stop') stop(message.trigger); });
    const timer = setTimeout(() => stop('timeout'), command.timeoutMs);
    const child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.environment,
        shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
    send({ type: 'spawned', pid: child.pid });
    child.once('error', error => send({ type: 'test-error', error: String(error.stack ?? error) }));
    child.once('close', (code, signal) => {
        clearTimeout(timer);
        send({ type: 'test-exit', code, signal });
        if (!stopping) finish();
        // Keep the group alive until escalation, even when the test leader exits.
    });
}

async function windowsHelper() {
    const file = path.join(devkit, 'build/host/cocos4-supervise.exe');
    const manifest = JSON.parse(await fs.readFile(path.join(devkit, 'build/host/supervisor.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.platform, 'win32'); assert.equal(manifest.arch, process.arch);
    assert.equal(manifest.file, 'cocos4-supervise.exe');
    const entry = await fs.lstat(file), bytes = await fs.readFile(file);
    assert(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, 'Expected the built regular Job Object helper');
    assert.equal(bytes.length, manifest.bytes); assert.equal(hash(bytes), manifest.sha256);
    assert.equal(hash(await fs.readFile(path.join(devkit, 'runtime/supervise-win32.c'))), manifest.sourceSha256,
        'Rebuild the Windows supervisor after source changes');
    return file;
}

function windowsIdentity(value) {
    assert(value && value.platform === 'win32' && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 0xffffffff);
    assert(typeof value.creationTime === 'string' && /^\d+$/.test(value.creationTime));
    return value;
}

async function ownerIdentity(helper) {
    return new Promise((resolve, reject) => {
        const child = spawn(helper, ['--identity', String(process.pid)], {
            windowsHide: true, shell: false, env: {}, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '', exceeded = false;
        const timer = setTimeout(() => { exceeded = true; child.kill(); }, 5000);
        child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 2048) { exceeded = true; child.kill(); } });
        child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 2048) { exceeded = true; child.kill(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            try {
                assert(!exceeded && !stderr && !signal && code === 0 && stdout.endsWith('\n'), 'Windows owner identity failed');
                const event = JSON.parse(stdout);
                assert(event.version === 1 && event.platform === 'win32' && event.type === 'identity' && event.alive === true);
                const identity = windowsIdentity(event.process); assert.equal(identity.pid, process.pid);
                resolve(identity);
            } catch (error) { reject(error); }
        });
    });
}

// The helper deliberately starts with an OS-only environment. This trusted
// wrapper restores only the retained allowlist for the actual Node test child.
// It remains inside the same non-breakaway Job as every test descendant.
async function windowsTest(command) {
    assert.equal(process.platform, 'win32'); assert(process.send, 'Internal Windows runner requires IPC');
    testEnvironment(command.environment, command.strict);
    const child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.environment,
        shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('spawn', () => process.send({ type: 'spawned', pid: child.pid }, () => {}));
    child.once('error', error => process.send({ type: 'test-error', error: String(error.stack ?? error) }, () => {}));
    child.once('close', (code, signal) => {
        process.exitCode = code === 0 && !signal ? 0 : 1;
        process.send({ type: 'test-exit', code, signal }, () => process.disconnect());
    });
}

async function superviseWindows(root, command, log, status, interruptions, setStop) {
    const helper = await windowsHelper(), owner = await ownerIdentity(helper);
    let protocol = '', pending = '', ready = false, started = false, exited = false, stopping = false, closed = false;
    await new Promise((resolve, reject) => {
        const child = spawn(helper, ['--owner', String(owner.pid), owner.creationTime, '--cwd', command.cwd, '--ipc', '--',
            command.executable, script, '--windows-test', root], {
            cwd: command.cwd, env: {}, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', log.fd, 'ipc'],
        });
        let stopSent = false, forceTimer;
        const stop = () => {
            if (stopSent || closed) return;
            stopSent = true; child.stdin.end('T');
            forceTimer = setTimeout(() => {
                status.error ??= 'Windows supervisor did not confirm Job cleanup within ten seconds';
                // Killing this exact child closes its sole Job handle. Without
                // treeClosed evidence it can never turn into a successful run.
                child.kill();
            }, 10000);
        };
        const fail = error => { status.error ??= String(error.stack ?? error); stop(); };
        const readyTimer = setTimeout(() => fail(new Error('Windows supervisor did not become ready within five seconds')), 5000);
        setStop(stop);
        child.stdin.on('error', fail);
        child.once('error', error => { clearTimeout(readyTimer); clearTimeout(forceTimer); reject(error); });
        child.on('message', message => {
            try {
                assert(ready && message && typeof message === 'object');
                if (message.type === 'spawned') {
                    assert(!status.testPid && Number.isSafeInteger(message.pid) && message.pid > 0);
                    status.testPid = message.pid;
                } else if (message.type === 'test-exit') {
                    assert(status.testPid && !status.testLeaderReaped);
                    assert(message.code === null || Number.isSafeInteger(message.code));
                    assert(message.signal === null || typeof message.signal === 'string');
                    Object.assign(status, { code: message.code, signal: message.signal, testLeaderReaped: true });
                } else if (message.type === 'test-error') fail(new Error(String(message.error)));
                else assert.fail('Unknown Windows test wrapper message');
            } catch (error) { fail(error); }
        });
        child.stdout.on('data', bytes => {
            protocol += bytes; pending += bytes;
            if (protocol.length > 8192 || pending.length > 8192) { fail(new Error('Windows supervisor protocol exceeded its limit')); return; }
            let end;
            while ((end = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, end); pending = pending.slice(end + 1);
                try {
                    assert(line.length < 1024);
                    const event = JSON.parse(line);
                    assert(event.version === 1 && event.platform === 'win32');
                    if (event.type === 'ready') {
                        assert(!ready); assert.deepEqual(windowsIdentity(event.owner), owner);
                        assert.equal(windowsIdentity(event.supervisor).pid, child.pid);
                        const runner = windowsIdentity(event.runner);
                        assert(runner.pid !== child.pid && runner.pid !== process.pid);
                        ready = true; clearTimeout(readyTimer); status.supervisorRunner = runner;
                        if (interruptions.length || stopSent) stop(); else child.stdin.write('G');
                    } else if (event.type === 'started') { assert(ready && !started && !exited); started = true; }
                    else if (event.type === 'runnerExit') {
                        assert(ready && !exited && Number.isSafeInteger(event.exitCode) && event.exitCode >= 0 && event.exitCode <= 0xffffffff);
                        exited = true; status.supervisorRunnerExitCode = event.exitCode;
                    } else if (event.type === 'stopping') {
                        assert(ready && !stopping); stopping = true; status.cleanupReason = event.reason;
                        assert(['stop', 'stdinEof', 'ownerExit', 'runnerExit', 'console'].includes(event.reason), `Windows cleanup: ${event.reason}`);
                    } else if (event.type === 'treeClosed') {
                        assert(ready && exited && stopping && !status.jobObjectClosed && event.activeProcesses === 0);
                        status.jobObjectClosed = true;
                    } else assert.fail(`Windows supervisor failure: ${line}`);
                } catch (error) { fail(error); }
            }
        });
        child.once('close', (code, signal) => {
            closed = true; clearTimeout(readyTimer); clearTimeout(forceTimer);
            status.supervisor = { pid: child.pid, code, signal, reaped: true };
            if (pending || !ready || !exited || !status.jobObjectClosed || code !== 0 || signal) {
                status.error ??= 'Windows supervisor closed without complete Job Object cleanup evidence';
            }
            resolve();
        });
    });
    await fs.writeFile(path.join(root, 'supervisor.log'), protocol, { flag: 'wx', mode: 0o600 });
    status.supervisorLogSha256 = hash(protocol);
}

async function run(root) {
    // Refuse to rerun or overwrite any started/historical matrix.
    assert.deepEqual((await fs.readdir(root)).sort(), ['command.json']);
    await json(root, 'running.json', { pid: process.pid });
    const startedAt = new Date().toISOString();
    const interruptions = [];
    let supervisor;
    let stopSupervisor = () => {};
    let status = { code: null, signal: null };
    const stop = trigger => {
        interruptions.push({ trigger, at: new Date().toISOString() });
        stopSupervisor(trigger);
    };
    const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    const onMessage = message => { if (message?.type === 'stop') stop('parent-stop'); };
    if (process.platform === 'win32') process.on('message', onMessage);
    let deadline;
    let result;
    try {
        const command = await readCommand(root);
        deadline = setTimeout(() => stop('timeout'), command.timeoutMs);
        testEnvironment(command.environment, command.strict);
        const fingerprint = async () => {
            const files = new Map();
            const walk = async directory => {
                for (const entry of await fs.readdir(path.join(devkit, directory), { withFileTypes: true })) {
                    if (['node_modules', 'build'].includes(entry.name)) continue;
                    const file = `${directory}/${entry.name}`;
                    if (entry.isDirectory()) await walk(file);
                    else if (entry.isFile() && (/\.(?:ts|js|mjs|cjs|json|c|md)$/.test(file) || file.startsWith('build/host/'))) {
                        files.set(file, hash(await fs.readFile(path.join(devkit, file))));
                    }
                }
            };
            for (const directory of ['src', 'test', 'scripts', 'runtime', 'probes', 'skills', 'packaging', 'build/src', 'build/probes', 'build/host']) await walk(directory);
            for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) files.set(file, hash(await fs.readFile(path.join(devkit, file))));
            const add = async file => files.set(file, hash(await fs.readFile(file)));
            await add(command.executable);
            for (const [name, value] of Object.entries(command.environment)) {
                if (name.endsWith('SDK_ROOT') || ['BILIBILI_PACKAGE_SDK', 'BILIBILI_SDK_BASE_ROOT'].includes(name)) await add(path.join(value, 'manifest.json'));
                if (['RUNTIME_BUILTINS_2D', 'RUNTIME_BUILTINS_3D'].includes(name)) await add(path.join(value, 'result.json'));
                if (name === 'GAME_SDK_RUNTIME_ROOT') for (const profile of ['2d-basic', '3d-basic']) {
                    const runtime = path.join(value, profile);
                    for (const file of ['runtime.json', 'builtin-report.json']) await add(path.join(runtime, file));
                    for (const file of ['browser-report.json', 'first-frame.png', 'after-click.png', 'after-touch.png', 'mobile.png']) {
                        await add(path.join(`${runtime}-browser`, file));
                    }
                    if (JSON.parse(await fs.readFile(path.join(runtime, 'builtin-report.json'))).kind === 'cocos4-builtin-identity') {
                        for (const file of ['receipt.json', 'builtin-result.json']) await add(path.join(`${runtime}.evidence`, file));
                    }
                }
                if (name === 'PORTABLE_STARTUP_RELEASE') {
                    await add(path.join(value, 'release.json'));
                    await add(path.join(value, process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node'));
                }
                if (name === 'PORTABLE_STARTUP_NODE') await add(value);
            }
            return Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        };
        const before = await fingerprint();
        await json(root, 'inputs.json', before);
        assert(!interruptions.length, 'Interrupted before test spawn');
        const log = await fs.open(path.join(root, 'test.log'), 'wx', 0o600);
        try {
            if (process.platform === 'win32') {
                await superviseWindows(root, command, log, status, interruptions, callback => { stopSupervisor = callback; });
            } else await new Promise((resolve, reject) => {
                supervisor = spawn(process.execPath, [script, '--supervise', root], { cwd: devkit, env: command.environment,
                    shell: false, detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
                stopSupervisor = trigger => { if (supervisor.connected) supervisor.send({ type: 'stop', trigger }, () => {}); };
                supervisor.once('error', reject);
                supervisor.on('message', message => {
                    if (message.type === 'spawned') {
                        status.testPid = message.pid;
                        if (interruptions.length) supervisor.send({ type: 'stop', trigger: interruptions[0].trigger }, () => {});
                    }
                    if (message.type === 'test-exit') Object.assign(status, { code: message.code, signal: message.signal, testLeaderReaped: true });
                    if (message.type === 'test-error') status.error = message.error;
                    if (message.type === 'cleanup') status.groupKillRequested = true;
                    if (message.type === 'interruption' && !interruptions.some(item => item.trigger === message.trigger)) {
                        interruptions.push({ trigger: message.trigger, at: message.at });
                    }
                });
                supervisor.once('close', (code, signal) => {
                    status.supervisor = { pid: supervisor.pid, code, signal, reaped: true };
                    resolve();
                });
            });
        } finally { await log.close(); }
        const after = await fingerprint();
        await json(root, 'inputs-after.json', after);
        const output = await fs.readFile(path.join(root, 'test.log'));
        const audit = auditTap(output.toString());
        const unchanged = JSON.stringify(before) === JSON.stringify(after);
        const cleanupConfirmed = process.platform === 'win32'
            ? status.jobObjectClosed === true && status.supervisor.code === 0 && status.supervisor.signal === null
                && status.supervisorRunnerExitCode === 0 && status.cleanupReason === 'runnerExit' && status.testLeaderReaped === true
            : status.groupKillRequested === true && status.supervisor.signal === 'SIGKILL';
        const passed = status.code === 0 && !status.signal && !status.error && !interruptions.length && unchanged && cleanupConfirmed
            && audit.complete && audit.totals.fail === 0 && audit.totals.cancelled === 0;
        result = { totals: audit.totals, completeTotals: audit.complete, unchanged, logSha256: hash(output),
            success: passed && (!command.strict || audit.allPassed), fullSuccess: Boolean(command.strict && passed && audit.allPassed),
            scope: command.strict ? 'Full devkit test matrix with configured integrations, no skips/TODOs; not vendor/device or release approval.'
                : 'Selected source tests and configured integrations only; skips/TODOs allowed, not full acceptance.' };
    } catch (error) { result = { success: false, fullSuccess: false, error: String(error.stack ?? error) }; }
    finally {
        clearTimeout(deadline);
        process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
        process.removeListener('message', onMessage);
    }
    await json(root, 'result.json', { node: process.version, startedAt, finishedAt: new Date().toISOString(), ...status,
        interrupted: interruptions.length > 0, interruptionTrigger: interruptions[0]?.trigger ?? null, interruptions,
        cleanupScope, ...result });
    process.exitCode = result.success ? 0 : 1;
}

async function main() {
    assert(['linux', 'win32'].includes(process.platform), 'Retained verification requires Linux process groups or Windows Job Objects');
    const args = process.argv.slice(2);
    if (['--run', '--supervise', '--windows-test'].includes(args[0])) {
        assert(args.length === 2 && path.isAbsolute(args[1]));
        if (args[0] === '--supervise') await supervise(await readCommand(args[1]));
        else if (args[0] === '--windows-test') await windowsTest(await readCommand(args[1]));
        else await run(args[1]);
        return;
    }
    const usage = 'Usage: pinned-node scripts/verify-tests.mjs [--foreground] [--strict] [--timeout-ms 1..7200000] [test/<name>.test.mjs ...]. --strict requires all files and all integration inputs; no skips/TODOs. Default launch is background; default timeout is one hour.';
    let foreground = false, strict = false, timeoutMs = 3600000;
    const files = [], options = new Set();
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (['--foreground', '--strict', '--timeout-ms'].includes(arg)) {
            assert(!options.has(arg), usage); options.add(arg);
            if (arg === '--foreground') foreground = true;
            else if (arg === '--strict') strict = true;
            else {
                assert(/^\d+$/.test(args[index + 1]), usage);
                timeoutMs = Number(args[++index]);
                assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= maximumTimeout, usage);
            }
        } else { assert(/^test\/[A-Za-z0-9.-]+\.test\.mjs$/.test(arg), usage); files.push(arg); }
    }
    assert(!strict || !files.length, '--strict requires the full test matrix, not a selection');
    assert.equal(new Set(files).size, files.length, usage);
    const environment = testEnvironment(process.env);
    const root = await fs.mkdtemp(path.join(devkit, 'build', `matrix-node${process.versions.node.split('.')[0]}-`));
    await json(root, 'command.json', { node: process.version, executable: process.execPath, cwd: devkit,
        args: [...testArguments, ...(files.length ? files : await testFiles())], environment, timeoutMs, strict, fullMatrix: !files.length });
    if (foreground) {
        console.log(JSON.stringify({ state: 'running', pid: process.pid, evidence: root, result: path.join(root, 'result.json') }));
        await run(root);
    } else {
        const child = spawn(process.execPath, [script, '--run', root], { cwd: devkit, detached: true, shell: false, windowsHide: true, stdio: 'ignore', env: environment });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        console.log(JSON.stringify({ state: 'running', pid: child.pid, evidence: root, result: path.join(root, 'result.json') }));
    }
}

if (process.argv[1] && (process.platform === 'win32'
    ? path.resolve(process.argv[1]).toLowerCase() === script.toLowerCase() : path.resolve(process.argv[1]) === script)) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
