import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Private source/build snapshots keep concurrent agents' shared builds intact.
// Generated evidence is intentionally retained, including on a failed test.
const root = fileURLToPath(new URL('../', import.meta.url));
assert(['18.20.8', '24.21.0'].includes(process.versions.node), 'Run with a pinned Node 18.20.8 or 24.21.0 binary.');
const noTests = process.argv.includes('--build-only');
const compilerOnly = process.argv.includes('--compiler-only');
const background = process.argv.includes('--background');
assert(process.argv.slice(2).every(arg => ['--build-only', '--compiler-only', '--background'].includes(arg))
    && (!background || (!noTests && !compilerOnly)), 'Usage: pinned-node test/logic-evidence.mjs [--build-only|--compiler-only|--background]');
const evidence = await fs.mkdtemp(path.join(root, `build/logic-lifetime-node${process.versions.node.split('.')[0]}-`));
const source = path.join(evidence, 'source');
await fs.mkdir(source);
for (const name of ['src', 'test', 'probes', 'scripts', 'runtime', 'skills', 'packaging', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    await fs.cp(path.join(root, name), path.join(source, name), { recursive: true,
        filter: filename => path.basename(filename) !== 'build' });
}
await fs.symlink(path.join(root, 'node_modules'), path.join(source, 'node_modules'));
const inputs = [];
async function inventory(directory, prefix = '') {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.name === 'node_modules' || item.name === 'build') continue;
        const name = prefix + item.name;
        if (item.isDirectory()) await inventory(path.join(directory, item.name), name + '/');
        else if (item.isFile()) {
            const bytes = await fs.readFile(path.join(directory, item.name));
            inputs.push({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
    }
}
await inventory(source);
await fs.writeFile(path.join(evidence, 'inputs.json'), JSON.stringify(inputs, null, 2));
const commands = [];
async function run(name, args, extra = {}) {
    const logfile = path.join(evidence, `${name}.log`);
    const output = createWriteStream(logfile);
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: source, shell: false,
        env: { PATH: '', LANG: 'C.UTF-8', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    const result = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => output.end(() => resolve({ code, signal })));
    });
    commands.push({ name, command: process.execPath, args, ...result, durationMs: Date.now() - started, logfile });
    await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ node: process.version, source, state: 'running', commands }, null, 2));
    process.stdout.write(JSON.stringify({ evidence, ...commands.at(-1) }) + '\n');
    assert.equal(result.code, 0, `${name} failed; see ${logfile}`);
    assert.equal(result.signal, null);
}
process.stdout.write(`Private evidence: ${evidence}\n`);
await run('typescript', [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', path.join(source, 'tsconfig.json')]);
await run('host', [path.join(source, 'scripts/build-supervisor.mjs')]);
await run('publisher', [path.join(source, 'scripts/build-publisher.mjs')]);
if (!noTests) {
    const sdk = path.resolve(process.env.LOGIC_TEST_SDK_ROOT ?? path.join(root, 'build/game-sdk'));
    await run('compiler', ['--test', '--test-reporter=tap', 'test/logic-compiler.test.mjs'], { LOGIC_TEST_SDK_ROOT: sdk, LOGIC_EVIDENCE_ROOT: evidence });
    if (!compilerOnly) {
        const files = ['test/logic.test.mjs', 'test/process.test.mjs', 'test/lifetime.test.mjs', 'test/job-logs.test.mjs'];
        await run(background ? 'tests-background' : 'tests', background ? ['scripts/verify-tests.mjs', ...files]
            : ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files],
        { LOGIC_TEST_SDK_ROOT: sdk, LOGIC_EVIDENCE_ROOT: evidence });
        if (background) {
            const receipt = JSON.parse(await fs.readFile(path.join(evidence, 'tests-background.log'), 'utf8'));
            await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ node: process.version, source,
                state: 'running', commands, finalResult: receipt.result }, null, 2));
            process.stdout.write(JSON.stringify({ state: 'running', evidence, finalResult: receipt.result }) + '\n');
        }
    }
}
if (!background) await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ node: process.version, source,
    state: 'completed', commands, scope: noTests ? 'Build only' : compilerOnly ? 'Compiler only' : 'Logic compiler and lifetime tests only' }, null, 2));
