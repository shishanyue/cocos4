import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { exportAndroid, validateConfig, verifyAndroidProject } from '../android/export-apk.mjs';
import { buildDirect } from '../android/direct-build.mjs';
import { hostRuntimeJava, hostWebSocketJava } from '../android/hosting.mjs';
import { androidProjectFiles } from '../android/templates.mjs';

const run = promisify(execFile);
const root = process.env.COCOS4_ANDROID_TEST_WORK_ROOT ? path.resolve(process.env.COCOS4_ANDROID_TEST_WORK_ROOT) : path.resolve(fileURLToPath(new URL('../build/android-hosting-tests/', import.meta.url)));
const base = { appId: 'org.cocos4.hosting', appName: 'Hosting fixture', backendUrl: 'https://game.example:7443' };
const lanConfig = { ...base, backendUrl: 'http://192.168.1.25:3000', hostingMode: 'lan-host', allowCleartext: true, configGlobal: '__SP_CLIENT_CONFIG__' };

async function caseDirectory(t) {
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'case-'));
    t.after(async () => {
        assert.equal(path.dirname(directory), root);
        await fs.rm(directory, { recursive: true, force: true });
    });
    return directory;
}

async function webFixture(t, content = '<!doctype html><html><body>hosting fixture</body></html>') {
    const directory = await caseDirectory(t);
    const input = path.join(directory, 'web');
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, 'index.html'), content);
    return { directory, input };
}

async function adapterFixture(t) {
    const directory = await caseDirectory(t);
    const adapter = path.join(directory, 'adapter');
    await fs.mkdir(path.join(adapter, 'data'), { recursive: true });
    await fs.writeFile(path.join(adapter, 'index.html'), '<!doctype html><html><body><script type="module" src="adapter.mjs"></script></body></html>');
    await fs.writeFile(path.join(adapter, 'adapter.mjs'), 'export const adapter = true;\n');
    await fs.writeFile(path.join(adapter, 'data', 'rooms.json'), '{"rooms":[]}\n');
    return { directory, adapter };
}

test('connect-only omits every hosting asset, Java class and manifest component', async t => {
    const { directory, input } = await webFixture(t);
    const { adapter } = await adapterFixture(t);
    const output = path.join(directory, 'project');
    const result = await exportAndroid({ input, output, config: { ...base } });
    assert.equal(result.hostingMode, 'connect-only');
    assert.equal(result.hostingAdapter, null);
    const receipt = JSON.parse(await fs.readFile(result.receipt, 'utf8'));
    assert.deepEqual(receipt.hosting, { mode: 'connect-only' });
    assert.ok(!receipt.files.some(item => item.path.includes('__cocos4_host')), 'connect-only packaged adapter assets');
    assert.ok(!receipt.files.some(item => /HostRuntime\.java$|HostWebSocket\.java$/.test(item.path)), 'connect-only packaged host Java');
    const activity = await fs.readFile(path.join(output, 'app/src/main/java/org/cocos4/hosting/MainActivity.java'), 'utf8');
    assert.ok(!activity.includes('HostRuntime'), 'connect-only activity references host runtime');
    const manifest = await fs.readFile(path.join(output, 'app/src/main/AndroidManifest.xml'), 'utf8');
    assert.ok(!manifest.includes('__cocos4_host'), 'connect-only manifest exposes host entry');
    assert.equal((await verifyAndroidProject(output)).success, true);
    await assert.rejects(exportAndroid({
        input, output: path.join(directory, 'rejected'), config: { ...base }, hostingDir: adapter,
    }), { code: 'HOSTING_ADAPTER_UNEXPECTED' });
    await assert.rejects(fs.stat(path.join(directory, 'rejected')), { code: 'ENOENT' });
});

