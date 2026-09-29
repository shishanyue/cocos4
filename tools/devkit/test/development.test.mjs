import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { verifyBrowserGame } from './browser-game.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const cli = join(devkit, 'build/src/cli.js');
const sdkRoot = resolve(process.env.GAME_OPERATION_SDK_ROOT ?? join(devkit, 'build/game-sdk'));
const legacyRoot = resolve(process.env.LEGACY_HTML5_SDK_ROOT ?? join(devkit, 'build/legacy-game-sdk'));
const requestOptions = { timeout: 20000 };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const readonlyNames = ['catalog', 'docs_search', 'docs_read', 'project_inspect', 'doctor', 'package_validate',
    'jobs_list', 'job_get', 'job_logs', 'job_cancel'];
const developNames = ['project_create', 'project_check', 'game_build'];
const previewNames = ['preview_start', 'preview_stop'];
const ajv = new AjvJsonSchemaValidator();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
const checkInput = (project, profile = '2d-basic') => ({ project, target: 'HTML5', profile, checks: ['types'], requestKey: randomUUID() });
const buildInput = (project, profile = '2d-basic') => ({ project, target: 'HTML5', profile, variant: 'debug', requestKey: randomUUID() });
const permissionFlags = mode => mode === 'preview' ? ['--mode', 'develop', '--preview', 'true']
    : mode === 'develop' ? ['--mode', 'develop'] : [];
const flags = env => ['--sdk-root', env.sdkRoot, '--workspace', env.workspace, '--state-root', env.stateRoot];

async function until(predicate, message, timeout = 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await delay(100);
    }
    assert.fail(message);
}

async function bounded(promise, milliseconds, message) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}

async function fixture(t, sdkId, selectedSdkRoot = sdkRoot) {
    const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'cocos4-development-'));
    const cleanup = [];
    const env = { root, sdkId, sdkRoot: selectedSdkRoot, workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), home: join(root, 'home'),
        cleanup, signal: t.signal };
    for (const directory of [env.workspace, env.home]) await fs.mkdir(directory, { mode: 0o700 });
    env.stateDirectory = join(env.stateRoot, hash(env.workspace));
    t.diagnostic(`Node ${process.version}; retained development workspace/state: ${root}`);
    // Reap children, but retain reports and immutable artifacts even after assertions fail.
    t.after(async () => {
        const failures = [];
        for (const close of cleanup.reverse()) try { await close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, `Shutdown failed; preserved ${root}`);
    });
    return env;
}

function envelope(value, validate, env, errorCode = null) {
    const checked = validate(value);
    assert.equal(checked.valid, true, checked.errorMessage);
    assert.deepEqual(Object.keys(value).sort(), ['data', 'error', 'ok', 'schemaVersion', 'sdkId', 'warnings']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.sdkId, env.sdkId);
    assert.equal(value.ok, errorCode === null, JSON.stringify(value.error));
    assert.deepEqual(value.warnings, []);
    if (errorCode === null) { assert.equal(value.error, null); assert.notEqual(value.data, null); }
    else { assert.equal(value.data, null); assert.equal(value.error.code, errorCode); }
    return value.data;
}

class ObservedTransport extends StdioClientTransport {
    messages = [];
    async start() {
        const receive = this.onmessage;
        this.onmessage = message => {
            assert.ok(Buffer.byteLength(JSON.stringify(message)) + 1 <= 65536, 'MCP response exceeds 64 KiB');
            this.messages.push(message);
            receive?.(message);
        };
        await super.start();
        // Observe the pinned official SDK's child only for EOF/signal evidence;
        // all framing, initialization, requests and responses remain SDK-owned.
        this.child = this._process;
        this.exited = new Promise(resolve => this.child.once('close', (code, signal) => resolve({ code, signal })));
    }
}

