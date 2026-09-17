import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { AppError, errorSchema, jobSchema, reportSchema } from './contracts.js';
import type { Job, JobReceipt, Operation, OperationError, OperationInput, WorkerRequest } from './contracts.js';

// Initial readonly slice: POSIX private state, one server-lifetime lock per real
// workspace (all SDK versions must use the same stateRoot). This is not a sandbox
// for project code. Only the fixed tool-owned worker may run in production.
// Private records and request keys are SDK-scoped; storage bounds and the lock
// remain workspace-wide. Version 1 records lack SDK ownership and are rejected
// without modification rather than exposing or assigning them to the current SDK.
// Seven-day retention, at most 64 records, 32 KiB logs / 128 KiB record and an
// 8 MiB metadata snapshot; including its atomic replacement, metadata/log state
// stays below 20 MiB. The worker's separately bounded 64 MiB package snapshot
// plus <=1 MiB validator is removed before another worker starts (<96 MiB total).
// Capacity exhaustion rejects submissions instead of breaking retained keys.
// Deadlines include admission/queue time: 60 seconds by default, 10 minutes max.
// Reports are capped at 48 KiB; overlong log lines are dropped, not partly leaked.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOBS = 64;
const MAX_LOG_BYTES = 32 * 1024;
const MAX_WORKER_LOG_BYTES = MAX_LOG_BYTES - 256;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RETIRED_LOCKS = 128;
const terminal = new Set<Job['state']>(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ownerSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict();
const recordSchema = z.object({
    sdkId: z.string().min(1).max(256), job: jobSchema, requestKeyDigest: digestSchema.nullable(),
    logs: z.object({ text: z.string().max(MAX_WORKER_LOG_BYTES), truncated: z.boolean() }).strict(),
}).strict();
const snapshotSchema = z.object({ version: z.literal(2), records: z.array(recordSchema).max(MAX_JOBS) }).strict();
const messageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('result'), report: reportSchema }).strict(),
    z.object({ type: z.literal('error'), error: errorSchema }).strict(),
    z.object({ type: z.literal('log'), text: z.string().max(MAX_LINE_BYTES) }).strict(),
]);
const requestSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('doctor'), input: z.object({
        project: z.string().min(1).max(1024).optional(), depth: z.enum(['quick', 'full']).default('quick'),
    }).strict() }).strict(),
    z.object({ operation: z.literal('package_validate'), input: z.object({
        directory: z.string().min(1).max(1024), target: z.literal('BILIBILI').default('BILIBILI'),
    }).strict() }).strict(),
]);

type Options = { workspace: string; sdkRoot: string; sdkId: string; stateRoot: string };
type RecordData = z.infer<typeof recordSchema>;
type Outcome = { state: 'succeeded'; report: Job['report'] } | {
    state: 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; error: OperationError;
};
type Pending = { input: OperationInput; timer: ReturnType<typeof setTimeout> };
type Active = { jobId: string; worker: Worker; outcome?: Outcome; invalid: boolean;
    log: { write: (text: string) => void; end: () => void } };

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
function failure(code: OperationError['code'], message: string): OperationError {
    return { code, message, retryable: false, nextSteps: [] };
}
function storageError(): AppError {
    return new AppError('PROCESS_FAILED', 'Private job state could not be persisted. The manager is stopped.');
}
function privateError(): AppError {
    return new AppError('PERMISSION_DENIED', 'Job state must use tool-owned, private, non-symlink paths.');
}
function pidExists(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return !hasCode(error, 'ESRCH'); }
}

