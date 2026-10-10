import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { checkLogic } from '../build/src/logic.js';
import { ProcessTree } from '../build/src/process.js';
import { loadSdk } from '../build/src/sdk.js';
import { fixture, sdkRoot } from './fixtures/logic-client.mjs';

async function runLogic(env, t, files, sdk) {
    let result;
    return checkLogic({ project: env.workspace, projectFiles: files, toolchain: sdk.toolchainRoot,
        types: path.join(sdk.profile('HTML5', '2d-basic', 'debug').directory, 'types'), staging: env.directory }, async () => {
        const tree = await ProcessTree.launch({ directory: path.join(env.directory, 'logic'), message: value => { result = value.result; },
            stdout: stream => stream.resume(), stderr: stream => stream.resume() });
        env.cleanup.push(async () => { tree.stop(); await tree.closed; });
        await tree.ready; tree.start();
        const outcome = await tree.closed;
        assert.equal(outcome.treeClosed, true);
        assert.equal(outcome.infrastructureFailed, false);
        return { exitCode: outcome.exitCode, signal: outcome.signal, result, error: null };
    }, () => {}).catch(error => {
        t.diagnostic(JSON.stringify(error.report ?? String(error), null, 2));
        throw error;
    });
}

test('delivered TS4.9.5 and unmodified Node typings compile and run TS/JS/MJS/CJS with no default TS filesystem', { timeout: 60000 }, async t => {
    const sdk = await loadSdk(sdkRoot);
    for (const extension of ['ts', 'js', 'mjs', 'cjs']) await t.test(extension, async t => {
        const env = await fixture(t, `compiler-${extension}`);
        const files = new Map([
            ['src/rules.ts', Buffer.from('export function score(value: number): number { return value + 7; }')],
            [`tests/rules.test.${extension}`, Buffer.from(extension === 'cjs'
                ? "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('logic cjs', () => assert.equal(4 + 7, 11));"
                : "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { score } from '../src/rules.js'; test('logic', () => assert.equal(score(4), 11));")],
        ]);
        const report = await runLogic(env, t, files, sdk);
        assert.equal(report.logic.passed, 1);
        assert.equal(report.logic.failed, 0);
    });
});

test('empty node:test skip and TODO reasons retain their structured status', { timeout: 60000 }, async t => {
    const env = await fixture(t, 'compiler-directives');
    const sdk = await loadSdk(sdkRoot);
    const files = new Map([['tests/directives.test.ts', Buffer.from(`import { test } from 'node:test';
test('skipped without a reason', context => { context.skip(''); throw new Error('skipped failure'); });
test('TODO without a reason', context => { context.todo(''); throw new Error('known failure'); });
`)]]);
    const report = await runLogic(env, t, files, sdk);
    assert.equal(report.logic.passed, 0);
    assert.equal(report.logic.failed, 0);
    assert.equal(report.logic.skipped, 1);
    assert.equal(report.logic.todo, 1);
    for (const name of ['skipped without a reason', 'TODO without a reason']) {
        assert.equal(report.items.find(item => item.name === name)?.status, 'warning');
    }
    assert(report.validationLevels.includes('logicExecution'));
});

test('virtual logic imports and diagnostics work in Unicode and spaced Windows paths', { timeout: 60000 }, async t => {
    const sdk = await loadSdk(sdkRoot);
    const env = await fixture(t, 'logic 编译 空格');
    const files = new Map([
        ['src/纯 规则.ts', Buffer.from(`import values from '../assets/初始 分数.json';
export function score(value: number): number { return value + values.bonus; }`)],
        ['assets/初始 分数.json', Buffer.from('{"bonus":7}')],
        ['tests/嵌套 目录/rules.test.ts', Buffer.from(`import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../../src/纯 规则.js';
test('portable snapshot paths', () => assert.equal(score(4), 11));`)],
    ]);
    const report = await runLogic(env, t, files, sdk);
    assert.equal(report.logic.passed, 1);
    assert.equal(report.logic.failed, 0);
    assert.equal(report.items.find(item => item.name === 'portable snapshot paths')?.file, 'tests/嵌套 目录/rules.test.cjs');

    files.set('src/纯 规则.ts', Buffer.from('export function score(value: number): number { return "wrong"; }'));
    await assert.rejects(checkLogic({ project: env.workspace, projectFiles: files, toolchain: sdk.toolchainRoot,
        types: path.join(sdk.profile('HTML5', '2d-basic', 'debug').directory, 'types'), staging: env.directory },
    async () => assert.fail('A type error must not execute the snapshot.'), () => {}), error => {
        assert.equal(error.code, 'TYPECHECK_FAILED');
        assert(error.report.items.some(item => item.code === 'TS2322' && item.file === 'src/纯 规则.ts' && item.line === 1));
        return true;
    });
});
