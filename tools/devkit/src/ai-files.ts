// Loaded only as a trusted, bundled OpenCode custom tool. No project code or dependencies.
import fs, { constants as C, type BigIntStats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

type Root = { path: string; dev: string; ino: string };
export type FilePolicy = { workspace: Root; readable: Root[]; mode: 'read-only' | 'develop' };
type Context = { abort?: AbortSignal; ask: (request: { permission: string; patterns: string[]; always: string[];
    metadata: Record<string, unknown> }) => Promise<unknown> };
type Chunk = { old: string[]; next: string[]; anchor?: string; eof?: boolean };
type Change = { kind: 'add' | 'delete' | 'update'; source: string; destination?: string; text?: string; chunks?: Chunk[] };
const MAX_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 8 * MAX_BYTES;
const LOCK = '.cocos4-ai-file-lock';
const fail = (kind: string, detail: string): never => { throw new Error(`AI_FILES_${kind}: ${detail}`); };
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const inode = (s: BigIntStats): string => `${s.dev}:${s.ino}`;
const contentsVersion = (s: BigIntStats): string => `${inode(s)}:${s.size}:${s.mtimeNs}:${s.mode}:${s.uid}:${s.gid}`;
const version = (s: BigIntStats): string => `${contentsVersion(s)}:${s.nlink}:${s.ctimeNs}`;
const fdPath = (fd: number): string => `/proc/self/fd/${fd}`;

function safeName(filename: string): boolean {
    return !filename.split('/').some(part => /^(?:\.env(?:\..*)?|\.envrc|\.git(?:-credentials)?|\.ssh|\.gnupg|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|\.opencode|\.claude|\.agents|\.config|opencode\.jsonc?|credentials.*|secrets.*|id_rsa.*|id_ed25519.*|\.cocos4-ai-.*)$/i.test(part)
        || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part)) && !filename.toLowerCase().includes('/.local/share/opencode');
}

export function captureFilePolicy(workspace: string, sdk: string, skills: string, mode: FilePolicy['mode']): FilePolicy {
    const readable = [workspace, sdk, skills].map(filename => {
        const stat = fs.lstatSync(filename, { bigint: true });
        if (!stat.isDirectory() || fs.realpathSync(filename) !== filename) fail('DENIED', 'Noncanonical tool root.');
        return { path: filename, dev: String(stat.dev), ino: String(stat.ino) };
    });
    if (readable.slice(1).some(root => root.path === workspace || root.path.startsWith(`${workspace}/`)
        || workspace.startsWith(`${root.path}/`))) fail('DENIED', 'Workspace and read-only roots must be disjoint.');
    return { workspace: readable[0], readable, mode };
}

function parsePatch(text: string): Change[] {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') fail('INVALID', 'Invalid patch envelope.');
    const changes: Change[] = [];
    let hunks = 0;
    for (let i = 0; i < lines.length;) {
        const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]);
        if (!header || changes.length >= 64) fail('INVALID', 'Invalid or oversized patch file list.');
        const change: Change = { kind: header![1].toLowerCase() as Change['kind'], source: header![2] };
        changes.push(change);
        if (change.kind === 'delete') continue;
        if (change.kind === 'add') {
            const content: string[] = [];
            while (i < lines.length && lines[i].startsWith('+')) content.push(lines[i++].slice(1));
            change.text = content.length ? `${content.join('\n')}\n` : '';
            continue;
        }
        if (lines[i]?.startsWith('*** Move to: ')) change.destination = lines[i++].slice(13);
        const chunks: Chunk[] = [];
        while (i < lines.length && !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[i])) {
            const line = lines[i++];
            if (line === '@@' || line.startsWith('@@ ')) {
                if (++hunks > 256) fail('INVALID', 'Patch hunk budget exceeded.');
                chunks.push({ old: [], next: [], ...(line !== '@@' ? { anchor: line.slice(3) } : {}) });
            } else if (line === '*** End of File' && chunks.length) {
                chunks[chunks.length - 1].eof = true;
                if (i < lines.length && !lines[i].startsWith('*** ')) fail('INVALID', 'End-of-file must end a file patch.');
            } else {
                const chunk = chunks.at(-1);
                if (!chunk || chunk.eof || ![' ', '+', '-'].includes(line[0])) fail('INVALID', 'Invalid patch hunk.');
                if (line[0] !== '+') chunk!.old.push(line.slice(1));
                if (line[0] !== '-') chunk!.next.push(line.slice(1));
            }
        }
        if (!chunks.length) fail('INVALID', 'An update requires exact-context hunks.');
        change.chunks = chunks;
    }
    if (!changes.length) fail('INVALID', 'Empty patch.');
    return changes;
}