test('lan-host packages the adapter and real Java transport while preserving client assets', async t => {
    const { directory, input } = await webFixture(t);
    const { adapter } = await adapterFixture(t);
    const output = path.join(directory, 'project');
    const result = await exportAndroid({ input, output, config: lanConfig, hostingDir: adapter });
    assert.equal(result.hostingMode, 'lan-host');
    const receipt = JSON.parse(await fs.readFile(result.receipt, 'utf8'));
    assert.equal(receipt.hosting.mode, 'lan-host');
    assert.equal(receipt.hosting.adapter.entry, '__cocos4_host/index.html');
    assert.deepEqual(receipt.hosting.adapter.files, ['adapter.mjs', 'data/rooms.json', 'index.html']);
    assert.deepEqual(receipt.hosting.bridge, { java: 'Cocos4Host', adapter: '__COCOS4_HOST_ADAPTER__', controlBase: '/__cocos4/host' });
    assert.equal(receipt.config.dynamicBackend, true, 'lan-host must always export the dynamic shell backend so a reload keeps the saved local endpoint');
    const hostingFiles = receipt.files.filter(item => item.path.startsWith('app/src/main/assets/www/__cocos4_host/'));
    assert.deepEqual(hostingFiles.map(item => item.path).sort(), [
        'app/src/main/assets/www/__cocos4_host/adapter.mjs',
        'app/src/main/assets/www/__cocos4_host/data/rooms.json',
        'app/src/main/assets/www/__cocos4_host/index.html',
    ]);
    assert.equal(await fs.readFile(path.join(output, 'app/src/main/assets/www/__cocos4_host/index.html'), 'utf8'),
        await fs.readFile(path.join(adapter, 'index.html'), 'utf8'));
    const javaRoot = path.join(output, 'app/src/main/java/org/cocos4/hosting');
    const socket = await fs.readFile(path.join(javaRoot, 'HostWebSocket.java'), 'utf8');
    const runtime = await fs.readFile(path.join(javaRoot, 'HostRuntime.java'), 'utf8');
    assert.match(socket, /class HostWebSocket/);
    assert.match(runtime, /class HostRuntime/);
    assert.match(runtime, /addJavascriptInterface\(new Bridge\(\), "Cocos4Host"\)/);
    assert.match(runtime, /__COCOS4_HOST_ADAPTER__/);
    assert.match(runtime, /\/__cocos4\/host\//);
    const localClient = await fs.readFile(path.join(javaRoot, 'LocalAssetClient.java'), 'utf8');
    assert.match(localClient, /class BackendSettings/);
    assert.match(localClient, /\"\/__cocos4\/backend\"\.equals\(localPath\)/);
    assert.match(localClient, /backendSettings\.configScript\(CONFIG_GLOBAL\)/);
    const activity = await fs.readFile(path.join(javaRoot, 'MainActivity.java'), 'utf8');
    assert.match(activity, /new HostRuntime\.Controller\(this, getAssets\(\), root\)/);
    assert.match(activity, /new LocalAssetClient\(getAssets\(\), getSharedPreferences\("cocos4-shell", MODE_PRIVATE\), hostController\)/);
    assert.equal((await verifyAndroidProject(output)).success, true);
    await assert.rejects(exportAndroid({ input, output: path.join(directory, 'missing'), config: lanConfig }), { code: 'HOSTING_ADAPTER_REQUIRED' });
    const noEntry = path.join(directory, 'no-entry');
    await fs.mkdir(noEntry);
    await fs.writeFile(path.join(noEntry, 'other.html'), '<!doctype html>');
    await assert.rejects(exportAndroid({ input, output: path.join(directory, 'no-entry-out'), config: lanConfig, hostingDir: noEntry }), { code: 'HOSTING_ENTRY_MISSING' });
    const native = path.join(directory, 'native');
    await fs.mkdir(native);
    await fs.writeFile(path.join(native, 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(native, 'libhost.so'), 'binary');
    await assert.rejects(exportAndroid({ input, output: path.join(directory, 'native-out'), config: lanConfig, hostingDir: native }), { code: 'HOSTING_ASSET_INVALID' });
    await assert.rejects(fs.stat(path.join(directory, 'native-out')), { code: 'ENOENT' });
});

// ---- Raw RFC 6455 client used against the generated Java transport -------------------------------

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function socketReader(socket) {
    const iterator = socket[Symbol.asyncIterator]();
    let buffered = Buffer.alloc(0);
    let finished = false;
    return {
        async take(count) {
            while (buffered.length < count) {
                if (finished) throw new Error(`socket closed with ${buffered.length}/${count} bytes`);
                const next = await iterator.next();
                if (next.done) { finished = true; continue; }
                buffered = buffered.length ? Buffer.concat([buffered, next.value]) : next.value;
            }
            const slice = Buffer.from(buffered.subarray(0, count));
            buffered = buffered.subarray(count);
            return slice;
        },
    };
}

async function readUntil(reader, marker, limit = 65536) {
    const bytes = [];
    while (bytes.length < limit) {
        const byte = await reader.take(1);
        bytes.push(byte[0]);
        if (bytes.length >= marker.length && Buffer.from(bytes.slice(-marker.length)).toString('latin1') === marker) break;
    }
    return Buffer.from(bytes).toString('latin1');
}

async function readRest(reader) {
    const chunks = [];
    try {
        for (;;) chunks.push(await reader.take(1));
    } catch {
        return Buffer.concat(chunks).toString('utf8');
    }
}

function clientFrame(opcode, payload = Buffer.alloc(0), options = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const fin = options.fin !== false;
    const masked = options.mask !== false;
    const rsv = options.rsv ?? 0;
    const first = (fin ? 0x80 : 0) | ((rsv & 0x7) << 4) | (opcode & 0x0f);
    const mode = options.lengthMode ?? 'auto';
    let header;
    if (mode === 126 || (mode === 'auto' && data.length > 125 && data.length <= 0xffff)) {
        header = Buffer.from([first, (masked ? 0x80 : 0) | 126, (data.length >> 8) & 0xff, data.length & 0xff]);
    } else if (mode === 127 || (mode === 'auto' && data.length > 0xffff)) {
        const wide = Buffer.alloc(8);
        wide.writeBigUInt64BE(BigInt(data.length));
        header = Buffer.concat([Buffer.from([first, (masked ? 0x80 : 0) | 127]), wide]);
    } else {
        header = Buffer.from([first, (masked ? 0x80 : 0) | data.length]);
    }
    if (!masked) return Buffer.concat([header, data]);
    const key = Buffer.from([0x21, 0x43, 0x65, 0x87]);
    const maskedData = Buffer.alloc(data.length);
    for (let index = 0; index < data.length; index++) maskedData[index] = data[index] ^ key[index & 3];
    return Buffer.concat([header, key, maskedData]);
}

async function readServerFrame(reader) {
    const header = await reader.take(2);
    assert.equal(header[1] & 0x80, 0, 'server frames must stay unmasked');
    const fin = (header[0] & 0x80) !== 0;
    const opcode = header[0] & 0x0f;
    let length = header[1] & 0x7f;
    if (length === 126) length = (await reader.take(2)).readUInt16BE(0);
    else if (length === 127) length = Number((await reader.take(8)).readBigUInt64BE(0));
    const payload = length ? await reader.take(length) : Buffer.alloc(0);
    return { fin, opcode, payload };
}

async function connectTcp(port) {
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    return socket;
}

async function upgrade(port, { target: requestTarget = '/ws', origin = null, version = '13', key = createHash('sha1').update(String(Math.random())).digest('base64').slice(0, 22) + '==' } = {}) {
    const socket = await connectTcp(port);
    const reader = socketReader(socket);
    const lines = [
        `GET ${requestTarget} HTTP/1.1`,
        'Host: 127.0.0.1:' + port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
    ];
    if (version !== null) lines.push(`Sec-WebSocket-Version: ${version}`);
    if (origin !== null) lines.push(`Origin: ${origin}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    const head = await readUntil(reader, '\r\n\r\n');
    return { socket, reader, head, key };
}

function assertUpgrade(head, key) {
    assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/);
    const expected = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    assert.match(head, new RegExp(`sec-websocket-accept: ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
}

async function expectClose(reader, code) {
    const frame = await readServerFrame(reader);
    assert.equal(frame.opcode, 0x8, `expected close frame, received opcode ${frame.opcode}`);
    assert.ok(frame.payload.length >= 2, 'close frame without status code');
    assert.equal(frame.payload.readUInt16BE(0), code);
    return frame;
}

function startHarness(java, classes, mainClass, args = []) {
    const child = spawn(java, ['-Djava.io.tmpdir=' + classes, '-cp', classes, mainClass, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: classes, TMP: classes, TMPDIR: classes },
    });
    const lines = [];
    const errors = [];
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buffered += chunk;
        for (let at; (at = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(at + 1)) lines.push(buffered.slice(0, at).replace(/\r$/, ''));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => errors.push(chunk));
    return {
        child, lines, errors,
        async waitFor(pattern, timeout = 15000, from = 0) {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const found = lines.slice(from).find(line => pattern.test(line));
                if (found !== undefined) return found;
                if (child.exitCode !== null) throw new Error(`harness exited ${child.exitCode}: ${errors.join('')}\n${lines.join('\n')}`);
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            throw new Error(`timed out waiting for ${pattern}:\n${lines.join('\n')}\n${errors.join('')}`);
        },
        async stop() {
            if (child.exitCode === null) {
                child.stdin.write('exit\n');
                await new Promise(resolve => child.once('exit', resolve));
            }
        },
    };
}

const javaHome = process.env.COCOS4_ANDROID_TEST_JAVA_HOME ?? process.env.JAVA_HOME;
const javaSuffix = process.platform === 'win32' ? '.exe' : '';
const javaBin = name => path.join(javaHome ?? '', 'bin', `${name}${javaSuffix}`);
const hasJdk = Boolean(javaHome) && await fs.access(javaBin('javac')).then(() => true, () => false);

const harnessSource = String.raw`package com.cocos4.hostingtest;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public final class HostHarness {
    private static final java.io.PrintStream OUT;
    static {
        try { OUT = new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8"); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new ExceptionInInitializerError(impossible); }
    }
    private static volatile boolean ready = true;
    private static volatile HostWebSocket.Server server;

    public static void main(String[] args) throws Exception {
        ready = args.length == 0 || !"not-ready".equals(args[0]);
        server = new HostWebSocket.Server();
        server.start(0, "127.0.0.1", "/ws", new HostWebSocket.Events() {
            @Override public boolean ready() { return ready; }
            @Override public void connect(HostWebSocket.Connection connection) {
                print("connect " + connection.id + " origin=" + connection.origin + " host=" + connection.host
                        + " path=" + connection.path + " query=" + connection.query);
            }
            @Override public void message(HostWebSocket.Connection connection, String type, String data, int bytes) {
                print("message " + type + " " + data + " " + bytes);
            }
            @Override public void close(HostWebSocket.Connection connection) { print("close " + connection.id); }
            @Override public void error(String message) { print("error " + message); }
        });
        print("PORT " + server.port());
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = input.readLine()) != null) {
            if (line.startsWith("ping ")) {
                server.ping(line.substring(5).trim());
                print("OK ping");
            } else if (line.equals("exit")) {
                break;
            }
        }
        server.close();
        System.exit(0);
    }

    private static synchronized void print(String value) {
        OUT.println(value);
        OUT.flush();
    }
}
`;

test('generated HostWebSocket compiles and serves raw RFC 6455 traffic with real pong forwarding', {
    skip: !hasJdk && 'Set COCOS4_ANDROID_TEST_JAVA_HOME or JAVA_HOME for the desktop-JVM transport check.',
}, async t => {
    const directory = await caseDirectory(t);
    const sources = path.join(directory, 'sources');
    const classes = path.join(directory, 'classes');
    const javaPackage = path.join(sources, 'com', 'cocos4', 'hostingtest');
    await fs.mkdir(javaPackage, { recursive: true });
    await fs.mkdir(classes);
    await fs.writeFile(path.join(javaPackage, 'HostWebSocket.java'), hostWebSocketJava('com.cocos4.hostingtest'));
    await fs.writeFile(path.join(javaPackage, 'HostHarness.java'), harnessSource);
    const environment = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
    await run(javaBin('javac'), ['-J-Djava.io.tmpdir=' + directory, '--release', '8', '-encoding', 'UTF-8', '-d', classes,
        path.join(javaPackage, 'HostWebSocket.java'), path.join(javaPackage, 'HostHarness.java')], { cwd: directory, env: environment });

    const harness = startHarness(javaBin('java'), classes, 'com.cocos4.hostingtest.HostHarness');
    t.after(() => { if (harness.child.exitCode === null) harness.child.kill(); });
    const port = Number(/^PORT (\d+)$/.exec(await harness.waitFor(/^PORT \d+$/))[1]);

    const health = await upgrade(port, { target: '/healthz' });
    const healthBody = await readRest(health.reader);
    assert.match(health.head, /^HTTP\/1\.1 200 OK/);
    assert.match(healthBody, /"cocos4AndroidHost":true/);
    health.socket.destroy();

    const missing = await upgrade(port, { target: '/other' });
    assert.match(missing.head, /^HTTP\/1\.1 404 Not Found/);
    missing.socket.destroy();

    const badPath = await upgrade(port, { target: '/nope' });
    assert.match(badPath.head, /^HTTP\/1\.1 404 Not Found/);
    badPath.socket.destroy();

    const client = await upgrade(port, { target: '/ws?room=alpha', origin: 'http://192.168.1.42:8080' });
    assertUpgrade(client.head, client.key);
    const connectLine = await harness.waitFor(/^connect c_[0-9a-f]+ origin=.*$/);
    const connectionId = /^connect (c_[0-9a-f]+) /.exec(connectLine)[1];
    assert.match(connectLine, /origin=http:\/\/192\.168\.1\.42:8080/);
    assert.match(connectLine, /host=127\.0\.0\.1:\d+/);
    assert.match(connectLine, /path=\/ws/);
    assert.match(connectLine, /query=room=alpha/);

    client.socket.write(clientFrame(0x1, 'hello-adapter'));
    await harness.waitFor(/^message text hello-adapter 13$/);

    // Legal fragmentation: a multi-byte UTF-8 character split across a non-final frame and a
    // continuation frame must still decode as one text message.
    const split = Buffer.from('中', 'utf8');
    client.socket.write(clientFrame(0x1, split.subarray(0, 1), { fin: false }));
    client.socket.write(clientFrame(0x0, Buffer.concat([split.subarray(1), Buffer.from('文')])));
    await harness.waitFor(/^message text 中文 6$/);

    client.socket.write(clientFrame(0x9, 'peer-ping'));
    const protocolPong = await readServerFrame(client.reader);
    assert.equal(protocolPong.opcode, 0xA);
    assert.equal(protocolPong.payload.toString(), 'peer-ping');

    harness.child.stdin.write(`ping ${connectionId}\n`);
    const adapterPing = await readServerFrame(client.reader);
    assert.equal(adapterPing.opcode, 0x9, 'Cocos4Host.ping must send a real ping frame');
    assert.ok(adapterPing.payload.length > 0, 'adapter probe ping must carry an echoable payload');
    await harness.waitFor(/^OK ping$/);
    client.socket.write(clientFrame(0xA, adapterPing.payload));
    const forwarded = await harness.waitFor(/^message pong \S+ \d+$/);
    const [, forwardedData, forwardedBytes] = /^message pong (\S+) (\d+)$/.exec(forwarded);
    assert.equal(forwardedData, adapterPing.payload.toString('base64'), 'forwarded pong must be the real echoed payload');
    assert.equal(Number(forwardedBytes), adapterPing.payload.length);

    client.socket.write(clientFrame(0x8, Buffer.concat([Buffer.from([0x03, 0xE8]), Buffer.from('bye')])));
    const closeEcho = await expectClose(client.reader, 1000);
    assert.equal(closeEcho.payload.subarray(2).toString(), 'bye');
    await harness.waitFor(new RegExp(`^close ${connectionId}$`));
    client.socket.destroy();

    const malformed = [
        { label: 'unmasked client frame', frame: clientFrame(0x1, 'x', { mask: false }), code: 1002 },
        { label: 'non-canonical 16-bit length', frame: clientFrame(0x1, 'abcde', { lengthMode: 126 }), code: 1002 },
        { label: 'non-canonical 64-bit length', frame: clientFrame(0x1, Buffer.alloc(100, 0x61), { lengthMode: 127 }), code: 1002 },
        { label: 'reserved bits', frame: clientFrame(0x1, 'x', { rsv: 1 }), code: 1002 },
        { label: 'new data frame during fragmented message', code: 1002, sequence: [clientFrame(0x1, 'a', { fin: false }), clientFrame(0x1, 'b')] },
        { label: 'invalid UTF-8 text', frame: clientFrame(0x1, Buffer.from([0xc3, 0x28])), code: 1007 },
        { label: 'oversized message', frame: clientFrame(0x1, Buffer.alloc(65537, 0x61), { lengthMode: 127 }), code: 1009 },
        { label: 'invalid close code 1005', frame: clientFrame(0x8, Buffer.from([0x03, 0xed])), code: 1002 },
        { label: '64-bit length with high bit set', frame: Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 1, 0x21, 0x43, 0x65, 0x87]), code: 1002 },
        { label: 'fragmented message exceeding 64 KiB', code: 1009, sequence: [clientFrame(0x1, Buffer.alloc(65535, 0x61), { fin: false }), clientFrame(0x0, Buffer.alloc(200, 0x62))] },
        { label: 'one-byte close payload', frame: clientFrame(0x8, Buffer.from([0x03])), code: 1002 },
        { label: 'unexpected continuation frame', frame: clientFrame(0x0, 'tail'), code: 1002 },
    ];
    for (const item of malformed) {
        const from = harness.lines.length;
        const probe = await upgrade(port, { target: '/ws', origin: 'http://192.168.1.42:8080' });
        assertUpgrade(probe.head, probe.key);
        const connect = await harness.waitFor(/^connect c_[0-9a-f]+ /, 15000, from);
        const id = /^connect (c_[0-9a-f]+) /.exec(connect)[1];
        for (const frame of item.sequence ?? [item.frame]) probe.socket.write(frame);
        await expectClose(probe.reader, item.code);
        await harness.waitFor(new RegExp(`^close ${id}$`), 15000, from);
        probe.socket.destroy();
    }

    const badKey = await upgrade(port, { target: '/ws', key: Buffer.alloc(15).toString('base64') });
    assert.match(badKey.head, /^HTTP\/1\.1 400 Bad Request/);
    assert.match(await readRest(badKey.reader), /WEBSOCKET_REQUIRED/);
    badKey.socket.destroy();

    const noVersion = await upgrade(port, { target: '/ws', version: null });
    assert.match(noVersion.head, /^HTTP\/1\.1 400 Bad Request/);
    noVersion.socket.destroy();

    const post = await connectTcp(port);
    const postReader = socketReader(post);
    post.write('POST /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n');
    const postHead = await readUntil(postReader, '\r\n\r\n');
    assert.match(postHead, /^HTTP\/1\.1 405 Method Not Allowed/);
    assert.match(await readRest(postReader), /METHOD_NOT_ALLOWED/);
    post.destroy();

    const offline = startHarness(javaBin('java'), classes, 'com.cocos4.hostingtest.HostHarness', ['not-ready']);
    t.after(() => { if (offline.child.exitCode === null) offline.child.kill(); });
    const offlinePort = Number(/^PORT (\d+)$/.exec(await offline.waitFor(/^PORT \d+$/))[1]);
    const rejected = await upgrade(offlinePort, { target: '/ws' });
    assert.match(rejected.head, /^HTTP\/1\.1 503 Service Unavailable/);
    assert.match(await readRest(rejected.reader), /BACKEND_NOT_READY/);
    rejected.socket.destroy();
    await offline.stop();

    await harness.stop();
    await assert.rejects(connectTcp(port), /ECONNREFUSED/);
});

async function discoverAndroidJar(sdk) {
    if (!sdk) return null;
    const platforms = path.join(sdk, 'platforms');
    const entries = await fs.readdir(platforms).catch(() => []);
    const candidates = entries.filter(name => /^android-\d+$/.test(name)).sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)));
    for (const name of candidates) {
        const candidate = path.join(platforms, name, 'android.jar');
        if (await fs.access(candidate).then(() => true, () => false)) return candidate;
    }
    return null;
}

