import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSON5 from 'json5';
import { catalogSchema, documentSchema, loadSdk, manifestSchema, searchSchema } from '../build/src/sdk.js';
import { publishSdk } from '../scripts/prepare-sdk.mjs';

const run = promisify(execFile);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const engine = fileURLToPath(new URL('../../../', import.meta.url));
const preparer = path.join(devkit, 'scripts/prepare-sdk.mjs');
const require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
    return JSON.stringify(value);
}
let temporary;
let prepared;
let sdk;
before(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'cocos4-sdk-test-'));
    prepared = path.join(temporary, 'prepared');
    await run(process.execPath, [preparer, '--out', prepared], { cwd: temporary });
    sdk = await loadSdk(prepared);
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

async function copy() {
    const directory = path.join(await mkdtemp(path.join(temporary, 'case-')), 'sdk');
    await cp(prepared, directory, { recursive: true });
    return directory;
}
async function mutate(directory, change) {
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    await change(manifest);
    delete manifest.sdkId;
    manifest.sdkId = `sha256-${hash(canonical(manifest))}`;
    await writeFile(file, JSON.stringify(manifest));
}
const code = expected => error => error?.code === expected;
async function snapshot(directory) {
    const result = [];
    async function walk(prefix) {
        for (const name of (await readdir(path.join(directory, prefix))).sort()) {
            const relative = prefix ? `${prefix}/${name}` : name;
            const full = path.join(directory, relative);
            const info = await lstat(full);
            result.push([relative, info.size, info.mode, info.mtimeMs, info.ctimeMs, info.isFile() ? hash(await readFile(full)) : null]);
            if (info.isDirectory()) await walk(relative);
        }
    }
    await walk('');
    return result;
}

