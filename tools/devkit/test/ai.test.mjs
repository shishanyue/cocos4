import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const build = path.resolve(process.env.AI_TEST_BUILD_ROOT ?? path.join(devkit, 'build'));
const sdkRoot = path.resolve(process.env.AI_TEST_SDK_ROOT ?? path.join(devkit, 'build/game-sdk-isolated'));
const cli = path.join(build, 'src/cli.js');
const { parseAiArgs, parseConfigForConflicts, checkOpenCodeConflicts, openCodeEnvironment, prepareOpenCode } =
    await import(pathToFileURL(path.join(build, 'src/ai.js')).href);
const { makeOpenCodeConfig, validateOpenCodeConfig, opencodeSupport, bundledSkillNames } =
    await import(pathToFileURL(path.join(build, 'src/ai-config.js')).href);
const { opencodeSchema } = await import(pathToFileURL(path.join(build, 'src/ai-opencode-schema.js')).href);
const hash = value => createHash('sha256').update(value).digest('hex');
const absent = name => assert.rejects(fs.lstat(name), { code: 'ENOENT' });
const baseArgs = ['--client', 'opencode', '--executable', '/trusted/opencode', '--workspace', '/games',
    '--sdk-root', '/sdk', '--state-root', '/state'];

async function fixture(t) {
    const root = await fs.mkdtemp('/tmp/opencode/cocos4-ai-');
    const workspace = path.join(root, 'workspace with spaces \u6e38\u620f');
    const home = path.join(root, 'home');
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.mkdir(home, { mode: 0o700 });
    const executable = path.join(root, 'fake opencode');
    await fs.writeFile(executable, `#!${process.execPath}\n`
        + await fs.readFile(new URL('./fixtures/ai/fake-opencode.cjs', import.meta.url), 'utf8'), { mode: 0o700 });
    await fs.writeFile(`${executable}.version`, `${opencodeSupport.version}\n`);
    await fs.writeFile(`${executable}.scenario`, '0');
    const options = { client: 'opencode', executable, workspace, sdkRoot, stateRoot: path.join(root, 'state'), mode: 'read-only', preview: false };
    const env = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        ANTHROPIC_API_KEY: 'test-only-not-a-credential', COCOS4_TEST_PROVIDER_TOKEN: 'test-only-custom-provider' };
    const cleanup = [];
    t.after(async () => {
        for (const close of cleanup.reverse()) await close();
        await fs.rm(root, { recursive: true, force: true });
    });
    return { root, options, env, cleanup, executable, workspace, home,
        args: ['ai', '--client', 'opencode', '--executable', executable, '--workspace', workspace,
            '--sdk-root', sdkRoot, '--state-root', options.stateRoot] };
}

function run(command, args, options = {}) {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    return { child, done, output: () => stdout };
}

test('ai accepts only explicit roots/executable and fixed startup permissions', () => {
    assert.deepEqual(parseAiArgs(baseArgs), { client: 'opencode', executable: '/trusted/opencode',
        workspace: '/games', sdkRoot: '/sdk', stateRoot: '/state', mode: 'read-only', preview: false });
    assert.equal(parseAiArgs([...baseArgs, '--mode', 'develop', '--preview', 'true']).preview, true);
    for (const args of [[], baseArgs.slice(0, -2), [...baseArgs, '--', '--model'], [...baseArgs, '--prompt', 'hi'],
        [...baseArgs, '--execute-tests', 'true'], [...baseArgs, '--client', 'opencode'], [...baseArgs, '--preview', 'true'],
        [...baseArgs, '--mode', 'maintainer'], [...baseArgs, '--preview', 'yes'], [...baseArgs, '--mode'],
        baseArgs.map(value => value === '/trusted/opencode' ? 'opencode' : value),
        baseArgs.map(value => value === '/games' ? '/games/{env:SECRET}' : value),
        baseArgs.map(value => value === 'opencode' ? 'another-client' : value)]) assert.throws(() => parseAiArgs(args));
});