const androidSdk = process.env.COCOS4_ANDROID_TEST_SDK;
const androidJar = process.env.COCOS4_ANDROID_TEST_ANDROID_JAR ?? await discoverAndroidJar(androidSdk);

test('lan-host Java compiles against the Android SDK and exposes the exact bridge contract', {
    skip: !(hasJdk && androidJar) && 'Set COCOS4_ANDROID_TEST_JAVA_HOME and COCOS4_ANDROID_TEST_SDK (or COCOS4_ANDROID_TEST_ANDROID_JAR) for the Android SDK compile check.',
}, async t => {
    const directory = await caseDirectory(t);
    const sources = path.join(directory, 'src');
    const classes = path.join(directory, 'classes');
    await fs.mkdir(classes);
    const javaFiles = [];
    for (const [name, source] of androidProjectFiles(validateConfig(lanConfig))) {
        if (!name.endsWith('.java')) continue;
        const destination = path.join(sources, name.replace(/^app\/src\/main\/java\//, ''));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, source);
        javaFiles.push(destination);
    }
    const buildConfig = path.join(sources, 'org', 'cocos4', 'hosting', 'BuildConfig.java');
    await fs.writeFile(buildConfig, 'package org.cocos4.hosting; public final class BuildConfig { public static final boolean DEBUG = true; }');
    javaFiles.push(buildConfig);
    const environment = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
    await run(javaBin('javac'), ['-J-Djava.io.tmpdir=' + directory, '--release', '8', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes, ...javaFiles],
        { cwd: directory, env: environment });
    const bridge = await run(javaBin('javap'), ['-classpath', classes, 'org.cocos4.hosting.HostRuntime$Controller$Bridge']);
    for (const method of ['ready', 'setState', 'sendText', 'sendBinary', 'close', 'ping', 'log']) {
        assert.match(bridge.stdout, new RegExp(`\\b${method}\\(`), `bridge is missing ${method}`);
    }
    const controller = await run(javaBin('javap'), ['-classpath', classes, 'org.cocos4.hosting.HostRuntime$Controller']);
    for (const method of ['handleControl', 'destroy']) assert.match(controller.stdout, new RegExp(`\\b${method}\\(`), `controller is missing ${method}`);
    const events = await run(javaBin('javap'), ['-classpath', classes, 'org.cocos4.hosting.HostWebSocket$Events']);
    assert.match(events.stdout, /\bmessage\(/, 'events interface is missing message');
});

test('real lan-host APK builds with the packaged adapter and host Java transport', {
    skip: !(hasJdk && androidSdk && androidJar) && 'Set COCOS4_ANDROID_TEST_JAVA_HOME and COCOS4_ANDROID_TEST_SDK for the real APK build.',
}, async t => {
    const { directory, input } = await webFixture(t);
    const { adapter } = await adapterFixture(t);
    const project = path.join(directory, 'project');
    await exportAndroid({ input, output: project, config: lanConfig, hostingDir: adapter });
    const built = await buildDirect({ project, sdk: androidSdk, javaHome, work: path.join(directory, 'work'),
        platform: Number(process.env.COCOS4_ANDROID_TEST_PLATFORM ?? 36), buildTools: process.env.COCOS4_ANDROID_TEST_BUILD_TOOLS ?? '36.0.0' });
    assert.equal(built.success, true, JSON.stringify(built));
    assert.equal(built.signed, true);
    assert.ok(built.steps.some(step => step.name === 'Compile Java shell' && step.success), 'host Java did not compile');
    assert.ok(built.steps.some(step => step.name === 'Verify APK signature' && step.success));
    assert.equal(built.deviceTested, false);
    assert.equal((await verifyAndroidProject(project)).success, true);
});

// ---- Desktop stub harness: executes the generated control/settings Java logic --------------------

const stubAndroidSources = {
    'android/content/Context.java': String.raw`package android.content;
public class Context { }
`,
    'android/app/Activity.java': String.raw`package android.app;
public class Activity extends android.content.Context { }
`,
    'android/content/SharedPreferences.java': String.raw`package android.content;

public interface SharedPreferences {
    String getString(String key, String fallback);
    Editor edit();
    interface Editor {
        Editor putString(String key, String value);
        Editor remove(String key);
        boolean commit();
    }
}
`,
    'android/content/res/AssetFileDescriptor.java': String.raw`package android.content.res;

import java.io.Closeable;

public class AssetFileDescriptor implements Closeable {
    private final long length;
    public AssetFileDescriptor(long length) { this.length = length; }
    public long getLength() { return length; }
    @Override public void close() { }
}
`,
    'android/content/res/AssetManager.java': String.raw`package android.content.res;

import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class AssetManager {
    public static final int ACCESS_STREAMING = 1;
    private final Map<String, byte[]> files = new HashMap<String, byte[]>();
    public void put(String name, byte[] bytes) { files.put(name, bytes); }
    public InputStream open(String name, int mode) throws IOException {
        byte[] bytes = files.get(name);
        if (bytes == null) throw new FileNotFoundException(name);
        return new ByteArrayInputStream(bytes);
    }
    public AssetFileDescriptor openFd(String name) throws IOException {
        byte[] bytes = files.get(name);
        if (bytes == null) throw new FileNotFoundException(name);
        return new AssetFileDescriptor(bytes.length);
    }
}
`,
    'android/graphics/Color.java': String.raw`package android.graphics;

public class Color { public static final int TRANSPARENT = 0; }
`,
    'android/net/Uri.java': String.raw`package android.net;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URLDecoder;

public class Uri {
    private final String raw;
    private final URI uri;

    private Uri(String raw) { this.raw = raw; this.uri = URI.create(raw); }

    public static Uri parse(String value) { return new Uri(value); }
    public String getScheme() { return uri.getScheme(); }
    public String getHost() { return uri.getHost(); }
    public String getUserInfo() { return uri.getUserInfo(); }
    public int getPort() { return uri.getPort(); }
    public String getPath() { return uri.getPath(); }

    public String getQueryParameter(String name) {
        String query = uri.getRawQuery();
        if (query == null) return null;
        for (String pair : query.split("&")) {
            int at = pair.indexOf('=');
            if (!decode(at < 0 ? pair : pair.substring(0, at)).equals(name)) continue;
            return decode(at < 0 ? "" : pair.substring(at + 1));
        }
        return null;
    }

    @Override public String toString() { return raw; }

    private static String decode(String value) {
        try { return URLDecoder.decode(value, "UTF-8"); }
        catch (UnsupportedEncodingException impossible) { throw new IllegalStateException(impossible); }
    }
}
`,
    'android/os/Looper.java': String.raw`package android.os;

public class Looper {
    private static final Looper MAIN = new Looper();
    public static Looper getMainLooper() { return MAIN; }
}
`,
    'android/os/Handler.java': String.raw`package android.os;

import java.util.ArrayList;
import java.util.List;

/** Deterministic stand-in: post() runs inline, postDelayed() only queues (the harness never fires it). */
public class Handler {
    private final List<Runnable> delayed = new ArrayList<Runnable>();
    public Handler(Looper looper) { }
    public boolean post(Runnable runnable) { runnable.run(); return true; }
    public boolean postDelayed(Runnable runnable, long delayMillis) {
        synchronized (delayed) { delayed.add(runnable); }
        return true;
    }
    public void removeCallbacks(Runnable runnable) {
        synchronized (delayed) { delayed.remove(runnable); }
    }
}
`,
    'android/util/Log.java': String.raw`package android.util;

public class Log {
    public static final int INFO = 4;
    public static final int ERROR = 6;
    public static int i(String tag, String message) { return println(INFO, tag, message); }
    public static int e(String tag, String message) { return println(ERROR, tag, message); }
    public static int println(int level, String tag, String message) {
        System.err.println("[" + level + "] " + tag + ": " + message);
        return 0;
    }
}
`,
    'android/view/View.java': String.raw`package android.view;

public class View {
    public static final int INVISIBLE = 4;
    private ViewGroup parent;
    public void setBackgroundColor(int color) { }
    public void setVisibility(int visibility) { }
    public ViewGroup getParent() { return parent; }
    void setParent(ViewGroup value) { parent = value; }
}
`,
    'android/view/ViewGroup.java': String.raw`package android.view;

import java.util.ArrayList;
import java.util.List;

public class ViewGroup extends View {
    private final List<View> children = new ArrayList<View>();
    public void addView(View child, LayoutParams params) { children.add(child); child.setParent(this); }
    public void removeView(View child) { children.remove(child); if (child != null) child.setParent(null); }
    public int getChildCount() { return children.size(); }
    public View getChildAt(int index) { return children.get(index); }
    public static class LayoutParams {
        public final int width;
        public final int height;
        public LayoutParams(int width, int height) { this.width = width; this.height = height; }
    }
}
`,
    'android/webkit/JavascriptInterface.java': String.raw`package android.webkit;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface JavascriptInterface { }
`,
    'android/webkit/MimeTypeMap.java': String.raw`package android.webkit;

public class MimeTypeMap {
    private static final MimeTypeMap SINGLETON = new MimeTypeMap();
    public static MimeTypeMap getSingleton() { return SINGLETON; }
    public String getMimeTypeFromExtension(String extension) { return null; }
}
`,
    'android/webkit/ValueCallback.java': String.raw`package android.webkit;

public interface ValueCallback<T> { void onReceiveValue(T value); }
`,
    'android/webkit/WebResourceError.java': String.raw`package android.webkit;

public interface WebResourceError {
    int getErrorCode();
    CharSequence getDescription();
}
`,
    'android/webkit/WebResourceRequest.java': String.raw`package android.webkit;

import android.net.Uri;
import java.util.Map;

public interface WebResourceRequest {
    Uri getUrl();
    boolean isForMainFrame();
    boolean hasGesture();
    boolean isRedirect();
    String getMethod();
    Map<String, String> getRequestHeaders();
}
`,
    'android/webkit/WebResourceResponse.java': String.raw`package android.webkit;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class WebResourceResponse {
    private final String mimeType;
    private final String encoding;
    private final int statusCode;
    private final String reasonPhrase;
    private final Map<String, String> headers;
    private final InputStream data;

    public WebResourceResponse(String mimeType, String encoding, InputStream data) {
        this(mimeType, encoding, 200, "OK", null, data);
    }

    public WebResourceResponse(String mimeType, String encoding, int statusCode, String reasonPhrase,
            Map<String, String> headers, InputStream data) {
        this.mimeType = mimeType;
        this.encoding = encoding;
        this.statusCode = statusCode;
        this.reasonPhrase = reasonPhrase;
        this.headers = headers == null ? new HashMap<String, String>() : new HashMap<String, String>(headers);
        this.data = data;
    }

    public int getStatusCode() { return statusCode; }
    public String getReasonPhrase() { return reasonPhrase; }
    public Map<String, String> getResponseHeaders() { return headers; }
    public InputStream getData() { return data; }
    public String getMimeType() { return mimeType; }
    public String getEncoding() { return encoding; }
}
`,
    'android/webkit/WebSettings.java': String.raw`package android.webkit;

public class WebSettings {
    public static final int MIXED_CONTENT_NEVER_ALLOW = 1;
    public void setJavaScriptEnabled(boolean value) { }
    public void setDomStorageEnabled(boolean value) { }
    public void setAllowFileAccess(boolean value) { }
    public void setAllowContentAccess(boolean value) { }
    public void setAllowFileAccessFromFileURLs(boolean value) { }
    public void setAllowUniversalAccessFromFileURLs(boolean value) { }
    public void setJavaScriptCanOpenWindowsAutomatically(boolean value) { }
    public void setSupportMultipleWindows(boolean value) { }
    public void setGeolocationEnabled(boolean value) { }
    public void setMixedContentMode(int mode) { }
    public void setMediaPlaybackRequiresUserGesture(boolean value) { }
}
`,
    'android/webkit/WebView.java': String.raw`package android.webkit;

import android.content.Context;
import android.view.View;
import java.util.ArrayList;
import java.util.List;

public class WebView extends View {
    public static final List<String> SCRIPT_LOG = new ArrayList<String>();
    public static final List<String> JAVASCRIPT_INTERFACES = new ArrayList<String>();
    public static final List<String> LOADED = new ArrayList<String>();
    private final WebSettings settings = new WebSettings();
    private WebViewClient client;
    private String url;

    public WebView(Context context) { }
    public WebSettings getSettings() { return settings; }
    public void setWebViewClient(WebViewClient value) { client = value; }
    public void addJavascriptInterface(Object object, String name) {
        synchronized (JAVASCRIPT_INTERFACES) { JAVASCRIPT_INTERFACES.add(name); }
    }
    public void evaluateJavascript(String script, ValueCallback<String> callback) {
        synchronized (SCRIPT_LOG) { SCRIPT_LOG.add(script); }
        if (callback != null) callback.onReceiveValue(null);
    }
    public void loadUrl(String value) {
        url = value;
        synchronized (LOADED) { LOADED.add(value); }
        if (client != null) client.onPageFinished(this, value);
    }
    public void stopLoading() { }
    public void destroy() { }
    public String getUrl() { return url; }
}
`,
    'android/webkit/WebViewClient.java': String.raw`package android.webkit;

public class WebViewClient {
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return false; }
    public boolean shouldOverrideUrlLoading(WebView view, String url) { return false; }
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return null; }
    public WebResourceResponse shouldInterceptRequest(WebView view, String url) { return null; }
    public void onPageFinished(WebView view, String url) { }
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { }
}
`,
};

const controlHarnessSource = String.raw`package com.cocos4.hostingtest;

import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.net.Uri;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class ControlHarness {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final Map<String, String> ASSET_ORIGIN = new HashMap<String, String>();
    private static final Map<String, String> EVIL_ORIGIN = new HashMap<String, String>();

    static {
        ASSET_ORIGIN.put("Origin", ORIGIN);
        EVIL_ORIGIN.put("Origin", "https://evil.example");
    }

    public static void main(String[] args) throws Exception {
        AssetManager assets = new AssetManager();
        assets.put("www/index.html", "<!doctype html><html><body>client</body></html>".getBytes(StandardCharsets.UTF_8));
        assets.put("www/__cocos4_host/index.html", "<!doctype html><html><body>adapter</body></html>".getBytes(StandardCharsets.UTF_8));
        StubPreferences preferences = new StubPreferences();
        ViewGroup root = new ViewGroup();
        org.cocos4.hosting.HostRuntime.Controller controller =
                new org.cocos4.hosting.HostRuntime.Controller(new android.app.Activity(), assets, root);
        org.cocos4.hosting.LocalAssetClient client =
                new org.cocos4.hosting.LocalAssetClient(assets, preferences, controller);

        print("start", client.intercept(request("/__cocos4/host/start?port=0&bind=lan&path=%2Fws", "POST", null)));
        print("status-starting", client.intercept(request("/__cocos4/host/status", "GET", null)));
        print("host-entry", WebView.LOADED.isEmpty() ? "" : WebView.LOADED.get(WebView.LOADED.size() - 1));
        print("bridge-name", WebView.JAVASCRIPT_INTERFACES.isEmpty() ? "" : WebView.JAVASCRIPT_INTERFACES.get(WebView.JAVASCRIPT_INTERFACES.size() - 1));
        print("children-running", String.valueOf(root.getChildCount()));
        boolean dispatched = false;
        for (String script : WebView.SCRIPT_LOG) if (script.contains("__COCOS4_HOST_ADAPTER__.onStart(")) dispatched = true;
        print("adapter-start", String.valueOf(dispatched));

        // The isolated adapter WebView becomes ready through the real @JavascriptInterface bridge.
        invokeBridge(controller, "ready", "{\"schemaVersion\":1}");
        WebResourceResponse running = client.intercept(request("/__cocos4/host/status", "GET", null));
        String runningBody = body(running);
        print("status-running", running.getStatusCode(), runningBody, "");
        String localBackend = field(runningBody, "localBackendUrl");
        String startedAt = field(runningBody, "startedAt");
        print("local-url", localBackend);
        print("started-at", startedAt);

        // saveBackendUrl(localURL): the Stronghold client PUTs the started local endpoint.
        String saveQuery = "/__cocos4/backend?url=" + URLEncoder.encode(localBackend, "UTF-8");
        print("save-local", client.intercept(request(saveQuery, "PUT", ASSET_ORIGIN)));

        // Client page reload: a new interceptor over the same activity-owned host controller and the
        // same application preferences, exactly what WebViewClient re-creation on reload looks like.
        org.cocos4.hosting.LocalAssetClient reloaded =
                new org.cocos4.hosting.LocalAssetClient(assets, preferences, controller);
        print("reload-config", reloaded.intercept(request("/cocos4-shell-config.js", "GET", null)));
        print("status-reloaded", reloaded.intercept(request("/__cocos4/host/status", "GET", null)));
        print("reload-backend-state", reloaded.intercept(request("/__cocos4/backend", "GET", null)));

        // Rejections around the same control surface.
        print("save-evil-origin", reloaded.intercept(request("/__cocos4/backend?url=" + URLEncoder.encode("http://127.0.0.1:9", "UTF-8"), "PUT", EVIL_ORIGIN)));
        print("save-bad-scheme", client.intercept(request("/__cocos4/backend?url=" + URLEncoder.encode("javascript:alert(1)", "UTF-8"), "PUT", ASSET_ORIGIN)));
        print("save-missing-url", client.intercept(request("/__cocos4/backend", "PUT", ASSET_ORIGIN)));
        print("backend-state-after-rejections", client.intercept(request("/__cocos4/backend", "GET", null)));
        print("status-post", client.intercept(request("/__cocos4/host/status", "POST", null)));
        print("start-conflict", client.intercept(request("/__cocos4/host/start?port=31234&bind=loopback&path=%2Fws", "POST", null)));
        print("start-idempotent", client.intercept(request("/__cocos4/host/start?port=0&bind=lan&path=%2Fws", "POST", null)));
        print("start-bad-port", client.intercept(request("/__cocos4/host/start?port=99999&bind=lan&path=%2Fws", "POST", null)));

        print("stop", client.intercept(request("/__cocos4/host/stop", "POST", null)));
        print("status-stopped", client.intercept(request("/__cocos4/host/status", "GET", null)));
        print("children-stopped", String.valueOf(root.getChildCount()));
        controller.destroy();
        print("children-destroyed", String.valueOf(root.getChildCount()));
        org.cocos4.hosting.LocalAssetClient destroyed =
                new org.cocos4.hosting.LocalAssetClient(assets, preferences, controller);
        print("start-destroyed", destroyed.intercept(request("/__cocos4/host/start?port=0&bind=lan&path=%2Fws", "POST", null)));
        print("DONE", "");

        java.io.BufferedReader input = new java.io.BufferedReader(
                new java.io.InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = input.readLine()) != null) {
            if ("exit".equals(line.trim())) break;
        }
        System.exit(0);
    }

    private static Request request(String path, String method, Map<String, String> headers) {
        return new Request(ORIGIN + path, method, false, headers);
    }

    private static void invokeBridge(org.cocos4.hosting.HostRuntime.Controller controller, String method, String argument) throws Exception {
        Class<?> type = Class.forName("org.cocos4.hosting.HostRuntime$Controller$Bridge");
        Constructor<?> constructor = type.getDeclaredConstructor(org.cocos4.hosting.HostRuntime.Controller.class);
        constructor.setAccessible(true);
        Object bridge = constructor.newInstance(controller);
        Method call = type.getDeclaredMethod(method, String.class);
        call.setAccessible(true);
        call.invoke(bridge, argument);
    }

    private static void print(String name, WebResourceResponse response) throws Exception {
        String allow = response.getResponseHeaders() == null ? "" : response.getResponseHeaders().get("Allow");
        print(name, response.getStatusCode(), body(response), allow);
    }

    private static void print(String name, String value) { print(name, 0, value, ""); }

    private static void print(String name, int status, String body, String allow) {
        String encoded = Base64.getEncoder().encodeToString((body == null ? "" : body).getBytes(StandardCharsets.UTF_8));
        String encodedAllow = Base64.getEncoder().encodeToString((allow == null ? "" : allow).getBytes(StandardCharsets.UTF_8));
        System.out.println(name + " " + status + " " + encoded + " " + encodedAllow);
        System.out.flush();
    }

    private static String body(WebResourceResponse response) throws Exception {
        InputStream stream = response.getData();
        if (stream == null) return "";
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String field(String json, String key) {
        String marker = "\"" + key + "\":";
        int at = json.indexOf(marker);
        if (at < 0) return "";
        int start = at + marker.length();
        if (start < json.length() && json.charAt(start) == '"') {
            int end = json.indexOf('"', start + 1);
            return json.substring(start + 1, end);
        }
        int end = start;
        while (end < json.length() && ",}".indexOf(json.charAt(end)) < 0) end++;
        return json.substring(start, end);
    }

    private static final class Request implements WebResourceRequest {
        private final Uri uri;
        private final String method;
        private final boolean mainFrame;
        private final Map<String, String> headers;

        Request(String url, String method, boolean mainFrame, Map<String, String> headers) {
            this.uri = Uri.parse(url);
            this.method = method;
            this.mainFrame = mainFrame;
            this.headers = headers == null ? new HashMap<String, String>() : headers;
        }

        @Override public Uri getUrl() { return uri; }
        @Override public boolean isForMainFrame() { return mainFrame; }
        @Override public boolean hasGesture() { return false; }
        @Override public boolean isRedirect() { return false; }
        @Override public String getMethod() { return method; }
        @Override public Map<String, String> getRequestHeaders() { return headers; }
    }

    private static final class StubPreferences implements SharedPreferences {
        private final Map<String, String> values = new HashMap<String, String>();

        @Override public String getString(String key, String fallback) {
            String value = values.get(key);
            return value == null ? fallback : value;
        }

        @Override public Editor edit() { return new StubEditor(); }

        private final class StubEditor implements Editor {
            private final Map<String, String> pending = new HashMap<String, String>();
            private final List<String> removed = new ArrayList<String>();
            @Override public Editor putString(String key, String value) { pending.put(key, value); return this; }
            @Override public Editor remove(String key) { removed.add(key); return this; }
            @Override public boolean commit() {
                for (String key : removed) values.remove(key);
                values.putAll(pending);
                return true;
            }
        }
    }
}
`;

test('lan-host control endpoints save the local backend URL and a client reload keeps the running host (desktop JVM stub harness)', {
    skip: !hasJdk && 'Set COCOS4_ANDROID_TEST_JAVA_HOME or JAVA_HOME for the desktop-JVM control harness.',
}, async t => {
    const directory = await caseDirectory(t);
    const sources = path.join(directory, 'src');
    const classes = path.join(directory, 'classes');
    await fs.mkdir(classes);
    const javaFiles = [];
    const write = async (name, source) => {
        const filename = path.join(sources, name);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, source);
        javaFiles.push(filename);
    };
    for (const [name, source] of androidProjectFiles(validateConfig(lanConfig))) {
        if (!/(?:HostRuntime|HostWebSocket|LocalAssetClient)\.java$/.test(name)) continue;
        await write(name.replace(/^app\/src\/main\/java\//, ''), source);
    }
    await write('org/cocos4/hosting/BuildConfig.java',
        'package org.cocos4.hosting; public final class BuildConfig { public static final boolean DEBUG = true; }');
    for (const [name, source] of Object.entries(stubAndroidSources)) await write(name, source);
    await write('com/cocos4/hostingtest/ControlHarness.java', controlHarnessSource);
    const environment = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
    await run(javaBin('javac'), ['-J-Djava.io.tmpdir=' + directory, '--release', '8', '-encoding', 'UTF-8', '-d', classes, ...javaFiles],
        { cwd: directory, env: environment });

    const harness = startHarness(javaBin('java'), classes, 'com.cocos4.hostingtest.ControlHarness');
    t.after(() => { if (harness.child.exitCode === null) harness.child.kill(); });
    const take = async name => {
        const line = await harness.waitFor(new RegExp(`^${name} `));
        const [label, status, payload, allow] = line.split(' ');
        assert.equal(label, name);
        return { status: Number(status), body: Buffer.from(payload, 'base64').toString('utf8'), allow: Buffer.from(allow, 'base64').toString('utf8') };
    };
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const start = await take('start');
    assert.equal(start.status, 202);
    const startState = JSON.parse(start.body);
    assert.equal(startState.kind, 'cocos4-android-host-control');
    assert.equal(startState.mode, 'lan-host');
    assert.equal(startState.state, 'starting');
    assert.equal(JSON.parse((await take('status-starting')).body).state, 'starting');
    assert.equal((await take('host-entry')).body, 'https://appassets.androidplatform.net/__cocos4_host/index.html');
    assert.equal((await take('bridge-name')).body, 'Cocos4Host');
    assert.equal((await take('children-running')).body, '1', 'the isolated backend WebView must live outside the game page');
    assert.equal((await take('adapter-start')).body, 'true', 'the adapter onStart bridge call must reach the host WebView');

    const running = JSON.parse((await take('status-running')).body);
    assert.equal(running.state, 'running');
    assert.equal(running.running, true);
    assert.equal(running.backendReady, true);
    assert.match(running.localBackendUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const localUrl = (await take('local-url')).body;
    const startedAt = (await take('started-at')).body;
    assert.equal(running.localBackendUrl, localUrl);
    assert.match(startedAt, /^\d+$/);

    const save = await take('save-local');
    assert.equal(save.status, 200, 'the control endpoint must accept the local (cleartext loopback) backend URL');
    assert.equal(JSON.parse(save.body).backendUrl, localUrl);

    const config = await take('reload-config');
    assert.equal(config.status, 200);
    assert.match(config.body, /__COCOS4_ANDROID__/);
    assert.match(config.body, new RegExp(`"backendUrl":"${escape(localUrl)}"`), 'reload must serve the persisted endpoint');
    assert.match(config.body, /"dynamicBackend":true/);
    assert.match(config.body, /globalThis\["__SP_CLIENT_CONFIG__"\]/);

    const reloaded = JSON.parse((await take('status-reloaded')).body);
    assert.equal(reloaded.running, true, 'a client reload must not stop the host');
    assert.equal(String(reloaded.startedAt), startedAt, 'a client reload must not restart the host');
    assert.equal(JSON.parse((await take('reload-backend-state')).body).backendUrl, localUrl);

    assert.equal((await take('save-evil-origin')).status, 403);
    assert.equal((await take('save-bad-scheme')).status, 400);
    assert.equal((await take('save-missing-url')).status, 400);
    assert.equal(JSON.parse((await take('backend-state-after-rejections')).body).backendUrl, localUrl);
    const statusPost = await take('status-post');
    assert.equal(statusPost.status, 405);
    assert.equal(statusPost.allow, 'GET');
    assert.equal((await take('start-conflict')).status, 409);
    assert.equal((await take('start-idempotent')).status, 200);
    assert.equal((await take('start-bad-port')).status, 400);

    assert.equal((await take('stop')).status, 202);
    const stopped = JSON.parse((await take('status-stopped')).body);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.running, false);
    assert.equal((await take('children-stopped')).body, '0');
    assert.equal((await take('children-destroyed')).body, '0');
    assert.equal((await take('start-destroyed')).status, 500);
    await take('DONE');

    const port = Number(localUrl.slice(localUrl.lastIndexOf(':') + 1));
    await assert.rejects(connectTcp(port), /ECONNREFUSED/);
    await harness.stop();
});