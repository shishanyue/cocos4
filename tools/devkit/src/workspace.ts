import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { AppError, diagnosticSchema } from './contracts.js';

const MiB = 1024 * 1024;
const inspectionLimits = { entries: 1000, bytes: 8 * MiB, milliseconds: 5000 };
const snapshotLimits = { entries: 10000, bytes: 64 * MiB, milliseconds: 60000 };
const privateComponent = /^(?:\.env(?:\..*|rc)?|\.git(?:-credentials)?|\.ssh|\.gnupg|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|(?:credentials|secrets?|key|private[-_.]?key|service[-_]?account)(?:\..*)?|.*\.(?:key|pem|p12|pfx|jks|keystore))$/i;

export function validateRelativePath(value: string): string {
    if (typeof value !== 'string' || !value || value.length > 1024) {
        throw new AppError('INVALID_ARGUMENTS', 'A relative path of 1 to 1024 characters is required.');
    }
    if (value === '.') return value;
    if (/[\\:%\x00-\x1f\x7f<>"|?*]/.test(value) || value.split('/').some((part) =>
        !part || part === '.' || part === '..' || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)/i.test(part))) {
        throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Use a relative path without escapes, reserved names or traversal.');
    }
    return value;
}

export const inspectionSchema = z.object({
    project: z.string().max(1024),
    kind: z.enum(['creator', 'javascript', 'minigame-output', 'unknown']),
    entry: z.string().max(1024).nullable(),
    files: z.number().int().min(0).max(1000),
    bytes: z.number().int().min(0).max(8 * MiB),
    complete: z.boolean(),
    requiredFeatures: z.array(z.string().max(128)).max(128),
    diagnostics: z.array(diagnosticSchema).max(32),
}).strict();
export type Inspection = z.infer<typeof inspectionSchema>;
type Diagnostic = Inspection['diagnostics'][number];
type Pin = { handle: FileHandle; absolute: string; stat: BigIntStats };
type Limits = typeof inspectionLimits;
type Scan = { records: Map<string, string>; contents: Map<string, string>; files: number; bytes: number };

function failChanged(): never {
    throw new AppError('INPUT_CHANGED', 'An input path or file changed during the read. Retry with an idle project.', [], true);
}