function redact(text: string): string {
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/gi, '[REDACTED PRIVATE KEY]')
        .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
        .replace(/((?:["']?)(?:authorization|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]]+)/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
        .replace(/\b(?:gh[pousr]_[a-z0-9_]{10,}|github_pat_[a-z0-9_]{10,}|glpat-[a-z0-9_-]{10,}|sk-[a-z0-9_-]{10,}|AKIA[A-Z0-9]{16})\b/gi, '[REDACTED]')
        .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[REDACTED]');
}

function sanitizedError(error: OperationError): OperationError {
    return errorSchema.parse({ ...error, message: redact(error.message).slice(0, 2048),
        nextSteps: error.nextSteps.map(step => redact(step).slice(0, 512)) });
}

async function privateDirectory(path: string, create = false): Promise<void> {
    if (create) {
        try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) {
        throw privateError();
    }
}

async function readPrivate(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw privateError();
        if (stat.size > maxBytes) throw new AppError('LIMIT_EXCEEDED', 'Private job state exceeds its size limit.');
        // Do not let a file growing after fstat turn a bounded read into readFile().
        const buffer = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > maxBytes) throw new AppError('LIMIT_EXCEEDED', 'Private job state exceeds its size limit.');
        return buffer.toString('utf8', 0, length);
    } finally { await handle.close(); }
}

export class JobManager {
    private readonly options: Options;
    private readonly owner = { pid: process.pid, token: randomUUID() };
    private directory = '';
    private locked = false;
    private ready = false;
    private closing = false;
    private broken = false;
    private records = new Map<string, RecordData>();
    private pending = new Map<string, Pending>();
    private active?: Active;
    private serial: Promise<unknown> = Promise.resolve();
    private closePromise?: Promise<void>;
    private logTimer?: ReturnType<typeof setTimeout>;
    private retentionTimer?: ReturnType<typeof setTimeout>;

    // workerUrl is constructor-only injection for a test subclass using open().
    // It is deliberately absent from Options and every public MCP input.
    constructor(options: Options, private readonly workerUrl = new URL('./worker.js', import.meta.url)) {
        this.options = { ...options };
    }

    static async open(options: Options): Promise<JobManager> {
        const manager = new this(options);
        try {
            await manager.initialize();
            manager.ready = true;
            manager.scheduleRetention();
            return manager;
        } catch (error) {
            await manager.releaseLock().catch(() => {});
            if (error instanceof AppError) throw error;
            throw new AppError('PERMISSION_DENIED', 'Private job state could not be opened safely.');
        }
    }

    private enqueue<T>(action: () => Promise<T>): Promise<T> {
        const next = this.serial.then(action);
        this.serial = next.catch(() => {});
        return next;
    }

    private background(action: () => Promise<void>): void {
        void this.enqueue(async () => { if (!this.broken && !this.closing) await action(); }).catch(() => {});
    }

    private assertOpen(): void {
        if (this.broken) throw storageError();
        if (!this.ready || this.closing) throw new AppError('PROCESS_FAILED', 'The job manager is not open.');
    }

    private async initialize(): Promise<void> {
        if (typeof process.getuid !== 'function') throw privateError();
        const options = z.object({
            workspace: z.string().min(1), sdkRoot: z.string().min(1), sdkId: z.string().min(1).max(256),
            stateRoot: z.string().min(1),
        }).strict().safeParse(this.options);
        if (!options.success || ![this.options.workspace, this.options.sdkRoot, this.options.stateRoot].every(isAbsolute)) {
            throw new AppError('INVALID_ARGUMENTS', 'Canonical absolute workspace, SDK and state paths are required.');
        }
        this.options.workspace = await realpath(this.options.workspace);
        this.options.sdkRoot = await realpath(this.options.sdkRoot);
        this.options.stateRoot = resolve(this.options.stateRoot);
        for (const root of [this.options.workspace, this.options.sdkRoot]) {
            const path = relative(root, this.options.stateRoot);
            if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))) throw privateError();
        }
        // Ancestors may be shared (e.g. root-owned sticky /tmp), but may not be
        // symlinks or replaceable by another unprivileged user.
        let current = parse(this.options.stateRoot).root;
        for (const part of this.options.stateRoot.slice(current.length).split(sep).filter(Boolean)) {
            current = join(current, part);
            try { await lstat(current); } catch (error) {
                if (!hasCode(error, 'ENOENT')) throw error;
                await privateDirectory(current, true);
            }
            const stat = await lstat(current);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid())
                || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))) throw privateError();
        }
        await privateDirectory(this.options.stateRoot);
        this.directory = join(this.options.stateRoot, hash(this.options.workspace));
        await privateDirectory(this.directory, true);
        await this.acquireLock();
        await this.cleanRemnants();
        let contents: string;
        try { contents = await readPrivate(join(this.directory, 'metadata.json'), MAX_SNAPSHOT_BYTES); } catch (error) {
            if (hasCode(error, 'ENOENT')) { await this.cleanStaging(); await this.persist(new Map()); return; }
            throw error;
        }
        const decoded = (() => {
            try { return snapshotSchema.parse(JSON.parse(contents)); } catch {
                throw new AppError('ARTIFACT_INVALID', 'Private job metadata is invalid; it was not overwritten.');
            }
        })();
        const keys = new Set<string>();
        for (const record of decoded.records) {
            if (this.records.has(record.job.jobId) || (record.requestKeyDigest && keys.has(record.requestKeyDigest))
                || byteLength(record) > MAX_RECORD_BYTES || Buffer.byteLength(record.logs.text) > MAX_WORKER_LOG_BYTES) {
                throw new AppError('ARTIFACT_INVALID', 'Private job metadata contains invalid or oversized records.');
            }
            if (record.requestKeyDigest) keys.add(record.requestKeyDigest);
            const job = record.job;
            if (terminal.has(job.state) && (job.finishedAt === null || job.finishedAt < job.createdAt)) {
                throw new AppError('ARTIFACT_INVALID', 'Private job metadata has inconsistent lifecycle fields.');
            }
            if ((job.state === 'succeeded' && (!job.report || job.error !== null))
                || (job.state !== 'succeeded' && job.report !== null)
                || (!terminal.has(job.state) && job.finishedAt !== null)) {
                throw new AppError('ARTIFACT_INVALID', 'Private job metadata has inconsistent outcome fields.');
            }
            if (record.sdkId === this.options.sdkId && !terminal.has(job.state)) {
                record.job = { ...job, state: 'interrupted', phase: 'interrupted', finishedAt: Date.now(), report: null,
                    error: failure('PROCESS_FAILED', 'The previous job owner stopped before this job completed.') };
            }
            this.records.set(job.jobId, record);
        }
        await this.cleanStaging();
        await this.persist(this.retained());
    }

    private async acquireLock(): Promise<void> {
        const lock = join(this.directory, 'lock');
        const claim = join(this.directory, `.claim-${this.owner.pid}-${this.owner.token}`);
        await mkdir(claim, { mode: 0o700 });
        try {
            const file = await open(join(claim, 'owner.json'), 'wx', 0o600);
            try { await file.writeFile(JSON.stringify(this.owner)); await file.sync(); } finally { await file.close(); }
            for (let attempt = 0; attempt < 16; attempt++) {
                try { await privateDirectory(lock); } catch (error) {
                    if (!hasCode(error, 'ENOENT')) throw error;
                    try { await rename(claim, lock); this.locked = true; return; } catch (renameError) {
                        if (!hasCode(renameError, 'EEXIST') && !hasCode(renameError, 'ENOTEMPTY')) throw renameError;
                    }
                }
                let owner: z.infer<typeof ownerSchema>;
                try {
                    await privateDirectory(lock);
                    owner = ownerSchema.parse(JSON.parse(await readPrivate(join(lock, 'owner.json'), 1024)));
                } catch (error) {
                    if (hasCode(error, 'ENOENT')) continue;
                    throw privateError();
                }
                if (pidExists(owner.pid)) throw new AppError('WORKSPACE_BUSY', 'Another live server owns this workspace.', [], true);
                let retired = 0;
                let entries = 0;
                for await (const entry of await opendir(this.directory)) {
                    if (++entries > 300) throw new AppError('LIMIT_EXCEEDED', 'Private state contains too many entries.');
                    if (entry.name.startsWith('.retired-')) retired++;
                    if (retired >= MAX_RETIRED_LOCKS) throw new AppError('LIMIT_EXCEEDED', 'Stale lock recovery history is full; offline state maintenance is required.');
                }
                // Never unlink a checked stale lock: two recoverers could unlink
                // a new live owner. A nonempty, permanently retained tombstone
                // makes rename atomic and non-replacing even for a paused racer.
                // Bounded at 128 recoveries; never auto-delete these tombstones.
                try { await rename(lock, join(this.directory, `.retired-${owner.token}`)); } catch (error) {
                    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error;
                }
            }
            throw new AppError('WORKSPACE_BUSY', 'Workspace ownership changed during lock acquisition.', [], true);
        } finally { await rm(claim, { recursive: true, force: true }); }
    }

    private async releaseLock(): Promise<void> {
        if (!this.locked) return;
        const lock = join(this.directory, 'lock');
        await privateDirectory(lock);
        const owner = ownerSchema.parse(JSON.parse(await readPrivate(join(lock, 'owner.json'), 1024)));
        if (owner.token !== this.owner.token || owner.pid !== this.owner.pid) throw privateError();
        const released = join(this.directory, `.claim-${this.owner.pid}-${this.owner.token}`);
        await rename(lock, released);
        this.locked = false;
        await rm(released, { recursive: true, force: true });
    }

    private async cleanRemnants(): Promise<void> {
        let count = 0;
        for await (const entry of await opendir(this.directory)) {
            if (++count > 300) throw new AppError('LIMIT_EXCEEDED', 'Private state contains too many entries.');
            const path = join(this.directory, entry.name);
            if (entry.name === 'lock' || entry.name === 'metadata.json') continue;
            if (/^staging-[a-f0-9-]{36}$/.test(entry.name)) {
                await privateDirectory(path);
                continue;
            }
            if (/^\.retired-[a-f0-9-]{36}$/.test(entry.name)) {
                await privateDirectory(path);
                ownerSchema.parse(JSON.parse(await readPrivate(join(path, 'owner.json'), 1024)));
                continue;
            }
            const claim = /^\.claim-([1-9][0-9]*)-[a-f0-9-]{36}$/.exec(entry.name);
            if (claim) {
                try {
                    await privateDirectory(path);
                    if (!pidExists(Number(claim[1]))) {
                        for await (const child of await opendir(path)) {
                            if (child.name !== 'owner.json') throw privateError();
                            await readPrivate(join(path, child.name), 1024);
                        }
                        await rm(path, { recursive: true });
                    }
                } catch (error) {
                    // Losing live contenders remove their own claims even while
                    // the new lock owner is scanning startup remnants.
                    if (!hasCode(error, 'ENOENT')) throw error;
                }
                continue;
            }
            if (/^\.metadata-[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
                await readPrivate(path, MAX_SNAPSHOT_BYTES);
                await rm(path);
                continue;
            }
            throw privateError();
        }
    }

    private async cleanupStaging(jobId: string): Promise<void> {
        await privateDirectory(this.options.stateRoot);
        await privateDirectory(this.directory);
        const path = join(this.directory, `staging-${jobId}`);
        try { await privateDirectory(path); } catch (error) {
            if (hasCode(error, 'ENOENT')) return;
            throw error;
        }
        // This namespace is exclusively tool-owned. rm never follows symlink
        // children; a symlink in place of the staging root is rejected above.
        await rm(path, { recursive: true });
    }

    private async cleanStaging(): Promise<void> {
        // The workspace lock excludes workers from every SDK. Remove orphaned
        // staging before another SDK can allocate a snapshot, without recovering
        // or exposing that SDK's jobs until its own manager is opened.
        for await (const entry of await opendir(this.directory)) {
            if (!entry.name.startsWith('staging-')) continue;
            const jobId = entry.name.slice('staging-'.length);
            if (!this.records.has(jobId)) throw new AppError('ARTIFACT_INVALID', 'Staging has no matching retained job; it was not removed.');
            await this.cleanupStaging(jobId);
        }
    }

    private retained(): Map<string, RecordData> {
        const cutoff = Date.now() - RETENTION_MS;
        return new Map([...this.records].filter(([, record]) => record.job.finishedAt === null || record.job.finishedAt >= cutoff));
    }

    private scheduleRetention(): void {
        clearTimeout(this.retentionTimer);
        if (!this.ready || this.closing || this.broken) return;
        const times = [...this.records.values()].flatMap(record => record.job.finishedAt === null ? [] : [record.job.finishedAt]);
        if (!times.length) return;
        this.retentionTimer = setTimeout(() => this.background(() => this.persist(this.retained())),
            Math.max(1, Math.min(...times) + RETENTION_MS + 1 - Date.now()));
        this.retentionTimer.unref();
    }

    private async persist(records: Map<string, RecordData> = this.records): Promise<void> {
        const temporary = join(this.directory, `.metadata-${randomUUID()}.tmp`);
        try {
            for (const record of records.values()) {
                recordSchema.parse(record);
                if (byteLength(record) > MAX_RECORD_BYTES) throw storageError();
            }
            const data = JSON.stringify({ version: 2, records: [...records.values()] });
            if (records.size > MAX_JOBS || Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) throw storageError();
            await privateDirectory(this.options.stateRoot);
            await privateDirectory(this.directory);
            const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
            await rename(temporary, join(this.directory, 'metadata.json'));
            // Publish lifecycle changes only after the atomic write succeeded.
            this.records = records;
            this.scheduleRetention();
        } catch { await this.failStorage(); }
        finally { await rm(temporary, { force: true }).catch(() => {}); }
    }

    private async failStorage(): Promise<never> {
        this.broken = true;
        for (const pending of this.pending.values()) clearTimeout(pending.timer);
        this.pending.clear();
        clearTimeout(this.logTimer);
        clearTimeout(this.retentionTimer);
        for (const record of this.records.values()) {
            if (record.sdkId === this.options.sdkId && !terminal.has(record.job.state)) record.job = { ...record.job, state: 'failed', phase: 'failed',
                finishedAt: Date.now(), report: null, error: failure('PROCESS_FAILED', storageError().message) };
        }
        if (this.active) {
            const active = this.active;
            await active.worker.terminate().catch(() => {});
            this.active = undefined;
            await this.cleanupStaging(active.jobId).catch(() => {});
        }
        throw storageError();
    }

    async submit(operation: Operation, input: OperationInput, requestKey?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JobReceipt> {
        const submittedAt = Date.now();
        const parsed = requestSchema.safeParse({ operation, input });
        if (!parsed.success || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
            || (requestKey !== undefined && (typeof requestKey !== 'string' || !requestKey.length || requestKey.length > 128
                || /[^A-Za-z0-9._-]/.test(requestKey)))) {
            throw new AppError('INVALID_ARGUMENTS', 'Invalid readonly operation, input, request key or deadline (1..600000 ms).');
        }
        const request = parsed.data;
        const requestKeyDigest = requestKey === undefined ? null : hash(JSON.stringify([this.options.sdkId, requestKey]));
        const inputDigest = hash(JSON.stringify({ sdkId: this.options.sdkId, sdkRoot: this.options.sdkRoot, ...request, timeoutMs }));
        return this.enqueue(async () => {
            this.assertOpen();
            const records = this.retained();
            if (requestKeyDigest) {
                const previous = [...records.values()].find(record => record.sdkId === this.options.sdkId && record.requestKeyDigest === requestKeyDigest);
                if (previous) {
                    if (previous.job.inputDigest !== inputDigest) throw new AppError('REQUEST_CONFLICT', 'This request key was used with different parameters.');
                    return { jobId: previous.job.jobId, state: previous.job.state, pollAfterMs: 100 };
                }
            }
            if ([...records.values()].filter(record => record.sdkId === this.options.sdkId && record.job.state === 'queued').length >= 8 || records.size >= MAX_JOBS) {
                throw new AppError('LIMIT_EXCEEDED', 'The workspace queue or seven-day job retention capacity is full.');
            }
            const job: Job = { jobId: randomUUID(), operation, project: 'project' in request.input ? request.input.project ?? null : null, inputDigest,
                state: 'queued', phase: 'queued', createdAt: submittedAt, startedAt: null, finishedAt: null,
                deadline: submittedAt + timeoutMs, error: null, report: null };
            records.set(job.jobId, { sdkId: this.options.sdkId, job, requestKeyDigest, logs: { text: '', truncated: false } });
            await this.persist(records);
            const timer = setTimeout(() => this.background(() => this.stop(job.jobId, 'timed_out')), Math.max(1, job.deadline - Date.now()));
            timer.unref();
            this.pending.set(job.jobId, { input: request.input, timer });
            await this.pump();
            return { jobId: job.jobId, state: this.get(job.jobId).state, pollAfterMs: 100 };
        });
    }

    list(): Job[] {
        return [...this.records.values()].filter(record => record.sdkId === this.options.sdkId).map(record => structuredClone(record.job));
    }

    get(jobId: string): Job {
        const record = this.records.get(jobId);
        if (!record || record.sdkId !== this.options.sdkId) throw new AppError('JOB_NOT_FOUND', 'No retained job has that ID.');
        return structuredClone(record.job);
    }

    logs(jobId: string): { text: string; truncated: boolean } {
        const job = this.get(jobId);
        const logs = this.records.get(jobId)!.logs;
        // Reserve space outside worker output and derive the terminal diagnostic
        // from published state: a failed commit must never log a false success.
        const outcome = terminal.has(job.state) ? `\n[job] ${job.state}${job.error ? ` (${job.error.code})` : ''}\n` : '';
        return { text: logs.text + outcome, truncated: logs.truncated };
    }

    async cancel(jobId: string): Promise<{ jobId: string; state: Job['state']; accepted: boolean }> {
        return this.enqueue(async () => {
            this.assertOpen();
            const job = this.get(jobId);
            if (terminal.has(job.state)) return { jobId, state: job.state, accepted: false };
            await this.stop(jobId, Date.now() >= job.deadline ? 'timed_out' : 'cancelled');
            return { jobId, state: this.get(jobId).state, accepted: true };
        });
    }

    private async update(jobId: string, fields: Partial<Job>): Promise<void> {
        const record = this.records.get(jobId)!;
        const records = new Map(this.records);
        records.set(jobId, { ...record, job: { ...record.job, ...fields } });
        await this.persist(records);
    }

    private async pump(): Promise<void> {
        if (this.active || this.closing || this.broken) return;
        for (const record of this.records.values()) {
            if (record.sdkId !== this.options.sdkId || record.job.state !== 'queued') continue;
            const job = record.job;
            if (Date.now() >= job.deadline) { await this.finish(job.jobId, this.stopOutcome('timed_out')); continue; }
            await this.update(job.jobId, { state: 'running', phase: 'running', startedAt: Date.now() });
            if (this.closing || Date.now() >= job.deadline) {
                await this.finish(job.jobId, this.stopOutcome(this.closing ? 'cancelled' : 'timed_out'));
                continue;
            }
            try {
                const workerData: WorkerRequest = { ...requestSchema.parse({ operation: job.operation, input: this.pending.get(job.jobId)!.input }),
                    workspace: this.options.workspace, sdkRoot: this.options.sdkRoot,
                    staging: join(this.directory, `staging-${job.jobId}`) };
                const worker = new Worker(this.workerUrl, { workerData, stdout: true, stderr: true,
                    // Do not inherit preload hooks or other executable Node flags.
                    execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
                const active: Active = { jobId: job.jobId, worker, invalid: false, log: this.logSink(job.jobId) };
                this.active = active;
                this.capture(job.jobId, worker.stdout);
                this.capture(job.jobId, worker.stderr);
                worker.on('message', (message: unknown) => this.onMessage(active, message));
                worker.on('messageerror', () => this.invalidate(active));
                worker.on('error', () => this.invalidate(active));
                worker.on('exit', (code) => this.background(async () => {
                    if (this.active !== active) return;
                    active.log.end();
                    this.active = undefined;
                    const outcome = code === 0 && !active.invalid && active.outcome ? active.outcome : {
                        state: 'failed' as const, error: failure('PROCESS_FAILED', 'The readonly worker stopped without a valid result.'),
                    };
                    await this.finish(job.jobId, outcome);
                    await this.pump();
                }));
            } catch {
                await this.finish(job.jobId, { state: 'failed', error: failure('PROCESS_FAILED', 'The readonly worker could not be started.') });
                continue;
            }
            return;
        }
    }

    private stopOutcome(state: 'cancelled' | 'timed_out'): Outcome {
        return { state, error: failure(state === 'cancelled' ? 'CANCELLED' : 'TIMEOUT',
            state === 'cancelled' ? 'The job was cancelled.' : 'The job exceeded its deadline, including queue time.') };
    }

    private async stop(jobId: string, state: 'cancelled' | 'timed_out'): Promise<void> {
        const record = this.records.get(jobId);
        if (!record || terminal.has(record.job.state)) return;
        if (this.active?.jobId === jobId) {
            await this.update(jobId, { state: 'cancelling', phase: state });
            const active = this.active;
            await active.worker.terminate();
            active.log.end();
            this.active = undefined;
        }
        await this.finish(jobId, this.stopOutcome(state));
        await this.pump();
    }

    private async finish(jobId: string, outcome: Outcome): Promise<void> {
        const job = this.get(jobId);
        if (terminal.has(job.state)) return;
        try { await this.cleanupStaging(jobId); } catch { await this.failStorage(); }
        const pending = this.pending.get(jobId);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(jobId);
        if (outcome.state !== 'cancelled' && Date.now() >= job.deadline) outcome = this.stopOutcome('timed_out');
        await this.update(jobId, { state: outcome.state, phase: outcome.state, finishedAt: Date.now(),
            report: outcome.state === 'succeeded' ? outcome.report : null,
            error: outcome.state === 'succeeded' ? null : outcome.error });
    }

    private invalidate(active: Active): void {
        active.invalid = true;
        this.background(async () => {
            if (this.active !== active) return;
            await active.worker.terminate();
            active.log.end();
            this.active = undefined;
            await this.finish(active.jobId, { state: 'failed', error: failure('PROCESS_FAILED', 'The readonly worker returned invalid data or failed.') });
            await this.pump();
        });
    }

    private onMessage(active: Active, message: unknown): void {
        if (this.active !== active || active.invalid || this.broken) return;
        const parsed = messageSchema.safeParse(message);
        if (!parsed.success) { this.invalidate(active); return; }
        const data = parsed.data;
        if (data.type === 'log') { active.log.write(data.text.endsWith('\n') ? data.text : `${data.text}\n`); return; }
        if (active.outcome) { this.invalidate(active); return; }
        if (data.type === 'error') {
            active.outcome = { state: 'failed', error: sanitizedError(data.error) };
        } else {
            if (byteLength(data.report) > 48 * 1024) { this.invalidate(active); return; }
            const report = reportSchema.parse({
                summary: redact(data.report.summary).slice(0, 2048),
                validationLevels: data.report.validationLevels.map(level => redact(level).slice(0, 128)),
                items: data.report.items.map(item => ({ ...item, name: redact(item.name).slice(0, 1024), message: redact(item.message).slice(0, 2048),
                    ...(item.code === undefined ? {} : { code: redact(item.code).slice(0, 128) }) })),
            });
            if (byteLength(report) > 48 * 1024) { this.invalidate(active); return; }
            active.outcome = { state: 'succeeded', report };
        }
    }

    private capture(jobId: string, stream: NodeJS.ReadableStream): void {
        const sink = this.logSink(jobId);
        stream.setEncoding('utf8');
        stream.on('data', sink.write);
        stream.on('end', sink.end);
        stream.on('error', () => this.truncateLog(jobId));
    }

    private logSink(jobId: string): { write: (text: string) => void; end: () => void } {
        let line = '';
        let dropping = false;
        let privateKey = false;
        return { write: (chunk: string) => {
            // Consume continuously even after the log budget has been exhausted.
            for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
                const ends = part.endsWith('\n');
                if (!dropping) {
                    if (Buffer.byteLength(line) + Buffer.byteLength(part) > MAX_LINE_BYTES) {
                        if (/-----BEGIN [^-]*PRIVATE KEY-----/i.test(line + part)) privateKey = true;
                        dropping = true; line = ''; this.truncateLog(jobId);
                    } else line += part;
                }
                if (ends) {
                    if (!dropping) {
                        if (/-----BEGIN [^-]*PRIVATE KEY-----/i.test(line)) privateKey = true;
                        if (privateKey) this.appendLog(jobId, '[REDACTED PRIVATE KEY]\n');
                        else this.appendLog(jobId, line);
                        if (/-----END [^-]*PRIVATE KEY-----/i.test(line)) privateKey = false;
                    }
                    line = ''; dropping = false;
                }
            }
        }, end: () => {
            if (line && !dropping) this.appendLog(jobId, privateKey ? '[REDACTED PRIVATE KEY]' : line);
            line = '';
        } };
    }

    private truncateLog(jobId: string): void {
        const record = this.records.get(jobId);
        if (record) { record.logs.truncated = true; this.flushLogsSoon(); }
    }

    private appendLog(jobId: string, text: string): void {
        const record = this.records.get(jobId);
        if (!record || this.broken) return;
        const clean = redact(text);
        if (Buffer.byteLength(record.logs.text) + Buffer.byteLength(clean) > MAX_WORKER_LOG_BYTES) record.logs.truncated = true;
        else record.logs.text += clean;
        this.flushLogsSoon();
    }

    private flushLogsSoon(): void {
        if (this.logTimer || this.broken || this.closing) return;
        this.logTimer = setTimeout(() => {
            this.logTimer = undefined;
            this.background(() => this.persist());
        }, 100);
        this.logTimer.unref();
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        clearTimeout(this.logTimer);
        clearTimeout(this.retentionTimer);
        this.closePromise = this.enqueue(async () => {
            for (const pending of this.pending.values()) clearTimeout(pending.timer);
            this.pending.clear();
            try {
                if (this.active) {
                    await this.active.worker.terminate();
                    this.active.log.end();
                    this.active = undefined;
                }
                const records = new Map(this.records);
                for (const [id, record] of records) {
                    if (record.sdkId === this.options.sdkId && !terminal.has(record.job.state)) records.set(id, { ...record, job: { ...record.job,
                        state: 'cancelled', phase: 'cancelled', finishedAt: Date.now(), report: null,
                        error: failure('CANCELLED', 'The server closed before this job completed.') } });
                }
                if (this.locked) {
                    try { await this.cleanStaging(); } catch { await this.failStorage(); }
                    await this.persist(records);
                }
            } finally { await this.releaseLock(); }
            if (this.broken) throw storageError();
        });
        return this.closePromise;
    }
}
