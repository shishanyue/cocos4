// Non-interactive real-client verification. No run/prompt/model/auth commands.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--executable', '--build-root', '--sdk-root', '--evidence-root'].includes(args[i])
        && args[i + 1] && path.isAbsolute(args[i + 1]) && !flags.has(args[i]));
    flags.set(args[i], args[i + 1]);
}
assert.equal(flags.size, 4);
const build = flags.get('--build-root');
const sdkRoot = flags.get('--sdk-root');
const evidence = flags.get('--evidence-root');
const { prepareOpenCode } = await import(pathToFileURL(path.join(build, 'src/ai.js')).href);
const { opencodeSupport, bundledSkillNames } = await import(pathToFileURL(path.join(build, 'src/ai-config.js')).href);
const root = await fs.mkdtemp('/tmp/opencode/cocos4-ai-real-');
const home = path.join(root, 'home');
const repository = path.join(root, 'repository');
const workspace = path.join(repository, 'workspace with spaces');
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(repository, { mode: 0o700 });
await fs.mkdir(workspace, { mode: 0o700 });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const manifestBefore = sha256(await fs.readFile(path.join(sdkRoot, 'manifest.json')));
// A fixture repository with a remote-derived identity would normally make this
// client write .git/opencode. No checkout, remote request, or user Git config.
for (const argv of [['init', '--quiet', repository], ['-C', repository, 'config', 'remote.origin.url', 'https://example.invalid/cocos4-ai-fixture.git']]) {
    await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/git', argv, { env: { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' },
            shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.resume();
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error('Fixture git setup failed.')));
    });
}
async function gitDigest() {
    const records = [];
    async function walk(directory) {
        for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(filename);
            else records.push([path.relative(repository, filename), sha256(await fs.readFile(filename))]);
        }
    }
    await walk(path.join(repository, '.git'));
    return sha256(JSON.stringify(records));
}
const gitBefore = await gitDigest();
let prepared;
const reports = [];
async function capture(name, argv, expectedCode = 0) {
    await prepared.verifyExecutable();
    const noEnv = name === 'mcp-list';
    const command = noEnv ? '/usr/bin/bwrap' : prepared.executable;
    let actualArgs = argv;
    if (noEnv) {
        const kit = path.dirname(build);
        // Packages use app/node_modules; source/focused builds hoist one level.
        // An existing but broken local symlink must not select the hoisted tree.
        let modulesRoot = path.join(build, 'node_modules');
        try { await fs.lstat(modulesRoot); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            modulesRoot = path.join(kit, 'node_modules');
        }
        const modules = await fs.realpath(modulesRoot);
        actualArgs = ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent',
            '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--ro-bind', kit, kit, '--ro-bind', modules, modules,
            '--ro-bind', sdkRoot, sdkRoot, '--bind', root, root,
            '--ro-bind', prepared.executable, prepared.executable, '--ro-bind', process.execPath, process.execPath,
            '--', prepared.executable, ...argv];
    }
    const result = await new Promise((resolve, reject) => {
        const child = spawn(command, actualArgs, { cwd: workspace, env: prepared.env, shell: false,
            stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let bytes = 0;
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.stdout.on('data', data => { bytes += data.length; if (bytes < 1024 * 1024) stdout += data; else child.kill('SIGKILL'); });
        child.stderr.on('data', data => { bytes += data.length; if (bytes < 1024 * 1024) stderr += data; else child.kill('SIGKILL'); });
        child.once('error', reject);
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ executable: prepared.executable, args: argv,
            command, actualArgs, hostEnvUnavailable: noEnv, code, signal, stdout, stderr }); });
    });
    await fs.writeFile(path.join(evidence, `opencode-${name}.json`), `${JSON.stringify({ ...result, expectedCode }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    reports.push({ name, code: result.code, expectedCode, signal: result.signal });
    assert.equal(result.code, expectedCode, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    return result;
}

try {
    const publicFile = path.join(workspace, 'permission-fixture.txt');
    const secretFile = path.join(workspace, '.env');
    const publicText = 'COCOS4_AI_PUBLIC_FIXTURE\n';
    const secretText = 'COCOS4_AI_TEST_SECRET=fixture-only-not-a-credential\n';
    await fs.writeFile(publicFile, publicText, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(secretFile, secretText, { flag: 'wx', mode: 0o600 });
    // No inherited credentials, user config, auth files or active client state.
    // Auth propagation is tested separately with dummy values in ai.test.mjs.
    prepared = await prepareOpenCode({ client: 'opencode', executable: flags.get('--executable'),
        workspace, sdkRoot, stateRoot: path.join(root, 'state'), mode: 'read-only', preview: false },
    { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1' });
    const version = await capture('version', ['--version']);
    assert.equal(version.stdout.trim(), opencodeSupport.version);
    const config = JSON.parse((await capture('config', ['debug', 'config'])).stdout);
    assert.deepEqual(config.mcp, prepared.config.mcp);
    assert.equal(config.mcp.cocos4.command[0], path.join(build, 'host/cocos4-mcp-launch'));
    assert.equal(config.mcp.cocos4.command.includes('/usr/bin/env'), false);
    assert.deepEqual(config.skills, prepared.config.skills);
    assert.deepEqual(config.permission, prepared.config.permission);
    assert.equal(config.default_agent, 'cocos4');
    const projects = JSON.parse((await capture('projects', ['debug', 'scrap'])).stdout);
    assert.ok(projects.length);
    assert.ok(projects.every(project => project.worktree === '/'), 'Client Git discovery expanded the workspace boundary.');
    const list = await capture('mcp-list', ['mcp', 'list']);
    const text = `${list.stdout}\n${list.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    assert.match(text, /cocos4\s+connected/);
    assert.match(text, /1 server\(s\)/);
    const skills = JSON.parse((await capture('skills', ['debug', 'skill'])).stdout);
    assert.deepEqual(skills.filter(skill => skill.name.startsWith('cocos4')).map(skill => skill.name).sort(), [...bundledSkillNames].sort());
    for (const name of bundledSkillNames) {
        const skill = skills.find(item => item.name === name);
        assert.ok(skill.location.startsWith(`${prepared.skillsRoot}/`));
        assert.ok(skill.description.length && skill.content.length);
    }
    const agent = JSON.parse((await capture('agent', ['debug', 'agent', 'cocos4'])).stdout);
    assert.equal(agent.name, 'cocos4');
    for (const permission of ['bash', 'task', 'webfetch', 'grep', 'glob', 'read']) {
        assert.equal(agent.permission.filter(rule => rule.permission === permission).at(-1).action, 'deny');
        assert.equal(agent.tools[permission], false);
    }
    assert.equal(agent.permission.filter(rule => rule.permission === 'edit' && rule.pattern === '*').at(-1).action, 'deny');
    assert.equal(agent.tools.cocos4_read, true);
    for (const tool of ['write', 'edit', 'apply_patch']) assert.equal(agent.tools[`cocos4_${tool}`], false);
    // Debug tool calls use the real client's permission evaluator without an LLM.
    const file = JSON.parse((await capture('read-file', ['debug', 'agent', 'cocos4', '--tool', 'cocos4_read',
        '--params', JSON.stringify({ filePath: publicFile })])).stdout);
    assert.ok(file.result.output.includes(publicText.trim()));
    const directory = JSON.parse((await capture('read-directory', ['debug', 'agent', 'cocos4', '--tool', 'cocos4_read',
        '--params', JSON.stringify({ filePath: workspace })])).stdout);
    assert.ok(directory.result.output.includes(path.basename(publicFile)));
    const denied = await capture('read-secret-denied', ['debug', 'agent', 'cocos4', '--tool', 'cocos4_read',
        '--params', JSON.stringify({ filePath: secretFile })], 1);
    assert.match(denied.stderr, /denied|prevents|permission/i);
    assert.equal(`${denied.stdout}${denied.stderr}`.includes(secretText.trim()), false);
    for (const tool of ['grep', 'glob']) {
        const blocked = await capture(`${tool}-denied`, ['debug', 'agent', 'cocos4', '--tool', tool,
            '--params', JSON.stringify({ pattern: tool === 'grep' ? 'COCOS4_AI_TEST_SECRET' : '.env', path: workspace })], 1);
        assert.match(blocked.stderr, new RegExp(`Tool ${tool} is disabled for agent cocos4`));
        assert.equal(`${blocked.stdout}${blocked.stderr}`.includes(secretText.trim()), false);
    }
    const builtin = await capture('builtin-read-denied', ['debug', 'agent', 'cocos4', '--tool', 'read',
        '--params', JSON.stringify({ filePath: publicFile })], 1);
    assert.match(builtin.stderr, /Tool read is disabled for agent cocos4/);
    assert.deepEqual((await fs.readdir(path.dirname(prepared.configFile))).sort(), ['.gitignore', 'opencode.json', 'tools']);
    assert.deepEqual((await fs.readdir(workspace)).sort(), ['.env', 'permission-fixture.txt']);
    assert.equal(await fs.readFile(publicFile, 'utf8'), publicText);
    assert.equal(await fs.readFile(secretFile, 'utf8'), secretText);
    assert.deepEqual(await fs.readdir(home), []);
    const gitAfter = await gitDigest();
    assert.equal(gitAfter, gitBefore, 'The client changed the fixture repository Git state.');
    const manifestAfter = sha256(await fs.readFile(path.join(sdkRoot, 'manifest.json')));
    assert.equal(manifestAfter, manifestBefore);
    const report = { executable: prepared.executable, version: prepared.version, schema: opencodeSupport,
        sdkId: prepared.sdkId, sdkRoot, manifestSha256Before: manifestBefore, manifestSha256After: manifestAfter,
        gitSha256Before: gitBefore, gitSha256After: gitAfter, clientWorktree: '/',
        config: prepared.config, configSha256: sha256(await fs.readFile(prepared.configFile)),
        discoveredSkills: skills.map(skill => ({ name: skill.name, location: skill.location })),
        checks: reports, modelRequests: 0, credentialsImported: false, modelGameplayDemonstration: false,
        limitations: ['Configuration, discovery and stdio evidence only; no model/gameplay demonstration.',
            'No vendor compilation or real-device acceptance.', 'No released portable archive or non-Linux host acceptance.'] };
    await prepared.cleanup();
    assert.equal((await fs.readdir(path.join(root, 'state'))).some(name => name.startsWith('ai-opencode-')), false);
    await fs.writeFile(path.join(evidence, 'opencode-evidence.json'), `${JSON.stringify({ ...report, temporaryConfigRemoved: true }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ version: prepared.version, sdkId: prepared.sdkId, mcp: 'connected', skills: bundledSkillNames,
        temporaryConfigRemoved: true, modelGameplayDemonstration: false, evidence }, null, 2));
} finally {
    await prepared?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
}
