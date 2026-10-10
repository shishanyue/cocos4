import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import promises from 'node:fs/promises';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';

// An isolated compiler output avoids racing the parent agent's integration build.
const moduleUrl = process.env.COCOS4_PREVIEW_MODULE ? pathToFileURL(process.env.COCOS4_PREVIEW_MODULE)
    : new URL('../build/src/preview.js', import.meta.url);
const { startPreview } = await import(moduleUrl.href);
const { AppError, artifactInventorySchema, artifactSchema, MAX_ARTIFACT_BYTES, previewSchema } = await import(new URL('./contracts.js', moduleUrl).href);
const windows = process.platform === 'win32';
const { enforceWindowsPrivate } = windows ? await import(new URL('./windows-fs.js', moduleUrl).href) : {};
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const code = expected => error => { assert.ok(error instanceof AppError, error.stack); assert.equal(error.code, expected, error.stack); return true; };
const isPayloadOpen = filename => path.basename(filename) === 'index.html';
const linked = (target, destination, directory = false) => fs.symlink(target, destination, directory ? (windows ? 'junction' : 'dir') : 'file');
const makePublic = async filename => {
    if (!windows) return fs.chmod(filename, (await fs.stat(filename)).isDirectory() ? 0o755 : 0o644);
    await execute(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [filename, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
};

async function fixture(t, extra = {}, prefix = 'cocos4-preview-') {
    const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), prefix));
    if (windows) await enforceWindowsPrivate(root);
    const cleanup = [];
    t.after(async () => {
        for (const close of cleanup.reverse()) await close();
        await fs.rm(root, { recursive: true, force: true });
    });
    const metadata = { artifactId: randomUUID(), sdkId: 'sha256-test-sdk', target: 'HTML5', profile: '2d-basic',
        variant: 'debug', entry: 'index.html', validationLevels: ['engine-build', 'game-typecheck'] };
    const artifactDirectory = path.join(root, `artifact-${metadata.artifactId}`);
    await fs.mkdir(artifactDirectory, { mode: 0o700 });
    if (windows) await enforceWindowsPrivate(artifactDirectory);
    const payload = new Map(Object.entries({
        'index.html': '<!doctype html><script src="loader.js"></script><script src="boot.js"></script>',
        'loader.js': '/* Static loader bytes. Never evaluated by the server. */',
        'boot.js': 'throw new Error("THE HTTP SERVER MUST NEVER EXECUTE GAME CODE");',
        'game/main.js': 'System.register([], function () { return { execute() {} }; });',
        'game-compiler.json': '{"requiredCCExports":[]}',
        'settings.json': '{}',
        'assets/image.png': Buffer.from([137, 80, 78, 71]),
        'assets/audio.wav': Buffer.from('RIFF'),
        'engine/module.wasm': Buffer.from([0, 97, 115, 109]),
        ...extra,
    }).map(([name, bytes]) => [name, Buffer.from(bytes)]));
    for (const [name, bytes] of payload) {
        await fs.mkdir(path.dirname(path.join(artifactDirectory, name)), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(artifactDirectory, name), bytes, { mode: 0o600 });
        if (windows) {
            let directory = path.dirname(path.join(artifactDirectory, name));
            while (directory !== artifactDirectory) {
                await enforceWindowsPrivate(directory);
                directory = path.dirname(directory);
            }
            await enforceWindowsPrivate(path.join(artifactDirectory, name));
        }
    }
    const inventory = { ...metadata, schemaVersion: 1,
        files: [...payload].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: digest(bytes) })) };
    const artifact = { ...metadata, files: inventory.files.length,
        bytes: inventory.files.reduce((sum, file) => sum + file.bytes, 0), sha256: '' };
    const inventoryFile = path.join(artifactDirectory, 'artifact-inventory.json');
    const seal = async () => {
        const raw = Buffer.from(JSON.stringify(inventory));
        await fs.writeFile(inventoryFile, raw, { mode: 0o600 });
        if (windows) await enforceWindowsPrivate(inventoryFile);
        artifact.sha256 = digest(raw);
    };
    await seal();
    const options = (ttlSeconds = 60) => ({ artifactDirectory, artifact, ttlSeconds });
    return { root, artifactDirectory, artifact, inventory, inventoryFile, payload, seal, options, cleanup,
        start: async (ttlSeconds = 60) => {
            const service = await startPreview(options(ttlSeconds));
            cleanup.push(() => service.close());
            return service;
        } };
}

function request(preview, overrides = {}) {
    const url = new URL(preview.url);
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: preview.port, path: url.pathname,
            agent: false, ...overrides }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.setTimeout(3000, () => request.destroy(new Error('HTTP test timed out')));
        request.end(overrides.body);
    });
}

