import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFileRace } from './fixtures/ai/file-race.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const build = path.resolve(process.env.AI_TEST_BUILD_ROOT ?? path.join(devkit, 'build'));
const { captureFilePolicy, createFileTools } = await import(pathToFileURL(path.join(build, 'src/ai-files.js')).href);
const windows = process.platform === 'win32';
const { enforceWindowsPrivate } = windows ? await import(pathToFileURL(path.join(build, 'src/windows-fs.js')).href) : {};
const execute = promisify(execFile);
const context = { ask: async () => {} };
const patch = (...files) => ({ patchText: `*** Begin Patch\n${files.join('\n')}\n*** End Patch` });
const update = (file, extra = '') => `*** Update File: ${file}\n${extra}@@\n-before\n+after`;
const refused = operation => assert.rejects(operation, /AI_FILES_(?:DENIED|INVALID|CHANGED|BUSY)/);

async function fixture(t, mode = 'develop') {
    const root = await fs.mkdtemp(windows ? path.join(await fs.realpath(tmpdir()), 'cocos4-ai-files-') : '/tmp/opencode/cocos4-ai-files-');
    if (windows) await enforceWindowsPrivate(root);
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace with spaces \u6e38\u620f');
    const sdk = path.join(root, 'sdk'), skills = path.join(root, 'skills'), outside = path.join(root, 'private');
    for (const directory of [workspace, sdk, skills, outside, path.join(workspace, 'src')]) {
        await fs.mkdir(directory, { mode: 0o700 });
        if (windows) await enforceWindowsPrivate(directory);
    }
    for (const filename of [path.join(workspace, 'src/first.ts'), path.join(workspace, 'src/second.ts')]) {
        await fs.writeFile(filename, 'before\n', { mode: 0o600 });
    }
    await fs.writeFile(path.join(workspace, '.env'), 'DUMMY_SECRET\n', { mode: 0o600 });
    await fs.writeFile(path.join(outside, 'second.ts'), 'DUMMY_PRIVATE_STATE\n', { mode: 0o600 });
    await fs.writeFile(path.join(sdk, 'manifest.json'), '{"fixture":true}\n', { mode: 0o600 });
    await fs.writeFile(path.join(skills, 'SKILL.md'), 'trusted skill\n', { mode: 0o600 });
    const policy = captureFilePolicy(workspace, sdk, skills, mode);
    return { root, workspace, sdk, skills, outside, policy, tools: createFileTools(policy),
        async pristine() {
            assert.equal(await fs.readFile(path.join(workspace, 'src/first.ts'), 'utf8'), 'before\n');
            assert.equal(await fs.readFile(path.join(workspace, 'src/second.ts'), 'utf8'), 'before\n');
            assert.deepEqual((await fs.readdir(path.join(workspace, 'src'))).sort(), ['first.ts', 'second.ts']);
            assert.equal((await fs.readdir(workspace)).some(name => name.startsWith('.cocos4-ai-')), false);
        } };
}

