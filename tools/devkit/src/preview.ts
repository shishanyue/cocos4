import { createHash, randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError, artifactInventorySchema, artifactSchema, MAX_ARTIFACT_BYTES, type Artifact, type Preview } from './contracts.js';
import { acquireWindowsPath, hostRealpath, type WindowsPathLease } from './windows-fs.js';

const inventoryName = 'artifact-inventory.json';
const chunkSize = 64 * 1024;
const privateComponent = /^(?:\..*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:credentials|secrets?|key|private[-_.]?key|service[-_]?account)(?:\..*)?|.*\.(?:key|pem|p12|pfx|jks|keystore)|node_modules|toolchain)$/i;
const privateRoot = /^(?:artifact-inventory\.json|metadata\.json|manifest\.json|runtime\.json|compiler-dependencies\.json|engine-build\.json|sdk|workspace|compiler|types|template)$/i;
const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
type Pin = { handle: FileHandle; absolute: string; stat: BigIntStats; lease?: WindowsPathLease };
type FileRecord = { bytes: number; sha256: string; stat: BigIntStats };

function invalid(): never {
    throw new AppError('ARTIFACT_INVALID', 'The artifact inventory, payload or private filesystem layout is invalid.');
}

function changed(): never {
    throw new AppError('INPUT_CHANGED', 'The retained artifact changed during preview verification.');
}

function safePath(value: string): boolean {
    return value.length > 0 && value.length <= 1024 && value.split('/').length <= 32
        && value.split('/').every(part => /^[A-Za-z0-9._@+-]+$/.test(part) && !part.startsWith('.') && !part.endsWith('.')
            && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !privateComponent.test(part))
        && !privateRoot.test(value.split('/')[0]);
}

function identity(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}`;
}

function stamp(stat: BigIntStats): string {
    return `${identity(stat)}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function fdPath(pin: Pin): string { return process.platform === 'win32' ? pin.absolute : `/proc/self/fd/${pin.handle.fd}`; }

function samePath(left: string, right: string): boolean {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function closePin(pin: Pin): Promise<void> {
    try { await pin.handle.close(); }
    finally { await pin.lease?.close(); }
}

async function checkPin(pin: Pin, content = true): Promise<void> {
    await pin.lease?.check();
    const current = await pin.handle.stat({ bigint: true });
    const linked = await fs.lstat(pin.absolute, { bigint: true });
    const signature = content ? stamp : identity;
    if (signature(current) !== signature(pin.stat) || signature(linked) !== signature(pin.stat)
        || !samePath(await hostRealpath(fdPath(pin)), pin.absolute) || !samePath(await hostRealpath(pin.absolute), pin.absolute)) changed();
}

async function openChild(parent: Pin, name: string, directory: boolean, privateInput = true): Promise<Pin> {
    const filename = path.join(fdPath(parent), name);
    let lease: WindowsPathLease | undefined;
    let handle: FileHandle | undefined;
    try {
        // Windows leases reject reparse points/unsafe ACLs and deny delete sharing
        // before Node resolves the path. Keep the lease for every open descriptor.
        if (process.platform === 'win32') lease = await acquireWindowsPath(filename, { directory, private: privateInput, trusted: privateInput });
        const before = await fs.lstat(filename, { bigint: true });
        if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n)) invalid();
        if (process.platform !== 'win32' && privateInput && (before.uid !== BigInt(process.getuid!())
            || (directory ? (before.mode & 0o7777n) !== 0o700n : ![0o400n, 0o600n].includes(before.mode & 0o7777n)))) invalid();
        handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
            | (directory ? (constants.O_DIRECTORY ?? 0) : 0));
        const stat = await handle.stat({ bigint: true });
        const signature = directory && !privateInput ? identity : stamp;
        if (signature(before) !== signature(stat)) changed();
        const pin = { handle, absolute: lease?.absolute ?? path.join(parent.absolute, name), stat, lease };
        await checkPin(pin, privateInput);
        return pin;
    } catch (error) {
        try { await handle?.close(); } finally { await lease?.close(); }
        throw error;
    }
}

