import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildHostToolWin32 } from '../scripts/build-publisher.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const captureDiagnostic = Buffer.concat([Buffer.from([0, 255]), Buffer.from('fixture diagnostic 游戏\n')]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function until(check, message, timeout = 8000) {
    const deadline = Date.now() + timeout;
    do {
        const value = await check();
        if (value) return value;
        await delay(20);
    } while (Date.now() < deadline);
    assert.fail(`Timed out: ${message}`);
}

function alive(pid) {
    assert(Number.isSafeInteger(pid) && pid > 0);
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// Child tests receive only selected host configuration and dummy credentials;
// capturing their environment must not disclose the test runner's credentials.
function environment(extra = {}) {
    const env = { PATH: '', COCOS4_TEST_PROVIDER_TOKEN: 'dummy-provider-token' };
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
        const source = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
        if (source && process.env[source] !== undefined) env[name] = process.env[source];
    }
    for (const [name, value] of Object.entries(extra)) {
        for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key];
        env[name] = value;
    }
    return env;
}

test('real Windows launcher preserves arguments and stdio, sanitizes before Node, and owns its process tree', {
    skip: process.platform !== 'win32' ? 'Real Windows x64 launcher acceptance requires Windows' : false,
    timeout: 360000,
}, async t => {
    assert.equal(process.arch, 'x64', 'Run Windows launcher acceptance using x64 Node');
    const temporary = await fs.realpath(tmpdir());
    const root = await fs.mkdtemp(path.join(temporary, 'cocos4-windows-launcher-'));
    const children = new Set(), descendants = new Set();
    const withinRoot = filename => {
        const resolved = path.resolve(filename);
        const relative = path.relative(root, resolved);
        assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
            `Fixture path must stay inside its temporary directory: ${resolved}`);
        return resolved;
    };
    t.after(async () => {
        for (const state of children) {
            if (!state.exited) state.child.kill('SIGKILL');
            state.child.stdin.destroy();
            state.child.stdout.destroy();
            state.child.stderr.destroy();
            clearTimeout(state.timer);
        }
        // Every fixture descendant has a 30-second watchdog. If containment is
        // broken, let that watchdog stop it instead of killing an unpinned PID.
        await until(() => [...descendants].every(pid => !alive(pid)), 'fixture descendant watchdog cleanup', 35000);
        assert.equal(path.dirname(path.resolve(root)), temporary);
        assert(path.basename(root).startsWith('cocos4-windows-launcher-'));
        assert.equal(await fs.realpath(root), root, 'Refuse to recursively remove a replaced fixture root');
        assert((await fs.lstat(root)).isDirectory());
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    function launch(executable, args, { cwd, env = environment(), input = Buffer.alloc(0), timeout = 15000 } = {}) {
        const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'] });
        const state = { child, output: [], diagnostic: [], bytes: 0, error: undefined,
            exited: false, closed: false, timedOut: false, code: null, signal: null };
        children.add(state);
        child.stdin.on('error', error => {
            if (!['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code)) state.error ??= error;
        });
        for (const [stream, destination] of [[child.stdout, state.output], [child.stderr, state.diagnostic]]) {
            stream.on('data', bytes => {
                state.bytes += bytes.length;
                if (state.bytes > 1024 * 1024) {
                    state.error ??= new Error('Fixture child output exceeded its bound');
                    child.kill('SIGKILL');
                } else destination.push(bytes);
            });
        }
        child.once('error', error => { state.error ??= error; });
        child.once('exit', () => { state.exited = true; });
        state.done = new Promise(resolve => child.once('close', (code, signal) => {
            state.code = code; state.signal = signal; state.closed = true;
            clearTimeout(state.timer);
            resolve(state);
        }));
        state.timer = setTimeout(() => {
            state.timedOut = true;
            child.kill('SIGKILL');
            child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        }, timeout);
        child.stdin.end(input);
        return state;
    }
    async function complete(state) {
        await state.done;
        assert.ifError(state.error);
        assert.equal(state.timedOut, false, Buffer.concat(state.diagnostic).toString('utf8'));
        return { code: state.code, signal: state.signal,
            stdout: Buffer.concat(state.output), stderr: Buffer.concat(state.diagnostic) };
    }

    const original = withinRoot(path.join(root, 'original kit'));
    const relocated = withinRoot(path.join(root, 'relocated kit 游戏 🚀'));
    for (const name of ['runtime', 'app']) await fs.mkdir(path.join(original, name), { recursive: true });
    await fs.copyFile(process.execPath, path.join(original, 'runtime/node.exe'));
    const entrySource = `import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mode = process.argv[2];
if (mode === 'tree') {
    setTimeout(() => process.exit(115), 30000);
    const branch = spawn(process.execPath, [fileURLToPath(new URL('./descendant.mjs', import.meta.url)), 'branch'],
        { shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    branch.once('error', error => { throw error; });
    branch.once('message', value => process.stdout.write(JSON.stringify({ pid: process.pid, ...value }) + '\\n'));
} else if (mode === 'exit') {
    const code = Number(process.argv[3]);
    process.stdout.write('exit:' + code + '\\n');
    process.stderr.write('fixture exit diagnostic:' + code + '\\n');
    process.exitCode = code;
} else {
    const chunks = [];
    for await (const bytes of process.stdin) chunks.push(bytes);
    process.stderr.write(Buffer.from(${JSON.stringify([...captureDiagnostic])}));
    process.stdout.write(JSON.stringify({ argv: process.argv, execArgv: process.execArgv, env: process.env,
        cwd: process.cwd(), input: Buffer.concat(chunks).toString('base64'), node: process.version }) + '\\n');
}
`;
    await fs.writeFile(path.join(original, 'app/launch.mjs'), entrySource, { flag: 'wx' });
    await fs.writeFile(path.join(original, 'app/descendant.mjs'), `import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
setTimeout(() => process.exit(115), 30000);
if (process.argv[2] === 'branch') {
    const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'],
        { shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    leaf.once('error', error => { throw error; });
    leaf.once('message', value => process.send({ branchPid: process.pid, leafPid: value.pid }));
} else process.send({ pid: process.pid });
`, { flag: 'wx' });
    const compilerOptions = process.env.COCOS4_WINDOWS_COMPILER ? { compiler: process.env.COCOS4_WINDOWS_COMPILER } : {};
    const built = await buildHostToolWin32(path.join(devkit, 'packaging/launcher-win32.c'),
        path.join(original, 'cocos4.exe'), compilerOptions);
    assert.equal(built.target, 'win32-x64');
    assert.equal(built.binarySha256, hash(await fs.readFile(path.join(original, 'cocos4.exe'))));
    // Validate both resolved endpoints before moving the fixture directory.
    assert.equal(await fs.realpath(withinRoot(original)), original);
    assert.equal(await fs.realpath(path.dirname(withinRoot(relocated))), root);
    await assert.rejects(fs.lstat(relocated), { code: 'ENOENT' });
    await fs.rename(original, relocated);
    await assert.rejects(fs.lstat(original), { code: 'ENOENT' });
    const launcher = path.join(relocated, 'cocos4.exe');
    const node = path.join(relocated, 'runtime/node.exe');
    const entry = path.join(relocated, 'app/launch.mjs');
    const cwd = withinRoot(path.join(root, 'caller workspace 中文'));
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'package.json'), 'invalid caller package; must not be imported', { flag: 'wx' });

    await t.test('Unicode relocation, quoting, empty arguments and binary stdio preserve exact values', async () => {
        const args = ['capture', '', 'value with spaces 游戏 🚀', '"quoted"', 'a\\"b', 'C:\\tail\\', '\\', '\\\\',
            'ends with \\', '* ? [a] {value}', '& | < > ^ %PATH% $HOME $(echo unsafe) ;`', '\t', '\r\n'];
        const input = Buffer.alloc(65536);
        for (let i = 0; i < input.length; ++i) input[i] = i % 256;
        const result = await complete(launch(launcher, args, { cwd, input }));
        assert.equal(result.code, 0, result.stderr.toString('utf8'));
        assert.equal(result.signal, null);
        assert.deepEqual(result.stderr, captureDiagnostic);
        const captured = JSON.parse(result.stdout.toString('utf8'));
        assert.deepEqual(captured.argv, [node, entry, ...args]);
        assert.deepEqual(captured.execArgv, ['--no-global-search-paths']);
        assert.equal(captured.cwd, cwd);
        assert.equal(captured.node, process.version, 'The fixture uses the current runtime, without claiming a release pin');
        assert.deepEqual(Buffer.from(captured.input, 'base64'), input);
        assert.equal(captured.env.COCOS4_TEST_PROVIDER_TOKEN, 'dummy-provider-token');
        assert.equal(Object.entries(captured.env).find(([key]) => key.toLowerCase() === 'path')?.[1], '');
    });

    await t.test('NODE_OPTIONS positive controls execute directly and every casing is removed before bundled Node', async () => {
        const marker = withinRoot(path.join(root, 'preload-ran.json'));
        const preload = withinRoot(path.join(root, 'preload with spaces 游戏.cjs'));
        await fs.writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid), { flag: 'wx' });\n`, { flag: 'wx' });
        const option = `--require=${JSON.stringify(preload.split(path.sep).join('/'))}`;
        for (const key of ['NODE_OPTIONS', 'nOdE_oPtIoNs', 'node_options']) {
            // Node's explicit preload resolver consults cwd/package.json; keep
            // the executable positive control separate from the poisoned cwd.
            const control = await complete(launch(node, [entry, 'capture'], { cwd: root, env: environment({ [key]: option }) }));
            assert.equal(control.code, 0, control.stderr.toString('utf8'));
            assert.match(await fs.readFile(marker, 'utf8'), /^[1-9][0-9]*$/, `${key} positive control must execute`);
            await fs.unlink(marker);
            const poison = environment({ [key]: option, nOdE_pAtH: root, BuN_OpTiOnS: '--preload=untrusted',
                Ld_PrElOaD: 'untrusted.dll', DyLd_InSeRt_LiBrArIeS: 'untrusted.dll', npm_config_registry: 'https://invalid.example',
                OpEnSsL_CoNf: 'Z:\\untrusted-openssl.cnf', sSlKeYLoGfIlE: 'Z:\\untrusted-keys',
                sYsTeMrOoT: 'Z:\\not-windows', WiNdIr: 'Z:\\not-windows' });
            const result = await complete(launch(launcher, ['capture'], { cwd, env: poison }));
            assert.equal(result.code, 0, result.stderr.toString('utf8'));
            assert.deepEqual(result.stderr, captureDiagnostic);
            await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
            const captured = JSON.parse(result.stdout.toString('utf8'));
            assert(!Object.keys(captured.env).some(name => /^(NODE_|BUN_|LD_|DYLD_|NPM_|OPENSSL_|SSLKEYLOGFILE$)/i.test(name)));
            const env = Object.fromEntries(Object.entries(captured.env).map(([name, value]) => [name.toLowerCase(), value]));
            assert.equal(env.systemroot, env.windir);
            assert.notEqual(env.systemroot, 'Z:\\not-windows');
            assert(path.win32.isAbsolute(env.systemroot));
            assert((await fs.stat(env.systemroot)).isDirectory());
            assert.equal(env.cocos4_test_provider_token, 'dummy-provider-token');
        }
    });

    await t.test('ordinary child exit codes propagate without extra launcher diagnostics', async () => {
        for (const code of [0, 7, 64, 72, 255, 4097]) {
            const result = await complete(launch(launcher, ['exit', String(code)], { cwd }));
            assert.equal(result.code, code);
            assert.equal(result.signal, null);
            assert.equal(result.stdout.toString('utf8'), `exit:${code}\n`);
            assert.equal(result.stderr.toString('utf8'), `fixture exit diagnostic:${code}\n`);
        }
    });

    await t.test('force-killing only the launcher closes Node and its live grandchildren through the Job', async () => {
        const state = launch(launcher, ['tree'], { cwd });
        const tree = await until(() => {
            assert.ifError(state.error);
            assert(!state.closed, Buffer.concat(state.diagnostic).toString('utf8'));
            const output = Buffer.concat(state.output).toString('utf8');
            return output.endsWith('\n') ? JSON.parse(output) : undefined;
        }, 'Node process tree readiness');
        const pids = [tree.pid, tree.branchPid, tree.leafPid];
        assert.equal(new Set(pids).size, 3);
        for (const pid of pids) { assert(alive(pid)); descendants.add(pid); }
        assert(state.child.kill('SIGKILL'), 'Kill the launcher alone, without taskkill /T or killing descendant PIDs');
        const result = await complete(state);
        await until(() => pids.every(pid => !alive(pid)), 'Job closes every ready Node descendant');
        assert.equal(result.stderr.length, 0);
        assert.equal(result.stdout.toString('utf8'), `${JSON.stringify(tree)}\n`);
    });
    t.diagnostic(`Built and ran the Windows launcher with ${process.version}; launcher SHA-256 ${built.binarySha256}. Fixture only, not complete portable-release acceptance.`);
});
