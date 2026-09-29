import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildMcpLauncher } from '../scripts/build-mcp-launch.mjs';

const exec = promisify(execFile);
const clean = { PATH: '', LANG: 'C.UTF-8' };

test('real static MCP helper sanitizes before Node without env, a loader, PATH or argument passthrough', { timeout: 120000 }, async t => {
    const root = await fs.mkdtemp(path.join(process.env.AI_TEST_EVIDENCE_ROOT ?? '/tmp/opencode', 'mcp-launch-'));
    const helper = path.join(root, 'cocos4-mcp-launch');
    const build = await buildMcpLauncher(helper);
    const repeat = await buildMcpLauncher(path.join(root, 'repeat'));
    assert.equal(build.binarySha256, repeat.binarySha256);
    assert.equal(build.linkage, 'static-no-libc');
    assert.equal(build.protocol, 'cocos4-mcp-launch-v1');
    assert.deepEqual(build.sharedLibraries, []);
    assert.deepEqual(build.requiredVersions, []);
    const node = await fs.realpath(process.execPath);
    const cli = path.join(root, 'trusted cli \u6e38\u620f.cjs');
    const workspace = path.join(root, 'workspace with spaces \u6e38\u620f');
    const session = path.join(root, 'session');
    for (const directory of [workspace, session, path.join(session, 'mcp-home'), path.join(session, 'tmp')]) await fs.mkdir(directory);
    await fs.writeFile(cli, `const fs = require('node:fs');
for (const file of ['/usr/bin/env', '/bin/env']) {
    try { fs.lstatSync(file); throw new Error('env must be absent'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(JSON.stringify({ env: process.env, argv: process.argv, execArgv: process.execArgv, cwd: process.cwd(), node: process.version }));
`, { flag: 'wx' });
    const jsMarker = path.join(root, 'node-preload-ran');
    const ldMarker = path.join(root, 'loader-preload-ran');
    const preload = path.join(root, 'preload.cjs');
    await fs.writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(jsMarker)}, 'bad');\n`, { flag: 'wx' });
    const library = path.join(root, 'preload.so');
    const source = path.join(root, 'preload.c');
    await fs.writeFile(source, `#include <fcntl.h>
