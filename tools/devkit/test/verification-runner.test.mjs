// Runner contract fixtures only, not synthetic SDKs or full engine acceptance.
// All source copies, logs and process observations are retained in private tmp.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { auditTap, testEnvironment } from '../scripts/verify-tests.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const complete = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.5\n';
const windows = process.platform === 'win32';
const nodeName = windows ? 'node.exe' : 'node';

test('retained environment keeps host paths and explicit integration inputs but rejects startup injection', () => {
    const host = { USERPROFILE: 'profile', LOCALAPPDATA: 'local', APPDATA: 'roaming', TEMP: 'temp', TMP: 'tmp',
        SystemRoot: 'windows', WINDIR: 'windows', COMSPEC: 'cmd', PATHEXT: '.EXE', PATH: 'path', HOME: 'home' };
    const environment = testEnvironment({ ...host, PORTABLE_STARTUP_RELEASE: 'release',
        NODE_OPTIONS: '--require=injected.cjs', NODE_PATH: 'injected', COCOS4_SECRET: 'secret' });
    assert.deepEqual(environment, { ...host, PORTABLE_STARTUP_RELEASE: 'release' });
    if (windows) assert.deepEqual(testEnvironment({ Path: 'path', SYSTEMROOT: 'windows', localappdata: 'local' }),
        { PATH: 'path', SystemRoot: 'windows', LOCALAPPDATA: 'local' });
    if (windows) assert.deepEqual(testEnvironment({ 'PROGRAMFILES(X86)': 'tools', COCOS4_WINDOWS_COMPILER: 'compiler',
        windowssdkdir: 'sdk', NODE_OPTIONS: 'injected' }),
    { 'ProgramFiles(x86)': 'tools', COCOS4_WINDOWS_COMPILER: 'compiler', WindowsSdkDir: 'sdk' });
});

test('TAP auditing rejects absent/ambiguous/inconsistent totals and distinguishes skips from full success', () => {
    assert.equal(auditTap(complete).allPassed, true);
    assert.equal(auditTap(complete.replaceAll('\n', '\r\n')).allPassed, true);
    for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
        assert.equal(auditTap(complete.replace(new RegExp(`# ${field} \\d+\\n`), '')).complete, false, field);
    }
    for (const output of ['', 'TAP version 13\nok 1 - started\n', complete + complete,
        complete.replace('# pass 2', '# pass 1'), complete.replaceAll('2', '0'), complete + 'ok 3 - unfinished\n']) {
        assert.equal(auditTap(output).complete, false);
    }
    for (const field of ['fail', 'cancelled', 'skipped', 'todo']) {
        const audit = auditTap(complete.replace('# pass 2', '# pass 1').replace(`# ${field} 0`, `# ${field} 1`));
        assert.equal(audit.complete, true);
        assert.equal(audit.allPassed, false);
    }
});

async function until(check, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    do {
        const value = await check();
        if (value) return value;
        await delay(25);
    } while (Date.now() < deadline);
    assert.fail(`Fixture deadline exceeded (${timeoutMs} ms)`);
}

async function processState(pid) {
    if (windows) {
        try { process.kill(pid, 0); return 'running'; }
        catch (error) { if (error.code === 'ESRCH') return 'absent'; throw error; }
    }
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
}