test('real sources produce a strict content-addressed pack and truthful catalog', async () => {
    assert.equal(manifestSchema.safeParse(sdk.manifest).success, true);
    const config = JSON5.parse(await readFile(path.join(engine, 'cc.config.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(path.join(engine, 'package.json'), 'utf8'));
    assert.equal(sdk.manifest.engineVersion, pkg.version);
    assert.deepEqual(sdk.manifest.catalog.platforms.map(item => item.id), [...config.platforms].sort());
    assert.deepEqual(sdk.manifest.catalog.features.map(item => item.id), Object.keys(config.features).sort());
    for (const feature of sdk.manifest.catalog.features) {
        assert.deepEqual(feature.modules, config.features[feature.id].modules);
        assert.deepEqual(feature.dependentModules, config.features[feature.id].dependentModules ?? []);
        assert.deepEqual(feature.dependentAssets, config.features[feature.id].dependentAssets ?? []);
    }
    for (const source of sdk.manifest.source.files) {
        const bytes = await readFile(path.join(engine, source.path));
        assert.equal(source.bytes, bytes.length);
        assert.equal(source.sha256, hash(bytes));
    }
    for (const file of sdk.manifest.files) {
        const bytes = await readFile(path.join(prepared, file.path));
        assert.equal(file.bytes, bytes.length);
        assert.equal(file.sha256, hash(bytes));
    }
    assert.equal(sdk.manifest.capabilities.gameDevelopment, false);
    assert.deepEqual(sdk.manifest.catalog.profiles, []);
    assert.deepEqual(sdk.manifest.catalog.templates, []);
    assert.equal(sdk.toolchainRoot, null);
    assert.throws(() => sdk.profile('HTML5', '2d-basic', 'debug'), code('PROFILE_NOT_AVAILABLE'));
    assert.throws(() => sdk.template('2d-basic-starter'), code('PROFILE_NOT_AVAILABLE'));
    for (const section of ['sdk', 'platforms', 'features', 'profiles', 'templates']) {
        const result = sdk.catalog({ section });
        assert.equal(catalogSchema.safeParse(result).success, true);
        assert.equal(result.available, !['profiles', 'templates'].includes(section));
    }
    assert.match(sdk.catalog({ section: 'sdk' }).items[0].description, /No game development/);
    assert(sdk.manifest.catalog.platforms.every(item => !item.prebuiltAvailable && !item.exportAvailable && !item.validationLevels.length));
    assert.equal(sdk.catalog({ section: 'platforms', target: 'BILIBILI' }).items.length, 1);
    assert.throws(() => sdk.catalog({ section: 'platforms', target: 'ANDROID' }), code('INVALID_ARGUMENTS'));
});

test('preparation is reproducible, includes exact trusted validator/license, and excludes unselected sources', async () => {
    const repeated = path.join(temporary, 'repeated');
    await run(process.execPath, [preparer, '--out', repeated, '--engine-root', engine], { cwd: temporary });
    const other = await loadSdk(repeated);
    assert.equal(other.sdkId, sdk.sdkId);
    assert.deepEqual(await readFile(path.join(repeated, 'manifest.json')), await readFile(path.join(prepared, 'manifest.json')));
    assert.deepEqual(await readFile(path.join(prepared, 'app/validate-bilibili.cjs')),
        await readFile(path.join(engine, 'scripts/validate-bilibili.cjs')));
    assert.deepEqual(await readFile(path.join(prepared, 'LICENSE')), await readFile(path.join(engine, 'LICENSE')));
    assert.deepEqual((await readdir(prepared)).sort(), ['LICENSE', 'app', 'docs', 'manifest.json']);
    assert(!JSON.stringify(sdk.manifest).includes(engine));
    assert(!sdk.manifest.files.some(file => /(?:\.env|node_modules|\.git|package\.json|cc\.config)/.test(file.path)));
});

test('concrete persisted readonly packs remain readable without regenerating their source catalog', async t => {
    const persisted = path.join(devkit, 'build/readonly-sdk');
    try { await lstat(persisted); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return t.skip('No persisted readonly pack exists in this checkout. Fresh readonly packs are tested separately.');
    }
    const bytes = await readFile(path.join(persisted, 'manifest.json'));
    const directory = path.join(temporary, 'persisted');
    await cp(persisted, directory, { recursive: true });
    const loaded = await loadSdk(directory);
    assert.equal(loaded.sdkId, JSON.parse(bytes).sdkId);
    assert.equal(loaded.toolchainRoot, null);
    assert.equal(loaded.manifest.kind, 'readonly-development');
    assert.equal(loaded.manifest.capabilities.gameDevelopment, false);
    assert.deepEqual(await readFile(path.join(directory, 'manifest.json')), bytes);
    assert(loaded.search({ query: 'Cocos', kind: 'all' }).items.length > 0);
});

test('preparer uses only its own JSON5 dependency with a dependency-free engine source snapshot', async () => {
    const isolated = await mkdtemp(path.join(temporary, 'prepare-isolated-'));
    const source = path.join(isolated, 'engine');
    const tool = path.join(isolated, 'tool');
    await mkdir(path.join(tool, 'scripts'), { recursive: true });
    await cp(preparer, path.join(tool, 'scripts/prepare-sdk.mjs'));
    if (process.platform === 'win32') {
        // The qualified maintainer publisher is explicit; preparation cannot
        // depend on a compiler, Python or any executable discovered via PATH.
        for (const relative of ['scripts/build-publisher.mjs', 'scripts/build-supervisor-win32.mjs', 'runtime/publish-win32.c',
            'build/host/cocos4-publish.exe', 'build/host/cocos4-publish.exe.build.json']) {
            await mkdir(path.dirname(path.join(tool, relative)), { recursive: true });
            await cp(path.join(devkit, relative), path.join(tool, relative));
        }
    }
    await mkdir(path.join(tool, 'node_modules'));
    assert.equal(require('json5/package.json').version, '2.2.3');
    await cp(path.dirname(require.resolve('json5/package.json')), path.join(tool, 'node_modules/json5'), { recursive: true });
    for (const file of sdk.manifest.source.files) {
        await mkdir(path.dirname(path.join(source, file.path)), { recursive: true });
        await cp(path.join(engine, file.path), path.join(source, file.path));
    }
    await assert.rejects(lstat(path.join(source, 'node_modules')), code('ENOENT'));
    const destination = path.join(isolated, 'pack');
    await run(process.execPath, [path.join(tool, 'scripts/prepare-sdk.mjs'), '--out', destination, '--engine-root', source],
        { cwd: isolated, env: { PATH: '', HOME: isolated, LANG: 'C' } });
    assert.equal((await loadSdk(destination)).sdkId, sdk.sdkId);
});

test('preparation refuses empty, populated, file and symlink destinations without changes', async () => {
    for (const kind of ['empty', 'populated', 'file', 'symlink']) {
        const destination = path.join(temporary, `existing-${kind}`);
        if (kind === 'file') await writeFile(destination, 'keep');
        else if (kind === 'symlink') await symlink(prepared, destination, 'junction');
        else {
            await mkdir(destination);
            if (kind === 'populated') await writeFile(path.join(destination, 'sentinel'), 'keep');
        }
        await assert.rejects(run(process.execPath, [preparer, '--out', destination]), /OUTPUT_CONFLICT/);
        if (kind === 'file') assert.equal(await readFile(destination, 'utf8'), 'keep');
        else if (kind === 'symlink') assert((await lstat(destination)).isSymbolicLink());
        else assert.deepEqual(await readdir(destination), kind === 'empty' ? [] : ['sentinel']);
    }
    await assert.rejects(run(process.execPath, [preparer, '--out', 'relative']), /Usage/);
    await assert.rejects(run(process.execPath, [preparer, '--out', path.join(temporary, 'unused'), '--extra', engine]), /Usage/);
});

test('concurrent publishers never replace the winner and clean staging', async () => {
    const destination = path.join(temporary, 'contended');
    const results = await Promise.allSettled([1, 2, 3].map(() => run(process.execPath, [preparer, '--out', destination])));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await loadSdk(destination)).sdkId, sdk.sdkId);
    assert(!(await readdir(temporary)).some(name => name.startsWith('.cocos4-sdk-staging-')));
});

test('atomic publisher itself rejects a newly created empty destination without replacing its inode', async () => {
    const staging = await copy();
    const destination = path.join(path.dirname(staging), 'destination with spaces-\u4e2d\u6587');
    // Simulate creation after the preparer's preflight, directly at publication.
    await mkdir(destination);
    const before = await lstat(destination, { bigint: true });
    await assert.rejects(publishSdk(staging, destination), /OUTPUT_CONFLICT/);
    assert.equal((await lstat(destination, { bigint: true })).ino, before.ino);
    assert.equal((await lstat(destination, { bigint: true })).ctimeNs, before.ctimeNs);
    assert.deepEqual(await readdir(destination), []);
    assert.equal((await loadSdk(staging)).sdkId, sdk.sdkId);
    await rm(destination, { recursive: true });
    const sourceInode = (await lstat(staging, { bigint: true })).ino;
    await publishSdk(staging, destination);
    assert.equal((await lstat(destination, { bigint: true })).ino, sourceInode);
    await assert.rejects(lstat(staging), code('ENOENT'));
    assert.equal((await loadSdk(destination)).sdkId, sdk.sdkId);
    await assert.rejects(publishSdk(staging, path.join(path.dirname(staging), 'missing')), /ATOMIC_PUBLISH_FAILED/);
    await assert.rejects(lstat(path.join(path.dirname(staging), 'missing')), code('ENOENT'));
});

test('atomic publisher rejects existing files, populated directories and links at publication time', async () => {
    for (const kind of ['file', 'populated', 'link']) {
        const staging = await copy();
        const destination = path.join(path.dirname(staging), 'occupied');
        if (kind === 'file') await writeFile(destination, 'keep');
        else if (kind === 'link') await symlink(prepared, destination, 'junction');
        else { await mkdir(destination); await writeFile(path.join(destination, 'sentinel'), 'keep'); }
        const before = await lstat(destination, { bigint: true });
        await assert.rejects(publishSdk(staging, destination), /OUTPUT_CONFLICT|ATOMIC_PUBLISH_FAILED/);
        const after = await lstat(destination, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.ctimeNs, before.ctimeNs);
        if (kind === 'file') assert.equal(await readFile(destination, 'utf8'), 'keep');
        else if (kind === 'link') assert(after.isSymbolicLink());
        else assert.deepEqual(await readdir(destination), ['sentinel']);
        assert.equal((await loadSdk(staging)).sdkId, sdk.sdkId);
    }
});

test('Windows preparation refuses a stale qualified publisher without publishing the pack', async t => {
    if (process.platform !== 'win32') return t.skip('Windows helper provenance contract.');
    const isolated = await mkdtemp(path.join(temporary, 'publisher-provenance-'));
    for (const relative of ['scripts/prepare-sdk.mjs', 'scripts/build-publisher.mjs', 'scripts/build-supervisor-win32.mjs', 'runtime/publish-win32.c',
        'build/host/cocos4-publish.exe', 'build/host/cocos4-publish.exe.build.json']) {
        await mkdir(path.dirname(path.join(isolated, relative)), { recursive: true });
        await cp(path.join(devkit, relative), path.join(isolated, relative));
    }
    await cp(path.dirname(require.resolve('json5/package.json')), path.join(isolated, 'node_modules/json5'), { recursive: true });
    const executable = path.join(isolated, 'build/host/cocos4-publish.exe');
    await writeFile(executable, Buffer.concat([await readFile(executable), Buffer.from('changed')]));
    const destination = path.join(isolated, 'sdk');
    await assert.rejects(run(process.execPath, [path.join(isolated, 'scripts/prepare-sdk.mjs'), '--engine-root', path.resolve(engine), '--out', destination]),
        /ATOMIC_PUBLISH_UNAVAILABLE/);
    await assert.rejects(lstat(destination), code('ENOENT'));
    assert(!(await readdir(isolated)).some(name => name.startsWith('.cocos4-sdk-staging-')));
});

test('catalog pagination is complete and cursors bind every condition and instance', async () => {
    const actual = [];
    let cursor;
    do {
        const result = sdk.catalog({ section: 'features', limit: 2, ...(cursor ? { cursor } : {}) });
        actual.push(...result.items.map(item => item.id));
        cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(actual, sdk.manifest.catalog.features.map(item => item.id));
    cursor = sdk.catalog({ section: 'features', limit: 2 }).nextCursor;
    assert(cursor);
    for (const query of [
        { section: 'platforms', limit: 2 }, { section: 'features', target: 'BILIBILI', limit: 2 },
        { section: 'features', limit: 3 },
    ]) assert.throws(() => sdk.catalog({ ...query, cursor }), code('CURSOR_INVALID'));
    const altered = `${cursor.slice(0, 5)}${cursor[5] === 'A' ? 'B' : 'A'}${cursor.slice(6)}`;
    assert.throws(() => sdk.catalog({ section: 'features', limit: 2, cursor: altered }), code('CURSOR_INVALID'));
    const reloaded = await loadSdk(prepared);
    assert.throws(() => reloaded.catalog({ section: 'features', limit: 2, cursor }), code('CURSOR_INVALID'));
    assert.throws(() => sdk.search({ query: 'Cocos', kind: 'all', limit: 2, cursor }), code('CURSOR_INVALID'));
});

test('search only returns actual guide text, positions and bound pagination', () => {
    const first = sdk.search({ query: 'Cocos', kind: 'all', limit: 1 });
    assert.equal(searchSchema.safeParse(first).success, true);
    assert.deepEqual(first.availableKinds, ['guide']);
    assert(first.nextCursor);
    for (const kind of ['api', 'example']) assert.deepEqual(sdk.search({ query: 'Node', kind }).items, []);
    const seen = [];
    let cursor;
    do {
        const page = sdk.search({ query: 'Cocos', kind: 'all', limit: 1, ...(cursor ? { cursor } : {}) });
        for (const result of page.items) {
            seen.push(result.documentId);
            const doc = sdk.manifest.docs.find(doc => doc.id === result.documentId);
            const text = sdk.resource(`cocos4://sdk/${sdk.sdkId}/docs/${doc.id}`);
            assert(text.includes('Cocos') || doc.title.includes('Cocos'));
            assert.deepEqual(result.requiredFeatures, []);
            if (result.matches.length) {
                const position = result.matches[0];
                assert([...text.split('\n')[position.line - 1]].slice(position.column - 1).join('').startsWith('Cocos'));
            }
        }
        cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    assert(seen.length > 1);
    assert.throws(() => sdk.search({ query: 'Node', kind: 'all', limit: 1, cursor: first.nextCursor }), code('CURSOR_INVALID'));
    assert.throws(() => sdk.search({ query: 'Cocos', kind: 'guide', limit: 1, cursor: first.nextCursor }), code('CURSOR_INVALID'));
    assert.throws(() => sdk.search({ query: 'Cocos', kind: 'all', profile: '2d-basic' }), code('PROFILE_NOT_AVAILABLE'));
});

test('guide resources and byte-safe reads expose the same bounded immutable documents', async () => {
    const resources = sdk.resources();
    assert.equal(resources.length, sdk.manifest.docs.length + 1);
    assert(Buffer.byteLength(sdk.resource(resources[0].uri)) < 16 * 1024);
    for (const doc of sdk.manifest.docs) {
        const resource = resources.find(resource => resource.uri.endsWith(`/docs/${doc.id}`));
        assert(resource);
        const whole = sdk.resource(resource.uri);
        assert.equal(whole, await readFile(path.join(prepared, doc.path), 'utf8'));
        assert(Buffer.byteLength(whole) <= 16 * 1024);
        let cursor;
        let reconstructed = '';
        do {
            const part = sdk.read({ documentId: doc.id, maxBytes: 67, ...(cursor ? { cursor } : {}) });
            assert.equal(documentSchema.safeParse(part).success, true);
            assert.equal(part.offsetBytes, Buffer.byteLength(reconstructed));
            assert(Buffer.byteLength(part.content) <= 67);
            assert(!part.content.includes('\ufffd'));
            reconstructed += part.content;
            cursor = part.nextCursor;
        } while (cursor);
        assert.equal(reconstructed, whole);
    }
    const doc = sdk.manifest.docs[0];
    const first = sdk.read({ documentId: doc.id, maxBytes: 4 });
    assert.throws(() => sdk.read({ documentId: sdk.manifest.docs[1].id, maxBytes: 4, cursor: first.nextCursor }), code('CURSOR_INVALID'));
    assert.throws(() => sdk.read({ documentId: doc.id, maxBytes: 8, cursor: first.nextCursor }), code('CURSOR_INVALID'));
    for (const documentId of ['../LICENSE', 'app/validate-bilibili.cjs', 'guide-not-present']) {
        assert.throws(() => sdk.read({ documentId }), code('INVALID_ARGUMENTS'));
    }
    for (const uri of ['file:///etc/passwd', `${resources[1].uri}/../LICENSE`, resources[1].uri.replace(sdk.sdkId, 'wrong')]) {
        assert.throws(() => sdk.resource(uri), code('INVALID_ARGUMENTS'));
    }
});

test('SDK and cached content remain readonly even after disk tampering', async () => {
    const directory = await copy();
    const loaded = await loadSdk(directory);
    assert(Object.isFrozen(loaded));
    assert(Object.isFrozen(loaded.manifest.catalog.features[0].modules));
    assert.throws(() => { loaded.manifest.catalog.features.push({}); }, TypeError);
    const doc = loaded.manifest.docs[0];
    const before = loaded.read({ documentId: doc.id });
    const uri = loaded.resources().find(resource => resource.uri.endsWith(`/docs/${doc.id}`)).uri;
    const resourceBefore = loaded.resource(uri);
    loaded.catalog({ section: 'features' }).items[0].modules.push('caller-mutation');
    loaded.resources()[0].name = 'caller-mutation';
    assert(!loaded.manifest.catalog.features[0].modules.includes('caller-mutation'));
    assert.notEqual(loaded.resources()[0].name, 'caller-mutation');
    await writeFile(path.join(directory, doc.path), 'tampered');
    assert.deepEqual(loaded.read({ documentId: doc.id }), before);
    assert.equal(loaded.resource(uri), resourceBefore);
    await assert.rejects(loadSdk(directory), code('SDK_INCOMPLETE'));
});

test('readonly filesystem operation does not create files or alter payload/metadata', async () => {
    const directory = await copy();
    const paths = (await snapshot(directory)).map(entry => entry[0]);
    try {
        for (const relative of paths.reverse()) {
            const full = path.join(directory, relative);
            await chmod(full, (await stat(full)).isDirectory() ? 0o555 : 0o444);
        }
        await chmod(directory, 0o555);
        const before = await snapshot(directory);
        const loaded = await loadSdk(directory);
        loaded.catalog({ section: 'sdk' });
        loaded.search({ query: 'Cocos', kind: 'all' });
        loaded.read({ documentId: loaded.manifest.docs[0].id });
        for (const resource of loaded.resources()) loaded.resource(resource.uri);
        assert.deepEqual(await snapshot(directory), before);
    } finally {
        await chmod(directory, 0o755);
        for (const relative of paths.reverse()) {
            const full = path.join(directory, relative);
            await chmod(full, (await stat(full)).isDirectory() ? 0o755 : 0o644);
        }
    }
});

test('copied pack and copied runtime load and run validator without any engine path', async () => {
    const isolated = await mkdtemp(path.join(temporary, 'isolated-'));
    const data = path.join(isolated, 'data');
    const runtime = path.join(isolated, 'runtime');
    await cp(prepared, data, { recursive: true });
    await mkdir(runtime);
    await cp(path.join(devkit, 'build/src/sdk.js'), path.join(runtime, 'sdk.js'));
    await cp(path.join(devkit, 'build/src/contracts.js'), path.join(runtime, 'contracts.js'));
    await cp(path.join(devkit, 'build/src/api-index.js'), path.join(runtime, 'api-index.js'));
    await writeFile(path.join(runtime, 'package.json'), '{"type":"module"}');
    await mkdir(path.join(runtime, 'node_modules'));
    await cp(path.join(devkit, 'node_modules/zod'), path.join(runtime, 'node_modules/zod'), { recursive: true });
    const game = path.join(isolated, 'game');
    await mkdir(game);
    for (const file of ['game.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js']) {
        await writeFile(path.join(game, file), 'throw new Error("project code must never execute");');
    }
    await writeFile(path.join(game, 'game.json'), JSON.stringify({ appId: 'test-only', version: '1.0' }));
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
        import { loadSdk } from './runtime/sdk.js';
        import { createRequire } from 'node:module';
        const sdk = await loadSdk(process.cwd() + '/data');
        const validator = createRequire(import.meta.url)(sdk.root + '/app/validate-bilibili.cjs');
        const result = validator.validateBilibili(process.cwd() + '/game');
        console.log(JSON.stringify({ id: sdk.sdkId, docs: sdk.resources().length, appId: result.appId }));
    `], { cwd: isolated, env: { PATH: '', HOME: isolated, LANG: 'C' } });
    assert.deepEqual(JSON.parse(stdout), { id: sdk.sdkId, docs: sdk.resources().length, appId: 'test-only' });
});

test('strict input and output schemas reject unknown fields and bounds', () => {
    for (const value of [{ section: 'sdk', extra: true }, { section: 'sdk', limit: 0 }, { section: 'sdk', limit: 101 }, { section: 'sdk', limit: 1.2 }]) {
        assert.throws(() => sdk.catalog(value), code('INVALID_ARGUMENTS'));
    }
    for (const value of [{ query: '', kind: 'all' }, { query: ' ', kind: 'all' }, { query: 'x'.repeat(257), kind: 'all' }, { query: 'x', kind: 'all', extra: true }]) {
        assert.throws(() => sdk.search(value), code('INVALID_ARGUMENTS'));
    }
    for (const maxBytes of [0, 3, 16385, Infinity]) assert.throws(() => sdk.read({ documentId: sdk.manifest.docs[0].id, maxBytes }), code('INVALID_ARGUMENTS'));
    for (const [schema, value] of [
        [catalogSchema, sdk.catalog({ section: 'sdk' })], [searchSchema, sdk.search({ query: 'Cocos', kind: 'all' })],
        [documentSchema, sdk.read({ documentId: sdk.manifest.docs[0].id })],
    ]) assert.equal(schema.safeParse({ ...value, extra: true }).success, false);
    const nested = sdk.catalog({ section: 'platforms' });
    nested.items[0].extra = true;
    assert.equal(catalogSchema.safeParse(nested).success, false);
});

test('reject malformed, duplicate-key, oversized and invalid UTF-8 manifests', async () => {
    const original = await readFile(path.join(prepared, 'manifest.json'), 'utf8');
    for (const text of [
        '{', original.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'),
        original.replace('"schemaVersion": 1', '"schemaVersion": 1, "\\u0073chemaVersion": 1'),
        original.replace('"gameBuild": false', '"gameBuild": false, "gameBuild": false'),
        ' '.repeat(256 * 1024 + 1), Buffer.from([0xff, 0xfe]),
    ]) {
        const directory = await copy();
        await writeFile(path.join(directory, 'manifest.json'), text);
        await assert.rejects(loadSdk(directory), code('SDK_INCOMPLETE'));
    }
});

test('reject rehashed but invalid schema, duplicate entries, paths, mappings and capability claims', async () => {
    const cases = [
        manifest => { manifest.extra = true; },
        manifest => { manifest.schemaVersion = 2; },
        manifest => { manifest.kind = 'portable-game'; },
        manifest => { manifest.kind = 'portable-development'; },
        manifest => { manifest.development = { directory: 'toolchain' }; },
        manifest => { manifest.capabilities.gameBuild = true; },
        manifest => { manifest.catalog.platforms[0].prebuiltAvailable = true; },
        manifest => { manifest.catalog.features[0].prebuiltAvailable = true; },
        manifest => { manifest.catalog.profiles.push({ id: 'fake' }); },
        manifest => { manifest.files.push(manifest.files[0]); },
        manifest => { manifest.docs.push(manifest.docs[0]); },
        manifest => { manifest.catalog.platforms.push(manifest.catalog.platforms[0]); },
        manifest => { manifest.catalog.features.push(manifest.catalog.features[0]); },
        manifest => { manifest.source.files[0] = manifest.source.files[1]; manifest.source.sha256 = hash(canonical(manifest.source.files)); },
        manifest => { manifest.source.sha256 = '0'.repeat(64); },
        manifest => { manifest.files[0].path = '../LICENSE'; },
        manifest => { manifest.files[0].path = '/etc/passwd'; },
        manifest => { manifest.files[0].path = 'docs\\escape.md'; },
        manifest => { manifest.files[0].path = 'docs/%2e%2e/escape.md'; },
        manifest => { manifest.files[0].path = 'docs/a.md:secret'; },
        manifest => { manifest.files[0].path = 'docs/a\0.md'; },
        manifest => { manifest.files[0].bytes = -1; },
        manifest => { manifest.files[0].bytes = 32769; },
        manifest => { manifest.files[0].sha256 = 'g'.repeat(64); },
        manifest => { manifest.docs[0].path = 'app/validate-bilibili.cjs'; },
        manifest => { manifest.docs[0].sourceOffset = 1; },
        manifest => { manifest.docs[0].sourcePath = 'package.json'; },
        manifest => { manifest.docs[0].id = '../LICENSE'; },
    ];
    for (const change of cases) {
        const directory = await copy();
        await mutate(directory, change);
        await assert.rejects(loadSdk(directory), code('SDK_INCOMPLETE'));
    }
});

test('reject stale sdkId, hash/size corruption, missing and unlisted files', async () => {
    const changes = [
        async directory => {
            const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
            manifest.engineVersion = 'changed';
            await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
        },
        async directory => {
            const file = path.join(directory, sdk.manifest.docs[0].path);
            const bytes = await readFile(file);
            bytes[0] ^= 1;
            await writeFile(file, bytes);
        },
        directory => writeFile(path.join(directory, sdk.manifest.docs[0].path), 'short'),
        directory => rm(path.join(directory, 'LICENSE')),
        directory => writeFile(path.join(directory, '.env'), 'secret=not indexed'),
        directory => mkdir(path.join(directory, 'unexpected')),
    ];
    for (const change of changes) {
        const directory = await copy();
        await change(directory);
        await assert.rejects(loadSdk(directory), code('SDK_INCOMPLETE'));
    }
});

test('reject symlink roots, ancestors, directories, files and special files without blocking', async () => {
    const rootLink = path.join(temporary, 'root-link');
    await symlink(prepared, rootLink, 'junction');
    await assert.rejects(loadSdk(rootLink), code('SDK_INCOMPLETE'));
    await assert.rejects(loadSdk(path.join(rootLink, 'docs', '..')), code('SDK_INCOMPLETE'));
    const ancestorLink = path.join(temporary, 'ancestor-link');
    await symlink(path.dirname(prepared), ancestorLink, 'junction');
    await assert.rejects(loadSdk(path.join(ancestorLink, path.basename(prepared))), code('SDK_INCOMPLETE'));
    for (const relative of ['manifest.json', 'docs', 'app/validate-bilibili.cjs']) {
        const directory = await copy();
        await rm(path.join(directory, relative), { recursive: true });
        await symlink(path.join(prepared, relative), path.join(directory, relative), relative === 'docs' ? 'junction' : 'file');
        await assert.rejects(loadSdk(directory), code('SDK_INCOMPLETE'));
    }
    const hardlinked = await copy();
    await link(path.join(hardlinked, 'LICENSE'), path.join(temporary, 'hardlink'));
    await assert.rejects(loadSdk(hardlinked), code('SDK_INCOMPLETE'));
    if (process.platform === 'linux') {
        const directory = await copy();
        await rm(path.join(directory, 'LICENSE'));
        await run('/usr/bin/mkfifo', [path.join(directory, 'LICENSE')]);
        await assert.rejects(loadSdk(directory), code('SDK_INCOMPLETE'));
    }
});

test('hash-valid payload with invalid UTF-8 still fails', async () => {
    const directory = await copy();
    const bytes = Buffer.from([0xff]);
    await writeFile(path.join(directory, 'LICENSE'), bytes);
    await mutate(directory, manifest => {
        Object.assign(manifest.files.find(file => file.path === 'LICENSE'), { bytes: bytes.length, sha256: hash(bytes) });
        Object.assign(manifest.source.files.find(file => file.path === 'LICENSE'), { bytes: bytes.length, sha256: hash(bytes) });
        manifest.source.sha256 = hash(canonical(manifest.source.files));
    });
    await assert.rejects(loadSdk(directory), code('SDK_INCOMPLETE'));
});

test('worst escaping and Unicode remain byte-safe and within duplicated response budget', async () => {
    const directory = await copy();
    const doc = sdk.manifest.docs.find(doc => doc.sourcePath === 'AGENTS.md');
    const text = '"\\\u0000\n\u{1f680}'.repeat(1280);
    const bytes = Buffer.from(text);
    await writeFile(path.join(directory, doc.path), bytes);
    await mutate(directory, manifest => {
        Object.assign(manifest.files.find(file => file.path === doc.path), { bytes: bytes.length, sha256: hash(bytes) });
        Object.assign(manifest.source.files.find(file => file.path === doc.sourcePath), { bytes: bytes.length, sha256: hash(bytes) });
        manifest.source.sha256 = hash(canonical(manifest.source.files));
    });
    const loaded = await loadSdk(directory);
    let cursor;
    let reconstructed = '';
    let pages = 0;
    do {
        const data = loaded.read({ documentId: doc.id, maxBytes: 16384, ...(cursor ? { cursor } : {}) });
        const envelope = { schemaVersion: 1, sdkId: loaded.sdkId, ok: true, data, warnings: [], error: null };
        const wire = { jsonrpc: '2.0', id: 1, result: { structuredContent: envelope, content: [{ type: 'text', text: JSON.stringify(envelope) }] } };
        assert(Buffer.byteLength(JSON.stringify(wire)) < 64 * 1024);
        assert(!data.content.includes('\ufffd'));
        ++pages;
        reconstructed += data.content;
        cursor = data.nextCursor;
    } while (cursor);
    assert.equal(reconstructed, text);
    assert(pages > 1, 'escaping overhead should clamp the requested 16 KiB chunk');
});
