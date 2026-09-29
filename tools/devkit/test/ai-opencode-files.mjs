// Real OpenCode 1.18.21 tool execution, not a glob/permission matcher simulation.
// Only disposable fixtures and a private SDK copy are attack targets. No LLM call.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const flags = new Map();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--executable', '--build-root', '--sdk-root', '--evidence-root'].includes(args[i])
        && args[i + 1] && path.isAbsolute(args[i + 1]) && !flags.has(args[i]));
    flags.set(args[i], args[i + 1]);
}
assert.equal(flags.size, 4);
const evidence = flags.get('--evidence-root');
const { prepareOpenCode } = await import(pathToFileURL(path.join(flags.get('--build-root'), 'src/ai.js')).href);
const root = await fs.mkdtemp('/tmp/opencode/cocos4-ai-file-tools-');
const workspace = path.join(root, 'workspace with spaces \u6e38\u620f');
const home = path.join(root, 'home');
const sdk = path.join(root, 'sdk-copy');
const outside = path.join(root, 'private');
const state = path.join(root, 'state');
const patch = (...files) => ({ patchText: `*** Begin Patch\n${files.join('\n')}\n*** End Patch` });
const update = (file, extra = '') => `*** Update File: ${file}\n${extra}@@\n-before\n+after`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const reports = [];
let readOnly, develop;
let completed = false;