test('safe client tools read/list, create, edit and multi-file Add/Update/Move/Delete real files', async t => {
    const f = await fixture(t);
    const invoke = (tool, args) => f.tools[tool].execute(args, context);
    assert.match(await invoke('read', { filePath: 'src/first.ts' }), /1: before/);
    const listing = await invoke('read', { filePath: f.workspace });
    assert.match(listing, /src\//);
    assert.doesNotMatch(listing, /\.env/);
    assert.match(await invoke('read', { filePath: path.join(f.sdk, 'manifest.json') }), /fixture/);
    assert.match(await invoke('read', { filePath: path.join(f.skills, 'SKILL.md') }), /trusted skill/);
    await invoke('write', { filePath: 'src/new.ts', content: 'one\none\n' });
    await refused(invoke('edit', { filePath: 'src/new.ts', oldString: 'one', newString: 'two' }));
    await invoke('edit', { filePath: 'src/new.ts', oldString: 'one', newString: 'two', replaceAll: true });
    assert.equal(await fs.readFile(path.join(f.workspace, 'src/new.ts'), 'utf8'), 'two\ntwo\n');
    let asked;
    await f.tools.apply_patch.execute(patch(update('src/first.ts'), update('src/second.ts', '*** Move to: src/moved.ts\n'),
        '*** Add File: src/added.ts\n+added', '*** Delete File: src/new.ts'), { ask: async req => { asked = req; } });
    assert.equal(asked.permission, 'cocos4_apply_patch');
    assert.deepEqual(asked.patterns, ['first.ts', 'second.ts', 'moved.ts', 'added.ts', 'new.ts'].map(name => path.join(f.workspace, 'src', name)));
    assert.equal(await fs.readFile(path.join(f.workspace, 'src/first.ts'), 'utf8'), 'after\n');
    assert.equal(await fs.readFile(path.join(f.workspace, 'src/moved.ts'), 'utf8'), 'after\n');
    assert.equal(await fs.readFile(path.join(f.workspace, 'src/added.ts'), 'utf8'), 'added\n');
    assert.deepEqual((await fs.readdir(path.join(f.workspace, 'src'))).sort(), ['added.ts', 'first.ts', 'moved.ts']);
    assert.equal((await fs.lstat(path.join(f.workspace, 'src/first.ts'))).nlink, 1);
    await fs.writeFile(path.join(f.workspace, 'src/crlf.ts'), '\uFEFFbefore\r\n');
    await invoke('apply_patch', patch(update('src/crlf.ts')));
    assert.equal(await fs.readFile(path.join(f.workspace, 'src/crlf.ts'), 'utf8'), '\uFEFFafter\r\n');
});

test('read-only policy rejects every mutation even when the client permission callback allows it', async t => {
    const f = await fixture(t, 'read-only');
    for (const [tool, args] of [['write', { filePath: 'src/first.ts', content: 'after\n' }],
        ['edit', { filePath: 'src/first.ts', oldString: 'before', newString: 'after' }],
        ['apply_patch', patch(update('src/first.ts'))]]) await refused(f.tools[tool].execute(args, context));
    assert.match(await f.tools.read.execute({ filePath: 'src/first.ts' }, context), /before/);
    await f.pristine();
});

test('late symlinks, directory links and hardlink aliases cannot be read or mutated', async t => {
    const f = await fixture(t);
    await fs.symlink('.env', path.join(f.workspace, 'public.txt'));
    await fs.link(path.join(f.workspace, '.env'), path.join(f.workspace, 'hardlink.txt'));
    await fs.symlink(f.outside, path.join(f.workspace, 'linked'), windows ? 'junction' : 'dir');
    await fs.symlink(windows ? path.join(f.workspace, 'src') : 'src', path.join(f.workspace, 'internal-link'), windows ? 'junction' : 'dir');
    for (const file of ['public.txt', 'hardlink.txt', 'linked/second.ts', 'internal-link/first.ts']) {
        for (const [tool, args] of [['read', { filePath: file }], ['write', { filePath: file, content: 'ATTACK\n' }],
            ['edit', { filePath: file, oldString: 'before', newString: 'ATTACK' }],
            ['apply_patch', patch(update('src/first.ts'), update(file))],
            ['apply_patch', patch(update('src/first.ts'), `*** Delete File: ${file}`)],
            ['apply_patch', patch(update('src/first.ts'), update('src/second.ts', `*** Move to: ${file}\n`))]]) {
            await refused(f.tools[tool].execute(args, context));
            await f.pristine();
        }
    }
    assert.equal(await fs.readFile(path.join(f.workspace, '.env'), 'utf8'), 'DUMMY_SECRET\n');
    assert.equal(await fs.readFile(path.join(f.outside, 'second.ts'), 'utf8'), 'DUMMY_PRIVATE_STATE\n');
});

test('all Move destinations, Add/Delete/Update paths and client/SDK/skill roots are authorized before multi-file effects', async t => {
    const f = await fixture(t);
    for (const target of ['.env', '.env.test', '.envrc', '.git/config', 'opencode.json', 'opencode.jsonc', '.opencode/plugins/evil.js',
        '.claude/settings.json', '.agents/skills/SKILL.md', '.config/opencode/auth.json', '.local/share/opencode/auth.json',
        '.npmrc', 'credentials.json', 'secrets.json', 'key.pem', 'id_ed25519', '../private/second.ts',
        path.join(f.outside, 'second.ts'), path.join(f.sdk, 'manifest.json'), path.join(f.skills, 'SKILL.md')]) {
        for (const body of [update('src/second.ts', `*** Move to: ${target}\n`), update(target),
            `*** Add File: ${target}\n+ATTACK`, `*** Delete File: ${target}`]) {
            await refused(f.tools.apply_patch.execute(patch(update('src/first.ts'), body), context));
            await f.pristine();
        }
    }
    assert.equal(await fs.readFile(path.join(f.sdk, 'manifest.json'), 'utf8'), '{"fixture":true}\n');
    assert.equal(await fs.readFile(path.join(f.skills, 'SKILL.md'), 'utf8'), 'trusted skill\n');
});

test('invalid later hunks, overlapping endpoints and occupied Add/Move destinations leave no partial edits', async t => {
    const f = await fixture(t);
    for (const args of [patch(update('src/first.ts'), '*** Update File: src/second.ts\n@@\n-missing\n+after'),
        patch(update('src/first.ts'), update('src/./first.ts')),
        patch(update('src/first.ts'), update('src/second.ts', '*** Move to: src/first.ts\n')),
        patch(update('src/first.ts'), '*** Add File: src/second.ts\n+replace'),
        patch(update('src/first.ts'), '*** Add File: missing/dir/file.ts\n+new'),
        patch(update('src/first.ts'), update('src/second.ts', '*** Move to: \n')),
        { patchText: '*** Begin Patch\n*** End Patch' }]) {
        await refused(f.tools.apply_patch.execute(args, context));
        await f.pristine();
    }
});

test('strict arguments, cancellation, permission failures, binary and oversized inputs do not cause writes', async t => {
    const f = await fixture(t);
    for (const args of [{ filePath: 'src/first.ts', offset: 0 }, { filePath: 'src/first.ts', limit: 2001 },
        { filePath: 'src/first.ts', unknown: true }, { filePath: 'src/first.ts', offset: '1' },
        { filePath: 'src/../.env' }, { filePath: 'src\\first.ts' }, { filePath: '.env\0' }]) {
        await refused(f.tools.read.execute(args, context));
    }
    await refused(f.tools.write.execute({ filePath: 'src/first.ts', content: 'x'.repeat(1024 * 1024 + 1) }, context));
    await fs.writeFile(path.join(f.workspace, 'src/binary.ts'), Buffer.from([0, 255]));
    await refused(f.tools.read.execute({ filePath: 'src/binary.ts' }, context));
    await fs.unlink(path.join(f.workspace, 'src/binary.ts'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.tools.write.execute({ filePath: 'src/first.ts', content: 'after' },
        { ...context, abort: controller.signal }), /AI_FILES_CANCELLED/);
    await assert.rejects(f.tools.write.execute({ filePath: 'src/first.ts', content: 'after' },
        { ask: async () => { throw new Error('permission denied'); } }), /permission denied/);
    await f.pristine();
});

test('root replacement, untrusted directories and recovery locks fail closed without following links', async t => {
    const f = await fixture(t);
    const saved = `${f.workspace}-saved`;
    await fs.rename(f.workspace, saved);
    await fs.mkdir(f.workspace, { mode: 0o700 });
    await refused(f.tools.read.execute({ filePath: f.workspace }, context));
    await fs.rmdir(f.workspace); await fs.rename(saved, f.workspace);
    if (windows) await execute(path.join(process.env.SystemRoot, 'System32/icacls.exe'),
        [path.join(f.workspace, 'src'), '/grant', '*S-1-1-0:(M)'], { windowsHide: true });
    else await fs.chmod(path.join(f.workspace, 'src'), 0o777);
    await refused(f.tools.read.execute({ filePath: 'src/first.ts' }, context));
    if (windows) await enforceWindowsPrivate(path.join(f.workspace, 'src'));
    else await fs.chmod(path.join(f.workspace, 'src'), 0o700);
    const lock = path.join(f.workspace, '.cocos4-ai-file-lock');
    await fs.symlink(path.join(f.workspace, '.env'), lock);
    await refused(f.tools.read.execute({ filePath: 'src/first.ts' }, context));
    await refused(f.tools.write.execute({ filePath: 'src/first.ts', content: 'after' }, context));
    await fs.unlink(lock);
    await f.pristine();
});

test('read races at final open and after reading suppress results, including ancestor swaps and new hardlinks', async t => {
    for (const scenario of ['symlink', 'hardlink', 'parent-open', 'parent-read', 'extra-link']) await t.test(scenario, async t => {
        const f = await fixture(t);
        const target = path.join(f.workspace, 'src/second.ts'), parent = path.dirname(target), saved = path.join(f.workspace, 'saved');
        const action = scenario.startsWith('parent-') ? 'parent' : scenario;
        const method = scenario === 'parent-read' || scenario === 'extra-link' ? 'readSync' : 'openSync';
        const race = installFileRace({ method, action, target, parent, saved,
            match: scenario === 'parent-open' ? parent : target, after: scenario === 'extra-link',
            outside: action === 'parent' ? f.outside : path.join(f.workspace, '.env'), alias: path.join(f.outside, 'alias.ts') });
        try { await refused(f.tools.read.execute({ filePath: target }, context)); assert.equal(race.fired, true); }
        finally { race.restore(); }
        assert.equal(await fs.readFile(path.join(f.workspace, '.env'), 'utf8'), 'DUMMY_SECRET\n');
        assert.equal(await fs.readFile(path.join(f.outside, 'second.ts'), 'utf8'), 'DUMMY_PRIVATE_STATE\n');
    });
});

test('write publication races never write through aliases and roll back the first file of a multi-file patch', async t => {
    for (const scenario of ['symlink', 'hardlink', 'parent', 'error']) await t.test(scenario, async t => {
        const f = await fixture(t);
        const target = path.join(f.workspace, 'src/second.ts'), parent = path.dirname(target), saved = path.join(f.workspace, 'saved');
        const race = installFileRace({ method: ['parent', 'error'].includes(scenario) ? 'linkSync' : 'renameSync', action: scenario,
            match: target, target, parent, saved, outside: scenario === 'parent' ? f.outside : path.join(f.workspace, '.env') });
        try {
            await refused(f.tools.apply_patch.execute(patch(update('src/first.ts'), update('src/second.ts')), context));
            assert.equal(race.fired, true);
        } finally { race.restore(); }
        const src = scenario === 'parent' && !race.blocked ? saved : parent;
        if (windows && scenario === 'parent') assert.equal(race.blocked, true, 'The native parent lease must block replacement');
        if (race.originalFile) assert.equal(await fs.readFile(race.originalFile, 'utf8'), 'before\n', 'The actor-withdrawn original input must never be written');
        assert.equal(await fs.readFile(path.join(src, 'first.ts'), 'utf8'), 'before\n');
        assert.equal(await fs.readFile(path.join(f.workspace, '.env'), 'utf8'), 'DUMMY_SECRET\n');
        assert.equal(await fs.readFile(path.join(f.outside, 'second.ts'), 'utf8'), 'DUMMY_PRIVATE_STATE\n');
        assert.deepEqual((await fs.readdir(src)).sort(), ['first.ts', 'second.ts']);
        assert.equal((await fs.readdir(f.workspace)).some(name => name.startsWith('.cocos4-ai-')), false);
    });
});

test('new Move destination appearing at link publication is never overwritten; earlier files roll back', async t => {
    for (const action of ['symlink', 'hardlink']) await t.test(action, async t => {
        const f = await fixture(t);
        const target = path.join(f.workspace, 'src/new.ts');
        const race = installFileRace({ method: 'linkSync', action, match: target, target, remove: false, outside: path.join(f.workspace, '.env') });
        try {
            await refused(f.tools.apply_patch.execute(patch(update('src/first.ts'), update('src/second.ts', '*** Move to: src/new.ts\n')), context));
            assert.equal(race.fired, true);
        } finally { race.restore(); }
        assert.equal(await fs.readFile(path.join(f.workspace, 'src/first.ts'), 'utf8'), 'before\n');
        assert.equal(await fs.readFile(path.join(f.workspace, 'src/second.ts'), 'utf8'), 'before\n');
        assert.equal(await fs.readFile(path.join(f.workspace, '.env'), 'utf8'), 'DUMMY_SECRET\n');
        await fs.unlink(target);
        await f.pristine();
    });
});
