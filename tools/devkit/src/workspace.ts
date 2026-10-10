import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError, diagnosticSchema, MAX_ARTIFACT_BYTES } from './contracts.js';
import { acquireWindowsPath, enforceWindowsPrivate, hostRealpath, verifyWindowsTrust, type WindowsPathLease } from './windows-fs.js';

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
type Pin = { handle: FileHandle; absolute: string; stat: BigIntStats; lease?: WindowsPathLease };
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
    return process.platform === 'win32' ? pin.absolute : `/proc/self/fd/${pin.handle.fd}`;
}

function hostCheck(): void {
    if (process.platform === 'win32' && process.arch === 'x64') return;
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK) {
        throw new AppError('SDK_INCOMPLETE', 'Secure workspace reads require the Windows x64 filesystem helper or verified Linux no-follow descriptor paths.');
    }
}

function childPath(pin: Pin, name: string): string {
    return process.platform === 'win32' ? path.join(pin.absolute, name) : `${fdPath(pin)}/${name}`;
}

function readFlags(directory: boolean): number {
    return process.platform === 'win32' ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0);
}

async function closePin(pin: Pin): Promise<void> {
    try { await pin.handle.close(); } finally { await pin.lease?.close(); }
}

async function privatePin(pin: Pin, directory: boolean): Promise<boolean> {
    if (process.platform === 'win32') {
        try { await verifyWindowsTrust(pin.absolute, true); return true; }
        catch (error) {
            if (error instanceof AppError && error.code === 'PERMISSION_DENIED') return false;
            throw error;
        }
    }
    return pin.stat.uid === BigInt(process.getuid!()) && (directory
        ? (pin.stat.mode & 0o7777n) === 0o700n : [0o400n, 0o600n].includes(pin.stat.mode & 0o7777n));
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
        await pin.lease?.check();
        const current = await pin.handle.stat({ bigint: true });
        const linked = await fs.lstat(pin.absolute, { bigint: true });
        if ((content ? stamp(current) !== stamp(pin.stat) : identity(current) !== identity(pin.stat))
            || identity(linked) !== identity(pin.stat)
            || await hostRealpath(fdPath(pin)) !== pin.absolute
            || await hostRealpath(pin.absolute) !== pin.absolute) failChanged();
    } catch (error) { filesystemError(error); }
}

async function openChild(parent: Pin, name: string, directory: boolean, immutable = false): Promise<Pin> {
    validateRelativePath(name);
    if (name.includes('/') || name === '.') throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Expected one path component.');
    const filename = childPath(parent, name);
    let handle: FileHandle | undefined;
    let lease: WindowsPathLease | undefined;
    try {
        await checkPin(parent);
        const before = await fs.lstat(filename, { bigint: true });
        if (before.isSymbolicLink()) throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Symbolic links are not workspace inputs.');
        if (directory ? !before.isDirectory() : !before.isFile()) {
            throw new AppError('UNSUPPORTED_PROJECT', 'Only regular files and directories are permitted.');
        }
        if (!directory && before.nlink !== 1n) throw new AppError('PERMISSION_DENIED', 'Hard-linked input files are not permitted.');
        if (process.platform === 'win32') lease = await acquireWindowsPath(filename, { directory, immutable });
        handle = await fs.open(lease?.absolute ?? filename, readFlags(directory));
        const stat = await handle.stat({ bigint: true });
        // Ancestor children may churn independently. scanTree checks content
        // stamps for directories it scans; traversal only pins their identity.
        if (directory ? identity(stat) !== identity(before) : stamp(stat) !== stamp(before)) failChanged();
        const pin = { handle, absolute: lease?.absolute ?? path.join(parent.absolute, name), stat, lease };
        await checkPin(pin, !directory);
        return pin;
    } catch (error) {
        await handle?.close();
        await lease?.close();
        filesystemError(error);
    }
}

