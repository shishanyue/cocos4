import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, connect, check, finished, starter, write, cli, sdkRoot } from './fixtures/logic-client.mjs';

// Each Windows case verifies the genuine SDK and creates a private compiler closure.
test('trusted pure logic through official MCP: real TS 4.9.5, Node declarations, permissions and results', { timeout: process.platform === 'win32' ? 1800000 : 360000 }, async t => {
    const env = await fixture(t);
    const manifestBefore = await fs.readFile(path.join(sdkRoot, 'manifest.json'));
    let session = await connect(env, false);
    const tool = session.tools.find(tool => tool.name === 'cocos4_project_check');
    assert(tool.inputSchema.required.includes('requestKey'));
    for (const checks of [[], ['types', 'types'], ['logic', 'logic'], ['engine']]) await session.call('project_check', check('game', checks), 'INVALID_ARGUMENTS');
    await session.call('project_check', { ...check(), requestKey: undefined }, 'INVALID_ARGUMENTS');
    await session.call('project_check', check(), 'PERMISSION_DENIED');
    await session.call('project_check', { ...check(), executeTests: true }, 'INVALID_ARGUMENTS');
    await starter(session);
    await session.close();
    session = await connect(env);
    assert.equal(session.tools.find(tool => tool.name === 'cocos4_project_check').annotations.openWorldHint, true);
    const marker = path.join(env.directory, 'MUST_NOT_EXECUTE_CONFIG');
    const canary = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('SCRIPT_EXECUTED');`;
    for (const file of ['babel.config.cjs', 'test.config.cjs', 'hook.cjs']) await write(env, file, canary);
    const pkg = JSON.parse(await fs.readFile(path.join(env.workspace, 'game/package.json'), 'utf8'));
    pkg.scripts = { test: 'node hook.cjs', postinstall: 'node hook.cjs', build: 'node hook.cjs' };
    await write(env, 'package.json', JSON.stringify(pkg));
    await write(env, 'tests/helper.mjs', 'throw new Error("HELPERS_ARE_NOT_DISCOVERED");');
    await write(env, 'src/rules.ts', 'export function score(value: number): number { return value + 7; }');
    const passing = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Scene } from 'cc';
import { score } from '../src/rules.js';
import { createWorld } from '../src/world.js';
test('score and pure template world', () => { assert.equal(score(4), 11); assert.equal(createWorld({} as Scene), false); });
test('typed async assertion', async () => { await assert.rejects(async () => { throw new Error('expected'); }, /expected/); });
`;
    await write(env, 'tests/rules.test.ts', passing);
    await t.test('passing TypeScript tests, canonical check-set keys, no implicit game build', async () => {
        const args = check('game', ['types', 'logic'], { requestKey: 'passing-ts' });
        const receipt = await session.call('project_check', args);
        assert.equal((await session.call('project_check', { ...args, checks: ['logic', 'types'] })).jobId, receipt.jobId);
        const page = await finished(session, receipt);
        assert.equal(page.job.state, 'succeeded', JSON.stringify(page));
        assert.equal(page.job.exitCode, 0);
        assert.equal(page.job.signal, null);
        assert.equal(page.job.workerExitCode, 0);
        assert.equal(page.report.logic.passed, 2);
        assert.equal(page.report.logic.failed, 0);
        assert.match(page.report.inputSnapshotSha256, /^[a-f0-9]{64}$/);
        for (const level of ['gameTypecheck', 'logicTypecheck', 'logicExecution']) assert(page.report.validationLevels.includes(level));
        assert.equal(page.report.artifacts, undefined);
        assert(!(await fs.readdir(env.stateDirectory)).some(name => name.startsWith('artifact-')));
        await session.call('project_check', { ...args, checks: ['types'] }, 'REQUEST_CONFLICT');
    });
    await t.test('ordinary JS, MJS and CJS tests execute without configs or npm', async () => {
        for (const extension of ['js', 'mjs', 'cjs']) {
            const source = extension === 'cjs'
                ? "const { test } = require('node:test'); const assert = require('node:assert'); test('cjs', () => assert.strictEqual(2 + 2, 4));"
                : `import { test } from 'node:test'; import assert from 'node:assert'; test('${extension}', () => assert.strictEqual(2 + 2, 4));`;
            await write(env, `tests/plain.test.${extension}`, source);
            const page = await finished(session, await session.call('project_check', check()));
            assert.equal(page.job.state, 'succeeded', JSON.stringify(page));
            assert.equal(page.report.logic.passed, 3);
            await fs.unlink(path.join(env.workspace, 'game/tests', `plain.test.${extension}`));
        }
    });
    await t.test('assertion failures fail the job even though the worker exits zero', async () => {
        await write(env, 'tests/rules.test.ts', passing.replace('score(4), 11', 'score(4), 12'));
        const page = await finished(session, await session.call('project_check', check()));
        assert.equal(page.job.state, 'failed', JSON.stringify(page));
        assert.equal(page.job.error.code, 'TEST_FAILED');
        assert.equal(page.job.exitCode, 1);
        assert.equal(page.job.workerExitCode, 0);
        assert(page.report.logic.failed > 0);
        assert(page.report.items.some(item => item.status === 'failed'));
        assert.equal((await session.call('job_cancel', { jobId: page.job.jobId })).accepted, false);
    });
    await t.test('TS errors and cc types cannot be hidden by skipping libraries or ambient widening', async () => {
        for (const source of [passing + '\nconst broken: number = "wrong";',
            "import type { Node } from 'cc'; const broken: Node = 1;"] ) {
            await write(env, 'tests/rules.test.ts', source);
            const page = await finished(session, await session.call('project_check', check()));
            assert.equal(page.job.state, 'failed', JSON.stringify(page));
            assert.equal(page.job.error.code, 'TYPECHECK_FAILED');
            assert.equal(page.job.exitCode, null, 'No OS runner started');
            assert.equal(page.job.workerExitCode, 0);
            assert(page.report.items.some(item => item.code === 'TS2322' && item.file === 'tests/rules.test.ts' && item.line));
        }
    });
    await t.test('engine execution, ancestor dependencies, escapes and executable config paths are rejected', async () => {
        for (const source of ["import { Node } from 'cc'; export const node = new Node();", "import 'ancestor-canary';",
            "import '../../outside.js';", "import '../babel.config.cjs';", "const target = 'node:fs'; import(target);",
            '/// <reference path="../../outside.d.ts" />\nexport const value = 1;',
            'declare module "cc" { export const widened: any; }']) {
            await write(env, 'tests/rules.test.ts', source);
            const page = await finished(session, await session.call('project_check', check()));
            assert.equal(page.job.error.code, 'UNSUPPORTED_PROJECT', JSON.stringify(page));
            assert.equal(page.job.exitCode, null);
        }
        await write(env, 'tests/rules.test.ts', passing);
        const config = await fs.readFile(path.join(env.workspace, 'game/tsconfig.json'));
        for (const value of [{ extends: '../outside.json' }, { compilerOptions: { skipLibCheck: true } }, { compilerOptions: { paths: { cc: ['../outside.d.ts'] } } }]) {
            await write(env, 'tsconfig.json', JSON.stringify(value));
            const page = await finished(session, await session.call('project_check', check()));
            assert.equal(page.job.error.code, 'UNSUPPORTED_PROJECT', JSON.stringify(page));
        }
        await write(env, 'tsconfig.json', config);
    });
    await t.test('running snapshot is independent of user file edits; changed inputs cannot return success', async () => {
        await write(env, 'tests/rules.test.ts', `import { test } from 'node:test'; import assert from 'node:assert/strict';
import { score } from '../src/rules.js';
test('snapshot', async () => { console.log('SNAPSHOT_RUNNING'); await new Promise(resolve => setTimeout(resolve, 1200)); assert.equal(score(4), 11); });`);
        const receipt = await session.call('project_check', check());
        const { until } = await import('./fixtures/logic-client.mjs');
        await until(async () => {
            const page = await session.call('job_get', { jobId: receipt.jobId });
            assert.equal(page.job.state, 'running', JSON.stringify(page));
            return (await session.call('job_logs', { jobId: receipt.jobId })).text.includes('SNAPSHOT_RUNNING');
        }, process.platform === 'win32' ? 150000 : 60000);
        await write(env, 'src/rules.ts', 'export function score(value: number): number { throw new Error("USER_FILE_EXECUTED"); }');
        const page = await finished(session, receipt);
        assert.equal(page.job.state, 'failed', JSON.stringify(page));
        assert.equal(page.job.error.code, 'INPUT_CHANGED');
        assert.equal(page.job.exitCode, 0, 'Runner tested the captured files, not the edited user path');
        await write(env, 'src/rules.ts', 'export function score(value: number): number { return value + 7; }');
    });
    await write(env, 'tests/rules.test.ts', passing);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    await session.close();
    assert.deepEqual(await fs.readFile(path.join(sdkRoot, 'manifest.json')), manifestBefore);
});

test('CLI startup execution flag is explicit boolean and cannot grant read-only execution', { timeout: 30000 }, async t => {
    const env = await fixture(t, 'logic-cli');
    for (const args of [['--execute-tests', 'true'], ['--mode', 'develop', '--execute-tests', 'yes'], ['--execute-tests', '1']]) {
        const child = spawn(process.execPath, [cli, 'tools', '--sdk-root', sdkRoot, '--workspace', env.workspace, '--state-root', env.stateRoot, ...args],
            { env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
        const code = await new Promise(resolve => child.on('close', resolve));
        assert.equal(code, 1); assert.equal(stdout, ''); assert.equal(JSON.parse(stderr).code, 'PERMISSION_DENIED');
    }
});
