import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError, permissionsSchema } from './contracts.js';
import { loadSdk, parseJson } from './sdk.js';
import { bundledSkillNames, makeOpenCodeConfig, opencodeSupport, type AiRoots } from './ai-config.js';
import { captureFilePolicy } from './ai-files.js';
import { acquireWindowsPath, enforceWindowsPrivate, enforceWindowsReadOnly, validateWindowsPath, verifyWindowsTrust,
    type WindowsPathLease } from './windows-fs.js';

export type AiOptions = AiRoots & { client: 'opencode'; executable: string };
const sourceFiles = ['config', 'config.json', 'opencode.json', 'opencode.jsonc'];
const forbiddenPath = /[\x00-\x1f\x7f*?\[\]{}\\]/;
const windows = process.platform === 'win32';
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const samePath = (left: string, right: string): boolean => windows ? left.toLowerCase() === right.toLowerCase() : left === right;
const environmentValue = (environment: NodeJS.ProcessEnv, name: string): string | undefined =>
    environment[Object.keys(environment).find(key => windows ? key.toLowerCase() === name.toLowerCase() : key === name) ?? name];

function absolute(value: string, label: string): string {
    if (windows) {
        try {
            if (/[\[\]{}]/.test(value)) throw new Error('Interpolation is forbidden.');
            return validateWindowsPath(value);
        } catch { throw new AppError('INVALID_ARGUMENTS', `${label} must be a normalized absolute local Windows path without aliases, controls or interpolation.`); }
    }
    if (!value || value.length > 4096 || !path.isAbsolute(value) || forbiddenPath.test(value)) {
        throw new AppError('INVALID_ARGUMENTS', `${label} must be an absolute path without controls, interpolation or glob characters.`);
    }
    return path.resolve(value);
}

export function parseAiArgs(args: string[]): AiOptions {
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
        const [key, value] = [args[i], args[i + 1]];
        if (!['--client', '--executable', '--workspace', '--sdk-root', '--state-root', '--mode', '--preview'].includes(key)
            || flags.has(key) || !value || value.length > 4096 || value.startsWith('--')) {
            throw new AppError('INVALID_ARGUMENTS', 'Invalid ai option. No client argument passthrough, commands or shell are accepted.');
        }
        flags.set(key, value);
    }
    if (flags.get('--client') !== 'opencode' || !['--executable', '--workspace', '--sdk-root', '--state-root'].every(key => flags.has(key))) {
        throw new AppError('INVALID_ARGUMENTS', 'ai requires --client opencode, --executable, --workspace, --sdk-root and --state-root.');
    }
    if (flags.has('--preview') && !['true', 'false'].includes(flags.get('--preview')!)) {
        throw new AppError('PERMISSION_DENIED', '--preview must be true or false.');
    }
    const permissions = permissionsSchema.safeParse({ mode: flags.get('--mode'), preview: flags.get('--preview') === 'true' });
    if (!permissions.success || (permissions.data.preview && permissions.data.mode !== 'develop')) {
        throw new AppError('PERMISSION_DENIED', 'Preview requires explicit develop mode and --preview true.');
    }
    return { client: 'opencode', executable: absolute(flags.get('--executable')!, '--executable'),
        workspace: absolute(flags.get('--workspace')!, '--workspace'), sdkRoot: absolute(flags.get('--sdk-root')!, '--sdk-root'),
        stateRoot: absolute(flags.get('--state-root')!, '--state-root'), mode: permissions.data.mode, preview: permissions.data.preview };
}

function conflict(source: string, detail: string): never {
    throw new AppError('OUTPUT_CONFLICT', `OpenCode conflict at ${source.slice(0, 512)}: ${detail}`, [
        'Use a separately selected clean environment/workspace or resolve the conflict yourself. No existing configuration was changed.',
        'The isolated client imports no existing config, plugins or stored credentials; provider authentication environment variables are preserved.',
    ]);
}

async function present(filename: string): Promise<Stats | undefined> {
    try { return await fs.lstat(filename); } catch (error) { if (missing(error)) return; throw error; }
}