function patchContent(original: string, chunks: Chunk[]): string {
    const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const content = original.slice(bom.length).replace(/\r\n/g, '\n');
    const lines = content ? content.split('\n') : [];
    if (lines.at(-1) === '') lines.pop();
    let cursor = 0;
    let work = 0;
    for (const chunk of chunks) {
        if (chunk.anchor !== undefined) {
            const anchors = lines.map((line, i) => i >= cursor && line === chunk.anchor ? i : -1).filter(i => i !== -1);
            if (anchors.length !== 1) fail('INVALID', 'Missing or ambiguous hunk anchor.');
            cursor = anchors[0] + 1;
        }
        const matches: number[] = [];
        for (let i = cursor; i <= lines.length - chunk.old.length; ++i) {
            if (++work > 8000000) fail('INVALID', 'Patch matching budget exceeded.');
            if (chunk.eof && i + chunk.old.length !== lines.length) continue;
            if (chunk.old.every((line, j) => {
                if (++work > 8000000) fail('INVALID', 'Patch matching budget exceeded.');
                return lines[i + j] === line;
            })) matches.push(i);
        }
        if (matches.length !== 1) fail('INVALID', 'Missing or ambiguous exact patch context; no files changed.');
        const start = matches[0];
        lines.splice(start, chunk.old.length, ...chunk.next);
        cursor = start + chunk.next.length;
    }
    return bom + (lines.length ? lines.join(newline) + newline : '');
}