async function fingerprint(filename) {
    const stat = await fs.lstat(filename, { bigint: true });
    return { ino: String(stat.ino), nlink: String(stat.nlink), mtime: String(stat.mtimeNs), mode: String(stat.mode),
        sha256: sha256(await fs.readFile(filename)) };
}
async function capture(name, prepared, tool, params, code = 0) {
    await prepared.verifyExecutable();
    const argv = ['debug', 'agent', 'cocos4', '--tool', tool, '--params', JSON.stringify(params)];
    // Select both registry branches without inference. Debug uses only model IDs.
    const model = tool === 'apply_patch' ? 'opencode/gpt-5' : 'opencode/big-pickle';
    const result = await new Promise((resolve, reject) => {
        const child = spawn(prepared.executable, argv, { cwd: workspace, shell: false,
            env: { ...prepared.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ model }) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', bytes = 0;
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.stdout.on('data', data => { bytes += data.length; if (bytes <= 1024 * 1024) stdout += data; else child.kill('SIGKILL'); });
        child.stderr.on('data', data => { bytes += data.length; if (bytes <= 1024 * 1024) stderr += data; else child.kill('SIGKILL'); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    await fs.writeFile(path.join(evidence, `file-tool-${name}.json`), `${JSON.stringify({ executable: prepared.executable,
        args: argv, registryModelOnly: model, expectedCode: code, ...result }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    reports.push({ name, tool, code: result.code, expectedCode: code, signal: result.signal });
    assert.equal(result.code, code, `${name}: ${result.stderr || result.stdout}`);
    assert.equal(result.signal, null, name);
    if (code === 1) {
        assert.match(result.stderr, tool.startsWith('cocos4_') && prepared.roots.mode === 'develop'
            ? /AI_FILES_(?:DENIED|INVALID|CHANGED|BUSY)/ : /disabled for agent cocos4/, name);
        assert.equal(`${result.stdout}${result.stderr}`.includes('DUMMY_AI_PRIVATE_SENTINEL'), false, name);
    }
    return result;
}

async function pristine() {
    assert.equal(await fs.readFile(path.join(workspace, 'src/first.ts'), 'utf8'), 'before\n');
    assert.equal(await fs.readFile(path.join(workspace, 'src/second.ts'), 'utf8'), 'before\n');
    assert.equal((await fs.readdir(workspace)).some(name => name.startsWith('.cocos4-ai-')), false);
    assert.equal((await fs.readdir(path.join(workspace, 'src'))).some(name => name.startsWith('.cocos4-ai-')), false);
}

try {
    for (const directory of [workspace, home, outside, path.join(workspace, 'src')]) await fs.mkdir(directory, { mode: 0o700 });
    // Reflink when available, never hardlink: a regression must not damage the
    // parent's retained SDK or share writable input inodes with it.
    await fs.cp(flags.get('--sdk-root'), sdk, { recursive: true, force: false, errorOnExist: true, mode: fs.constants.COPYFILE_FICLONE });
    await fs.chmod(sdk, 0o500);
    const options = { client: 'opencode', executable: flags.get('--executable'), workspace,
        sdkRoot: sdk, stateRoot: state, mode: 'read-only', preview: false };
    const env = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1' };
    readOnly = await prepareOpenCode(options, env);
    develop = await prepareOpenCode({ ...options, mode: 'develop' }, env);
    for (const prepared of [readOnly, develop]) assert.deepEqual(prepared.config.mcp.cocos4.command.slice(0, 4),
        [path.join(flags.get('--build-root'), 'host/cocos4-mcp-launch'), 'cocos4-mcp-launch-v1', '--node', await fs.realpath(process.execPath)]);
    for (const name of ['first.ts', 'second.ts']) await fs.writeFile(path.join(workspace, 'src', name), 'before\n');
    const publicFile = path.join(workspace, 'src/first.ts');
    const secretFile = path.join(workspace, '.env');
    await fs.writeFile(secretFile, 'DUMMY_AI_PRIVATE_SENTINEL_ENV\n');
    await fs.writeFile(path.join(outside, 'second.ts'), 'DUMMY_AI_PRIVATE_SENTINEL_OUTSIDE\n');
    await fs.writeFile(path.join(state, 'private.txt'), 'DUMMY_AI_PRIVATE_SENTINEL_STATE\n', { mode: 0o600 });
    await fs.symlink('.env', path.join(workspace, 'public.txt'));
    await fs.link(secretFile, path.join(workspace, 'hardlink.txt'));
    await fs.symlink(outside, path.join(workspace, 'linked-directory'));
    await fs.symlink(state, path.join(workspace, 'linked-state'));
    await fs.symlink('src', path.join(workspace, 'internal-link'));
    // Added AFTER startup: no startup scan may be the security boundary.
    await fs.mkdir(path.join(workspace, '.opencode/plugins'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.opencode/skills/injected'), { recursive: true });
    for (const name of ['opencode.json', 'opencode.jsonc']) await fs.writeFile(path.join(workspace, name), '{"plugin":[]}\n');
    const pluginMarker = path.join(root, 'untrusted-plugin-executed');
    await fs.writeFile(path.join(workspace, '.opencode/plugins/evil.js'),
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pluginMarker)}, 'bad'); export default async () => ({});\n`);
    await fs.writeFile(path.join(workspace, '.opencode/skills/injected/SKILL.md'), 'untrusted skill fixture\n');

    for (const [tool, params] of [['read', { filePath: publicFile }], ['write', { filePath: publicFile, content: 'after\n' }],
        ['edit', { filePath: publicFile, oldString: 'before', newString: 'after' }], ['apply_patch', patch(update('src/first.ts'))]]) {
        await capture(`builtin-${tool}-normal`, develop, tool, params, 1);
        await pristine();
    }
    const read = await capture('normal-read', develop, 'cocos4_read', { filePath: publicFile });
    assert.match(JSON.parse(read.stdout).result.output, /1: before/);
    const list = await capture('normal-list', develop, 'cocos4_read', { filePath: workspace });
    assert.match(JSON.parse(list.stdout).result.output, /src\//);
    assert.doesNotMatch(JSON.parse(list.stdout).result.output, /\.env|\.opencode|public\.txt|hardlink\.txt|linked-directory/);
    await capture('normal-sdk-read', develop, 'cocos4_read', { filePath: path.join(sdk, 'manifest.json'), limit: 5 });
    await capture('normal-skill-read', develop, 'cocos4_read', { filePath: path.join(develop.skillsRoot, 'cocos4-devkit/SKILL.md'), limit: 5 });
    await capture('normal-create', develop, 'cocos4_write', { filePath: 'src/new.ts', content: 'initial\n' });
    await capture('normal-overwrite', develop, 'cocos4_write', { filePath: 'src/new.ts', content: 'value\n' });
    await capture('normal-edit', develop, 'cocos4_edit', { filePath: 'src/new.ts', oldString: 'value', newString: 'edited', replaceAll: false });
    assert.equal(await fs.readFile(path.join(workspace, 'src/new.ts'), 'utf8'), 'edited\n');
    await capture('normal-multi-file-patch', develop, 'cocos4_apply_patch', patch(update('src/first.ts'),
        update('src/second.ts', '*** Move to: src/moved.ts\n'), '*** Add File: src/added.ts\n+added', '*** Delete File: src/new.ts'));
    assert.equal(await fs.readFile(publicFile, 'utf8'), 'after\n');
    assert.equal(await fs.readFile(path.join(workspace, 'src/moved.ts'), 'utf8'), 'after\n');
    assert.equal(await fs.readFile(path.join(workspace, 'src/added.ts'), 'utf8'), 'added\n');
    assert.deepEqual((await fs.readdir(path.join(workspace, 'src'))).sort(), ['added.ts', 'first.ts', 'moved.ts']);
    await fs.unlink(path.join(workspace, 'src/moved.ts')); await fs.unlink(path.join(workspace, 'src/added.ts'));
    for (const name of ['first.ts', 'second.ts']) await fs.writeFile(path.join(workspace, 'src', name), 'before\n');

    await capture('readonly-read', readOnly, 'cocos4_read', { filePath: publicFile });
    for (const [tool, params] of [['write', { filePath: publicFile, content: 'after\n' }],
        ['edit', { filePath: publicFile, oldString: 'before', newString: 'after' }], ['apply_patch', patch(update('src/first.ts'))]]) {
        await capture(`readonly-builtin-${tool}`, readOnly, tool, params, 1);
        await capture(`readonly-safe-${tool}`, readOnly, `cocos4_${tool}`, params, 1);
        await pristine();
    }

    const protectedFiles = [secretFile, path.join(outside, 'second.ts'), path.join(state, 'private.txt'), path.join(sdk, 'manifest.json'),
        path.join(develop.skillsRoot, 'cocos4-devkit/SKILL.md'), develop.configFile, readOnly.configFile,
        path.join(workspace, 'opencode.json'), path.join(workspace, 'opencode.jsonc'),
        path.join(workspace, '.opencode/plugins/evil.js'), path.join(workspace, '.opencode/skills/injected/SKILL.md')];
    const before = await Promise.all(protectedFiles.map(fingerprint));
    for (const name of ['public.txt', 'hardlink.txt', 'linked-directory/second.ts', 'linked-state/private.txt', 'internal-link/first.ts']) {
        const slug = name.replaceAll('/', '-');
        for (const [tool, params] of [['read', { filePath: name }], ['write', { filePath: name, content: 'ATTACK\n' }],
            ['apply_patch', patch(update('src/first.ts'), update(name))]]) {
            await capture(`builtin-${tool}-${slug}`, develop, tool, params, 1);
            await capture(`safe-${tool}-${slug}`, develop, `cocos4_${tool}`, params, 1);
            await pristine();
        }
        await capture(`safe-move-${slug}`, develop, 'cocos4_apply_patch',
            patch(update('src/first.ts'), update('src/second.ts', `*** Move to: ${name}\n`)), 1);
        await pristine();
    }
    const targets = ['.env', 'opencode.json', 'opencode.jsonc', '.opencode/plugins/evil.js', '.opencode/skills/injected/SKILL.md',
        path.join(sdk, 'manifest.json'), path.join(develop.skillsRoot, 'cocos4-devkit/SKILL.md'), develop.configFile,
        path.join(state, 'private.txt'), path.join(outside, 'second.ts')];
    for (const [index, target] of targets.entries()) {
        const params = patch(update('src/first.ts'), update('src/second.ts', `*** Move to: ${target}\n`));
        await capture(`builtin-forbidden-move-${index}`, develop, 'apply_patch', params, 1);
        await capture(`safe-forbidden-move-${index}`, develop, 'cocos4_apply_patch', params, 1);
        await pristine();
    }
    for (const [index, body] of ['*** Add File: .env\n+ATTACK', '*** Delete File: .env',
        '*** Update File: src/second.ts\n@@\n-missing\n+after', '*** Add File: src/second.ts\n+overwrite',
        update('src/second.ts', '*** Move to: src/first.ts\n'), '*** Add File: missing/directory/new.ts\n+new'].entries()) {
        await capture(`safe-invalid-batch-${index}`, develop, 'cocos4_apply_patch', patch(update('src/first.ts'), body), 1);
        await pristine();
    }
    const after = await Promise.all(protectedFiles.map(fingerprint));
    assert.deepEqual(after, before, 'Forbidden endpoint content, inode, mode, link count or mtime changed.');

    // Deterministic races immediately after a guard / immediately before a real
    // syscall, inside the actual client's custom tool executor. Production code
    // has no test hooks; only this disposable trusted wrapper is instrumented.
    const toolFile = path.join(path.dirname(develop.configFile), 'tools/cocos4.js');
    const wrapper = await fs.readFile(toolFile, 'utf8');
    const raceModule = new URL('./fixtures/ai/file-race.mjs', import.meta.url).href;
    const races = ['read-symlink', 'read-hardlink', 'read-parent-open', 'read-parent-after-open', 'read-extra-link',
        'write-symlink', 'write-hardlink', 'patch-symlink', 'patch-hardlink', 'patch-parent', 'patch-io-error',
        'move-symlink', 'move-hardlink'];
    for (const name of races) {
        const directory = path.join(workspace, `race-${name}`);
        await fs.mkdir(directory, { mode: 0o700 });
        for (const entry of ['first.ts', 'second.ts']) await fs.writeFile(path.join(directory, entry), 'before\n');
        const move = name.startsWith('move-'), reading = name.startsWith('read-');
        const target = path.join(directory, move ? 'new.ts' : 'second.ts');
        const saved = path.join(workspace, `saved-${name}`);
        const marker = path.join(root, `injected-${name}`);
        const parentRace = name.includes('parent');
        const action = parentRace ? 'parent' : name.includes('extra-link') ? 'extra-link'
            : name.includes('error') ? 'error' : name.includes('hardlink') ? 'hardlink' : 'symlink';
        const method = reading ? (name.endsWith('after-open') || action === 'extra-link' ? 'readSync' : 'openSync')
            : parentRace || action === 'error' || move ? 'linkSync' : 'renameSync';
        const spec = { method, action, match: name.endsWith('parent-open') ? directory : target, target, parent: directory, saved,
            outside: parentRace ? outside : secretFile, marker, alias: path.join(outside, `${name}.txt`),
            remove: !move, after: action === 'extra-link' };
        await fs.chmod(toolFile, 0o600);
        await fs.writeFile(toolFile, `import { installFileRace } from ${JSON.stringify(raceModule)};\ninstallFileRace(${JSON.stringify(spec)});\n${wrapper}`);
        await fs.chmod(toolFile, 0o400);
        try {
            const tool = reading ? 'cocos4_read' : name.startsWith('write-') ? 'cocos4_write' : 'cocos4_apply_patch';
            const params = reading ? { filePath: target } : name.startsWith('write-') ? { filePath: target, content: 'after\n' }
                : patch(update(path.join(directory, 'first.ts')), update(path.join(directory, 'second.ts'), move ? `*** Move to: ${target}\n` : ''));
            await capture(`race-${name}`, develop, tool, params, 1);
            assert.equal(await fs.readFile(marker, 'utf8'), 'syscall-boundary-injection\n', name);
            const actualDirectory = parentRace ? saved : directory;
            assert.equal(await fs.readFile(path.join(actualDirectory, 'first.ts'), 'utf8'), 'before\n', `${name}: partial first-file write`);
            assert.equal(await fs.readFile(secretFile, 'utf8'), 'DUMMY_AI_PRIVATE_SENTINEL_ENV\n', name);
            assert.equal(await fs.readFile(path.join(outside, 'second.ts'), 'utf8'), 'DUMMY_AI_PRIVATE_SENTINEL_OUTSIDE\n', name);
            assert.equal((await fs.readdir(actualDirectory)).some(entry => entry.startsWith('.cocos4-ai-')), false, name);
            await pristine();
        } finally {
            await fs.chmod(toolFile, 0o600); await fs.writeFile(toolFile, wrapper); await fs.chmod(toolFile, 0o400);
        }
    }
    await assert.rejects(fs.lstat(pluginMarker), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(home), []);
    for (const prepared of [develop, readOnly]) {
        assert.deepEqual((await fs.readdir(path.dirname(prepared.configFile))).sort(), ['.gitignore', 'opencode.json', 'tools']);
    }
    // Race fixtures deliberately change link counts, but never protected bytes.
    const final = await Promise.all(protectedFiles.map(fingerprint));
    assert.deepEqual(final.map(item => item.sha256), before.map(item => item.sha256));
    await fs.writeFile(path.join(evidence, 'file-tool-protected.json'), `${JSON.stringify({ paths: protectedFiles, before, after, final }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
    completed = true;
} finally {
    await develop?.cleanup(); await readOnly?.cleanup();
    await fs.writeFile(path.join(evidence, 'file-tools-evidence.json'), `${JSON.stringify({ version: develop?.version,
        executable: develop?.executable, node: process.version, mcpCommand: develop?.config.mcp.cocos4.command,
        completed, checks: reports, modelRequests: 0,
        originalSdkWasAttackTarget: false, raceMethod: 'test-only syscall-boundary instrumentation in real debug-agent execution',
        limitations: ['Non-root Linux only.', 'No OS isolation from hostile same-UID processes, mounts or client/kit tampering.',
            'Multi-file publication is not crash-atomic; conflicts preserve a recovery lock rather than overwrite concurrent data.'] }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
    // Only the newly copied fixture SDK is chmodded, never the retained SDK.
    async function writableDirs(directory) {
        await fs.chmod(directory, 0o700);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writableDirs(path.join(directory, entry.name));
    }
    await writableDirs(root);
    await fs.rm(root, { recursive: true });
}
console.log(JSON.stringify({ realClient: develop.version, checks: reports.length, completed, modelRequests: 0, evidence }, null, 2));