function checkDeadline(deadline: number): void {
    if (performance.now() > deadline) throw new AppError('TIMEOUT', 'Artifact verification exceeded its time budget.');
}

// Never readFile/stream a mutable path: bound every read by its declared length,
// check EOF and metadata, and hash the exact buffer that will be sent to HTTP.
async function readVerified(pin: Pin, expected: { bytes: number; sha256: string }, buffer: Buffer,
    retain: boolean, deadline: number, aborted: () => boolean = () => false): Promise<void> {
    if (pin.stat.size !== BigInt(expected.bytes)) invalid();
    await checkPin(pin);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < expected.bytes) {
        checkDeadline(deadline);
        if (aborted()) throw new AppError('CANCELLED', 'Preview request closed.');
        const destination = retain ? offset : 0;
        const length = Math.min(chunkSize, expected.bytes - offset);
        const { bytesRead } = await pin.handle.read(buffer, destination, length, offset);
        if (!bytesRead) changed();
        hash.update(buffer.subarray(destination, destination + bytesRead));
        offset += bytesRead;
    }
    if ((await pin.handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) changed();
    await checkPin(pin);
    checkDeadline(deadline);
    if (hash.digest('hex') !== expected.sha256) invalid();
}

async function closePins(pins: Pin[]): Promise<void> {
    const results = await Promise.allSettled(pins.map(closePin));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
}

