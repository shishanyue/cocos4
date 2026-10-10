import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProcessTree, processIdentity } from '../build/src/process.js';
import { fixture, until } from './fixtures/logic-client.mjs';

const runner = fileURLToPath(new URL('./fixtures/process-runner.mjs', import.meta.url));
const windows = process.platform === 'win32';
test(`real ${windows ? 'Windows Job Object' : 'Linux nested subreapers'}: exit status, detached descendants, cancellation and supervisor death`, { timeout: 90000 }, async t => {
    const modes = ['pass', 'fail', 'signal', 'tree', 'double-fork', 'exit-tree', 'kill-supervisor', ...(windows ? [] : ['kill-guardian'])];
    for (const mode of modes) await t.test(mode, async t => {
        const env = await fixture(t, `process-${mode}`);
        await fs.writeFile(path.join(env.directory, 'mode.json'), JSON.stringify({ mode: mode.startsWith('kill-') ? 'tree' : mode }));
        const messages = [];
        const tree = await ProcessTree.launch({ directory: env.directory, message: message => messages.push(message),
            stdout: stream => stream.resume(), stderr: stream => stream.resume() }, runner);
        env.cleanup.push(async () => { tree.stop(); await tree.closed; });
        const identity = await tree.ready;
        assert(identity.pid > 0 && identity.guardianPid > 0);
        assert.equal(identity.pid === identity.guardianPid, windows);
        if (windows) {
            assert.equal(identity.platform, 'win32');
            assert(identity.runnerPid > 0 && identity.runnerPid !== identity.pid);
            assert.equal((await processIdentity(identity.pid)).startTime, identity.startTime);
            assert.equal((await processIdentity(identity.runnerPid)).startTime, identity.runnerStartTime);
        }
        tree.start();
        let pids = [];
        let stopped;
        if (!['pass', 'fail', 'signal'].includes(mode)) {
            const ready = await until(() => messages.find(message => message.type === 'tree_ready'));
            pids = [ready.runner, ...ready.descendants];
            stopped = Date.now();
            if (mode === 'kill-supervisor') process.kill(identity.pid, 'SIGKILL');
            else if (mode === 'kill-guardian') process.kill(identity.guardianPid, 'SIGKILL');
            else if (mode !== 'exit-tree') tree.stop();
        }
        const result = await tree.closed;
        assert.equal(result.treeClosed, !(windows && mode === 'kill-supervisor'), JSON.stringify(result));
        assert.equal(result.infrastructureFailed, mode.startsWith('kill-'), JSON.stringify(result));
        if (stopped) {
            assert(Date.now() - stopped < 10000);
            for (const pid of pids) await until(async () => !(await processIdentity(pid))?.alive, 10000);
        }
        if (mode === 'pass' || mode === 'exit-tree') assert.equal(result.exitCode, 0);
        if (mode === 'fail') assert.equal(result.exitCode, 7);
        if (mode === 'signal') {
            if (windows) { assert.notEqual(result.exitCode, 0); assert.equal(result.signal, null); }
            else assert.deepEqual([result.exitCode, result.signal], [null, 'SIGTERM']);
        }
        if (mode === 'tree' || mode === 'double-fork') {
            if (windows) assert.deepEqual([result.exitCode, result.signal], [0xc000013a, null]);
            else { assert(Date.now() - stopped >= 4900, 'Five-second grace was skipped'); assert.equal(result.signal, 'SIGKILL'); }
        }
    });
});

test('a ready runner remains suspended until start; duplicate start and stop are idempotent', { timeout: 15000 }, async t => {
    const env = await fixture(t, 'process-suspended');
    await fs.writeFile(path.join(env.directory, 'mode.json'), JSON.stringify({ mode: 'pass' }));
    const messages = [];
    const tree = await ProcessTree.launch({ directory: env.directory, message: value => messages.push(value),
        stdout: stream => stream.resume(), stderr: stream => stream.resume() }, runner);
    env.cleanup.push(async () => { tree.stop(); await tree.closed; });
    await tree.ready;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(messages.length, 0);
    tree.start(); tree.start();
    const result = await tree.closed;
    tree.stop(); tree.stop();
    assert.deepEqual(result, { exitCode: 0, signal: null, treeClosed: true, infrastructureFailed: false });
    assert.equal(messages.length, 1);
});
