import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProcessTree, processIdentity } from '../build/src/process.js';
import { fixture, until } from './fixtures/logic-client.mjs';

const runner = fileURLToPath(new URL('./fixtures/process-runner.mjs', import.meta.url));
test('real Linux nested subreapers: exit status, setsid descendants, cancellation and either supervisor SIGKILL', { timeout: 90000 }, async t => {
    for (const mode of ['pass', 'fail', 'signal', 'tree', 'double-fork', 'exit-tree', 'kill-supervisor', 'kill-guardian']) await t.test(mode, async t => {
        const env = await fixture(t, `process-${mode}`);
        await fs.writeFile(path.join(env.directory, 'mode.json'), JSON.stringify({ mode: mode.startsWith('kill-') ? 'tree' : mode }));
        const messages = [];
        const tree = await ProcessTree.launch({ directory: env.directory, message: message => messages.push(message),
            stdout: stream => stream.resume(), stderr: stream => stream.resume() }, runner);
        env.cleanup.push(async () => { tree.stop(); await tree.closed; });
        const identity = await tree.ready;
        assert(identity.pid > 0 && identity.guardianPid > 0 && identity.pid !== identity.guardianPid);
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
        assert.equal(result.treeClosed, true, JSON.stringify(result));
        assert.equal(result.infrastructureFailed, mode.startsWith('kill-'), JSON.stringify(result));
        if (stopped) {
            assert(Date.now() - stopped < 10000);
            for (const pid of pids) assert.equal((await processIdentity(pid))?.alive ?? false, false, `Surviving PID ${pid}`);
        }
        if (mode === 'pass' || mode === 'exit-tree') assert.equal(result.exitCode, 0);
        if (mode === 'fail') assert.equal(result.exitCode, 7);
        if (mode === 'signal') assert.deepEqual([result.exitCode, result.signal], [null, 'SIGTERM']);
        if (mode === 'tree' || mode === 'double-fork') {
            assert(Date.now() - stopped >= 4900, 'Five-second grace was skipped');
            assert.equal(result.signal, 'SIGKILL');
        }
    });
});
