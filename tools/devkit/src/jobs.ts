import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { AppError, artifactSchema, authorize, errorSchema, gameTimeoutSchema, jobSchema, logicResultSchema, matchesArtifactProvenance, MAX_ARTIFACT_BYTES, operationError, operationRequestSchema, permissionsSchema, previewSchema, releaseIdSchema, reportSchema } from './contracts.js';
import type { Artifact, Job, JobReceipt, LogicExecution, LogicResult, Operation, OperationError, OperationRequest, Permissions, WorkerRequest } from './contracts.js';
import { commitGameOutput } from './game.js';
import { ProcessTree, processIdentity, supervisorIdentitySchema, verifySupervisor, waitForSupervisors, type ProcessOutcome } from './process.js';
import { acquireWindowsPath, enforceWindowsPrivate, hostRealpath as realpath, verifyWindowsTrust, type WindowsPathLease } from './windows-fs.js';

// One server-lifetime lock per real workspace, independent of SDK version.
// Records/keys are SDK-scoped; quotas and ownership remain workspace-wide.
// Fixed workers prepare data only. The parent alone admits supervised trusted
// logic runners and publishes output. Supervision is not a code/network sandbox.
// Metadata v1 lacks SDK ownership and is rejected unchanged, not reassigned.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOBS = 64;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_LOG_BYTES = 256 * 1024 * 1024;
const MAX_WORKER_LOG_BYTES = MAX_LOG_BYTES - 256;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ARTIFACT_STORAGE_BYTES = 512 * 1024 * 1024;
const MAX_ARTIFACTS = 64;
const MAX_RETIRED_LOCKS = 128;
const terminal = new Set<Job['state']>(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ownerSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid(), startTime: z.string().regex(/^\d+$/).optional() }).strict();
const recordSchema = z.object({
    sdkId: z.string().min(1).max(256), job: jobSchema, requestKeyDigest: digestSchema.nullable(),
    executesLogic: z.boolean().default(false), supervisor: supervisorIdentitySchema.optional(),
    logs: z.object({ bytes: z.number().int().min(0).max(MAX_WORKER_LOG_BYTES), generation: z.number().int().nonnegative(), truncated: z.boolean(),
        discardedBytes: z.number().int().nonnegative().nullable().default(null) }).strict(),
}).strict();
const artifactRegistrySchema = z.array(artifactSchema.refine(artifact => artifact.sdkId.length > 0
    && artifact.bytes <= MAX_ARTIFACT_BYTES && artifact.files <= 10000)).max(MAX_ARTIFACTS);
const snapshotSchema = z.object({ version: z.literal(5), records: z.array(recordSchema).max(MAX_JOBS), artifacts: artifactRegistrySchema }).strict();
const registrySnapshotSchema = snapshotSchema.extend({ version: z.literal(4) });
// Existing v2/v3 state contains accepted keys and successful build ownership.
// Migrate both before expiring jobs; inline v2 logs become separate files.
const previousSnapshotSchema = snapshotSchema.omit({ artifacts: true }).extend({ version: z.literal(3) });
const legacySnapshotSchema = z.object({ version: z.literal(2), records: z.array(recordSchema.omit({ executesLogic: true, supervisor: true }).extend({
    logs: z.object({ text: z.string().max(32 * 1024), truncated: z.boolean(), discardedBytes: z.number().int().nonnegative().nullable().default(null) }).strict(),
})).max(MAX_JOBS) }).strict();
const messageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('result'), report: reportSchema }).strict(),
    z.object({ type: z.literal('error'), error: errorSchema, report: reportSchema.optional() }).strict(),
    z.object({ type: z.literal('ready'), preview: previewSchema }).strict(),
    z.object({ type: z.literal('log'), text: z.string().max(MAX_LINE_BYTES) }).strict(),
    z.object({ type: z.literal('execute_logic') }).strict(),
]);
type Options = { workspace: string; sdkRoot: string; sdkId: string; stateRoot: string; permissions?: Permissions; releaseId?: string | null };
type RecordData = z.infer<typeof recordSchema>;
type Outcome = { state: 'succeeded'; report: Job['report'] } | {
    state: 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; error: OperationError; report?: Job['report'];
};
type Pending = { request: OperationRequest; timer: ReturnType<typeof setTimeout> };
type Active = { jobId: string; kind: 'task' | 'preview'; worker: Worker; outcome?: Outcome; invalid: boolean; ready: boolean;
    workerExitCode?: number; logicRequested?: boolean; tree?: ProcessTree; processOutcome?: ProcessOutcome; logicResult?: LogicResult;
    logicDone?: boolean; stopOutcome?: Outcome;
    log: { write: (text: string) => void; end: () => void } };
type LogData = { chunks: Buffer[]; bytes: number; diskBytes: number };
const LOG_BLOCK_BYTES = 64 * 1024;
function logData(bytes: Buffer, diskBytes = bytes.length): LogData {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += LOG_BLOCK_BYTES) chunks.push(bytes.subarray(offset, offset + LOG_BLOCK_BYTES));
    return { chunks, bytes: bytes.length, diskBytes };
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
function renameConflict(error: unknown): boolean {
    // MoveFileEx cannot replace a nonempty directory and Node reports EPERM
    // for that case on Windows instead of POSIX EEXIST/ENOTEMPTY.
    return hasCode(error, 'EEXIST') || hasCode(error, 'ENOTEMPTY') || (process.platform === 'win32' && hasCode(error, 'EPERM'));
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
    let created = false;
    if (create) {
        try { await mkdir(path, { mode: 0o700 }); created = true; } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw privateError();
    if (process.platform === 'win32') {
        if (created) await enforceWindowsPrivate(path);
        await verifyWindowsTrust(path, true);
    } else if (stat.uid !== process.getuid!() || (stat.mode & 0o077)) {
        throw privateError();
    }
}

async function readPrivate(path: string, maxBytes: number): Promise<string> {
    const lease = process.platform === 'win32' ? await acquireWindowsPath(path, { private: true, immutable: true }).catch(error => {
        if (hasCode(error, 'PATH_OUTSIDE_WORKSPACE')) throw privateError();
        throw error;
    }) : undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(lease?.absolute ?? path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o077)))) throw privateError();
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
        await lease?.check();
        return buffer.toString('utf8', 0, length);
    } finally { try { await handle?.close(); } finally { await lease?.close(); } }
}