function identity(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

function stamp(stat: BigIntStats): string {
    return `${identity(stat)}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function fdPath(pin: Pin): string {
    return `/proc/self/fd/${pin.handle.fd}`;
}

function hostCheck(): void {
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) {
        throw new AppError('SDK_INCOMPLETE', 'Secure workspace reads require verified Linux /proc/self/fd and no-follow opens.');
    }
}

function deadlineCheck(deadline: number): void {
    if (performance.now() > deadline) throw new AppError('TIMEOUT', 'The bounded workspace scan exceeded its time budget.');
}

function filesystemError(error: unknown): never {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EACCES' || code === 'EPERM') throw new AppError('PERMISSION_DENIED', 'A workspace or tool-state path is not readable.');
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Symlinks and non-directory path ancestors are forbidden.');
    if (code === 'ENOENT') failChanged();
    throw error;
}

async function checkPin(pin: Pin, content = false): Promise<void> {
    try {
        const current = await pin.handle.stat({ bigint: true });
        const linked = await fs.lstat(pin.absolute, { bigint: true });
        if ((content ? stamp(current) !== stamp(pin.stat) : identity(current) !== identity(pin.stat))
            || identity(linked) !== identity(pin.stat)
            || await fs.realpath(fdPath(pin)) !== pin.absolute
            || await fs.realpath(pin.absolute) !== pin.absolute) failChanged();
    } catch (error) { filesystemError(error); }
}

async function openChild(parent: Pin, name: string, directory: boolean): Promise<Pin> {
    validateRelativePath(name);
    if (name.includes('/') || name === '.') throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Expected one path component.');
    const filename = `${fdPath(parent)}/${name}`;
    let handle: FileHandle | undefined;
    try {
        const before = await fs.lstat(filename, { bigint: true });
        if (before.isSymbolicLink()) throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Symbolic links are not workspace inputs.');
        if (directory ? !before.isDirectory() : !before.isFile()) {
            throw new AppError('UNSUPPORTED_PROJECT', 'Only regular files and directories are permitted.');
        }
        if (!directory && before.nlink !== 1n) throw new AppError('PERMISSION_DENIED', 'Hard-linked input files are not permitted.');
        handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            | (directory ? constants.O_DIRECTORY : 0));
        const stat = await handle.stat({ bigint: true });
        // Ancestor children may churn independently. scanTree checks content
        // stamps for directories it scans; traversal only pins their identity.
        if (directory ? identity(stat) !== identity(before) : stamp(stat) !== stamp(before)) failChanged();
        const pin = { handle, absolute: path.join(parent.absolute, name), stat };
        await checkPin(pin, !directory);
        return pin;
    } catch (error) {
        await handle?.close();
        filesystemError(error);
    }
}

// Walk from / rather than realpath-then-open: every ancestor stays pinned until
// the operation ends, so replacing an ancestor cannot redirect file reads.
async function pinAbsolute(absolute: string): Promise<Pin[]> {
    hostCheck();
    if (!path.isAbsolute(absolute) || absolute !== path.resolve(absolute) || absolute.length > 4096) {
        throw new AppError('INVALID_ARGUMENTS', 'The authorized root must be a normalized absolute directory.');
    }
    if (absolute.split('/').filter(Boolean).length > 64) throw new AppError('LIMIT_EXCEEDED', 'Authorized roots may have at most 64 ancestors.');
    const pins: Pin[] = [];
    try {
        const handle = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const root = { handle, absolute: '/', stat: await handle.stat({ bigint: true }) };
        pins.push(root);
        try {
            if (await fs.realpath(fdPath(root)) !== '/') throw new Error('Unexpected procfs root.');
        } catch {
            throw new AppError('SDK_INCOMPLETE', 'The host does not provide verified Linux pinned-descriptor paths.');
        }
        for (const component of absolute.split('/').filter(Boolean)) {
            pins.push(await openChild(pins[pins.length - 1], component, true));
        }
        return pins;
    } catch (error) {
        await closePins(pins);
        filesystemError(error);
    }
}

async function closePins(pins: Pin[]): Promise<void> {
    for (const pin of pins.slice().reverse()) await pin.handle.close();
}

async function checkPins(pins: Pin[]): Promise<void> {
    for (const pin of pins) await checkPin(pin);
}

async function pinProject(workspace: string, project: string): Promise<Pin[]> {
    validateRelativePath(project);
    const components = project === '.' ? [] : project.split('/');
    if (components.length > 32) throw new AppError('LIMIT_EXCEEDED', 'Workspace paths are limited to 32 components.');
    if (components.some((name) => privateComponent.test(name))) throw new AppError('PERMISSION_DENIED', 'Private paths are not project inputs.');
    const pins = await pinAbsolute(workspace);
    try {
        for (const component of components) pins.push(await openChild(pins[pins.length - 1], component, true));
        return pins;
    } catch (error) { await closePins(pins); throw error; }
}

async function readRegular(pin: Pin, maximum: number, deadline: number): Promise<Buffer> {
    if (pin.stat.size > BigInt(maximum)) throw new AppError('LIMIT_EXCEEDED', 'The input exceeds the bounded file or byte limit.');
    const length = Number(pin.stat.size);
    const bytes = Buffer.alloc(length + 1);
    let offset = 0;
    while (offset < bytes.length) {
        deadlineCheck(deadline);
        const read = await pin.handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
    }
    if (offset !== length) failChanged();
    await checkPin(pin, true);
    deadlineCheck(deadline);
    return bytes.subarray(0, length);
}

async function createDirectory(parent: Pin, name: string): Promise<Pin> {
    await checkPin(parent);
    await fs.mkdir(`${fdPath(parent)}/${name}`, { mode: 0o700 });
    parent.stat = await parent.handle.stat({ bigint: true });
    return openChild(parent, name, true);
}

async function writePrivate(parent: Pin, name: string, bytes: Buffer): Promise<void> {
    await checkPin(parent);
    const handle = await fs.open(`${fdPath(parent)}/${name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())) failChanged();
        await handle.writeFile(bytes);
        await handle.chmod(0o400);
        await checkPin({ handle, stat: await handle.stat({ bigint: true }), absolute: path.join(parent.absolute, name) }, true);
    } finally { await handle.close(); }
}