test('retained verification uses bounded real processes without shared build writes', { timeout: 90000 }, async t => {
    const root = await fs.mkdtemp(path.join(tmpdir(), `verification-runner-node${process.versions.node.split('.')[0]}-`));
    t.diagnostic(`Retained runner-only evidence: ${root}`);
    await writeJson(path.join(root, 'scope.json'), { node: process.version, scope: 'Private runner fixtures, not full devkit acceptance' });
    const fixture = async (name, body) => {
        const directory = path.join(root, name);
        const source = path.join(directory, 'source');
        const temporary = path.join(directory, 'tmp');
        for (const item of ['src', 'test', 'scripts', 'runtime', 'probes', 'skills', 'packaging', 'build/src', 'build/probes', 'build/host']) {
            await fs.mkdir(path.join(source, item), { recursive: true });
        }
        await fs.mkdir(temporary);
        await fs.copyFile(new URL('../scripts/verify-tests.mjs', import.meta.url), path.join(source, 'scripts/verify-tests.mjs'));
        if (windows) {
            for (const name of ['cocos4-supervise.exe', 'supervisor.json']) {
                await fs.copyFile(new URL(`../build/host/${name}`, import.meta.url), path.join(source, 'build/host', name));
            }
            await fs.copyFile(new URL('../runtime/supervise-win32.c', import.meta.url), path.join(source, 'runtime/supervise-win32.c'));
        }
        await fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}');
        for (const file of ['package-lock.json', 'tsconfig.json']) await fs.writeFile(path.join(source, file), '{}');
        await fs.writeFile(path.join(source, 'build/probes/mcp-client.js'), "import { test } from 'node:test'; test('fixture probe', () => {});\n");
        await fs.writeFile(path.join(source, 'test/fixture.test.mjs'), body);
        return { directory, source, temporary };
    };
    let sequence = 0;
    const launch = (item, args, extra = {}) => {
        const prefix = path.join(item.directory, `launch-${sequence++}`);
        const argv = ['scripts/verify-tests.mjs', ...args];
        const env = { PATH: process.env.PATH ?? '', HOME: item.temporary, TMPDIR: item.temporary, LANG: 'C',
            ...(windows ? { USERPROFILE: item.temporary, LOCALAPPDATA: item.temporary, APPDATA: item.temporary,
                TEMP: item.temporary, TMP: item.temporary, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}), ...extra };
        const child = spawn(process.execPath, argv, { cwd: item.source, env, windowsHide: true,
            stdio: windows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => { stdout += bytes; });
        child.stderr.on('data', bytes => { stderr += bytes; });
        const terminate = setTimeout(() => child.kill('SIGTERM'), 15000);
        const kill = setTimeout(() => child.kill('SIGKILL'), 22000);
        const closed = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', async (code, signal) => {
                clearTimeout(terminate); clearTimeout(kill);
                try {
                    await writeJson(`${prefix}.json`, { executable: process.execPath, args: argv, cwd: item.source, environment: env, code, signal });
                    await fs.writeFile(`${prefix}.log`, stdout + stderr, { flag: 'wx' });
                    resolve({ code, signal, stdout, stderr });
                } catch (error) { reject(error); }
            });
        });
        return { child, closed, receipt: () => until(() => stdout.includes('\n') && JSON.parse(stdout.split('\n')[0])) };
    };
    const finish = async running => {
        const exit = await running.closed;
        const receipt = JSON.parse(exit.stdout.split('\n')[0]);
        const result = await until(async () => {
            try { return await readJson(receipt.result); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        });
        return { exit, receipt, result };
    };

    await t.test('foreground propagates failure; successful selections with skips are not full acceptance', async () => {
        for (const fail of [false, true]) {
            const item = await fixture(fail ? 'failure' : 'selected', `import { test } from 'node:test';
                test('fixture', () => { ${fail ? "throw new Error('EXPECTED_FIXTURE_FAILURE');" : ''} });
                test('intentional selected-scope skip', { skip: true }, () => {});`);
            const { exit, result } = await finish(launch(item, ['--foreground', '--timeout-ms', '10000', 'test/fixture.test.mjs']));
            assert.equal(exit.code, fail ? 1 : 0, exit.stderr);
            assert.equal(result.success, !fail);
            assert.equal(result.fullSuccess, false);
            assert.equal(result.totals.skipped, 1);
            assert.equal(result.totals.fail, fail ? 1 : 0);
            assert.equal(result.completeTotals, true);
            assert.equal(result.interrupted, false);
            assert.equal(result.testLeaderReaped, true);
            assert.equal(await processState(result.testPid), 'absent');
            assert.equal(await processState(result.supervisor.pid), 'absent');
        }
    });

    await t.test('background receipts remain compatible and historical evidence cannot be rerun', async () => {
        const item = await fixture('background', "import { test } from 'node:test'; test('fixture', () => {});");
        const { exit, receipt, result } = await finish(launch(item, ['--timeout-ms', '10000', 'test/fixture.test.mjs']));
        assert.equal(exit.code, 0);
        assert.equal(receipt.state, 'running');
        assert.equal(result.success, true);
        const before = await fs.readFile(receipt.result);
        const retry = await launch(item, ['--run', receipt.evidence]).closed;
        assert.equal(retry.code, 1);
        assert.deepEqual(await fs.readFile(receipt.result), before);
    });

    await t.test('strict mode requires a full selection and explicit integration inputs; CLI cannot expand commands', async () => {
        const item = await fixture('arguments', "import { test } from 'node:test'; test('fixture', () => {});");
        for (const args of [['--strict', 'test/fixture.test.mjs'], ['--command', 'true'], ['--eval', 'process.exit(0)'],
            ['test/../fixture.test.mjs'], ['runtime/fixture.test.mjs'], ['--timeout-ms', '0'], ['--timeout-ms', '7200001'],
            ['--timeout-ms', 'NaN'], ['--foreground', '--foreground']]) {
            const exit = await launch(item, args).closed;
            assert.equal(exit.code, 1, JSON.stringify(args));
        }
        assert.deepEqual(await fs.readdir(path.join(item.source, 'build')), ['host', 'probes', 'src']);
        const { exit, result } = await finish(launch(item, ['--foreground', '--strict', '--timeout-ms', '10000']));
        assert.equal(exit.code, 1);
        assert.equal(result.success, false);
        assert.equal(result.fullSuccess, false);
        assert.match(result.error, /Missing strict integration inputs:.*RUNTIME_BUILTINS_2D.*PORTABLE_STARTUP_RELEASE/);
        const evidence = path.join(item.directory, 'invalid-command');
        await fs.mkdir(evidence);
        await writeJson(path.join(evidence, 'command.json'), { executable: process.execPath, node: process.version,
            cwd: `${item.source}/`, args: ['--eval', 'process.exit(0)'], timeoutMs: 1000, environment: {} });
        assert.equal((await launch(item, ['--run', evidence]).closed).code, 1);
        assert.equal((await readJson(path.join(evidence, 'result.json'))).success, false);
    });

    await t.test('the explicit whole-matrix budget matches CI without weakening result checks', async () => {
        const item = await fixture('matrix-budget', "import { test } from 'node:test'; test('fixture', () => {});");
        const { exit, receipt, result } = await finish(launch(item, ['--foreground', '--timeout-ms', '7200000', 'test/fixture.test.mjs']));
        assert.equal(exit.code, 0, exit.stderr);
        assert.equal((await readJson(path.join(receipt.evidence, 'command.json'))).timeoutMs, 7200000);
        assert.equal(result.success, true);
        assert.equal(result.fullSuccess, false);
        assert.equal(result.completeTotals, true);
        assert.equal(result.totals.fail, 0);
        assert.equal(result.totals.skipped, 0);
        assert.equal(await processState(result.testPid), 'absent');
        assert.equal(await processState(result.supervisor.pid), 'absent');
    });

    await t.test('portable inputs and builtin report identities are forwarded, hashed, and mutation fails closed', async () => {
        for (const mutate of [false, true]) {
            const item = await fixture(mutate ? 'changed-input' : 'inputs', `import assert from 'node:assert/strict';
                import { test } from 'node:test'; import * as fs from 'node:fs/promises';
                test('forwarded fixture identity inputs', async () => {
                    for (const key of ['PORTABLE_STARTUP_RELEASE', 'PORTABLE_STARTUP_NODE', 'RUNTIME_BUILTINS_2D', 'RUNTIME_BUILTINS_3D']) assert(process.env[key], key);
                    assert.equal(process.env.NODE_OPTIONS, undefined);
                    ${mutate ? "await fs.appendFile(process.env.RUNTIME_BUILTINS_2D + '/result.json', '\\n');" : ''}
                });`);
            const release = path.join(item.directory, 'identity-only-release');
            await fs.mkdir(path.join(release, 'runtime'), { recursive: true });
            await writeJson(path.join(release, 'release.json'), { fixture: 'identity hashing only, not a release' });
            if (windows) await fs.copyFile(process.execPath, path.join(release, 'runtime', nodeName));
            else await fs.symlink(process.execPath, path.join(release, 'runtime', nodeName));
            const env = { PORTABLE_STARTUP_RELEASE: release, PORTABLE_STARTUP_NODE: process.execPath };
            for (const key of ['RUNTIME_BUILTINS_2D', 'RUNTIME_BUILTINS_3D']) {
                env[key] = path.join(item.directory, key);
                await fs.mkdir(env[key]);
                await writeJson(path.join(env[key], 'result.json'), { fixture: 'report identity only, not compiled builtins' });
            }
            const { exit, receipt, result } = await finish(launch(item, ['--foreground', '--timeout-ms', '10000', 'test/fixture.test.mjs'], env));
            assert.equal(exit.code, mutate ? 1 : 0, exit.stderr);
            assert.equal(result.success, !mutate);
            assert.equal(result.unchanged, !mutate);
            const command = await readJson(path.join(receipt.evidence, 'command.json'));
            const inputs = await readJson(path.join(receipt.evidence, 'inputs.json'));
            const after = await readJson(path.join(receipt.evidence, 'inputs-after.json'));
            for (const [key, value] of Object.entries(env)) assert.equal(command.environment[key], value);
            for (const file of [process.execPath, path.join(release, 'release.json'), path.join(release, 'runtime', nodeName),
                path.join(env.RUNTIME_BUILTINS_2D, 'result.json'), path.join(env.RUNTIME_BUILTINS_3D, 'result.json')]) {
                assert.match(inputs[file], /^[a-f0-9]{64}$/);
                assert.equal(after[file], digest(await fs.readFile(file)));
            }
        }
    });

    for (const trigger of windows ? [] : ['SIGINT', 'SIGTERM', 'timeout']) await t.test(`${trigger}: leader exits before escalation, stubborn child cannot suppress it`, async () => {
        const item = await fixture(trigger, `import { spawn } from 'node:child_process'; import { test } from 'node:test';
            spawn(process.execPath, [process.env.TMPDIR + '/leaf.mjs', String(process.ppid)], { stdio: 'ignore' });
            process.on('SIGTERM', () => process.exit(0));
            test('bounded blocked fixture', () => new Promise(() => {}));`);
        const ready = path.join(item.temporary, 'ready.json');
        await fs.writeFile(path.join(item.temporary, 'leaf.mjs'), `import * as fs from 'node:fs/promises';
            process.on('SIGTERM', () => {});
            setTimeout(() => process.exit(90), 12000);
            await fs.writeFile(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ leaf: process.pid, runner: Number(process.argv[2]) }));
            await fs.rename(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});`);
        const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: 'ignore' });
        const sentinelClosed = new Promise(resolve => sentinel.once('close', resolve));
        try {
            const running = launch(item, ['--foreground', '--timeout-ms', trigger === 'timeout' ? '2500' : '10000', 'test/fixture.test.mjs']);
            const pids = await until(async () => {
                try { return await readJson(ready); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
            });
            if (trigger !== 'timeout') running.child.kill(trigger);
            await until(async () => (await processState(pids.runner)) === 'absent');
            assert.notEqual(await processState(pids.leaf), 'absent', 'Leaf must outlive the test leader to exercise escalation');
            assert.notEqual(await processState(pids.leaf), 'Z', 'Leaf must still be running before escalation');
            const { exit, result } = await finish(running);
            assert.equal(exit.code, 1, exit.stderr);
            assert.equal(result.interruptionTrigger, trigger);
            assert.equal(result.interrupted, true);
            assert.equal(result.success, false);
            assert.equal(result.fullSuccess, false);
            assert.equal(result.completeTotals, false);
            assert.equal(result.groupKillRequested, true);
            assert.equal(result.supervisor.signal, 'SIGKILL');
            assert.equal(result.testLeaderReaped, true);
            assert(Date.parse(result.finishedAt) - Date.parse(result.interruptions[0].at) >= 4900);
            const leafState = await until(async () => {
                const state = await processState(pids.leaf);
                return ['absent', 'Z'].includes(state) && state;
            }, 2000);
            assert.equal(await processState(result.supervisor.pid), 'absent');
            assert.equal(sentinel.exitCode, null);
            assert.equal(sentinel.signalCode, null, 'An unrelated process group must never be signalled');
            assert.match(result.cleanupScope, /setsid escapes and orphan descendant reaping are not established/);
            await writeJson(path.join(item.directory, 'process-observations.json'), { ...pids, leafState,
                testLeader: 'reaped', supervisor: 'reaped', unrelatedSentinel: 'alive', scope: result.cleanupScope });
        } finally {
            sentinel.kill('SIGKILL');
            await sentinelClosed;
        }
    });

    for (const trigger of windows ? ['parent-stop', 'timeout', 'owner-exit'] : []) await t.test(`${trigger}: Windows Job terminates live descendants and leaves unrelated processes alive`, async () => {
        const item = await fixture(trigger, `import { spawn } from 'node:child_process'; import { test } from 'node:test';
            spawn(process.execPath, [process.env.TMPDIR + '/leaf.mjs', String(process.pid), String(process.ppid)], { stdio: 'ignore', windowsHide: true });
            test('bounded blocked fixture', () => new Promise(() => {}));`);
        const ready = path.join(item.temporary, 'ready.json');
        await fs.writeFile(path.join(item.temporary, 'leaf.mjs'), `import * as fs from 'node:fs/promises';
            setTimeout(() => process.exit(90), 20000);
            await fs.writeFile(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ leaf: process.pid, test: Number(process.argv[2]), runner: Number(process.argv[3]) }));
            await fs.rename(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});`);
        const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, windowsHide: true, stdio: 'ignore' });
        const sentinelClosed = new Promise(resolve => sentinel.once('close', resolve));
        try {
            // Include fingerprinting and Windows process creation under CI load
            // so timeout exercises a live descendant, rather than dying before
            // the leaf can publish the process observation.
            const running = launch(item, ['--foreground', '--timeout-ms', trigger === 'timeout' ? '8000' : '10000', 'test/fixture.test.mjs']);
            const receipt = await running.receipt();
            const pids = await until(async () => {
                try { return await readJson(ready); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
            });
            for (const pid of Object.values(pids)) assert.equal(await processState(pid), 'running');
            if (trigger === 'parent-stop') running.child.send({ type: 'stop' });
            if (trigger === 'owner-exit') running.child.kill('SIGKILL');
            let cleanup;
            if (trigger === 'owner-exit') {
                const exit = await running.closed;
                assert(exit.code !== 0 || exit.signal, 'Forcibly terminated owner cannot exit successfully');
                await assert.rejects(fs.stat(receipt.result), { code: 'ENOENT' }, 'Owner death cannot manufacture a pass result');
                assert.equal((await readJson(path.join(receipt.evidence, 'running.json'))).pid, running.child.pid);
                cleanup = 'Owner death independently observed; no retained pass or cleanup receipt was fabricated';
            } else {
                const { exit, result } = await finish(running);
                assert.equal(exit.code, 1, exit.stderr);
                assert.equal(result.interruptionTrigger, trigger);
                assert.equal(result.interrupted, true);
                assert.equal(result.success, false); assert.equal(result.fullSuccess, false);
                assert.equal(result.completeTotals, false);
                assert.equal(result.jobObjectClosed, true);
                assert.equal(result.supervisor.code, 0); assert.equal(result.supervisor.signal, null);
                assert.equal(result.cleanupReason, 'stop');
                assert.equal(await processState(result.supervisor.pid), 'absent');
                assert.equal(await processState(result.supervisorRunner.pid), 'absent');
                const protocol = await fs.readFile(path.join(receipt.evidence, 'supervisor.log'));
                assert.equal(result.supervisorLogSha256, digest(protocol));
                assert.equal(JSON.parse(protocol.toString().trim().split('\n').at(-1)).type, 'treeClosed');
                assert.match(result.cleanupScope, /Own Job Object.*zero active processes/);
                cleanup = result.cleanupScope;
            }
            for (const pid of Object.values(pids)) await until(async () => (await processState(pid)) === 'absent', 3000);
            assert.equal(sentinel.exitCode, null); assert.equal(sentinel.signalCode, null);
            assert.equal(await processState(sentinel.pid), 'running', 'An unrelated process must remain alive');
            await writeJson(path.join(item.directory, 'process-observations.json'), { ...pids, testTree: 'absent', unrelatedSentinel: 'alive', scope: cleanup });
        } finally { sentinel.kill('SIGKILL'); await sentinelClosed; }
    });
});
