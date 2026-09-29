import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

// Isolated verification from tools/devkit (does not replace build/src):
// ./node_modules/.bin/tsc --outDir build/bilibili-development-agent --pretty false
// COMBINED_SDK_ROOT=/path/to/sdk BILIBILI_DEVELOPMENT_TEST_BUILD_PREFIX=../build/bilibili-development-agent/src/ node --test test/bilibili-development.test.mjs
// LEGACY_HTML5_SDK_ROOT optionally selects a concrete older HTML5-only SDK.
const devkit = fileURLToPath(new URL('../', import.meta.url));
const build = new URL(process.env.BILIBILI_DEVELOPMENT_TEST_BUILD_PREFIX ?? '../build/src/', import.meta.url);
const cli = fileURLToPath(new URL('cli.js', build));
const sdkRoot = resolve(process.env.COMBINED_SDK_ROOT ?? join(devkit, 'build/game-sdk'));
const legacyRoot = resolve(process.env.LEGACY_HTML5_SDK_ROOT ?? join(devkit, 'build/legacy-game-sdk'));
const ajv = new AjvJsonSchemaValidator();
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const requestOptions = { timeout: 20000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = name => assert.rejects(fs.lstat(name), { code: 'ENOENT' });
const input = (project, profile, target = 'BILIBILI') => ({ project, target, profile, variant: 'debug', requestKey: randomUUID() });
const flags = env => ['--sdk-root', env.sdkRoot, '--workspace', env.workspace, '--state-root', env.stateRoot,
    '--mode', 'develop', '--preview', 'true'];
const childEnv = env => ({ HOME: env.home, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true' });

async function bounded(promise, milliseconds, message) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}

async function until(predicate, message, timeout = 150000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await delay(100);
    }
    assert.fail(message);
}

async function filesIn(root, prefix = '') {
    const files = [];
    for (const entry of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) files.push(...await filesIn(root, `${name}/`));
        else { assert.ok(entry.isFile(), `Unexpected non-regular file: ${name}`); files.push(name); }
    }
    return files.sort();
}