function rawRequest(preview, bytes) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: preview.port }, () => socket.write(bytes));
        let response = '';
        socket.setTimeout(3000, () => socket.destroy(new Error('Raw HTTP test timed out')));
        socket.on('data', chunk => { response += chunk.toString('latin1'); });
        socket.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
        socket.on('close', () => resolve(response));
    });
}

async function idleSocket(env, preview) {
    const socket = net.connect({ host: '127.0.0.1', port: preview.port });
    socket.on('error', () => {});
    socket.resume();
    env.cleanup.push(() => socket.destroy());
    await once(socket, 'connect');
    return socket;
}

test('BILIBILI receipts are valid artifacts but cannot open files or a preview listener', async t => {
    const env = await fixture(t, { 'game.js': 'throw new Error("NOT A BROWSER ENTRY");' });
    Object.assign(env.artifact, { target: 'BILIBILI', entry: 'game.js' });
    Object.assign(env.inventory, { target: 'BILIBILI', entry: 'game.js' });
    await env.seal();
    artifactSchema.parse(env.artifact);
    artifactInventorySchema.parse(env.inventory);
    for (const [target, entry] of [['HTML5', 'game.js'], ['BILIBILI', 'index.html']]) {
        assert.equal(artifactSchema.safeParse({ ...env.artifact, target, entry }).success, false);
        assert.equal(artifactInventorySchema.safeParse({ ...env.inventory, target, entry }).success, false);
    }
    const originalOpen = promises.open;
    const originalCreateServer = http.createServer;
    let opened = 0;
    let listeners = 0;
    promises.open = (...args) => { opened++; return originalOpen(...args); };
    http.createServer = (...args) => { listeners++; return originalCreateServer(...args); };
    syncBuiltinESMExports();
    try { await assert.rejects(env.start(), code('UNSUPPORTED_PROJECT')); }
    finally {
        promises.open = originalOpen;
        http.createServer = originalCreateServer;
        syncBuiltinESMExports();
    }
    assert.equal(opened, 0);
    assert.equal(listeners, 0);
});

test('real loopback GET/HEAD, relative runtime routes and binary MIME types', async t => {
    const env = await fixture(t);
    for (const file of ['index.html', 'loader.js', 'game/main.js']) await fs.chmod(path.join(env.artifactDirectory, file), 0o400);
    const { preview } = await env.start();
    assert.deepEqual(previewSchema.parse(preview), preview);
    const url = new URL(preview.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/[a-f0-9]{64}\/$/);
    assert.equal(Number(url.port), preview.port);
    const second = await env.start();
    assert.notEqual(new URL(second.preview.url).pathname, url.pathname);
    const root = await request(preview);
    assert.equal(root.status, 200);
    assert.deepEqual(root.body, env.payload.get('index.html'));
    assert.equal(root.headers['cache-control'], 'no-store');
    assert.equal(root.headers['x-content-type-options'], 'nosniff');
    assert.equal(root.headers['referrer-policy'], 'no-referrer');
    assert.equal(root.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(root.headers['access-control-allow-origin'], undefined);
    assert.equal(root.headers.connection, 'close');
    for (const [name, mime] of [['index.html', 'text/html'], ['loader.js', 'text/javascript'], ['boot.js', 'text/javascript'],
        ['game/main.js', 'text/javascript'], ['game-compiler.json', 'application/json'], ['settings.json', 'application/json'],
        ['assets/image.png', 'image/png'], ['assets/audio.wav', 'audio/wav'], ['engine/module.wasm', 'application/wasm']]) {
        const asset = new URL(name, preview.url);
        assert.ok(asset.pathname.startsWith(url.pathname));
        for (const method of ['GET', 'HEAD']) {
            const response = await request(preview, { path: `${asset.pathname}?v=1`, method });
            assert.equal(response.status, 200, `${method} ${name}`);
            assert.equal(response.headers['content-type'].split(';')[0], mime);
            assert.equal(Number(response.headers['content-length']), env.payload.get(name).length);
            assert.deepEqual(response.body, method === 'HEAD' ? Buffer.alloc(0) : env.payload.get(name));
        }
    }
});

test('all routes require the secret prefix, exact Host and absent or exact same Origin', async t => {
    const env = await fixture(t);
    const { preview } = await env.start();
    const url = new URL(preview.url);
    for (const target of ['/', '/index.html', '/favicon.ico', '/artifact-inventory.json', `/${'0'.repeat(64)}/`, url.pathname.slice(0, -1)]) {
        assert.equal((await request(preview, { path: target })).status, 404, target);
    }
    assert.equal((await request(preview, { headers: { Origin: url.origin } })).status, 200);
    for (const Host of ['localhost', `localhost:${preview.port}`, '127.0.0.1', 'evil.invalid', '127.1', `127.0.0.1:${preview.port + 1}`, `${url.host}.`]) {
        const response = await request(preview, { headers: { Host } });
        assert.equal(response.status, 403, Host);
        assert.equal(response.body.length, 0);
    }
    for (const Origin of ['null', 'https://evil.invalid', 'http://localhost', `${url.origin}/`, `https://${url.host}`, `${url.origin} http://evil.invalid`]) {
        assert.equal((await request(preview, { headers: { Origin } })).status, 403, Origin);
    }
    for (const value of ['cross-site', 'same-site']) {
        assert.equal((await request(preview, { headers: { 'Sec-Fetch-Site': value } })).status, 403);
    }
    for (const headers of ['', `Host: ${url.host}\r\nHost: ${url.host}\r\n`,
        `Host: ${url.host}\r\nOrigin: ${url.origin}\r\nOrigin: ${url.origin}\r\n`]) {
        const response = await rawRequest(preview, `GET ${url.pathname} HTTP/1.0\r\n${headers}\r\n`);
        assert.match(response, /^HTTP\/1\.1 40[03]/);
        assert.ok(!response.includes(env.payload.get('index.html').toString()));
    }
});

test('raw traversal, percent escapes, alternate separators, unknown assets and private routes never normalize into payload', async t => {
    const env = await fixture(t);
    const { preview } = await env.start();
    const url = new URL(preview.url);
    const bad = ['../index.html', './index.html', 'game/../index.html', 'game/./main.js', 'game//main.js',
        '%2e%2e/index.html', '%252e%252e/index.html', 'game%2fmain.js', '%69ndex.html', 'game\\main.js',
        '..;/index.html', 'index.html.', '/index.html', 'index.html#ignored', 'index.html?escape=%2f',
        'unknown.js', '__proto__', 'assets', 'assets/', '.env', '.git/config', 'key.json', 'credentials.json',
        'artifact-inventory.json', 'metadata.json', 'sdk/manifest.json', 'compiler/compile-game.cjs', 'workspace/src/main.ts'];
    for (const name of bad) {
        const response = await request(preview, { path: `${url.pathname}${name}` });
        assert.equal(response.status, 404, name);
        assert.equal(response.body.length, 0);
        assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await request(preview, { path: preview.url })).status, 404, 'absolute-form proxy target');
    assert.equal((await request(preview, { path: `//${url.host}${url.pathname}` })).status, 404);
});