test('generated config is validated offline against the frozen official 2020-12 schema', () => {
    assert.equal(opencodeSupport.version, '1.18.21');
    assert.equal(hash(JSON.stringify(opencodeSchema)), opencodeSupport.schemaObjectSha256);
    assert.equal(opencodeSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    const config = makeOpenCodeConfig(parseAiArgs(baseArgs), '/runtime/node', '/kit/app/src/cli.js', '/kit/skills', '/state/session', '/kit/app/host/cocos4-mcp-launch');
    validateOpenCodeConfig(config);
    assert.equal(config.permission.edit, 'deny');
    assert.equal(config.permission.bash, 'deny');
    assert.equal(config.permission.task, 'deny');
    assert.equal(config.mcp.cocos4.type, 'local');
    assert.deepEqual(config.mcp.cocos4.command, ['/kit/app/host/cocos4-mcp-launch', 'cocos4-mcp-launch-v1',
        '--node', '/runtime/node', '--cli', '/kit/app/src/cli.js', '--session', '/state/session',
        '--sdk-root', '/sdk', '--workspace', '/games', '--state-root', '/state', '--mode', 'read-only', '--preview', 'false']);
    assert.deepEqual(config.skills, { paths: ['/kit/skills'] });
    for (const mutate of [
        value => { value.mcp.cocos4.command = 'node cli.js mcp'; },
        value => { value.skills = ['/kit/skills']; },
        value => { value.skills.urls = ['https://example.invalid/skills']; },
        value => { value.mcp.cocos4 = { type: 'remote', url: 'https://example.invalid' }; },
        value => { value.mcp.other = value.mcp.cocos4; },
        value => { value.permission.bash = 'always'; },
        value => { value.theme = 'ignored-unknown-key'; },
        value => { value.agent.cocos4.model = 'external/schema-ref'; },
    ]) { const value = structuredClone(config); mutate(value); assert.throws(() => validateOpenCodeConfig(value)); }
    const develop = makeOpenCodeConfig({ ...parseAiArgs(baseArgs), mode: 'develop', preview: true },
        '/runtime/node', '/kit/app/src/cli.js', '/kit/skills', '/state/session', '/kit/app/host/cocos4-mcp-launch');
    for (const value of [config, develop]) for (const tool of ['grep', 'glob', 'list']) {
        assert.equal(value.permission[tool], 'deny', `${tool} must not bypass per-file read rules or download ripgrep`);
        assert.equal(value.agent.cocos4.permission[tool], 'deny');
    }
    for (const value of [config, develop]) for (const tool of ['read', 'write', 'edit', 'apply_patch']) {
        assert.equal(value.permission[tool], 'deny');
        assert.equal(value.agent.cocos4.permission[tool], 'deny');
    }
    assert.equal(config.permission.cocos4_read, 'allow');
    assert.equal(develop.permission.cocos4_read, 'allow');
    for (const tool of ['write', 'edit', 'apply_patch']) {
        assert.equal(config.permission[`cocos4_${tool}`], 'deny');
        assert.equal(develop.permission[`cocos4_${tool}`], 'allow');
    }
    assert.equal(develop.permission.bash, 'deny');
    assert.deepEqual(develop.mcp.cocos4.command.slice(-4), ['--mode', 'develop', '--preview', 'true']);
    assert.match(develop.agent.cocos4.prompt, /cocos4_read/);
});

test('JSONC conflict parsing preserves strings, rejects duplicates and never expands secrets', () => {
    assert.deepEqual(parseConfigForConflicts('{/*x*/ "url":"https://host/,}", "value":"{env:SECRET}", //x\n}'),
        { url: 'https://host/,}', value: '{env:SECRET}' });
    for (const text of ['{"mcp":{},"mcp":{"cocos4":{}}}', '{"mcp":{"cocos4":{}},"mcp":{}}',
        '{"mcp":{},"\\u006dcp":{}}', '{"secret":"bad', 'null', '[]', '{/*unfinished}']) {
        assert.throws(() => parseConfigForConflicts(text));
    }
});

test('environment conflicts reject by name without printing values; provider environment survives only in AI child', async t => {
    const f = await fixture(t);
    assert.deepEqual(await checkOpenCodeConflicts(f.workspace, f.env), []);
    for (const name of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PERMISSION',
        'OPENCODE_TEST_HOME', 'OPENCODE_TEST_MANAGED_CONFIG_DIR', 'OPENCODE_PLUGIN_META_FILE', 'OPENCODE_PURE']) {
        await assert.rejects(checkOpenCodeConflicts(f.workspace, { ...f.env, [name]: 'sensitive-do-not-print' }), error =>
            error.code === 'OUTPUT_CONFLICT' && error.message.includes(name) && !JSON.stringify(error).includes('sensitive-do-not-print'));
    }
    const source = { ...f.env, NODE_OPTIONS: '--require=/bad/preload', NODE_PATH: '/ambient/modules',
        LD_PRELOAD: '/bad/library', npm_config_registry: 'https://private.invalid', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://private.invalid',
        GIT_WORK_TREE: '/untrusted', GIT_CONFIG_COUNT: '1', OPENCODE_API_KEY: 'test-only-opencode-provider' };
    const saved = structuredClone(source);
    const env = openCodeEnvironment(source, '/private/session');
    assert.deepEqual(source, saved);
    assert.equal(env.HOME, f.home);
    for (const key of ['ANTHROPIC_API_KEY', 'COCOS4_TEST_PROVIDER_TOKEN', 'OPENCODE_API_KEY']) assert.equal(env[key], source[key]);
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'npm_config_registry', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT']) assert.equal(env[key], undefined);
    assert.equal(env.GIT_DIR, '/private/session/no-git');
    assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1');
    assert.equal(env.npm_config_offline, 'true');
});

