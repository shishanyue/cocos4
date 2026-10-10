import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Maintainer-only COMPONENT acceptance, not Windows app/process/jobs support.
// Run with bundled node.exe --no-global-search-paths --test test/windows-supervisor.mjs.
// No npm/SDK is needed; this explicit host harness is outside test/*.test.mjs.
// Defaults: build/windows-host/{cocos4-supervise,windows-supervisor-fixture}.exe
// Override with absolute COCOS4_WINDOWS_SUPERVISOR / COCOS4_WINDOWS_FIXTURE.
// Each exe requires its build-script-generated .exe.json sidecar. Keep this test
// beside fixtures/windows-node-runner.mjs, or set COCOS4_WINDOWS_NODE_RUNNER.
// Optional COCOS4_WINDOWS_ACCEPTANCE_DIR: absent absolute directory to RETAIN
// report files/transcripts. Without it a private temporary directory is removed.
// Non-win32 invocation fails before artifact access or execution, never skips.
// Wine is labelled smoke, not Windows qualification. No production gate is changed.
const root = fileURLToPath(new URL('../', import.meta.url));
const helper = process.env.COCOS4_WINDOWS_SUPERVISOR ?? path.join(root, 'build/windows-host/cocos4-supervise.exe');
const fixture = process.env.COCOS4_WINDOWS_FIXTURE ?? path.join(root, 'build/windows-host/windows-supervisor-fixture.exe');
const nodeRunner = process.env.COCOS4_WINDOWS_NODE_RUNNER ?? fileURLToPath(new URL('./fixtures/windows-node-runner.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cancellationCode = 0xc000013a;

function identity(value) {
    assert.deepEqual(Object.keys(value).sort(), ['creationTime', 'pid', 'platform']);
    assert.equal(value.platform, 'win32');
    assert(Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0xffffffff);
    assert.match(value.creationTime, /^[1-9]\d{0,19}$/);
    assert(BigInt(value.creationTime) <= 0xffffffffffffffffn);
    return value;
}
function observation(value) {
    assert.equal(value.version, 1);
    assert.equal(value.platform, 'win32');
    const fields = {
        ready: ['supervisor', 'owner', 'runner'], started: [], runnerExit: ['exitCode'], stopping: ['reason'],
        treeClosed: ['activeProcesses'], treeNotClosed: ['activeProcesses'], error: ['operation', 'errorCode'], identity: ['process', 'alive'],
        tree: ['exists', 'activeProcesses'],
    }[value.type];
    assert(fields, `Unknown observation ${value.type}`);
    assert.deepEqual(Object.keys(value).sort(), ['version', 'platform', 'type', ...fields].sort());
    for (const name of ['supervisor', 'owner', 'runner', 'process']) if (value[name]) identity(value[name]);
    if (value.type === 'identity') assert.equal(typeof value.alive, 'boolean');
    for (const name of ['exitCode', 'errorCode']) if (name in value) assert(Number.isInteger(value[name]) && value[name] >= 0 && value[name] <= 0xffffffff);
    if (value.type === 'treeClosed') assert.equal(value.activeProcesses, 0);
    if (value.type === 'tree') {
        assert.equal(typeof value.exists, 'boolean');
        assert(Number.isInteger(value.activeProcesses) && value.activeProcesses >= 0);
        if (!value.exists) assert.equal(value.activeProcesses, 0);
    }
    if (value.type === 'treeNotClosed') assert(value.activeProcesses === null || Number.isInteger(value.activeProcesses) && value.activeProcesses >= 0);
    if (value.type === 'stopping') assert(['stop', 'stdinEof', 'ownerExit', 'runnerExit', 'controlError', 'console',
        'observationError', 'readyTimeout', 'infrastructure'].includes(value.reason));
    if (value.type === 'error') assert.match(value.operation, /^[A-Za-z]+$/);
    return value;
}
async function until(check, description, timeout = 8000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const result = await check();
        if (result) return result;
        assert(Date.now() < deadline, `Timed out: ${description}`);
        await delay(15);
    }
}
async function jsonFile(file) {
    return until(async () => {
        try {
            const bytes = await fs.readFile(file);
            assert(bytes.length <= 131072, 'Bounded fixture report');
            return JSON.parse(bytes.toString('utf8'));
        } catch (error) {
            if (['ENOENT', 'EBUSY', 'EACCES'].includes(error.code) || error instanceof SyntaxError) return null;
            throw error;
        }
    }, file);
}

test('Windows x64 Job Object supervisor component acceptance', {
    timeout: 180000,
}, async t => {
    assert.equal(process.platform, 'win32', 'Windows supervisor component acceptance requires a win32 host; use the bundled Windows x64 Node executable');
    assert.equal(process.arch, 'x64', 'Use the bundled Windows x64 Node executable');
    for (const value of [helper, fixture, nodeRunner]) assert(path.isAbsolute(value), 'Explicit paths must be absolute');
    const retained = process.env.COCOS4_WINDOWS_ACCEPTANCE_DIR;
    let directory;
    if (retained) {
        assert(path.isAbsolute(retained));
        await fs.mkdir(retained); directory = retained;
    } else directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos4-windows-supervisor-'));
    const children = new Set(), transcripts = [];
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
        await Promise.all([...children].map(child => child.exitCode !== null || child.signalCode !== null ? undefined
            : new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 3000).unref(); })));
        await fs.writeFile(path.join(directory, 'transcripts.json'), `${JSON.stringify(transcripts, null, 2)}\n`, { flag: 'wx' });
        if (!retained) await fs.rm(directory, { recursive: true, force: true });
    });
    function launch(exe, args, options = {}) {
        const child = spawn(exe, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
        children.add(child);
        child.stdin.on('error', () => {});
        const state = { child, stdout: '', stderr: '', done: false, code: null, signal: null, error: null };
        child.stdout.on('data', bytes => {
            state.stdout += bytes.toString('utf8');
            if (Buffer.byteLength(state.stdout) > 16384) { state.error = new Error('Excess stdout'); child.kill(); }
        });
        child.stderr.on('data', bytes => { state.stderr = (state.stderr + bytes.toString('utf8')).slice(-16384); });
        child.once('error', error => { state.error = error; state.done = true; });
        child.once('close', (code, signal) => { state.done = true; state.code = code; state.signal = signal; });
        return state;
    }
    async function complete(state, timeout = 8000) {
        await until(() => state.done, `process ${state.child.pid} closure: ${state.stderr}`, timeout);
        assert.ifError(state.error);
        return state;
    }
    async function native(args) {
        const state = launch(fixture, args);
        state.child.stdin.end();
        await complete(state);
        assert.equal(state.code, 0, `${args[0]}: ${state.stderr}`);
        assert.equal(state.signal, null);
        return state;
    }
    async function processIdentity(pid) {
        const state = launch(helper, ['--identity', String(pid)]);
        state.child.stdin.end();
        await complete(state);
        assert.equal(state.code, 0, state.stdout + state.stderr);
        assert(state.stdout.endsWith('\n') && state.stdout.split('\n').length === 2);
        const event = observation(JSON.parse(state.stdout));
        assert.equal(event.type, 'identity');
        assert.equal(event.alive, true, 'The requested live process must remain alive');
        return event.process;
    }
    const owner = await processIdentity(process.pid);
    async function treeState(value) {
        const state = launch(helper, ['--tree', String(value.pid), value.creationTime]);
        state.child.stdin.end(); await complete(state);
        assert.equal(state.code, 0, state.stdout + state.stderr);
        const event = observation(JSON.parse(state.stdout));
        assert.equal(event.type, 'tree');
        return event;
    }
    async function run(caseDirectory, args, executable = fixture, extra = {}) {
        const { ipc = false, ...options } = extra;
        const state = launch(helper, ['--owner', String(owner.pid), owner.creationTime, '--cwd', caseDirectory,
            ...(ipc ? ['--ipc'] : []), '--', executable, ...args],
        { ...(ipc ? { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] } : {}), ...options });
        state.events = [];
        let pending = '', total = 0;
        state.child.stdout.on('data', bytes => {
            try {
                total += bytes.length;
                assert(total <= 8192, 'Protocol total bound');
                assert(bytes.every(byte => byte < 128), 'Protocol is ASCII JSON');
                pending += bytes.toString('ascii');
                for (let end; (end = pending.indexOf('\n')) !== -1;) {
                    assert(end + 1 <= 1024, 'Protocol record bound');
                    const value = observation(JSON.parse(pending.slice(0, end)));
                    pending = pending.slice(end + 1);
                    state.events.push(value);
                    assert(state.events.length <= 8, 'Protocol record count');
                }
                assert(pending.length < 1024);
            } catch (error) { state.error = error; state.child.stdin.end('T'); }
        });
        state.child.stdout.once('end', () => { if (pending) state.error = new Error('Truncated observation'); });
        state.wait = type => until(() => {
            assert.ifError(state.error);
            const event = state.events.find(event => event.type === type);
            assert(event || !state.done, `Missing ${type}: ${state.stdout} ${state.stderr}`);
            return event;
        }, type);
        transcripts.push({ directory: caseDirectory, executable, args, events: state.events });
        return state;
    }
    async function ready(state) {
        const value = await state.wait('ready');
        assert.equal(state.events[0], value);
        assert.deepEqual(value.owner, owner);
        assert.equal(value.supervisor.pid, state.child.pid);
        assert.deepEqual(await processIdentity(value.supervisor.pid), value.supervisor);
        assert.deepEqual(await processIdentity(value.runner.pid), value.runner);
        assert(BigInt(value.runner.creationTime) >= BigInt(value.supervisor.creationTime));
        return value;
    }
    async function closed(state, exitCode, reason, helperCode = 0) {
        await complete(state);
        assert.equal(state.code, helperCode, state.stdout + state.stderr);
        assert.equal(state.signal, null);
        assert.equal(state.events.filter(e => e.type === 'ready').length, 1);
        assert.equal(state.events.filter(e => e.type === 'runnerExit').length, 1);
        assert.equal(state.events.filter(e => e.type === 'stopping').length, 1);
        assert.equal(state.events.filter(e => e.type === 'treeClosed').length, 1);
        assert.equal(state.events.at(-1).type, 'treeClosed');
        assert.equal(state.events.find(e => e.type === 'runnerExit').exitCode, exitCode);
        assert.equal(state.events.find(e => e.type === 'stopping').reason, reason);
        assert(!state.events.some(e => ['error', 'treeNotClosed', 'identity'].includes(e.type)));
    }
    let sequence = 0;
    async function caseDirectory(name) {
        const value = path.join(directory, `${++sequence}-${name} space-\u6d4b\u8bd5`);
        await fs.mkdir(value);
        return value;
    }
    async function watch(value, caseDir, name) {
        identity(value);
        const started = path.join(caseDir, `${name}-watching.json`), result = path.join(caseDir, `${name}-exited.json`);
        const state = launch(fixture, ['watch', String(value.pid), value.creationTime, started, result]);
        state.child.stdin.end();
        assert.deepEqual(await jsonFile(started), value);
        return async expected => {
            await complete(state, 13000);
            assert.equal(state.code, 0, `Pinned watcher failed for ${name}`);
            const observed = await jsonFile(result);
            assert.equal(observed.exited, true);
            if (expected !== undefined) assert.equal(observed.exitCode, expected);
            else assert.notEqual(observed.exitCode, 115, `${name} reached the fixture watchdog instead of supervised termination`);
            return observed;
        };
    }
    async function tree(caseDir) {
        const state = await run(caseDir, ['tree', caseDir]);
        const value = await ready(state);
        state.child.stdin.write('G');
        await state.wait('started');
        const identities = await Promise.all(['root', 'branch', 'leaf'].map(name => jsonFile(path.join(caseDir, `${name}.json`))));
        assert.deepEqual(identities[0], value.runner);
        const watchers = await Promise.all(identities.map((value, i) => watch(value, caseDir, ['root', 'branch', 'leaf'][i])));
        return { state, watchers, identities, value };
    }

    await t.test('artifact identity, provenance, and actual PE evidence', async () => {
        const artifacts = [];
        for (const [file, component] of [[helper, 'supervisor'], [fixture, 'acceptance-fixture']]) {
            const bytes = await fs.readFile(file);
            const manifest = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
            assert.equal(manifest.version, 1);
            assert.equal(manifest.component, component);
            assert.equal(manifest.platform, 'win32'); assert.equal(manifest.arch, 'x64');
            assert.equal(manifest.sha256, hash(bytes)); assert.equal(manifest.bytes, bytes.length);
            if (manifest.compiler.kind === 'msvc') {
                assert.match(manifest.compiler.version, /^19\.[0-9]+\.[0-9]+$/);
                assert.equal(manifest.pe.hardening.controlFlowGuard, true);
                assert(manifest.pe.hardening.loadConfigBytes > 0);
            } else {
                assert(manifest.compiler.kind === undefined || manifest.compiler.kind === 'zig');
                assert.equal(manifest.compiler.version, '0.16.0');
            }
            assert.match(manifest.compiler.sha256, /^[a-f0-9]{64}$/);
            assert.equal(manifest.pe.machine, 'AMD64');
            const coff = bytes.readUInt32LE(0x3c) + 4;
            assert.equal(bytes.readUInt16LE(coff), 0x8664);
            assert.equal(bytes.readUInt16LE(coff + 20), 0x20b);
            const dll = bytes.readUInt16LE(coff + 20 + 70);
            assert.equal(dll & 0x160, 0x160, 'Actual ASLR/high-entropy/NX bits');
            assert.equal(manifest.pe.hardening.relocationsPresent, true);
            assert.deepEqual(manifest.pe.hardening.writableExecutableSections, []);
            artifacts.push({ component, sha256: manifest.sha256, sourceSha256: manifest.sourceSha256 });
        }
        const hostFile = path.join(directory, 'host.json');
        await native(['host', hostFile]);
        const host = await jsonFile(hostFile);
        const evidence = { scope: 'supervisor-component-only', host: { platform: process.platform, arch: process.arch, release: os.release(), ...host },
            kind: host.wineDetected ? 'WINE_SMOKE_NOT_WINDOWS_ACCEPTANCE' : 'WINDOWS_COMPONENT_ACCEPTANCE_RUN_NOT_APP_QUALIFICATION',
            node: { version: process.version, sha256: hash(await fs.readFile(process.execPath)) },
            harnessSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), nodeRunnerSha256: hash(await fs.readFile(nodeRunner)), artifacts };
        await fs.writeFile(path.join(directory, 'run.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
        t.diagnostic(JSON.stringify(evidence));
    });

    const args = ['', 'plain', 'two words', '\t', 'line\nbreak', '"', '\\', 'tail\\', '\\\\"quoted\\"',
        'C:\\path with spaces\\', '\u6d4b\u8bd5-\ud83c\udf0d', '*.json', '%PATH%', '&|^<>'];
    const poison = { ...process.env, NODE_OPTIONS: '--require=Z:\\missing-poison.cjs', NODE_PATH: 'Z:\\poison',
        PATH: 'Z:\\poison', SystemRoot: 'Z:\\not-windows', WINDIR: 'Z:\\not-windows', COMSPEC: 'Z:\\poison.exe',
        TEMP: 'Z:\\poison', TMP: 'Z:\\poison', USERPROFILE: 'Z:\\poison', HOME: 'Z:\\poison', COCOS4_SECRET: 'must-not-leak' };
    await t.test('ready precedes execution; wide args, clean OS environment, NUL stdin, no breakaway, isolated stdout', async () => {
        const dir = await caseDirectory('native-observe'), file = path.join(dir, 'observed.json');
        const state = await run(dir, ['observe', file, ...args], fixture, { env: poison });
        const value = await ready(state);
        await delay(250);
        await assert.rejects(fs.stat(file), { code: 'ENOENT' });
        assert.deepEqual(state.events.map(e => e.type), ['ready']);
        state.child.stdin.write('G');
        await closed(state, 0, 'runnerExit');
        const data = await jsonFile(file);
        assert.deepEqual(data.identity, value.runner);
        assert.deepEqual(data.args, args);
        assert.equal(data.cwd.toLowerCase(), dir.toLowerCase());
        assert.equal(data.stdinEof, true); assert.equal(data.inJob, true);
        assert.equal(data.jobFlags, 0x2000, 'KILL_ON_JOB_CLOSE only, neither breakaway bit');
        assert.equal(data.breakawayCreated, false); assert.equal(data.breakawayError, 5, 'ERROR_ACCESS_DENIED');
        assert.deepEqual(data.environment, [`PATH=${data.system}`, `SystemRoot=${data.windows}`, `WINDIR=${data.windows}`]);
        assert.match(state.stderr, /"activeProcesses":999/); assert.match(state.stderr, /fixture-stderr/);
        assert.equal(state.events.filter(e => e.type === 'started').length, 1);
    });
    await t.test('bundled Node executes with exact arguments and without inherited NODE_OPTIONS', async () => {
        const dir = await caseDirectory('node-observe'), file = path.join(dir, 'node.json');
        const state = await run(dir, [nodeRunner, file, ...args], process.execPath, { env: poison });
        const value = await ready(state);
        state.child.stdin.write('G');
        await closed(state, 0, 'runnerExit');
        const data = await jsonFile(file);
        assert.equal(data.pid, value.runner.pid); assert.deepEqual(data.args, args);
        assert.equal(data.platform, 'win32'); assert.equal(data.arch, 'x64');
        assert.deepEqual(Object.keys(data.environment).map(s => s.toUpperCase()).sort(), ['PATH', 'SYSTEMROOT', 'WINDIR']);
        assert.match(state.stderr, /node-fixture-stderr/); assert.match(state.stderr, /"activeProcesses":999/);
    });
    await t.test('explicit Node IPC transfers only fd 3 and supports a bidirectional exchange', async () => {
        const dir = await caseDirectory('node-ipc'), script = path.join(dir, 'ipc-runner.mjs');
        await fs.writeFile(script, `import assert from 'node:assert/strict';
assert.equal(typeof process.send, 'function');
assert.deepEqual(Object.keys(process.env).map(key => key.toUpperCase()).sort(), ['PATH', 'SYSTEMROOT', 'WINDIR']);
process.on('message', message => {
    assert.deepEqual(message, { type: 'ping', text: 'IPC \\u6d4b\\u8bd5' });
    process.send({ type: 'pong', pid: process.pid, text: message.text }, () => process.disconnect());
});
process.send({ type: 'hello', pid: process.pid });
`, { flag: 'wx' });
        const state = await run(dir, [script], process.execPath, { ipc: true, env: poison });
        const value = await ready(state), messages = [];
        state.child.on('message', message => {
            messages.push(message);
            if (message?.type === 'hello') state.child.send({ type: 'ping', text: 'IPC \u6d4b\u8bd5' });
        });
        state.child.stdin.write('G');
        await closed(state, 0, 'runnerExit');
        assert.deepEqual(messages, [{ type: 'hello', pid: value.runner.pid }, { type: 'pong', pid: value.runner.pid, text: 'IPC \u6d4b\u8bd5' }]);
    });
    await t.test('requesting IPC without an inherited fd 3 fails before runner creation', async () => {
        const dir = await caseDirectory('missing-ipc');
        for (const stdio of [
            ['pipe', 'pipe', 'pipe'],
            ['pipe', 'pipe', 'pipe', 'ignore'],
            ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'],
        ]) {
            const state = launch(helper, ['--owner', String(owner.pid), owner.creationTime, '--cwd', dir, '--ipc', '--', fixture, 'sleep'], { stdio });
            state.child.stdin.end(); await complete(state);
            assert.equal(state.code, 125, `Unopened fd 3 with ${JSON.stringify(stdio)}: ${state.stdout} ${state.stderr}`);
            const event = observation(JSON.parse(state.stdout));
            assert.equal(event.type, 'error'); assert.equal(event.operation, 'ipcDescriptor');
            assert.equal(event.errorCode, 6);
        }
    });
    await t.test('DWORD exit statuses remain unsigned, including STILL_ACTIVE as a real exit value', async () => {
        for (const code of [0, 259, 0x80000000, 0xffffffff]) {
            const dir = await caseDirectory(`exit-${code}`), state = await run(dir, ['exit', String(code)]);
            await ready(state); state.child.stdin.write('G');
            await closed(state, code, 'runnerExit');
        }
    });
    await t.test('fast acknowledgement immediately after raw ready, repeated 16 times', async () => {
        for (let i = 0; i < 16; i++) {
            const dir = await caseDirectory(`fast-ack-${i}`), state = await run(dir, ['exit', '0']);
            await state.wait('ready');
            state.child.stdin.write('G');
            await closed(state, 0, 'runnerExit');
            assert.deepEqual(state.events.slice(0, 2).map(event => event.type), ['ready', 'started']);
        }
    });
    for (const [control, reason, helperCode] of [['T', 'stop', 0], ['GG', 'controlError', 125], ['X', 'controlError', 125], ['', 'stdinEof', 0]]) {
        await t.test(`suspended cancellation/control rejection: ${control || 'EOF'}`, async () => {
            const dir = await caseDirectory(`cancel-${control || 'eof'}`), file = path.join(dir, 'must-not-exist.json');
            const state = await run(dir, ['observe', file]);
            const value = await ready(state), waited = await watch(value.runner, dir, 'suspended');
            if (control) state.child.stdin.write(control); else state.child.stdin.end();
            await closed(state, cancellationCode, reason, helperCode);
            await waited(cancellationCode);
            assert(!state.events.some(e => e.type === 'started'));
            await assert.rejects(fs.stat(file), { code: 'ENOENT' });
        });
    }
    for (const reason of ['stop', 'stdinEof', 'runnerExit']) {
        await t.test(`${reason} closes a live three-generation tree`, async () => {
            const dir = await caseDirectory(`tree-${reason}`), { state, watchers } = await tree(dir);
            if (reason === 'stop') state.child.stdin.write('T');
            else if (reason === 'stdinEof') state.child.stdin.end();
            else await fs.writeFile(path.join(dir, 'exit-root'), '', { flag: 'wx' });
            const code = reason === 'runnerExit' ? 0xfedcba98 : cancellationCode;
            await closed(state, code, reason);
            await Promise.all(watchers.map((waited, i) => waited(i === 0 ? code : cancellationCode)));
        });
    }
    await t.test('forced helper termination closes its sole Job handle and kills descendants', async () => {
        const dir = await caseDirectory('helper-death'), { state, watchers, value } = await tree(dir);
        const running = await treeState(value.supervisor);
        assert.equal(running.exists, true);
        assert(running.activeProcesses >= 3, 'Job accounting includes every fixture generation and any OS console hosts');
        const helperWaited = await watch(value.supervisor, dir, 'helper');
        await native(['kill', String(value.supervisor.pid), value.supervisor.creationTime]);
        await helperWaited(0xdeadbeef);
        await Promise.all(watchers.map(waited => waited()));
        await complete(state);
        assert(!state.events.some(e => e.type === 'treeClosed'), 'Forced helper death cannot certify closure itself');
        const recovered = await treeState(value.supervisor);
        assert.equal(recovered.activeProcesses, 0, 'Independent Job accounting proves all descendants exited');
    });
    await t.test('identity reports a terminated process while an independent handle still pins its PID', async () => {
        const dir = await caseDirectory('terminated-identity');
        const subject = launch(fixture, ['sleep']);
        subject.child.stdin.end();
        const value = await processIdentity(subject.child.pid);
        const started = path.join(dir, 'watching.json'), ended = path.join(dir, 'exited.json');
        const watcher = launch(fixture, ['watchHold', String(value.pid), value.creationTime, started, ended]);
        watcher.child.stdin.end();
        assert.deepEqual(await jsonFile(started), value);
        await native(['kill', String(value.pid), value.creationTime]);
        await jsonFile(ended);
        const state = launch(helper, ['--identity', String(value.pid)]);
        state.child.stdin.end(); await complete(state);
        assert.equal(state.code, 0);
        const event = observation(JSON.parse(state.stdout));
        assert.deepEqual(event.process, value); assert.equal(event.alive, false);
        await complete(watcher); await complete(subject);
    });
    await t.test('owner death kills the tree even while a separate keeper holds stdin open', async () => {
        const dir = await caseDirectory('owner-death');
        const ownerState = launch(fixture, ['owner', helper, dir]);
        ownerState.child.stdin.end();
        const names = ['owner', 'helper', 'keeper', 'root', 'branch', 'leaf'];
        const values = await Promise.all(names.map(name => jsonFile(path.join(dir, `${name}.json`))));
        const byName = Object.fromEntries(names.map((name, i) => [name, identity(values[i])]));
        assert.equal(byName.owner.pid, ownerState.child.pid);
        t.after(async () => { await native(['kill', String(byName.keeper.pid), byName.keeper.creationTime]).catch(() => {}); });
        const watched = await Promise.all(['owner', 'helper', 'root', 'branch', 'leaf'].map(name => watch(byName[name], dir, name)));
        await native(['kill', String(byName.owner.pid), byName.owner.creationTime]);
        await Promise.all(watched.map(waited => waited()));
        await native(['alive', String(byName.keeper.pid), byName.keeper.creationTime]);
        await native(['kill', String(byName.keeper.pid), byName.keeper.creationTime]);
        await complete(ownerState);
    });
    await t.test('stale owner identity and non-absolute executable fail closed before ready', async () => {
        const dir = await caseDirectory('invalid-owner');
        for (const [creation, executable] of [[String(BigInt(owner.creationTime) + 1n), fixture], [owner.creationTime, 'relative.exe']]) {
            const state = launch(helper, ['--owner', String(owner.pid), creation, '--cwd', dir, '--', executable, 'sleep']);
            state.child.stdin.end(); await complete(state);
            assert.equal(state.code, 125);
            const lines = state.stdout.trim().split('\n').map(line => observation(JSON.parse(line)));
            assert.equal(lines.length, 1); assert.equal(lines[0].type, 'error');
        }
    });
});
