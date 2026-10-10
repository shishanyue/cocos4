import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError } from './contracts.js';
import { hash, parseJson } from './sdk.js';
import { acquireWindowsPath, type WindowsPathLease } from './windows-fs.js';

export const supervisorIdentitySchema = z.object({
    pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/),
    guardianPid: z.number().int().positive(), guardianStartTime: z.string().regex(/^\d+$/),
    platform: z.enum(['linux', 'win32']).optional(),
    runnerPid: z.number().int().positive().optional(), runnerStartTime: z.string().regex(/^\d+$/).optional(),
}).strict();
export type SupervisorIdentity = z.infer<typeof supervisorIdentitySchema>;
export type ProcessExit = { exitCode: number | null; signal: string | null };
export type ProcessOutcome = ProcessExit & { treeClosed: boolean; infrastructureFailed: boolean };
const eventSchema = z.discriminatedUnion('type', [
    supervisorIdentitySchema.extend({ type: z.literal('ready') }),
    z.object({ type: z.literal('runner_started'), pid: z.number().int().positive() }).strict(),
    z.object({ type: z.literal('runner_exit'), exitCode: z.number().int().min(0).max(255).nullable(), signal: z.number().int().positive().nullable() }).strict(),
    z.object({ type: z.literal('closed') }).strict(), z.object({ type: z.literal('closure_failed') }).strict(),
]);
const windowsIdentitySchema = z.object({ platform: z.literal('win32'), pid: z.number().int().positive().max(0xffffffff),
    creationTime: z.string().regex(/^\d+$/) }).strict();
const windowsEnvelope = z.object({ version: z.literal(1), platform: z.literal('win32') });
const windowsErrorSchema = windowsEnvelope.extend({ type: z.literal('error'), operation: z.string().min(1).max(64),
    errorCode: z.number().int().nonnegative().max(0xffffffff) }).strict();
const windowsIdentityEventSchema = z.union([
    windowsEnvelope.extend({ type: z.literal('identity'), process: windowsIdentitySchema, alive: z.boolean() }).strict(), windowsErrorSchema,
]);
const windowsTreeEventSchema = windowsEnvelope.extend({ type: z.literal('tree'), exists: z.boolean(),
    activeProcesses: z.number().int().nonnegative().max(0xffffffff) }).strict();
const windowsEventSchema = z.discriminatedUnion('type', [
    windowsEnvelope.extend({ type: z.literal('ready'), supervisor: windowsIdentitySchema, owner: windowsIdentitySchema, runner: windowsIdentitySchema }).strict(),
    windowsEnvelope.extend({ type: z.literal('started') }).strict(),
    windowsEnvelope.extend({ type: z.literal('runnerExit'), exitCode: z.number().int().nonnegative().max(0xffffffff) }).strict(),
    windowsEnvelope.extend({ type: z.literal('stopping'), reason: z.enum(['stop', 'stdinEof', 'ownerExit', 'runnerExit', 'controlError', 'console',
        'observationError', 'readyTimeout', 'infrastructure']) }).strict(),
    windowsEnvelope.extend({ type: z.literal('treeClosed'), activeProcesses: z.literal(0) }).strict(),
    windowsEnvelope.extend({ type: z.literal('treeNotClosed'), activeProcesses: z.number().int().nonnegative().max(0xffffffff).nullable() }).strict(),
    windowsErrorSchema,
]);
const helperName = process.platform === 'win32' ? 'cocos4-supervise.exe' : 'cocos4-supervise';
const hostManifestSchema = z.object({ version: z.literal(1), platform: z.literal(process.platform), arch: z.literal(process.arch),
    file: z.literal(helperName), bytes: z.number().int().positive().max(32 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

type SupervisorFile = { fd: number; absolute: string; close: () => Promise<void> };
async function supervisorFile(): Promise<SupervisorFile> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let lease: WindowsPathLease | undefined;
    try {
        if (process.platform !== 'linux' && process.platform !== 'win32') throw new Error('Unsupported host.');
        const manifest = hostManifestSchema.parse(parseJson(await readFile(new URL('../host/supervisor.json', import.meta.url), 'utf8')));
        const filename = new URL(`../host/${helperName}`, import.meta.url);
        if (process.platform === 'win32') lease = await acquireWindowsPath(fileURLToPath(filename), { trusted: true, immutable: true });
        const entry = await lstat(filename);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe helper.');
        file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && ((stat.mode & 0o022) || !(stat.mode & 0o100)))
            || stat.size !== manifest.bytes || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error('Unsafe helper.');
        const bytes = Buffer.alloc(manifest.bytes + 1);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== manifest.bytes || hash(bytes.subarray(0, read.bytesRead)) !== manifest.sha256) throw new Error('Helper integrity.');
        await lease?.check();
        const verified = file, pinned = lease;
        return { fd: verified.fd, absolute: pinned?.absolute ?? fileURLToPath(filename),
            close: async () => { try { await verified.close(); } finally { await pinned?.close(); } } };
    } catch {
        try { await file?.close(); } finally { await lease?.close(); }
        throw new AppError('SDK_INCOMPLETE', `Trusted logic execution requires the packaged host/${helperName} helper matching this host.`,
            ['Use a verified host distribution. Runtime never invokes a compiler or downloads a helper.']);
    }
}
export async function verifySupervisor(): Promise<void> { await (await supervisorFile()).close(); }