async function connect(env, mode = 'preview') {
    const transport = new ObservedTransport({ command: process.execPath,
        args: [cli, 'mcp', ...flags(env), ...permissionFlags(mode)], cwd: env.workspace,
        env: { HOME: env.home, PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true' }, stderr: 'pipe' });
    const client = new Client({ name: 'cocos4-development-regression', version: '1.0.0' }, { jsonSchemaValidator: ajv });
    const errors = [];
    let stderr = '';
    let closing;
    client.onerror = error => errors.push(error);
    transport.stderr.on('data', bytes => { stderr += bytes; });
    const abort = () => transport.child?.kill('SIGKILL');
    env.signal.addEventListener('abort', abort, { once: true });
    const close = (signal = 'EOF') => {
        if (closing) return closing;
        closing = (async () => {
            try {
                if (transport.child && transport.child.exitCode === null && transport.child.signalCode === null) {
                    if (signal === 'EOF') transport.child.stdin.end();
                    else transport.child.kill(signal);
                }
                if (transport.exited) {
                    let outcome;
                    try { outcome = await bounded(transport.exited, 15000, `MCP did not stop after ${signal}`); }
                    catch (error) { abort(); await transport.exited; throw error; }
                    assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
                }
                assert.equal(stderr, '');
                assert.deepEqual(errors, []);
            } finally { env.signal.removeEventListener('abort', abort); await client.close(); }
        })();
        return closing;
    };
    env.cleanup.push(close);
    let discovery;
    try {
        await client.connect(transport, { timeout: 60000 });
        discovery = await client.listTools(undefined, requestOptions);
    } catch (error) {
        throw new Error(`MCP ${mode} startup/discovery failed: ${error.message}; exit=${transport.child?.exitCode}; signal=${transport.child?.signalCode}; stderr=${JSON.stringify(stderr)}; state=${env.stateRoot}`, { cause: error });
    }
    const { tools, nextCursor } = discovery;
    assert.equal(nextCursor, undefined);
    const validators = new Map(tools.map(tool => [tool.name, ajv.getValidator(tool.outputSchema)]));
    return { client, transport, tools, validators, close,
        async call(shortName, args = {}, errorCode = null) {
            const name = `cocos4_${shortName}`;
            const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, requestOptions);
            assert.equal(result.isError, errorCode !== null, JSON.stringify(result.structuredContent));
            assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
            return envelope(result.structuredContent, validators.get(name), env, errorCode);
        } };
}

async function finished(session, receipt) {
    assert.match(receipt.jobId, /^[a-f0-9-]{36}$/);
    assert.ok(receipt.pollAfterMs > 0);
    return until(async () => {
        const page = await session.call('job_get', { jobId: receipt.jobId, limit: 100 });
        return terminal.has(page.job.state) && page;
    }, `Job ${receipt.jobId} did not finish`);
}

function succeeded(page) {
    assert.equal(page.job.state, 'succeeded', JSON.stringify(page));
    assert.equal(page.job.error, null);
    assert.ok(page.report);
    assert.ok(page.job.finishedAt >= page.job.startedAt);
    return page;
}

async function ready(session, receipt) {
    return until(async () => {
        const page = await session.call('job_get', { jobId: receipt.jobId });
        assert.ok(!terminal.has(page.job.state), `Preview stopped before ready: ${JSON.stringify(page)}`);
        return page.job.phase === 'ready' && page.job;
    }, 'Preview never became ready', 30000);
}

function get(preview, overrides = {}) {
    const url = new URL(preview.url);
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: preview.port, path: url.pathname, agent: false,
            ...overrides }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('Preview HTTP timed out')));
        request.end();
    });
}

async function socketProbe(env, preview) {
    const socket = net.connect({ host: '127.0.0.1', port: preview.port });
    socket.on('error', () => {});
    socket.resume();
    env.cleanup.push(() => socket.destroy());
    const closed = new Promise(resolve => socket.once('close', resolve));
    await once(socket, 'connect');
    socket.write(`GET ${new URL(preview.url).pathname} HTTP/1.1\r\n`);
    return { closed, socket };
}

async function closedPreview(preview, probe) {
    if (probe) await bounded(probe.closed, 5000, 'Preview left an established socket open');
    await assert.rejects(get(preview), error => error.code === 'ECONNREFUSED');
}

function launchCli(env, args, mode = 'preview') {
    const child = spawn(process.execPath, [cli, ...args, ...flags(env), ...permissionFlags(mode)], {
        cwd: env.workspace, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { HOME: env.home, PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true' },
    });
    const lines = [];
    const errors = [];
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.on('error', error => errors.push(error));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') errors.push(error); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) child.kill('SIGKILL');
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try { assert.ok(Buffer.byteLength(line) + 1 <= 65536); lines.push(JSON.parse(line)); }
            catch (error) { errors.push(error); }
        }
    });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    const timer = setTimeout(kill, 150000);
    env.signal.addEventListener('abort', kill, { once: true });
    const done = new Promise(resolve => child.once('close', (code, signal) => {
        clearTimeout(timer);
        env.signal.removeEventListener('abort', kill);
        resolve({ code, signal, stdout, stderr, lines });
    }));
    env.cleanup.push(async () => { kill(); await done; assert.deepEqual(errors, []); assert.equal(pending, ''); });
    child.stdin.end();
    return { child, done, lines };
}

