import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, EmptyResultSchema, ErrorCode, ListResourcesResultSchema, ListToolsResultSchema,
    McpError, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const engine = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(devkit, 'build/src/cli.js');
const requestOptions = { timeout: 5000 };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const toolNames = ['catalog', 'docs_search', 'docs_read', 'project_inspect', 'doctor', 'package_validate',
    'jobs_list', 'job_get', 'job_logs', 'job_cancel'].map(name => `cocos4_${name}`);
const ajv = new AjvJsonSchemaValidator();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const protocolError = code => error => error instanceof McpError && error.code === code;
const resultSchemas = { 'tools/call': CallToolResultSchema, 'tools/list': ListToolsResultSchema,
    'resources/list': ListResourcesResultSchema, 'resources/read': ReadResourceResultSchema };
const flags = env => ['--sdk-root', env.sdkRoot, '--workspace', env.workspace, '--state-root', env.stateRoot];

async function until(predicate, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await delay(10);
    }
    assert.fail(message);
}

function envelope(value, validate, sdkId, errorCode = null) {
    const checked = validate(value);
    assert.equal(checked.valid, true, checked.errorMessage);
    assert.deepEqual(Object.keys(value).sort(), ['data', 'error', 'ok', 'schemaVersion', 'sdkId', 'warnings']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.sdkId, sdkId);
    assert.equal(value.ok, errorCode === null);
    assert.deepEqual(value.warnings, []);
    if (errorCode === null) {
        assert.equal(value.error, null);
        assert.notEqual(value.data, null);
    } else {
        assert.equal(value.data, null);
        assert.equal(value.error.code, errorCode);
        assert.deepEqual(Object.keys(value.error).sort(), ['code', 'message', 'nextSteps', 'retryable']);
        assert.ok(value.error.message.length > 0);
    }
    return value.data;
}

class ObservedTransport extends StdioClientTransport {
    messages = [];
    sent = [];
    async start() {
        const receive = this.onmessage;
        this.onmessage = message => { this.messages.push(message); receive?.(message); };
        await super.start();
    }
    async send(message) { this.sent.push(message); await super.send(message); }
}