export async function startPreview(options: {
    artifactDirectory: string; artifact: Artifact; ttlSeconds: number;
}): Promise<{ preview: Preview; closed: Promise<void>; close(): Promise<void> }> {
    const { artifactDirectory, ttlSeconds } = options;
    const parsed = artifactSchema.safeParse(options.artifact);
    if (!parsed.success || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7200) {
        throw new AppError('INVALID_ARGUMENTS', 'Preview requires an artifact receipt and an integer TTL of 1 to 7200 seconds.');
    }
    const artifact = parsed.data;
    if (artifact.target !== 'HTML5' || artifact.entry !== 'index.html') {
        throw new AppError('UNSUPPORTED_PROJECT', 'Browser preview requires an HTML5 artifact with an index.html entry.');
    }
    if (artifact.bytes > MAX_ARTIFACT_BYTES || artifact.files > 10000) {
        throw new AppError('LIMIT_EXCEEDED', 'Preview artifacts are limited to 128 MiB and 10000 payload files.');
    }
    if (process.platform !== 'win32' && (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK)) {
        throw new AppError('SDK_INCOMPLETE', 'Secure preview reads require the Windows filesystem helper or Linux no-follow opens and verified /proc/self/fd.');
    }
    if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory)
        || artifactDirectory !== path.resolve(artifactDirectory) || artifactDirectory.length > 4096
        || artifactDirectory.split(path.sep).length > 64 || path.basename(artifactDirectory) !== `artifact-${artifact.artifactId}`) {
        throw new AppError('INVALID_ARGUMENTS', 'Preview requires the parent-authorized private artifact directory.');
    }
    const pins: Pin[] = [];
    const files = new Map<string, FileRecord>();
    const directories = new Map<string, BigIntStats>();
    const deadline = performance.now() + 60000;
    try {
        const rootPath = path.parse(artifactDirectory).root;
        // Validate and retain the complete artifact chain first. A drive root is
        // a system ancestor, not a payload leaf: Windows normally permits users
        // to create directories there, and TrustedInstaller may own it. The
        // complete-chain lease applies the helper's ancestor policy correctly.
        const lease = process.platform === 'win32'
            ? await acquireWindowsPath(artifactDirectory, { directory: true, private: true, trusted: true }) : undefined;
        let handle: FileHandle;
        try {
            handle = await fs.open(rootPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        } catch (error) { await lease?.close(); throw error; }
        let root: Pin;
        try { root = { handle, absolute: rootPath, stat: await handle.stat({ bigint: true }), lease }; }
        catch (error) { try { await handle.close(); } finally { await lease?.close(); } throw error; }
        pins.push(root);
        if (!samePath(await hostRealpath(fdPath(root)), root.absolute)) throw new AppError('SDK_INCOMPLETE', 'Verified filesystem descriptor paths are unavailable.');
        const components = artifactDirectory.slice(rootPath.length).split(path.sep).filter(Boolean);
        for (let index = 0; index < components.length; index++) {
            checkDeadline(deadline);
            // On Windows the last two leases retain the private ACL policy for
            // later HTTP checks. Parent-directory content may still change.
            pins.push(await openChild(pins[pins.length - 1], components[index], true,
                process.platform === 'win32' && index >= components.length - 2));
        }
        if (process.platform !== 'win32') {
            for (const pin of pins) {
                const owner = pin.stat.uid === 0n || pin.stat.uid === BigInt(process.getuid!());
                const stickyRoot = pin.stat.uid === 0n && (pin.stat.mode & 0o1000n) !== 0n;
                if (!owner || ((pin.stat.mode & 0o022n) !== 0n && !stickyRoot)) invalid();
            }
            for (const pin of pins.slice(-2)) {
                if (pin.stat.uid !== BigInt(process.getuid!()) || (pin.stat.mode & 0o7777n) !== 0o700n) invalid();
            }
        }
        const directory = pins[pins.length - 1];
        const inventoryPin = await openChild(directory, inventoryName, false);
        try {
            if (inventoryPin.stat.size > 16n * 1024n * 1024n) {
                throw new AppError('LIMIT_EXCEEDED', 'The artifact inventory exceeds 16 MiB.');
            }
            const bytes = Buffer.alloc(Number(inventoryPin.stat.size));
            await readVerified(inventoryPin, { bytes: bytes.length, sha256: artifact.sha256 }, bytes, true, deadline);
            const inventory = artifactInventorySchema.parse(JSON.parse(bytes.toString('utf8')));
            for (const key of ['artifactId', 'sdkId', 'target', 'profile', 'variant', 'entry'] as const) {
                if (inventory[key] !== artifact[key]) invalid();
            }
            if (JSON.stringify(inventory.validationLevels) !== JSON.stringify(artifact.validationLevels)
                || JSON.stringify(inventory.provenance) !== JSON.stringify(artifact.provenance)
                || inventory.files.length !== artifact.files) invalid();
            const expected = new Map(inventory.files.map(file => [file.path, file]));
            if (expected.size !== inventory.files.length || new Set(inventory.files.map(file => file.path.toLowerCase())).size !== expected.size
                || !expected.has(artifact.entry)) invalid();
            const expectedDirectories = new Set<string>();
            let total = 0;
            for (const file of inventory.files) {
                if (!safePath(file.path)) invalid();
                total += file.bytes;
                if (total > MAX_ARTIFACT_BYTES) throw new AppError('LIMIT_EXCEEDED', 'Artifact payload exceeds 128 MiB.');
                const parts = file.path.split('/');
                for (let end = 1; end < parts.length; end++) {
                    expectedDirectories.add(parts.slice(0, end).join('/'));
                    if (expectedDirectories.size + expected.size + 1 > 20000) {
                        throw new AppError('LIMIT_EXCEEDED', 'Artifact tree exceeds 20000 entries.');
                    }
                }
            }
            if (total !== artifact.bytes || [...expectedDirectories].some(name => expected.has(name))) invalid();
            const scratch = Buffer.alloc(chunkSize);
            let entries = 0;
            async function scan(pin: Pin, prefix: string): Promise<void> {
                await checkPin(pin);
                directories.set(prefix, pin.stat);
                const listing = await fs.opendir(fdPath(pin));
                try {
                    for (;;) {
                        checkDeadline(deadline);
                        const entry = await listing.read();
                        if (!entry) break;
                        if (++entries > 20000) throw new AppError('LIMIT_EXCEEDED', 'Artifact tree exceeds 20000 entries.');
                        if (!prefix && entry.name === inventoryName) { await checkPin(inventoryPin); continue; }
                        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
                        if (!safePath(name) || (entry.isDirectory() ? !expectedDirectories.has(name) : !expected.has(name))) invalid();
                        const child = await openChild(pin, entry.name, entry.isDirectory());
                        try {
                            if (entry.isDirectory()) await scan(child, name);
                            else {
                                const record = expected.get(name)!;
                                if (files.has(name)) invalid();
                                await readVerified(child, record, scratch, false, deadline);
                                files.set(name, { bytes: record.bytes, sha256: record.sha256, stat: child.stat });
                            }
                        } finally { await closePin(child); }
                    }
                } finally { await listing.close(); }
                await checkPin(pin);
            }
            await scan(directory, '');
            if (files.size !== expected.size) invalid();
            await checkPin(inventoryPin);
            for (const pin of pins) await checkPin(pin, pin === directory);
        } finally { await closePin(inventoryPin); }
    } catch (error) {
        await closePins(pins);
        if (process.platform === 'win32' && error instanceof AppError && ['PERMISSION_DENIED', 'PATH_OUTSIDE_WORKSPACE'].includes(error.code)) invalid();
        if (error instanceof AppError) throw error;
        invalid();
    }

    const prefix = `/${randomBytes(32).toString('hex')}/`;
    const sockets = new Set<Socket>();
    const used = new WeakSet<Socket>();
    const pending = new Set<Promise<void>>();
    const waiting: Array<{ allocation: number; start(): void; dispose(): void }> = [];
    let origin = '';
    let host = '';
    let stopping = false;
    let buffered = 0;
    let requests = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000,
        connectionsCheckingInterval: 1000, keepAliveTimeout: 1000 }, handleRequest);
    server.maxHeadersCount = 64;
    server.maxConnections = 32;
    server.maxRequestsPerSocket = 1;
    server.setTimeout(5000, socket => socket.destroy());

    function close(): Promise<void> {
        if (!stopping) {
            stopping = true;
            clearTimeout(timer);
            for (const request of waiting.splice(0)) request.dispose();
            const stopped = new Promise<void>(resolve => server.close(() => resolve()));
            for (const socket of sockets) socket.destroy();
            void (async () => {
                await stopped;
                await Promise.allSettled(pending);
                await closePins(pins);
            })().then(resolveClosed, rejectClosed);
        }
        return closed;
    }

    function drainWaiting(): void {
        while (!stopping && pending.size < 8 && waiting.length) {
            const next = waiting[0];
            if (buffered + next.allocation > MAX_ARTIFACT_BYTES) return;
            waiting.shift();
            next.start();
        }
    }

    function handleRequest(request: IncomingMessage, response: ServerResponse): void {
        if (stopping || used.has(request.socket) || ++requests > 10000) {
            request.socket.destroy();
            if (requests > 10000) void close().catch(() => {});
            return;
        }
        used.add(request.socket);
        response.shouldKeepAlive = false;
        response.setHeader('Connection', 'close');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
        const reject = (status: number): void => { response.writeHead(status, { 'Content-Length': '0' }); response.end(); };
        if (request.rawHeaders.length > 64) { reject(431); return; }
        const countHeader = (name: string): number => request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
        if (countHeader('host') !== 1 || request.headers.host !== host || countHeader('origin') > 1
            || (request.headers.origin !== undefined && request.headers.origin !== origin)
            || (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) {
            reject(403); return;
        }
        // Inspect the raw request target, never URL-normalize traversal into an allowed route.
        const raw = request.url ?? '';
        if (raw.length > 2048 || /[^\x21-\x7e]|[%\\#]/.test(raw) || !raw.startsWith(prefix)) { reject(404); return; }
        const name = raw.split('?')[0].slice(prefix.length) || 'index.html';
        if (!safePath(name)) { reject(404); return; }
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); reject(405); return; }
        if (request.headers.expect !== undefined || request.headers['transfer-encoding'] !== undefined
            || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) { reject(400); return; }
        const record = files.get(name);
        if (!record) { reject(404); return; }
        const retain = request.method === 'GET';
        const allocation = retain ? record.bytes : Math.min(record.bytes, chunkSize);
        if (waiting.length >= 24) { reject(503); return; }
        // Normal resource bursts wait without opening files or allocating payload buffers.
        // Waiting and verification share one deadline; FIFO also prevents large-file starvation.
        const deadline = performance.now() + 5000;
        const dispose = (): void => {
            clearTimeout(waitTimer);
            response.off('close', disconnected);
        };
        const removeWaiting = (): boolean => {
            const index = waiting.indexOf(queued);
            if (index < 0) return false;
            waiting.splice(index, 1);
            dispose();
            return true;
        };
        const disconnected = (): void => { if (removeWaiting()) drainWaiting(); };
        const waitTimer = setTimeout(() => {
            if (removeWaiting()) {
                if (!response.destroyed) reject(503);
                drainWaiting();
            }
        }, 5000);
        const queued = { allocation, dispose, start: (): void => {
            dispose();
            buffered += allocation;
            const task = (async () => {
                const requestPins: Pin[] = [];
                try {
                    checkDeadline(deadline);
                    if (stopping || response.destroyed) return;
                    const root = pins[pins.length - 1];
                    for (const pin of pins) { checkDeadline(deadline); await checkPin(pin, pin === root); }
                    let parent = root;
                    const parts = name.split('/');
                    for (let index = 0; index < parts.length; index++) {
                        checkDeadline(deadline);
                        if (stopping || response.destroyed) return;
                        const directory = index < parts.length - 1;
                        const pin = await openChild(parent, parts[index], directory);
                        requestPins.push(pin);
                        const expected = directory ? directories.get(parts.slice(0, index + 1).join('/'))! : record.stat;
                        if (stamp(pin.stat) !== stamp(expected)) changed();
                        parent = pin;
                    }
                    // Aggregate live response buffers, not just individual file sizes, are capped.
                    checkDeadline(deadline);
                    if (stopping || response.destroyed) return;
                    const body = Buffer.alloc(allocation);
                    await readVerified(parent, record, body, retain, deadline, () => stopping || response.destroyed);
                    for (const pin of requestPins) { checkDeadline(deadline); await checkPin(pin); }
                    for (const pin of pins) { checkDeadline(deadline); await checkPin(pin, pin === root); }
                    checkDeadline(deadline);
                    if (stopping || response.destroyed) return;
                    response.writeHead(200, { 'Content-Type': mime[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
                        'Content-Length': String(record.bytes) });
                    await new Promise<void>(resolve => {
                        response.once('close', resolve);
                        response.end(retain ? body : undefined);
                    });
                } catch {
                    if (!response.destroyed && !response.headersSent) reject(409);
                    else response.destroy();
                } finally {
                    try { await closePins(requestPins); }
                    finally { buffered -= allocation; }
                }
            })();
            pending.add(task);
            void task.finally(() => { pending.delete(task); drainWaiting(); }).catch(() => response.destroy());
        } };
        waiting.push(queued);
        response.once('close', disconnected);
        drainWaiting();
    }

    server.on('connection', socket => {
        sockets.add(socket);
        const lifetime = setTimeout(() => socket.destroy(), 10000);
        socket.once('close', () => { clearTimeout(lifetime); sockets.delete(socket); });
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('upgrade', (_request, socket) => socket.destroy());
    server.on('connect', (_request, socket) => socket.destroy());
    server.on('checkContinue', handleRequest);
    server.on('checkExpectation', handleRequest);
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', reject); resolve(); });
        });
    } catch {
        await close();
        throw new AppError('PROCESS_FAILED', 'The loopback preview listener could not be started.');
    }
    server.on('error', () => { void close().catch(() => {}); });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        await close();
        throw new AppError('PROCESS_FAILED', 'The preview listener is not on IPv4 loopback.');
    }
    host = `127.0.0.1:${address.port}`;
    origin = `http://${host}`;
    const preview: Preview = { artifactId: artifact.artifactId, url: `${origin}${prefix}`, port: address.port,
        expiresAt: Date.now() + ttlSeconds * 1000 };
    timer = setTimeout(() => { void close().catch(() => {}); }, ttlSeconds * 1000);
    return { preview, closed, close };
}