async function windowsTreeClosed(pid: number, startTime: string): Promise<boolean> {
    const helper = await supervisorFile();
    try {
        return await new Promise<boolean>((resolve, reject) => {
            const child = spawn(helper.absolute, ['--tree', String(pid), startTime],
                { shell: false, windowsHide: true, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '', invalid = false;
            const timer = setTimeout(() => { invalid = true; child.kill(); }, 5000);
            child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString('utf8'); if (stdout.length > 2048) { invalid = true; child.kill(); } });
            child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8'); if (stderr.length > 2048) { invalid = true; child.kill(); } });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', code => {
                clearTimeout(timer);
                try {
                    if (invalid || stderr || code !== 0 || !stdout.endsWith('\n')) throw new Error('Incomplete Job accounting.');
                    const event = windowsTreeEventSchema.parse(JSON.parse(stdout));
                    if (!event.exists && event.activeProcesses !== 0) throw new Error('Invalid Job accounting.');
                    resolve(event.activeProcesses === 0);
                } catch { reject(new AppError('WORKSPACE_BUSY', 'The previous Windows Job Object could not confirm cleanup; its state was preserved.', [], true)); }
            });
        });
    } finally { await helper.close(); }
}

export async function processIdentity(pid: number): Promise<{ startTime: string; alive: boolean } | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new AppError('INVALID_ARGUMENTS', 'A valid process identifier is required.');
    if (process.platform === 'win32') {
        const helper = await supervisorFile();
        try {
            const observation = await new Promise<z.infer<typeof windowsIdentityEventSchema>>((resolve, reject) => {
                const child = spawn(helper.absolute, ['--identity', String(pid)],
                    { shell: false, windowsHide: true, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = '', stderr = '', invalid = false;
                const timer = setTimeout(() => { invalid = true; child.kill(); }, 5000);
                child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString('utf8'); if (stdout.length > 2048) { invalid = true; child.kill(); } });
                child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8'); if (stderr.length > 2048) { invalid = true; child.kill(); } });
                child.once('error', error => { clearTimeout(timer); reject(error); });
                child.once('close', code => {
                    clearTimeout(timer);
                    try {
                        if (invalid || stderr || !stdout.endsWith('\n')) throw new Error('Incomplete process identity.');
                        const event = windowsIdentityEventSchema.parse(JSON.parse(stdout));
                        if (event.type === 'identity' && (code !== 0 || event.process.pid !== pid)) throw new Error('Mismatched process identity.');
                        if (event.type === 'error' && code !== 125) throw new Error('Invalid identity failure.');
                        resolve(event);
                    } catch (error) { reject(error); }
                });
            });
            if (observation.type === 'identity') return { startTime: observation.process.creationTime, alive: observation.alive };
            // Windows returns ERROR_INVALID_PARAMETER for a PID that no longer
            // exists. Access denied is not evidence that the owner is dead.
            if (observation.operation === 'OpenProcess' && [87, 1168].includes(observation.errorCode)) return null;
            throw new AppError('WORKSPACE_BUSY', 'The previous process identity could not be verified; its state was preserved.', [], true);
        } finally { await helper.close(); }
    }
    try {
        const text = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
        return { startTime: fields[19], alive: !['Z', 'X'].includes(fields[0]) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
export async function waitForSupervisors(identities: SupervisorIdentity[]): Promise<void> {
    const deadline = Date.now() + 10000;
    for (;;) {
        let alive = false;
        const unique = new Map<string, readonly [number, string]>();
        for (const value of identities) {
            if (value.platform && value.platform !== process.platform) throw new AppError('WORKSPACE_BUSY', 'Private job state belongs to a different host platform.', [], true);
            for (const pair of [[value.pid, value.startTime], [value.guardianPid, value.guardianStartTime],
                ...(value.runnerPid && value.runnerStartTime ? [[value.runnerPid, value.runnerStartTime] as const] : [])] as const) unique.set(`${pair[0]}:${pair[1]}`, pair);
        }
        for (const [pid, startTime] of unique.values()) {
            const actual = await processIdentity(pid);
            if (actual?.alive && actual.startTime === startTime) alive = true;
        }
        if (!alive && process.platform === 'win32') {
            for (const value of identities) if (!await windowsTreeClosed(value.pid, value.startTime)) alive = true;
        }
        if (!alive) return;
        if (Date.now() >= deadline) throw new AppError('WORKSPACE_BUSY', 'A previous supervised tree has not confirmed shutdown. Its state and staging were preserved.', [], true);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

export class ProcessTree {
    readonly ready: Promise<SupervisorIdentity>;
    readonly closed: Promise<ProcessOutcome>;
    private stopping = false;
    private started = false;
    private ended = false;
    private stopTimer?: ReturnType<typeof setTimeout>;
    private resolveClosed!: (outcome: ProcessOutcome) => void;
    private rejectReady!: (error: Error) => void;
    private outcome: ProcessOutcome = { exitCode: null, signal: null, treeClosed: false, infrastructureFailed: false };

    private constructor(readonly child: ChildProcess, onMessage: (message: unknown) => void, ownerStartTime?: string) {
        let resolveReady!: (identity: SupervisorIdentity) => void;
        this.ready = new Promise((resolve, reject) => { resolveReady = resolve; this.rejectReady = reject; });
        this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
        let pending = '', total = 0, ready = false, exited = false, runnerStarted = false, supervisorStopping = false;
        const timer = setTimeout(() => { this.outcome.infrastructureFailed = true;
            this.rejectReady(new AppError('PROCESS_FAILED', 'The process supervisor did not start within five seconds.')); this.stop(); }, 5000);
        const invalid = (): void => { this.outcome.infrastructureFailed = true; this.stop(); };
        const control = this.control();
        control.on('error', invalid);
        const events = (process.platform === 'win32' ? child.stdout : child.stdio[4]) as NodeJS.ReadableStream;
        events.setEncoding('utf8');
        events.on('data', (text: string) => {
            if ((total += Buffer.byteLength(text)) > 16384 || (pending += text).length > 4096) { invalid(); return; }
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end); pending = pending.slice(end + 1);
                if (process.platform === 'win32') {
                    let event: z.infer<typeof windowsEventSchema>;
                    try { event = windowsEventSchema.parse(JSON.parse(line)); } catch { invalid(); continue; }
                    if (event.type === 'ready') {
                        if (ready || event.supervisor.pid !== child.pid || event.owner.pid !== process.pid || event.owner.creationTime !== ownerStartTime
                            || event.runner.pid === event.supervisor.pid || event.runner.pid === process.pid) { invalid(); continue; }
                        ready = true; clearTimeout(timer);
                        resolveReady({ platform: 'win32', pid: event.supervisor.pid, startTime: event.supervisor.creationTime,
                            guardianPid: event.supervisor.pid, guardianStartTime: event.supervisor.creationTime,
                            runnerPid: event.runner.pid, runnerStartTime: event.runner.creationTime });
                    } else if (event.type === 'started') {
                        if (!ready || runnerStarted || exited) { invalid(); continue; }
                        runnerStarted = true;
                    } else if (event.type === 'runnerExit') {
                        if (!ready || exited) { invalid(); continue; }
                        exited = true; this.outcome.exitCode = event.exitCode;
                    } else if (event.type === 'stopping') {
                        if (supervisorStopping) { invalid(); continue; }
                        supervisorStopping = true;
                        if (['controlError', 'observationError', 'readyTimeout', 'infrastructure'].includes(event.reason)) invalid();
                    } else if (event.type === 'treeClosed') {
                        if (!ready || !exited || !supervisorStopping || this.outcome.treeClosed) { invalid(); continue; }
                        this.outcome.treeClosed = true;
                    } else invalid();
                    continue;
                }
                let event: z.infer<typeof eventSchema>;
                try { event = eventSchema.parse(JSON.parse(line)); } catch { invalid(); continue; }
                if (event.type === 'ready') {
                    if (ready || event.pid !== child.pid) { invalid(); continue; }
                    ready = true; clearTimeout(timer);
                    const { type: _, ...identity } = event;
                    resolveReady(identity);
                } else if (event.type === 'runner_started') {
                    if (!ready || runnerStarted || exited) { invalid(); continue; }
                    runnerStarted = true;
                } else if (event.type === 'runner_exit') {
                    if (exited || (event.exitCode === null) === (event.signal === null)) { invalid(); continue; }
                    exited = true;
                    this.outcome.exitCode = event.exitCode;
                    this.outcome.signal = event.signal === null ? null
                        : Object.entries(osConstants.signals).find(([, number]) => number === event.signal)?.[0] ?? `SIGNAL_${event.signal}`;
                } else if (event.type === 'closed') this.outcome.treeClosed = true;
                else if (event.type === 'closure_failed') invalid();
            }
        });
        events.on('error', invalid);
        child.on('message', onMessage);
        child.on('error', invalid);
        child.on('close', (code, signal) => {
            this.ended = true;
            clearTimeout(timer); clearTimeout(this.stopTimer);
            if (!ready) this.rejectReady(new AppError('PROCESS_FAILED', 'The process supervisor failed to initialize.'));
            if (pending || code !== 0 || signal || !this.outcome.treeClosed) this.outcome.infrastructureFailed = true;
            this.resolveClosed({ ...this.outcome });
        });
    }

    static async launch(options: { directory: string; message: (message: unknown) => void;
        stdout: (stream: NodeJS.ReadableStream) => void; stderr: (stream: NodeJS.ReadableStream) => void },
    runner = fileURLToPath(new URL('./logic-runner.js', import.meta.url))): Promise<ProcessTree> {
        const helper = await supervisorFile();
        try {
            if (process.platform === 'win32') {
                const owner = await processIdentity(process.pid);
                if (!owner?.alive) throw new AppError('PROCESS_FAILED', 'The server process identity could not be established.');
                const child = spawn(helper.absolute,
                    ['--owner', String(process.pid), owner.startTime, '--cwd', options.directory, '--ipc', '--',
                        process.execPath, '--max-old-space-size=256', runner, options.directory], {
                        shell: false, windowsHide: true, cwd: options.directory, env: {}, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                    });
                const tree = new ProcessTree(child, options.message, owner.startTime);
                // The helper's stdout is its lifecycle protocol. Both runner
                // streams are deliberately merged on stderr by the Job helper.
                options.stderr(child.stderr!);
                // Keep the verified executable pinned until initialization; a
                // path replacement cannot win the asynchronous CreateProcess.
                await new Promise<void>(resolve => { child.once('spawn', resolve); child.once('error', () => resolve()); });
                return tree;
            }
            const child = spawn('/proc/self/fd/6', [process.execPath, '--max-old-space-size=256', runner, options.directory], {
                detached: true, shell: false, cwd: options.directory,
                env: { LANG: 'C.UTF-8', TZ: 'UTC', PATH: '', HOME: options.directory, TMPDIR: options.directory },
                stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc', helper.fd],
            });
            const tree = new ProcessTree(child, options.message);
            options.stdout(child.stdout!); options.stderr(child.stderr!);
            return tree;
        } finally { await helper.close(); }
    }
    private control(): NodeJS.WritableStream {
        return (process.platform === 'win32' ? this.child.stdin : this.child.stdio[3]) as NodeJS.WritableStream;
    }
    start(): void {
        if (!this.stopping && !this.ended && !this.started) { this.started = true; this.control().write('G'); }
    }
    stop(): void {
        if (this.stopping || this.ended) return;
        this.stopping = true;
        this.control().end('T');
        this.stopTimer = setTimeout(() => {
            this.outcome.infrastructureFailed = true;
            // Do not kill the reapers and pretend their tree was cleaned. They
            // keep reaping an unkillable kernel task; recovery retains ownership.
            this.resolveClosed({ ...this.outcome, treeClosed: false });
        }, 9750);
    }
}