async function boundedText(filename: string, maxBytes = 256 * 1024): Promise<string> {
    const lease = windows ? await acquireWindowsPath(filename, { immutable: true }) : undefined;
    try {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || !samePath(await fs.realpath(filename), filename)) {
        conflict(filename, 'Cannot safely inspect this regular, bounded config/skill file.');
    }
    const handle = await fs.open(filename, windows ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) conflict(filename, 'File changed.');
        const bytes = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
        }
        const after = await handle.stat();
        if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) conflict(filename, 'File changed.');
        await lease?.check();
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
    } finally { await lease?.close(); }
}

export function parseConfigForConflicts(text: string): Record<string, unknown> {
    // Strip JSONC comments/trailing commas without touching quoted strings;
    // parseJson also rejects duplicate (including escaped) object keys.
    const json = text.replace(/^\uFEFF/, '')
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, quoted: string | undefined) => quoted ?? ' ')
        .replace(/("(?:[^"\\]|\\.)*")|,\s*([}\]])/g, (match, quoted: string | undefined, close: string) => quoted ?? close);
    const data = parseJson(json);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a configuration object.');
    return data as Record<string, unknown>;
}

function skillName(text: string, source: string): string | undefined {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (frontmatter === undefined) return;
    const names = [...frontmatter.matchAll(/^(?:name|"name"|'name'):[ \t]*(.*)$/gm)];
    if (!names.length) {
        if (/[{}&*!"']/.test(frontmatter)) conflict(source, 'Complex YAML skill names cannot be checked safely.');
        return;
    }
    if (names.length !== 1) conflict(source, 'Ambiguous skill name.');
    const raw = names[0][1].trim();
    let name = raw.replace(/[ \t]+#.*$/, '');
    if (raw.startsWith('"')) {
        try { name = JSON.parse(raw); } catch { conflict(source, 'Cannot inspect a quoted skill name.'); }
    } else if (raw.startsWith("'")) {
        if (!/^'[^']*'$/.test(raw)) conflict(source, 'Cannot inspect a quoted skill name.');
        name = raw.slice(1, -1);
    }
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) conflict(source, 'Cannot establish an unambiguous skill name.');
    return name;
}

async function scanSkills(root: string, bundled: boolean, seen: Set<string>, budget: { entries: number }): Promise<void> {
    if (!await present(root)) return;
    async function walk(directory: string, depth: number): Promise<void> {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || !samePath(await fs.realpath(directory), directory)) conflict(directory, 'Skill directory is a link or not a directory.');
        const lease = windows ? await acquireWindowsPath(directory, { directory: true }) : undefined;
        try {
        if (depth > 16) conflict(root, 'Skill discovery exceeds its depth budget.');
        const entries = await fs.opendir(directory);
        for await (const entry of entries) {
            if (++budget.entries > 10000) conflict(root, 'Skill discovery exceeds its entry budget.');
            const filename = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) conflict(filename, 'Cannot safely inspect linked skills.');
            if (entry.isDirectory()) await walk(filename, depth + 1);
            else if (entry.name === 'SKILL.md') {
                const name = skillName(await boundedText(filename, 64 * 1024), filename);
                const reserved = bundledSkillNames.some(value => value.toLowerCase() === name?.toLowerCase());
                if (!bundled && reserved) conflict(filename, `Reserved bundled skill name ${name}.`);
                if (bundled) {
                    if (!reserved || seen.has(name!) || path.relative(root, filename) !== path.join(name!, 'SKILL.md')) {
                        conflict(filename, 'Bundled skill names must be unique, expected names with matching directories.');
                    }
                    seen.add(name!);
                }
            } else if (!entry.isFile()) conflict(filename, 'Special files are not skill inputs.');
        }
        await lease?.check();
        } finally { await lease?.close(); }
    }
    await walk(root, 0);
}

