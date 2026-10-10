import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './contracts.js';

export interface WindowsPathOptions {
    directory?: boolean;
    private?: boolean;
    trusted?: boolean;
    immutable?: boolean;
}
export interface WindowsPathLease {
    readonly absolute: string;
    check(): Promise<void>;
    close(): Promise<void>;
}

// Drive-relative paths, device namespaces, alternate streams and DOS aliases
// have no meaning in the workspace protocol. Keep this validation independent
// of the platform so package authors can exercise it on every build host.
export function validateWindowsPath(value: string): string {
    if (typeof value !== 'string' || value.length > 4096 || !/^[a-z]:\\/i.test(value)
        || /[\x00-\x1f\x7f/<>"|?*]/.test(value) || value.slice(2).includes(':')
        || value !== path.win32.normalize(value) || (value.length > 3 && value.endsWith('\\'))) {
        throw new AppError('PATH_OUTSIDE_WORKSPACE', 'A normalized local Windows drive path is required.');
    }
    const components = value.slice(3).split('\\').filter(Boolean);
    if (components.length > 128) throw new AppError('LIMIT_EXCEEDED', 'A Windows path may have at most 128 components.');
    for (const component of components) {
        if (component.length > 255 || /[. ]$/.test(component) || component === '.' || component === '..'
            || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)/i.test(component)) {
            throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Windows aliases and reserved path components are forbidden.');
        }
    }
    return value;
}

// Node 18's Windows realpath rejects ordinary DOS paths beyond MAX_PATH even
// when open/stat work. Only change the syscall input; retain its canonical output.
export function hostRealpath(filename: string): Promise<string> {
    // Node 24 rejects namespaced drive roots with EISDIR; roots cannot exceed MAX_PATH.
    const extended = process.platform === 'win32' && filename !== path.parse(filename).root;
    return fs.realpath(extended ? path.toNamespacedPath(filename) : filename);
}

function unavailable(): AppError {
    return new AppError('SDK_INCOMPLETE', 'Secure Windows filesystem access requires the packaged host/cocos4-fs.exe helper and matching fs.json.');
}
function nativeError(kind: string, code: number): Error {
    if (code === 2 || code === 3) return Object.assign(new Error('The Windows path does not exist.'), { code: 'ENOENT' });
    if (kind === 'path') return new AppError('PATH_OUTSIDE_WORKSPACE', 'Reparse points, remote paths and noncanonical Windows paths are forbidden.');
    if (kind === 'acl' || code === 5 || code === 1314) return new AppError('PERMISSION_DENIED', 'The Windows path has an untrusted owner or grants access outside its permitted principals.');
    if (kind === 'limit') return new AppError('LIMIT_EXCEEDED', 'The Windows filesystem lease limit was exceeded.');
    return new AppError('INPUT_CHANGED', `A Windows filesystem lease could not be verified (${code}).`, [], true);
}