// Walk from the filesystem root rather than realpath-then-open. On Windows the
// native leases reject every reparse point and deny ancestor deletion/renaming;
// Linux resolves children through pinned descriptors with O_NOFOLLOW.
async function pinAbsolute(absolute: string): Promise<Pin[]> {
    hostCheck();
    if (!path.isAbsolute(absolute) || absolute !== path.resolve(absolute) || absolute.length > 4096) {
        throw new AppError('INVALID_ARGUMENTS', 'The authorized root must be a normalized absolute directory.');
    }
    const windows = process.platform === 'win32';
    if (windows && !/^[A-Za-z]:\\/.test(absolute)) {
        throw new AppError('PATH_OUTSIDE_WORKSPACE', 'Windows workspace roots must use a local drive path, without UNC or device namespaces.');
    }
    const filesystemRoot = path.parse(absolute).root;
    const components = absolute.slice(filesystemRoot.length).split(path.sep).filter(Boolean);
    if (components.length > 64) throw new AppError('LIMIT_EXCEEDED', 'Authorized roots may have at most 64 ancestors.');
    const pins: Pin[] = [];
    try {
        const lease = windows ? await acquireWindowsPath(filesystemRoot, { directory: true }) : undefined;
        let handle: FileHandle;
        try { handle = await fs.open(lease?.absolute ?? filesystemRoot, readFlags(true)); }
        catch (error) { await lease?.close(); throw error; }
        const root: Pin = { handle, absolute: lease?.absolute ?? filesystemRoot, stat: await handle.stat({ bigint: true }), lease };
        pins.push(root);
        try {
            if (await hostRealpath(fdPath(root)) !== root.absolute) throw new Error('Unexpected filesystem root.');
        } catch {
            throw new AppError('SDK_INCOMPLETE', 'The host does not provide verified Linux pinned-descriptor paths.');
        }
        for (const component of components) {
            pins.push(await openChild(pins[pins.length - 1], component, true));
        }
        return pins;
    } catch (error) {
        await closePins(pins);
        filesystemError(error);
    }
}

async function closePins(pins: Pin[]): Promise<void> {
    for (const pin of pins.slice().reverse()) await closePin(pin);
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
    await fs.mkdir(childPath(parent, name), { mode: 0o700 });
    if (process.platform === 'win32') await enforceWindowsPrivate(childPath(parent, name));
    parent.stat = await parent.handle.stat({ bigint: true });
    return openChild(parent, name, true);
}

async function writePrivate(parent: Pin, name: string, bytes: Buffer): Promise<void> {
    await checkPin(parent);
    const handle = await fs.open(childPath(parent, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK), 0o600);
    try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || (process.platform !== 'win32' && stat.uid !== BigInt(process.getuid!()))) failChanged();
        if (process.platform === 'win32') await enforceWindowsPrivate(path.join(parent.absolute, name));
        await handle.writeFile(bytes);
        await handle.chmod(0o400);
        await checkPin({ handle, stat: await handle.stat({ bigint: true }), absolute: path.join(parent.absolute, name) }, true);
    } finally { await handle.close(); }
}

async function scanTree(root: Pin, limits: Limits, deadline: number, scan: Scan, options: {
    output?: Pin;
    file?: (name: string, bytes: Buffer) => void;
    privatePath?: (name: string) => void;
    jsonBytes?: number;
    privateOutput?: boolean;
} = {}): Promise<void> {
    let entries = 0;
    async function walk(pin: Pin, prefix: string, depth: number, output?: Pin): Promise<void> {
        deadlineCheck(deadline);
        await checkPin(pin, true);
        if (options.privateOutput && !await privatePin(pin, true)) {
            throw new AppError('ARTIFACT_INVALID', 'Output directories must remain private and tool-owned.');
        }
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
                        finally { if (childOutput) await closePin(childOutput); }
                    } else {
                        if (options.privateOutput && !await privatePin(child, false)) {
                            throw new AppError('ARTIFACT_INVALID', 'Output files must remain private, non-executable and tool-owned.');
                        }
                        const maximum = Math.min(limits.bytes - scan.bytes, /\.(?:json|jsonc)$/i.test(name) ? options.jsonBytes ?? MiB : limits.bytes);
                        const bytes = await readRegular(child, maximum, deadline);
                        scan.files++;
                        scan.bytes += bytes.length;
                        const hash = createHash('sha256').update(bytes).digest('hex');
                        scan.records.set(name, `${stamp(child.stat)}:${hash}`);
                        scan.contents.set(name, hash);
                        if (output) await writePrivate(output, entry.name, bytes);
                        options.file?.(name, bytes);
                    }
                } finally { await closePin(child); }
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
export async function readSdkValidator(sdkRoot: string, expectedHash: string, validatorName = 'validate-bilibili.cjs'): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new AppError('SDK_INCOMPLETE', 'The packaged validator has no verified SHA-256 manifest entry.');
    if (!/^validate-(?:bilibili|minigame)\.cjs$/.test(validatorName)) throw new AppError('SDK_INCOMPLETE', 'The packaged validator name is not supported.');
    const pins = await pinAbsolute(sdkRoot);
    try {
        pins.push(await openChild(pins[pins.length - 1], 'app', true));
        const file = await openChild(pins[pins.length - 1], validatorName, false);
        try {
            const bytes = await readRegular(file, MiB, performance.now() + 5000);
            if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
                throw new AppError('SDK_INCOMPLETE', 'The packaged validator failed its manifest hash check.');
            }
            await checkPins(pins);
            return bytes;
        } finally { await closePin(file); }
    } finally { await closePins(pins); }
}