export async function checkOpenCodeConflicts(workspace: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
    for (const [key, value] of Object.entries(environment)) {
        // Provider keys are authentication, not client configuration. Do not
        // print values, expand substitutions, or read credential stores.
        if (value !== undefined && /^OPENCODE_/i.test(key) && !['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'].includes(windows ? key.toUpperCase() : key)) {
            conflict(`environment variable ${key}`, 'Explicit client environment configuration is not merged.');
        }
    }
    const home = absolute(environmentValue(environment, 'HOME') || (windows ? environmentValue(environment, 'USERPROFILE') : undefined) || homedir(), 'HOME');
    const configHome = absolute(environmentValue(environment, 'XDG_CONFIG_HOME') || path.join(home, '.config'), 'XDG_CONFIG_HOME');
    const managed = windows ? path.join(absolute(environmentValue(environment, 'ProgramData') || 'C:\\ProgramData', 'ProgramData'), 'opencode') : '/etc/opencode';
    for (const name of ['opencode.json', 'opencode.jsonc']) {
        if (await present(path.join(managed, name))) conflict(path.join(managed, name), 'Managed configuration cannot be bypassed or merged safely.');
    }
    const scopes = new Set([home]);
    for (let current = workspace, depth = 0;; current = path.dirname(current)) {
        if (++depth > 64) conflict(workspace, 'Too many workspace ancestors.');
        scopes.add(current);
        if (current === path.dirname(current)) break;
    }
    const configDirs = new Set([path.join(configHome, 'opencode'), ...[...scopes].map(root => path.join(root, '.opencode'))]);
    const files = new Set<string>();
    const skillDirs = new Set<string>();
    for (const root of configDirs) {
        for (const name of sourceFiles) files.add(path.join(root, name));
        for (const name of ['skills', 'skill']) skillDirs.add(path.join(root, name));
    }
    for (const root of scopes) {
        for (const name of ['opencode.json', 'opencode.jsonc']) files.add(path.join(root, name));
        for (const name of ['.claude', '.agents']) skillDirs.add(path.join(root, name, 'skills'));
    }
    const ignored: string[] = [];
    for (const filename of files) {
        if (!await present(filename)) continue;
        if (path.basename(filename) === 'config') conflict(filename, 'Legacy executable/TOML configuration is not imported.');
        let data: Record<string, unknown>;
        try { data = parseConfigForConflicts(await boundedText(filename)); }
        catch (error) { if (error instanceof AppError && error.code === 'OUTPUT_CONFLICT') throw error; conflict(filename, 'Malformed or duplicate-key configuration.'); }
        for (const field of ['mcp', 'agent', 'mode']) {
            const entries = data[field];
            if (entries && typeof entries === 'object' && Object.keys(entries).some(name => name.toLowerCase() === 'cocos4')) {
                conflict(filename, `Reserved ${field} name cocos4.`);
            }
        }
        if (data.skills !== undefined) {
            const skills = data.skills as { paths?: unknown; urls?: unknown };
            if (!skills || typeof skills !== 'object' || Array.isArray(skills)
                || (skills.paths !== undefined && (!Array.isArray(skills.paths) || skills.paths.some(item => typeof item !== 'string')))
                || (skills.urls !== undefined && (!Array.isArray(skills.urls) || skills.urls.length))) {
                conflict(filename, 'Remote or ambiguous skill sources cannot be checked offline.');
            }
            for (const item of skills.paths as string[] ?? []) {
                if (item.includes('{') || item.includes('://')) conflict(filename, 'Skill path interpolation or URLs are not resolved.');
                skillDirs.add(absolute(item.startsWith('~/') ? path.join(home, item.slice(2)) : path.resolve(workspace, item), 'Skill path'));
            }
        }
        ignored.push(filename);
    }
    const budget = { entries: 0 };
    for (const directory of skillDirs) await scanSkills(directory, false, new Set(), budget);
    return ignored;
}

async function privateState(root: string): Promise<void> {
    let current = path.parse(root).root;
    for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (!await present(current)) {
            if (windows) await verifyWindowsTrust(path.dirname(current));
            await fs.mkdir(current, { mode: 0o700 });
            if (windows) await enforceWindowsPrivate(current);
        }
        if (windows) { await verifyWindowsTrust(current, samePath(current, root)); continue; }
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid!())
            || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))) {
            throw new AppError('PERMISSION_DENIED', 'State ancestors must be canonical directories not replaceable by other users.');
        }
    }
    if (windows) return;
    const stat = await fs.lstat(root);
    if (stat.uid !== process.getuid!() || stat.mode & 0o077 || await fs.realpath(root) !== root) {
        throw new AppError('PERMISSION_DENIED', 'State must be a private, user-owned directory. Existing permissions are never changed.');
    }
}

