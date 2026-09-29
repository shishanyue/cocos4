// Orchestration contract tests only. No synthetic SDK/declarations or engine build.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pins, publishVerificationResult, requireCompleteTap, requireFreshOutput, requireNodeArchive, requireNodeLock,
    verificationEnvironment, verificationLayout, verificationReceipt } from '../scripts/prepare-verification.mjs';
import { auditTap, testEnvironment } from '../scripts/verify-tests.mjs';

test('both pinned lanes provision eight distinct runtime/report paths and mandatory integration inputs', () => {
    assert.deepEqual(pins.nodes, ['18.20.8', '24.21.0']);
    assert.equal(pins.effectsNode, '24.21.0');
    const layout = verificationLayout('/isolated/run/engine');
    assert.equal(layout.runtimes.length, 8);
    assert.equal(new Set(layout.runtimes.map(item => item.directory)).size, 8);
    for (const variant of ['debug', 'release']) for (const target of ['HTML5', 'BILIBILI']) {
        assert.deepEqual(layout.runtimes.filter(item => item.target === target && item.variant === variant).map(item => item.profile),
            ['2d-basic', '3d-basic']);
    }
    const builtins = { '2d-basic': '/isolated/run/effects-2d', '3d-basic': '/isolated/run/effects-3d' };
    const env = verificationEnvironment(layout, builtins, '/isolated/run/chrome');
    for (const name of ['GAME_SDK_INTEGRATION', 'RUNTIME_INTEGRATION', 'RELEASE_GAME_INTEGRATION']) assert.equal(env[name], '1');
    for (const name of ['LOGIC_TEST_SDK_ROOT', 'COMBINED_SDK_ROOT', 'BILIBILI_PACKAGE_SDK']) assert.equal(env[name], layout.debugSdk);
    assert.equal(env.AI_TEST_SDK_ROOT, layout.sdk);
    assert.equal(env.RELEASE_GAME_SDK_ROOT, layout.sdk);
    assert.equal(layout.candidate, '/isolated/run/portable-candidate');
    assert.equal(env.PORTABLE_STARTUP_RELEASE, layout.candidate);
    assert.equal(env.PORTABLE_STARTUP_NODE, path.join(layout.candidate, 'runtime/node'));
    assert.equal(env.AI_TEST_EVIDENCE_ROOT, path.join(layout.build, 'ai-evidence'));
    assert(!layout.candidate.startsWith(`${layout.engine}/`));
    assert(!layout.runtimes.some(item => item.directory === layout.candidate));
    assert.equal(env.API_DOCS_LEGACY_SDK_ROOT, layout.legacySdk);
    assert.equal(env.GAME_CHROME_EXECUTABLE, env.RUNTIME_CHROME);
    const repro = { GAME_SDK_RUNTIME_ROOT: layout.debugHtml, RUNTIME_BUILTINS_2D: builtins['2d-basic'],
        BILIBILI_SDK_BASE_ROOT: layout.base, LEGACY_HTML5_SDK_ROOT: layout.legacySdk, COMBINED_SDK_ROOT: layout.debugSdk };
    const forwarded = testEnvironment({ ...env, NODE_OPTIONS: '--require=unreviewed' }, true);
    assert.equal(forwarded.NODE_OPTIONS, undefined);
    assert.equal(forwarded.AI_TEST_SDK_ROOT, layout.sdk);
    assert.equal(forwarded.AI_TEST_EVIDENCE_ROOT, env.AI_TEST_EVIDENCE_ROOT);
    assert.deepEqual(testEnvironment({ AI_TEST_EVIDENCE_ROOT: env.AI_TEST_EVIDENCE_ROOT }), { AI_TEST_EVIDENCE_ROOT: env.AI_TEST_EVIDENCE_ROOT });
    const withoutAiEvidence = { ...env }; delete withoutAiEvidence.AI_TEST_EVIDENCE_ROOT;
    assert.doesNotThrow(() => testEnvironment(withoutAiEvidence, true), 'Evidence output remains optional, unlike SDK inputs');
    for (const [key, value] of Object.entries(repro)) {
        assert.equal(env[key], value);
        assert.equal(forwarded[key], value, `Reproducibility input must survive the verifier allowlist: ${key}`);
        const missing = { ...env }; delete missing[key];
        assert.throws(() => testEnvironment(missing, true), new RegExp(`Missing strict integration inputs: ${key}`));
    }
    assert.throws(() => testEnvironment({ ...env, GAME_SDK_INTEGRATION: '0' }, true), /Missing strict integration inputs: GAME_SDK_INTEGRATION/);
    assert.equal(env.BILIBILI_RUNTIME_DIRECTORIES.split(path.delimiter).length, 2);
    for (const item of layout.runtimes) assert.equal(item.report,
        `${item.directory}-${item.target === 'HTML5' ? 'browser/browser' : 'local/local'}-report.json`);
    assert.throws(() => verificationEnvironment(layout, {}, '/isolated/run/chrome'), /Both real builtin/);
    assert.throws(() => verificationEnvironment({ ...layout, candidate: undefined }, builtins, '/isolated/run/chrome'), /canonical absolute/);
    assert.throws(() => verificationLayout('/checkout/../checkout'), /canonical absolute/);
    assert.throws(() => verificationLayout('/checkout\nINJECTED=1'), /canonical absolute/);
});

