import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import JSON5 from 'json5';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Application } from '../build/src/app.js';
import { artifactSchema, artifactInventorySchema } from '../build/src/contracts.js';
import { manifestSchema, profileSchema, templateSchema, runtimeValidationLevels } from '../build/src/sdk.js';
import { serve } from '../build/src/server.js';

const targets = ['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE'];
const platforms = JSON5.parse(await readFile(new URL('../../../cc.config.json', import.meta.url), 'utf8')).platforms;
const digest = 'a'.repeat(64);
const record = path => ({ path, bytes: 1, sha256: digest });
const escapedId = '\u0000'.repeat(128);
const frameBytes = (tools, id) => Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, result: { tools } })) + 1;
const ajv = new AjvJsonSchemaValidator();
const metaSchema = new Ajv({ strict: false });
const permissions = [{ mode: 'read-only', preview: false, executeTests: false },
    ...[false, true].flatMap(preview => [false, true].map(executeTests => ({ mode: 'develop', preview, executeTests })))];

// Schema-valid metadata only, never a fabricated loadable SDK. Discovery needs
// no payload, preparation, workspace lock, workers or retained application state.
function metadata() {
    const guides = ['README.md', 'AGENTS.md', 'docs/bilibili_minigame/README.md', 'docs/plans/cocos4-mcp-devkit.md'];
    const profiles = targets.flatMap(target => ['debug', 'release'].flatMap(variant => ['2d-basic', '3d-basic'].map(id => {
        const directory = `engine/profiles/${target}/${id}/${variant}`;
        return { id, target, variant, directory, descriptor: `${directory}/runtime.json`, exports: `${directory}/cc-exports.json`,
            features: ['base'], delivery: 'PREBUILT', validationLevels: [...runtimeValidationLevels[target]],
            [target === 'HTML5' ? 'browserReport' : 'localReport']: `${directory}/evidence/${target === 'HTML5' ? 'browser' : 'local'}-report.json` };
    })));
    return manifestSchema.parse({
        schemaVersion: 1, sdkId: `sha256-${digest}`, kind: 'portable-development', engineVersion: '4.0.0-alpha.34', description: 'Discovery metadata fixture',
        capabilities: { catalog: true, docs: true, packageValidation: ['BILIBILI', 'WECHAT', 'BYTEDANCE'],
            gameDevelopment: true, gameBuild: true, preview: true, export: true },
        source: { sha256: digest, attribution: 'Metadata only', files: ['package.json', 'cc.config.json', 'LICENSE',
            'scripts/validate-bilibili.cjs', 'scripts/validate-minigame.cjs', ...guides].map(record) },
        license: { path: 'LICENSE', spdx: 'MIT' },
        files: ['LICENSE', 'app/validate-bilibili.cjs', 'app/validate-minigame.cjs', ...guides.map((_, i) => `docs/guide-${i}.md`)].map(record),
        catalog: { platforms: [...platforms].sort().map(id => ({ id, engineTargetAllowed: true,
            prebuiltAvailable: targets.includes(id), exportAvailable: targets.includes(id), validationLevels: targets.includes(id) ? [...runtimeValidationLevels[id]] : [] })),
        features: [{ id: 'base', modules: ['base'], dependentModules: [], dependentAssets: [], prebuiltAvailable: true }], profiles,
        templates: profiles.map(({ id, target, variant, directory }) => ({ id: `${target.toLowerCase()}-${id}-${variant}-starter`,
            profile: id, target, variant, directory: `${directory}/template` })) },
        docs: guides.map((sourcePath, i) => ({ id: `guide-${i}`, kind: 'guide', title: sourcePath, path: `docs/guide-${i}.md`, sourcePath, sourceOffset: 0 })),
        apiIndex: { ...record('docs/api-index.json'), schemaVersion: 1, symbols: 1, examples: profiles.length },
        development: { baseSdkId: `sha256-${digest}`, baseManifest: 'provenance/readonly-manifest.json', directory: 'toolchain',
            compiler: 'toolchain/compiler/compile-game.cjs', dependencies: 'toolchain/compiler-dependencies.json', inventory: 'toolchain/inventory.json', sourceLock: 'toolchain/source-lock.json',
            sourceFiles: ['compile-game.cjs', 'files.cjs'].map(name => ({ ...record(`toolchain/compiler/${name}`), sourcePath: `tools/devkit/runtime/${name}` })),
            licenseReview: 'required', missingLicenseFiles: [], node: { bundled: false, minimum: '18.20.8' } },
    });
}

function application(grants, manifest = metadata()) {
    const sdk = { sdkId: manifest.sdkId, manifest,
        search: ({ query, kind, profile }) => ({ query, kind, profile: profile ?? null, availableKinds: ['guide'], items: [], nextCursor: null }) };
    return new Application(sdk, path.join(tmpdir(), 'cocos4-discovery-unused-workspace'), { async close() {} }, grants);
}