export function openCodeEnvironment(environment: NodeJS.ProcessEnv, session: string): NodeJS.ProcessEnv {
    const env = { ...environment };
    for (const name of Object.keys(env)) {
        const canonical = windows ? name.toUpperCase() : name;
        if (/^(?:NODE_OPTIONS$|NODE_PATH$|BUN_OPTIONS$|BUN_ENV_FILE$|LD_|DYLD_|npm_|NPM_|OTEL_|GIT_|OPENCODE(?:_|$))/.test(canonical)
            && !['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'].includes(canonical)) delete env[name];
        if (windows && /^(?:XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA)$/i.test(name)) delete env[name];
    }
    return { ...env,
        OPENCODE_CONFIG: path.join(session, 'config/opencode/opencode.json'),
        OPENCODE_CONFIG_DIR: path.join(session, 'config/opencode'),
        // Global.Path.home is separate from HOME in the reviewed client. Keep
        // HOME and provider auth environment intact, but do not scan ~/.opencode.
        OPENCODE_TEST_HOME: path.join(session, 'home'),
        XDG_CONFIG_HOME: path.join(session, 'config'), XDG_DATA_HOME: path.join(session, 'data'),
        XDG_STATE_HOME: path.join(session, 'state'), XDG_CACHE_HOME: path.join(session, 'cache'),
        TMPDIR: path.join(session, 'tmp'),
        ...(windows ? { TEMP: path.join(session, 'tmp'), TMP: path.join(session, 'tmp'),
            APPDATA: path.join(session, 'config'), LOCALAPPDATA: path.join(session, 'data') } : {}),
        GIT_DIR: path.join(session, 'no-git'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_PURE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_TERMINAL_TITLE: '1',
        OTEL_SDK_DISABLED: 'true', npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
    };
}

function identity(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }

function verifyMcpPe(bytes: Buffer, libraries: string[]): void {
    const require = (condition: boolean): void => { if (!condition) throw new Error('Invalid Windows MCP image.'); };
    require(bytes.length >= 256 && bytes.readUInt16LE(0) === 0x5a4d);
    const header = bytes.readUInt32LE(0x3c);
    require(header >= 64 && header + 24 <= bytes.length && bytes.readUInt32LE(header) === 0x4550
        && bytes.readUInt16LE(header + 4) === 0x8664);
    const count = bytes.readUInt16LE(header + 6), optional = header + 24;
    const optionalBytes = bytes.readUInt16LE(header + 20), sections = optional + optionalBytes;
    require(count > 0 && count <= 96 && optionalBytes >= 240 && sections + count * 40 <= bytes.length
        && bytes.readUInt16LE(optional) === 0x20b && (bytes.readUInt16LE(optional + 70) & 0x160) === 0x160
        && bytes.readUInt32LE(optional + 108) >= 14 && bytes.readUInt32LE(optional + 112 + 13 * 8) === 0);
    const offset = (rva: number, length = 1): number => {
        for (let index = 0; index < count; index++) {
            const at = sections + index * 40, start = bytes.readUInt32LE(at + 12);
            const size = bytes.readUInt32LE(at + 16), raw = bytes.readUInt32LE(at + 20);
            if (rva >= start && rva - start + length <= size && raw + rva - start + length <= bytes.length) return raw + rva - start;
        }
        throw new Error('Invalid Windows MCP image address.');
    };
    for (let index = 0; index < count; index++) {
        require((bytes.readUInt32LE(sections + index * 40 + 36) & 0xa0000000) !== 0xa0000000);
    }
    const imports = bytes.readUInt32LE(optional + 120), size = bytes.readUInt32LE(optional + 124);
    require(imports > 0 && size >= 20 && size <= 65536);
    const actual: string[] = [], allowed = new Set(['kernel32.dll', 'msvcrt.dll', 'advapi32.dll', 'shell32.dll', 'userenv.dll']);
    let terminated = false;
    for (let index = 0; index < Math.floor(size / 20); index++) {
        const at = offset(imports + index * 20, 20);
        if (bytes.subarray(at, at + 20).every(value => value === 0)) { terminated = true; break; }
        const name = offset(bytes.readUInt32LE(at + 12));
        let end = name;
        while (end < bytes.length && end - name <= 256 && bytes[end] !== 0) end++;
        require(end < bytes.length && end > name && end - name <= 256);
        const library = bytes.toString('ascii', name, end).toLowerCase();
        require(allowed.has(library) && !actual.includes(library)); actual.push(library);
    }
    require(terminated && actual.length > 0 && JSON.stringify(actual.sort()) === JSON.stringify(libraries.map(value => value.toLowerCase()).sort()));
}

async function windowsMcpLauncher(): Promise<{ filename: string; verify: () => Promise<void> }> {
    const filename = absolute(fileURLToPath(new URL('../host/cocos4-mcp-launch.exe', import.meta.url)), 'MCP helper');
    const stamps = new Map<string, string>();
    const read = async (file: string, maximum: number): Promise<Buffer> => {
        const lease = await acquireWindowsPath(file, { immutable: true, trusted: true });
        try {
            const before = await fs.lstat(file);
            if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error('Unsafe helper file.');
            const bytes = await fs.readFile(file);
            if (bytes.length !== before.size || identity(await fs.lstat(file)) !== identity(before)) throw new Error('Helper changed.');
            await lease.check(); stamps.set(file, identity(before)); return bytes;
        } finally { await lease.close(); }
    };
    try {
        const report = z.object({ schemaVersion: z.literal(1), protocol: z.literal('cocos4-mcp-launch-v1'),
            target: z.literal('win32-x64'), linkage: z.literal('windows-system-libraries'), source: z.literal('runtime/mcp-launch-win32.c'),
            sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z.number().int().min(256).max(32 * 1024 * 1024), sharedLibraries: z.array(z.string()).min(1).max(16),
            requiredVersions: z.array(z.string()).length(0),
        }).parse(parseJson((await read(`${filename}.build.json`, 256 * 1024)).toString('utf8')));
        const bytes = await read(filename, 32 * 1024 * 1024);
        if (bytes.length !== report.bytes || createHash('sha256').update(bytes).digest('hex') !== report.binarySha256) throw new Error('Helper integrity mismatch.');
        verifyMcpPe(bytes, report.sharedLibraries);
    } catch {
        throw new AppError('SDK_INCOMPLETE', 'AI requires the verified shipped Windows x64 cocos4-mcp-launch.exe helper and integrity report.',
            ['Install a complete trusted kit; AI never compiles, downloads or falls back to a host executable.']);
    }
    const verify = async (): Promise<void> => {
        for (const [file, stamp] of stamps) {
            await verifyWindowsTrust(file);
            if (identity(await fs.lstat(file)) !== stamp) throw new AppError('INPUT_CHANGED', 'The shipped MCP launcher changed after validation.');
        }
    };
    await verify(); return { filename, verify };
}

async function mcpLauncher(): Promise<{ filename: string; verify: () => Promise<void> }> {
    if (windows) return windowsMcpLauncher();
    // build/{src,host} in source, app/{src,host} in a portable kit. Never search
    // the SDK, workspace, environment or PATH for an executable replacement.
    const filename = absolute(fileURLToPath(new URL('../host/cocos4-mcp-launch', import.meta.url)), 'MCP helper');
    const stamps = new Map<string, string>();
    try {
        for (let directory = path.dirname(filename);; directory = path.dirname(directory)) {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid!())
                || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))) throw new Error('Unsafe helper ancestor.');
            if (directory === path.dirname(directory)) break;
        }
        const read = async (file: string, maximum: number): Promise<Buffer> => {
            const before = await fs.lstat(file);
            if (!before.isFile() || before.nlink !== 1 || before.size > maximum
                || (before.uid !== 0 && before.uid !== process.getuid!()) || (before.mode & 0o6022)
                || await fs.realpath(file) !== file) throw new Error('Unsafe helper file.');
            const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                if (identity(await handle.stat()) !== identity(before)) throw new Error('Helper changed.');
                const bytes = Buffer.alloc(before.size + 1);
                let length = 0;
                while (length < bytes.length) {
                    const result = await handle.read(bytes, length, bytes.length - length, null);
                    if (!result.bytesRead) break;
                    length += result.bytesRead;
                }
                if (length !== before.size || identity(await handle.stat()) !== identity(before)) throw new Error('Helper changed.');
                stamps.set(file, identity(before));
                return bytes.subarray(0, length);
            } finally { await handle.close(); }
        };
        const report = z.object({ schemaVersion: z.literal(1), protocol: z.literal('cocos4-mcp-launch-v1'),
            target: z.literal('linux-x64'), linkage: z.literal('static-no-libc'), source: z.literal('runtime/mcp-launch.c'),
            sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z.number().int().min(64).max(1024 * 1024), sharedLibraries: z.array(z.string()).length(0),
            requiredVersions: z.array(z.string()).length(0),
        }).parse(parseJson((await read(`${filename}.build.json`, 64 * 1024)).toString('utf8')));
        const bytes = await read(filename, 1024 * 1024);
        await fs.access(filename, constants.X_OK);
        if (bytes.length !== report.bytes || createHash('sha256').update(bytes).digest('hex') !== report.binarySha256
            || bytes.length < 64 || !bytes.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
            || bytes.readUInt16LE(16) !== 2 || bytes.readUInt16LE(18) !== 62 || bytes.readUInt32LE(20) !== 1
            || bytes.readUInt16LE(52) !== 64 || bytes.readUInt16LE(54) !== 56) throw new Error('Invalid helper ELF/integrity.');
        const offset = bytes.readBigUInt64LE(32), count = bytes.readUInt16LE(56);
        if (offset < 64n || !count || count > 128 || offset + BigInt(count * 56) > BigInt(bytes.length)) throw new Error('Invalid ELF headers.');
        let executable = false;
        for (let i = 0; i < count; ++i) {
            const at = Number(offset) + i * 56, type = bytes.readUInt32LE(at), flags = bytes.readUInt32LE(at + 4);
            // PT_INTERP and PT_DYNAMIC are forbidden even if a matching report
            // claims static linkage. The helper must run before any loader.
            if (type === 2 || type === 3 || (type === 0x6474e551 && (flags & 1))) throw new Error('Helper has a loader or executable stack.');
            if (type === 1 && (flags & 1)) executable = true;
        }
        if (!executable) throw new Error('Helper has no executable load segment.');
    } catch {
        throw new AppError('SDK_INCOMPLETE', 'AI requires the verified shipped Linux x64 cocos4-mcp-launch helper and integrity report.',
            ['Install a complete trusted kit; AI never compiles, downloads or falls back to a host env executable.']);
    }
    const verify = async (): Promise<void> => {
        for (const [file, stamp] of stamps) {
            const stat = await present(file);
            if (!stat || identity(stat) !== stamp || await fs.realpath(file) !== file) {
                throw new AppError('INPUT_CHANGED', 'The shipped MCP launcher changed after validation.');
            }
        }
    };
    await verify();
    return { filename, verify };
}

