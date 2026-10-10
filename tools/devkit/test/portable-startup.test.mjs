import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildHostTool, buildHostToolWin32 } from '../scripts/build-publisher.mjs';
import { hash, verifyInventory } from '../scripts/verify-portable.mjs';

const execute = promisify(execFile);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const launcherName = windows ? 'cocos4.exe' : 'cocos4';
const nodeName = windows ? 'node.exe' : 'node';
const releaseRoot = process.env.PORTABLE_STARTUP_RELEASE;
const node = process.env.PORTABLE_STARTUP_NODE ?? (releaseRoot ? path.join(releaseRoot, 'runtime', nodeName)
    : process.version === 'v24.21.0' ? process.execPath : undefined);
const host = ['linux', 'win32'].includes(process.platform) && process.arch === 'x64';
const portableSkip = !host ? 'Portable launcher requires Linux or Windows x64'
    : !node ? 'Set PORTABLE_STARTUP_NODE to pinned Node 24.21.0 or PORTABLE_STARTUP_RELEASE to a current package' : false;
const cleanEnv = { PATH: '', LANG: 'C.UTF-8', ...(windows ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    USERPROFILE: '', LOCALAPPDATA: '', APPDATA: '' } : {}) };
let root, compiled, fixture, temporaryParent;

async function writableDirectories(directory) {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await writableDirectories(path.join(directory, entry.name));
    }
}

async function snapshot(directory, relative = '', entries = []) {
    const filename = path.join(directory, relative);
    const stat = await fs.lstat(filename);
    entries.push([relative, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs,
        stat.isFile() ? hash(await fs.readFile(filename)) : null]);
    if (stat.isDirectory()) for (const name of (await fs.readdir(filename)).sort()) {
        await snapshot(directory, path.join(relative, name), entries);
    }
    return entries;
}

async function command(directory, args, { cwd = directory, env = cleanEnv } = {}) {
    try {
        return { code: 0, ...await execute(path.join(directory, launcherName), args,
            { cwd, env, timeout: 120000, maxBuffer: 1024 * 1024 }) };
    } catch (error) {
        assert.equal(typeof error.code, 'number', error.message);
        assert.equal(error.killed, false, error.message);
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
}

function startupFailure(result, message) {
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.code, 'PORTABLE_STARTUP_FAILED');
    assert.match(error.message, message);
    return error;
}

before(async () => {
    if (!host) return;
    // Windows TEMP may explicitly grant other principals mutation rights. The
    // real helper must remain in a trusted chain; this test owns only its root.
    temporaryParent = await fs.realpath(windows ? process.env.USERPROFILE : tmpdir());
    root = await fs.mkdtemp(path.join(temporaryParent, 'cocos4-portable-startup-'));
    compiled = path.join(root, 'compiled');
    // Never refresh shared build/src or import a possibly stale application build.
    await execute(process.execPath, [path.join(devkit, 'node_modules/typescript/bin/tsc'),
        '--project', path.join(devkit, 'tsconfig.json'), '--outDir', compiled],
    { cwd: devkit, timeout: 120000, maxBuffer: 1024 * 1024 });
    await fs.writeFile(path.join(compiled, 'package.json'), '{"type":"module"}', { flag: 'wx' });
    await fs.symlink(path.join(devkit, 'node_modules'), path.join(compiled, 'node_modules'), windows ? 'junction' : 'dir');
    if (windows) {
        const { buildFsWin32 } = await import('../scripts/build-fs-win32.mjs');
        const metadata = await buildFsWin32({ output: path.join(compiled, 'host/cocos4-fs.exe'), compiler: process.env.COCOS4_WINDOWS_COMPILER });
        await fs.writeFile(path.join(compiled, 'host/fs.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64',
            file: 'cocos4-fs.exe', bytes: metadata.bytes, sha256: metadata.binarySha256, sourceSha256: metadata.sourceSha256 }));
    }
    if (portableSkip) return;
    assert(path.isAbsolute(node));
    assert.equal((await execute(node, ['--version'], { env: cleanEnv })).stdout.trim(), 'v24.21.0');
    fixture = path.join(root, 'incomplete-package');
    for (const name of ['app', 'runtime']) await fs.mkdir(path.join(fixture, name), { recursive: true });
    await fs.copyFile(node, path.join(fixture, 'runtime', nodeName));
    await fs.copyFile(path.join(devkit, 'packaging/launch.mjs'), path.join(fixture, 'app/launch.mjs'));
    await fs.copyFile(path.join(devkit, 'scripts/verify-portable.mjs'), path.join(fixture, 'app/verify-portable.mjs'));
    if (windows) await buildHostToolWin32(path.join(devkit, 'packaging/launcher-win32.c'), path.join(fixture, launcherName),
        { compiler: process.env.COCOS4_WINDOWS_COMPILER });
    else await buildHostTool(path.join(devkit, 'packaging/launcher.c'), path.join(fixture, launcherName), true);
    // This fixture intentionally has no release/SDK manifest. It is never a runnable release.
});