export class JobManager {
    private readonly options: Options;
    private readonly owner: z.infer<typeof ownerSchema> = { pid: process.pid, token: randomUUID() };
    private directory = '';
    private locked = false;
    private ready = false;
    private closing = false;
    private broken = false;
    private cleanupConfirmed = true;
    private records = new Map<string, RecordData>();
    private artifacts = new Map<string, Artifact>();
    private pending = new Map<string, Pending>();
    private readonly active = new Map<string, Active>();
    private serial: Promise<unknown> = Promise.resolve();
    private closePromise?: Promise<void>;
    private logTimer?: ReturnType<typeof setTimeout>;
    private retentionTimer?: ReturnType<typeof setTimeout>;
    private readonly logData = new Map<string, LogData>();
    private readonly evictedLogs = new Set<string>();
    private readonly encoded = new Map<string, { record: RecordData; logStamp: string; json: string }>();

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
        if (process.platform !== 'win32' && typeof process.getuid !== 'function') throw privateError();
        const options = z.object({
            workspace: z.string().min(1), sdkRoot: z.string().min(1), sdkId: z.string().min(1).max(256),
            stateRoot: z.string().min(1), permissions: permissionsSchema.optional(), releaseId: releaseIdSchema.nullable().optional(),
        }).strict().safeParse(this.options);
        if (!options.success || ![this.options.workspace, this.options.sdkRoot, this.options.stateRoot].every(isAbsolute)) {
            throw new AppError('INVALID_ARGUMENTS', 'Canonical absolute workspace, SDK and state paths are required.');
        }
        this.options.workspace = await realpath(this.options.workspace);
        this.options.permissions = permissionsSchema.parse(this.options.permissions ?? {});
        if ((this.options.permissions.preview || this.options.permissions.executeTests) && this.options.permissions.mode !== 'develop') {
            throw new AppError('PERMISSION_DENIED', 'Preview and test execution require explicit develop permission.');
        }
        if (this.options.permissions.executeTests) await verifySupervisor();
        this.owner.startTime = (await processIdentity(process.pid))?.startTime;
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
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw privateError();
            // The Windows lease verifies the complete chain at the private
            // root. Shared ancestors may allow creating new children without
            // allowing replacement of this already existing owned subtree.
            if (process.platform !== 'win32' && ((stat.uid !== 0 && stat.uid !== process.getuid!())
                || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))))) throw privateError();
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
            try {
                const data: unknown = JSON.parse(contents);
                const current = snapshotSchema.safeParse(data);
                if (current.success) return current.data;
                const registry = registrySnapshotSchema.safeParse(data);
                if (registry.success) return registry.data;
                const previous = previousSnapshotSchema.safeParse(data);
                if (previous.success) return { ...previous.data, artifacts: null };
                const legacy = legacySnapshotSchema.parse(data);
                return { artifacts: null, records: legacy.records.map(record => {
                    const bytes = Buffer.from(record.logs.text);
                    this.logData.set(record.job.jobId, logData(bytes, 0));
                    return { ...record, executesLogic: false, logs: { bytes: bytes.length, generation: 0,
                        truncated: record.logs.truncated, discardedBytes: record.logs.discardedBytes } };
                }) };
            } catch { throw new AppError('ARTIFACT_INVALID', 'Private job metadata is invalid; it was not overwritten.'); }
        })();
        for (const artifact of decoded.artifacts ?? []) {
            if (this.artifacts.has(artifact.artifactId)) throw new AppError('ARTIFACT_INVALID', 'Private artifact registry contains duplicate IDs.');
            this.artifacts.set(artifact.artifactId, artifact);
        }
        await waitForSupervisors(decoded.records.flatMap(record => 'supervisor' in record && record.supervisor ? [record.supervisor] : []));
        const keys = new Set<string>();
        for (const record of decoded.records) {
            if (this.records.has(record.job.jobId) || (record.requestKeyDigest && keys.has(record.requestKeyDigest))
                || byteLength(record) > MAX_RECORD_BYTES) {
                throw new AppError('ARTIFACT_INVALID', 'Private job metadata contains invalid or oversized records.');
            }
            if (record.requestKeyDigest) keys.add(record.requestKeyDigest);
            const job = record.job;
            if (job.report?.artifacts?.length && (job.operation !== 'game_build' || job.state !== 'succeeded'
                || job.report.artifacts.length !== 1 || job.report.artifacts[0].artifactId !== job.jobId
                || job.report.artifacts[0].sdkId !== record.sdkId || job.report.artifacts[0].bytes > MAX_ARTIFACT_BYTES
                || job.report.artifacts[0].files > 10000)) {
                throw new AppError('ARTIFACT_INVALID', 'Private artifact metadata has inconsistent ownership.');
            }
            const artifact = job.report?.artifacts?.[0];
            if (artifact?.provenance && !matchesArtifactProvenance(artifact, job.report?.profile, job.releaseId)) {
                throw new AppError('ARTIFACT_INVALID', 'Private artifact provenance disagrees with its producing job.');
            }
            const registered = this.artifacts.get(job.jobId);
            if (registered && (job.operation !== 'game_build' || job.state !== 'succeeded'
                || JSON.stringify(registered) !== JSON.stringify(artifact))) {
                throw new AppError('ARTIFACT_INVALID', 'Private artifact registry disagrees with its retained build.');
            }
            if (artifact && decoded.artifacts === null) this.artifacts.set(artifact.artifactId, artifact);
            if (terminal.has(job.state) && (job.finishedAt === null || job.finishedAt < job.createdAt)) {
                throw new AppError('ARTIFACT_INVALID', 'Private job metadata has inconsistent lifecycle fields.');
            }
            if ((job.state === 'succeeded' && (!job.report || job.error !== null))
                || (!['succeeded', 'failed'].includes(job.state) && job.report !== null)
                || (job.state !== 'succeeded' && job.report?.artifacts?.length)
                || (!terminal.has(job.state) && job.finishedAt !== null)) {
                throw new AppError('ARTIFACT_INVALID', 'Private job metadata has inconsistent outcome fields.');
            }
            if (record.sdkId === this.options.sdkId && !terminal.has(job.state)) {
                record.job = { ...job, state: 'interrupted', phase: 'interrupted', finishedAt: Date.now(), report: null,
                    error: failure('PROCESS_FAILED', job.phase === 'committing'
                        ? 'The previous owner stopped during publication. Project output may exist; inspect it before retrying. Unregistered private artifacts are preserved for manual inspection.'
                        : 'The previous job owner stopped before this job completed.') };
            }
            this.records.set(job.jobId, record);
            if (!this.logData.has(job.jobId)) {
                let bytes = Buffer.alloc(0);
                try { bytes = Buffer.from(await readPrivate(join(this.directory, `log-${job.jobId}.txt`), MAX_WORKER_LOG_BYTES)); }
                catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
                // An interrupted flush may have appended more than the last
                // metadata commit. Keep those bytes, but do not invent counters.
                if (record.logs.generation && record.logs.bytes === 0 && bytes.length) {
                    this.evictedLogs.add(job.jobId); bytes = Buffer.alloc(0);
                }
                if (bytes.length !== record.logs.bytes) {
                    record.logs.generation++; record.logs.bytes = bytes.length; record.logs.discardedBytes = null; record.logs.truncated = true;
                }
                this.logData.set(job.jobId, logData(bytes));
            }
        }
        if ([...this.records.values()].reduce((sum, record) => sum + record.logs.bytes, 0) > MAX_WORKSPACE_LOG_BYTES) {
            throw new AppError('LIMIT_EXCEEDED', 'Retained workspace logs exceed 256 MiB.');
        }
        await this.cleanStaging();
        await this.persist(this.retained());
    }

    private async acquireLock(): Promise<void> {
        const lock = join(this.directory, 'lock');
        const claim = join(this.directory, `.claim-${this.owner.pid}-${this.owner.token}`);
        await privateDirectory(claim, true);
        try {
            const file = await open(join(claim, 'owner.json'), 'wx', 0o600);
            try {
                if (process.platform === 'win32') await enforceWindowsPrivate(join(claim, 'owner.json'));
                await file.writeFile(JSON.stringify(this.owner)); await file.sync();
            } finally { await file.close(); }
            for (let attempt = 0; attempt < 16; attempt++) {
                try { await privateDirectory(lock); } catch (error) {
                    if (!hasCode(error, 'ENOENT')) throw error;
                    try { await rename(claim, lock); this.locked = true; return; } catch (renameError) {
                        if (!renameConflict(renameError)) throw renameError;
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
                const identity = await processIdentity(owner.pid);
                if (identity?.alive && (!owner.startTime || identity.startTime === owner.startTime)) throw new AppError('WORKSPACE_BUSY', 'Another live server owns this workspace.', [], true);
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
                    if (!hasCode(error, 'ENOENT') && !renameConflict(error)) throw error;
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
            if (/^log-[a-f0-9-]{36}\.txt$/.test(entry.name)) continue;
            if (/^artifact-[a-f0-9-]{36}$/.test(entry.name)) { await privateDirectory(path); continue; }
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

    private async persist(records: Map<string, RecordData> = this.records, artifacts = this.artifacts): Promise<void> {
        const temporary = join(this.directory, `.metadata-${randomUUID()}.tmp`);
        try {
            await this.flushLogFiles(records);
            const parts: string[] = [];
            for (const record of records.values()) {
                record.job.discardedLogBytes = record.logs.discardedBytes;
                const logStamp = `${record.logs.bytes}:${record.logs.generation}:${record.logs.truncated}:${record.logs.discardedBytes}`;
                let cached = this.encoded.get(record.job.jobId);
                if (!cached || cached.record !== record || cached.logStamp !== logStamp) {
                    recordSchema.parse(record);
                    const json = JSON.stringify(record);
                    if (Buffer.byteLength(json) > MAX_RECORD_BYTES) throw storageError();
                    cached = { record, logStamp, json };
                    this.encoded.set(record.job.jobId, cached);
                }
                parts.push(cached.json);
            }
            const registry = artifactRegistrySchema.parse([...artifacts.values()]);
            const data = `{"version":5,"records":[${parts.join(',')}],"artifacts":${JSON.stringify(registry)}}`;
            if (records.size > MAX_JOBS || Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) throw storageError();
            await privateDirectory(this.options.stateRoot);
            await privateDirectory(this.directory);
            const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                if (process.platform === 'win32') await enforceWindowsPrivate(temporary);
                await file.writeFile(data); await file.sync();
            } finally { await file.close(); }
            await rename(temporary, join(this.directory, 'metadata.json'));
            // Publish lifecycle changes only after the atomic write succeeded.
            this.records = records;
            this.artifacts = artifacts;
            for (const id of this.logData.keys()) if (!records.has(id)) {
                await rm(join(this.directory, `log-${id}.txt`), { force: true });
                this.logData.delete(id); this.encoded.delete(id);
            }
            // Delivered artifacts outlive job metadata. An unreferenced artifact
            // can also be a successful publication whose metadata write crashed.
            this.scheduleRetention();
        } catch { await this.failStorage(); }
        finally { await rm(temporary, { force: true }).catch(() => {}); }
    }

    private async flushLogFiles(records: Map<string, RecordData>): Promise<void> {
        // Free evicted disk space before allocating replacement logs. Metadata
        // keeps keys/outcomes independently; a crash here only loses log bytes.
        for (const id of this.evictedLogs) {
            await rm(join(this.directory, `log-${id}.txt`), { force: true });
            this.evictedLogs.delete(id);
        }
        for (const [id, data] of this.logData) {
            if (!records.has(id) || data.diskBytes >= data.bytes) continue;
            const target = data.bytes;
            const filename = join(this.directory, `log-${id}.txt`);
            let lease: WindowsPathLease | undefined;
            let file: Awaited<ReturnType<typeof open>> | undefined;
            try {
                if (process.platform === 'win32') {
                    try { lease = await acquireWindowsPath(filename, { private: true }); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
                    // Creation is exclusive; an injected replacement is never
                    // followed before the new private log is pinned.
                    if (!lease) {
                        await (await open(filename, 'wx', 0o600)).close();
                        await enforceWindowsPrivate(filename);
                        lease = await acquireWindowsPath(filename, { private: true });
                    }
                }
                file = await open(lease?.absolute ?? filename,
                    constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
                const stat = await file.stat();
                if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o077)))
                    || stat.size !== data.diskBytes) throw privateError();
                while (data.diskBytes < target) {
                    const index = Math.floor(data.diskBytes / LOG_BLOCK_BYTES);
                    const offset = data.diskBytes % LOG_BLOCK_BYTES;
                    const length = Math.min(target - data.diskBytes, data.chunks[index].length - offset);
                    const { bytesWritten } = await file.write(data.chunks[index], offset, length, data.diskBytes);
                    if (!bytesWritten) throw storageError();
                    data.diskBytes += bytesWritten;
                }
                await file.sync();
                await lease?.check();
            } finally { try { await file?.close(); } finally { await lease?.close(); } }
        }
    }

    private async failStorage(): Promise<never> {
        this.broken = true;
        for (const pending of this.pending.values()) clearTimeout(pending.timer);
        this.pending.clear();
        clearTimeout(this.logTimer);
        clearTimeout(this.retentionTimer);
        const activeJobs = [...this.active.values()];
        for (const active of activeJobs) active.tree?.stop();
        await Promise.all(activeJobs.map(async active => {
            const exitCode = active.workerExitCode ?? await active.worker.terminate().catch(() => null);
            const runner = active.tree ? await active.tree.closed : undefined;
            if (runner && !runner.treeClosed) this.cleanupConfirmed = false;
            active.log.end();
            const record = this.records.get(active.jobId);
            if (record) record.job = { ...record.job, exitCode: record.executesLogic ? runner?.exitCode ?? null : exitCode,
                signal: runner?.signal ?? null, workerExitCode: exitCode };
            this.active.delete(active.jobId);
            if (!runner || runner.treeClosed) await this.cleanupStaging(active.jobId).catch(() => {});
        }));
        for (const record of this.records.values()) {
            if (record.sdkId === this.options.sdkId && !terminal.has(record.job.state)) {
                const stop = activeJobs.find(active => active.jobId === record.job.jobId)?.stopOutcome;
                record.job = { ...record.job, state: stop?.state ?? 'failed', phase: stop?.state ?? 'failed',
                    finishedAt: Date.now(), report: null,
                    error: stop && stop.state !== 'succeeded' ? stop.error : failure('PROCESS_FAILED', storageError().message) };
            }
        }
        throw storageError();
    }

    async submit(operation: Operation, input: OperationRequest['input'], requestKey?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JobReceipt> {
        const submittedAt = Date.now();
        const parsed = operationRequestSchema.safeParse({ operation, input });
        const maximum = operation === 'preview_start' ? 7260000
            : operation === 'project_check' || operation === 'game_build' ? gameTimeoutSchema.removeDefault().maxValue! : MAX_TIMEOUT_MS;
        if (!parsed.success || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum
            || (!['doctor', 'package_validate'].includes(operation) && requestKey === undefined)
            || (requestKey !== undefined && (typeof requestKey !== 'string' || !requestKey.length || requestKey.length > 128
                || /[^A-Za-z0-9._-]/.test(requestKey)))) {
            throw new AppError('INVALID_ARGUMENTS', 'Invalid operation, input, request key or deadline.');
        }
        const request = parsed.data;
        if (request.operation === 'project_check') request.input.checks.sort();
        authorize(request, this.options.permissions ?? permissionsSchema.parse({}));
        const releaseId = this.options.releaseId ?? null;
        const requestKeyDigest = requestKey === undefined ? null : hash(JSON.stringify(releaseId
            ? [this.options.sdkId, releaseId, requestKey] : [this.options.sdkId, requestKey]));
        const inputDigest = hash(JSON.stringify({ sdkId: this.options.sdkId,
            ...(releaseId ? { releaseId } : { sdkRoot: this.options.sdkRoot }), ...request, timeoutMs }));
        return this.enqueue(async () => {
            this.assertOpen();
            const records = this.retained();
            if (requestKeyDigest) {
                const previous = [...records.values()].find(record => record.sdkId === this.options.sdkId
                    && record.job.releaseId === releaseId && record.requestKeyDigest === requestKeyDigest);
                if (previous) {
                    if (previous.job.inputDigest !== inputDigest) throw new AppError('REQUEST_CONFLICT', 'This request key was used with different parameters.');
                    return { jobId: previous.job.jobId, state: previous.job.state, pollAfterMs: 100 };
                }
            }
            if ([...records.values()].filter(record => record.sdkId === this.options.sdkId && record.job.state === 'queued').length >= 8 || records.size >= MAX_JOBS) {
                throw new AppError('LIMIT_EXCEEDED', 'The workspace queue or seven-day job retention capacity is full.');
            }
            if (request.operation === 'preview_start') {
                const artifact = this.artifact(request.input.artifactId);
                if (artifact.target !== 'HTML5' || artifact.entry !== 'index.html') {
                    throw new AppError('UNSUPPORTED_PROJECT', 'Browser preview requires an HTML5 artifact with an index.html entry.');
                }
                if ([...records.values()].some(({ job, sdkId }) => sdkId === this.options.sdkId && job.operation === 'preview_start' && !terminal.has(job.state))) {
                    throw new AppError('WORKSPACE_BUSY', 'Stop the existing workspace preview before starting another.', [], true);
                }
            }
            const job: Job = { jobId: randomUUID(), releaseId, operation, project: 'project' in request.input ? request.input.project ?? null
                : request.operation === 'project_create' ? request.input.directory : null, inputDigest,
                state: 'queued', phase: 'queued', createdAt: submittedAt, startedAt: null, finishedAt: null,
                deadline: submittedAt + timeoutMs, error: null, report: null, exitCode: null, signal: null, workerExitCode: null, discardedLogBytes: 0 };
            records.set(job.jobId, { sdkId: this.options.sdkId, job, requestKeyDigest,
                executesLogic: request.operation === 'project_check' && request.input.checks.includes('logic'),
                logs: { bytes: 0, generation: 0, truncated: false, discardedBytes: 0 } });
            await this.persist(records);
            const timer = setTimeout(() => this.background(() => this.stop(job.jobId, 'timed_out')), Math.max(1, job.deadline - Date.now()));
            timer.unref();
            this.pending.set(job.jobId, { request, timer });
            await this.pump();
            return { jobId: job.jobId, state: this.get(job.jobId).state, pollAfterMs: 100 };
        });
    }

    list(): Job[] {
        return [...this.records.values()].filter(record => record.sdkId === this.options.sdkId).map(record => this.get(record.job.jobId));
    }

    get(jobId: string): Job {
        const record = this.records.get(jobId);
        if (!record || record.sdkId !== this.options.sdkId) throw new AppError('JOB_NOT_FOUND', 'No retained job has that ID.');
        return structuredClone({ ...record.job, discardedLogBytes: record.logs.discardedBytes });
    }

    artifact(artifactId: string): Artifact {
        const artifact = this.artifacts.get(artifactId);
        if (!artifact || artifact.sdkId !== this.options.sdkId) {
            throw new AppError('ARTIFACT_INVALID', 'No published artifact is registered with this ID in the authorized SDK/workspace.');
        }
        return structuredClone(artifact);
    }

    logs(jobId: string): { text: string; truncated: boolean; discardedLogBytes: number | null } {
        const info = this.logInfo(jobId);
        return { text: this.logBytes(jobId, 0, info.totalBytes).toString('utf8'), truncated: info.truncated, discardedLogBytes: info.discardedLogBytes };
    }

    logInfo(jobId: string): { totalBytes: number; generation: number; truncated: boolean; discardedLogBytes: number | null } {
        const record = this.records.get(jobId);
        if (!record || record.sdkId !== this.options.sdkId) throw new AppError('JOB_NOT_FOUND', 'No retained job has that ID.');
        return { totalBytes: record.logs.bytes + Buffer.byteLength(this.logOutcome(record.job)), generation: record.logs.generation,
            truncated: record.logs.truncated, discardedLogBytes: record.logs.discardedBytes };
    }

    private logOutcome(job: Job): string {
        return terminal.has(job.state) ? `\n[job] ${job.state}${job.error ? ` (${job.error.code})` : ''}\n` : '';
    }

    logBytes(jobId: string, start: number, length: number): Buffer {
        const info = this.logInfo(jobId);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > info.totalBytes) {
            throw new AppError('CURSOR_INVALID', 'Log cursor is outside the retained range.');
        }
        const data = this.logData.get(jobId);
        const bytes = data?.bytes ?? 0;
        const end = Math.min(start + length, info.totalBytes);
        const parts: Buffer[] = [];
        for (let offset = start; data && offset < Math.min(end, bytes);) {
            const index = Math.floor(offset / LOG_BLOCK_BYTES);
            const chunkEnd = Math.min((index + 1) * LOG_BLOCK_BYTES, end, bytes);
            parts.push(data.chunks[index].subarray(offset % LOG_BLOCK_BYTES, offset % LOG_BLOCK_BYTES + chunkEnd - offset));
            offset = chunkEnd;
        }
        if (end > bytes) parts.push(Buffer.from(this.logOutcome(this.records.get(jobId)!.job)).subarray(Math.max(start - bytes, 0), end - bytes));
        return Buffer.concat(parts);
    }

    async cancel(jobId: string): Promise<{ jobId: string; state: Job['state']; accepted: boolean }> {
        // Signal promptly even when a durable metadata write is awaiting I/O.
        // The serialized transition below decides whether cancellation is accepted.
        this.assertOpen();
        const current = this.get(jobId);
        const active = this.active.get(jobId);
        if (active && current.phase !== 'committing' && !active.stopOutcome) {
            active.stopOutcome = this.stopOutcome(Date.now() >= current.deadline ? 'timed_out' : 'cancelled');
            active.tree?.stop();
        }
        return this.enqueue(async () => {
            this.assertOpen();
            const job = this.get(jobId);
            if (terminal.has(job.state)) return { jobId, state: job.state, accepted: active?.stopOutcome !== undefined };
            if (job.state === 'cancelling') return { jobId, state: job.state, accepted: false };
            await this.stop(jobId, Date.now() >= job.deadline ? 'timed_out' : 'cancelled');
            return { jobId, state: this.get(jobId).state, accepted: true };
        });
    }

    private async update(jobId: string, fields: Partial<Job>): Promise<void> {
        const record = this.records.get(jobId)!;
        const records = new Map(this.records);
        records.set(jobId, { ...record, job: { ...record.job, ...fields } });
        const artifacts = new Map(this.artifacts);
        if (fields.state === 'succeeded' && record.job.operation === 'game_build' && fields.report?.artifacts?.[0]) {
            const artifact = fields.report.artifacts[0];
            artifacts.set(artifact.artifactId, artifact);
        }
        // Ownership and the successful job become visible in the same commit.
        await this.persist(records, artifacts);
    }

    private async pump(): Promise<void> {
        if (this.closing || this.broken) return;
        for (const record of this.records.values()) {
            if (record.sdkId !== this.options.sdkId || record.job.state !== 'queued') continue;
            const job = record.job;
            const kind = job.operation === 'preview_start' ? 'preview' : 'task';
            if ([...this.active.values()].some(active => active.kind === kind)) continue;
            if (Date.now() >= job.deadline) { await this.finish(job.jobId, this.stopOutcome('timed_out')); continue; }
            await this.update(job.jobId, { state: 'running', phase: 'running', startedAt: Date.now() });
            if (this.closing || Date.now() >= job.deadline) {
                await this.finish(job.jobId, this.stopOutcome(this.closing ? 'cancelled' : 'timed_out'));
                continue;
            }
            try {
                const request = this.pending.get(job.jobId)!.request;
                const workerData: WorkerRequest = { ...request,
                    workspace: this.options.workspace, sdkRoot: this.options.sdkRoot,
                    staging: join(this.directory, `staging-${job.jobId}`), permissions: this.options.permissions,
                    expectedSdkId: this.options.sdkId, artifactsRoot: this.directory, artifactId: job.jobId,
                    releaseId: job.releaseId,
                    ...(request.operation === 'preview_start' ? { artifact: this.artifact(request.input.artifactId) } : {}) };
                const worker = new Worker(this.workerUrl, { workerData, stdout: true, stderr: true,
                    // Do not inherit preload hooks or other executable Node flags.
                    execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: kind === 'preview' ? 128 : 512, maxYoungGenerationSizeMb: 16 } });
                const active: Active = { jobId: job.jobId, kind, worker, invalid: false, ready: false, log: this.logSink(job.jobId) };
                this.active.set(job.jobId, active);
                this.capture(job.jobId, worker.stdout);
                this.capture(job.jobId, worker.stderr);
                worker.on('message', (message: unknown) => this.onMessage(active, message));
                worker.on('messageerror', () => this.invalidate(active));
                worker.on('error', () => this.invalidate(active));
                worker.on('exit', code => {
                    active.workerExitCode = code;
                    active.log.end();
                    if (active.logicRequested && !active.logicDone) { active.invalid = true; active.tree?.stop(); }
                    this.background(() => this.settle(active));
                });
            } catch {
                await this.finish(job.jobId, { state: 'failed', error: failure('PROCESS_FAILED', 'The worker could not be started.') });
                continue;
            }
        }
    }

    private stopOutcome(state: 'cancelled' | 'timed_out'): Outcome {
        return { state, error: failure(state === 'cancelled' ? 'CANCELLED' : 'TIMEOUT',
            state === 'cancelled' ? 'The job was cancelled.' : 'The job exceeded its deadline, including queue time.') };
    }

    private async stop(jobId: string, state: 'cancelled' | 'timed_out'): Promise<void> {
        const record = this.records.get(jobId);
        if (!record || terminal.has(record.job.state)) return;
        const active = this.active.get(jobId);
        if (active) {
            active.stopOutcome ??= this.stopOutcome(state);
            active.tree?.stop();
            await this.update(jobId, { state: 'cancelling', phase: active.stopOutcome.state });
            active.workerExitCode ??= await active.worker.terminate();
            active.log.end();
            await this.settle(active);
        } else {
            await this.finish(jobId, this.stopOutcome(state));
            await this.pump();
        }
    }

    private async settle(active: Active): Promise<void> {
        if (this.active.get(active.jobId) !== active || active.workerExitCode === undefined || (active.logicRequested && !active.logicDone)) return;
        if (active.tree && !active.processOutcome?.treeClosed) {
            // Keep ownership and staging when cleanup cannot be confirmed.
            await this.failStorage();
        }
        this.active.delete(active.jobId);
        const outcome = active.stopOutcome ?? (active.workerExitCode === 0 && !active.invalid && active.outcome
            ? active.outcome : { state: 'failed' as const, error: failure('PROCESS_FAILED', 'The worker or process supervisor stopped without a valid result.') });
        await this.finish(active.jobId, outcome, active.workerExitCode, active.processOutcome);
        await this.pump();
    }

    private async executeLogic(active: Active): Promise<void> {
        const request = this.pending.get(active.jobId)?.request;
        if (active.logicRequested || active.outcome || request?.operation !== 'project_check' || !request.input.checks.includes('logic')
            || !this.options.permissions?.executeTests) { this.invalidate(active); return; }
        active.logicRequested = true;
        try {
            const tree = await ProcessTree.launch({ directory: join(this.directory, `staging-${active.jobId}`, 'logic'),
                stdout: stream => this.capture(active.jobId, stream), stderr: stream => this.capture(active.jobId, stream),
                message: message => {
                    const parsed = z.object({ type: z.literal('logic_result'), result: logicResultSchema }).strict().safeParse(message);
                    if (!parsed.success || active.logicResult || byteLength(parsed.data.result) > 24 * 1024) { this.invalidate(active); return; }
                    active.logicResult = parsed.data.result;
                } });
            active.tree = tree;
            // Set observations outside the serial queue so close/storage failure
            // can wait for cleanup without deadlocking on its own queued callback.
            void tree.closed.then(outcome => {
                active.processOutcome = outcome; active.logicDone = true;
                if (outcome.infrastructureFailed) active.invalid = true;
                this.background(async () => {
                    if (this.active.get(active.jobId) !== active) return;
                    const error = outcome.infrastructureFailed || !active.logicResult
                        ? failure('PROCESS_FAILED', 'The logic runner or its supervisor did not produce a valid, fully reaped result.')
                        : outcome.exitCode !== 0 || outcome.signal || active.logicResult.summary.failed
                            ? failure('TEST_FAILED', 'node:test reported failing logic tests.') : null;
                    const result: LogicExecution = { exitCode: outcome.exitCode, signal: outcome.signal,
                        result: active.logicResult ?? null, error };
                    if (active.workerExitCode === undefined && !active.stopOutcome && !active.invalid) active.worker.postMessage(result);
                    else if (active.workerExitCode === undefined && !active.stopOutcome) {
                        // An infrastructure failure is still a reportable failed
                        // job, never an unobserved wait on the worker's IPC port.
                        active.worker.postMessage(result);
                    }
                    await this.settle(active);
                });
            });
            const identity = await tree.ready;
            const record = this.records.get(active.jobId)!;
            const records = new Map(this.records);
            records.set(active.jobId, { ...record, supervisor: identity, job: { ...record.job, phase: 'logic' } });
            await this.persist(records);
            if (this.closing || active.stopOutcome || active.workerExitCode !== undefined || Date.now() >= record.job.deadline) tree.stop();
            else tree.start();
        } catch {
            active.invalid = true;
            if (active.tree) active.tree.stop(); else active.logicDone = true;
            void active.worker.terminate();
        }
    }

    private async finish(jobId: string, outcome: Outcome, workerExitCode: number | null = null, runner?: ProcessOutcome): Promise<void> {
        const job = this.get(jobId);
        if (terminal.has(job.state)) return;
        const pending = this.pending.get(jobId);
        if (outcome.state !== 'cancelled' && Date.now() >= job.deadline) outcome = this.stopOutcome('timed_out');
        if (outcome.state === 'succeeded' && pending && ['project_create', 'game_build'].includes(job.operation)) {
            // Cancellation is serialized with this commit. Once publication starts,
            // later cancel calls wait for the durable outcome and return accepted=false.
            if (this.closing) outcome = this.stopOutcome('cancelled');
            else {
                await this.update(jobId, { phase: 'committing' });
                try {
                    if (this.closing) throw new AppError('CANCELLED', 'The server closed before publication started.');
                    if (Date.now() >= job.deadline) throw new AppError('TIMEOUT', 'The job deadline expired before publication started.');
                    if (job.operation === 'game_build') {
                        const present = new Set<string>();
                        let count = 0;
                        for await (const entry of await opendir(this.directory)) {
                            if (++count > 300) throw new AppError('LIMIT_EXCEEDED', 'Private state contains too many entries.');
                            const match = /^artifact-([a-f0-9-]{36})$/.exec(entry.name);
                            if (!match) continue;
                            await privateDirectory(join(this.directory, entry.name));
                            if (!this.artifacts.has(match[1])) {
                                throw new AppError('ARTIFACT_INVALID', 'Unregistered published output prevents safe artifact quota accounting.',
                                    ['Stop the server and inspect or move unregistered artifact directories outside private state before building again.']);
                            }
                            present.add(match[1]);
                        }
                        // Only the user can remove delivered output. Reconcile absent
                        // directories without resurrecting ownership from old jobs.
                        const artifacts = new Map([...this.artifacts].filter(([id]) => present.has(id)));
                        if (artifacts.size !== this.artifacts.size) await this.persist(this.records, artifacts);
                        const bytes = [...artifacts.values()].reduce((sum, artifact) => sum + artifact.bytes, 0);
                        const added = outcome.report?.artifacts?.reduce((sum, artifact) => sum + artifact.bytes, 0) ?? 0;
                        if (added > MAX_ARTIFACT_BYTES || bytes + added > MAX_ARTIFACT_STORAGE_BYTES || artifacts.size >= MAX_ARTIFACTS) {
                            throw new AppError('LIMIT_EXCEEDED', 'Private artifacts are limited to 128 MiB each, 512 MiB and 64 outputs per workspace.',
                                ['Stop the server and move unneeded artifacts outside private state to free their quota; delivered files are never auto-deleted.']);
                        }
                    }
                    if (this.closing) throw new AppError('CANCELLED', 'The server closed before publication started.');
                    if (Date.now() >= job.deadline) throw new AppError('TIMEOUT', 'The job deadline expired before publication started.');
                    await commitGameOutput({ workspace: this.options.workspace, staging: join(this.directory, `staging-${jobId}`), releaseId: job.releaseId,
                        artifactsRoot: this.directory }, pending.request, outcome.report!);
                    const target = outcome.report!.artifacts?.[0]?.target;
                    outcome.report = { ...outcome.report!, summary: job.operation === 'project_create'
                        ? 'Editable SDK project published without replacing any existing destination.'
                        : target !== 'HTML5'
                            ? `${target} source-package artifact published; source-package preflight only. Vendor compilation, publishing, browser, Creator and device validation were not performed.`
                            : `${target} game artifact published. Browser, Creator and device validation were not performed.`,
                    validationLevels: [...outcome.report!.validationLevels, 'atomicPublication'] };
                } catch (error) {
                    const diagnostic = sanitizedError(operationError(error));
                    outcome = { state: diagnostic.code === 'TIMEOUT' ? 'timed_out' : diagnostic.code === 'CANCELLED' ? 'cancelled' : 'failed', error: diagnostic };
                }
            }
        }
        try { await this.cleanupStaging(jobId); } catch { await this.failStorage(); }
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(jobId);
        await this.update(jobId, { state: outcome.state, phase: outcome.state, finishedAt: Date.now(),
            exitCode: this.records.get(jobId)!.executesLogic ? runner?.exitCode ?? null : workerExitCode,
            signal: runner?.signal ?? null, workerExitCode, discardedLogBytes: this.records.get(jobId)!.logs.discardedBytes,
            report: outcome.report ?? null,
            error: outcome.state === 'succeeded' ? null : outcome.error });
    }

    private invalidate(active: Active): void {
        active.invalid = true;
        active.tree?.stop();
        void active.worker.terminate();
    }

    private onMessage(active: Active, message: unknown): void {
        if (this.active.get(active.jobId) !== active || active.invalid || this.broken) return;
        const parsed = messageSchema.safeParse(message);
        if (!parsed.success) { this.invalidate(active); return; }
        const data = parsed.data;
        if (data.type === 'log') { active.log.write(data.text.endsWith('\n') ? data.text : `${data.text}\n`); return; }
        if (data.type === 'execute_logic') { this.background(() => this.executeLogic(active)); return; }
        if (active.outcome) { this.invalidate(active); return; }
        if (data.type === 'ready') {
            const request = this.pending.get(active.jobId)?.request;
            const url = new URL(data.preview.url);
            if (active.kind !== 'preview' || active.ready || request?.operation !== 'preview_start'
                || data.preview.artifactId !== request.input.artifactId || url.origin !== `http://127.0.0.1:${data.preview.port}`
                || !/^\/[a-f0-9]{64}\/$/.test(url.pathname) || url.search || url.hash || url.username || url.password
                || data.preview.expiresAt > this.get(active.jobId).deadline || data.preview.expiresAt <= Date.now()) {
                this.invalidate(active); return;
            }
            active.ready = true;
            this.background(async () => {
                if (this.active.get(active.jobId) === active) await this.update(active.jobId, { phase: 'ready', preview: data.preview });
            });
            return;
        }
        let report: Job['report'] = null;
        if (data.report) {
            if (byteLength(data.report) > 48 * 1024 || (data.report.artifacts?.length
                && (data.type !== 'result' || this.get(active.jobId).operation !== 'game_build'
                    || data.report.artifacts.length !== 1 || data.report.artifacts[0].artifactId !== active.jobId
                    || data.report.artifacts[0].sdkId !== this.options.sdkId
                    || !matchesArtifactProvenance(data.report.artifacts[0], data.report.profile, this.get(active.jobId).releaseId)))) { this.invalidate(active); return; }
            report = reportSchema.parse({ ...data.report,
                summary: redact(data.report.summary).slice(0, 2048),
                validationLevels: data.report.validationLevels.map(level => redact(level).slice(0, 128)),
                items: data.report.items.map(item => ({ ...item, name: redact(item.name).slice(0, 1024), message: redact(item.message).slice(0, 2048),
                    ...(item.code === undefined ? {} : { code: redact(item.code).slice(0, 128) }),
                    ...(item.file === undefined ? {} : { file: redact(item.file).slice(0, 1024) }) })),
            });
            if (byteLength(report) > 48 * 1024) { this.invalidate(active); return; }
        }
        active.outcome = data.type === 'error' ? { state: 'failed', error: sanitizedError(data.error), report }
            : report?.items.some(item => item.status === 'failed') ? { state: 'failed', report,
                error: failure('PROCESS_FAILED', 'The operation reported failed checks.') } : { state: 'succeeded', report };
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
                if (dropping) this.truncateLog(jobId, Buffer.byteLength(part));
                else {
                    if (Buffer.byteLength(line) + Buffer.byteLength(part) > MAX_LINE_BYTES) {
                        if (/-----BEGIN [^-]*PRIVATE KEY-----/i.test(line + part)) privateKey = true;
                        this.truncateLog(jobId, Buffer.byteLength(line) + Buffer.byteLength(part));
                        dropping = true; line = '';
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

    private truncateLog(jobId: string, bytes?: number): void {
        const record = this.records.get(jobId);
        if (record) {
            record.logs.truncated = true;
            record.logs.discardedBytes = bytes === undefined || record.logs.discardedBytes === null ? null
                : Math.min(Number.MAX_SAFE_INTEGER, record.logs.discardedBytes + bytes);
            this.flushLogsSoon();
        }
    }

    private appendLog(jobId: string, text: string): void {
        const record = this.records.get(jobId);
        if (!record || this.broken) return;
        const clean = Buffer.from(redact(text));
        if (record.logs.bytes + clean.length > MAX_WORKER_LOG_BYTES) { this.truncateLog(jobId, Buffer.byteLength(text)); return; }
        let workspaceBytes = [...this.records.values()].reduce((sum, item) => sum + item.logs.bytes, 0);
        for (const item of [...this.records.values()].filter(item => terminal.has(item.job.state) && item.logs.bytes)
            .sort((a, b) => a.job.finishedAt! - b.job.finishedAt!)) {
            if (workspaceBytes + clean.length <= MAX_WORKSPACE_LOG_BYTES) break;
            workspaceBytes -= item.logs.bytes;
            if (item.logs.discardedBytes !== null) item.logs.discardedBytes += item.logs.bytes;
            item.logs.bytes = 0; item.logs.generation++; item.logs.truncated = true;
            this.logData.set(item.job.jobId, logData(Buffer.alloc(0)));
            this.evictedLogs.add(item.job.jobId);
        }
        if (workspaceBytes + clean.length > MAX_WORKSPACE_LOG_BYTES) { this.truncateLog(jobId, Buffer.byteLength(text)); return; }
        let data = this.logData.get(jobId);
        if (!data) { data = logData(Buffer.alloc(0)); this.logData.set(jobId, data); }
        for (let offset = 0; offset < clean.length;) {
            const index = Math.floor(data.bytes / LOG_BLOCK_BYTES);
            if (!data.chunks[index]) data.chunks[index] = Buffer.alloc(LOG_BLOCK_BYTES);
            else if (data.chunks[index].length < LOG_BLOCK_BYTES) {
                const old = data.chunks[index]; data.chunks[index] = Buffer.alloc(LOG_BLOCK_BYTES); old.copy(data.chunks[index]);
            }
            const length = Math.min(clean.length - offset, LOG_BLOCK_BYTES - data.bytes % LOG_BLOCK_BYTES);
            clean.copy(data.chunks[index], data.bytes % LOG_BLOCK_BYTES, offset, offset + length);
            data.bytes += length; offset += length;
        }
        record.logs.bytes = data.bytes;
        this.flushLogsSoon();
    }

    private flushLogsSoon(): void {
        if (this.logTimer || this.broken || this.closing) return;
        this.logTimer = setTimeout(() => {
            this.logTimer = undefined;
            this.background(() => this.persist());
        }, 250);
        this.logTimer.unref();
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        for (const active of this.active.values()) { active.stopOutcome ??= this.stopOutcome('cancelled'); active.tree?.stop(); }
        clearTimeout(this.logTimer);
        clearTimeout(this.retentionTimer);
        this.closePromise = this.enqueue(async () => {
            for (const pending of this.pending.values()) clearTimeout(pending.timer);
            this.pending.clear();
            try {
                await Promise.all([...this.active.values()].map(async active => {
                    const workerExitCode = active.workerExitCode ?? await active.worker.terminate();
                    const runner = active.tree ? await active.tree.closed : undefined;
                    if (runner && !runner.treeClosed) this.cleanupConfirmed = false;
                    const record = this.records.get(active.jobId)!;
                    record.job = { ...record.job, exitCode: record.executesLogic ? runner?.exitCode ?? null : workerExitCode,
                        signal: runner?.signal ?? null, workerExitCode };
                    active.log.end();
                    this.active.delete(active.jobId);
                }));
                if (!this.cleanupConfirmed) throw new AppError('PROCESS_FAILED', 'Process-tree closure was not confirmed. Ownership and staging were preserved.');
                const records = new Map(this.records);
                for (const [id, record] of records) {
                    if (record.sdkId === this.options.sdkId && !terminal.has(record.job.state)) records.set(id, { ...record, job: { ...record.job,
                        state: 'cancelled', phase: 'cancelled', finishedAt: Date.now(), report: null, discardedLogBytes: record.logs.discardedBytes,
                        error: failure('CANCELLED', 'The server closed before this job completed.') } });
                }
                if (this.locked) {
                    try { await this.cleanStaging(); } catch { await this.failStorage(); }
                    await this.persist(records);
                }
            } finally { if (this.cleanupConfirmed) await this.releaseLock(); }
            if (this.broken) throw storageError();
        });
        return this.closePromise;
    }
}