test('config and skill name collisions, malformed configs, remote skills and links fail closed without writes', async t => {
    const f = await fixture(t);
    const filename = path.join(f.workspace, 'opencode.jsonc');
    for (const text of ['{"mcp":{"cocos4":{"enabled":false}}}', '{"agent":{"cocos4":{}}}',
        '{"mode":{"cocos4":{}}}', '{"mcp":{"cocos4":{}},"mcp":{}}',
        '{"skills":{"urls":["https://example.invalid"]}}', '{invalid-secret-do-not-print}']) {
        await fs.writeFile(filename, text);
        const before = await fs.stat(filename);
        await assert.rejects(checkOpenCodeConflicts(f.workspace, f.env), { code: 'OUTPUT_CONFLICT' });
        assert.equal(await fs.readFile(filename, 'utf8'), text);
        assert.equal((await fs.stat(filename)).mtimeMs, before.mtimeMs);
    }
    await fs.unlink(filename);
    const skillDir = path.join(f.home, '.agents/skills/different-directory');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    for (const name of bundledSkillNames) {
        await fs.writeFile(skillFile, `---\nname: "${name}"\ndescription: collision\n---\n`);
        await assert.rejects(checkOpenCodeConflicts(f.workspace, f.env), { code: 'OUTPUT_CONFLICT' });
    }
    await fs.writeFile(skillFile, '---\n"name": cocos4-devkit\ndescription: collision\n---\n');
    await assert.rejects(checkOpenCodeConflicts(f.workspace, f.env), { code: 'OUTPUT_CONFLICT' });
    await fs.writeFile(skillFile, '---\n{"name":"cocos4-devkit"}\n---\n');
    await assert.rejects(checkOpenCodeConflicts(f.workspace, f.env), { code: 'OUTPUT_CONFLICT' });
    await fs.unlink(skillFile);
    await fs.symlink('/does-not-exist', skillFile);
    await assert.rejects(checkOpenCodeConflicts(f.workspace, f.env), { code: 'OUTPUT_CONFLICT' });
    await fs.unlink(skillFile);
    await fs.writeFile(skillFile, '---\nname: external-game-notes\ndescription: not imported\n---\n');
    await fs.writeFile(filename, '{"skills":{"paths":["../home/.agents/skills"]}}');
    assert.deepEqual(await checkOpenCodeConflicts(f.workspace, f.env), [filename]);
});