#include <unistd.h>
__attribute__((constructor)) static void sentinel(void) {
    int fd = open(${JSON.stringify(ldMarker)}, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd >= 0) { (void) close(fd); }
}
`, { flag: 'wx' });
    await exec('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC', source, '-o', library],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 60000 });
    const poison = { ANTHROPIC_API_KEY: 'DUMMY_PROVIDER_AUTH', OPENCODE_API_KEY: 'DUMMY_OPENCODE_AUTH',
        COCOS4_CUSTOM_PROVIDER_TOKEN: 'DUMMY_CUSTOM_AUTH', NODE_OPTIONS: `--require=${preload}`, NODE_PATH: root,
        LD_PRELOAD: library, LD_AUDIT: library, LD_LIBRARY_PATH: root, BUN_OPTIONS: '--preload=bad',
        OPENSSL_CONF: '/missing/openssl', SSLKEYLOGFILE: '/missing/keys',
        HOME: '/untrusted', TMPDIR: '/untrusted', PATH: '/untrusted', LANG: 'untrusted', LC_ALL: 'untrusted' };
    const namespace = ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent',
        '--ro-bind', '/', '/', '--proc', '/proc', '--tmpfs', '/usr/bin', '--bind', root, root, '--ro-bind', node, node,
        '--chdir', workspace];
    const records = [];
    const run = async (name, command, args, environment = poison) => {
        const argv = [...namespace, ...Object.entries(environment).flatMap(([key, value]) => ['--setenv', key, value]), '--', command, ...args];
        let result;
        try { result = { code: 0, ...await exec('/usr/bin/bwrap', argv, { env: clean, timeout: 10000, maxBuffer: 65536 }) }; }
        catch (error) {
            assert.equal(typeof error.code, 'number', error.message);
            assert.equal(error.killed, false, error.message);
            result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
        }
        records.push({ name, command, args, ...result });
        return result;
    };
    const args = ['cocos4-mcp-launch-v1', '--node', node, '--cli', cli, '--session', session,
        '--sdk-root', '/trusted/sdk', '--workspace', workspace, '--state-root', '/private/state', '--mode', 'read-only', '--preview', 'false'];
    const noMarkers = async () => {
        for (const marker of [jsMarker, ldMarker]) await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
    };
    // Positive controls prove both sentinels are executable, not merely invalid
    // environment values. Only bwrap's child receives the poisoned environment.
    const control = await run('sentinel-positive-control', node, [cli], { NODE_OPTIONS: poison.NODE_OPTIONS, LD_PRELOAD: library });
    assert.equal(control.code, 0, control.stderr);
    for (const marker of [jsMarker, ldMarker]) { assert.ok((await fs.stat(marker)).isFile()); await fs.unlink(marker); }
    const old = await run('old-unbundled-env-command', '/usr/bin/env', ['-i', node, cli], {});
    assert.notEqual(old.code, 0);
    assert.match(old.stderr, /No such file/);
    for (const [mode, preview] of [['read-only', 'false'], ['develop', 'false'], ['develop', 'true']]) {
        const argv = [...args]; argv[14] = mode; argv[16] = preview;
        const result = await run(`valid-${mode}-${preview}`, helper, argv);
        assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
        const captured = JSON.parse(result.stdout);
        assert.deepEqual(captured.env, { PATH: '', HOME: path.join(session, 'mcp-home'), TMPDIR: path.join(session, 'tmp'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
        assert.deepEqual(captured.argv, [node, cli, 'mcp', '--sdk-root', '/trusted/sdk', '--workspace', workspace,
            '--state-root', '/private/state', '--mode', mode, '--preview', preview]);
        assert.deepEqual(captured.execArgv, ['--no-global-search-paths']);
        assert.equal(captured.cwd, workspace); assert.equal(captured.node, process.version);
        await noMarkers();
    }
    const invalid = [[], args.slice(0, -1), [...args, '-p', 'process.env'], [...args, '--', '/bin/sh'],
        ['-i', 'PATH=', node, cli], args.map((value, i) => i === 0 ? 'cocos4-mcp-launch-v2' : value)];
    for (const index of [2, 4, 6, 8, 10, 12]) for (const value of ['relative', '-e', '/bad\npath', '/bad/{env:SECRET}',
        '/bad/*', '/bad/../escape', '/bad//path', '/bad/./path', '/bad/..', '/bad/', `/${'x'.repeat(4096)}`]) {
        const argv = [...args]; argv[index] = value; invalid.push(argv);
    }
    for (const [index, value] of [[1, '--cli'], [3, '--node'], [14, 'maintainer'], [16, 'yes'], [16, 'true']]) {
        const argv = [...args]; argv[index] = value; invalid.push(argv);
    }
    for (const [index, argv] of invalid.entries()) {
        const result = await run(`malformed-${index}`, helper, argv);
        assert.equal(result.code, 64, result.stderr); assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'cocos4: invalid fixed MCP launch arguments.\n');
        await noMarkers();
    }
    const absent = [...args]; absent[2] = '/missing/explicit-node';
    const failed = await run('exec-failure-no-fallback', helper, absent);
    assert.equal(failed.code, 72); assert.equal(failed.stdout, ''); await noMarkers();
    await fs.writeFile(path.join(root, 'evidence.json'), `${JSON.stringify({ node: process.version, build, repeat,
        namespace, records, hostEnvUnavailable: true, sentinelPositiveControls: true, completed: true,
        modelRequests: 0, portableAcceptance: false }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    t.diagnostic(`Retained MCP launcher evidence: ${root}`);
});
