import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError } from './contracts.js';
import { hash, parseJson } from './sdk.js';

export const supervisorIdentitySchema = z.object({
    pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/),
    guardianPid: z.number().int().positive(), guardianStartTime: z.string().regex(/^\d+$/),
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
const hostManifestSchema = z.object({ version: z.literal(1), platform: z.literal('linux'), arch: z.literal(process.arch),
    file: z.literal('cocos4-supervise'), bytes: z.number().int().positive().max(1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

async function supervisorFile(): Promise<Awaited<ReturnType<typeof open>>> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        if (process.platform !== 'linux') throw new Error('Linux only.');
        const manifest = hostManifestSchema.parse(parseJson(await readFile(new URL('../host/supervisor.json', import.meta.url), 'utf8')));
        file = await open(new URL('../host/cocos4-supervise', import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) || !(stat.mode & 0o100) || stat.size !== manifest.bytes) throw new Error('Unsafe helper.');
        const bytes = Buffer.alloc(manifest.bytes + 1);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== manifest.bytes || hash(bytes.subarray(0, read.bytesRead)) !== manifest.sha256) throw new Error('Helper integrity.');
        return file;
    } catch {
        await file?.close();
        throw new AppError('SDK_INCOMPLETE', 'Trusted logic execution requires the packaged Linux host/cocos4-supervise helper matching this host.',
            ['Use a verified host distribution. Runtime never invokes a compiler or downloads a helper.']);
    }
}
export async function verifySupervisor(): Promise<void> { await (await supervisorFile()).close(); }

export async function processIdentity(pid: number): Promise<{ startTime: string; alive: boolean } | null> {
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
        for (const value of identities) for (const [pid, startTime] of [[value.pid, value.startTime], [value.guardianPid, value.guardianStartTime]] as const) {
            const actual = await processIdentity(pid);
            if (actual?.alive && actual.startTime === startTime) alive = true;
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
    private ended = false;
    private stopTimer?: ReturnType<typeof setTimeout>;
    private resolveClosed!: (outcome: ProcessOutcome) => void;
    private rejectReady!: (error: Error) => void;
    private outcome: ProcessOutcome = { exitCode: null, signal: null, treeClosed: false, infrastructureFailed: false };

    private constructor(readonly child: ChildProcess, onMessage: (message: unknown) => void) {
        let resolveReady!: (identity: SupervisorIdentity) => void;
        this.ready = new Promise((resolve, reject) => { resolveReady = resolve; this.rejectReady = reject; });
        this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
        let pending = '', total = 0, ready = false, exited = false;
        const timer = setTimeout(() => { this.rejectReady(new AppError('PROCESS_FAILED', 'The process supervisor did not start within five seconds.')); this.stop(); }, 5000);
        const invalid = (): void => { this.outcome.infrastructureFailed = true; this.stop(); };
        const control = child.stdio[3] as NodeJS.WritableStream;
        control.on('error', invalid);
        const events = child.stdio[4] as NodeJS.ReadableStream;
        events.setEncoding('utf8');
        events.on('data', (text: string) => {
            if ((total += Buffer.byteLength(text)) > 16384 || (pending += text).length > 4096) { invalid(); return; }
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end); pending = pending.slice(end + 1);
                let event: z.infer<typeof eventSchema>;
                try { event = eventSchema.parse(JSON.parse(line)); } catch { invalid(); continue; }
                if (event.type === 'ready') {
                    if (ready || event.pid !== child.pid) { invalid(); continue; }
                    ready = true; clearTimeout(timer);
                    const { type: _, ...identity } = event;
                    resolveReady(identity);
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
            if (!ready) this.rejectReady(new AppError('PROCESS_FAILED', 'The Linux process supervisor failed to initialize.'));
            if (pending || code !== 0 || signal || !this.outcome.treeClosed) this.outcome.infrastructureFailed = true;
            this.resolveClosed({ ...this.outcome });
        });
    }

    static async launch(options: { directory: string; message: (message: unknown) => void;
        stdout: (stream: NodeJS.ReadableStream) => void; stderr: (stream: NodeJS.ReadableStream) => void },
    runner = fileURLToPath(new URL('./logic-runner.js', import.meta.url))): Promise<ProcessTree> {
        const helper = await supervisorFile();
        try {
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
    start(): void {
        if (!this.stopping && !this.ended) (this.child.stdio[3] as NodeJS.WritableStream).write('G');
    }
    stop(): void {
        if (this.stopping || this.ended) return;
        this.stopping = true;
        (this.child.stdio[3] as NodeJS.WritableStream).end('T');
        this.stopTimer = setTimeout(() => {
            this.outcome.infrastructureFailed = true;
            // Do not kill the reapers and pretend their tree was cleaned. They
            // keep reaping an unkillable kernel task; recovery retains ownership.
            this.resolveClosed({ ...this.outcome, treeClosed: false });
        }, 9750);
    }
}