test('startup validates roots before launching, without changing existing state permissions', async t => {
    const f = await fixture(t);
    await assert.rejects(prepareOpenCode({ ...f.options, stateRoot: f.workspace }, f.env), { code: 'PERMISSION_DENIED' });
    await assert.rejects(prepareOpenCode({ ...f.options, executable: path.join(f.root, 'absent') }, f.env), { code: 'INVALID_ARGUMENTS' });
    await fs.mkdir(f.options.stateRoot, { mode: 0o755 });
    await assert.rejects(prepareOpenCode(f.options, f.env), { code: 'PERMISSION_DENIED' });
    assert.equal((await fs.stat(f.options.stateRoot)).mode & 0o777, 0o755);
    await fs.rmdir(f.options.stateRoot);
    await fs.symlink(f.home, f.options.stateRoot);
    await assert.rejects(prepareOpenCode(f.options, f.env), { code: 'PERMISSION_DENIED' });
    await absent(`${f.executable}.probe`);
});

test('private config, source-independent paths, auth separation, SDK binding and cleanup', async t => {
    const f = await fixture(t);
    const globalDir = path.join(f.home, '.config/opencode');
    await fs.mkdir(globalDir, { recursive: true });
    const globalFile = path.join(globalDir, 'opencode.json');
    const contents = '{"provider":{"unrelated":{"options":{"apiKey":"do-not-copy-test-value"}}}}';
    await fs.writeFile(globalFile, contents);
    const before = await fs.stat(globalFile);
    const source = structuredClone(f.env);
    const prepared = await prepareOpenCode(f.options, f.env);
    f.cleanup.push(prepared.cleanup);
    assert.equal(prepared.version, opencodeSupport.version);
    assert.match(prepared.sdkId, /^sha256-[a-f0-9]{64}$/);
    assert.deepEqual(prepared.ignoredConfigs, [globalFile]);
    assert.deepEqual(f.env, source);
    assert.equal((await fs.stat(prepared.session)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(prepared.configFile)).mode & 0o777, 0o400);
    assert.equal((await fs.stat(path.dirname(prepared.configFile))).mode & 0o777, 0o500);
    const toolFile = path.join(path.dirname(prepared.configFile), 'tools/cocos4.js');
    assert.equal((await fs.stat(path.dirname(toolFile))).mode & 0o777, 0o500);
    assert.equal((await fs.stat(toolFile)).mode & 0o777, 0o400);
    assert.match(await fs.readFile(toolFile, 'utf8'), /createFileTools/);
    assert.doesNotMatch(await fs.readFile(toolFile, 'utf8'), /@opencode-ai\/plugin|test-only/);
    await assert.rejects(fs.access(path.dirname(prepared.configFile), 2), { code: 'EACCES' });
    const configText = await fs.readFile(prepared.configFile, 'utf8');
    assert.equal(configText.includes('test-only-not-a-credential'), false);
    assert.equal(configText.includes('do-not-copy-test-value'), false);
    assert.equal(prepared.env.ANTHROPIC_API_KEY, f.env.ANTHROPIC_API_KEY);
    assert.deepEqual(JSON.parse(await fs.readFile(`${f.executable}.probe`, 'utf8')), { providerPresent: false, preloadPresent: false });
    assert.equal(await fs.readFile(globalFile, 'utf8'), contents);
    assert.equal((await fs.stat(globalFile)).mtimeMs, before.mtimeMs);
    const command = prepared.config.mcp.cocos4.command;
    assert.deepEqual(command, [path.join(build, 'host/cocos4-mcp-launch'), 'cocos4-mcp-launch-v1',
        '--node', await fs.realpath(process.execPath), '--cli', cli, '--session', prepared.session,
        '--sdk-root', sdkRoot, '--workspace', f.workspace, '--state-root', f.options.stateRoot,
        '--mode', 'read-only', '--preview', 'false']);
    const capture = await run(command[0], [...command.slice(1), '-p', 'JSON.stringify(process.env)'], { env: f.env }).done;
    assert.equal(capture.code, 64, 'The helper must not provide the old env-style eval passthrough');
    assert.equal(capture.stdout, '');
    await prepared.cleanup();
    await prepared.cleanup();
    await absent(prepared.session);
    assert.deepEqual(await fs.readdir(f.options.stateRoot), []);
});

