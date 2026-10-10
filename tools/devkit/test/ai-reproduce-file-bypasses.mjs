// Explicit regression research against a retained PRE-FIX application snapshot.
// Only disposable fixture files are read/changed; no model request is made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const devkit = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.platform, 'linux', 'The retained pre-fix application snapshot and its bypass evidence are Linux-specific.');
const build = process.argv[2];
assert.ok(build && path.isAbsolute(build));
const evidence = await fs.mkdtemp(path.join(devkit, 'build/ai-bypass-before-'));
const root = await fs.mkdtemp(path.join(tmpdir(), 'cocos4-ai-before-'));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
await fs.mkdir(workspace); await fs.mkdir(home);
const { prepareOpenCode } = await import(pathToFileURL(path.join(build, 'src/ai.js')).href);
let prepared;
try {
    prepared = await prepareOpenCode({ client: 'opencode', executable: '/usr/bin/opencode', workspace,
        sdkRoot: path.join(devkit, 'build/game-sdk-isolated'), stateRoot: path.join(root, 'state'), mode: 'develop', preview: false },
    { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1' });
    const marker = 'DUMMY_AI_PERMISSION_SENTINEL';
    await fs.writeFile(path.join(workspace, '.env'), marker);
    await fs.symlink('.env', path.join(workspace, 'public.txt'));
    await fs.link(path.join(workspace, '.env'), path.join(workspace, 'hardlink.txt'));
    await fs.writeFile(path.join(root, 'outside.txt'), marker);
    await fs.symlink(root, path.join(workspace, 'parent-link'));
    const results = [];
    async function capture(name, tool, params) {
        await prepared.verifyExecutable();
        const args = ['debug', 'agent', 'cocos4', '--tool', tool, '--params', JSON.stringify(params)];
        const result = await new Promise((resolve, reject) => {
            // Select the GPT tool registry branch only; no inference/provider call.
            const child = spawn(prepared.executable, args, { cwd: workspace, shell: false,
                env: { ...prepared.env, OPENCODE_CONFIG_CONTENT: '{"model":"opencode/gpt-5"}' }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
            child.stdout.on('data', data => { stdout += data; });
            child.stderr.on('data', data => { stderr += data; });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', (code, signal) => { clearTimeout(timer); resolve({ name, args, code, signal, stdout, stderr }); });
        });
        await fs.writeFile(path.join(evidence, `${name}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
        results.push({ name, code: result.code, exposedDummy: result.stdout.includes(marker) });
        assert.equal(result.code, 0, result.stderr);
        return result;
    }
    for (const file of ['public.txt', 'hardlink.txt', 'parent-link/outside.txt']) {
        assert.ok((await capture(file.replaceAll('/', '-'), 'read', { filePath: path.join(workspace, file) })).stdout.includes(marker));
    }
    await fs.writeFile(path.join(workspace, 'patch-probe.txt'), 'before\n');
    await capture('forbidden-move', 'apply_patch', { patchText: '*** Begin Patch\n*** Update File: patch-probe.txt\n'
        + '*** Move to: .env\n@@\n-before\n+after\n*** End Patch' });
    assert.equal(await fs.readFile(path.join(workspace, '.env'), 'utf8'), 'after\n');
    await fs.writeFile(path.join(evidence, 'summary.json'), JSON.stringify({ build, version: prepared.version,
        results, forbiddenMoveSucceeded: true, modelRequests: 0, fixtureOnly: true }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ evidence, reproduced: results.map(item => item.name), modelRequests: 0 }, null, 2));
} finally { await prepared?.cleanup(); await fs.rm(root, { recursive: true, force: true }); }