export async function withPackageSnapshot<T>(workspace: string, directory: string, staging: string,
    validatorBytes: Buffer, validate: (snapshot: string, validator: string) => T | Promise<T>, validatorName = 'validate-bilibili.cjs'): Promise<T> {
    if (!/^validate-(?:bilibili|minigame)\.cjs$/.test(validatorName)) throw new AppError('INVALID_ARGUMENTS', 'Unknown packaged validator.');
    const deadline = performance.now() + snapshotLimits.milliseconds;
    const sourcePins = await pinProject(workspace, directory);
    const statePins: Pin[] = [];
    try {
        outside(workspace, staging);
        if (!path.isAbsolute(staging) || staging !== path.resolve(staging)) {
            throw new AppError('INVALID_ARGUMENTS', 'Job staging must be a normalized absolute path.');
        }
        statePins.push(...await pinAbsolute(path.dirname(staging)));
        await trustedAncestors(statePins);
        const parent = statePins[statePins.length - 1];
        const name = validateRelativePath(path.basename(staging));
        try {
            await fs.lstat(childPath(parent, name));
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') filesystemError(error);
            if (!await privatePin(parent, true)) {
                throw new AppError('PERMISSION_DENIED', 'Only private tool-owned state may contain a new job staging directory.');
            }
            const created = await createDirectory(parent, name);
            await closePin(created);
        }
        statePins.push(await openChild(parent, name, true));
        const state = statePins[statePins.length - 1];
        if (!await privatePin(state, true)) {
            throw new AppError('PERMISSION_DENIED', 'Job staging must be an owner-only directory owned by this tool user.');
        }
        const job = await createDirectory(state, `validation-${randomUUID()}`);
        statePins.push(job);
        await writePrivate(job, validatorName, validatorBytes);
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
        const result = await validate(output.absolute, path.join(job.absolute, validatorName));
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

type InventoryFile = { readonly path: string; readonly bytes: number; readonly sha256: string };
const gameLimits = { entries: 20000, bytes: MAX_ARTIFACT_BYTES + 4 * MiB, milliseconds: 60000 };

function outside(root: string, directory: string): void {
    const relative = path.relative(root, directory);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new AppError('PERMISSION_DENIED', 'Private job state must be outside the workspace and SDK.');
    }
}

async function trustedAncestors(pins: Pin[]): Promise<void> {
    if (process.platform === 'win32') {
        // The native helper checks the whole chain in one lease. Checking each
        // ancestor as a leaf would incorrectly forbid shared system directories
        // whose ACL allows creating children but not replacing existing ones.
        await verifyWindowsTrust(pins[pins.length - 1].absolute);
        return;
    }
    for (const pin of pins) {
        const owner = pin.stat.uid === 0n || pin.stat.uid === BigInt(process.getuid!());
        const sticky = pin.stat.uid === 0n && (pin.stat.mode & 0o1000n) !== 0n;
        if (!owner || ((pin.stat.mode & 0o022n) !== 0n && !sticky)) {
            throw new AppError('PERMISSION_DENIED', 'Publication and private-state ancestors must not be replaceable by other users.');
        }
    }
}

async function pinGameState(workspace: string, staging: string, create = false): Promise<Pin[]> {
    outside(workspace, staging);
    const pins = await pinAbsolute(path.dirname(staging));
    try {
        if (staging !== path.resolve(staging)) throw new AppError('INVALID_ARGUMENTS', 'Expected canonical job staging.');
        await trustedAncestors(pins);
        const parent = pins[pins.length - 1];
        const name = path.basename(staging);
        if (create) {
            try { await fs.lstat(childPath(parent, name)); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                if (!await privatePin(parent, true)) {
                    throw new AppError('PERMISSION_DENIED', 'New staging requires an owner-only parent.');
                }
                const created = await createDirectory(parent, name);
                await closePin(created);
            }
        }
        pins.push(await openChild(parent, name, true));
        const state = pins[pins.length - 1];
        if (!await privatePin(state, true)) {
            throw new AppError('PERMISSION_DENIED', 'Job staging must be private and tool-owned.');
        }
        return pins;
    } catch (error) { await closePins(pins); filesystemError(error); }
}

// Copy only manifest-listed bytes. In particular, never require executable SDK
// files by their original path after a hash check: that path can be replaced.
export async function withGameSnapshot<T>(workspace: string, project: string | undefined, staging: string,
    sdk: { root: string; files: readonly InventoryFile[] },
    action: (paths: { sdk: string; project?: string; output: string }) => Promise<T>): Promise<T> {
    outside(sdk.root, staging);
    const deadline = performance.now() + 10 * 60000;
    const statePins = await pinGameState(workspace, staging, true);
    const sourcePins: Pin[] = [];
    const sdkPins: Pin[] = [];
    try {
        const state = statePins[statePins.length - 1];
        const sdkOutput = await createDirectory(state, 'sdk');
        statePins.push(sdkOutput);
        const tree = new Map<string, InventoryFile[]>();
        let total = 0;
        const names = new Set<string>();
        for (const file of sdk.files) {
            validateRelativePath(file.path);
            if (file.path === '.' || names.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
                || !/^[a-f0-9]{64}$/.test(file.sha256) || (total += file.bytes) > 512 * MiB || names.size >= 20000) {
                throw new AppError('SDK_INCOMPLETE', 'The selected SDK inventory is invalid or too large.');
            }
            names.add(file.path.toLowerCase());
            const directory = path.posix.dirname(file.path);
            tree.set(directory, [...tree.get(directory) ?? [], file]);
            for (let parent = directory; parent !== '.'; parent = path.posix.dirname(parent)) {
                if (!tree.has(parent)) tree.set(parent, []);
            }
        }
        sdkPins.push(...await pinAbsolute(sdk.root));
        const copy = async (source: Pin, output: Pin, prefix: string): Promise<void> => {
            for (const file of tree.get(prefix) ?? []) {
                const name = path.posix.basename(file.path);
                const input = await openChild(source, name, false);
                try {
                    const bytes = await readRegular(input, file.bytes, deadline);
                    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
                        throw new AppError('SDK_INCOMPLETE', 'SDK bytes no longer match the verified manifest.');
                    }
                    await writePrivate(output, name, bytes);
                } finally { await closePin(input); }
            }
            for (const directory of tree.keys()) {
                if (directory === '.' || path.posix.dirname(directory) !== prefix) continue;
                const name = path.posix.basename(directory);
                const child = await openChild(source, name, true);
                try {
                    const destination = await createDirectory(output, name);
                    try { await copy(child, destination, directory); }
                    finally { await closePin(destination); }
                    await checkPin(child);
                } finally { await closePin(child); }
            }
        };
        await copy(sdkPins[sdkPins.length - 1], sdkOutput, '.');
        await checkPins(sdkPins);
        const before = newScan();
        let projectOutput: Pin | undefined;
        if (project !== undefined) {
            sourcePins.push(...await pinProject(workspace, project));
            projectOutput = await createDirectory(state, 'project');
            statePins.push(projectOutput);
            await scanTree(sourcePins[sourcePins.length - 1], snapshotLimits, deadline, before, { output: projectOutput });
            await checkPins(sourcePins);
        }
        const output = await createDirectory(state, 'output');
        statePins.push(output);
        for (const pin of statePins) pin.stat = await pin.handle.stat({ bigint: true });
        await checkPins(statePins);
        const snapshot = newScan();
        if (projectOutput) {
            await scanTree(projectOutput, snapshotLimits, deadline, snapshot);
            compareRecords(before.contents, snapshot.contents);
        }
        const result = await action({ sdk: sdkOutput.absolute, project: projectOutput?.absolute, output: output.absolute });
        if (projectOutput) {
            const copiedAfter = newScan();
            await scanTree(projectOutput, snapshotLimits, deadline, copiedAfter);
            compareRecords(snapshot.records, copiedAfter.records);
            const after = newScan();
            await scanTree(sourcePins[sourcePins.length - 1], snapshotLimits, deadline, after);
            compareRecords(before.records, after.records);
        }
        await checkPins(sourcePins);
        await checkPins(statePins);
        deadlineCheck(deadline);
        return result;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('OUTPUT_CONFLICT', 'Job staging already contains operation output.');
        filesystemError(error);
    } finally { await closePins(sdkPins); await closePins(sourcePins); await closePins(statePins); }
}