async function scanTree(root: Pin, limits: Limits, deadline: number, scan: Scan, options: {
    output?: Pin;
    file?: (name: string, bytes: Buffer) => void;
    privatePath?: (name: string) => void;
} = {}): Promise<void> {
    let entries = 0;
    async function walk(pin: Pin, prefix: string, depth: number, output?: Pin): Promise<void> {
        deadlineCheck(deadline);
        await checkPin(pin, true);
        scan.records.set(prefix || '.', stamp(pin.stat));
        const directory = await fs.opendir(fdPath(pin));
        try {
            for (;;) {
                deadlineCheck(deadline);
                const entry = await directory.read();
                if (!entry) break;
                if (++entries > limits.entries) throw new AppError('LIMIT_EXCEEDED', 'The scan reached its file/directory entry limit.');
                const name = prefix ? `${prefix}/${entry.name}` : entry.name;
                validateRelativePath(name);
                if (privateComponent.test(entry.name)) {
                    if (options.privatePath) { options.privatePath(name); continue; }
                    throw new AppError('PERMISSION_DENIED', 'Package snapshots must not contain private environment, VCS or key files.');
                }
                if (depth >= 32) throw new AppError('LIMIT_EXCEEDED', 'Workspace scans are limited to 32 levels.');
                const child = await openChild(pin, entry.name, entry.isDirectory());
                try {
                    if (child.stat.isDirectory()) {
                        const childOutput = output ? await createDirectory(output, entry.name) : undefined;
                        try { await walk(child, name, depth + 1, childOutput); }
                        finally { await childOutput?.handle.close(); }
                    } else {
                        const maximum = Math.min(limits.bytes - scan.bytes, /\.(?:json|jsonc)$/i.test(name) ? MiB : limits.bytes);
                        const bytes = await readRegular(child, maximum, deadline);
                        scan.files++;
                        scan.bytes += bytes.length;
                        const hash = createHash('sha256').update(bytes).digest('hex');
                        scan.records.set(name, `${stamp(child.stat)}:${hash}`);
                        scan.contents.set(name, hash);
                        if (output) await writePrivate(output, entry.name, bytes);
                        options.file?.(name, bytes);
                    }
                } finally { await child.handle.close(); }
            }
        } finally { await directory.close(); }
        await checkPin(pin, true);
        deadlineCheck(deadline);
    }
    try { await walk(root, '', 0, options.output); }
    catch (error) { filesystemError(error); }
}

function newScan(): Scan {
    return { records: new Map(), contents: new Map(), files: 0, bytes: 0 };
}

function compareRecords(before: Map<string, string>, after: Map<string, string>): void {
    if (before.size !== after.size) failChanged();
    for (const [name, value] of before) if (after.get(name) !== value) failChanged();
}