test('wrong client version fails before a session and cleans its private config', async t => {
    const f = await fixture(t);
    await fs.writeFile(`${f.executable}.version`, '1.18.22\n');
    const result = await run(process.execPath, [cli, ...f.args], { cwd: f.root, env: f.env }).done;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'SDK_INCOMPLETE');
    assert.match(result.stderr, /1\.18\.21/);
    assert.deepEqual(await fs.readdir(f.options.stateRoot), []);
});

test('executable changes after version verification are rejected', async t => {
    const f = await fixture(t);
    const prepared = await prepareOpenCode(f.options, f.env);
    f.cleanup.push(prepared.cleanup);
    await fs.appendFile(f.executable, '\n// changed after verification\n');
    await assert.rejects(prepared.verifyExecutable(), { code: 'INPUT_CHANGED' });
});

test('startup rejects missing, unsafe or non-static shipped helpers and checks identity again before client launch', async t => {
    const f = await fixture(t);
    const kit = path.join(f.root, 'kit');
    const app = path.join(kit, 'app');
    await fs.cp(path.join(build, 'src'), path.join(app, 'src'), { recursive: true, errorOnExist: true, force: false });
    await fs.writeFile(path.join(kit, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
    await fs.symlink(path.join(path.dirname(build), 'node_modules'), path.join(kit, 'node_modules'));
    await fs.cp(path.join(path.dirname(build), 'skills'), path.join(kit, 'skills'), { recursive: true, errorOnExist: true, force: false });
    await fs.mkdir(path.join(app, 'host'));
    const helper = path.join(app, 'host/cocos4-mcp-launch');
    const binary = await fs.readFile(path.join(build, 'host/cocos4-mcp-launch'));
    const metadata = await fs.readFile(path.join(build, 'host/cocos4-mcp-launch.build.json'));
    const { prepareOpenCode: prepare } = await import(pathToFileURL(path.join(app, 'src/ai.js')).href);
    const refused = async () => {
        await assert.rejects(prepare(f.options, f.env), { code: 'SDK_INCOMPLETE' });
        await absent(`${f.executable}.probe`);
        await absent(f.options.stateRoot);
    };
    await refused();
    await fs.writeFile(helper, binary, { mode: 0o755 });
    await refused();
    await fs.writeFile(`${helper}.build.json`, metadata);
    for (const mutate of [value => { value.protocol = 'other'; }, value => { value.linkage = 'dynamic'; },
        value => { value.binarySha256 = '0'.repeat(64); }, value => { value.bytes++; }]) {
        const report = JSON.parse(metadata); mutate(report);
        await fs.writeFile(`${helper}.build.json`, JSON.stringify(report)); await refused();
    }
    await fs.writeFile(`${helper}.build.json`, metadata);
    for (const mode of [0o644, 0o777, 0o4755]) { await fs.chmod(helper, mode); await refused(); }
    await fs.chmod(helper, 0o755);
    await fs.link(helper, `${helper}.alias`); await refused(); await fs.unlink(`${helper}.alias`);
    await fs.rename(helper, `${helper}.saved`);
    await fs.symlink(`${helper}.saved`, helper); await refused(); await fs.unlink(helper);
    await fs.rename(`${helper}.saved`, helper);
    for (const kind of [2, 3]) {
        const changed = Buffer.from(binary);
        changed.writeUInt32LE(kind, Number(changed.readBigUInt64LE(32)));
        await fs.writeFile(helper, changed);
        await fs.writeFile(`${helper}.build.json`, JSON.stringify({ ...JSON.parse(metadata), binarySha256: hash(changed) }));
        await refused();
    }
    await fs.writeFile(helper, binary); await fs.writeFile(`${helper}.build.json`, metadata);
    await fs.chmod(helper, 0o555); await fs.chmod(`${helper}.build.json`, 0o444);
    const prepared = await prepare(f.options, f.env);
    f.cleanup.push(prepared.cleanup);
    await fs.chmod(helper, 0o755);
    await fs.appendFile(helper, '\0');
    await assert.rejects(prepared.verifyExecutable(), { code: 'INPUT_CHANGED' });
});

test('ai CLI launches only the fixed no-argument client and propagates exit status', async t => {
    const f = await fixture(t);
    await fs.writeFile(`${f.executable}.scenario`, '7');
    const result = await run(process.execPath, [cli, ...f.args, '--mode', 'develop', '--preview', 'true'], {
        env: f.env, cwd: f.root,
    }).done;
    assert.equal(result.code, 7, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.cwd, f.workspace);
    assert.deepEqual(record.args, []);
    assert.equal(record.agent, 'cocos4');
    assert.equal(record.edit, 'deny');
    assert.equal(record.safeWrite, 'allow');
    assert.equal(record.provider, f.env.ANTHROPIC_API_KEY);
    assert.equal(record.customProvider, f.env.COCOS4_TEST_PROVIDER_TOKEN);
    assert.equal(record.preload, null);
    assert.equal(record.home, f.home);
    await absent(record.configFile);
    assert.deepEqual(await fs.readdir(f.options.stateRoot), []);
    assert.deepEqual(await fs.readdir(f.workspace), []);
});

test('handled termination forwards to the client and removes only the owned temporary config', async t => {
    const f = await fixture(t);
    await fs.writeFile(`${f.executable}.scenario`, 'wait');
    const pending = run(process.execPath, [cli, ...f.args], { env: f.env, cwd: f.root });
    f.cleanup.push(async () => { pending.child.kill('SIGKILL'); await pending.done; });
    while (!pending.output().includes('\n')) await once(pending.child.stdout, 'data');
    const record = JSON.parse(pending.output());
    pending.child.kill('SIGTERM');
    const result = await pending.done;
    assert.equal(result.code, 143, result.stderr);
    await absent(record.configFile);
    assert.deepEqual(await fs.readdir(f.options.stateRoot), []);
});

test('termination during version probing also cleans the private config without launching a client session', async t => {
    const f = await fixture(t);
    await fs.writeFile(`${f.executable}.version`, 'wait');
    const pending = run(process.execPath, [cli, ...f.args], { env: f.env, cwd: f.root });
    f.cleanup.push(async () => { pending.child.kill('SIGKILL'); await pending.done; });
    const deadline = Date.now() + 60000;
    for (;;) {
        try { await fs.stat(`${f.executable}.probe`); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; await delay(50); }
    }
    pending.child.kill('SIGTERM');
    const result = await pending.done;
    assert.equal(result.code, 143, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(await fs.readdir(f.options.stateRoot), []);
});

test('official SDK client discovers read-only tools through the exact isolated MCP command; preloads never run', async t => {
    const f = await fixture(t);
    const prepared = await prepareOpenCode(f.options, f.env);
    f.cleanup.push(prepared.cleanup);
    const marker = path.join(f.root, 'preload-ran');
    const preload = path.join(f.root, 'bad-preload.cjs');
    await fs.writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('preload escaped');`);
    const command = prepared.config.mcp.cocos4.command;
    // A fresh root also keeps ancestor ownership meaningful in an unprivileged
    // user namespace. Only explicit runtimes, dependencies and inputs are bound.
    const kit = path.dirname(build);
    const modules = await fs.realpath(path.join(kit, 'node_modules'));
    const mounts = ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent',
        '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
        '--proc', '/proc', '--dev', '/dev', '--ro-bind', kit, kit, '--ro-bind', modules, modules,
        '--ro-bind', sdkRoot, sdkRoot, '--bind', f.root, f.root,
        '--ro-bind', await fs.realpath(process.execPath), await fs.realpath(process.execPath)];
    const startup = await run('/usr/bin/bwrap', [...mounts, '--', process.execPath, cli, ...f.args], { env: f.env, cwd: f.workspace }).done;
    assert.equal(startup.code, 0, startup.stderr);
    assert.equal(JSON.parse(startup.stdout).agent, 'cocos4');
    const namespace = [...mounts,
        '--setenv', 'NODE_OPTIONS', `--require=${preload}`, '--setenv', 'ANTHROPIC_API_KEY', f.env.ANTHROPIC_API_KEY,
        '--', ...command];
    const transport = new StdioClientTransport({ command: '/usr/bin/bwrap', args: namespace, cwd: f.workspace,
        env: { HOME: f.home, PATH: '', LANG: 'C.UTF-8' }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data', bytes => { stderr += bytes; });
    const client = new Client({ name: 'cocos4-ai-deterministic-test', version: '1.0.0' });
    const errors = [];
    client.onerror = error => errors.push(error.message);
    f.cleanup.push(() => client.close());
    try { await client.connect(transport, { timeout: 120000 }); }
    catch (error) { throw new Error(`MCP connection failed: ${stderr}`, { cause: error }); }
    const child = transport._process;
    const closed = once(child, 'close');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    assert.ok(tools.some(tool => tool.name === 'cocos4_catalog'));
    assert.equal(tools.some(tool => tool.name === 'cocos4_project_create'), false);
    assert.equal(tools.some(tool => tool.name === 'cocos4_game_build'), false);
    const catalog = await client.callTool({ name: 'cocos4_catalog', arguments: { section: 'sdk' } });
    assert.equal(catalog.isError, false);
    assert.equal(catalog.structuredContent.sdkId, prepared.sdkId);
    const docs = await client.callTool({ name: 'cocos4_docs_search', arguments: { query: 'Component', kind: 'api', limit: 1 } });
    assert.equal(docs.isError, false);
    assert.ok(docs.structuredContent.data.availableKinds.includes('api'));
    assert.equal(docs.structuredContent.data.items.length, 1);
    const document = await client.callTool({ name: 'cocos4_docs_read', arguments: { documentId: docs.structuredContent.data.items[0].documentId } });
    assert.equal(document.isError, false);
    assert.ok(document.structuredContent.data.content.length);
    child.stdin.end();
    assert.deepEqual(await closed, [0, null]);
    await client.close();
    assert.equal(stderr, '');
    assert.deepEqual(errors, []);
    await absent(marker);
    if (process.env.AI_TEST_EVIDENCE_ROOT) await fs.writeFile(path.join(process.env.AI_TEST_EVIDENCE_ROOT, 'stdio-evidence.json'),
        `${JSON.stringify({ sdkId: prepared.sdkId, client: client.getServerVersion(), tools: tools.map(tool => tool.name),
            catalog: catalog.structuredContent, docs: docs.structuredContent, document: document.structuredContent,
            command, namespace, startupWithoutHostEnv: startup, hostEnvUnavailable: true, preloadExecuted: false, exitCode: 0, stderr,
            modelGameplayDemonstration: false }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
});