export async function readGameOutput(directory: string): Promise<Map<string, Buffer>> {
    const pins = await pinAbsolute(directory);
    try {
        const files = new Map<string, Buffer>();
        const scan = newScan();
        await scanTree(pins[pins.length - 1], gameLimits, performance.now() + gameLimits.milliseconds,
            scan, { jsonBytes: 4 * MiB, file: (name, bytes) => files.set(name, bytes) });
        await checkPins(pins);
        return files;
    } finally { await closePins(pins); }
}

export function validateProjectDestination(directory: string): string {
    validateRelativePath(directory);
    if (directory === '.') throw new AppError('OUTPUT_CONFLICT', 'Project creation requires an absent directory, not the workspace itself.');
    if (directory.split('/').some(name => privateComponent.test(name) || /^\.cocos4(?:[.-]|$)/i.test(name))) {
        throw new AppError('PERMISSION_DENIED', 'Private and reserved tool paths are not project destinations.');
    }
    return directory;
}

function validPublisherBinary(bytes: Buffer, stat: BigIntStats): boolean {
    if (process.platform !== 'win32') {
        return Boolean(stat.mode & 0o100n) && bytes.length >= 64
            && bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) && bytes.readUInt16LE(18) === 62;
    }
    if (bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
    const pe = bytes.readUInt32LE(0x3c);
    return pe >= 64 && pe <= bytes.length - 26 && bytes.readUInt32LE(pe) === 0x4550
        && bytes.readUInt16LE(pe + 4) === 0x8664 && bytes.readUInt16LE(pe + 24) === 0x20b;
}