test('GET/HEAD only; bodies, expectations, upgrade, CONNECT and pipelining cannot create another service', async t => {
    const env = await fixture(t);
    const { preview } = await env.start();
    const url = new URL(preview.url);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
        const response = await request(preview, { method });
        assert.equal(response.status, 405, method);
        assert.equal(response.headers.allow, 'GET, HEAD');
    }
    assert.equal((await request(preview, { headers: { 'Content-Length': '1' }, body: 'x' })).status, 400);
    const expect = await rawRequest(preview, `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nExpect: 100-continue\r\n\r\n`);
    assert.match(expect, /^HTTP\/1\.1 400/);
    assert.ok(!expect.includes('100 Continue'));
    assert.equal(await rawRequest(preview, `CONNECT evil.invalid:80 HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`), '');
    assert.equal(await rawRequest(preview, `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`), '');
    const line = `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`;
    const pipelined = await rawRequest(preview, line + line);
    assert.ok((pipelined.match(/HTTP\/1\.1 200/g) ?? []).length <= 1);
});

test('raw inventory SHA-256, every receipt identity field, byte totals and counts are enforced', async t => {
    await t.test('raw inventory bytes, not reserialized JSON', async t => {
        const env = await fixture(t);
        await fs.appendFile(env.inventoryFile, '\n');
        await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
    });
    for (const [key, value] of Object.entries({ artifactId: randomUUID(), sdkId: 'wrong-sdk', target: 'WECHAT',
        profile: '3d-basic', variant: 'release', entry: 'other.html', validationLevels: ['unearned-browser-evidence'] })) {
        await t.test(key, async t => {
            const env = await fixture(t);
            env.inventory[key] = value;
            await env.seal();
            await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
        });
    }
    for (const key of ['bytes', 'files']) {
        await t.test(`receipt ${key}`, async t => {
            const env = await fixture(t);
            env.artifact[key]++;
            await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
        });
    }
    await t.test('payload SHA-256', async t => {
        const env = await fixture(t);
        await fs.writeFile(path.join(env.artifactDirectory, 'index.html'), Buffer.alloc(env.payload.get('index.html').length, 120));
        await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
    });
});

test('retained release and profile provenance is bound to the exact inventory, including legacy absence', async t => {
    const env = await fixture(t);
    const provenance = { releaseId: `sha256-${'a'.repeat(64)}`, profileSha256: 'b'.repeat(64) };
    env.inventory.provenance = provenance;
    await env.seal();
    await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
    for (const changed of [{ ...provenance, releaseId: null }, { ...provenance, profileSha256: 'c'.repeat(64) }]) {
        env.artifact.provenance = changed;
        await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
    }
    env.artifact.provenance = provenance;
    const service = await env.start();
    assert.equal((await request(service.preview)).status, 200);
});

