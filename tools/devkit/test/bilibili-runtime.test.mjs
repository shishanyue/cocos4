import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildRuntime } = require('../scripts/build-runtime.cjs');
const { inspectClosure, readRuntime, verifyBilibili } = require('../runtime/verify-bilibili.cjs');
const { verifyWechat } = require('../runtime/verify-wechat.cjs');
const { verifyBytedance } = require('../runtime/verify-bytedance.cjs');
const { exerciseBilibili } = require('../runtime/bilibili-local-host.cjs');
const { inventory, sha256 } = require('../runtime/files.cjs');

test('runtime target selection rejects unsupported targets without building', async () => {
    for (const target of ['ANDROID', 'IOS', 'NATIVE', 'bilibili', '', null]) {
        await assert.rejects(buildRuntime({ profile: '2d-basic', builtinDirectory: '.', outDirectory: '.', target }), /TARGET_NOT_AVAILABLE/);
    }
    for (const target of [undefined, 'HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE']) {
        await assert.rejects(buildRuntime({ profile: '2d-basic', builtinDirectory: '.', outDirectory: '.', target }), /OUTPUT_CONFLICT/);
    }
});

test('local report outputs cannot enter the input runtime through Windows path casing', async t => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'minigame evidence-')));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const directory = join(temporary, 'Runtime');
    await mkdir(directory);
    await writeFile(join(directory, 'payload.txt'), 'Output boundary fixture only');
    // An inventory fixture can reach the output guard, but cannot pass runtime closure inspection.
    await writeFile(join(directory, 'runtime.json'), JSON.stringify({ schemaVersion: 1, files: await inventory(directory) }));
    for (const [target, verify] of [['bilibili', verifyBilibili], ['wechat', verifyWechat], ['bytedance', verifyBytedance]]) {
        await t.test(target, async () => {
            const aliases = [directory];
            if (process.platform === 'win32') aliases.push(join(temporary, 'runtime'));
            for (const alias of aliases) {
                for (const outDirectory of [alias, join(alias, 'evidence'), join(alias, '..evidence')]) {
                    await assert.rejects(verify({ runtimeDirectory: directory, outDirectory }), /Evidence output must be outside the runtime/);
                }
            }
            const sibling = `${directory}-local`;
            await assert.rejects(verify({ runtimeDirectory: directory, outDirectory: sibling }),
                error => error.code === 'ERR_ASSERTION' && error.expected === `cocos4-${target}-runtime`);
            await assert.rejects(readFile(join(sibling, 'local-report.json')), { code: 'ENOENT' });
        });
    }
});

test('Application tracks a void run callback and synchronous/asynchronous start failures', async () => {
    const source = await readFile(new URL('../runtime/bilibili-application.js', import.meta.url), 'utf8');
    let Application;
    vm.runInNewContext(source, { System: { register(deps, declare) { declare((name, value) => { Application = value; }).execute(); } } });
    let callback;
    let release;
    let settled = false;
    const application = new Application();
    application.cc = { game: { run(value) { callback = value; } } };
    application.main = { start: () => new Promise(resolve => { release = resolve; }) };
    const pending = application.start().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    callback();
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await pending;
    assert.equal(settled, true);
    for (const start of [() => { throw new Error('sync failure'); }, () => Promise.reject(new Error('async failure'))]) {
        application.main.start = start;
        const pending = application.start();
        callback();
        await assert.rejects(pending, /failure/);
    }
    application.cc.game.run = () => { throw new Error('run failure'); };
    await assert.rejects(application.start(), /run failure/);
});