// Parent process only. Fixed packaged helper uses kernel no-replace rename.
// No shell, project executable, or
// check-then-rename/cross-device fallback. The caller serializes cancellation.
// Rename and job metadata are not a crash-recoverable transaction: after host
// process loss, the parent must reconcile the destination before retrying.
export async function publishGameOutput(context: { workspace: string; staging: string; artifactsRoot: string },
    destination: { project: string } | { artifact: string }, validate: (files: Map<string, Buffer>) => void): Promise<void> {
    const sourcePins = await pinGameState(context.workspace, context.staging);
    const destinationPins: Pin[] = [];
    const helperPins: Pin[] = [];
    try {
        const staging = sourcePins[sourcePins.length - 1];
        sourcePins.push(await openChild(staging, 'output', true));
        const source = sourcePins[sourcePins.length - 1];
        let name: string;
        if ('project' in destination) {
            validateProjectDestination(destination.project);
            name = path.posix.basename(destination.project);
            destinationPins.push(...await pinProject(context.workspace, path.posix.dirname(destination.project)));
            await trustedAncestors(destinationPins);
        } else {
            if (!/^artifact-[a-f0-9-]{36}$/i.test(destination.artifact)) throw new AppError('ARTIFACT_INVALID', 'Invalid artifact destination.');
            name = destination.artifact;
            destinationPins.push(...await pinGameState(context.workspace, context.artifactsRoot));
        }
        const files = new Map<string, Buffer>();
        const scan = newScan();
        await scanTree(source, gameLimits, performance.now() + gameLimits.milliseconds, scan,
            { jsonBytes: 4 * MiB, privateOutput: true, file: (name, bytes) => files.set(name, bytes) });
        const directories = new Set(['.']);
        for (const file of files.keys()) {
            for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
        }
        if ([...scan.records.keys()].some(name => !files.has(name) && !directories.has(name))) {
            throw new AppError('ARTIFACT_INVALID', 'Unlisted empty output directories cannot be published.');
        }
        validate(files);
        let helper: Pin;
        try {
            if (process.arch !== 'x64') throw new Error('Only x64 publishers are built.');
            // Source builds use build/{src,host}; distributions use app/{src,host}.
            // No PATH, environment override, SDK/project executable or runtime build.
            const binary = `cocos4-publish${process.platform === 'win32' ? '.exe' : ''}`;
            const filename = fileURLToPath(new URL(`../host/${binary}`, import.meta.url));
            helperPins.push(...await pinAbsolute(path.dirname(filename)));
            await trustedAncestors(helperPins);
            const directory = helperPins[helperPins.length - 1];
            const report = await openChild(directory, `${binary}.build.json`, false, true);
            helperPins.push(report);
            helper = await openChild(directory, binary, false, true);
            helperPins.push(helper);
            for (const pin of [report, helper]) {
                if (process.platform === 'win32') { await verifyWindowsTrust(pin.absolute); continue; }
                if ((pin.stat.uid !== 0n && pin.stat.uid !== BigInt(process.getuid!())) || (pin.stat.mode & 0o6022n) !== 0n) {
                    throw new Error('Unsafe publisher ownership or permissions.');
                }
            }
            const deadline = performance.now() + 5000;
            const manifest = z.object({ schemaVersion: z.literal(1), protocol: z.literal('cocos4-publish-v1'),
                target: z.literal(process.platform === 'win32' ? 'win32-x64' : 'linux-x64'), bytes: z.number().int().positive().max(MiB),
                binarySha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(
                JSON.parse((await readRegular(report, 64 * 1024, deadline)).toString('utf8')));
            const bytes = await readRegular(helper, MiB, deadline);
            if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.binarySha256
                || !validPublisherBinary(bytes, helper.stat)) throw new Error('Invalid publisher binary or integrity report.');
            await checkPins(helperPins);
            await checkPin(helper, true);
        } catch {
            throw new AppError('SDK_INCOMPLETE', 'Atomic publication requires the verified shipped host-specific cocos4-publish helper.',
                ['Install a complete trusted kit; publication never compiles or downloads a helper.']);
        }
        await checkPins(sourcePins);
        await checkPins(destinationPins);
        const pins = [...sourcePins, ...destinationPins];
        const args = ['cocos4-publish-v1', String(sourcePins.length), name,
            ...pins.flatMap(pin => [pin.absolute, String(pin.stat.dev), String(pin.stat.ino), String(pin.stat.mode)])];
        // The publisher takes its own delete-capable source handle, rechecks all
        // identities, and locks the complete ancestor chains before renaming.
        // Keep Node's descriptor but release the source lease for that handoff.
        if (process.platform === 'win32') { await source.lease?.close(); source.lease = undefined; }
        await new Promise<void>((resolve, reject) => {
            // Execute the checked inode, not a pathname that can be replaced after
            // validation. The kit and its owner remain trusted, not a sandbox.
            const windows = process.platform === 'win32';
            const child = spawn(windows ? helper.absolute : `/proc/self/fd/${pins.length + 3}`, args,
                { env: windows ? { SystemRoot: process.env.SystemRoot } : {}, cwd: path.parse(helper.absolute).root,
                    shell: false, windowsHide: true,
                    stdio: windows ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'ignore', 'ignore', ...pins.map(pin => pin.handle.fd), helper.handle.fd] });
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            child.once('error', () => { clearTimeout(timer); reject(new AppError('SDK_INCOMPLETE', 'Atomic publication requires the compiled host-specific cocos4-publish helper.')); });
            child.once('exit', (code, signal) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new AppError(code === 70 ? 'OUTPUT_CONFLICT' : code === 73 ? 'INPUT_CHANGED'
                    : code === 74 ? 'PERMISSION_DENIED' : signal ? 'TIMEOUT' : 'SDK_INCOMPLETE',
                code === 70 ? 'The destination already exists, even if empty; nothing was overwritten.'
                    : 'Atomic publication failed or could not be confirmed. No unsafe rename fallback was attempted.'));
            });
        });
    } catch (error) { filesystemError(error); }
    finally { await closePins(helperPins); await closePins(destinationPins); await closePins(sourcePins); }
}