async function cliResult(process, code = 0) {
    const result = await process.done;
    assert.equal(result.signal, null);
    assert.equal(result.code, code, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'));
    return result.lines;
}

async function changeProject(env, project, revision) {
    const filename = join(env.workspace, project, 'src/main.ts');
    const title = `DEVELOPMENT_${project}_${revision}`;
    let source = await fs.readFile(filename, 'utf8');
    assert.match(source, /pointsPerClick = 7/);
    assert.match(source, /'CLICK THE TILE'/);
    source = source.replace('pointsPerClick = 7', 'pointsPerClick = 11').replace("'CLICK THE TILE'", JSON.stringify(title));
    source += `\nexport const developmentRevision = ${JSON.stringify(revision)};\n`;
    await fs.writeFile(filename, source);
    const rules = `${JSON.stringify({ title, restart: 'R restarts the current edited game' })}\n`;
    await fs.writeFile(join(env.workspace, project, 'assets/rules.json'), rules);
    await fs.writeFile(join(env.workspace, project, 'assets/development.txt'), revision);
    const marker = join(env.root, 'PROJECT_SCRIPTS_EXECUTED');
    const canary = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'EXECUTED'); throw new Error('PROJECT CODE RAN');`;
    await fs.writeFile(join(env.workspace, project, 'babel.config.cjs'), canary);
    await fs.writeFile(join(env.workspace, project, 'hook.cjs'), canary);
    const pkgFile = join(env.workspace, project, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    pkg.scripts = { build: 'node hook.cjs', test: 'node hook.cjs', postinstall: 'node hook.cjs' };
    await fs.writeFile(pkgFile, JSON.stringify(pkg));
    return { source, rules, revision };
}

async function verifyArtifact(env, artifact, edited) {
    assert.equal(artifact.sdkId, env.sdkId);
    const directory = join(env.stateDirectory, `artifact-${artifact.artifactId}`);
    const raw = await fs.readFile(join(directory, 'artifact-inventory.json'));
    assert.equal(hash(raw), artifact.sha256);
    const inventory = JSON.parse(raw);
    assert.equal(inventory.files.length, artifact.files);
    assert.equal(inventory.files.reduce((sum, file) => sum + file.bytes, 0), artifact.bytes);
    assert.ok(!inventory.files.some(file => /^(?:types|template|toolchain|node_modules)\//.test(file.path)));
    for (const file of inventory.files) {
        const bytes = await fs.readFile(join(directory, file.path));
        assert.equal(bytes.length, file.bytes);
        assert.equal(hash(bytes), file.sha256, file.path);
    }
    const emitted = await fs.readFile(join(directory, 'game/main.js'), 'utf8');
    assert.ok(emitted.includes(edited.revision));
    assert.equal(await fs.readFile(join(directory, 'assets/game/rules.json'), 'utf8'), edited.rules);
    assert.equal(await fs.readFile(join(directory, 'assets/game/development.txt'), 'utf8'), edited.revision);
    for (const name of ['package.json', 'hook.cjs', 'babel.config.cjs', 'runtime.json', 'compiler-dependencies.json']) await absent(join(directory, name));
    const metadata = JSON.parse(await fs.readFile(join(directory, 'game-compiler.json'), 'utf8'));
    assert.deepEqual([metadata.typeChecked, metadata.profileChecked, metadata.emitted, metadata.checkOnly], [true, true, true, false]);
    assert.deepEqual([metadata.typeChecking.strict, metadata.typeChecking.skipLibCheck, metadata.typeChecking.skipDefaultLibCheck], [true, false, false]);
}

async function browserCheck(t, preview, artifact, profile, artifactDirectory) {
    if (!process.env.GAME_CHROME_EXECUTABLE) return;
    assert.equal(profile, artifact.profile);
    const { evidenceDirectory, report } = await verifyBrowserGame({ preview, artifact, artifactDirectory,
        executablePath: process.env.GAME_CHROME_EXECUTABLE });
    t.diagnostic(JSON.stringify({ evidenceDirectory, artifactId: artifact.artifactId, validation: report.validation }));
}

// Positive release builds use the full SDK in release-development.test.mjs, not this persisted debug-only pack.
test('legacy debug-only SDK rejects unavailable release profiles through MCP and CLI before creating jobs', { timeout: 120000 }, async t => {
    try { assert.ok((await fs.lstat(legacyRoot)).isDirectory(), 'LEGACY_HTML5_SDK_ROOT must be a directory'); }
    catch (error) {
        if (error.code === 'ENOENT' && process.env.LEGACY_HTML5_SDK_ROOT === undefined && process.env.GAME_SDK_INTEGRATION !== '1') {
            return t.skip('Saved debug-only SDK absent; set LEGACY_HTML5_SDK_ROOT to require missing-profile verification.');
        }
        throw error;
    }
    const manifestBytes = await fs.readFile(join(legacyRoot, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.ok(manifest.development, 'Missing-profile verification requires a real game-development pack');
    assert.deepEqual(manifest.catalog.profiles.map(item => `${item.target}/${item.id}/${item.variant}`).sort(),
        ['HTML5/2d-basic/debug', 'HTML5/3d-basic/debug']);
    const env = await fixture(t, manifest.sdkId, legacyRoot);
    const session = await connect(env, 'develop');
    const input = { ...buildInput('absent-game'), variant: 'release' };
    const tool = session.tools.find(tool => tool.name === 'cocos4_game_build');
    assert.equal(ajv.getValidator(tool.inputSchema)(input).valid, true);
    const metadata = await fs.readFile(join(env.stateDirectory, 'metadata.json'));
    await session.call('game_build', input, 'PROFILE_NOT_AVAILABLE');
    assert.deepEqual((await session.call('jobs_list')).items, []);
    assert.deepEqual(await fs.readdir(env.workspace), []);
    assert.ok(!(await fs.readdir(env.stateDirectory)).some(name => /^(?:staging|artifact)-/.test(name)));
    assert.deepEqual(await fs.readFile(join(env.stateDirectory, 'metadata.json')), metadata);
    await session.close();

    const stateFiles = (await fs.readdir(env.stateDirectory)).sort();
    const lines = await cliResult(launchCli(env, ['call', 'cocos4_game_build', '--input', JSON.stringify({ ...input, requestKey: randomUUID() })], 'develop'), 1);
    assert.equal(lines.length, 1);
    envelope(lines[0], session.validators.get('cocos4_game_build'), env, 'PROFILE_NOT_AVAILABLE');
    assert.deepEqual(await fs.readdir(env.workspace), []);
    assert.deepEqual((await fs.readdir(env.stateDirectory)).sort(), stateFiles);
    assert.deepEqual(await fs.readFile(join(env.stateDirectory, 'metadata.json')), metadata);
    assert.deepEqual(await fs.readFile(join(legacyRoot, 'manifest.json')), manifestBytes);
});

// Each independent CLI/worker revalidates the full indexed SDK. Budget the whole
// workflow separately from its unchanged per-request, child and production deadlines.
test('real development SDK through official MCP/Ajv and CLI, with durable preview lifecycle', { timeout: 1200000, concurrency: false }, async t => {
    try { assert.ok((await fs.lstat(sdkRoot)).isDirectory(), 'GAME_OPERATION_SDK_ROOT must be a directory'); }
    catch (error) {
        if (error.code === 'ENOENT' && !process.env.GAME_OPERATION_SDK_ROOT && process.env.GAME_SDK_INTEGRATION !== '1') {
            t.skip('Default real development SDK absent; set GAME_OPERATION_SDK_ROOT or require GAME_SDK_INTEGRATION=1.');
            return;
        }
        throw error;
    }
    const manifestBytes = await fs.readFile(join(sdkRoot, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.ok(manifest.development, 'Integration requires a real game-development pack, not the readonly catalog');
    const env = await fixture(t, manifest.sdkId);
    const templateId = profile => {
        const template = manifest.catalog.templates.find(item => item.profile === profile && item.target === 'HTML5' && item.variant === 'debug');
        assert.ok(template, `Missing real ${profile} starter`);
        return template.id;
    };
    t.diagnostic(`Node ${process.version}; official SDK stdio/Ajv; real ${manifest.sdkId}`);
    if (!process.env.GAME_CHROME_EXECUTABLE) t.diagnostic('Browser not requested; GAME_CHROME_EXECUTABLE enables actual edited-game rendering/input checks.');

    await t.test('startup capability gates expose exactly 10/13/15 tools and cannot be escalated by arguments', async t => {
        // A failed gate must not leave a server owning the later development workflow.
        const env = await fixture(t, manifest.sdkId);
        for (const [mode, names] of [['readonly', readonlyNames], ['develop', [...readonlyNames, ...developNames]],
            ['preview', [...readonlyNames, ...developNames, ...previewNames]]]) {
            const session = await connect(env, mode);
            t.after(() => session.close());
            assert.deepEqual(session.tools.map(tool => tool.name).sort(), names.map(name => `cocos4_${name}`).sort());
            assert.deepEqual(session.client.getServerCapabilities(), { tools: {}, resources: {} });
            for (const tool of session.tools) {
                assert.equal(tool.inputSchema.additionalProperties, false);
                assert.equal(tool.outputSchema.additionalProperties, false);
                assert.equal(session.validators.get(tool.name)({}).valid, false);
            }
            for (const name of [...developNames, ...previewNames].filter(name => !names.includes(name))) {
                await assert.rejects(session.client.callTool({ name: `cocos4_${name}`, arguments: { mode: 'develop', preview: true } },
                    CallToolResultSchema, requestOptions), error => error instanceof McpError && error.code === ErrorCode.MethodNotFound);
            }
            if (mode !== 'readonly') {
                const tool = session.tools.find(tool => tool.name === 'cocos4_project_check');
                const validate = ajv.getValidator(tool.inputSchema);
                assert.deepEqual(tool.inputSchema.properties.checks.items.enum, ['types', 'logic']);
                assert.equal(tool.inputSchema.properties.executeTests, undefined);
                assert.equal(tool.annotations.openWorldHint, false);
                // Logic is valid input, but neither develop nor preview grants execution.
                for (const checks of [['logic'], ['types', 'logic'], ['logic', 'types']]) {
                    const input = { ...checkInput('game'), checks };
                    assert.equal(validate(input).valid, true);
                    await session.call('project_check', input, 'PERMISSION_DENIED');
                }
                for (const checks of [[], ['types', 'types'], ['logic', 'logic'], ['engine']]) {
                    await session.call('project_check', { ...checkInput('game'), checks }, 'INVALID_ARGUMENTS');
                }
                for (const grant of [{ executeTests: true }, { mode: 'develop', preview: true },
                    { permissions: { mode: 'develop', executeTests: true } }]) {
                    await session.call('project_check', { ...checkInput('game'), checks: ['logic'], ...grant }, 'INVALID_ARGUMENTS');
                }
                assert.deepEqual((await session.call('jobs_list')).items, []);
            }
            if (mode === 'preview') {
                for (const name of [...developNames, ...previewNames]) await session.call(name, { permissions: { mode: 'develop' } }, 'INVALID_ARGUMENTS');
                await session.call('project_create', { directory: 'game', templateId: templateId('2d-basic'), projectName: 'test', requestKey: '../key' }, 'INVALID_ARGUMENTS');
                const required = [
                    ['project_create', { directory: 'game', templateId: templateId('2d-basic'), projectName: 'test' }],
                    ['project_check', { project: 'game', target: 'HTML5', profile: '2d-basic', checks: ['types'] }],
                    ['game_build', { project: 'game', target: 'HTML5', profile: '2d-basic', variant: 'debug' }],
                    ['preview_start', { artifactId: randomUUID() }],
                ];
                for (const [name, args] of required) {
                    assert(session.tools.find(tool => tool.name === `cocos4_${name}`).inputSchema.required.includes('requestKey'));
                    await session.call(name, args, 'INVALID_ARGUMENTS');
                }
                for (const name of ['project_check', 'game_build']) for (const timeoutMs of [0, 999, 3600001, 1.5, '1000', null]) {
                    const args = name === 'project_check' ? checkInput('game') : buildInput('game');
                    await session.call(name, { ...args, timeoutMs }, 'INVALID_ARGUMENTS');
                }
                assert.deepEqual((await session.call('jobs_list')).items, []);
            }
            await session.close();
        }
        for (const permission of ['--preview', '--execute-tests']) {
            const forbidden = await launchCli(env, ['tools', permission, 'true'], 'readonly').done;
            assert.equal(forbidden.signal, null);
            assert.equal(forbidden.code, 1);
            assert.equal(forbidden.stdout, '');
            assert.equal(JSON.parse(forbidden.stderr).code, 'PERMISSION_DENIED');
        }
        assert.deepEqual(await fs.readdir(env.workspace), []);
        assert.ok(!(await fs.readdir(env.stateDirectory)).some(name => /^(?:staging|artifact)-/.test(name)));
    });

    let session = await connect(env);
    const builds = new Map();
    const edited = new Map();
    for (const profile of ['2d-basic', '3d-basic']) {
        await t.test(`${profile}: create editable project, check real edits, build verified payload and serve/browser-test it`, async t => {
            const project = profile === '2d-basic' ? 'game2d' : 'game3d';
            const input = { directory: project, templateId: templateId(profile), projectName: `edited-${profile}`, requestKey: `create-${profile}` };
            const receipt = await session.call('project_create', input);
            assert.equal((await session.call('project_create', input)).jobId, receipt.jobId);
            await session.call('project_create', { ...input, directory: `${project}-different` }, 'REQUEST_CONFLICT');
            succeeded(await finished(session, receipt));
            assert.equal(JSON.parse(await fs.readFile(join(env.workspace, project, 'package.json'), 'utf8')).name, input.projectName);
            assert.equal((await fs.stat(join(env.workspace, project, 'src/main.ts'))).mode & 0o777, 0o600);
            const changes = await changeProject(env, project, `ACTUAL_${profile}_REVISION_ONE`);
            edited.set(profile, changes);
            const checked = succeeded(await finished(session, await session.call('project_check', checkInput(project, profile))));
            assert.ok(checked.report.validationLevels.includes('gameTypecheck'));
            assert.equal(checked.report.artifacts, undefined);
            const buildArgs = { ...buildInput(project, profile), requestKey: `build-${profile}` };
            const buildReceipt = await session.call('game_build', buildArgs);
            assert.equal((await session.call('game_build', buildArgs)).jobId, buildReceipt.jobId);
            const build = succeeded(await finished(session, buildReceipt));
            assert.equal(build.report.artifacts.length, 1);
            const artifact = build.report.artifacts[0];
            await verifyArtifact(env, artifact, changes);
            builds.set(profile, build);
            const previewArgs = { artifactId: artifact.artifactId, ttlSeconds: 180, requestKey: `preview-${profile}` };
            const previewReceipt = await session.call('preview_start', previewArgs);
            t.after(() => session.call('preview_stop', { jobId: previewReceipt.jobId }));
            assert.equal((await session.call('preview_start', previewArgs)).jobId, previewReceipt.jobId);
            await session.call('preview_start', { ...previewArgs, ttlSeconds: 179 }, 'REQUEST_CONFLICT');
            const job = await ready(session, previewReceipt);
            const preview = job.preview;
            assert.equal(job.state, 'running');
            assert.equal(preview.artifactId, artifact.artifactId);
            assert.match(new URL(preview.url).pathname, /^\/[a-f0-9]{64}\/$/);
            const route = name => new URL(name, preview.url).pathname;
            const html = await get(preview);
            assert.equal(html.status, 200);
            assert.equal(html.headers['access-control-allow-origin'], undefined);
            for (const match of html.body.toString().matchAll(/src="([^"]+)"/g)) {
                assert.equal((await get(preview, { path: route(match[1]) })).status, 200, match[1]);
            }
            const main = await get(preview, { path: route('game/main.js') });
            assert.ok(main.body.includes(changes.revision));
            assert.equal((await get(preview, { path: route('assets/game/rules.json') })).body.toString(), changes.rules);
            const head = await get(preview, { path: route('game/main.js'), method: 'HEAD' });
            assert.equal(head.status, 200);
            assert.equal(head.body.length, 0);
            assert.equal(Number(head.headers['content-length']), main.body.length);
            for (const name of ['../index.html', '%2e%2e/index.html', 'game%2fmain.js', 'artifact-inventory.json', 'metadata.json',
                'toolchain/compiler/compile-game.cjs', 'types/cc.d.ts', 'unknown.png']) {
                assert.equal((await get(preview, { path: new URL(preview.url).pathname + name })).status, 404, name);
            }
            assert.equal((await get(preview, { path: '/index.html' })).status, 404);
            assert.equal((await get(preview, { headers: { Host: 'attacker.invalid' } })).status, 403);
            assert.equal((await get(preview, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
            assert.equal((await get(preview, { method: 'POST' })).status, 405);
            await t.test('real edited-game browser rendering, input, audio and restarts', async t => {
                await browserCheck(t, preview, artifact, profile, join(env.stateDirectory, `artifact-${artifact.artifactId}`));
            });

            if (profile === '2d-basic') {
                const second = { source: changes.source.replaceAll(changes.revision, 'ACTUAL_2D_REVISION_TWO'),
                    rules: changes.rules.replaceAll(changes.revision, 'ACTUAL_2D_REVISION_TWO'), revision: 'ACTUAL_2D_REVISION_TWO' };
                await fs.writeFile(join(env.workspace, project, 'src/main.ts'), second.source);
                await fs.writeFile(join(env.workspace, project, 'assets/rules.json'), second.rules);
                await fs.writeFile(join(env.workspace, project, 'assets/development.txt'), second.revision);
                const checking = await session.call('project_check', { ...checkInput(project), requestKey: 'coexisting-check' });
                const cancelledCreate = await session.call('project_create', { directory: 'cancelled-starter', projectName: 'never-publish', templateId: templateId(profile), requestKey: 'cancelled-starter' });
                assert.equal(cancelledCreate.state, 'queued');
                assert.equal((await session.call('job_cancel', { jobId: cancelledCreate.jobId })).accepted, true);
                assert.equal((await finished(session, cancelledCreate)).job.state, 'cancelled');
                await absent(join(env.workspace, 'cancelled-starter'));
                const building = await session.call('game_build', { ...buildInput(project), requestKey: 'coexisting-build' });
                assert.equal(building.state, 'queued', 'Only one heavy worker may run beside the preview');
                assert.equal((await session.call('job_get', { jobId: checking.jobId })).job.state, 'running');
                assert.equal((await session.call('job_get', { jobId: job.jobId })).job.phase, 'ready');
                assert.ok((await get(preview, { path: route('game/main.js') })).body.includes(changes.revision));
                succeeded(await finished(session, checking));
                const next = succeeded(await finished(session, building));
                await verifyArtifact(env, next.report.artifacts[0], second);
                await verifyArtifact(env, artifact, changes);
                assert.notEqual(next.report.artifacts[0].sha256, artifact.sha256);
                assert.equal((await session.call('game_build', buildArgs)).jobId, buildReceipt.jobId, 'A retained request key must not silently rebuild changed inputs');
                await session.call('preview_start', { artifactId: next.report.artifacts[0].artifactId, ttlSeconds: 2, requestKey: randomUUID() }, 'WORKSPACE_BUSY');
                assert.equal((await session.call('job_get', { jobId: job.jobId })).job.state, 'running');
                builds.set(profile, next);
                edited.set(profile, second);
            }
            const probe = await socketProbe(env, preview);
            assert.deepEqual(await session.call('preview_stop', { jobId: job.jobId }), { jobId: job.jobId, state: 'cancelled', accepted: true });
            assert.deepEqual(await session.call('preview_stop', { jobId: job.jobId }), { jobId: job.jobId, state: 'cancelled', accepted: false });
            await closedPreview(preview, probe);
            assert.equal((await session.call('preview_start', previewArgs)).jobId, job.jobId, 'Terminal preview request keys remain idempotent');
            await absent(join(env.root, 'PROJECT_SCRIPTS_EXECUTED'));
        });
    }

    await t.test('failed types/profile APIs carry real failed reports; bad paths, private inputs and existing output fail closed', async () => {
        const source = join(env.workspace, 'game2d/src/main.ts');
        const original = await fs.readFile(source);
        try {
            for (const [text, expected] of [['export const broken: number = "NOT_A_NUMBER";', 'TYPECHECK_FAILED'],
                ['import { MeshRenderer } from "cc"; export const forbidden = MeshRenderer;', 'FEATURE_NOT_IN_PROFILE']]) {
                await fs.writeFile(source, text);
                const page = await finished(session, await session.call('project_check', checkInput('game2d')));
                assert.equal(page.job.state, 'failed');
                assert.equal(page.job.error.code, expected, JSON.stringify(page));
                assert.ok(page.report.items.some(item => item.status === 'failed' && item.file && item.line && item.column));
                assert.equal(page.report.artifacts, undefined);
            }
        } finally { await fs.writeFile(source, original); }
        for (const args of [{ ...buildInput('game2d'), profile: 'invented' }, { ...buildInput('game2d'), target: 'WECHAT' }]) {
            await session.call('game_build', args, 'PROFILE_NOT_AVAILABLE');
        }
        await session.call('project_create', { directory: 'unknown', projectName: 'test', templateId: 'invented', requestKey: randomUUID() }, 'PROFILE_NOT_AVAILABLE');
        for (const [directory, error] of [['../escape', 'PATH_OUTSIDE_WORKSPACE'], ['.', 'OUTPUT_CONFLICT'], ['.env', 'PERMISSION_DENIED']]) {
            await session.call('project_create', { directory, projectName: 'test', templateId: templateId('2d-basic'), requestKey: randomUUID() }, error);
        }
        await session.call('game_build', { ...buildInput('../escape') }, 'PATH_OUTSIDE_WORKSPACE');
        const existing = join(env.workspace, 'existing');
        await fs.mkdir(existing);
        await fs.writeFile(join(existing, 'keep.txt'), 'EXISTING_USER_DATA');
        const conflict = await finished(session, await session.call('project_create', { directory: 'existing', projectName: 'test', templateId: templateId('2d-basic'), requestKey: randomUUID() }));
        assert.equal(conflict.job.state, 'failed');
        assert.equal(conflict.job.error.code, 'OUTPUT_CONFLICT');
        assert.equal(await fs.readFile(join(existing, 'keep.txt'), 'utf8'), 'EXISTING_USER_DATA');
        const privateFile = join(env.workspace, 'game2d/.env');
        await fs.writeFile(privateFile, 'PRIVATE_SENTINEL_MUST_NOT_LEAK');
        try {
            const denied = await finished(session, await session.call('project_check', checkInput('game2d')));
            assert.equal(denied.job.error.code, 'PERMISSION_DENIED');
            assert.ok(!JSON.stringify(denied).includes('PRIVATE_SENTINEL_MUST_NOT_LEAK'));
        } finally { await fs.unlink(privateFile); }
        await session.call('preview_start', { artifactId: randomUUID(), ttlSeconds: 2, requestKey: randomUUID() }, 'ARTIFACT_INVALID');
        await session.call('preview_stop', { jobId: builds.get('2d-basic').job.jobId }, 'INVALID_ARGUMENTS');
    });

    await t.test('active compiler cancellation publishes no artifact or staging output and remains cancelled', async () => {
        const before = (await fs.readdir(env.stateDirectory)).filter(name => name.startsWith('artifact-')).sort();
        const receipt = await session.call('game_build', buildInput('game2d'));
        await until(async () => {
            const page = await session.call('job_get', { jobId: receipt.jobId });
            assert.ok(!terminal.has(page.job.state), 'Build finished before active cancellation could be exercised');
            return (await session.call('job_logs', { jobId: receipt.jobId })).text.includes('Running the SDK-contained strict game compiler');
        }, 'Compiler did not start before cancellation');
        assert.equal((await session.call('job_cancel', { jobId: receipt.jobId })).accepted, true);
        const page = await finished(session, receipt);
        assert.equal(page.job.state, 'cancelled');
        assert.equal(page.job.error.code, 'CANCELLED');
        assert.equal(page.report, null);
        assert.equal((await session.call('job_cancel', { jobId: receipt.jobId })).accepted, false);
        await delay(100);
        assert.deepEqual((await fs.readdir(env.stateDirectory)).filter(name => name.startsWith('artifact-')).sort(), before);
        assert.ok(!(await fs.readdir(env.stateDirectory)).some(name => name.startsWith('staging-')));
    });

    await t.test('preview TTL completes successfully and foreign workspaces cannot use a retained artifact', async () => {
        const artifact = builds.get('2d-basic').report.artifacts[0];
        const receipt = await session.call('preview_start', { artifactId: artifact.artifactId, ttlSeconds: 2, requestKey: randomUUID() });
        const job = await ready(session, receipt);
        assert.ok((await get(job.preview, { path: new URL('game/main.js', job.preview.url).pathname })).body.includes(edited.get('2d-basic').revision));
        const probe = await socketProbe(env, job.preview);
        const ended = succeeded(await finished(session, receipt));
        assert.ok(ended.report.validationLevels.includes('loopbackServing'));
        await closedPreview(job.preview, probe);
        assert.equal((await session.call('preview_stop', { jobId: job.jobId })).accepted, false);
        const otherWorkspace = join(env.root, 'other-workspace');
        await fs.mkdir(otherWorkspace, { mode: 0o700 });
        const foreign = await connect({ ...env, workspace: otherWorkspace });
        await foreign.call('preview_start', { artifactId: artifact.artifactId, ttlSeconds: 2, requestKey: randomUUID() }, 'ARTIFACT_INVALID');
        await foreign.call('job_get', { jobId: builds.get('2d-basic').job.jobId }, 'JOB_NOT_FOUND');
        await foreign.close();
    });

    for (const signal of ['EOF', 'SIGTERM']) await t.test(`${signal} stops preview sockets and active work; restart retrieves and serves the persisted artifact`, async () => {
        const build = builds.get('2d-basic');
        const artifact = build.report.artifacts[0];
        const receipt = await session.call('preview_start', { artifactId: artifact.artifactId, ttlSeconds: 180, requestKey: randomUUID() });
        const previewJob = await ready(session, receipt);
        const probe = await socketProbe(env, previewJob.preview);
        const compiling = await session.call('project_check', checkInput('game2d'));
        assert.equal(compiling.state, 'running');
        await session.close(signal);
        await closedPreview(previewJob.preview, probe);
        session = await connect(env);
        const restored = await session.call('job_get', { jobId: build.job.jobId });
        assert.deepEqual(restored.report.artifacts, [artifact]);
        assert.equal(restored.job.state, 'succeeded');
        for (const jobId of [receipt.jobId, compiling.jobId]) assert.equal((await session.call('job_get', { jobId })).job.state, 'cancelled');
        assert.ok(!(await fs.readdir(env.stateDirectory)).some(name => name.startsWith('staging-')));
        const restarted = await ready(session, await session.call('preview_start', { artifactId: artifact.artifactId, ttlSeconds: 60, requestKey: randomUUID() }));
        assert.equal((await get(restarted.preview)).status, 200);
        assert.notEqual(restarted.preview.url, previewJob.preview.url);
        await session.call('preview_stop', { jobId: restarted.jobId });
    });
    const validators = session.validators;
    await session.close();

    await t.test('CLI flags, real create/check/build, failed diagnostics, idempotence and live preview TTL/SIGTERM', async () => {
        for (const [mode, count] of [['readonly', 10], ['develop', 13], ['preview', 15]]) {
            assert.equal((await cliResult(launchCli(env, ['tools'], mode)))[0].tools.length, count);
        }
        const call = async (name, input, exitCode = 0, errorCode = null) => {
            const lines = await cliResult(launchCli(env, ['call', `cocos4_${name}`, '--input', JSON.stringify(input)]), exitCode);
            const output = [...developNames, 'preview_start'].includes(name) && errorCode === null ? 'job_get' : name;
            return lines.map(line => envelope(line, validators.get(`cocos4_${output}`), env, errorCode));
        };
        const create = { directory: 'cli-game', projectName: 'cli-edited-game', templateId: templateId('2d-basic'), requestKey: 'cli-create' };
        const created = (await call('project_create', create))[0];
        succeeded(created);
        assert.equal((await call('project_create', create))[0].job.jobId, created.job.jobId);
        const changes = await changeProject(env, 'cli-game', 'CLI_ACTUAL_GAME_SOURCE');
        succeeded((await call('project_check', checkInput('cli-game')))[0]);
        const built = succeeded((await call('game_build', { ...buildInput('cli-game'), requestKey: 'cli-build' }))[0]);
        await verifyArtifact(env, built.report.artifacts[0], changes);
        const source = join(env.workspace, 'cli-game/src/main.ts');
        await fs.writeFile(source, 'export const broken: number = "CLI_TYPE_ERROR";');
        try {
            const failed = (await call('project_check', checkInput('cli-game'), 1))[0];
            assert.equal(failed.job.state, 'failed');
            assert.equal(failed.job.error.code, 'TYPECHECK_FAILED');
            assert.ok(failed.report.items.some(item => item.status === 'failed' && item.file && item.line));
        } finally { await fs.writeFile(source, changes.source); }
        const retrieved = (await call('job_get', { jobId: built.job.jobId }))[0];
        assert.deepEqual(retrieved.report.artifacts, built.report.artifacts);
        for (const signal of ['TTL', 'SIGTERM']) {
            const process = launchCli(env, ['call', 'cocos4_preview_start', '--input', JSON.stringify({
                artifactId: built.report.artifacts[0].artifactId, ttlSeconds: signal === 'TTL' ? 2 : 180,
                requestKey: randomUUID(),
            })]);
            const announced = await until(() => {
                assert.equal(process.child.exitCode, null, 'CLI exited before announcing its ready preview');
                return process.lines.find(line => line.data?.job.phase === 'ready');
            }, 'CLI did not announce preview');
            const readyPage = envelope(announced, validators.get('cocos4_job_get'), env);
            assert.equal(readyPage.job.state, 'running');
            assert.equal((await get(readyPage.job.preview)).status, 200);
            const probe = await socketProbe(env, readyPage.job.preview);
            if (signal === 'SIGTERM') process.child.kill('SIGTERM');
            const lines = await cliResult(process, signal === 'TTL' ? 0 : 1);
            await closedPreview(readyPage.job.preview, probe);
            const retained = (await call('job_get', { jobId: readyPage.job.jobId }))[0];
            assert.equal(retained.job.state, signal === 'TTL' ? 'succeeded' : 'cancelled');
            // A graceful signal must not replace the terminal job envelope with
            // a failed query against an already-closing Application.
            const ended = envelope(lines.at(-1), validators.get('cocos4_job_get'), env);
            assert.equal(ended.job.state, signal === 'TTL' ? 'succeeded' : 'cancelled');
        }
        await absent(join(env.root, 'PROJECT_SCRIPTS_EXECUTED'));
    });
    for (const [profile, build] of builds) await verifyArtifact(env, build.report.artifacts[0], edited.get(profile));
    assert.deepEqual(await fs.readFile(join(sdkRoot, 'manifest.json')), manifestBytes);
    await absent(join(env.root, 'PROJECT_SCRIPTS_EXECUTED'));
});