// Explicit fresh-build artifacts, not a fabricated engine or silently reused HTML5 bundle.
const directories = process.env.BILIBILI_RUNTIME_DIRECTORIES?.split(delimiter).map(directory => resolve(directory)) || [];
test('fresh Bilibili artifacts: closure, canonical preflight and real loader/Application integration',
    { skip: !directories.length, timeout: 240000 }, async t => {
        for (const directory of directories) {
            const { files, descriptor, descriptorBytes } = await readRuntime(directory);
            await t.test(`${descriptor.profile}: source/resource closure and runtime payload`, () => {
                const evidence = inspectClosure(files);
                assert.ok(evidence.engineExportCount > 100);
                assert.ok(evidence.requiredCCExportCount > 20);
                assert.equal(descriptor.constants.USE_3D, descriptor.profile === '3d-basic');
                assert.equal(descriptor.validationLevels.vendorBuild, false);
                assert.equal(descriptor.validationLevels.device, false);
                assert.equal(descriptor.features.includes('legacy-pipeline'), true);
                assert.doesNotMatch(files.get('template/src/main.ts').toString(), /\bdocument\b|\bwindow\b/);
                assert.match(files.get('template/src/main.ts').toString(), /text.on\(Node.EventType.TOUCH_END/);
                assert.equal(files.has('index.html'), false);
                assert.equal(files.has('boot.js'), false);
            });
            for (const distinct of [false, true]) await t.test(`${descriptor.profile}: actual loader, ${distinct ? 'distinct' : 'shared'} global`, async () => {
                const evidence = await exerciseBilibili(files, { distinct });
                assert.ok(evidence.loaded.includes('application.js'));
                assert.ok(evidence.loaded.includes('game/main.js'));
                assert.ok(evidence.loaded.includes('game/world.js'));
                assert.equal(evidence.launchSuccessCount, 1);
                assert.equal(evidence.probe.restarts, 1);
            });
            await t.test(`${descriptor.profile}: actual loader fails without the canonical distinct-global bridge`, async () => {
                const copy = new Map(files);
                copy.set('game.js', Buffer.from(files.get('game.js').toString().replace('if (globalThis.self !== globalThis)', 'if (false)')));
                await assert.rejects(exerciseBilibili(copy, { distinct: true }), /System is not defined/);
            });
            for (const fault of ['missing-settings', 'missing-export', 'missing-builtin', 'invalid-material', 'init', 'run', 'start-sync', 'start-async', 'missing-asset']) {
                await t.test(`${descriptor.profile}: ${fault} rejects startup without launchSuccess`, async () => {
                    const result = await exerciseBilibili(files, { distinct: true, fault });
                    assert.equal(result.errors.length, 1);
                });
            }
            await t.test(`${descriptor.profile}: parser, unknown module, asset and settings negative gates`, () => {
                for (const [mutate, expected] of [
                    [copy => copy.set('game/main.js', Buffer.from('System.register(["unknown-package"], function () {});')), /UNKNOWN_MODULE/],
                    [copy => copy.delete('game/world.js'), /MISSING_RESOURCE/],
                    [copy => copy.delete('assets/game/tile.png'), /MISSING_RESOURCE/],
                    [copy => copy.set('game/main.js', Buffer.from('const =;')), /Unexpected token/],
                    [copy => copy.set('settings.json', Buffer.from('{"engine":{"builtinAssets":[]}}')), /deep-equal/],
                    [copy => {
                        const metadata = JSON.parse(copy.get('game-compiler.json'));
                        metadata.requiredCCExports.push('MissingCCExport');
                        copy.set('game-compiler.json', Buffer.from(JSON.stringify(metadata)));
                    }, /FEATURE_NOT_IN_PROFILE/],
                ]) { const copy = new Map(files); mutate(copy); assert.throws(() => inspectClosure(copy), expected); }
            });
            await t.test(`${descriptor.profile}: sibling local-report contract is hash-bound`, async () => {
                const report = JSON.parse(await readFile(`${directory}-local/local-report.json`));
                assert.equal(report.schemaVersion, 1);
                assert.equal(report.kind, 'cocos4-bilibili-local-report');
                assert.equal(report.profile, descriptor.profile);
                assert.equal(report.runtimeSha256, sha256(descriptorBytes));
                assert.equal(report.success, true);
                assert.deepEqual(report.checks, { moduleClosure: true, canonicalPreflight: true,
                    loaderBootstrapSharedGlobal: true, loaderBootstrapDistinctGlobal: true, entryLifecycle: true, startupFailure: true });
                assert.deepEqual(report.validationLevels, { vendorBuild: false, device: false });
                assert.deepEqual(report.evidence.shared.errors, []);
                assert.deepEqual(report.evidence.distinct.errors, []);
                assert.equal(report.evidence.failures.length, 9);
            });
            await t.test(`${descriptor.profile}: verifier refuses tampering and invalid canonical config`, async () => {
                const temporary = await realpath(await mkdtemp(join(tmpdir(), 'bilibili negative-')));
                t.after(() => rm(temporary, { recursive: true, force: true }));
                const copy = join(temporary, 'runtime');
                await cp(directory, copy, { recursive: true });
                const config = JSON.parse(files.get('game.json'));
                await writeFile(join(copy, 'game.json'), JSON.stringify({ ...config, appId: '' }));
                await assert.rejects(verifyBilibili({ runtimeDirectory: copy }), /integrity mismatch/);
                const descriptor = JSON.parse(descriptorBytes);
                descriptor.files = (await inventory(copy)).filter(file => file.path !== 'runtime.json');
                await writeFile(join(copy, 'runtime.json'), JSON.stringify(descriptor));
                await assert.rejects(verifyBilibili({ runtimeDirectory: copy }), /requires a nonempty appId/);
                await assert.rejects(readFile(`${copy}-local/local-report.json`), { code: 'ENOENT' });
            });
        }
    });
