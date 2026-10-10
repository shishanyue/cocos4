// Each invocation owns its build/evidence tree; never rewrites shared build/src.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--opencode' && path.isAbsolute(args[1])));
const root = await fs.mkdtemp(path.join(tmpdir(), 'cocos4-ai-focused-'));
const windows = process.platform === 'win32';
const packaged = Number(process.versions.node.split('.')[0]) >= 24;
const build = path.join(root, packaged ? 'app' : 'build');
const node = packaged ? path.join(root, `runtime/node${windows ? '.exe' : ''}`) : process.execPath;
const source = path.join(root, 'source');
const sdkRoot = path.resolve(process.env.AI_TEST_SDK_ROOT ?? path.join(devkit, 'build/game-sdk-isolated'));
const manifest = await fs.readFile(path.join(sdkRoot, 'manifest.json'));
const before = createHash('sha256').update(manifest).digest('hex');
const results = [];
async function run(name, command, argv, env = process.env) {
    const result = await new Promise((resolve, reject) => {
        const child = spawn(command, argv, { cwd: source, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
        child.stdout.on('data', bytes => { stdout += bytes; process.stdout.write(bytes); });
        child.stderr.on('data', bytes => { stderr += bytes; process.stderr.write(bytes); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ command, args: argv, code, signal, stdout, stderr }); });
    });
    await fs.writeFile(path.join(root, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    results.push({ name, code: result.code, signal: result.signal });
    assert.equal(result.code, 0, `${name} failed; evidence retained in ${root}`);
}
console.log(`AI focused build/evidence: ${root}`);
try {
    await fs.mkdir(source);
    for (const name of ['src', 'probes', 'tsconfig.json', 'package.json', 'package-lock.json']) await fs.cp(path.join(devkit, name), path.join(source, name),
        { recursive: true, errorOnExist: true, force: false });
    for (const directory of ['scripts', 'runtime']) await fs.mkdir(path.join(source, directory));
    for (const name of ['runtime/mcp-launch.c', 'runtime/mcp-launch-win32.c', 'scripts/build-publisher.mjs',
        'scripts/build-mcp-launch.mjs', 'scripts/build-supervisor-win32.mjs', 'scripts/verify-portable.mjs',
        ...(windows ? ['runtime/fs-win32.c', 'scripts/build-fs-win32.mjs'] : [])]) {
        await fs.copyFile(path.join(devkit, name), path.join(source, name), fs.constants.COPYFILE_EXCL);
    }
    await fs.mkdir(path.join(source, 'test'));
    for (const name of (await fs.readdir(path.join(devkit, 'test'))).filter(name => /^ai.*\.mjs$/.test(name))) {
        await fs.copyFile(path.join(devkit, 'test', name), path.join(source, 'test', name), fs.constants.COPYFILE_EXCL);
    }
    await fs.cp(path.join(devkit, 'test/fixtures/ai'), path.join(source, 'test/fixtures/ai'), { recursive: true, errorOnExist: true, force: false });
    const inputs = [];
    async function inventory(directory) {
        for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await inventory(filename);
            else inputs.push({ path: path.relative(source, filename).split(path.sep).join('/'),
                sha256: createHash('sha256').update(await fs.readFile(filename)).digest('hex') });
        }
    }
    await inventory(source);
    await fs.writeFile(path.join(root, 'source-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
    await fs.symlink(path.join(devkit, 'node_modules'), path.join(root, 'node_modules'), windows ? 'junction' : 'dir');
    if (packaged) {
        await fs.mkdir(path.dirname(node));
        await fs.copyFile(process.execPath, node, fs.constants.COPYFILE_EXCL);
        await fs.chmod(node, 0o755);
    }
    await run('typescript', process.execPath, [path.join(devkit, 'node_modules/typescript/bin/tsc'), '--project', path.join(source, 'tsconfig.json'), '--outDir', build]);
    await run('mcp-launch-build', process.execPath,
        ['scripts/build-mcp-launch.mjs', '--out', path.join(build, `host/cocos4-mcp-launch${windows ? '.exe' : ''}`)]);
    if (windows) {
        await run('fs-helper-build', process.execPath, ['scripts/build-fs-win32.mjs']);
        await fs.cp(path.join(source, 'build/host'), path.join(build, 'host'), { recursive: true, errorOnExist: true, force: false });
    }
    await fs.cp(path.join(devkit, 'skills'), path.join(root, 'skills'), { recursive: true, errorOnExist: true, force: false });
    await run('tests', node, ['--test', 'test/ai.test.mjs', 'test/ai-mcp-launch.test.mjs', 'test/ai-opencode-smoke.test.mjs',
        'test/ai-files.test.mjs', 'test/ai-skills.test.mjs'],
        { ...process.env, AI_TEST_BUILD_ROOT: build, AI_TEST_SDK_ROOT: sdkRoot, AI_TEST_EVIDENCE_ROOT: root });
    if (args.length) await run('real-opencode', node,
        ['test/ai-opencode-smoke.mjs', '--executable', args[1], '--build-root', build, '--sdk-root', sdkRoot, '--evidence-root', root]);
    if (args.length) await run('real-file-tools', node,
        ['test/ai-opencode-files.mjs', '--executable', args[1], '--build-root', build, '--sdk-root', sdkRoot, '--evidence-root', root]);
} finally {
    const after = createHash('sha256').update(await fs.readFile(path.join(sdkRoot, 'manifest.json'))).digest('hex');
    await fs.writeFile(path.join(root, 'summary.json'), `${JSON.stringify({ node: process.version, nodeExecutable: process.execPath,
        platform: process.platform, build, source,
        layout: packaged ? `app/src + app/host + runtime/node${windows ? '.exe' : ''}` : 'build/src + build/host', testNode: node,
        sdkRoot, sdkId: JSON.parse(manifest).sdkId, manifestSha256Before: before, manifestSha256After: after,
        results, modelGameplayDemonstration: false }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    assert.equal(after, before, 'Retained SDK manifest changed during focused verification.');
}