export async function prepareOpenCode(input: AiOptions, environment: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
    const checkCancelled = (): void => { if (signal?.aborted) throw new AppError('CANCELLED', 'AI startup was cancelled.'); };
    checkCancelled();
    // Revalidate programmatic callers as well as the CLI.
    const options = parseAiArgs(['--client', input.client, '--executable', input.executable,
        '--workspace', input.workspace, '--sdk-root', input.sdkRoot, '--state-root', input.stateRoot,
        '--mode', input.mode, '--preview', String(input.preview)]);
    if (process.arch !== 'x64' || (!windows && (process.platform !== 'linux' || !process.getuid || process.getuid() === 0))) {
        throw new AppError('SDK_INCOMPLETE', 'The isolated AI launcher requires Windows x64 or non-root Linux x64.');
    }
    const workspace = absolute(await fs.realpath(options.workspace), '--workspace');
    if (!(await fs.lstat(workspace)).isDirectory()) throw new AppError('INVALID_ARGUMENTS', 'Workspace must already be a directory.');
    const roots: AiRoots = { workspace, sdkRoot: options.sdkRoot, stateRoot: options.stateRoot, mode: options.mode, preview: options.preview };
    const contained = (parent: string, child: string): boolean => {
        const relative = path.relative(parent, child);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    const directories = [roots.workspace, roots.sdkRoot, roots.stateRoot];
    for (let i = 0; i < directories.length; ++i) for (let j = i + 1; j < directories.length; ++j) {
        if (contained(directories[i], directories[j]) || contained(directories[j], directories[i])) {
            throw new AppError('PERMISSION_DENIED', 'Workspace, SDK and state must be disjoint.');
        }
    }
    const ignoredConfigs = await checkOpenCodeConflicts(workspace, environment);
    let executable: string;
    try {
        executable = absolute(await fs.realpath(options.executable), '--executable');
        if (!(await fs.lstat(executable)).isFile()) throw new Error('Not a file.');
        if (windows) await verifyWindowsTrust(executable);
        await fs.access(executable, constants.X_OK);
    } catch { throw new AppError('INVALID_ARGUMENTS', 'Select an already installed, trusted executable by absolute path. Nothing will be downloaded.'); }
    const executableStamp = identity(await fs.lstat(executable));
    const helper = await mcpLauncher();
    const skillsRoot = absolute(path.resolve(fileURLToPath(new URL('../../skills/', import.meta.url))), 'Bundled skills');
    const appRoot = absolute(path.resolve(fileURLToPath(new URL('../', import.meta.url))), 'Bundled app');
    if ([skillsRoot, appRoot, executable, process.execPath].some(root => contained(workspace, root) || contained(root, workspace))) {
        throw new AppError('PERMISSION_DENIED', 'The workspace must not overlap the trusted app, skills or executables.');
    }
    const names = new Set<string>();
    await scanSkills(skillsRoot, true, names, { entries: 0 });
    if (names.size !== bundledSkillNames.length) throw new AppError('SDK_INCOMPLETE', 'The bundled skills directory is missing or incomplete.');
    const sdk = await loadSdk(roots.sdkRoot);
    const filePolicy = captureFilePolicy(workspace, roots.sdkRoot, skillsRoot, roots.mode);
    checkCancelled();
    await privateState(roots.stateRoot);
    const session = await fs.mkdtemp(path.join(roots.stateRoot, 'ai-opencode-'));
    if (windows) await enforceWindowsPrivate(session);
    const sessionStamp = identity(await fs.lstat(session)).split(':').slice(0, 2).join(':');
    const configDir = path.join(session, 'config/opencode');
    let closed = false;
    const cleanup = async (): Promise<void> => {
        if (closed) return;
        const stat = await fs.lstat(session);
        if (!stat.isDirectory() || `${stat.dev}:${stat.ino}` !== sessionStamp || !samePath(await fs.realpath(session), session)) {
            throw new AppError('INPUT_CHANGED', 'Owned AI session directory changed; refusing cleanup.');
        }
        if (await present(configDir)) {
            if (windows) {
                await enforceWindowsPrivate(configDir);
                for (const name of ['opencode.json', '.gitignore', 'tools', 'tools/cocos4.js']) {
                    const file = path.join(configDir, name);
                    if (await present(file)) await enforceWindowsPrivate(file);
                }
            }
            await fs.chmod(configDir, 0o700);
            if (await present(path.join(configDir, 'tools'))) await fs.chmod(path.join(configDir, 'tools'), 0o700);
        }
        await fs.rm(session, { recursive: true });
        closed = true;
    };
    try {
        for (const directory of ['config', 'config/opencode', 'home', 'data', 'state', 'cache', 'tmp', 'mcp-home']) {
            await fs.mkdir(path.join(session, directory), { mode: 0o700 });
            if (windows) await enforceWindowsPrivate(path.join(session, directory));
        }
        const config = makeOpenCodeConfig(roots, absolute(await fs.realpath(process.execPath), 'Node executable'),
            absolute(fileURLToPath(new URL('./cli.js', import.meta.url)), 'CLI entry'), skillsRoot, session, helper.filename);
        const configFile = path.join(configDir, 'opencode.json');
        await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
        await fs.writeFile(path.join(configDir, '.gitignore'), 'node_modules\n', { flag: 'wx', mode: 0o400 });
        const toolDir = path.join(configDir, 'tools');
        await fs.mkdir(toolDir, { mode: 0o700 });
        // Config.directories/ToolRegistry loads these even with OPENCODE_PURE.
        // No @opencode-ai/plugin import/install and no project-discovered code.
        await fs.writeFile(path.join(toolDir, 'cocos4.js'),
            `import { createFileTools } from ${JSON.stringify(new URL('./ai-files.js', import.meta.url).href)};\n`
            + `const tools = createFileTools(${JSON.stringify(filePolicy)});\n`
            + 'export const { read, write, edit, apply_patch } = tools;\n', { flag: 'wx', mode: 0o400 });
        if (!windows) await fs.chmod(toolDir, 0o500);
        // v1.18.21 Npm.install returns before reify when a config directory is
        // not writable. This also prevents auto-seeding/migrating config files.
        if (!windows) await fs.chmod(configDir, 0o500);
        if (windows) {
            for (const file of [configFile, path.join(configDir, '.gitignore'), path.join(toolDir, 'cocos4.js'), toolDir, configDir]) {
                await enforceWindowsReadOnly(file);
            }
        }
        const env = openCodeEnvironment(environment, session);
        const versionEnv = openCodeEnvironment({ HOME: path.join(session, 'home'), PATH: windows ? '' : '/usr/bin:/bin', LANG: 'C.UTF-8',
            ...(windows ? { SystemRoot: environmentValue(environment, 'SystemRoot'), WINDIR: environmentValue(environment, 'WINDIR') } : {}) }, session);
        checkCancelled();
        const version = await new Promise<string>((resolve, reject) => {
            const child = spawn(executable, ['--version'], { cwd: session, env: versionEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
            const abort = (): void => { child.kill('SIGKILL'); };
            signal?.addEventListener('abort', abort, { once: true });
            let stdout = '';
            let count = 0;
            const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
            child.stdout.on('data', (bytes: Buffer) => { count += bytes.length; if (count <= 4096) stdout += bytes.toString(); else child.kill('SIGKILL'); });
            child.stderr.on('data', (bytes: Buffer) => { count += bytes.length; if (count > 4096) child.kill('SIGKILL'); });
            child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort);
                reject(new AppError('PROCESS_FAILED', 'OpenCode version probe could not start.')); });
            child.once('close', (code, childSignal) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (signal?.aborted) reject(new AppError('CANCELLED', 'AI startup was cancelled.'));
                else if (code !== 0 || childSignal || count > 4096 || stdout.trim() !== opencodeSupport.version) {
                    reject(new AppError('SDK_INCOMPLETE', `Only reviewed OpenCode ${opencodeSupport.version} is supported. The bounded version probe failed or returned another version.`,
                        ['Select the supported, already installed client. Client/schema upgrades require maintainer review; no automatic installation is performed.']));
                } else resolve(stdout.trim());
            });
        });
        const verifyExecutable = async (): Promise<void> => {
            checkCancelled();
            await helper.verify();
            if (closed || identity(await fs.lstat(executable)) !== executableStamp) {
                throw new AppError('INPUT_CHANGED', 'The selected executable changed after version validation.');
            }
        };
        await verifyExecutable();
        return { executable, version, roots, sdkId: sdk.sdkId, skillsRoot, config, configFile, session, env,
            ignoredConfigs, verifyExecutable, cleanup };
    } catch (error) { await cleanup(); throw error; }
}

