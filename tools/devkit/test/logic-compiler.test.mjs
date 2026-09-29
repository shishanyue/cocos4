import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { checkLogic } from '../build/src/logic.js';
import { ProcessTree } from '../build/src/process.js';
import { loadSdk } from '../build/src/sdk.js';
import { fixture, sdkRoot } from './fixtures/logic-client.mjs';

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
        let result;
        const report = await checkLogic({ project: env.workspace, projectFiles: files, toolchain: sdk.toolchainRoot,
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
        assert.equal(report.logic.passed, 1);
        assert.equal(report.logic.failed, 0);
    });
});