async function connect(t, env) {
    const transport = new ObservedTransport({ command: process.execPath,
        args: [cli, 'mcp', ...flags(env), '--mode', 'read-only'], cwd: env.workspace,
        env: { HOME: env.home, PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true' }, stderr: 'pipe' });
    const client = new Client({ name: 'cocos4-blackbox', version: '1.0.0' }, { jsonSchemaValidator: ajv });
    const errors = [];
    let stderr = '';
    client.onerror = error => errors.push(error);
    transport.stderr.on('data', chunk => { stderr += chunk; });
    const abort = () => { void client.close().catch(() => {}); };
    t.signal.addEventListener('abort', abort, { once: true });
    // Register before connect/assertions so failures cannot strand a child or its workspace lock.
    t.after(async () => {
        t.signal.removeEventListener('abort', abort);
        await client.close();
        assert.equal(transport.pid, null);
        assert.deepEqual(errors, []);
        assert.equal(stderr, '');
        for (const message of transport.messages) {
            assert.ok(Buffer.byteLength(JSON.stringify(message)) + 1 <= 65536, 'MCP response exceeds 64 KiB');
        }
    });
    await client.connect(transport, requestOptions);
    const { tools, nextCursor } = await client.listTools(undefined, requestOptions);
    assert.equal(nextCursor, undefined);
    const validators = new Map(tools.map(tool => [tool.name, ajv.getValidator(tool.outputSchema)]));
    return { client, transport, tools, validators, close: () => client.close(),
        async call(name, args = {}, errorCode = null, meta) {
            const result = await client.callTool({ name, arguments: args, ...(meta && { _meta: meta }) }, CallToolResultSchema, requestOptions);
            assert.equal(result.isError, errorCode !== null);
            assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
            return envelope(result.structuredContent, validators.get(name), env.sdkId, errorCode);
        } };
}

// This small process harness is also used for raw EOF/budget probes, never as a replacement SDK client.
function launch(t, env, args, { raw = false, cwd = env.workspace } = {}) {
    const child = spawn(process.execPath, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { HOME: env.home, PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true' } });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let outcome;
    const messages = [];
    const errors = [];
    const closed = new Promise(resolve => child.once('close', (code, signal) => { outcome = { code, signal }; resolve(outcome); }));
    child.on('error', error => errors.push(error));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') errors.push(error); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) child.kill('SIGKILL');
        if (!raw) return;
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
                assert.ok(Buffer.byteLength(line) + 1 <= 65536);
                messages.push(JSON.parse(line));
            } catch (error) { errors.push(error); }
        }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const kill = () => { if (!outcome) child.kill('SIGKILL'); };
    const timer = setTimeout(kill, 20000);
    timer.unref();
    t.signal.addEventListener('abort', kill, { once: true });
    t.after(async () => {
        clearTimeout(timer);
        t.signal.removeEventListener('abort', kill);
        kill();
        await closed;
        assert.deepEqual(errors, []);
    });
    closed.then(() => {
        clearTimeout(timer);
        t.signal.removeEventListener('abort', kill);
    });
    let id = 0;
    return { child, closed, messages, output: () => ({ stdout, stderr }),
        async request(method, params) {
            const requestId = ++id;
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) })}\n`);
            return until(() => {
                const response = messages.find(message => message.id === requestId);
                assert.ok(response || !outcome, `Server exited before ${method}: ${stderr}`);
                return response;
            }, `No raw response to ${method}`, 5000);
        } };
}

async function runCli(t, env, command, override = {}) {
    const abortListeners = getEventListeners(t.signal, 'abort');
    const process = launch(t, env, [cli, ...command, ...flags({ ...env, ...override })]);
    process.child.stdin.end();
    const outcome = await process.closed;
    assert.deepEqual(getEventListeners(t.signal, 'abort'), abortListeners, 'CLI exit must release its abort listener before test teardown');
    assert.equal(outcome.signal, null);
    return { ...outcome, ...process.output() };
}

function ndjson(result, code = 0) {
    assert.equal(result.code, code, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'), 'CLI must emit newline-terminated JSON');
    return result.stdout.slice(0, -1).split('\n').map(line => {
        assert.ok(Buffer.byteLength(line) + 1 <= 65536);
        return JSON.parse(line);
    });
}

async function pages(session, name, args) {
    const result = [];
    const seen = new Set();
    let cursor;
    do {
        const page = await session.call(name, { ...args, ...(cursor && { cursor }) });
        result.push(page);
        cursor = page.nextCursor;
        assert.ok(cursor === null || (typeof cursor === 'string' && !seen.has(cursor)), 'Pagination must terminate');
        seen.add(cursor);
        assert.ok(result.length < 10000, 'Pagination exceeded fixture bounds');
    } while (cursor !== null);
    return result;
}

async function finished(session, receipt, args = {}) {
    assert.match(receipt.jobId, /^[a-f0-9-]{36}$/);
    assert.ok(receipt.pollAfterMs > 0);
    return until(async () => {
        const page = await session.call('cocos4_job_get', { jobId: receipt.jobId, ...args });
        return terminal.has(page.job.state) && page;
    }, `Job ${receipt.jobId} did not reach terminal state`);
}

async function rawSession(t, env) {
    const process = launch(t, env, [cli, 'mcp', ...flags(env)], { raw: true });
    const hello = await process.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'eof-budget-probe', version: '1' } });
    assert.equal(hello.result.protocolVersion, '2025-11-25');
    assert.deepEqual(hello.result.capabilities, { tools: {}, resources: {} });
    process.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return process;
}

test('production MCP/CLI blackbox with a prepared offline SDK', { concurrency: false, timeout: 180000 }, async t => {
    const base = await mkdtemp(join(await realpath(tmpdir()), 'cocos4-mcp-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const sdkRoot = join(base, 'sdk');
    const preparation = launch(t, { workspace: base, home: base }, [join(devkit, 'scripts/prepare-sdk.mjs'), '--out', sdkRoot]);
    preparation.child.stdin.end();
    assert.deepEqual(await preparation.closed, { code: 0, signal: null }, preparation.output().stderr);
    assert.equal(preparation.output().stderr, '');
    const manifest = JSON.parse(await readFile(join(sdkRoot, 'manifest.json'), 'utf8'));
    assert.equal(JSON.parse(preparation.output().stdout).sdkId, manifest.sdkId);
    const config = JSON5.parse(await readFile(join(engine, 'cc.config.json'), 'utf8'));
    const docs = await Promise.all(manifest.docs.map(async doc => ({ ...doc, text: await readFile(join(sdkRoot, doc.path), 'utf8') })));
    const shortDoc = docs.filter(doc => /[^\x00-\x7f]/.test(doc.text))
        .sort((a, b) => Buffer.byteLength(a.text) - Buffer.byteLength(b.text))[0];
    assert.ok(shortDoc, 'The real SDK must include a UTF-8 document for byte-boundary pagination tests');
    const resourceBase = `cocos4://sdk/${manifest.sdkId}/`;
    t.diagnostic(`Node ${process.version}; official SDK stdio/Ajv; Linux Python3 atomic SDK preparation; ${manifest.sdkId}`);

    async function fixture() {
        const root = await mkdtemp(join(base, 'case-'));
        const env = { root, sdkRoot, sdkId: manifest.sdkId, workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), home: join(root, 'home') };
        await Promise.all([env.workspace, env.home].map(directory => mkdir(directory, { mode: 0o700 })));
        env.marker = join(root, 'project-code-executed');
        const canary = `require('node:fs').writeFileSync(${JSON.stringify(env.marker)}, 'executed'); throw new Error('PROJECT_CODE_MUST_NOT_RUN');\n`;
        for (const name of ['valid', 'invalid']) {
            const directory = join(env.workspace, name);
            await mkdir(directory);
            for (const file of ['game.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js', 'vite.config.js']) {
                await writeFile(join(directory, file), canary);
            }
            await writeFile(join(directory, 'game.json'), JSON.stringify({ appId: 'test', version: name === 'valid' ? '1' : '' }));
            await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'data-only-fixture', main: 'game.js',
                scripts: { preinstall: 'node game.js', build: 'node game.js', test: 'node game.js' },
                dependencies: { 'must-not-download': 'https://127.0.0.1:1/must-not-download.tgz' } }));
        }
        return env;
    }

    async function slowPackage(env) {
        // Real snapshot work leaves time to observe/cancel a worker, without injecting worker code or sleeps.
        for (let index = 0; index < 256; index++) await writeFile(join(env.workspace, 'valid', `payload-${index}.bin`), Buffer.alloc(8192, index));
    }

    await t.test('initialize 2025-11-25, exact capabilities and all ten strict, SDK-validating tool schemas', async t => {
        const env = await fixture();
        const session = await connect(t, env);
        assert.equal(session.transport.sent.find(message => message.method === 'initialize').params.protocolVersion, '2025-11-25');
        assert.equal(session.transport.messages.find(message => message.result?.protocolVersion).result.protocolVersion, '2025-11-25');
        assert.deepEqual(session.client.getServerVersion(), { name: 'cocos4-devkit', version: '0.1.0' });
        assert.deepEqual(session.client.getServerCapabilities(), { tools: {}, resources: {} });
        assert.deepEqual(session.tools.map(tool => tool.name).sort(), [...toolNames].sort());
        for (const tool of session.tools) {
            assert.equal(tool.inputSchema.type, 'object');
            assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
            assert.equal(tool.outputSchema.type, 'object');
            assert.equal(tool.outputSchema.additionalProperties, false, tool.name);
            assert.equal(ajv.getValidator(tool.inputSchema)({ unexpected: true }).valid, false);
            assert.equal(session.validators.get(tool.name)({}).valid, false);
            const writesState = ['cocos4_doctor', 'cocos4_package_validate', 'cocos4_job_cancel'].includes(tool.name);
            assert.deepEqual(tool.annotations, { readOnlyHint: !writesState, destructiveHint: false,
                idempotentHint: !['cocos4_doctor', 'cocos4_package_validate'].includes(tool.name), openWorldHint: false });
            await session.call(tool.name, { unexpected: true }, 'INVALID_ARGUMENTS');
        }
        const catalogTool = session.tools.find(tool => tool.name === 'cocos4_catalog');
        assert.deepEqual(catalogTool.inputSchema.properties.target.enum, [...config.platforms].sort());
        assert.deepEqual(session.tools.find(tool => tool.name === 'cocos4_package_validate').inputSchema.properties.target.enum, ['BILIBILI']);
        await session.client.ping(requestOptions);
    });

    await t.test('unknown tools/methods are protocol errors; malformed outer params are InvalidParams', { concurrency: false }, async t => {
        const session = await connect(t, await fixture());
        await assert.rejects(session.client.callTool({ name: 'cocos4_build', arguments: {} }, CallToolResultSchema, requestOptions), protocolError(ErrorCode.MethodNotFound));
        for (const method of ['cocos4/unknown', 'prompts/list', 'resources/templates/list']) {
            await assert.rejects(session.client.request({ method }, EmptyResultSchema, requestOptions), protocolError(ErrorCode.MethodNotFound));
        }
        const badCalls = [undefined, {}, { name: 7 }, { name: 'cocos4_catalog', arguments: null },
            ...[[], 'bad', 1, true].map(args => ({ name: 'cocos4_catalog', arguments: args })),
            { name: 'cocos4_catalog', arguments: { section: 'sdk' }, unknown: true }];
        const requests = [...badCalls.map(params => ({ method: 'tools/call', params })),
            ...['tools/list', 'resources/list'].flatMap(method => [{ method, params: { unknown: true } }, { method, params: { cursor: 'not-supported' } }]),
            ...[{}, { uri: 1 }, { uri: `${resourceBase}manifest`, unknown: true }].map(params => ({ method: 'resources/read', params }))];
        for (const [index, request] of requests.entries()) {
            await t.test(`${index + 1}: ${request.method} ${JSON.stringify(request.params)}`, async () => {
                // Generic request deliberately avoids client-side method argument validation.
                await assert.rejects(session.client.request(request, resultSchemas[request.method], requestOptions), protocolError(-32602));
                await session.client.ping(requestOptions);
            });
        }
    });

    await t.test('valid progress tokens and extensible standard _meta survive raw dispatch', { concurrency: false }, async t => {
        const session = await connect(t, await fixture());
        for (const token of ['progress-1', 42]) {
            await t.test(`token ${token}`, async () => {
                const data = await session.call('cocos4_catalog', { section: 'sdk' }, null,
                    { progressToken: token, 'example.com/trace': { request: 'blackbox' } });
                assert.equal(data.items[0].sdkId, manifest.sdkId);
            });
        }
        for (const method of ['tools/list', 'resources/list', 'resources/read']) {
            await t.test(method, async () => {
                await session.client.request({ method, params: { ...(method === 'resources/read' && { uri: `${resourceBase}manifest` }),
                    _meta: { 'example.com/trace': ['extensible', 1] } } }, resultSchemas[method], requestOptions);
            });
        }
    });

    await t.test('invalid tool arguments use the same bounded structured business-error envelope', async t => {
        const session = await connect(t, await fixture());
        const cases = [
            ['catalog', {}], ['catalog', { section: 'platforms', limit: 0 }], ['catalog', { section: 'sdk', limit: 1.5 }],
            ['catalog', { section: 'sdk', limit: 101 }], ['docs_search', { query: '', kind: 'all' }],
            ['docs_search', { query: '   ', kind: 'all' }], ['docs_search', { query: 'x', kind: 'all', profile: 'invented' }],
            ['docs_read', { documentId: shortDoc.id, maxBytes: 3 }], ['docs_read', { documentId: shortDoc.id, maxBytes: 16385 }],
            ['docs_read', { documentId: '../README.md' }], ['project_inspect', { project: 1 }],
            ['doctor', { depth: 'repair' }], ['doctor', { workerUrl: 'file:///tmp/worker.js' }],
            ['job_get', { jobId: 'not-a-uuid' }], ['job_logs', { jobId: randomUUID(), maxBytes: 0 }],
        ];
        for (const [name, input] of cases) await session.call(`cocos4_${name}`, input, 'INVALID_ARGUMENTS');
        for (const name of ['job_get', 'job_logs', 'job_cancel']) await session.call(`cocos4_${name}`, { jobId: randomUUID() }, 'JOB_NOT_FOUND');
        assert.deepEqual((await session.call('cocos4_jobs_list')).items, []);
    });

    await t.test('catalog is source-derived, fully paginated, and never invents delivered profiles/targets', async t => {
        const session = await connect(t, await fixture());
        const platforms = (await pages(session, 'cocos4_catalog', { section: 'platforms', limit: 1 })).flatMap(page => page.items);
        assert.deepEqual(platforms.map(item => item.id), [...config.platforms].sort());
        assert.ok(platforms.every(item => item.engineTargetAllowed && !item.prebuiltAvailable && !item.exportAvailable && item.validationLevels.length === 0));
        const features = (await pages(session, 'cocos4_catalog', { section: 'features', limit: 3 })).flatMap(page => page.items);
        assert.deepEqual(features, Object.entries(config.features).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([id, feature]) => ({ id, modules: feature.modules, dependentModules: feature.dependentModules ?? [],
                dependentAssets: feature.dependentAssets ?? [], prebuiltAvailable: false })));
        for (const section of ['profiles', 'templates']) {
            const result = await session.call('cocos4_catalog', { section });
            assert.equal(result.available, false);
            assert.deepEqual(result.items, []);
            assert.equal(result.nextCursor, null);
            assert.ok(result.reason);
        }
        const sdk = (await session.call('cocos4_catalog', { section: 'sdk' })).items[0];
        assert.deepEqual(sdk.capabilities, manifest.capabilities);
        assert.equal(sdk.engineVersion, manifest.engineVersion);
        assert.equal(sdk.sourceSha256, manifest.source.sha256);
        assert.deepEqual((await session.call('cocos4_catalog', { section: 'platforms', target: 'BILIBILI' })).items.map(item => item.id), ['BILIBILI']);
        for (const target of ['ANDROID', 'IOS', 'MAC', 'WINDOWS', 'LINUX', 'BAIDU', 'invented']) {
            await session.call('cocos4_catalog', { section: 'platforms', target }, 'INVALID_ARGUMENTS');
        }
        for (const target of ['WECHAT', 'OPPO', 'ANDROID']) {
            await session.call('cocos4_package_validate', { directory: 'valid', target }, 'INVALID_ARGUMENTS');
        }
    });

    await t.test('only fixed manifest-listed resource URIs are readable, with exact packaged bytes', async t => {
        const session = await connect(t, await fixture());
        const { resources, nextCursor } = await session.client.listResources(undefined, requestOptions);
        assert.equal(nextCursor, undefined);
        assert.deepEqual(resources.map(item => item.uri), [`${resourceBase}manifest`, ...docs.map(doc => `${resourceBase}docs/${doc.id}`)]);
        for (const resource of resources) {
            const { contents } = await session.client.readResource({ uri: resource.uri }, requestOptions);
            assert.equal(contents.length, 1);
            assert.equal(contents[0].uri, resource.uri);
            assert.equal(contents[0].mimeType, resource.mimeType);
            if (resource.uri.endsWith('/manifest')) assert.equal(JSON.parse(contents[0].text).sdkId, manifest.sdkId);
            else assert.equal(contents[0].text, docs.find(doc => resource.uri.endsWith(`/${doc.id}`)).text);
        }
        for (const uri of ['file:///etc/passwd', 'https://example.com/', `${resourceBase}../manifest`, `${resourceBase}docs/../manifest`,
            `${resourceBase}manifest?x=1`, `${resourceBase}manifest#x`, `${resourceBase}docs/%2e%2e`, 'cocos4://sdk/foreign/manifest']) {
            await assert.rejects(session.client.readResource({ uri }, requestOptions), protocolError(ErrorCode.InvalidParams));
        }
    });

    await t.test('literal docs filters, source positions, UTF-8 pages and query/session-bound cursors', async t => {
        const env = await fixture();
        const session = await connect(t, env);
        const query = 'Cocos';
        const expected = docs.filter(doc => doc.text.includes(query) || doc.title.includes(query));
        assert.ok(expected.length > 1);
        for (const kind of ['guide', 'all', 'api', 'example']) {
            const results = await pages(session, 'cocos4_docs_search', { query, kind, limit: 1 });
            assert.ok(results.every(page => page.kind === kind && page.profile === null && page.availableKinds.join() === 'guide'));
            const items = results.flatMap(page => page.items);
            assert.deepEqual(items.map(item => item.documentId), ['api', 'example'].includes(kind) ? [] : expected.map(doc => doc.id));
            for (const item of items) {
                const doc = docs.find(doc => doc.id === item.documentId);
                const found = doc.text.indexOf(query);
                const before = doc.text.slice(0, Math.max(found, 0));
                assert.deepEqual(item.matches, found < 0 ? [] : [{ line: before.split('\n').length,
                    column: [...before.slice(before.lastIndexOf('\n') + 1)].length + 1 }]);
                assert.equal(item.engineVersion, manifest.engineVersion);
                assert.deepEqual(item.requiredFeatures, []);
            }
        }
        const literal = '.*';
        assert.deepEqual((await pages(session, 'cocos4_docs_search', { query: literal, kind: 'all' })).flatMap(page => page.items.map(item => item.documentId)),
            docs.filter(doc => doc.text.includes(literal) || doc.title.includes(literal)).map(doc => doc.id));
        const docPages = await pages(session, 'cocos4_docs_read', { documentId: shortDoc.id, maxBytes: 257 });
        let offset = 0;
        for (const page of docPages) {
            assert.equal(page.offsetBytes, offset);
            assert.ok(Buffer.byteLength(page.content) <= 257 && page.content.length > 0);
            assert.ok(!page.content.includes('\ufffd'));
            assert.equal(page.totalBytes, Buffer.byteLength(shortDoc.text));
            assert.equal(page.sha256, sha256(shortDoc.text));
            offset += Buffer.byteLength(page.content);
        }
        assert.equal(docPages.map(page => page.content).join(''), shortDoc.text);
        const cursor = (await session.call('cocos4_catalog', { section: 'platforms', limit: 1 })).nextCursor;
        for (const input of [{ section: 'features', limit: 1, cursor }, { section: 'platforms', limit: 2, cursor },
            { section: 'platforms', limit: 1, cursor: `${cursor}x` }]) await session.call('cocos4_catalog', input, 'CURSOR_INVALID');
        await session.call('cocos4_docs_read', { documentId: shortDoc.id, maxBytes: 256, cursor: docPages[0].nextCursor }, 'CURSOR_INVALID');
        await session.close();
        const reopened = await connect(t, env);
        await reopened.call('cocos4_catalog', { section: 'platforms', limit: 1, cursor }, 'CURSOR_INVALID');
    });

    await t.test('malicious paths, symlinks and private inputs are rejected without leaking outside data', async t => {
        const env = await fixture();
        const outside = join(env.root, 'outside');
        await mkdir(outside);
        await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_DATA_MUST_NOT_APPEAR');
        await symlink(outside, join(env.workspace, 'escape'));
        await mkdir(join(env.workspace, '.ssh'));
        const session = await connect(t, env);
        for (const project of ['../outside', '/etc', 'valid/../invalid', 'valid//x', './valid', 'valid/',
            'C:\\Windows', '\\\\server\\share', '%2e%2e/outside', 'valid\u0000x', 'CON', 'valid.']) {
            for (const [name, input] of [['project_inspect', { project }], ['doctor', { project }],
                ['package_validate', { target: 'BILIBILI', directory: project }], ['jobs_list', { project }]]) {
                await session.call(`cocos4_${name}`, input, 'PATH_OUTSIDE_WORKSPACE');
            }
        }
        await session.call('cocos4_project_inspect', { project: 'escape' }, 'PATH_OUTSIDE_WORKSPACE');
        await session.call('cocos4_project_inspect', { project: '.ssh' }, 'PERMISSION_DENIED');
        const escaped = await finished(session, await session.call('cocos4_package_validate', { target: 'BILIBILI', directory: 'escape' }));
        assert.equal(escaped.job.state, 'failed');
        assert.equal(escaped.job.error.code, 'PATH_OUTSIDE_WORKSPACE');
        assert.ok(!JSON.stringify(session.transport.messages).includes('OUTSIDE_DATA_MUST_NOT_APPEAR'));
        assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE_DATA_MUST_NOT_APPEAR');
    });

    await t.test('real inspection, doctor and Bilibili success/failure jobs, paginated logs and terminal cancellation', async t => {
        const env = await fixture();
        const session = await connect(t, env);
        const before = await readFile(join(env.workspace, 'valid/game.js'));
        const inspected = await session.call('cocos4_project_inspect', { project: 'valid' });
        assert.equal(inspected.kind, 'minigame-output');
        assert.equal(inspected.entry, 'game.js');
        assert.equal(inspected.complete, true);
        assert.ok(inspected.diagnostics.some(item => item.code === 'SCRIPTS_NOT_RUN'));
        assert.ok(inspected.diagnostics.some(item => item.code === 'UNVERIFIED_DEPENDENCIES'));
        assert.equal((await session.call('cocos4_project_inspect', { project: '.' })).project, '.');
        const doctor = await finished(session, await session.call('cocos4_doctor', { project: 'valid', depth: 'full' }), { limit: 1 });
        assert.equal(doctor.job.state, 'succeeded');
        assert.ok(doctor.report.validationLevels.includes('bounded-project-data'));
        const reportPages = await pages(session, 'cocos4_job_get', { jobId: doctor.job.jobId, limit: 1 });
        assert.ok(reportPages.length > 5);
        assert.ok(reportPages.flatMap(page => page.report.items).some(item => item.code === 'SCRIPTS_NOT_RUN'));
        const good = await finished(session, await session.call('cocos4_package_validate', { target: 'BILIBILI', directory: 'valid' }));
        assert.equal(good.job.state, 'succeeded');
        assert.equal(good.job.error, null);
        assert.ok(good.report.validationLevels.includes('bilibili-source-preflight'));
        assert.ok(good.report.items.some(item => item.name === 'BILIBILI package' && item.status === 'passed' && item.bytes > 0));
        const bad = await finished(session, await session.call('cocos4_package_validate', { target: 'BILIBILI', directory: 'invalid' }));
        assert.equal(bad.job.state, 'failed');
        assert.equal(bad.job.error.code, 'ARTIFACT_INVALID');
        assert.match(bad.job.error.message, /version/);
        assert.equal(bad.report, null);
        for (const job of [good.job, bad.job]) {
            assert.ok(job.finishedAt >= job.startedAt && job.startedAt >= job.createdAt);
            const logs = await pages(session, 'cocos4_job_logs', { jobId: job.jobId, maxBytes: 4 });
            let offset = 0;
            for (const [index, page] of logs.entries()) {
                assert.equal(page.offsetBytes, offset);
                assert.ok(Buffer.byteLength(page.text) <= 4);
                assert.equal(page.hasMore, index < logs.length - 1);
                offset += Buffer.byteLength(page.text);
            }
            const text = logs.map(page => page.text).join('');
            assert.equal(offset, logs.at(-1).totalBytes);
            assert.match(text, /Verifying the read-only SDK/);
            assert.ok(text.includes(`[job] ${job.state}`));
            assert.deepEqual(await session.call('cocos4_job_cancel', { jobId: job.jobId }), { jobId: job.jobId, state: job.state, accepted: false });
            assert.equal((await session.call('cocos4_job_logs', { jobId: job.jobId })).text, text);
        }
        const listed = (await pages(session, 'cocos4_jobs_list', { limit: 1 })).flatMap(page => page.items);
        assert.deepEqual(new Set(listed.map(job => job.jobId)), new Set([doctor.job.jobId, good.job.jobId, bad.job.jobId]));
        assert.deepEqual((await session.call('cocos4_jobs_list', { project: 'valid' })).items.map(job => job.jobId), [doctor.job.jobId]);
        await session.close();
        assert.deepEqual(await readFile(join(env.workspace, 'valid/game.js')), before);
        await assert.rejects(lstat(env.marker), { code: 'ENOENT' });
        await assert.rejects(lstat(join(env.workspace, 'valid/node_modules')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(env.home), []);
        const reopened = await connect(t, env);
        assert.deepEqual((await reopened.call('cocos4_job_get', { jobId: good.job.jobId })).job, good.job);
    });

    await t.test('accepted cancellation of a real active job is durable and cannot turn into success', async t => {
        const env = await fixture();
        await slowPackage(env);
        const session = await connect(t, env);
        const receipt = await session.call('cocos4_package_validate', { target: 'BILIBILI', directory: 'valid' });
        const liveLogs = await session.call('cocos4_job_logs', { jobId: receipt.jobId, maxBytes: 4 });
        assert.equal(typeof liveLogs.nextCursor, 'string');
        const cancelled = await session.call('cocos4_job_cancel', { jobId: receipt.jobId });
        assert.equal(cancelled.accepted, true);
        assert.equal(cancelled.state, 'cancelled');
        const result = await finished(session, receipt);
        assert.equal(result.job.state, 'cancelled');
        assert.equal(result.job.error.code, 'CANCELLED');
        assert.equal(result.report, null);
        const remainingLogs = await pages(session, 'cocos4_job_logs', { jobId: receipt.jobId, maxBytes: 4, cursor: liveLogs.nextCursor });
        assert.ok((liveLogs.text + remainingLogs.map(page => page.text).join('')).includes('[job] cancelled (CANCELLED)'));
        assert.equal((await session.call('cocos4_job_cancel', { jobId: receipt.jobId })).accepted, false);
        await session.close();
        const reopened = await connect(t, env);
        assert.equal((await reopened.call('cocos4_job_get', { jobId: receipt.jobId })).job.state, 'cancelled');
        assert.match((await reopened.call('cocos4_job_logs', { jobId: receipt.jobId })).text, /\[job\] cancelled \(CANCELLED\)/);
    });

    await t.test('cross-process locks include canonical workspace aliases and release on close', async t => {
        const env = await fixture();
        const session = await connect(t, env);
        const alias = join(env.root, 'workspace-alias');
        await symlink(env.workspace, alias);
        for (const workspace of [env.workspace, alias]) {
            const result = await runCli(t, env, ['tools'], { workspace });
            assert.equal(result.code, 1);
            assert.equal(result.stdout, '');
            assert.equal(JSON.parse(result.stderr).code, 'WORKSPACE_BUSY');
        }
        await session.close();
        assert.equal(ndjson(await runCli(t, env, ['tools']))[0].tools.length, 10);
    });

    await t.test('workspace and SDK foreign job IDs are blocked, including logs and cancellation', async t => {
        const env = await fixture();
        const original = await connect(t, env);
        const owned = await finished(original, await original.call('cocos4_doctor'));
        await original.close();
        const other = await fixture();
        const foreignWorkspace = await connect(t, { ...other, stateRoot: env.stateRoot });
        assert.deepEqual((await foreignWorkspace.call('cocos4_jobs_list')).items, []);
        for (const name of ['job_get', 'job_logs', 'job_cancel']) await foreignWorkspace.call(`cocos4_${name}`, { jobId: owned.job.jobId }, 'JOB_NOT_FOUND');
        await foreignWorkspace.close();

        // Prepare a second genuine SDK from a private trusted-source copy, not forged job metadata.
        const source = join(env.root, 'source');
        await mkdir(source);
        for (const file of manifest.source.files) {
            await mkdir(dirname(join(source, file.path)), { recursive: true });
            await copyFile(join(engine, file.path), join(source, file.path));
        }
        await writeFile(join(source, 'README.md'), `${await readFile(join(source, 'README.md'), 'utf8')}\nSDK ownership test variant.\n`);
        const secondRoot = join(env.root, 'sdk-two');
        const prepare = launch(t, env, [join(devkit, 'scripts/prepare-sdk.mjs'), '--out', secondRoot, '--engine-root', source]);
        prepare.child.stdin.end();
        assert.deepEqual(await prepare.closed, { code: 0, signal: null }, prepare.output().stderr);
        const secondId = JSON.parse(prepare.output().stdout).sdkId;
        assert.notEqual(secondId, manifest.sdkId);
        const second = await connect(t, { ...env, sdkRoot: secondRoot, sdkId: secondId });
        assert.deepEqual((await second.call('cocos4_jobs_list')).items, []);
        for (const name of ['job_get', 'job_logs', 'job_cancel']) await second.call(`cocos4_${name}`, { jobId: owned.job.jobId }, 'JOB_NOT_FOUND');
        const locked = await runCli(t, env, ['tools']);
        assert.equal(locked.stdout, '');
        assert.equal(JSON.parse(locked.stderr).code, 'WORKSPACE_BUSY');
        await second.close();
        const restored = await connect(t, env);
        assert.deepEqual((await restored.call('cocos4_job_get', { jobId: owned.job.jobId })).job, owned.job);
    });

    await t.test('CLI emits all catalog/search/document NDJSON pages before session cursors expire', { concurrency: false }, async t => {
        const env = await fixture();
        const tools = ndjson(await runCli(t, env, ['tools']))[0].tools;
        assert.deepEqual(tools.map(tool => tool.name).sort(), [...toolNames].sort());
        const validate = name => ajv.getValidator(tools.find(tool => tool.name === name).outputSchema);
        for (const section of ['platforms', 'features']) {
            await t.test(section, async () => {
                const lines = ndjson(await runCli(t, env, ['call', 'cocos4_catalog', '--input', JSON.stringify({ section, limit: 1 })]));
                const data = lines.map(line => envelope(line, validate('cocos4_catalog'), env.sdkId));
                assert.equal(data.at(-1).nextCursor, null);
                assert.ok(data.every(page => page.items.length === 1));
                assert.deepEqual(data.flatMap(page => page.items), manifest.catalog[section]);
            });
        }
        await t.test('literal search', async () => {
            const lines = ndjson(await runCli(t, env, ['call', 'cocos4_docs_search', '--input', JSON.stringify({ query: 'Cocos', kind: 'all', limit: 1 })]));
            const data = lines.map(line => envelope(line, validate('cocos4_docs_search'), env.sdkId));
            assert.equal(data.at(-1).nextCursor, null);
            assert.deepEqual(data.flatMap(page => page.items.map(item => item.documentId)), docs.filter(doc => doc.text.includes('Cocos') || doc.title.includes('Cocos')).map(doc => doc.id));
        });
        await t.test('four-byte UTF-8 document pages', async () => {
            const lines = ndjson(await runCli(t, env, ['call', 'cocos4_docs_read', '--input', JSON.stringify({ documentId: shortDoc.id, maxBytes: 4 })]));
            const data = lines.map(line => envelope(line, validate('cocos4_docs_read'), env.sdkId));
            assert.ok(data.length > 1);
            let offset = 0;
            for (const page of data) {
                assert.equal(page.offsetBytes, offset);
                assert.ok(Buffer.byteLength(page.content) > 0 && Buffer.byteLength(page.content) <= 4);
                offset += Buffer.byteLength(page.content);
            }
            assert.equal(data.at(-1).nextCursor, null);
            assert.equal(data.map(page => page.content).join(''), shortDoc.text);
        });
    });

    await t.test('CLI job calls wait for terminal status and consume reports, job lists and logs completely', { concurrency: false }, async t => {
        const env = await fixture();
        for (let index = 0; index < 24; index++) await writeFile(join(env.workspace, 'valid', `asset-${index}.scene`), '{}');
        const tools = ndjson(await runCli(t, env, ['tools']))[0].tools;
        const validate = name => ajv.getValidator(tools.find(tool => tool.name === name).outputSchema);
        const doctor = ndjson(await runCli(t, env, ['call', 'cocos4_doctor', '--input', '{"project":"valid","depth":"full"}']))
            .map(line => envelope(line, validate('cocos4_job_get'), env.sdkId));
        const jobId = doctor[0].job.jobId;
        await t.test('all doctor diagnostics beyond the default twenty-item page', () => {
            assert.ok(doctor.every(page => page.job.state === 'succeeded'));
            assert.equal(doctor.at(-1).nextCursor, null);
            const report = doctor.flatMap(page => page.report.items);
            assert.ok(report.length > 20);
            assert.equal(report.filter(item => item.code === 'UNSUPPORTED_ASSET').length, 24);
        });
        for (const directory of ['valid', 'invalid']) {
            await t.test(`wait for ${directory} Bilibili package`, async t => {
                const result = ndjson(await runCli(t, env, ['call', 'cocos4_package_validate', '--input', JSON.stringify({ target: 'BILIBILI', directory })]), directory === 'valid' ? 0 : 1)
                    .map(line => envelope(line, validate('cocos4_job_get'), env.sdkId));
                assert.ok(result.every(page => page.job.state === (directory === 'valid' ? 'succeeded' : 'failed')));
                assert.equal(result.at(-1).nextCursor, null);
                if (directory === 'invalid') assert.equal(result[0].job.error.code, 'ARTIFACT_INVALID');
            });
        }
        const quick = ndjson(await runCli(t, env, ['doctor'])).map(line => envelope(line, validate('cocos4_job_get'), env.sdkId));
        assert.equal(quick[0].job.state, 'succeeded');
        await t.test('job report with limit one', async t => {
            const data = ndjson(await runCli(t, env, ['call', 'cocos4_job_get', '--input', JSON.stringify({ jobId, limit: 1 })]))
                .map(line => envelope(line, validate('cocos4_job_get'), env.sdkId));
            assert.equal(data.at(-1).nextCursor, null);
            assert.ok(data.every(page => page.report.items.length === 1));
            assert.equal(data.flatMap(page => page.report.items).filter(item => item.code === 'UNSUPPORTED_ASSET').length, 24);
        });
        await t.test('retained job list with limit one', async t => {
            const listed = ndjson(await runCli(t, env, ['call', 'cocos4_jobs_list', '--input', '{"limit":1}']))
                .map(line => envelope(line, validate('cocos4_jobs_list'), env.sdkId));
            assert.equal(listed.at(-1).nextCursor, null);
            assert.equal(listed.flatMap(page => page.items).length, 4);
        });
        await t.test('complete terminal log in four-byte pages', async t => {
            const logs = ndjson(await runCli(t, env, ['call', 'cocos4_job_logs', '--input', JSON.stringify({ jobId, maxBytes: 4 })]))
                .map(line => envelope(line, validate('cocos4_job_logs'), env.sdkId));
            assert.equal(logs.at(-1).nextCursor, null);
            assert.equal(logs.at(-1).hasMore, false);
            const text = logs.map(page => page.text).join('');
            assert.equal(Buffer.byteLength(text), logs.at(-1).totalBytes);
            assert.match(text, /\[job\] succeeded\n$/);
        });
        await assert.rejects(lstat(env.marker), { code: 'ENOENT' });
    });

    await t.test('startup requires explicit disjoint absolute roots, readonly mode and private state; failures keep stdout quiet', async t => {
        const env = await fixture();
        const publicState = join(env.root, 'public-state');
        await mkdir(publicState);
        await chmod(publicState, 0o755);
        const alias = join(env.root, 'state-alias');
        await symlink(publicState, alias);
        for (const [override, code] of [
            [{ workspace: 'relative' }, 'INVALID_ARGUMENTS'], [{ sdkRoot: 'relative' }, 'INVALID_ARGUMENTS'],
            [{ stateRoot: 'relative' }, 'INVALID_ARGUMENTS'], [{ workspace: env.sdkRoot }, 'PERMISSION_DENIED'],
            [{ workspace: base }, 'PERMISSION_DENIED'], [{ stateRoot: env.root }, 'PERMISSION_DENIED'],
            [{ stateRoot: join(env.workspace, 'state') }, 'PERMISSION_DENIED'], [{ stateRoot: join(sdkRoot, 'state') }, 'PERMISSION_DENIED'],
            [{ stateRoot: publicState }, 'PERMISSION_DENIED'], [{ stateRoot: alias }, 'PERMISSION_DENIED'],
            [{ sdkRoot: join(env.root, 'absent-sdk') }, 'SDK_INCOMPLETE'],
        ]) {
            const result = await runCli(t, env, ['tools'], override);
            assert.equal(result.code, 1, JSON.stringify(override));
            assert.equal(result.stdout, '');
            assert.equal(JSON.parse(result.stderr).code, code);
        }
        for (const command of [['tools', '--mode', 'write'], ['tools', '--mode', 'repair'], ['call', 'unknown'],
            ['call', 'cocos4_catalog', '--input', '{broken'], ['tools', '--input', '{}'], ['tools', '--mode', 'read-only', '--mode', 'read-only']]) {
            const result = await runCli(t, env, command);
            assert.equal(result.code, 1);
            assert.equal(result.stdout, '');
            assert.ok(['INVALID_ARGUMENTS', 'PERMISSION_DENIED'].includes(JSON.parse(result.stderr).code));
        }
        const missing = launch(t, env, [cli, 'mcp']);
        missing.child.stdin.end();
        assert.deepEqual(await missing.closed, { code: 1, signal: null });
        assert.equal(missing.output().stdout, '');
        assert.equal(JSON.parse(missing.output().stderr).code, 'INVALID_ARGUMENTS');
        const business = ndjson(await runCli(t, env, ['call', 'cocos4_catalog', '--input', '{"section":"not-real"}']), 1);
        assert.equal(business[0].ok, false);
        assert.equal(business[0].error.code, 'INVALID_ARGUMENTS');
        assert.equal((await lstat(publicState)).mode & 0o777, 0o755);
        await assert.rejects(lstat(join(env.root, 'absent-sdk')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(env.home), []);
        await assert.rejects(lstat(env.marker), { code: 'ENOENT' });
    });

    await t.test('stdin EOF cancels an active real worker without any termination signal and releases the lock', async t => {
        const env = await fixture();
        await slowPackage(env);
        const process = await rawSession(t, env);
        const response = await process.request('tools/call', { name: 'cocos4_package_validate', arguments: { target: 'BILIBILI', directory: 'valid' } });
        const receipt = response.result.structuredContent.data;
        assert.equal(response.result.structuredContent.ok, true);
        assert.equal(receipt.state, 'running');
        process.child.stdin.end();
        assert.deepEqual(await process.closed, { code: 0, signal: null });
        assert.equal(process.output().stderr, '');
        const reopened = await connect(t, env);
        const job = (await reopened.call('cocos4_job_get', { jobId: receipt.jobId })).job;
        assert.equal(job.state, 'cancelled');
        assert.equal(job.error.code, 'CANCELLED');
        const stateDirectory = join(env.stateRoot, sha256(await realpath(env.workspace)));
        assert.ok(!(await readdir(stateDirectory)).some(name => name.startsWith('staging-')));
        await assert.rejects(lstat(env.marker), { code: 'ENOENT' });
    });

    await t.test('oversized incoming messages fail closed without waiting for a newline or a signal', async t => {
        const env = await fixture();
        const process = await rawSession(t, env);
        process.child.stdin.write(' '.repeat(65537));
        const result = await process.closed;
        assert.equal(result.signal, null);
        assert.ok(result.code === 0 || result.code === 1);
        assert.match(process.output().stderr, /MCP transport\/protocol error/);
        assert.equal(process.messages.length, 1, 'Oversized input must not dispatch a tool');
        await connect(t, env);
    });

    await t.test('paused stdout/backpressure cannot prevent EOF shutdown or strand the workspace lock', async t => {
        const env = await fixture();
        const process = await rawSession(t, env);
        process.child.stdout.pause();
        process.child.stdin.write(Array.from({ length: 48 }, (_, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 100, method: 'tools/list' })).join('\n') + '\n');
        await delay(150);
        process.child.stdin.end();
        // Wait for process exit before draining buffered stdout, so the test cannot accidentally relieve backpressure.
        await until(() => process.child.exitCode !== null || process.child.signalCode !== null, 'Backpressured server did not exit on EOF', 12000);
        assert.equal(process.child.signalCode, null);
        process.child.stdout.resume();
        const result = await process.closed;
        assert.ok(result.code === 0 || result.code === 1);
        await connect(t, env);
    });

    for (const file of manifest.files) assert.equal(sha256(await readFile(join(sdkRoot, file.path))), file.sha256, `SDK payload changed: ${file.path}`);
    assert.deepEqual(JSON.parse(await readFile(join(sdkRoot, 'manifest.json'), 'utf8')), manifest);
});