async function fixture(t, root, manifest) {
    const temporary = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'cocos4-bilibili-development-'));
    const env = { sdkRoot: root, sdkId: manifest.sdkId, manifest, root: temporary, workspace: join(temporary, 'workspace'),
        stateRoot: join(temporary, 'state'), home: join(temporary, 'home'), cleanup: [], signal: t.signal };
    for (const directory of [env.workspace, env.home]) await fs.mkdir(directory, { mode: 0o700 });
    env.stateDirectory = join(env.stateRoot, hash(env.workspace));
    await fs.mkdir(join(devkit, 'build'), { recursive: true });
    env.evidence = await fs.mkdtemp(join(devkit, `build/bilibili-development-node${process.versions.node.split('.')[0]}-`));
    await fs.mkdir(join(env.evidence, 'jobs'), { mode: 0o700 });
    await fs.writeFile(join(env.evidence, 'run.json'), JSON.stringify({ node: process.version, sdkId: manifest.sdkId,
        manifestSha256: hash(await fs.readFile(join(root, 'manifest.json'))), cli,
        vendorBuildValidated: false, deviceValidated: false, resourceLoadingValidated: false }, null, 2));
    t.diagnostic(`Node ${process.version}; ${manifest.sdkId}; evidence: ${env.evidence}`);
    t.after(async () => {
        const errors = [];
        for (const close of env.cleanup.reverse()) try { await close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, `Shutdown failed; preserved ${temporary}`);
        await fs.rm(temporary, { recursive: true, force: true });
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
    async start() {
        const receive = this.onmessage;
        this.onmessage = message => {
            assert.ok(Buffer.byteLength(JSON.stringify(message)) + 1 <= 65536, 'MCP exceeded its wire budget');
            receive?.(message);
        };
        await super.start();
        // Only EOF/exit observation uses the pinned SDK child; protocol traffic is SDK-owned.
        this.child = this._process;
        this.exited = new Promise(resolve => this.child.once('close', (code, signal) => resolve({ code, signal })));
    }
}

async function connect(env) {
    const transport = new ObservedTransport({ command: process.execPath, args: [cli, 'mcp', ...flags(env)],
        cwd: env.workspace, env: childEnv(env), stderr: 'pipe' });
    const client = new Client({ name: 'cocos4-bilibili-development', version: '1.0.0' }, { jsonSchemaValidator: ajv });
    const errors = [];
    let stderr = '';
    let closing;
    client.onerror = error => errors.push(error);
    transport.stderr.on('data', bytes => { stderr += bytes; });
    const kill = () => transport.child?.kill('SIGKILL');
    env.signal.addEventListener('abort', kill, { once: true });
    const close = () => closing ??= (async () => {
        try {
            if (transport.child?.exitCode === null && transport.child.signalCode === null) transport.child.stdin.end();
            if (transport.exited) {
                let outcome;
                try { outcome = await bounded(transport.exited, 15000, 'MCP did not shut down after EOF'); }
                catch (error) { kill(); await transport.exited; throw error; }
                assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
            }
            assert.equal(stderr, '');
            assert.deepEqual(errors, []);
        } finally { env.signal.removeEventListener('abort', kill); await client.close(); }
    })();
    env.cleanup.push(close);
    await client.connect(transport, { timeout: 60000 });
    const { tools, nextCursor } = await client.listTools(undefined, requestOptions);
    assert.equal(nextCursor, undefined);
    const validators = new Map(tools.map(tool => [tool.name, ajv.getValidator(tool.outputSchema)]));
    return { close, validators, pid: transport.pid,
        async call(name, args = {}, errorCode = null) {
            const fullName = `cocos4_${name}`;
            const result = await client.callTool({ name: fullName, arguments: args }, CallToolResultSchema, requestOptions);
            assert.equal(result.isError, errorCode !== null, JSON.stringify(result.structuredContent));
            assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
            return envelope(result.structuredContent, validators.get(fullName), env, errorCode);
        } };
}

async function finished(env, session, receipt) {
    assert.match(receipt.jobId, /^[a-f0-9-]{36}$/);
    assert.ok(receipt.pollAfterMs > 0);
    const page = await until(async () => {
        const page = await session.call('job_get', { jobId: receipt.jobId, limit: 100 });
        return terminal.has(page.job.state) && page;
    }, `Job ${receipt.jobId} did not finish`);
    assert.equal(page.nextCursor, null, 'Integration reports must fit the requested full page');
    const logs = await session.call('job_logs', { jobId: receipt.jobId, maxBytes: 16384 });
    await fs.writeFile(join(env.evidence, 'jobs', `${receipt.jobId}.json`), JSON.stringify({ ...page, logs }, null, 2));
    return page;
}

function succeeded(page) {
    assert.equal(page.job.state, 'succeeded', JSON.stringify(page));
    assert.equal(page.job.error, null);
    assert.ok(page.report);
    return page;
}

async function cliCall(env, validators, name, args) {
    const child = spawn(process.execPath, [cli, 'call', `cocos4_${name}`, '--input', JSON.stringify(args), ...flags(env)], {
        cwd: env.workspace, env: childEnv(env), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const errors = [];
    child.on('error', error => errors.push(error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', bytes => { stdout += bytes; if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    const timer = setTimeout(kill, 150000);
    env.signal.addEventListener('abort', kill, { once: true });
    const done = new Promise(resolve => child.once('close', (code, signal) => {
        clearTimeout(timer);
        env.signal.removeEventListener('abort', kill);
        resolve({ code, signal });
    }));
    env.cleanup.push(async () => { kill(); await done; assert.deepEqual(errors, []); });
    assert.deepEqual(await done, { code: 0, signal: null }, stderr || stdout);
    assert.equal(stderr, '');
    assert.ok(stdout.endsWith('\n'));
    const pages = stdout.trimEnd().split('\n').map(line => {
        assert.ok(Buffer.byteLength(line) + 1 <= 65536);
        return envelope(JSON.parse(line), validators.get('cocos4_job_get'), env);
    });
    assert.equal(pages.length, 1);
    return succeeded(pages[0]);
}

async function editedProject(env, project, profile) {
    const directory = join(env.workspace, project);
    const filename = join(directory, 'src/main.ts');
    const revision = `USER_EDITED_${profile.replaceAll('-', '_')}`;
    const original = await fs.readFile(filename, 'utf8');
    assert.match(original, /pointsPerClick = 7/);
    const typeOnlySources = {
        'interfaces.ts': 'export interface GameSettings { pointsPerClick: number; }\n',
        'aliases.ts': 'export type Revision = string;\n',
        'type-exports.ts': "export type { GameSettings } from './interfaces.js';\nexport type { Revision } from './aliases.js';\n",
    };
    for (const [name, content] of Object.entries(typeOnlySources)) await fs.writeFile(join(directory, 'src', name), content);
    const source = "import type { GameSettings } from './interfaces.js';\n"
        + "import type { Revision } from './aliases.js';\n"
        + "import type { GameSettings as ReexportedSettings, Revision as ReexportedRevision } from './type-exports.js';\n"
        + original.replace('pointsPerClick = 7', 'pointsPerClick = 19')
        + '\nexport const bilibiliSettings: GameSettings & ReexportedSettings = { pointsPerClick: 19 };\n'
        + `export const bilibiliDevelopmentRevision: Revision & ReexportedRevision = ${JSON.stringify(revision)};\n`;
    const rules = ` { "customProjectData": ${JSON.stringify(revision)}, "title": "USER GAME", "restart": "Restart" }\r\n`;
    await fs.writeFile(filename, source);
    await fs.writeFile(join(directory, 'assets/rules.json'), rules);
    await fs.writeFile(join(directory, 'assets/user.txt'), revision);
    const config = JSON.parse(await fs.readFile(join(directory, 'game.json')));
    Object.assign(config, { appId: `TEST_ONLY_NOT_VENDOR_CERTIFIED_${profile}`, version: '9.8.7-test', deviceOrientation: 'portrait' });
    config.networkTimeout.request = 23456;
    const gameJson = ` \r\n${JSON.stringify(config, null, '\t')}\r\n `;
    await fs.writeFile(join(directory, 'game.json'), gameJson);
    const canary = `require('node:fs').writeFileSync(${JSON.stringify(join(env.root, 'PROJECT_CODE_EXECUTED'))}, 'bad'); throw Error('PROJECT CODE RAN');`;
    for (const name of ['hook.cjs', 'babel.config.cjs', 'tests/contract.mjs']) await fs.writeFile(join(directory, name), canary);
    const pkg = JSON.parse(await fs.readFile(join(directory, 'package.json')));
    pkg.scripts = { build: 'node hook.cjs', test: 'node hook.cjs', postinstall: 'node hook.cjs' };
    await fs.writeFile(join(directory, 'package.json'), JSON.stringify(pkg));
    return { project, profile, source, rules, revision, gameJson,
        typeOnlyFiles: Object.keys(typeOnlySources).map(name => name.replace(/\.ts$/, '.js')) };
}

async function verifyArtifact(env, artifact, edited, target = 'BILIBILI') {
    assert.equal(artifact.sdkId, env.sdkId);
    assert.equal(artifact.target, target);
    assert.equal(artifact.profile, edited.profile);
    assert.equal(artifact.variant, 'debug');
    assert.equal(artifact.entry, target === 'BILIBILI' ? 'game.js' : 'index.html');
    const directory = join(env.stateDirectory, `artifact-${artifact.artifactId}`);
    assert.equal((await fs.stat(directory)).mode & 0o077, 0);
    const raw = await fs.readFile(join(directory, 'artifact-inventory.json'));
    assert.equal(hash(raw), artifact.sha256);
    const inventory = JSON.parse(raw);
    const { files, bytes, sha256, ...identity } = artifact;
    const { files: entries, schemaVersion, ...recorded } = inventory;
    assert.equal(schemaVersion, 1);
    assert.deepEqual(recorded, identity);
    assert.equal(entries.length, files);
    assert.equal(entries.reduce((sum, file) => sum + file.bytes, 0), bytes);
    assert.deepEqual(await filesIn(directory), [...entries.map(file => file.path), 'artifact-inventory.json'].sort());
    for (const file of entries) {
        assert.ok(!/^(?:types|template|toolchain|node_modules|tests)\//.test(file.path), file.path);
        const content = await fs.readFile(join(directory, file.path));
        assert.equal(content.length, file.bytes, file.path);
        assert.equal(hash(content), file.sha256, file.path);
    }
    const main = await fs.readFile(join(directory, 'game/main.js'), 'utf8');
    assert.ok(main.includes(edited.revision));
    assert.match(main, /"pointsPerClick", \[property\], \{[^}]*initializer: function \(\) \{\s*return 19;/);
    assert.equal(await fs.readFile(join(directory, 'assets/game/rules.json'), 'utf8'), edited.rules);
    assert.equal(await fs.readFile(join(directory, 'assets/game/user.txt'), 'utf8'), edited.revision);
    for (const name of ['package.json', 'hook.cjs', 'babel.config.cjs', 'runtime.json', 'engine-build.json', 'compiler-dependencies.json']) {
        await absent(join(directory, name));
    }
    const metadata = JSON.parse(await fs.readFile(join(directory, 'game-compiler.json')));
    assert.deepEqual([metadata.typeChecked, metadata.profileChecked, metadata.emitted, metadata.checkOnly], [true, true, true, false]);
    assert.deepEqual([metadata.typeChecking.strict, metadata.typeChecking.skipLibCheck, metadata.typeChecking.skipDefaultLibCheck], [true, false, false]);
    assert.deepEqual(metadata.diagnostics, []);
    assert.deepEqual(entries.filter(file => file.path.startsWith('game/')).map(file => file.path).sort(),
        metadata.outputFiles.map(name => `game/${name}`).sort());
    for (const name of edited.typeOnlyFiles ?? []) assert.ok(metadata.outputFiles.includes(name), `Missing type-only module: ${name}`);
    for (const name of metadata.outputFiles) {
        const file = `game/${name}`;
        const code = await fs.readFile(join(directory, file), 'utf8');
        assert.match(code, /^\s*System\.register\s*\(/, file);
        // Parse only, never run: native import/export, including a trailing export {}, is invalid in a script.
        assert.doesNotThrow(() => new Script(code, { filename: file }), `${file} must contain only script-compatible SystemJS output`);
    }
    const profile = env.manifest.catalog.profiles.find(item => item.id === edited.profile && item.target === target && item.variant === 'debug');
    const descriptor = JSON.parse(await fs.readFile(join(env.sdkRoot, profile.descriptor)));
    const engine = descriptor.engineEntry.slice(2);
    const expected = env.manifest.files.find(file => file.path === `${profile.directory}/${engine}`);
    const engineBytes = await fs.readFile(join(directory, engine));
    assert.equal(hash(engineBytes), expected.sha256);
    assert.deepEqual(engineBytes, await fs.readFile(join(env.sdkRoot, expected.path)));
    if (target === 'BILIBILI') {
        assert.equal(await fs.readFile(join(directory, 'game.json'), 'utf8'), edited.gameJson, 'Preserve user config bytes, not normalized SDK config');
        for (const name of ['index.html', 'boot.js', 'engine']) await absent(join(directory, name));
        const html = env.manifest.catalog.profiles.find(item => item.id === edited.profile && item.target === 'HTML5' && item.variant === 'debug');
        const htmlEngine = env.manifest.files.find(file => file.path === `${html.directory}/engine/cc.js`);
        assert.notEqual(expected.sha256, htmlEngine.sha256, 'BILIBILI must not reuse the HTML5 engine');
        for (const name of ['game.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js']) {
            assert.deepEqual(await fs.readFile(join(directory, name)), await fs.readFile(join(env.sdkRoot, profile.directory, name)));
        }
    } else {
        for (const name of ['game.js', 'game.json', 'application.js', 'cocos-js']) await absent(join(directory, name));
    }
    await absent(join(env.workspace, edited.project, `artifact-${artifact.artifactId}`));
    await absent(join(env.root, 'PROJECT_CODE_EXECUTED'));
    return { directory, entries };
}

async function listeningSockets(pid) {
    const sockets = new Set();
    for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
        try {
            const link = await fs.readlink(`/proc/${pid}/fd/${fd}`);
            const match = /^socket:\[(\d+)\]$/.exec(link);
            if (match) sockets.add(match[1]);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const listeners = [];
    for (const table of ['tcp', 'tcp6']) {
        const rows = (await fs.readFile(`/proc/${pid}/net/${table}`, 'utf8')).trim().split('\n').slice(1);
        for (const row of rows) {
            const fields = row.trim().split(/\s+/);
            if (fields[3] === '0A' && sockets.has(fields[9])) listeners.push(`${table}:${fields[1]}`);
        }
    }
    return listeners.sort();
}

async function previewRejected(session, artifact) {
    const before = await session.call('jobs_list', { limit: 100 });
    assert.equal(before.nextCursor, null);
    assert.deepEqual(await listeningSockets(session.pid), []);
    await session.call('preview_start', { artifactId: artifact.artifactId, ttlSeconds: 60, requestKey: randomUUID() }, 'UNSUPPORTED_PROJECT');
    assert.deepEqual(await session.call('jobs_list', { limit: 100 }), before, 'Rejected preview must not admit any job');
    assert.deepEqual(await listeningSockets(session.pid), [], 'Rejected preview must not open a port');
}

function get(preview, name = '') {
    return new Promise((resolve, reject) => {
        const request = http.get(new URL(name, preview.url), { agent: false }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('Preview HTTP timed out')));
    });
}

async function htmlPreview(env, session, artifact, edited) {
    const receipt = await session.call('preview_start', { artifactId: artifact.artifactId, ttlSeconds: 60, requestKey: randomUUID() });
    const job = await until(async () => {
        const page = await session.call('job_get', { jobId: receipt.jobId });
        assert.ok(!terminal.has(page.job.state), JSON.stringify(page));
        return page.job.phase === 'ready' && page.job;
    }, 'HTML5 preview did not become ready', 30000);
    try {
        assert.equal((await get(job.preview)).status, 200);
        const main = await get(job.preview, 'game/main.js');
        assert.equal(main.status, 200);
        assert.ok(main.body.includes(edited.revision));
        assert.equal((await get(job.preview, 'assets/game/rules.json')).body.toString(), edited.rules);
    } finally { await session.call('preview_stop', { jobId: job.jobId }); }
    assert.equal((await finished(env, session, receipt)).job.state, 'cancelled');
    await assert.rejects(get(job.preview), error => error.code === 'ECONNREFUSED');
    assert.deepEqual(await listeningSockets(session.pid), []);
}

// Includes repeated full SDK validation across both targets and independent CLI
// invocations; individual job/child deadlines remain unchanged.
test('combined BILIBILI development through official MCP/Ajv and real CLI', { timeout: 1200000, concurrency: false }, async t => {
    try { assert.ok((await fs.lstat(sdkRoot)).isDirectory()); }
    catch (error) {
        if (error.code === 'ENOENT' && process.env.COMBINED_SDK_ROOT === undefined) {
            t.skip('Default combined SDK absent; set COMBINED_SDK_ROOT to require real integration.');
            return;
        }
        throw error;
    }
    const manifestBytes = await fs.readFile(join(sdkRoot, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.ok(manifest.development && manifest.apiIndex, 'A real indexed combined SDK is required');
    const env = await fixture(t, sdkRoot, manifest);
    let session = await connect(env);
    const builds = new Map();
    const edits = new Map();

    await t.test('catalog, Node/MeshRenderer API queries and exact BILIBILI examples use the indexed combined SDK', async () => {
        for (const section of ['profiles', 'templates']) {
            const page = await session.call('catalog', { section, target: 'BILIBILI', limit: 100 });
            assert.equal(page.available, true);
            assert.equal(page.nextCursor, null);
            assert.deepEqual(page.items, manifest.catalog[section].filter(item => item.target === 'BILIBILI'));
        }
        const raw = await fs.readFile(join(sdkRoot, manifest.apiIndex.path));
        assert.equal(hash(raw), manifest.apiIndex.sha256);
        const index = JSON.parse(raw);
        assert.equal(index.entries.filter(entry => entry.kind === 'api').length, manifest.apiIndex.symbols);
        assert.equal(index.entries.filter(entry => entry.kind === 'example').length, manifest.apiIndex.examples);
        for (const [name, profile] of [['Node', '2d-basic'], ['MeshRenderer', '3d-basic']]) {
            let cursor;
            let match;
            do {
                const page = await session.call('docs_search', { query: `cc.${name}`, kind: 'api', profile, limit: 100,
                    ...(cursor ? { cursor } : {}) });
                match = page.items.find(item => item.title === `cc.${name}`);
                cursor = page.nextCursor;
            } while (!match && cursor);
            assert.ok(match, `${name} must be discoverable in ${profile}`);
            const doc = await session.call('docs_read', { documentId: match.documentId, maxBytes: 16384 });
            assert.equal(doc.api.qualifiedName, `cc.${name}`);
            assert.equal(doc.api.featureRequirements, 'unknown');
            assert.ok(doc.anchors.length);
            for (const { variant } of manifest.catalog.profiles.filter(item => item.target === 'BILIBILI' && item.id === profile)) {
                const availability = doc.runtimeAvailability.find(item => item.target === 'BILIBILI' && item.profile === profile && item.variant === variant);
                assert.ok(availability, `Missing ${profile}/${variant} API availability`);
                assert.equal(availability.status, 'export-present');
                const binding = index.profiles.find(item => item.target === 'BILIBILI' && item.profile === profile && item.variant === variant);
                assert.ok(binding, `Missing ${profile}/${variant} API binding`);
                assert.equal(availability.engineSha256, binding.engine.sha256);
                assert.equal(availability.exportsSha256, binding.exports.sha256);
            }
        }
        const forbidden = await session.call('docs_search', { query: 'cc.MeshRenderer', kind: 'api', profile: '2d-basic', limit: 100 });
        assert.ok(!forbidden.items.some(item => item.title === 'cc.MeshRenderer'));
        for (const profile of ['2d-basic', '3d-basic']) {
            const expected = manifest.catalog.templates.filter(item => item.target === 'BILIBILI' && item.profile === profile)
                .flatMap(template => ['main.ts', 'world.ts'].map(name => [template.target, template.profile, template.variant,
                    template.id, `${template.directory}/src/${name}`]));
            assert.ok(expected.length, `Missing BILIBILI templates for ${profile}`);
            const examples = [];
            let cursor;
            do {
                const page = await session.call('docs_search', { query: 'createWorld', kind: 'example', profile, limit: 100,
                    ...(cursor ? { cursor } : {}) });
                examples.push(...page.items.filter(item => item.example.target === 'BILIBILI'));
                cursor = page.nextCursor;
            } while (cursor);
            assert.deepEqual(examples.map(({ example }) => [example.target, example.profile, example.variant,
                example.templateId, example.sourcePath]).sort(), expected.sort());
            for (const example of examples) {
                assert.equal(example.example.templateId, `bilibili-${profile}${example.example.variant === 'release' ? '-release' : ''}-starter`);
                assert.equal(example.example.usage, 'template-source');
                const source = manifest.files.find(file => file.path === example.example.sourcePath);
                assert.ok(source);
                assert.equal(example.example.sourceSha256, source.sha256);
                let cursor;
                let text = '';
                do {
                    const doc = await session.call('docs_read', { documentId: example.documentId, maxBytes: 4096, ...(cursor ? { cursor } : {}) });
                    assert.equal(doc.documentId, example.documentId);
                    assert.deepEqual(doc.example, example.example);
                    assert.equal(doc.totalBytes, source.bytes);
                    assert.equal(doc.sha256, source.sha256);
                    assert.equal(doc.offsetBytes, Buffer.byteLength(text));
                    assert.ok(doc.content.length);
                    assert.ok(Buffer.byteLength(doc.content) <= 4096);
                    text += doc.content;
                    assert.equal(doc.nextCursor === null, Buffer.byteLength(text) === source.bytes);
                    cursor = doc.nextCursor;
                } while (cursor);
                assert.equal(Buffer.byteLength(text), source.bytes);
                assert.deepEqual(Buffer.from(text), await fs.readFile(join(sdkRoot, example.example.sourcePath)));
                assert.equal(hash(text), example.example.sourceSha256);
            }
        }
    });

    await t.test('doctor validates the full indexed pack without worker heap exhaustion', async () => {
        const page = succeeded(await finished(env, session, await session.call('doctor', { depth: 'full' })));
        assert.ok(page.report.validationLevels.includes('payload-sha256'));
        assert.equal(page.report.artifacts, undefined);
    });

    for (const profile of ['2d-basic', '3d-basic']) await t.test(`${profile}: create, edit, strictly check and build a real BILIBILI package`, async () => {
        const project = `game-${profile}`;
        const receipt = await session.call('project_create', { directory: project, projectName: project,
            templateId: `bilibili-${profile}-starter`, requestKey: `create-${profile}` });
        succeeded(await finished(env, session, receipt));
        const directory = join(env.workspace, project);
        const pkg = JSON.parse(await fs.readFile(join(directory, 'package.json')));
        await fs.writeFile(join(env.evidence, `created-${profile}.json`), JSON.stringify({ project, package: pkg,
            files: await filesIn(directory) }, null, 2));
        const delivered = manifest.catalog.profiles.find(item => item.target === 'BILIBILI' && item.id === profile && item.variant === 'debug');
        const expected = JSON.parse(await fs.readFile(join(sdkRoot, delivered.directory, 'game.json')));
        assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'game.json'))), { ...expected, appId: '', version: pkg.version });
        assert.equal((await fs.stat(join(directory, 'game.json'))).mode & 0o777, 0o600);
        const declarations = manifest.files.filter(file => file.path.startsWith(`${delivered.directory}/types/`));
        assert.ok(declarations.length);
        assert.deepEqual(await filesIn(join(directory, 'types')), declarations.map(file => file.path.slice(`${delivered.directory}/types/`.length)).sort());
        for (const file of declarations) assert.equal(hash(await fs.readFile(join(directory, file.path.slice(delivered.directory.length + 1)))), file.sha256);
        const edited = await editedProject(env, project, profile);
        edits.set(profile, edited);
        const workspaceFiles = await filesIn(env.workspace);
        const checked = succeeded(await finished(env, session, await session.call('project_check', { project, profile, target: 'BILIBILI', checks: ['types'], requestKey: randomUUID() })));
        assert.ok(checked.report.validationLevels.includes('gameTypecheck'));
        assert.equal(checked.report.artifacts, undefined);
        const args = { ...input(project, profile), requestKey: `build-${profile}` };
        const building = await session.call('game_build', args);
        assert.equal((await session.call('game_build', args)).jobId, building.jobId);
        const page = succeeded(await finished(env, session, building));
        assert.equal(page.report.artifacts.length, 1);
        const artifact = page.report.artifacts[0];
        const verified = await verifyArtifact(env, artifact, edited);
        assert.deepEqual(await filesIn(env.workspace), workspaceFiles, 'Build output belongs only in private state');
        assert.equal(await fs.readFile(join(directory, 'game.json'), 'utf8'), edited.gameJson, 'Build must not rewrite user config');
        for (const level of ['gameTypecheck', 'profileLinkage', 'staticModuleClosure', 'bilibiliSourcePreflight', 'copiedResourceInventory', 'atomicPublication']) {
            assert.ok(page.report.validationLevels.includes(level), level);
        }
        for (const code of ['RUNTIME_UNVERIFIED', 'RESOURCE_LOADING_UNVERIFIED']) {
            assert.ok(page.report.items.some(item => item.status === 'warning' && item.code === code), code);
        }
        assert.match(page.report.summary, /BILIBILI/);
        assert.ok(!page.report.validationLevels.some(level => /browser|device|vendor|render|resourceLoading/i.test(level)));
        const resources = verified.entries.filter(file => file.path.startsWith('assets/') || (file.path.startsWith('cocos-js/') && !file.path.endsWith('.js')));
        const resourceItem = page.report.items.find(item => item.name === 'Copied resource inventory');
        assert.equal(resourceItem.status, 'passed');
        assert.equal(resourceItem.bytes, resources.reduce((sum, file) => sum + file.bytes, 0));
        assert.ok(resourceItem.message.includes(hash(resources.map(file => `${file.path}\0${file.sha256}\n`).join(''))));
        assert.equal(page.report.items.find(item => item.name === 'BILIBILI source preflight').bytes, artifact.bytes);
        const destination = join(env.evidence, profile);
        await fs.mkdir(destination, { mode: 0o700 });
        await fs.cp(verified.directory, join(destination, `artifact-${artifact.artifactId}`), { recursive: true });
        await fs.writeFile(join(destination, 'report.json'), JSON.stringify(page, null, 2));
        builds.set(profile, page);
    });

    await t.test('indexed package_validate worker preflights a copied real artifact without heap exhaustion', async () => {
        assert.ok(builds.has('2d-basic'), 'Requires a successful BILIBILI artifact, not a fabricated package');
        const artifact = builds.get('2d-basic').report.artifacts[0];
        const source = join(env.stateDirectory, `artifact-${artifact.artifactId}`);
        const directory = 'validation-package';
        const copy = join(env.workspace, directory);
        const raw = await fs.readFile(join(source, 'artifact-inventory.json'));
        const files = [...JSON.parse(raw).files, { path: 'artifact-inventory.json', bytes: raw.length, sha256: artifact.sha256 }];
        const before = (await fs.readdir(env.stateDirectory)).filter(name => name.startsWith('artifact-')).sort();
        // This explicit test-only copy does not change private artifact publication or ownership.
        await fs.cp(source, copy, { recursive: true, force: false, errorOnExist: true });
        try {
            const page = succeeded(await finished(env, session, await session.call('package_validate', { target: 'BILIBILI', directory })));
            assert.equal(page.job.operation, 'package_validate');
            assert.equal(page.report.artifacts, undefined);
            assert.deepEqual(page.report.validationLevels,
                ['manifest-sha256', 'bounded-private-snapshot', 'bilibili-source-preflight', 'input-change-detection']);
            const preflight = page.report.items.find(item => item.name === 'BILIBILI package');
            assert.equal(preflight.status, 'passed');
            assert.equal(preflight.bytes, artifact.bytes + raw.length, 'Copied inventory is also part of the validated source package');
            assert.equal(page.report.items.find(item => item.name === 'main').bytes, preflight.bytes);
            assert.match(page.report.summary, /Vendor compilation, publishing and runtime behavior remain unverified/);
            assert.deepEqual(await filesIn(copy), files.map(file => file.path).sort());
            for (const file of files) {
                const bytes = await fs.readFile(join(copy, file.path));
                assert.equal(bytes.length, file.bytes, file.path);
                assert.equal(hash(bytes), file.sha256, file.path);
            }
            await fs.writeFile(join(env.evidence, 'package-validate-report.json'), JSON.stringify(page, null, 2));
        } finally { await fs.rm(copy, { recursive: true, force: true }); }
        assert.deepEqual((await fs.readdir(env.stateDirectory)).filter(name => name.startsWith('artifact-')).sort(), before);
        assert.ok(!(await fs.readdir(env.stateDirectory)).some(name => name.startsWith('staging-')));
        await verifyArtifact(env, artifact, edits.get('2d-basic'));
    });

    await t.test('invalid configuration, types, profile APIs and assets fail without changing prior artifacts', async t => {
        assert.ok(builds.has('2d-basic'), 'A successful BILIBILI build is required to test failure preservation');
        const edited = edits.get('2d-basic');
        const directory = join(env.workspace, edited.project);
        const before = (await fs.readdir(env.stateDirectory)).filter(name => name.startsWith('artifact-')).sort();
        const cases = [
            ['missing game.json', 'game.json', null, 'UNSUPPORTED_PROJECT'],
            ['malformed JSON', 'game.json', '{', 'ARTIFACT_INVALID'],
            ['duplicate JSON keys', 'game.json', '{"appId":"one","appId":"two","version":"1"}', 'ARTIFACT_INVALID'],
            ['non-object JSON', 'game.json', '[]', 'ARTIFACT_INVALID'],
            ['unsplit subpackages', 'game.json', JSON.stringify({ ...JSON.parse(edited.gameJson), subpackages: [{ name: 'extra', root: 'extra' }] }), 'UNSUPPORTED_PROJECT'],
            ['canonical empty appId', 'game.json', JSON.stringify({ ...JSON.parse(edited.gameJson), appId: '' }), 'ARTIFACT_INVALID'],
            // Focused canonical tests cover null/false/0/''/[]; keep one full-worker plugin regression here.
            ['canonical plugins true', 'game.json', JSON.stringify({ ...JSON.parse(edited.gameJson), plugins: true }), 'ARTIFACT_INVALID'],
            ['bad TypeScript', 'src/main.ts', `${edited.source}\nexport const broken: number = "TYPE_ERROR";`, 'TYPECHECK_FAILED'],
            ['declaration-only start', 'src/main.ts', 'export declare function start(): Promise<void>;\nexport const marker = "DECLARATION_ONLY_START";\n', 'TYPECHECK_FAILED'],
            ['3D API in 2D', 'src/main.ts', `${edited.source}\nimport { MeshRenderer } from 'cc'; export const forbidden = MeshRenderer;`, 'FEATURE_NOT_IN_PROFILE'],
            ['unsupported asset', 'assets/unsupported.prefab', '{}', 'UNSUPPORTED_PROJECT'],
        ];
        for (const [name, relative, content, expected] of cases) await t.test(name, async () => {
            const filename = join(directory, relative);
            const original = await fs.readFile(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
            try {
                if (content === null) await fs.unlink(filename); else await fs.writeFile(filename, content);
                const page = await finished(env, session, await session.call('game_build', input(edited.project, edited.profile)));
                assert.equal(page.job.state, 'failed', JSON.stringify(page));
                assert.equal(page.job.error.code, expected, JSON.stringify(page));
                assert.equal(page.report?.artifacts, undefined);
                if (['canonical empty appId', 'canonical plugins true', 'bad TypeScript', 'declaration-only start', '3D API in 2D'].includes(name)) {
                    assert.ok(page.report?.items.some(item => item.status === 'failed'));
                }
                if (['bad TypeScript', '3D API in 2D'].includes(name)) {
                    assert.ok(page.report.items.some(item => item.status === 'failed' && item.file && item.line && item.column));
                }
            } finally {
                if (original === null) await fs.rm(filename, { force: true }); else await fs.writeFile(filename, original);
            }
            assert.deepEqual((await fs.readdir(env.stateDirectory)).filter(name => name.startsWith('artifact-')).sort(), before);
            assert.ok(!(await fs.readdir(env.stateDirectory)).some(name => name.startsWith('staging-')));
            for (const [profile, built] of builds) await verifyArtifact(env, built.report.artifacts[0], edits.get(profile));
        });
    });

    await t.test('owned BILIBILI previews reject before job/port creation; the same project still builds and serves HTML5', async () => {
        assert.ok(builds.has('2d-basic'), 'Requires an owned BILIBILI artifact');
        await previewRejected(session, builds.get('2d-basic').report.artifacts[0]);
        const edited = edits.get('2d-basic');
        const page = succeeded(await finished(env, session, await session.call('game_build', input(edited.project, edited.profile, 'HTML5'))));
        await verifyArtifact(env, page.report.artifacts[0], edited, 'HTML5');
        await htmlPreview(env, session, page.report.artifacts[0], edited);
    });

    const validators = session.validators;
    await session.close();
    await t.test('real CLI rebuilds BILIBILI and MCP reopens its persisted artifact without enabling preview', async () => {
        assert.ok(builds.has('2d-basic'), 'Requires a successfully edited BILIBILI project');
        const edited = edits.get('2d-basic');
        const page = await cliCall(env, validators, 'game_build', input(edited.project, edited.profile));
        await fs.writeFile(join(env.evidence, 'cli-report.json'), JSON.stringify(page, null, 2));
        await verifyArtifact(env, page.report.artifacts[0], edited);
        const retrieved = await cliCall(env, validators, 'job_get', { jobId: page.job.jobId });
        assert.deepEqual(retrieved.report.artifacts, page.report.artifacts);
        session = await connect(env);
        const restored = await session.call('job_get', { jobId: page.job.jobId, limit: 100 });
        assert.deepEqual(restored.report.artifacts, page.report.artifacts);
        await previewRejected(session, page.report.artifacts[0]);
        await verifyArtifact(env, restored.report.artifacts[0], edited);
        await session.close();
    });

    await t.test('a concrete older HTML5-only SDK still creates, checks, builds and previews without root game.json', async t => {
        let legacy;
        try { legacy = JSON.parse(await fs.readFile(join(legacyRoot, 'manifest.json'))); }
        catch (error) {
            if (error.code === 'ENOENT' && process.env.LEGACY_HTML5_SDK_ROOT === undefined) return t.skip('Older SDK absent; set LEGACY_HTML5_SDK_ROOT to require compatibility verification.');
            throw error;
        }
        assert.ok(legacy.development);
        assert.ok(legacy.catalog.profiles.every(profile => profile.target === 'HTML5'));
        const old = await fixture(t, legacyRoot, legacy);
        const client = await connect(old);
        const project = 'legacy-game';
        const profile = '2d-basic';
        succeeded(await finished(old, client, await client.call('project_create', { directory: project, projectName: project, templateId: '2d-basic-starter', requestKey: randomUUID() })));
        await absent(join(old.workspace, project, 'game.json'));
        const sourceFile = join(old.workspace, project, 'src/main.ts');
        const revision = 'LEGACY_HTML5_USER_EDIT';
        const source = (await fs.readFile(sourceFile, 'utf8')).replace('pointsPerClick = 7', 'pointsPerClick = 19')
            + `\nexport const revision = "${revision}";\n`;
        const rules = '{"title":"LEGACY USER GAME","restart":"Restart"}\n';
        await fs.writeFile(sourceFile, source);
        await fs.writeFile(join(old.workspace, project, 'assets/rules.json'), rules);
        await fs.writeFile(join(old.workspace, project, 'assets/user.txt'), revision);
        const checked = succeeded(await finished(old, client, await client.call('project_check', { project, profile, target: 'HTML5', checks: ['types'], requestKey: randomUUID() })));
        assert.ok(checked.report.validationLevels.includes('gameTypecheck'));
        const page = succeeded(await finished(old, client, await client.call('game_build', input(project, profile, 'HTML5'))));
        const edited = { project, profile, source, rules, revision };
        await verifyArtifact(old, page.report.artifacts[0], edited, 'HTML5');
        await htmlPreview(old, client, page.report.artifacts[0], edited);
        await client.close();
    });
    assert.deepEqual(await fs.readFile(join(sdkRoot, 'manifest.json')), manifestBytes);
    await absent(join(env.root, 'PROJECT_CODE_EXECUTED'));
});