// Only remap IDs; the official client and transport still own framing, dispatch
// and validation. Exercise the server's allowed 128-character ID at wire size.
class ObservedTransport extends StdioClientTransport {
    messages = [];
    escapeIds = false;
    async start() {
        const receive = this.onmessage;
        this.onmessage = message => {
            this.messages.push(message);
            receive?.(message.id === escapedId ? { ...message, id: this.originalId } : message);
        };
        await super.start();
    }
    async send(message) {
        if (this.escapeIds && message.method === 'tools/list') {
            this.originalId = message.id;
            return super.send({ ...message, id: escapedId });
        }
        return super.send(message);
    }
}

if (process.argv[2] === '--serve-discovery') {
    await serve(application(JSON.parse(process.argv[3])));
} else {
    test('sixteen-profile discovery stays within the unchanged frame budget for every permission set', async t => {
        const manifest = metadata();
        assert.equal(manifest.catalog.profiles.length, 16);
        assert.equal(manifest.catalog.templates.length, 16);
        for (const grants of permissions) {
            const app = application(grants, manifest);
            try {
                assert.equal(app.tools.length, grants.mode === 'read-only' ? 10 : grants.preview ? 15 : 13);
                for (const id of [1, escapedId]) assert(frameBytes(app.tools, id) <= 65536, `${JSON.stringify(grants)}: ${frameBytes(app.tools, id)} bytes`);
                for (const tool of app.tools) {
                    for (const schema of [tool.inputSchema, tool.outputSchema]) {
                        assert.equal(schema.type, 'object');
                        assert.equal(schema.additionalProperties, false);
                        assert.equal(metaSchema.validateSchema(schema), true, JSON.stringify(metaSchema.errors));
                        assert.equal(ajv.getValidator(schema)({ unexpected: true }).valid, false, tool.name);
                    }
                }
                const search = app.tools.find(tool => tool.name === 'cocos4_docs_search');
                assert.deepEqual(search.inputSchema.properties.profile.enum, ['2d-basic', '3d-basic']);
                for (const profile of ['2d-basic', '3d-basic', 'not-delivered']) {
                    const result = await app.call(search.name, { query: 'Node', kind: 'api', profile });
                    assert.equal(result.isError, profile === 'not-delivered');
                    assert.equal(ajv.getValidator(search.outputSchema)(result.structuredContent).valid, true);
                }
                assert.deepEqual(app.tools.find(tool => tool.name === 'cocos4_catalog').inputSchema.properties.target.enum, [...platforms].sort());
                assert.deepEqual(app.tools.find(tool => tool.name === 'cocos4_package_validate').inputSchema.properties.target.enum, targets.slice(1));
                t.diagnostic(`${JSON.stringify(grants)}: numeric ID ${frameBytes(app.tools, 1)}, escaped ID ${frameBytes(app.tools, escapedId)} bytes`);
            } finally { await app.close(); }
        }
    });

    test('official stdio initialize, full discovery and ping survive escaped IDs without state or jobs', { timeout: 30000 }, async t => {
        for (const grants of permissions) await t.test(JSON.stringify(grants), { timeout: 5000 }, async t => {
            const transport = new ObservedTransport({ command: process.execPath,
                args: [fileURLToPath(import.meta.url), '--serve-discovery', JSON.stringify(grants)], cwd: tmpdir(),
                env: { HOME: tmpdir(), TMPDIR: tmpdir(), XDG_STATE_HOME: path.join(tmpdir(), 'cocos4-discovery-unused-state'), PATH: '', NODE_OPTIONS: '' }, stderr: 'pipe' });
            const client = new Client({ name: 'cocos4-discovery-budget', version: '1' });
            let stderr = '';
            const errors = [];
            transport.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 65536) void client.close(); });
            client.onerror = error => errors.push(error);
            const close = () => { void client.close(); };
            t.signal.addEventListener('abort', close, { once: true });
            t.after(async () => {
                t.signal.removeEventListener('abort', close);
                await client.close();
                assert.equal(transport.pid, null);
                assert.equal(stderr, '');
                assert.deepEqual(errors, []);
            });
            const options = { timeout: 2000 };
            await client.connect(transport, options);
            assert.deepEqual(client.getServerVersion(), { name: 'cocos4-devkit', version: '0.1.0' });
            assert.deepEqual(client.getServerCapabilities(), { tools: {}, resources: {} });
            const expected = application(grants);
            try {
                for (const escaped of [false, true]) {
                    transport.escapeIds = escaped;
                    const result = await client.listTools(undefined, options);
                    assert.equal(result.nextCursor, undefined);
                    assert.deepEqual(result.tools, expected.tools);
                }
            } finally { await expected.close(); }
            await client.ping(options);
            assert.equal(transport.messages.length, 4);
            assert.equal(transport.messages[2].id, escapedId);
            for (const message of transport.messages) assert(Buffer.byteLength(JSON.stringify(message)) + 1 <= 65536);
        });
    });

    test('grouped profile, template and artifact schemas preserve exact target-specific shapes', () => {
        const manifest = metadata();
        const inventories = targets.map(target => ({ schemaVersion: 1, artifactId: '11111111-1111-4111-8111-111111111111',
            sdkId: manifest.sdkId, target, entry: target === 'HTML5' ? 'index.html' : 'game.js', profile: '2d-basic', variant: 'debug',
            validationLevels: [], files: [record(target === 'HTML5' ? 'index.html' : 'game.js')] }));
        const artifacts = inventories.map(({ schemaVersion, ...inventory }) => ({ ...inventory, bytes: 1, files: 1, sha256: digest }));
        for (const [schema, values] of [[profileSchema, manifest.catalog.profiles], [templateSchema, manifest.catalog.templates],
            [artifactSchema, artifacts], [artifactInventorySchema, inventories]]) {
            const validate = ajv.getValidator(toJsonSchemaCompat(z.object({ value: schema }).strict()));
            const check = (value, valid) => {
                const parsed = schema.safeParse(value);
                assert.equal(parsed.success, valid, JSON.stringify(value));
                assert.equal(validate({ value }).valid, valid, JSON.stringify(value));
                if (valid) assert.deepEqual(parsed.data, value, 'Parsing must not change persisted metadata');
            };
            for (const value of values) {
                check(value, true);
                check({ ...value, unexpected: true }, false);
                check({ ...value, variant: 'production' }, false);
                for (const target of ['ANDROID', 'OPPO', 'WECHAT_MINI_PROGRAM', 'wechat', '', null]) check({ ...value, target }, false);
                for (const key of Object.keys(value)) {
                    const missing = { ...value }; delete missing[key];
                    check(missing, false);
                }
                if ('entry' in value) {
                    check({ ...value, entry: value.target === 'HTML5' ? 'game.js' : 'index.html' }, false);
                    check({ ...value, provenance: { releaseId: null, profileSha256: digest } }, true);
                    check({ ...value, provenance: { releaseId: manifest.sdkId, profileSha256: digest } }, true);
                    check({ ...value, provenance: { releaseId: null, profileSha256: 'invalid' } }, false);
                } else {
                    check({ ...value, id: 'x'.repeat(128) }, true);
                    check({ ...value, id: 'x'.repeat(129) }, false);
                    check({ ...value, id: '../escape' }, false);
                    check({ ...value, directory: 'x'.repeat(512) }, true);
                    check({ ...value, directory: 'x'.repeat(513) }, false);
                    // Existing Zod filesystem refinements are not expressible in JSON Schema.
                    for (const directory of ['../escape', 'CON', 'trailing.']) assert.equal(schema.safeParse({ ...value, directory }).success, false);
                }
                if ('descriptor' in value) {
                    const right = value.target === 'HTML5' ? 'browserReport' : 'localReport';
                    const wrong = value.target === 'HTML5' ? 'localReport' : 'browserReport';
                    check({ ...value, [wrong]: value[right] }, false);
                    const swapped = { ...value, [wrong]: value[right] }; delete swapped[right];
                    check(swapped, false);
                }
            }
        }
    });

    test('long legal template IDs do not inflate discovery and an empty profile set accepts no filter', async () => {
        const manifest = metadata();
        manifest.catalog.templates.forEach((template, index) => { template.id = `${index}-`.padEnd(128, 'x'); });
        manifest.description = 'x'.repeat(1024);
        const app = application(permissions.at(-1), manifestSchema.parse(manifest));
        try { assert(frameBytes(app.tools, escapedId) <= 65536); } finally { await app.close(); }
        manifest.kind = 'readonly-development';
        delete manifest.development;
        delete manifest.apiIndex;
        for (const key of ['gameDevelopment', 'gameBuild', 'preview', 'export']) manifest.capabilities[key] = false;
        manifest.catalog.profiles = [];
        manifest.catalog.templates = [];
        manifest.catalog.platforms.forEach(platform => Object.assign(platform, { prebuiltAvailable: false, exportAvailable: false, validationLevels: [] }));
        manifest.catalog.features.forEach(feature => { feature.prebuiltAvailable = false; });
        const readonly = application(permissions[0], manifestSchema.parse(manifest));
        try {
            assert.equal((await readonly.call('cocos4_docs_search', { query: 'Node', kind: 'api' })).isError, false);
            assert.equal((await readonly.call('cocos4_docs_search', { query: 'Node', kind: 'api', profile: '2d-basic' })).structuredContent.error.code, 'INVALID_ARGUMENTS');
        } finally { await readonly.close(); }
    });
}