export async function inspectProject(workspace: string, project: string): Promise<Inspection> {
    validateRelativePath(project);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // Regular-file I/O can stall even with O_NONBLOCK. Return partial data at
        // the wall deadline; the reader still owns and closes any pending handles.
        return await Promise.race([inspectProjectData(workspace, project), new Promise<Inspection>((resolve) => {
            timer = setTimeout(() => resolve(inspectionSchema.parse({ project, kind: 'unknown', entry: null,
                files: 0, bytes: 0, complete: false, requiredFeatures: [], diagnostics: [{ code: 'TIMEOUT', severity: 'warning',
                    message: 'The 5-second inspection deadline expired. Partial data is withheld; no project code was executed.',
                    source: 'workspace-inspection', nextSteps: ['Retry on an idle local filesystem or narrow the project directory.'] }] })),
            inspectionLimits.milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}

async function inspectProjectData(workspace: string, project: string): Promise<Inspection> {
    validateRelativePath(project);
    const deadline = performance.now() + inspectionLimits.milliseconds;
    const result: Inspection = { project, kind: 'unknown', entry: null, files: 0, bytes: 0, complete: true, requiredFeatures: [], diagnostics: [] };
    const add = (code: string, severity: Diagnostic['severity'], message: string, file?: string): void => {
        if (result.diagnostics.length < 31) result.diagnostics.push({ code, severity, message, source: 'workspace-inspection',
            ...(file && Buffer.byteLength(file) <= 256 ? { file } : {}), nextSteps: [] });
        else if (result.diagnostics.length === 31) result.diagnostics.push({ code: 'DIAGNOSTICS_TRUNCATED', severity: 'warning',
            message: 'Additional diagnostics were omitted to keep inspection bounded.', source: 'workspace-inspection', nextSteps: [] });
    };
    add('DATA_ONLY', 'info', 'Data-only inspection; no project scripts, type checking, dependency resolution or runtime validation were performed.');
    add('FEATURES_UNDETERMINED', 'info', 'Required engine features are not inferred from filenames or dependencies. No portable profile availability is established.');
    const configs = new Map<string, Record<string, unknown>>();
    const scan = newScan();
    const pins = await pinProject(workspace, project);
    try {
        try {
            await scanTree(pins[pins.length - 1], inspectionLimits, deadline, scan, {
                privatePath: (name) => add('PRIVATE_PATH_SKIPPED', 'warning', 'Private file or directory was not opened.', name),
                file: (name, bytes) => {
                    if (/\.(?:scene|prefab|fbx|effect|mtl|material|gltf|glb|blend|obj|dae|ktx2?|pvr|pkm|astc|dds|basis|skel|spine|ttf|otf)$/i.test(name)) {
                        add('UNSUPPORTED_ASSET', 'warning', 'This asset requires import, compilation or runtime integration not validated by this data-only tool.', name);
                    }
                    if (/(?:^|\/)(?:[^/]*config[^/]*\.(?:[cm]?js|ts|jsonc)|[^/]+\.config\.json|\.babelrc|\.eslintrc)$/.test(name)) {
                        add('NONSTANDARD_CONFIG', 'warning', 'Executable or nonstandard configuration was not loaded.', name);
                    }
                    if (!/(?:^|\/)(?:package|tsconfig(?:\.[^/]+)?)\.json$/.test(name)) return;
                    try {
                        const data: unknown = JSON.parse(bytes.toString('utf8'));
                        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected object.');
                        configs.set(name, data as Record<string, unknown>);
                    } catch { add('INVALID_JSON', 'warning', 'Configuration is not a strict JSON object; it was not interpreted or executed.', name); }
                },
            });
            const after = newScan();
            await scanTree(pins[pins.length - 1], inspectionLimits, deadline, after, { privatePath: () => {} });
            compareRecords(scan.records, after.records);
            await checkPins(pins);
        } catch (error) {
            if (!(error instanceof AppError) || !['LIMIT_EXCEEDED', 'TIMEOUT'].includes(error.code)) throw error;
            result.complete = false;
            if (result.diagnostics.length === 32) result.diagnostics.pop();
            result.diagnostics.push({ code: error.code, severity: 'warning', message: 'Inspection is partial: a scan budget was reached. Narrow the project directory; full doctor does not run project code.',
                source: 'workspace-inspection', nextSteps: [] });
        }
        result.files = scan.files;
        result.bytes = scan.bytes;
        const pkg = configs.get('package.json');
        if (pkg) result.kind = pkg.creator ? 'creator' : 'javascript';
        if (scan.contents.has('game.json') && scan.contents.has('game.js')) { result.kind = 'minigame-output'; result.entry = 'game.js'; }
        if (pkg && typeof pkg.main === 'string') {
            try {
                const entry = validateRelativePath(pkg.main);
                if (entry !== '.' && scan.contents.has(entry)) result.entry = entry;
                else add('UNRESOLVED_ENTRY', 'warning', 'The declared package entry is not a scanned regular file.', 'package.json');
            } catch { add('EXTERNAL_ENTRY', 'warning', 'The declared package entry is unsafe or external and was not followed.', 'package.json'); }
        }
        for (const [name, config] of configs) {
            if (path.posix.basename(name) === 'package.json') {
                for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'plugins', 'workspaces', 'imports', 'exports']) {
                    if (config[field] !== undefined) add('UNVERIFIED_DEPENDENCIES', 'warning', `${field} declarations are present but were not resolved, installed or trusted.`, name);
                }
                if (config.scripts !== undefined) add('SCRIPTS_NOT_RUN', 'info', 'Package scripts were read as data only and were not executed.', name);
                continue;
            }
            const local = (value: unknown, wildcard = false): boolean => {
                if (typeof value !== 'string') return false;
                try {
                    const relative = value.startsWith('./') ? value.slice(2) : value;
                    validateRelativePath(wildcard ? relative.replace(/\*/g, 'wildcard') : relative);
                    return true;
                } catch { return false; }
            };
            if (config.extends !== undefined) {
                const bases = Array.isArray(config.extends) ? config.extends : [config.extends];
                const external = bases.some((base) => typeof base !== 'string' || !base.startsWith('./') || !local(base));
                add(external ? 'EXTERNAL_TSCONFIG' : 'UNRESOLVED_TSCONFIG', 'warning', 'tsconfig extends was not followed or resolved.', name);
            }
            if (config.references !== undefined) {
                const external = !Array.isArray(config.references) || config.references.some((ref: unknown) =>
                    !ref || typeof ref !== 'object' || !local((ref as Record<string, unknown>).path));
                add(external ? 'EXTERNAL_TSCONFIG' : 'UNRESOLVED_TSCONFIG', 'warning', 'tsconfig project references were not followed.', name);
            }
            const options = config.compilerOptions;
            if (options && typeof options === 'object' && !Array.isArray(options)) {
                const values = options as Record<string, unknown>;
                for (const field of ['baseUrl', 'rootDir', 'outDir', 'typeRoots', 'rootDirs', 'paths']) {
                    if (values[field] === undefined) continue;
                    let targets: unknown[] = [];
                    if (field === 'paths' && values.paths && typeof values.paths === 'object' && !Array.isArray(values.paths)) {
                        targets = Object.values(values.paths).flat();
                    } else targets = Array.isArray(values[field]) ? values[field] as unknown[] : [values[field]];
                    add(targets.some((target) => !local(target, field === 'paths')) ? 'EXTERNAL_TSCONFIG' : 'UNRESOLVED_TSCONFIG',
                        'warning', `tsconfig ${field} was inspected as data only, not followed.`, name);
                }
                if (values.plugins !== undefined) add('UNTRUSTED_PLUGIN', 'warning', 'TypeScript plugins were not loaded.', name);
            }
            for (const field of ['files', 'include', 'exclude']) {
                if (config[field] !== undefined && (!Array.isArray(config[field])
                    || (config[field] as unknown[]).some((value) => !local(value, true)))) {
                    add('EXTERNAL_TSCONFIG', 'warning', `tsconfig ${field} contains external or unsupported paths.`, name);
                }
            }
        }
        return inspectionSchema.parse(result);
    } finally { await closePins(pins); }
}

// The SDK loader establishes manifest trust. This independently pins and hashes
// the packaged validator before any of its bytes are used as executable code.
export async function readSdkValidator(sdkRoot: string, expectedHash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new AppError('SDK_INCOMPLETE', 'The packaged validator has no verified SHA-256 manifest entry.');
    const pins = await pinAbsolute(sdkRoot);
    try {
        pins.push(await openChild(pins[pins.length - 1], 'app', true));
        const file = await openChild(pins[pins.length - 1], 'validate-bilibili.cjs', false);
        try {
            const bytes = await readRegular(file, MiB, performance.now() + 5000);
            if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
                throw new AppError('SDK_INCOMPLETE', 'The packaged Bilibili validator failed its manifest hash check.');
            }
            await checkPins(pins);
            return bytes;
        } finally { await file.handle.close(); }
    } finally { await closePins(pins); }
}

export async function withPackageSnapshot<T>(workspace: string, directory: string, staging: string,
    validatorBytes: Buffer, validate: (snapshot: string, validator: string) => T | Promise<T>): Promise<T> {
    const deadline = performance.now() + snapshotLimits.milliseconds;
    const sourcePins = await pinProject(workspace, directory);
    const statePins: Pin[] = [];
    try {
        if (staging === workspace || staging.startsWith(`${workspace === '/' ? '' : workspace}/`)) {
            throw new AppError('PERMISSION_DENIED', 'Job staging must be outside the read-only workspace.');
        }
        if (!path.isAbsolute(staging) || staging !== path.resolve(staging)) {
            throw new AppError('INVALID_ARGUMENTS', 'Job staging must be a normalized absolute path.');
        }
        statePins.push(...await pinAbsolute(path.dirname(staging)));
        for (const pin of statePins) {
            const owner = pin.stat.uid === 0n || pin.stat.uid === BigInt(process.getuid!());
            const sharedStickyRoot = pin.stat.uid === 0n && (pin.stat.mode & 0o1000n) !== 0n;
            if (!owner || ((pin.stat.mode & 0o022n) !== 0n && !sharedStickyRoot)) {
                throw new AppError('PERMISSION_DENIED', 'Tool-state ancestors must not be replaceable by other users.');
            }
        }
        const parent = statePins[statePins.length - 1];
        const name = validateRelativePath(path.basename(staging));
        try {
            await fs.lstat(`${fdPath(parent)}/${name}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') filesystemError(error);
            if (parent.stat.uid !== BigInt(process.getuid!()) || (parent.stat.mode & 0o077n) !== 0n) {
                throw new AppError('PERMISSION_DENIED', 'Only private tool-owned state may contain a new job staging directory.');
            }
            const created = await createDirectory(parent, name);
            await created.handle.close();
        }
        statePins.push(await openChild(parent, name, true));
        const state = statePins[statePins.length - 1];
        if (state.stat.uid !== BigInt(process.getuid!()) || (state.stat.mode & 0o077n) !== 0n) {
            throw new AppError('PERMISSION_DENIED', 'Job staging must be an owner-only directory owned by this tool user.');
        }
        const job = await createDirectory(state, `validation-${randomUUID()}`);
        statePins.push(job);
        await writePrivate(job, 'validate-bilibili.cjs', validatorBytes);
        const output = await createDirectory(job, 'snapshot');
        statePins.push(output);
        const before = newScan();
        await scanTree(sourcePins[sourcePins.length - 1], snapshotLimits, deadline, before, { output });
        // Pin metadata reflects the intentional tool-owned writes, not input changes.
        for (const pin of statePins) pin.stat = await pin.handle.stat({ bigint: true });
        await checkPins(sourcePins);
        await checkPins(statePins);
        const snapshotBefore = newScan();
        await scanTree(output, snapshotLimits, deadline, snapshotBefore);
        compareRecords(before.contents, snapshotBefore.contents);
        const result = await validate(output.absolute, path.join(job.absolute, 'validate-bilibili.cjs'));
        const snapshotAfter = newScan();
        await scanTree(output, snapshotLimits, deadline, snapshotAfter);
        compareRecords(snapshotBefore.records, snapshotAfter.records);
        const after = newScan();
        await scanTree(sourcePins[sourcePins.length - 1], snapshotLimits, deadline, after);
        compareRecords(before.records, after.records);
        await checkPins(sourcePins);
        await checkPins(statePins);
        deadlineCheck(deadline);
        return result;
    } finally {
        // Job-state lifecycle owns cleanup, including cancellation/worker termination.
        await closePins(statePins);
        await closePins(sourcePins);
    }
}