test('inventory rejects duplicate, private, escaped and self-including paths, missing entry and unknown schema fields', async t => {
    for (const name of ['../outside', '/absolute', 'game//main.js', 'game/../main.js', 'game\\main.js', 'game/%2emain.js',
        'game/CON', 'game/file.', '.env', 'assets/.env.production', 'assets/key.json', 'assets/server.pem',
        'artifact-inventory.json', 'metadata.json', 'sdk/manifest.json', 'compiler-dependencies.json', 'node_modules/code.js']) {
        await t.test(name, async t => {
            const env = await fixture(t);
            env.inventory.files[1].path = name;
            await env.seal();
            await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
        });
    }
    for (const variant of ['duplicate', 'case collision', 'missing entry', 'unknown field', 'file-directory collision']) {
        await t.test(variant, async t => {
            const env = await fixture(t);
            if (variant === 'duplicate') env.inventory.files[1] = { ...env.inventory.files[0] };
            if (variant === 'case collision') env.inventory.files[1].path = 'INDEX.HTML';
            if (variant === 'missing entry') env.inventory.files[0].path = 'other.html';
            if (variant === 'unknown field') env.inventory.command = 'NEVER EXECUTE';
            if (variant === 'file-directory collision') env.inventory.files[1].path = 'game';
            env.artifact.bytes = env.inventory.files.reduce((sum, file) => sum + file.bytes, 0);
            await env.seal();
            await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
        });
    }
});