after(async () => {
    if (root) {
        await writableDirectories(root);
        assert(path.isAbsolute(root) && path.dirname(root) === temporaryParent && path.basename(root).startsWith('cocos4-portable-startup-'));
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('SDK diagnostics share the real verifier/host checks without writing workspace or state', { skip: !host }, async () => {
    const sdkRoot = path.join(root, 'readonly-sdk');
    await execute(process.execPath, [path.join(devkit, 'scripts/prepare-sdk.mjs'), '--out', sdkRoot],
        { cwd: devkit, timeout: 30000, maxBuffer: 65536 });
    const { loadSdk } = await import(pathToFileURL(path.join(compiled, 'src/sdk.js')));
    const { diagnoseSdk, runOperation } = await import(pathToFileURL(path.join(compiled, 'src/operations.js')));
    const { reportSchema } = await import(pathToFileURL(path.join(compiled, 'src/contracts.js')));
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const before = await snapshot(sdkRoot);
    const report = await diagnoseSdk(await loadSdk(sdkRoot));
    assert.deepEqual(reportSchema.parse(report), report);
    assert(report.items.some(item => item.code === 'PROFILE_NOT_AVAILABLE'));
    assert(report.items.some(item => item.name === 'Host filesystem' && item.status === 'passed'));
    const job = await runOperation({ operation: 'doctor', input: { depth: 'full' }, sdkRoot, workspace,
        staging: path.join(root, 'absent-state/job') });
    assert.deepEqual(job.items.filter(item => item.name !== 'Test execution'), report.items);
    assert.deepEqual(job.validationLevels, report.validationLevels);
    assert.deepEqual(await snapshot(sdkRoot), before);
    assert.deepEqual(await fs.readdir(workspace), []);
    await assert.rejects(fs.lstat(path.join(root, 'absent-state')), { code: 'ENOENT' });
    await fs.chmod(path.join(sdkRoot, 'app/validate-bilibili.cjs'), 0o600);
    await fs.appendFile(path.join(sdkRoot, 'app/validate-bilibili.cjs'), '\n// damaged\n');
    await assert.rejects(loadSdk(sdkRoot), { code: 'SDK_INCOMPLETE' });
});

test('packaged launcher help and strict arguments need no HOME; invalid grants/config never reach the SDK',
    { skip: portableSkip }, async t => {
        const workspace = path.join(root, 'argument-workspace'), state = path.join(root, 'absent-private-state');
        await fs.mkdir(workspace);
        const before = await snapshot(fixture);
        const help = await command(fixture, ['--help']);
        assert.equal(help.code, 0, help.stderr);
        assert.equal(help.stderr, '');
        assert.match(help.stdout, /doctor without --workspace.*no state or HOME/);
        assert.match(help.stdout, /apk export\|build\|build-direct requires --mode develop/);
        const cases = [
            ['unknown command', ['repair'], /Unknown command/],
            ['managed SDK', ['doctor', '--sdk-root', '/tmp/sdk'], /--sdk-root is managed/],
            ['unknown option', ['doctor', '--config', '/tmp/config'], /Unknown, duplicate/],
            ['missing value', ['doctor', '--workspace'], /missing option/],
            ['duplicate flag', ['doctor', '--mode', 'read-only', '--mode', 'read-only'], /duplicate/],
            ['passthrough', ['doctor', '--', 'anything'], /Unknown, duplicate/],
            ['doctor input', ['doctor', '--input', '{}'], /Unknown, duplicate/],
            ['bad mode', ['doctor', '--mode', 'repair'], /Invalid startup mode/],
            ['bad preview', ['doctor', '--preview', 'yes'], /literal true or false/],
            ['bad test grant', ['doctor', '--execute-tests', '1'], /literal true or false/],
            ['preview escalation', ['doctor', '--preview', 'true'], /explicit develop permission/],
            ['test escalation', ['doctor', '--execute-tests', 'true'], /explicit develop permission/],
            ['SDK-only develop', ['doctor', '--mode', 'develop'], /SDK-only doctor accepts no/],
            ['SDK-only preview', ['doctor', '--mode', 'develop', '--preview', 'true'], /SDK-only doctor accepts no/],
            ['SDK-only tests', ['doctor', '--mode', 'develop', '--execute-tests', 'true'], /SDK-only doctor accepts no/],
            ['SDK-only state', ['doctor', '--state-root', state], /SDK-only doctor accepts no/],
            ['relative workspace', ['doctor', '--workspace', '.'], /canonical absolute/],
            ['SDK workspace', ['doctor', '--workspace', fixture, '--state-root', state], /must be disjoint/],
            ['workspace state', ['tools', '--workspace', workspace, '--state-root', workspace], /must be disjoint/],
            ['nested state', ['tools', '--workspace', workspace, '--state-root', path.join(workspace, 'state')], /must be disjoint/],
            ['release state', ['tools', '--workspace', workspace, '--state-root', path.join(fixture, 'state')], /must be disjoint/],
            ['missing state env', ['doctor', '--workspace', workspace], windows ? /USERPROFILE must be/ : /HOME must be/],
            ['relative state', ['doctor', '--workspace', workspace, '--state-root', 'state'], /canonical absolute/],
            ['AI test grant', ['ai', '--execute-tests', 'true'], /Unknown, duplicate/],
            ['AI SDK override', ['ai', '--sdk-root', '/tmp/sdk'], /--sdk-root is managed/],
            ['bad tool', ['call', 'doctor'], /Expected a cocos4 tool name/],
        ];
        for (const [name, args, message] of cases) await t.test(name, async () => {
            startupFailure(await command(fixture, args), message);
        });
        for (const args of [['mcp'], ['tools'], ['call', 'cocos4_doctor'], ['ai']]) {
            startupFailure(await command(fixture, [...args, '--state-root', state]), /must be disjoint/);
        }
        for (const env of windows ? [{ USERPROFILE: 'relative' }, { USERPROFILE: root, LOCALAPPDATA: 'relative' }]
            : [{ HOME: 'relative' }, { HOME: '/tmp', XDG_STATE_HOME: 'relative' }]) {
            startupFailure(await command(fixture, ['tools', '--workspace', workspace], { env: { ...cleanEnv, ...env } }), /canonical absolute/);
        }
        await fs.symlink(workspace, path.join(root, 'workspace-link'), windows ? 'junction' : 'dir');
        startupFailure(await command(fixture, ['doctor', '--workspace', path.join(root, 'workspace-link'), '--state-root', state]), /aliases and symlinks/);
        await fs.writeFile(path.join(root, 'not-directory'), 'data');
        startupFailure(await command(fixture, ['doctor', '--workspace', path.join(root, 'not-directory'), '--state-root', state]), /Workspace must already exist/);
        assert.deepEqual(await snapshot(fixture), before);
        assert.deepEqual(await fs.readdir(workspace), []);
        await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
    });

test('SDK-only packaged doctor fails closed on missing inventory instead of requiring HOME or making state',
    { skip: portableSkip }, async () => {
        const before = await snapshot(fixture);
        const error = startupFailure(await command(fixture, ['doctor']), /release.json/);
        assert.equal(error.causeCode, 'ENOENT');
        assert.deepEqual(await snapshot(fixture), before);
    });

test('APK routing verifies the package first and forwards its own arguments without SDK, workspace or state injection',
    { skip: portableSkip }, async () => {
        const before = await snapshot(fixture);
        const denied = startupFailure(await command(fixture, ['apk', 'doctor', '--sdk', path.join(root, 'android-sdk')]), /release.json/);
        assert.equal(denied.causeCode, 'ENOENT');
        assert.deepEqual(await snapshot(fixture), before);

        // This isolated routing fixture stubs verification and the APK runner, not a valid release or an APK build.
        const verifier = path.join(fixture, 'app/verify-portable.mjs');
        const originalVerifier = await fs.readFile(verifier);
        const bridgeDirectory = path.join(fixture, 'app/src');
        const bridge = path.join(bridgeDirectory, 'android-cli.js');
        await fs.mkdir(bridgeDirectory);
        await fs.writeFile(bridge, `export async function runAndroidCli(args) {
    process.stdout.write(JSON.stringify({ args, checks: globalThis.routingChecks }) + '\\n');
}
`);
        try {
            await fs.writeFile(verifier, `export async function verifyInventory(root) {
    globalThis.routingChecks = ['inventory'];
    return { releaseRoot: root };
}
export async function verifyHost(root, manifest) {
    if (manifest.releaseRoot !== root) throw new Error('Wrong release passed to host verification');
    globalThis.routingChecks.push('host');
}
`);
            const args = ['export', '--input', path.join(root, 'web 游戏'), '--output', path.join(root, 'apk project'),
                '--config', path.join(root, 'game.json'), '--mode', 'develop'];
            const result = await command(fixture, ['apk', ...args]);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stderr, '');
            assert.deepEqual(JSON.parse(result.stdout), { args, checks: ['inventory', 'host'] });
        } finally {
            await fs.writeFile(verifier, originalVerifier);
            await fs.unlink(bridge);
            await fs.rmdir(bridgeDirectory);
        }
    });

test('current real package: readonly relocation, SDK-only doctor, explicit-workspace jobs and unchanged grants',
    { skip: portableSkip || (!releaseRoot && 'Set PORTABLE_STARTUP_RELEASE to a verified package containing current application code'), timeout: 600000 }, async t => {
        assert(path.isAbsolute(releaseRoot));
        const original = await verifyInventory(releaseRoot);
        for (const [source, delivered] of [['packaging/launch.mjs', 'app/launch.mjs'],
            ['scripts/verify-portable.mjs', 'app/verify-portable.mjs'], ['packaging/AGENTS.md', 'AGENTS.md']]) {
            assert.deepEqual(await fs.readFile(path.join(releaseRoot, delivered)), await fs.readFile(path.join(devkit, source)), `Stale package: ${delivered}`);
        }
        for (const name of await fs.readdir(path.join(compiled, 'src'))) {
            assert.deepEqual(await fs.readFile(path.join(releaseRoot, 'app/src', name)), await fs.readFile(path.join(compiled, 'src', name)), `Stale package application: ${name}`);
        }
        const extracted = path.join(root, 'extracted');
        await fs.cp(releaseRoot, extracted, { recursive: true, force: false, errorOnExist: true });
        const relocated = path.join(root, 'relocated kit \u4e2d\u6587');
        await fs.rename(extracted, relocated);
        const cwd = path.join(root, 'readonly-cwd');
        await fs.mkdir(cwd);
        await fs.writeFile(path.join(cwd, 'package.json'), '{invalid: "must not be inspected"}');
        await fs.chmod(cwd, 0o555);
        const cwdBefore = await snapshot(cwd), before = await snapshot(relocated);
        const { reportSchema } = await import(pathToFileURL(path.join(compiled, 'src/contracts.js')));
        for (const options of [{}, { cwd }, { cwd, env: { ...cleanEnv, HOME: 'invalid-unused-home', XDG_STATE_HOME: 'invalid-unused-state',
            NODE_OPTIONS: '--require=/must-not-load.cjs', NODE_PATH: '/must-not-load' } }]) {
            const result = await command(relocated, ['doctor'], options);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stderr, '');
            const data = JSON.parse(result.stdout);
            assert.equal(data.schemaVersion, 1);
            assert.equal(data.command, 'doctor');
            assert.equal(data.scope, 'sdk-only');
            assert.equal(data.success, true);
            assert.equal(data.releaseId, original.releaseId);
            assert.equal(data.sdkId, original.sdk.sdkId);
            assert.deepEqual(reportSchema.parse(data.report), data.report);
            assert.deepEqual(data.report.validationLevels, ['manifest-schema', 'payload-sha256', windows ? 'windows-pinned-reads' : 'linux-pinned-reads', 'release-inventory', 'bundled-node', 'host-abi']);
            assert(data.report.items.some(item => item.name === 'Host ABI' && item.status === 'passed'));
            assert(data.report.items.some(item => item.name === 'Release acceptance' && item.status === 'warning'));
            assert(data.report.items.some(item => item.name === 'Workspace and permissions' && /no workspace authorized/.test(item.message)));
            assert(data.report.items.some(item => item.name === 'AI client' && /Not checked/.test(item.message)));
            assert(!data.report.items.some(item => item.status === 'failed' || item.name === 'Project inspection'));
        }
        assert.deepEqual(await snapshot(cwd), cwdBefore);
        assert.deepEqual(await snapshot(relocated), before);

        const workspace = path.join(root, 'real-package-workspace'), state = path.join(root, 'real-package-state');
        await fs.mkdir(workspace, { mode: 0o700 });
        const flags = ['--workspace', workspace, '--state-root', state];
        for (const args of [['mcp'], ['tools'], ['call', 'cocos4_doctor'], ['ai']]) {
            startupFailure(await command(relocated, [...args, '--state-root', state]), /must be disjoint/);
        }
        const explicit = await command(relocated, ['doctor', ...flags]);
        assert.equal(explicit.code, 0, explicit.stderr);
        assert.equal(explicit.stderr, '');
        const page = JSON.parse(explicit.stdout).data;
        assert.equal(page.job.state, 'succeeded');
        assert.equal(page.job.releaseId, original.releaseId);
        assert(page.report.validationLevels.includes(windows ? 'windows-pinned-reads' : 'linux-pinned-reads'));
        assert(page.report.items.some(item => item.name === 'Test execution' && /disabled/.test(item.message)));
        const stateBefore = await snapshot(state);
        await assert.rejects(execute(process.execPath, [path.join(relocated, 'app/src/cli.js'), 'doctor',
            '--sdk-root', path.join(relocated, 'sdk'), ...flags], { cwd: workspace, env: cleanEnv, timeout: 120000 }), error => {
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            assert.equal(JSON.parse(error.stderr).code, 'SDK_INCOMPLETE');
            return true;
        });
        assert.deepEqual(await snapshot(state), stateBefore, 'A foreign interpreter cannot admit a release-identified job.');
        const tools = await command(relocated, ['tools', ...flags, '--mode', 'develop', '--execute-tests', 'true']);
        assert.equal(tools.code, 0, tools.stderr);
        assert(JSON.parse(tools.stdout).tools.some(tool => tool.name === 'cocos4_project_check'));
        const denied = await command(relocated, ['call', 'cocos4_project_check', '--input',
            '{"project":"untrusted","target":"HTML5","profile":"2d-basic","checks":["logic"],"requestKey":"no-grant"}', ...flags, '--mode', 'develop']);
        assert.equal(denied.code, 1);
        assert.equal(JSON.parse(denied.stdout).error.code, 'PERMISSION_DENIED');
        const missingClient = await command(relocated, ['ai', '--client', 'opencode', ...flags]);
        assert.equal(missingClient.code, 1);
        assert.match(JSON.parse(missingClient.stderr).message, /--executable/);
        assert.deepEqual(await fs.readdir(workspace), []);
        assert.deepEqual(await snapshot(relocated), before);

        // Only damage our private copy, never the supplied release or its evidence.
        const damaged = path.join(relocated, 'AGENTS.md');
        await fs.chmod(damaged, 0o600);
        await fs.appendFile(damaged, '\nDAMAGED TEST COPY\n');
        await fs.chmod(damaged, 0o444);
        startupFailure(await command(relocated, ['doctor']), /AGENTS\.md/);
        assert.equal((await verifyInventory(releaseRoot)).releaseId, original.releaseId);
        t.diagnostic(`Verified current packaged commands for ${original.releaseId}; SDK ${original.sdk.sdkId}. No browser/model/vendor/device execution.`);
    });