export async function launchAi(args: string[]): Promise<void> {
    const options = parseAiArgs(args);
    const controller = new AbortController();
    let prepared: Awaited<ReturnType<typeof prepareOpenCode>> | undefined;
    let child: ChildProcess | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let exitOnSignal: number | undefined;
    const stop = (signal: NodeJS.Signals): void => {
        exitOnSignal = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
        controller.abort();
        child?.kill(signal);
        if (child) killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 5000);
    };
    const interrupt = (): void => stop('SIGINT');
    const terminate = (): void => stop('SIGTERM');
    const hangup = (): void => stop('SIGHUP');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate); process.once('SIGHUP', hangup);
    try {
        prepared = await prepareOpenCode(options, process.env, controller.signal);
        process.stderr.write(`OpenCode ${prepared.version}; mode=${prepared.roots.mode}; preview=${prepared.roots.preview}. `
            + 'Private child config only. No existing config/plugins/stored credentials are imported; provider auth environment is preserved.\n');
        if (prepared.ignoredConfigs.length) process.stderr.write(`Not imported: ${prepared.ignoredConfigs.map(value => JSON.stringify(value)).join(', ')}\n`);
        await prepared.verifyExecutable();
        const launch = prepared;
        const status = await new Promise<number>((resolve, reject) => {
            // No prompt, resume flag, client arguments, PATH search or shell.
            child = spawn(launch.executable, [], { cwd: launch.roots.workspace, env: launch.env, shell: false, stdio: 'inherit' });
            child.once('error', () => reject(new AppError('PROCESS_FAILED', 'OpenCode could not start.')));
            child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143)));
        });
        process.exitCode = exitOnSignal ?? status;
    } catch (error) {
        if (exitOnSignal === undefined) throw error;
        process.exitCode = exitOnSignal;
    } finally {
        if (killTimer) clearTimeout(killTimer);
        process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); process.removeListener('SIGHUP', hangup);
        await prepared?.cleanup();
    }
}