test('only the exact private regular-file tree is accepted: no symlinks, hardlinks, special or unlisted entries', async t => {
    const changes = {
        'unlisted file': env => fs.writeFile(path.join(env.artifactDirectory, 'unknown.txt'), 'not inventoried', { mode: 0o600 }),
        'empty directory': env => fs.mkdir(path.join(env.artifactDirectory, 'unknown'), { mode: 0o700 }),
        'private directory': env => fs.mkdir(path.join(env.artifactDirectory, '.git'), { mode: 0o700 }),
        'hard-linked payload': env => fs.link(path.join(env.artifactDirectory, 'index.html'), path.join(env.root, 'external-link')),
        'hard-linked inventory': env => fs.link(env.inventoryFile, path.join(env.root, 'inventory-link')),
        'non-private file': env => makePublic(path.join(env.artifactDirectory, 'index.html')),
        ...(!windows ? { 'executable payload': env => fs.chmod(path.join(env.artifactDirectory, 'index.html'), 0o700) } : {}),
        'non-private directory': env => makePublic(path.join(env.artifactDirectory, 'assets')),
        'non-private root': env => makePublic(env.artifactDirectory),
        'non-private parent': env => makePublic(env.root),
        'payload symlink': async env => {
            await fs.unlink(path.join(env.artifactDirectory, 'index.html'));
            await fs.writeFile(path.join(env.root, 'secret'), 'PRIVATE_SENTINEL');
            await linked(path.join(env.root, 'secret'), path.join(env.artifactDirectory, 'index.html'));
        },
        'inventory symlink': async env => {
            await fs.rename(env.inventoryFile, path.join(env.root, 'inventory'));
            await linked(path.join(env.root, 'inventory'), env.inventoryFile);
        },
        'directory symlink': async env => {
            await fs.rename(path.join(env.artifactDirectory, 'game'), path.join(env.root, 'moved-game'));
            await linked(path.join(env.root, 'moved-game'), path.join(env.artifactDirectory, 'game'), true);
        },
        'root symlink': async env => {
            await fs.rename(env.artifactDirectory, path.join(env.root, 'moved-artifact'));
            await linked(path.join(env.root, 'moved-artifact'), env.artifactDirectory, true);
        },
    };
    for (const [name, change] of Object.entries(changes)) {
        await t.test(name, async t => {
            const env = await fixture(t);
            await change(env);
            await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
        });
    }
    await t.test('Unix socket in place of a listed file', { skip: windows ? 'Unix-domain filesystem socket and procfs are Linux-specific.' : false }, async t => {
        const env = await fixture(t);
        const filename = path.join(env.artifactDirectory, 'index.html');
        await fs.unlink(filename);
        const server = net.createServer();
        // Linux sockaddr_un is short; address the pinned parent via procfs for this fixture.
        const directory = await fs.open(env.artifactDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
        const address = `/proc/self/fd/${directory.fd}/index.html`;
        env.cleanup.push(async () => { await new Promise(resolve => server.close(resolve)); await directory.close(); });
        server.listen(address);
        await once(server, 'listening');
        await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
    });
});

test('GET and HEAD recheck metadata and bytes; post-start mutation never leaks changed or linked contents', async t => {
    const changes = {
        'same-length overwrite and restored mtime': async (env, filename) => {
            const stat = await fs.stat(filename);
            await fs.writeFile(filename, Buffer.alloc(stat.size, 120));
            await fs.utimes(filename, stat.atime, stat.mtime);
        },
        'same-byte inode replacement': async (env, filename) => {
            await fs.rename(filename, path.join(env.root, 'old'));
            await fs.writeFile(filename, env.payload.get('game/main.js'), { mode: 0o600 });
        },
        'file symlink': async (env, filename) => {
            await fs.writeFile(path.join(env.root, 'secret'), 'PRIVATE_SENTINEL', { mode: 0o600 });
            await fs.unlink(filename);
            await linked(path.join(env.root, 'secret'), filename);
        },
        'hard link': (env, filename) => fs.link(filename, path.join(env.root, 'outside')),
        'mode change': (_env, filename) => fs.chmod(filename, 0o400),
        'missing file': (_env, filename) => fs.unlink(filename),
        'renamed directory': async env => {
            await fs.rename(path.join(env.artifactDirectory, 'game'), path.join(env.root, 'game-old'));
            await linked(path.join(env.root, 'game-old'), path.join(env.artifactDirectory, 'game'), true);
        },
        'renamed root': async env => {
            await fs.rename(env.artifactDirectory, path.join(env.root, 'old-artifact'));
            await linked(path.join(env.root, 'old-artifact'), env.artifactDirectory, true);
        },
    };
    for (const [name, change] of Object.entries(changes)) {
        await t.test(name, async t => {
            const env = await fixture(t);
            const { preview } = await env.start();
            const route = new URL('game/main.js', preview.url).pathname;
            assert.equal((await request(preview, { path: route })).status, 200);
            if (windows && name === 'renamed root') {
                // The native lease opens with data access so Windows share
                // accounting denies replacement throughout the preview lifetime.
                await assert.rejects(change(env, path.join(env.artifactDirectory, 'game/main.js')),
                    error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
                assert.equal((await request(preview, { path: route })).status, 200);
                return;
            }
            const mutationDeadline = Date.now() + 3000;
            for (;;) {
                try { await change(env, path.join(env.artifactDirectory, 'game/main.js')); break; }
                catch (error) {
                    // The previous HTTP response can reach the client before its
                    // Windows request leases finish closing. Only that bounded
                    // sharing denial may be retried; other errors still fail.
                    if (!windows || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= mutationDeadline) throw error;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
            }
            for (const method of ['GET', 'HEAD']) {
                const result = await request(preview, { path: route, method });
                assert.equal(result.status, 409);
                assert.equal(result.body.length, 0);
            }
        });
    }
});

test('pinned opens reject an lstat/open symlink swap before reading', async t => {
    const env = await fixture(t);
    await fs.writeFile(path.join(env.root, 'secret'), 'PRIVATE_SENTINEL', { mode: 0o600 });
    const original = promises.open;
    let swapped = false;
    promises.open = async (filename, flags, ...args) => {
        if (isPayloadOpen(filename)) {
            if (!windows) {
                assert.match(filename, /^\/proc\/self\/fd\/\d+\/index\.html$/);
                assert.ok(flags & constants.O_NOFOLLOW);
                assert.ok(flags & constants.O_NONBLOCK);
            }
            swapped = true;
            await fs.unlink(path.join(env.artifactDirectory, 'index.html'));
            await linked(path.join(env.root, 'secret'), path.join(env.artifactDirectory, 'index.html'));
        }
        return original(filename, flags, ...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(env.start(), code('ARTIFACT_INVALID')); }
    finally { promises.open = original; syncBuiltinESMExports(); }
    assert.equal(swapped, true);
});

test('growth during startup or HTTP reads is bounded by the receipt, never readFile or an unbounded stream', async t => {
    for (const phase of ['startup', 'GET', 'HEAD']) {
        await t.test(phase, async t => {
            const env = await fixture(t);
            const service = phase === 'startup' ? undefined : await env.start();
            const original = promises.open;
            const originalReadFile = promises.readFile;
            let totalRead = 0;
            let grew = false;
            promises.readFile = (...args) => {
                // Verifying the immutable Windows host helper is independent of
                // mutable artifact reads, which must remain length-bounded.
                if (typeof args[0] === 'string' && (args[0].startsWith(env.artifactDirectory)
                    || (!windows && args[0].startsWith('/proc/self/fd/')))) throw new Error('Unbounded artifact readFile must not be used');
                return originalReadFile(...args);
            };
            promises.open = async (filename, flags, ...args) => {
                const handle = await original(filename, flags, ...args);
                if (isPayloadOpen(filename) && typeof flags === 'number') {
                    const read = handle.read.bind(handle);
                    handle.read = async (...args) => {
                        const result = await read(...args);
                        totalRead += result.bytesRead;
                        if (!grew) {
                            grew = true;
                            const writer = await original(path.join(env.artifactDirectory, 'index.html'), 'r+');
                            try { await writer.truncate(MAX_ARTIFACT_BYTES * 2); }
                            finally { await writer.close(); }
                        }
                        return result;
                    };
                }
                return handle;
            };
            syncBuiltinESMExports();
            try {
                if (phase === 'startup') await assert.rejects(env.start(), code('INPUT_CHANGED'));
                else {
                    const response = await request(service.preview, { method: phase });
                    assert.equal(response.status, 409);
                    assert.equal(response.body.length, 0);
                }
            } finally { promises.open = original; promises.readFile = originalReadFile; syncBuiltinESMExports(); }
            assert.equal(grew, true);
            assert.ok(totalRead <= env.payload.get('index.html').length + 1);
        });
    }
});

test('input budgets, TTL bounds and authorized directory shape fail closed', async t => {
    const env = await fixture(t);
    for (const ttlSeconds of [0, -1, 7201, 1.5, Infinity, NaN, '1']) {
        await assert.rejects(startPreview({ ...env.options(), ttlSeconds }), code('INVALID_ARGUMENTS'));
    }
    for (const artifactDirectory of [env.root, '.', `${env.artifactDirectory}/`, `${env.root}/../${path.basename(env.root)}/${path.basename(env.artifactDirectory)}`]) {
        await assert.rejects(startPreview({ ...env.options(), artifactDirectory }), code('INVALID_ARGUMENTS'));
    }
    await assert.rejects(startPreview({ ...env.options(), artifact: { ...env.artifact, bytes: MAX_ARTIFACT_BYTES + 1 } }), code('LIMIT_EXCEEDED'));
    await assert.rejects(startPreview({ ...env.options(), artifact: { ...env.artifact, files: 10001 } }), code('LIMIT_EXCEEDED'));
    const inventory = await fs.open(env.inventoryFile, 'r+');
    try { await inventory.truncate(16 * 1024 * 1024 + 1); }
    finally { await inventory.close(); }
    await assert.rejects(env.start(), code('LIMIT_EXCEEDED'));
    await env.seal();
    const payload = await fs.open(path.join(env.artifactDirectory, 'index.html'), 'r+');
    try { await payload.truncate(MAX_ARTIFACT_BYTES * 2); }
    finally { await payload.close(); }
    await assert.rejects(env.start(), code('ARTIFACT_INVALID'));
});

test('declared directory growth is bounded before walking, and unsupported hosts fail closed', async t => {
    const env = await fixture(t);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try { await assert.rejects(env.start(), code('SDK_INCOMPLETE')); }
    finally { Object.defineProperty(process, 'platform', platform); }
    env.inventory.files.push(...Array.from({ length: 9990 }, (_, index) => ({
        path: `d${index}/sub/empty.bin`, bytes: 0, sha256: digest(''),
    })));
    env.artifact.files = env.inventory.files.length;
    await env.seal();
    await assert.rejects(env.start(), code('LIMIT_EXCEEDED'));
});

test('HTTP rehashes the bytes read, not just stat metadata', async t => {
    const env = await fixture(t);
    const { preview } = await env.start();
    const original = promises.open;
    let altered = 0;
    promises.open = async (...args) => {
        const handle = await original(...args);
        if (isPayloadOpen(args[0])) {
            const read = handle.read.bind(handle);
            handle.read = async (...args) => {
                const result = await read(...args);
                if (result.bytesRead) { args[0][args[1]] ^= 1; altered++; }
                return result;
            };
        }
        return handle;
    };
    syncBuiltinESMExports();
    try {
        for (const method of ['GET', 'HEAD']) {
            const response = await request(preview, { method });
            assert.equal(response.status, 409);
            assert.equal(response.body.length, 0);
        }
    } finally { promises.open = original; syncBuiltinESMExports(); }
    assert.equal(altered, 2);
});

test('normal resource bursts wait while file verification stays capped at eight requests', { timeout: 15000 }, async t => {
    const env = await fixture(t);
    const { preview } = await env.start();
    const original = promises.open;
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    let ready;
    const full = new Promise(resolve => { ready = resolve; });
    let readers = 0;
    let reading = 0;
    let maximumReading = 0;
    promises.open = async (...args) => {
        const handle = await original(...args);
        if (isPayloadOpen(args[0])) {
            const read = handle.read.bind(handle);
            handle.read = async (...args) => {
                if (args[3] === 0) {
                    if (++readers === 8) ready();
                    maximumReading = Math.max(maximumReading, ++reading);
                    try { await blocked; }
                    finally { reading--; }
                }
                return read(...args);
            };
        }
        return handle;
    };
    syncBuiltinESMExports();
    const active = Array.from({ length: 8 }, () => request(preview));
    const results = Promise.all(active);
    let queuedResults;
    try {
        await full;
        let finished = 0;
        queuedResults = Promise.all(Array.from({ length: 24 }, () => request(preview).then(response => { finished++; return response; })));
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(finished, 0);
        assert.equal(readers, 8);
        unblock();
        for (const response of await queuedResults) assert.equal(response.status, 200);
        assert.equal(readers, 32);
        assert.equal(maximumReading, 8);
    } finally {
        unblock();
        promises.open = original;
        syncBuiltinESMExports();
        for (const response of await results) assert.equal(response.status, 200);
        await queuedResults;
    }
});

test('aggregate response buffers queue large GETs and retain FIFO order for HEAD', { timeout: 30000 }, async t => {
    const env = await fixture(t, { 'index.html': Buffer.alloc(17 * 1024 * 1024, 120) });
    const { preview } = await env.start();
    const original = promises.open;
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    let ready;
    const full = new Promise(resolve => { ready = resolve; });
    let readers = 0;
    promises.open = async (...args) => {
        const handle = await original(...args);
        if (isPayloadOpen(args[0])) {
            const read = handle.read.bind(handle);
            handle.read = async (...args) => {
                if (args[3] === 0) {
                    if (++readers === 7) ready();
                    await blocked;
                }
                return read(...args);
            };
        }
        return handle;
    };
    syncBuiltinESMExports();
    const active = Promise.all(Array.from({ length: 7 }, () => request(preview)));
    let queued;
    try {
        await full;
        let finished = 0;
        queued = Promise.all(['GET', 'HEAD'].map(method => request(preview, { method }).then(response => { finished++; return response; })));
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(finished, 0);
        assert.equal(readers, 7, 'The eighth large GET exceeds the buffer budget; HEAD waits behind it');
        unblock();
        const [get, head] = await queued;
        assert.equal(get.status, 200);
        assert.deepEqual(get.body, env.payload.get('index.html'));
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
        assert.equal(readers, 9);
    } finally {
        unblock();
        await active;
        await queued;
        promises.open = original;
        syncBuiltinESMExports();
    }
});

test('queued preview requests release their place on disconnect, expiry and server close', { timeout: 30000 }, async t => {
    for (const mode of ['disconnect', 'expiry', 'close']) {
        await t.test(mode, async t => {
            const env = await fixture(t);
            const service = await env.start();
            const original = promises.open;
            let unblock;
            const blocked = new Promise(resolve => { unblock = resolve; });
            let ready;
            const full = new Promise(resolve => { ready = resolve; });
            let readers = 0;
            promises.open = async (...args) => {
                const handle = await original(...args);
                if (isPayloadOpen(args[0])) {
                    const read = handle.read.bind(handle);
                    handle.read = async (...args) => {
                        if (args[3] === 0) {
                            if (++readers === 8) ready();
                            await blocked;
                        }
                        return read(...args);
                    };
                }
                return handle;
            };
            syncBuiltinESMExports();
            const active = Promise.all(Array.from({ length: 8 }, () => request(service.preview).catch(error => ({ error }))));
            let closing;
            try {
                await full;
                const socket = await idleSocket(env, service.preview);
                const url = new URL(service.preview.url);
                const disconnected = new Promise(resolve => socket.once('close', resolve));
                socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
                await new Promise(resolve => setTimeout(resolve, 100));
                assert.equal(readers, 8);
                const began = Date.now();
                if (mode === 'disconnect') socket.destroy();
                if (mode === 'close') closing = service.close();
                await disconnected;
                assert.ok(Date.now() - began < 6500, 'Queued requests retain the five-second budget');
                // Let the server observe the close before any reader can finish.
                await new Promise(resolve => setTimeout(resolve, 50));
                unblock();
                await active;
                await closing;
                assert.equal(readers, 8, 'Cancelled requests must never open an artifact file');
                if (mode !== 'close') assert.equal((await request(service.preview)).status, 200);
            } finally {
                unblock();
                await active;
                await closing;
                promises.open = original;
                syncBuiltinESMExports();
            }
        });
    }
});

test('header sizes/counts and simultaneous connections are bounded', { timeout: 10000 }, async t => {
    const env = await fixture(t);
    const { preview } = await env.start();
    const url = new URL(preview.url);
    const start = `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n`;
    assert.equal(await rawRequest(preview, `${start}X-Large: ${'x'.repeat(9000)}\r\n\r\n`), '');
    const manyHeaders = Array.from({ length: 33 }, (_, i) => `X-${i}: x\r\n`).join('');
    assert.match(await rawRequest(preview, `${start}${manyHeaders}\r\n`), /^HTTP\/1\.1 431/);
    const sockets = [];
    for (let index = 0; index < 32; index++) sockets.push(await idleSocket(env, preview));
    const extra = await idleSocket(env, preview);
    await new Promise(resolve => { if (extra.destroyed) resolve(); else extra.once('close', resolve); });
    assert.equal(extra.destroyed, true);
    for (const socket of sockets) socket.destroy();
});

test('incomplete HTTP headers time out without waiting for preview TTL', { timeout: 10000 }, async t => {
    const env = await fixture(t);
    const { preview } = await env.start(60);
    const socket = await idleSocket(env, preview);
    const began = Date.now();
    const disconnected = new Promise(resolve => socket.once('close', resolve));
    socket.write(`GET ${new URL(preview.url).pathname} HTTP/1.1\r\n`);
    await disconnected;
    assert.ok(Date.now() - began < 7500);
    assert.equal((await request(preview)).status, 200);
});

test('TTL expiry and idempotent explicit close resolve closed and destroy active sockets', { timeout: 6000 }, async t => {
    for (const mode of ['ttl', 'explicit']) {
        await t.test(mode, async t => {
            const env = await fixture(t);
            const service = await env.start(mode === 'ttl' ? 1 : 7200);
            const socket = await idleSocket(env, service.preview);
            socket.write('GET / HTTP/1.1\r\n');
            const disconnected = new Promise(resolve => socket.once('close', resolve));
            let closed = false;
            service.closed.then(() => { closed = true; });
            assert.equal(closed, false);
            const began = Date.now();
            if (mode === 'explicit') await Promise.all([service.close(), service.close()]);
            await service.closed;
            await disconnected;
            assert.equal(closed, true);
            assert.ok(Date.now() - began < 2500);
            assert.equal(socket.destroyed, true);
            await service.close();
            await assert.rejects(request(service.preview), error => error.code === 'ECONNREFUSED');
        });
    }
});

test('terminating the owning worker kills the real HTTP listener and established sockets', { timeout: 10000 }, async t => {
    const env = await fixture(t);
    const source = `import { parentPort, workerData } from 'node:worker_threads';
        const { startPreview } = await import(workerData.module);
        const service = await startPreview(workerData.options);
        parentPort.postMessage(service.preview);
        await service.closed;
        parentPort.close();`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
        workerData: { module: moduleUrl.href, options: env.options() }, execArgv: [], stdout: true, stderr: true,
    });
    env.cleanup.push(() => worker.terminate());
    let output = '';
    worker.stdout.on('data', bytes => { output += bytes; });
    worker.stderr.on('data', bytes => { output += bytes; });
    const [preview] = await once(worker, 'message');
    assert.equal((await request(preview)).status, 200);
    const socket = await idleSocket(env, preview);
    socket.write(`GET ${new URL(preview.url).pathname} HTTP/1.1\r\n`);
    const disconnected = new Promise(resolve => socket.once('close', resolve));
    await worker.terminate();
    await disconnected;
    assert.equal(socket.destroyed, true);
    await assert.rejects(request(preview), error => error.code === 'ECONNREFUSED');
    assert.equal(output, '');
});

test('retained artifact parent paths support Unicode and spaces without URL or shell conversion', async t => {
    const env = await fixture(t, {}, 'cocos4-preview-中文 space-');
    const { preview } = await env.start();
    const result = await request(preview, { path: new URL('game/main.js', preview.url).pathname });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, env.payload.get('game/main.js'));
    if (windows) {
        const service = await startPreview({ ...env.options(), artifactDirectory: env.artifactDirectory.toLowerCase() });
        env.cleanup.push(() => service.close());
        assert.deepEqual((await request(service.preview)).body, env.payload.get('index.html'));
    }
});

test('explicit host Chromium loads retained files and runs browser input through the private loopback route',
    { skip: !process.env.COCOS4_PREVIEW_BROWSER, timeout: 60000 }, async t => {
        const env = await fixture(t, {
            'index.html': '<!doctype html><meta charset="utf-8"><button id="advance">Advance</button><output id="count">0</output><canvas width="40" height="40"></canvas><script src="boot.js"></script>',
            'boot.js': 'const canvas = document.querySelector("canvas"); const ctx = canvas.getContext("2d"); ctx.fillStyle = "rgb(24, 176, 96)"; ctx.fillRect(0, 0, 40, 40); document.querySelector("button").onclick = () => { document.querySelector("output").textContent = String(Number(document.querySelector("output").textContent) + 1); };',
        }, 'cocos4-preview-浏览器 space-');
        const { preview } = await env.start();
        const require = createRequire(new URL('../runtime/package.json', import.meta.url));
        const { chromium } = require('playwright-core');
        const browser = await chromium.launch({ executablePath: process.env.COCOS4_PREVIEW_BROWSER, headless: true });
        try {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(String(error)));
            assert.equal((await page.goto(preview.url)).status(), 200);
            await page.locator('#advance').click();
            assert.equal(await page.locator('#count').textContent(), '1');
            assert.deepEqual(await page.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data]), [24, 176, 96, 255]);
            assert.deepEqual(errors, []);
            t.diagnostic(`Real ${browser.version()} verified HTTP loading, relative JavaScript, canvas pixels and input. This is preview-server evidence, not engine or vendor-device rendering acceptance.`);
        } finally { await browser.close(); }
    });