type Pending = { id: number; resolve: (fields: string[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
class WindowsSession {
    private pending?: Pending;
    private serial: Promise<unknown> = Promise.resolve();
    private nextId = 1;
    private failed?: Error;
    private buffer = '';
    private active = 0;
    private idle?: ReturnType<typeof setTimeout>;
    private constructor(private readonly child: ChildProcessWithoutNullStreams) {
        child.unref();
        child.stdout.setEncoding('ascii');
        child.stdout.on('data', (chunk: string) => {
            this.buffer += chunk;
            if (this.buffer.length > 40000) { this.fail(unavailable()); return; }
            let end: number;
            while ((end = this.buffer.indexOf('\n')) !== -1) {
                const line = this.buffer.slice(0, end).replace(/\r$/, '');
                this.buffer = this.buffer.slice(end + 1);
                const fields = line.split(' '), pending = this.pending;
                if (!pending || fields[0] !== String(pending.id) || !['OK', 'ERR'].includes(fields[1])) { this.fail(unavailable()); return; }
                this.pending = undefined; clearTimeout(pending.timer); this.reference(false);
                if (fields[1] === 'ERR') {
                    if (fields.length !== 4 || !/^[0-9]+$/.test(fields[3])) { pending.reject(unavailable()); this.fail(unavailable()); return; }
                    pending.reject(nativeError(fields[2], Number(fields[3])));
                } else pending.resolve(fields.slice(2));
            }
        });
        child.stderr.on('data', () => this.fail(unavailable()));
        child.once('error', () => this.fail(unavailable()));
        child.once('close', () => this.fail(unavailable()));
        child.stdin.on('error', () => this.fail(unavailable()));
    }
    private reference(ref: boolean): void {
        for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
            const handle = stream as unknown as { ref?: () => void; unref?: () => void };
            if (ref) handle.ref?.(); else handle.unref?.();
        }
    }
    private fail(error: Error): void {
        if (this.failed) return;
        this.failed = error;
        if (this.idle) clearTimeout(this.idle);
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
        this.child.stdin.destroy(); this.child.kill(); this.reference(false);
    }
    static async create(): Promise<WindowsSession> {
        if (process.platform !== 'win32' || process.arch !== 'x64') throw unavailable();
        const filename = fileURLToPath(new URL('../host/cocos4-fs.exe', import.meta.url));
        try {
            const raw = await fs.readFile(new URL('../host/fs.json', import.meta.url), 'utf8');
            if (raw.length > 4096) throw unavailable();
            const metadata = JSON.parse(raw) as Record<string, unknown>;
            const info = await fs.lstat(filename);
            if (metadata.version !== 1 || metadata.platform !== 'win32' || metadata.arch !== 'x64'
                || metadata.file !== 'cocos4-fs.exe' || !Number.isSafeInteger(metadata.bytes)
                || Number(metadata.bytes) <= 0 || Number(metadata.bytes) > 32 * 1024 * 1024
                || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)
                || typeof metadata.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sourceSha256)
                || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== metadata.bytes
                || (await hostRealpath(filename)).toLowerCase() !== filename.toLowerCase()) throw unavailable();
            const bytes = await fs.readFile(filename);
            if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw unavailable();
            const child = spawn(filename, ['cocos4-fs-v1'], { shell: false, windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'], env: {} });
            const session = new WindowsSession(child);
            const response = await session.request('H');
            if (response.length !== 1 || response[0] !== 'cocos4-fs-v1') { session.fail(unavailable()); throw unavailable(); }
            return session;
        } catch (error) { if (error instanceof AppError) throw error; throw unavailable(); }
    }
    request(command: string): Promise<string[]> {
        const execute = (): Promise<string[]> => {
            if (this.failed) return Promise.reject(this.failed);
            if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
            const id = this.nextId++;
            if (!Number.isSafeInteger(id)) { this.fail(unavailable()); return Promise.reject(unavailable()); }
            this.reference(true);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => this.fail(unavailable()), 15000);
                this.pending = { id, resolve, reject, timer };
                this.child.stdin.write(`${id} ${command}\n`);
            });
        };
        const result = this.serial.then(execute, execute);
        this.serial = result.catch(() => undefined);
        return result;
    }
    retain(): void { this.active++; }
    release(): void {
        if (--this.active !== 0) return;
        this.idle = setTimeout(() => {
            if (this.active || this.pending) return;
            this.child.stdin.end(); this.reference(false);
            if (sharedSession) sharedSession = undefined;
        }, 1000);
        this.idle.unref();
    }
}
let sharedSession: Promise<WindowsSession> | undefined;
async function session(): Promise<WindowsSession> {
    if (!sharedSession) sharedSession = WindowsSession.create().catch(error => { sharedSession = undefined; throw error; });
    return sharedSession;
}

export async function acquireWindowsPath(filename: string, options: WindowsPathOptions = {}): Promise<WindowsPathLease> {
    validateWindowsPath(filename);
    const service = await session();
    // Keep the session alive while P is queued, including concurrent callers.
    service.retain();
    const flags = (options.directory ? 1 : 0) | (options.private ? 2 : 0) | (options.trusted ? 4 : 0) | (options.immutable ? 8 : 0);
    try {
        const fields = await service.request(`P ${flags} ${Buffer.from(filename, 'utf16le').toString('hex')}`);
        if (fields.length !== 2 || !/^[1-9][0-9]*$/.test(fields[0]) || !/^(?:[a-f0-9]{4})+$/.test(fields[1])) throw unavailable();
        const absolute = validateWindowsPath(Buffer.from(fields[1], 'hex').toString('utf16le'));
        const token = fields[0]; let closed = false;
        return { absolute,
            check: async () => { if (closed) throw new AppError('INPUT_CHANGED', 'The Windows path lease is closed.'); await service.request(`C ${token}`); },
            close: async () => { if (closed) return; closed = true; try { await service.request(`R ${token}`); } finally { service.release(); } },
        };
    } catch (error) { service.release(); throw error; }
}

export async function verifyWindowsTrust(filename: string, requirePrivate = false): Promise<void> {
    const info = await fs.lstat(filename);
    const lease = await acquireWindowsPath(filename, { directory: info.isDirectory(), private: requirePrivate, trusted: true });
    try { await lease.check(); } finally { await lease.close(); }
}

// This is an explicit creation-time operation. Verification never rewrites an
// existing user's ACL. Directory ACEs inherit onto both files and directories.
export async function enforceWindowsPrivate(filename: string): Promise<void> {
    validateWindowsPath(filename);
    const service = await session(); service.retain();
    try { await service.request(`A ${Buffer.from(filename, 'utf16le').toString('hex')}`); }
    finally { service.release(); }
}

export async function enforceWindowsReadOnly(filename: string): Promise<void> {
    validateWindowsPath(filename);
    const service = await session(); service.retain();
    try { await service.request(`O ${Buffer.from(filename, 'utf16le').toString('hex')}`); }
    finally { service.release(); }
}