test('reproducibility skips only nonintegration runs, never missing required integration inputs', async () => {
    const run = promisify(execFile);
    const args = ['--test', '--test-reporter=tap', fileURLToPath(new URL('./reproducibility.test.mjs', import.meta.url))];
    const { stdout } = await run(process.execPath, args, { env: {}, timeout: 10000 });
    assert.deepEqual(auditTap(stdout).totals, { tests: 1, pass: 0, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
    await assert.rejects(run(process.execPath, args, { env: { GAME_SDK_INTEGRATION: '1' }, timeout: 10000 }), error => {
        assert.equal(error.code, 1);
        assert.equal(auditTap(error.stdout).complete, true);
        assert.deepEqual(auditTap(error.stdout).totals, { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
        assert.match(error.stdout, /Missing reproducibility inputs: GAME_SDK_RUNTIME_ROOT, RUNTIME_BUILTINS_2D, BILIBILI_SDK_BASE_ROOT, LEGACY_HTML5_SDK_ROOT, COMBINED_SDK_ROOT/);
        return true;
    });
});

test('portable Node input is the reviewed official archive, not a setup-node or npm binary', async () => {
    const lock = JSON.parse(await fs.readFile(new URL('../packaging/node-lock.json', import.meta.url)));
    assert.equal(requireNodeLock(lock), lock);
    assert.equal(lock.version, pins.effectsNode);
    assert.equal(lock.url, 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz');
    for (const change of [
        { schemaVersion: 2 }, { version: '18.20.8' }, { target: 'linux-arm64' }, { archiveRoot: '../node' },
        { url: lock.url.replace('https:', 'http:') }, { url: lock.npmComparison.url },
        { url: `${lock.url}?unreviewed` }, { checksumsUrl: 'https://example.invalid/SHASUMS256.txt' },
        { sha256: 'unverified' }, { sha256: lock.sha256.toUpperCase() }, { sha256: undefined },
        { files: ['bin/node'] }, { files: [...lock.files, 'bin/npm'] },
    ]) assert.throws(() => requireNodeLock({ ...lock, ...change }));
});

test('missing, damaged or aliased Node archives fail before extraction without changing the input', async t => {
    const lock = JSON.parse(await fs.readFile(new URL('../packaging/node-lock.json', import.meta.url)));
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devkit-node-input-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const archive = path.join(root, `${lock.archiveRoot}.tar.xz`);
    await assert.rejects(requireNodeArchive(archive, lock), { code: 'ENOENT' });
    // Deliberately invalid bytes exercise rejection only, never a stand-in runtime/candidate.
    const invalid = 'not an official Node archive';
    await fs.writeFile(archive, invalid, { flag: 'wx' });
    await assert.rejects(requireNodeArchive(archive, lock), /does not match the reviewed official pin/);
    await fs.symlink(archive, path.join(root, 'alias.tar.xz'));
    await assert.rejects(requireNodeArchive(path.join(root, 'alias.tar.xz'), lock), /Symlink input/);
    await fs.link(archive, path.join(root, 'hardlink.tar.xz'));
    await assert.rejects(requireNodeArchive(archive, lock), /Unsafe\/oversized input/);
    assert.equal(await fs.readFile(archive, 'utf8'), invalid);
    assert.deepEqual((await fs.readdir(root)).sort(), ['alias.tar.xz', 'hardlink.tar.xz', path.basename(archive)].sort());
});

test('preparation rechecks interruption after asynchronous stage setup', { timeout: 10000 }, async () => {
    const script = await fs.readFile(new URL('../scripts/prepare-verification.mjs', import.meta.url), 'utf8');
    const start = script.indexOf('    const run = async '), end = script.indexOf('\n    try {', start);
    assert(start >= 0 && end > start);
    // Exercise the actual stage runner, never main/provisioning; all side effects are stubbed.
    const runFixture = new Function('assert', 'path', 'checkpoint', `
        const env = {}, records = [], out = '/fixture', process = { stdout: { write() {} } };
        let active, escalation, interrupted = false, spawned = false;
        const stop = () => { interrupted = true; };
        const pause = async name => { await Promise.resolve(); if (name === checkpoint) stop(); };
        const receipt = () => pause('receipt'), json = () => pause('command'), hash = () => '';
        const fs = {
            open: async () => { await pause('log'); return { close: async () => {} }; },
            readFile: async () => Buffer.alloc(0),
        };
        const spawn = () => {
            assert.equal(checkpoint, undefined, 'Interrupted stage reached spawn');
            spawned = true;
            return { once(event, callback) { if (event === 'close') queueMicrotask(() => callback(0, null)); } };
        };
        ${script.slice(start, end)}
        return run('fixture', 'unused', [], out).then(() => assert(spawned));
    `);
    await runFixture(assert, path);
    for (const checkpoint of ['receipt', 'command', 'log']) {
        await assert.rejects(runFixture(assert, path, checkpoint), /Verification interrupted/, checkpoint);
    }
});

test('CI contract requires host probes, verified download, clean offline assembly and the unfiltered all-tests lane', async () => {
    // Source/wiring assertions are not a clean checkout or hosted rehearsal.
    const script = await fs.readFile(new URL('../scripts/prepare-verification.mjs', import.meta.url), 'utf8');
    const workflow = await fs.readFile(new URL('../../../.github/workflows/devkit-probes.yml', import.meta.url), 'utf8');
    assert.match(workflow, /node: \['18\.20\.8', '24\.21\.0'\]/);
    for (const dependency of ['binutils', 'bubblewrap', 'curl', 'tar', 'xz-utils']) {
        assert.match(workflow, new RegExp(`apt-get install -y [^\\n]*\\b${dependency}\\b`));
    }
    assert.match(workflow, /sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
    assert.match(workflow, /install -d -m 700 \/tmp\/opencode/);
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /xvfb-run -a node tools\/devkit\/scripts\/prepare-verification\.mjs --out "\$VERIFICATION_OUT" --effect-node "\$EFFECT_NODE"/);
    const receiptStep = workflow.indexOf('      - name: Retain Non-Sensitive Integration Receipt');
    assert(receiptStep > 0);
    assert.doesNotMatch(workflow.slice(0, receiptStep), /^\s*if:|actions\/upload-artifact/m);
    assert.doesNotMatch(workflow, /^\s*(?:continue-on-error|paths|paths-ignore):|actions\/cache|contents: write/m);
    assert.equal([...workflow.matchAll(/uses: actions\/upload-artifact/g)].length, 1);
    assert.match(workflow.slice(receiptStep), /if: always\(\)\n        uses: actions\/upload-artifact@v4/);
    assert.match(workflow.slice(receiptStep), /^          path: \$\{\{ env\.VERIFICATION_OUT \}\}\/ci-receipt\.json\n          if-no-files-found: warn\n          retention-days: 7\s*$/m);
    assert.match(workflow, /    env:\n      VERIFICATION_OUT: \$\{\{ runner\.temp \}\}\/devkit-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-node\$\{\{ matrix\.node \}\}/);
    assert.match(script, /JSON\.stringify\(verificationReceipt\(\{ \.\.\.inputs, \.\.\.result, records \}\)/);
    assert.match(script, /await fs\.rename\(path\.join\(out, 'ci-receipt\.json\.tmp'\), path\.join\(out, 'ci-receipt\.json'\)\)/);
    assert.match(script, /records\.push\(record\);\n        await receipt\(\)/);
    assert.match(script, /await json\(`\$\{record\.log\}\.result\.json`, record\);\n            await receipt\(\)/);
    assert.match(script, /await publishVerificationResult\(out, \{ \.\.\.inputs, success: true, totals, records \}, \(\) => interrupted\)/);
    assert.match(script, /assert\(result\.success, 'Verification interrupted'\)/);
    assert.match(script, /await publishVerificationResult\(out, \{ \.\.\.inputs, success: false,\n            error: String\(error\.stack \?\? error\), records \}, \(\) => interrupted\)/);
    assert.match(script, /process\.platform === 'linux' && process\.arch === 'x64'/);
    assert.match(script, /await fs\.access\('\/tmp\/opencode', constants\.W_OK \| constants\.X_OK\)/);
    assert.match(script, /await run\('host-readelf', '\/usr\/bin\/readelf'/);
    const hostProbe = script.match(/await run\('host-mcp-namespaces',[\s\S]*?30000\);/)?.[0];
    assert(hostProbe);
    for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-net', '--proc', '--tmpfs', '--ro-bind']) assert(hostProbe.includes(flag));
    assert(hostProbe.includes('"/usr/bin/env"'));
    const download = script.indexOf("await run('download-reviewed-node'");
    const verified = script.indexOf('inputs.nodeArchive = await requireNodeArchive(nodeArchive, nodeLock)');
    const assembly = script.indexOf("await run('offline-candidate'");
    const full = script.indexOf("requireCompleteTap(await run('full-integration'");
    assert(download > 0 && verified > download && assembly > verified && full > assembly);
    assert.match(script, /'--proto', '=https', '--tlsv1\.2'/);
    assert.match(script, /'--output', nodeArchive, '--url', nodeLock\.url/);
    assert.match(script, /'tools\/devkit\/packaging\/node-lock\.json'/);
    const offline = script.match(/await run\('offline-candidate',[\s\S]*?1800000\);/)?.[0];
    assert(offline);
    for (const value of ["'/usr/bin/bwrap'", "'--unshare-net'", "'--ro-bind', '/', '/'", "'--tmpfs', '/tmp'", "'--bind', out, out", "'--ro-bind', node, node",
        "'scripts/prepare-release.mjs'", "'--sdk-root', layout.sdk", "'--node-archive', nodeArchive", "'--out', layout.candidate"]) assert(offline.includes(value));
    assert(offline.indexOf("'--tmpfs', '/tmp'") < offline.indexOf("'--bind', out, out"));
    assert(script.indexOf('SOURCE_DIRTY: verification requires a clean checkout') < script.indexOf("await run('clone-source'"));
    assert(script.indexOf('SOURCE_DIRTY: provisioned clone must still be clean') < assembly);
    assert.match(script, /assert\.equal\(candidate\.source\.dirty, false/);
    assert.match(script, /assert\.equal\(candidate\.sdk\.sdkId, combined\.sdkId\)/);
    assert.match(script, /assert\.equal\(candidate\.runtime\.node\.archiveSha256, inputs\.nodeArchive\.sha256\)/);
    assert.match(script, /await run\('portable-node-version', integrationEnv\.PORTABLE_STARTUP_NODE/);
    assert.match(script, /\.filter\(file => file\.endsWith\('\.test\.mjs'\)\)\.sort\(\)/);
    assert.match(script, /'build\/probes\/mcp-client\.js', \.\.\.files\.map\(file => `test\/\$\{file\}`\)\], devkit, integrationEnv/);
    assert.doesNotMatch(script, /--test-name-pattern|--allow-dirty|--skip|process\.env\.PORTABLE_STARTUP/);
    assert.match(script, /verifyInventory\(layout\.candidate\)\)\.releaseId, candidate\.releaseId, 'Candidate changed/);
    assert.match(script, /'Candidate changed during verification'\);\n        assert\(!interrupted, 'Verification interrupted'\);/);
});

test('Chromium OS packages are explicit disposable-host prerequisites; provisioner installs only run-local browser files', async () => {
    const script = await fs.readFile(new URL('../scripts/prepare-verification.mjs', import.meta.url), 'utf8');
    const workflow = await fs.readFile(new URL('../../../.github/workflows/devkit-probes.yml', import.meta.url), 'utf8');
    const runtime = JSON.parse(await fs.readFile(new URL('../runtime/package.json', import.meta.url)));
    assert.equal(runtime.devDependencies['playwright-core'], '1.58.2', 'Review the Ubuntu Chromium OS package list on upgrade');
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    const host = workflow.match(/      - name: Install Chromium OS Prerequisites On This Disposable Runner\n[\s\S]*?(?=      - name:)/)?.[0];
    assert(host);
    for (const dependency of ['xvfb', 'fonts-noto-color-emoji', 'fonts-unifont', 'libfontconfig1', 'libfreetype6',
        'xfonts-cyrillic', 'xfonts-scalable', 'fonts-liberation', 'fonts-ipafont-gothic', 'fonts-wqy-zenhei',
        'fonts-tlwg-loma-otf', 'fonts-freefont-ttf', 'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64',
        'libatspi2.0-0t64', 'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libgbm1', 'libglib2.0-0t64',
        'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1',
        'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2']) {
        assert(host.split(/\s+/).includes(dependency), dependency);
    }
    assert(workflow.indexOf(host) < workflow.indexOf('      - name: Provision Inputs'));
    assert.match(script, /preinstalled Chromium OS dependencies/);
    assert.match(script, /PLAYWRIGHT_BROWSERS_PATH: path\.join\(out, 'browsers'\)/);
    assert.match(script, /await run\('install-browser',[\s\S]*?'install', 'chromium'\], devkit\)/);
    assert.match(script, /const chrome = await fs\.realpath/);
    assert.match(script, /assert\(chrome\.startsWith\(`\$\{env\.PLAYWRIGHT_BROWSERS_PATH\}\/`\)/);
    assert.doesNotMatch(script, /--with-deps|install-deps|\bsudo\b|\bapt(?:-get)?\b/);
});

test('CI receipts allowlist identities, totals and stage outcomes, never raw errors, environments or payloads', () => {
    const secret = 'UNCLEARED_AUTH_ENV_OR_PAYLOAD';
    const digest = 'a'.repeat(64);
    const startedAt = '2026-09-23T00:00:00.000Z', finishedAt = '2026-09-23T00:01:00.000Z';
    const record = { name: 'full-integration', code: 1, signal: null, startedAt, finishedAt, logSha256: digest,
        environment: { AUTH_TOKEN: secret, HOME: secret, XAUTHORITY: secret }, command: secret, args: [secret],
        cwd: secret, log: secret, stdout: secret, stderr: secret, error: secret };
    const input = { node: 'v24.21.0', revision: 'b'.repeat(40), startedAt, finishedAt, cleanClone: true,
        nodeArchive: { sha256: digest, archive: secret, url: secret },
        candidate: { releaseId: `sha256-${digest}`, sdkId: `sha256-${digest}`, distributionApproved: false,
            directory: secret, source: { environment: secret }, files: [secret] },
        totals: { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0, diagnostic: secret },
        records: [record], source: secret, out: secret, error: secret, environment: { AUTH_TOKEN: secret }, payload: secret };
    for (const [result, status] of [[{}, 'running'], [{ success: true }, 'passed'],
        [{ success: false }, 'failed'], [{ success: false, interrupted: true }, 'interrupted'],
        [{ success: true, interrupted: true }, 'interrupted']]) {
        const receipt = verificationReceipt({ ...input, ...result });
        assert.equal(receipt.status, status);
        assert.equal(receipt.revision, input.revision);
        assert.equal(receipt.nodeArchiveSha256, digest);
        assert.deepEqual(receipt.candidate, { releaseId: `sha256-${digest}`, sdkId: `sha256-${digest}`, distributionApproved: false });
        assert.deepEqual(receipt.records, [{ name: 'full-integration', code: 1, signal: null, interrupted: undefined,
            startedAt, finishedAt, logSha256: digest }]);
        assert.deepEqual(receipt.totals, { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
        assert(!JSON.stringify(receipt).includes(secret));
    }
    const early = verificationReceipt({ node: input.node, startedAt, records: [{ name: 'install-browser', startedAt }] });
    assert.equal(early.status, 'running');
    assert.equal(early.candidate, undefined);
    assert.equal(early.records[0].code, undefined, 'An incomplete stage must not become a success');
    assert.equal(verificationReceipt({ success: false }).status, 'failed', 'Preflight failures also have a receipt');
});

test('final publication rechecks interruption after staging, including failure output', { timeout: 10000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devkit-verification-publication-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const [name, success, interruptAt] of [['success', true, Infinity], ['failure', false, Infinity],
        ['interrupted', true, 1], ['late-success', true, 2], ['late-failure', false, 2]]) {
        const out = path.join(root, name);
        await fs.mkdir(out);
        const resultFile = path.join(out, 'result.json'), receiptFile = path.join(out, 'ci-receipt.json');
        await fs.writeFile(receiptFile, JSON.stringify(verificationReceipt({ node: process.version })));
        let checks = 0;
        const result = await publishVerificationResult(out, { node: process.version, success, records: [] }, () => {
            // The second observation follows async writes. Staged success must not yet be public.
            assert.equal(existsSync(resultFile), false, name);
            assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).status, 'running', name);
            return ++checks >= interruptAt;
        });
        const interrupted = Number.isFinite(interruptAt);
        assert.equal(result.success, success && !interrupted, name);
        assert.equal(result.interrupted, interrupted, name);
        assert.deepEqual(JSON.parse(await fs.readFile(resultFile, 'utf8')), result);
        assert.equal(JSON.parse(await fs.readFile(receiptFile, 'utf8')).status,
            interrupted ? 'interrupted' : success ? 'passed' : 'failed', name);
        assert.deepEqual((await fs.readdir(out)).sort(), ['ci-receipt.json', 'result.json']);
    }
});

test('missing totals, interruption fragments, failures, cancellations, skips and TODOs cannot pass', () => {
    const complete = '# tests 10\n# pass 10\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    assert.deepEqual(requireCompleteTap(complete), { tests: 10, pass: 10, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
    for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
        assert.throws(() => requireCompleteTap(complete.replace(new RegExp(`# ${field} \\d+\\n`), '')), /terminal TAP total/);
    }
    for (const field of ['fail', 'cancelled', 'skipped', 'todo']) {
        assert.throws(() => requireCompleteTap(complete.replace(`# ${field} 0`, `# ${field} 1`)), /Integration requires all tests/);
    }
    assert.throws(() => requireCompleteTap(complete.replace('# pass 10', '# pass 9')), /Integration requires/);
    assert.throws(() => requireCompleteTap(complete.replaceAll('10', '0')), /Integration requires/);
    assert.throws(() => requireCompleteTap(complete + complete), /ambiguous/);
    assert.throws(() => requireCompleteTap('TAP version 13\nok 1 - started\n'), /terminal TAP total/);
});

test('preparation refuses existing, overlapping and symlinked destinations without modifying them', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devkit-verification-inputs-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const existing = path.join(root, 'existing');
    await fs.mkdir(source); await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, 'sentinel'), 'untouched');
    await requireFreshOutput(source, path.join(root, 'new-run'));
    await assert.rejects(fs.lstat(path.join(root, 'new-run')), { code: 'ENOENT' });
    await assert.rejects(requireFreshOutput(source, existing), /OUTPUT_CONFLICT/);
    for (const out of [source, path.join(source, 'build'), root]) await assert.rejects(requireFreshOutput(source, out), /outside the source/);
    await fs.symlink(existing, path.join(root, 'alias'));
    await assert.rejects(requireFreshOutput(source, path.join(root, 'alias/new-run')), /canonical/);
    assert.equal(await fs.readFile(path.join(existing, 'sentinel'), 'utf8'), 'untouched');
});