export function createFileTools(input: FilePolicy) {
    if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) {
        fail('DENIED', 'Safe client file tools require non-root Linux with procfs.');
    }
    const policy: FilePolicy = JSON.parse(JSON.stringify(input));
    const authorize = (value: string, write: boolean): { filename: string; root: Root } => {
        if (!value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || value.split('/').includes('..')) {
            return fail('DENIED', 'Invalid file path.');
        }
        const filename = path.resolve(policy.workspace.path, value);
        const roots = write ? [policy.workspace] : policy.readable;
        const root = roots.find(item => filename === item.path || filename.startsWith(`${item.path}/`));
        if (!root || !safeName(filename) || (write && (policy.mode !== 'develop' || filename === root.path))) {
            return fail('DENIED', 'File path or operation is outside the startup permissions.');
        }
        return { filename, root };
    };

    function perform(kind: 'read' | 'write' | 'edit' | 'apply_patch', args: Record<string, unknown>, changes: Change[]) {
        type Dir = { fd: number; filename: string; stamp: string };
        type Pin = { filename: string; entry: string; parent: Dir; fd?: number; before?: BigIntStats; directory?: Dir };
        type Mutation = { pin: Pin; after?: string; stage?: string; staged?: BigIntStats;
            backup?: string; backupMarker?: BigIntStats; backedUp?: boolean; backedStamp?: string;
            backed?: BigIntStats; published?: BigIntStats };
        const dirs = new Map<string, Dir>();
        const handles: number[] = [];
        const mutations: Mutation[] = [];
        let lock: { entry: string; stamp: string } | undefined;
        let preserve = false;
        let inputBytes = 0;
        let failure: unknown;
        let output = '';
        const optionalStat = (entry: string): BigIntStats | undefined => {
            try { return fs.lstatSync(entry, { bigint: true }); } catch (error) { if (!absent(error)) throw error; }
        };
        function trustedDirectory(stat: BigIntStats): boolean {
            return stat.isDirectory() && (stat.uid === 0n || stat.uid === BigInt(process.getuid!()))
                && (!(stat.mode & 0o022n) || !!(stat.uid === 0n && (stat.mode & 0o1000n)));
        }
        function directory(filename: string): Dir {
            const cached = dirs.get(filename);
            if (cached) return cached;
            if (dirs.size > 512) return fail('INVALID', 'Directory budget exceeded.');
            const parent = filename === '/' ? undefined : directory(path.dirname(filename));
            const entry = parent ? `${fdPath(parent.fd)}/${path.basename(filename)}` : '/';
            const fd = fs.openSync(entry, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_NONBLOCK);
            handles.push(fd);
            const stat = fs.fstatSync(fd, { bigint: true });
            if (!trustedDirectory(stat)) {
                return fail('DENIED', 'Directories must be trusted and not writable by other users.');
            }
            const dir = { fd, filename, stamp: inode(stat) };
            dirs.set(filename, dir);
            return dir;
        }
        function checkDirs(): void {
            for (const dir of dirs.values()) {
                const stat = fs.fstatSync(dir.fd, { bigint: true });
                if (!trustedDirectory(stat) || inode(stat) !== dir.stamp || fs.readlinkSync(fdPath(dir.fd)) !== dir.filename) {
                    fail('CHANGED', 'A pinned directory moved; refusing path-based fallback.');
                }
            }
        }
        function rootDir(root: Root): Dir {
            const dir = directory(root.path);
            if (dir.stamp !== `${root.dev}:${root.ino}`) fail('CHANGED', 'A startup root was replaced.');
            checkDirs();
            return dir;
        }
        function pin(value: string, write: boolean): Pin {
            const { filename, root } = authorize(value, write);
            const anchored = rootDir(root);
            if (filename === root.path) return { filename, entry: fdPath(anchored.fd), parent: anchored, directory: anchored };
            const parent = directory(path.dirname(filename));
            checkDirs();
            const entry = `${fdPath(parent.fd)}/${path.basename(filename)}`;
            const before = optionalStat(entry);
            if (!before) return { filename, entry, parent };
            if (before.isDirectory() && !write) return { filename, entry, parent, directory: directory(filename) };
            if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES)) {
                return fail('DENIED', 'Only bounded, single-link regular files are supported.');
            }
            inputBytes += Number(before.size);
            if (inputBytes > MAX_BATCH_BYTES) return fail('INVALID', 'Transaction input byte budget exceeded.');
            const fd = fs.openSync(entry, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
            handles.push(fd);
            if (version(fs.fstatSync(fd, { bigint: true })) !== version(before)) fail('CHANGED', 'File changed while opening.');
            checkDirs();
            return { filename, entry, parent, before, fd };
        }
        function check(pin: Pin): void {
            checkDirs();
            const current = optionalStat(pin.entry);
            if (pin.before ? !current || version(current) !== version(pin.before)
                || version(fs.fstatSync(pin.fd!, { bigint: true })) !== version(pin.before) : current !== undefined) {
                fail('CHANGED', 'A transaction input or destination changed.');
            }
        }
        function text(pin: Pin): string {
            if (!pin.before || pin.fd === undefined) return fail('INVALID', 'An existing regular file is required.');
            check(pin);
            const buffer = Buffer.alloc(Number(pin.before.size) + 1);
            let length = 0;
            while (length < buffer.length) {
                const bytes = fs.readSync(pin.fd, buffer, length, buffer.length - length, length);
                if (!bytes) break;
                length += bytes;
            }
            check(pin);
            if (length !== Number(pin.before.size) || buffer.subarray(0, length).includes(0)) fail('INVALID', 'Changed or binary text input.');
            return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
        }
        const ownedUnlink = (entry: string, stamp: string): void => {
            const current = optionalStat(entry);
            if (!current || inode(current) !== stamp) fail('CHANGED', 'An owned transaction entry was replaced.');
            fs.unlinkSync(entry);
        };
        try {
            const workspace = rootDir(policy.workspace);
            const lockEntry = `${fdPath(workspace.fd)}/${LOCK}`;
            if (kind === 'read') {
                if (optionalStat(lockEntry)) fail('BUSY', 'A file transaction or recovery lock is present.');
                const item = pin(args.filePath as string, false);
                const offset = Number(args.offset ?? 1), limit = Number(args.limit ?? 200);
                let lines: string[];
                if (item.directory) {
                    const before = fs.fstatSync(item.directory.fd, { bigint: true });
                    const entries: string[] = [];
                    const stream = fs.opendirSync(fdPath(item.directory.fd));
                    try {
                        for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
                            if (entries.length >= 10000) fail('INVALID', 'Directory entry budget exceeded.');
                            entries.push(entry.name);
                        }
                    } finally { stream.closeSync(); }
                    lines = entries.sort().flatMap(name => {
                        if (/[\x00-\x1f\x7f\\]/.test(name) || !safeName(path.join(item.filename, name))) return [];
                        const stat = optionalStat(`${fdPath(item.directory!.fd)}/${name}`);
                        return stat?.isDirectory() ? [`${name}/`] : stat?.isFile() && stat.nlink === 1n ? [name] : [];
                    });
                    if (version(before) !== version(fs.fstatSync(item.directory.fd, { bigint: true }))) fail('CHANGED', 'Directory changed during inspection.');
                } else lines = text(item).split('\n');
                checkDirs();
                if (optionalStat(lockEntry)) fail('BUSY', 'A file transaction started during inspection.');
                let output = `${item.filename}\n`;
                let next = offset - 1;
                for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); ++i) {
                    const line = `${i + 1}: ${lines[i].slice(0, 2000)}\n`;
                    if (Buffer.byteLength(output + line) > 40000) break;
                    output += line;
                    next = i + 1;
                }
                return output + (next < lines.length ? `(More entries/lines; use offset=${next + 1}.)\n` : '');
            }

            if (optionalStat(lockEntry)) fail('BUSY', 'A file transaction or recovery lock is present.');
            const pins = new Map<string, Pin>();
            for (const change of changes) for (const value of [change.source, ...(change.destination !== undefined ? [change.destination] : [])]) {
                const filename = authorize(value, true).filename;
                if (pins.has(filename)) fail('INVALID', 'Duplicate/overlapping patch endpoints.');
                pins.set(filename, pin(filename, true));
            }
            const lockFd = fs.openSync(lockEntry, C.O_CREAT | C.O_EXCL | C.O_RDWR | C.O_NOFOLLOW, 0o600);
            handles.push(lockFd);
            lock = { entry: lockEntry, stamp: inode(fs.fstatSync(lockFd, { bigint: true })) };
            for (const item of pins.values()) check(item);
            // All endpoints are authorized/opened before reading hunks or creating stages.
            let outputBytes = 0;
            for (const change of changes) {
                const source = pins.get(authorize(change.source, true).filename)!;
                let after: string | undefined;
                if (kind === 'write') after = args.content as string;
                else if (kind === 'edit') {
                    const original = text(source), old = args.oldString as string;
                    const parts = original.split(old);
                    if (parts.length < 2 || (!args.replaceAll && parts.length !== 2)) fail('INVALID', 'Missing or ambiguous edit text.');
                    if (Buffer.byteLength(original) + (parts.length - 1)
                        * (Buffer.byteLength(args.newString as string) - Buffer.byteLength(old)) > MAX_BYTES) {
                        fail('INVALID', 'Output file exceeds its byte budget.');
                    }
                    after = parts.join(args.newString as string);
                } else if (change.kind === 'add') {
                    if (source.before) fail('INVALID', 'Patch Add cannot overwrite an existing file.');
                    after = change.text!;
                } else {
                    const original = text(source);
                    if (change.kind === 'update') after = patchContent(original, change.chunks!);
                }
                if (after !== undefined && Buffer.byteLength(after) > MAX_BYTES) fail('INVALID', 'Output file exceeds its byte budget.');
                outputBytes += Buffer.byteLength(after ?? '');
                if (outputBytes > MAX_BATCH_BYTES) fail('INVALID', 'Transaction output byte budget exceeded.');
                if (change.destination !== undefined) {
                    const destination = pins.get(authorize(change.destination, true).filename)!;
                    if (destination.before) fail('INVALID', 'Move destination must not exist.');
                    mutations.push({ pin: source }, { pin: destination, after });
                } else mutations.push({ pin: source, after });
            }
            const nonce = randomUUID();
            for (let i = 0; i < mutations.length; ++i) {
                const item = mutations[i];
                const base = `${fdPath(item.pin.parent.fd)}/.cocos4-ai-${nonce}-${i}`;
                if (item.pin.before) item.backup = `${base}.old`;
                if (item.after !== undefined) item.stage = `${base}.new`;
            }
            fs.writeFileSync(lockFd, JSON.stringify({ transaction: nonce, paths: mutations.map(item => ({ path: item.pin.filename,
                backup: item.backup && path.basename(item.backup), stage: item.stage && path.basename(item.stage) })) }));
            fs.fsyncSync(lockFd);
            for (const item of mutations) {
                check(item.pin);
                if (item.backup) {
                    // A regular placeholder makes rename reject a source that raced
                    // into a directory. Reserved names are never client file inputs.
                    const fd = fs.openSync(item.backup, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
                    try { item.backupMarker = fs.fstatSync(fd, { bigint: true }); }
                    finally { fs.closeSync(fd); }
                }
                if (!item.stage) continue;
                const fd = fs.openSync(item.stage, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
                try {
                    item.staged = fs.fstatSync(fd, { bigint: true });
                    fs.writeFileSync(fd, item.after!);
                    fs.fchmodSync(fd, item.pin.before ? Number(item.pin.before.mode & 0o777n) & ~0o022 : 0o600);
                    fs.fsyncSync(fd);
                    item.staged = fs.fstatSync(fd, { bigint: true });
                } finally { fs.closeSync(fd); }
            }
            for (const item of mutations) check(item.pin);
            try {
                // Withdraw and verify every old entry before publishing any output.
                // Rename/link/unlink operate on anchored entries, never through the
                // user-supplied final component. Existing inodes are never written.
                for (const item of mutations) {
                    check(item.pin);
                    if (item.backup) {
                        fs.renameSync(item.pin.entry, item.backup);
                        item.backedUp = true;
                        const stat = fs.lstatSync(item.backup, { bigint: true });
                        item.backedStamp = inode(stat);
                        if (!stat.isFile() || stat.nlink !== 1n || contentsVersion(stat) !== contentsVersion(item.pin.before!)) {
                            fail('CHANGED', 'An input was replaced or linked at publication; rolling back.');
                        }
                        item.backed = stat;
                    }
                }
                for (const item of mutations) {
                    checkDirs();
                    if (optionalStat(item.pin.entry)) fail('CHANGED', 'A destination appeared before publication.');
                    if (item.backed && (version(fs.lstatSync(item.backup!, { bigint: true })) !== version(item.backed)
                        || version(fs.fstatSync(item.pin.fd!, { bigint: true })) !== version(item.backed))) {
                        fail('CHANGED', 'A withdrawn input changed before publication.');
                    }
                    if (item.stage) {
                        if (version(fs.lstatSync(item.stage, { bigint: true })) !== version(item.staged!)) {
                            fail('CHANGED', 'A staged output changed.');
                        }
                        // Atomic no-replace publication, including for Move destinations.
                        fs.linkSync(item.stage, item.pin.entry);
                        item.published = fs.lstatSync(item.pin.entry, { bigint: true });
                        if (item.published.nlink !== 2n || contentsVersion(item.published) !== contentsVersion(item.staged!)) {
                            fail('CHANGED', 'A staged output was replaced or linked at publication.');
                        }
                    }
                }
                checkDirs();
                for (const item of mutations) {
                    const current = optionalStat(item.pin.entry);
                    if (item.published ? !current || version(current) !== version(item.published) : current !== undefined) {
                        fail('CHANGED', 'A published output changed; rolling back.');
                    }
                    if (item.backed && version(fs.lstatSync(item.backup!, { bigint: true })) !== version(item.backed)) {
                        fail('CHANGED', 'A withdrawn input changed; rolling back.');
                    }
                    fs.fsyncSync(item.pin.parent.fd);
                }
            } catch (error) {
                let restored = true;
                for (const item of mutations.slice().reverse()) {
                    try {
                        if (item.published) ownedUnlink(item.pin.entry, inode(item.published));
                        if (item.backedUp) {
                            if (!item.backedStamp || inode(fs.lstatSync(item.backup!, { bigint: true })) !== item.backedStamp) {
                                fail('CHANGED', 'Backup identity changed.');
                            }
                            // link() does not follow a symlink and refuses an occupied
                            // destination, so rollback cannot overwrite an actor's file.
                            fs.linkSync(item.backup!, item.pin.entry);
                            ownedUnlink(item.backup!, item.backedStamp!);
                            item.backedUp = false;
                            item.backupMarker = undefined;
                        }
                    } catch { restored = false; }
                }
                if (!restored) { preserve = true; return fail('RECOVERY_REQUIRED', 'Concurrent mutation prevented rollback; lock/backups retained.'); }
                throw error;
            }
            // Publication is complete. Cleanup failure is not a partial commit:
            // retain the lock and report it rather than retrying or hiding success.
            for (const item of mutations) {
                try { if (item.backedUp) { ownedUnlink(item.backup!, item.backedStamp!); item.backedUp = false; item.backupMarker = undefined; } }
                catch { preserve = true; }
            }
            output = `Committed ${mutations.length} file changes.\n` + mutations.map(item => item.pin.filename).join('\n');
        } catch (error) {
            failure = error;
        } finally {
            if (!preserve) {
                for (const item of mutations) {
                    if (item.stage && item.staged) {
                        try { ownedUnlink(item.stage, inode(item.staged)); } catch { preserve = true; }
                    }
                    if (item.backup && item.backupMarker && !item.backedUp) {
                        try { ownedUnlink(item.backup, inode(item.backupMarker)); } catch { preserve = true; }
                    }
                }
                if (lock && !preserve) {
                    try { ownedUnlink(lock.entry, lock.stamp); } catch { preserve = true; }
                }
            }
            for (const fd of handles.reverse()) fs.closeSync(fd);
        }
        if (failure) {
            if (preserve) return fail('RECOVERY_REQUIRED', 'File operation failed; owned lock/stages/backups retained. Inspect before retrying.');
            if (failure instanceof Error && failure.message.startsWith('AI_FILES_')) throw failure;
            const code = (failure as NodeJS.ErrnoException)?.code;
            return fail(code === 'EEXIST' && !lock ? 'BUSY' : 'DENIED', 'Filesystem operation refused; no path-following fallback.');
        }
        return output + (preserve ? '\nCleanup/recovery lock retained; do not retry blindly.' : '');
    }

    const string = { type: 'string' };
    const shapes = {
        read: { filePath: string, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } },
        write: { filePath: string, content: string },
        edit: { filePath: string, oldString: string, newString: string, replaceAll: { type: 'boolean' } },
        apply_patch: { patchText: string },
    };
    const descriptions = {
        read: 'Read bounded UTF-8 text or list an authorized directory, rejecting links and secret paths. offset=1, limit=200 by default.',
        write: 'Create/replace a UTF-8 game file in an existing directory. Develop mode only. Uses anchored transactional publication.',
        edit: 'Replace exact text in a game file. Set replaceAll=false unless all occurrences are intended. Develop mode only.',
        apply_patch: 'Apply *** Begin Patch / Add File / Update File / Move to / Delete File hunks transactionally. Exact, unambiguous context; existing parent directories; no overwrite on Add/Move.',
    };
    const tools = {} as Record<keyof typeof shapes, { description: string; args: Record<string, unknown>;
        execute: (args: unknown, ctx: Context) => Promise<string> }>;
    for (const kind of Object.keys(shapes) as (keyof typeof shapes)[]) tools[kind] = {
        description: descriptions[kind], args: shapes[kind],
        async execute(value: unknown, ctx: Context): Promise<string> {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID', 'Expected tool arguments.');
            const args = value as Record<string, unknown>;
            if (Object.keys(args).some(key => !Object.hasOwn(shapes[kind], key))) return fail('INVALID', 'Unknown tool argument.');
            for (const [key, shape] of Object.entries(shapes[kind])) {
                if (args[key] === undefined && ['offset', 'limit', 'replaceAll'].includes(key)) continue;
                if (shape.type === 'integer' ? !Number.isSafeInteger(args[key]) || Number(args[key]) < 1
                    || (key === 'limit' && Number(args[key]) > 2000) : typeof args[key] !== shape.type) return fail('INVALID', 'Invalid tool argument.');
                if (typeof args[key] === 'string' && (Buffer.byteLength(args[key] as string) > MAX_BYTES || (args[key] as string).includes('\0'))) {
                    return fail('INVALID', 'Tool input byte budget exceeded or NUL input.');
                }
            }
            if (kind === 'edit' && !args.oldString) return fail('INVALID', 'Empty edit context.');
            if (kind !== 'read' && policy.mode !== 'develop') return fail('DENIED', 'Read-only mode forbids every file mutation.');
            const changes: Change[] = kind === 'apply_patch' ? parsePatch(args.patchText as string)
                : [{ kind: 'update', source: args.filePath as string }];
            const patterns = changes.flatMap(item => [item.source, ...(item.destination !== undefined ? [item.destination] : [])])
                .map(filename => authorize(filename, kind !== 'read').filename);
            await ctx.ask({ permission: `cocos4_${kind}`, patterns, always: [], metadata: { paths: patterns } });
            if (ctx.abort?.aborted) return fail('CANCELLED', 'File operation cancelled.');
            return perform(kind, args, changes);
        },
    };
    return tools;
}
