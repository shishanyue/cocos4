import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const engine = path.resolve(devkit, '../..');
const require = createRequire(import.meta.url);
const { readBuiltins, builtinIdentity } = require('../runtime/builtins.cjs');
const { sha256 } = require('../runtime/files.cjs');
const run = promisify(execFile);

// Reuse strict integration inputs, never trigger an engine/browser build. All
// writes, including TypeScript output, are private; build/src belongs to the parent.
test('retained-input reproducibility semantics, execution receipts and legacy readers', {
    skip: !process.env.GAME_SDK_RUNTIME_ROOT && process.env.GAME_SDK_INTEGRATION !== '1'
        ? 'Set GAME_SDK_RUNTIME_ROOT and the strict builtin/base/legacy/combined SDK inputs.' : false,
    timeout: 300000,
}, async t => {
    const environment = Object.fromEntries(['GAME_SDK_RUNTIME_ROOT', 'RUNTIME_BUILTINS_2D', 'BILIBILI_SDK_BASE_ROOT',
        'LEGACY_HTML5_SDK_ROOT', 'COMBINED_SDK_ROOT'].map(key => [key, process.env[key]]));
    const missing = Object.keys(environment).filter(key => !environment[key]);
    assert.equal(missing.length, 0, `Missing reproducibility inputs: ${missing.join(', ')}`);
    for (const [key, value] of Object.entries(environment)) {
        assert.ok(path.isAbsolute(value) && path.resolve(value) === value, `Expected a canonical absolute input: ${key}`);
    }
    const root = await mkdtemp(path.join(tmpdir(), `cocos4-repro-node${process.versions.node.split('.')[0]}-`));
    t.diagnostic(`Retained private evidence: ${root}`);
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
    await symlink(path.join(devkit, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    for (const directory of ['scripts', 'runtime']) await mkdir(path.join(root, directory));
    for (const file of ['scripts/prepare-sdk.mjs', 'runtime/builtins.cjs']) await symlink(path.join(devkit, file), path.join(root, file));
    // Copy the entry, not a symlink: its relative imports must resolve to this
    // private build on both Node lanes, with no process-wide resolution hooks.
    await cp(path.join(devkit, 'scripts/prepare-game-sdk.mjs'), path.join(root, 'scripts/prepare-game-sdk.mjs'));
    await run(process.execPath, [path.join(devkit, 'node_modules/typescript/bin/tsc'), '--project', path.join(devkit, 'tsconfig.json'),
        '--outDir', path.join(root, 'build')], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const packager = pathToFileURL(path.join(root, 'scripts/prepare-game-sdk.mjs'));
    const privateSdk = path.join(root, 'build/src/sdk.js');
    await t.test('packager requires its private compiled SDK and cannot fall back to shared build/src', async () => {
        await rename(privateSdk, `${privateSdk}.withheld`);
        try {
            await assert.rejects(run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(packager.href)})`],
                { cwd: root, env: {}, timeout: 10000 }), error => {
                assert.equal(error.code, 1);
                assert.match(error.stderr, /ERR_MODULE_NOT_FOUND/);
                assert.ok(error.stderr.includes(privateSdk));
                return true;
            });
        } finally { await rename(`${privateSdk}.withheld`, privateSdk); }
    });
    const { browserReportSchema, browserSummarySchema, canonical, hash, loadSdk, parseJson, runtimeDescriptorSchema,
        summarizeBrowserReport, validateRuntime, validateRuntimeScripts } = await import(pathToFileURL(privateSdk));
    const { prepareGameSdk } = await import(packager);
    const json = bytes => parseJson(bytes.toString('utf8'));
    const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    const inputs = [];
    const sources = [];
    const remember = async file => {
        const bytes = await readFile(file);
        sources.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
        return bytes;
    };
    await remember(path.join(environment.BILIBILI_SDK_BASE_ROOT, 'manifest.json'));
    await cp(environment.BILIBILI_SDK_BASE_ROOT, path.join(root, 'base'), { recursive: true, errorOnExist: true, force: false });
    for (const profile of ['2d-basic', '3d-basic']) {
        const source = path.join(environment.GAME_SDK_RUNTIME_ROOT, profile);
        const runtime = path.join(root, 'inputs', profile);
        const browserReport = `${runtime}-browser/browser-report.json`;
        await mkdir(path.dirname(runtime), { recursive: true });
        await cp(source, runtime, { recursive: true, errorOnExist: true, force: false });
        await cp(`${source}-browser`, `${runtime}-browser`, { recursive: true, errorOnExist: true, force: false });
        const bytes = await remember(path.join(source, 'runtime.json'));
        const reportBytes = await remember(`${source}-browser/browser-report.json`);
        if (json(await remember(path.join(source, 'builtin-report.json'))).kind === 'cocos4-builtin-identity') {
            await cp(`${source}.evidence`, `${runtime}.evidence`, { recursive: true, errorOnExist: true, force: false });
            for (const file of ['receipt.json', 'builtin-result.json']) await remember(path.join(`${source}.evidence`, file));
        }
        const descriptor = runtimeDescriptorSchema.parse(json(bytes));
        const report = browserReportSchema.parse(json(reportBytes));
        for (const screenshot of report.screenshots) await remember(path.join(`${source}-browser`, screenshot.path));
        validateRuntime(descriptor, report, hash(bytes));
        await validateRuntimeScripts(descriptor, file => readFile(path.join(runtime, file)));
        inputs.push({ runtime, browserReport });
    }

    await t.test('builtin source/file gates precede path-independent identity; original bytes are retained', async () => {
        const source = environment.RUNTIME_BUILTINS_2D;
        const original = await remember(path.join(source, 'result.json'));
        const report = json(original);
        assert.equal(report.profile, '2d-basic');
        assert.deepEqual((await readBuiltins({ engine, profile: report.profile, builtinDirectory: source })).executionBytes, original);
        const results = [];
        for (const name of ['effects-a', 'effects-longer-root-b']) {
            const builtinDirectory = path.join(root, name);
            await cp(source, builtinDirectory, { recursive: true, errorOnExist: true, force: false });
            const changed = structuredClone(report);
            changed.preprocessor.path = `${builtinDirectory}/tools/glslangValidator`;
            changed.graphics.renderer = name;
            await save(path.join(builtinDirectory, 'result.json'), changed);
            const result = await readBuiltins({ engine, profile: report.profile, builtinDirectory });
            assert.deepEqual(result.executionBytes, await readFile(path.join(builtinDirectory, 'result.json')));
            const stable = json(result.reportBytes);
            assert.equal(stable.preprocessor.sha256, report.preprocessor.sha256);
            assert.equal(stable.preprocessor.version, report.preprocessor.version);
            for (const key of ['inputs', 'files', 'compiler', 'mappings', 'lockSha256', 'node', 'validation']) assert.deepEqual(stable[key], report[key]);
            assert.equal(stable.preprocessor.path, undefined);
            assert.equal(stable.graphics, undefined);
            await writeFile(path.join(builtinDirectory, 'identity.json'), result.reportBytes, { flag: 'wx' });
            results.push(result);
        }
        assert.deepEqual(results[0].reportBytes, results[1].reportBytes);
        assert.notEqual(hash(results[0].executionBytes), hash(results[1].executionBytes));
        for (const mutate of [value => { value.preprocessor.sha256 = '1'.repeat(64); },
            value => { value.preprocessor.version += 'different'; }, value => { value.compiler.revision = 'different'; },
            value => { value.mappings.sha256 = '2'.repeat(64); }]) {
            const changed = structuredClone(report); mutate(changed);
            assert.notEqual(hash(builtinIdentity(changed)), results[0].reportSha256);
        }
        const bad = path.join(root, 'effects-invalid');
        await cp(source, bad, { recursive: true });
        for (const [mutate, error] of [[value => { value.validation.compilerParser = false; }, /Builtin compilation not successful: compilerParser/],
            [value => { value.inputs[Object.keys(value.inputs)[0]] = '0'.repeat(64); }, /Builtin source inputs changed/],
            [value => { value.files[0].sha256 = '0'.repeat(64); }, /Builtin integrity mismatch/]]) {
            const changed = structuredClone(report); mutate(changed);
            await save(path.join(bad, 'result.json'), changed);
            await assert.rejects(readBuiltins({ engine, profile: report.profile, builtinDirectory: bad }), error);
        }
        await writeFile(path.join(bad, 'result.json'), original);
        const file = path.join(bad, report.files[0].path);
        const bytes = await readFile(file);
        const damaged = Buffer.from(bytes); damaged[0] ^= 1;
        await writeFile(file, damaged);
        await assert.rejects(readBuiltins({ engine, profile: report.profile, builtinDirectory: bad }), /Builtin integrity mismatch/);
        await writeFile(file, bytes);
        await rename(file, `${file}.withheld`);
        try {
            await assert.rejects(readBuiltins({ engine, profile: report.profile, builtinDirectory: bad }), { code: 'ENOENT' });
        } finally { await rename(`${file}.withheld`, file); }
        assert.throws(() => builtinIdentity({ ...report, unreviewedTool: 'new' }), /Unreviewed/);
    });

    await t.test('browser normalization keeps source/tool bindings and rejects bad raw evidence', async () => {
        const report = json(await readFile(inputs[0].browserReport));
        const read = file => readFile(path.join(path.dirname(inputs[0].browserReport), file));
        const summary = await summarizeBrowserReport(report, read);
        assert.equal(browserSummarySchema.safeParse(summary).success, true);
        assert.deepEqual(summary.tools, report.tools, 'Retain recorded tool hashes; never invent hashes for historical runs');
        const descriptorBytes = await readFile(path.join(inputs[0].runtime, 'runtime.json'));
        const descriptor = runtimeDescriptorSchema.parse(json(descriptorBytes));
        validateRuntime(descriptor, summary, hash(descriptorBytes));
        for (const mutate of [value => { value.success = false; }, value => { value.validation.webAudio = false; },
            value => { value.pageErrors.push('error'); }, value => { value.screenshots[0].sha256 = '0'.repeat(64); },
            value => { value.screenshots[0].width++; }, value => { value.screenshots[1].path = value.screenshots[0].path; }]) {
            const changed = structuredClone(report); mutate(changed);
            await assert.rejects(summarizeBrowserReport(changed, read));
        }
        assert.throws(() => parseJson('{"success":false,"success":true}'));
        const file = path.join(path.dirname(inputs[0].browserReport), report.screenshots[0].path);
        const bytes = await readFile(file);
        const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1;
        await writeFile(file, damaged);
        try {
            await assert.rejects(summarizeBrowserReport(report, read), /Invalid browser screenshot evidence/);
            const out = path.join(root, 'invalid-browser');
            await assert.rejects(prepareGameSdk({ base: path.join(root, 'base'), runtimes: inputs, out, engineRoot: engine }),
                /Invalid browser screenshot evidence/);
            for (const directory of [out, `${out}.evidence`]) await assert.rejects(lstat(directory), { code: 'ENOENT' });
        } finally { await writeFile(file, bytes); }
        const changed = structuredClone(summary); changed.runtimeSha256 = '0'.repeat(64);
        assert.throws(() => validateRuntime(descriptor, changed, hash(descriptorBytes)));
        if (summary.build) {
            const changed = structuredClone(summary); changed.build.engineSha256 = '0'.repeat(64);
            assert.throws(() => validateRuntime(descriptor, changed, hash(descriptorBytes)));
        }
        // Constructed tool identities test sensitivity only, not historical provenance.
        const fixture = { ...report, tools: { executableSha256: '1'.repeat(64), verifierSha256: '2'.repeat(64), playwright: 'fixture', node: process.version } };
        const first = await summarizeBrowserReport(fixture, read);
        fixture.tools.executableSha256 = '3'.repeat(64);
        assert.notEqual(hash(canonical(first)), hash(canonical(await summarizeBrowserReport(fixture, read))));
    });

    let sdkId;
    await t.test('private packaging has equal payloads and different complete receipts under controlled observations', async () => {
        const varied = [];
        const { PNG } = require('../../../node_modules/pngjs');
        for (const input of inputs) {
            const runtime = path.join(root, 'different-output-root', path.basename(input.runtime));
            await mkdir(path.dirname(runtime), { recursive: true });
            await cp(input.runtime, runtime, { recursive: true });
            await cp(path.dirname(input.browserReport), `${runtime}-browser`, { recursive: true });
            if (json(await readFile(path.join(input.runtime, 'builtin-report.json'))).kind === 'cocos4-builtin-identity') {
                await cp(`${input.runtime}.evidence`, `${runtime}.evidence`, { recursive: true });
            }
            const browserReport = `${runtime}-browser/browser-report.json`;
            const report = json(await readFile(browserReport));
            report.executablePath = `${root}/different-tools/chrome`;
            report.requests.reverse();
            for (const message of report.console) message.text = message.text.replace(/\d+\.\d+ ms/g, '999.99 ms').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:54321');
            report.graphics.renderer = 'controlled fixture renderer';
            report.initial.observationTime = 123;
            report.final.observationTime = 456;
            for (const audio of report.audio) audio.peak += 0.001;
            // Same decoded pixels, different valid PNG encoding. This is explicitly
            // a normalization fixture, NOT a new graphics run or clean release.
            for (const screenshot of report.screenshots) {
                const file = path.join(`${runtime}-browser`, screenshot.path);
                const original = await readFile(file);
                const image = PNG.sync.read(original);
                const bytes = PNG.sync.write(image, { deflateLevel: 0 });
                assert.notEqual(hash(bytes), hash(original));
                assert.deepEqual(PNG.sync.read(bytes).data, image.data);
                await writeFile(file, bytes);
                screenshot.sha256 = hash(bytes);
            }
            await save(browserReport, report);
            varied.push({ runtime, browserReport });
        }
        const outputs = [];
        for (const [name, runtimes] of [['pack-a', inputs], ['pack-longer-root-b', varied]]) {
            const result = await prepareGameSdk({ base: path.join(root, 'base'), runtimes, out: path.join(root, name), engineRoot: engine });
            assert.equal((await loadSdk(result.root)).sdkId, result.sdkId);
            const receipt = json(await readFile(path.join(result.evidence, 'receipt.json')));
            assert.equal(receipt.sdkId, result.sdkId);
            assert.equal(receipt.manifestSha256, hash(await readFile(path.join(result.root, 'manifest.json'))));
            for (const file of receipt.files) {
                const bytes = await readFile(path.join(result.evidence, file.path));
                assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
            }
            for (const input of runtimes) {
                const descriptor = json(await readFile(path.join(input.runtime, 'runtime.json')));
                const prefix = `engine/profiles/HTML5/${descriptor.profile}/${descriptor.variant}`;
                assert.deepEqual(await readFile(path.join(result.evidence, prefix, 'evidence/browser-report.json')), await readFile(input.browserReport));
                assert.deepEqual(await readFile(path.join(result.root, prefix, 'runtime.json')), await readFile(path.join(input.runtime, 'runtime.json')));
                if (json(await readFile(path.join(input.runtime, 'builtin-report.json'))).kind === 'cocos4-builtin-identity') {
                    for (const [source, retained] of [['builtin-result.json', 'builtin-result.json'], ['receipt.json', 'runtime-receipt.json']]) {
                        assert.deepEqual(await readFile(path.join(result.evidence, prefix, retained)), await readFile(path.join(`${input.runtime}.evidence`, source)));
                    }
                }
            }
            outputs.push(result);
        }
        sdkId = outputs[0].sdkId;
        assert.equal(outputs[1].sdkId, sdkId);
        assert.deepEqual(await readFile(path.join(outputs[0].root, 'manifest.json')), await readFile(path.join(outputs[1].root, 'manifest.json')));
        assert.notEqual(hash(await readFile(path.join(outputs[0].evidence, 'receipt.json'))), hash(await readFile(path.join(outputs[1].evidence, 'receipt.json'))));
        const original = await readFile(path.join(outputs[0].evidence, 'receipt.json'));
        await assert.rejects(prepareGameSdk({ base: path.join(root, 'base'), runtimes: inputs, out: outputs[0].root, engineRoot: engine }), /OUTPUT_CONFLICT/);
        assert.deepEqual(await readFile(path.join(outputs[0].evidence, 'receipt.json')), original);
        const conflict = path.join(root, 'receipt-conflict');
        await mkdir(`${conflict}.evidence`);
        await assert.rejects(prepareGameSdk({ base: path.join(root, 'base'), runtimes: inputs, out: conflict, engineRoot: engine }), /OUTPUT_CONFLICT/);
        await assert.rejects(lstat(conflict), { code: 'ENOENT' });
    });

    await t.test('persisted legacy SDK bytes still validate without migration', async () => {
        for (const [name, source] of [['legacy-game-sdk', environment.LEGACY_HTML5_SDK_ROOT], ['indexed-game-sdk', environment.COMBINED_SDK_ROOT]]) {
            const before = await remember(path.join(source, 'manifest.json'));
            assert.equal(Boolean(json(before).apiIndex), name === 'indexed-game-sdk', 'Exercise both pre-index and indexed SDK readers');
            const copy = path.join(root, name);
            await cp(source, copy, { recursive: true, errorOnExist: true, force: false });
            assert.equal((await loadSdk(copy)).sdkId, json(before).sdkId);
            assert.deepEqual(await readFile(path.join(copy, 'manifest.json')), before);
        }
    });
    for (const source of sources) assert.equal(sha256(await readFile(source.path)), source.sha256, `Retained source changed: ${source.path}`);
    assert.equal((await readdir(root)).some(name => name.startsWith('.cocos4-game-sdk-')), false);
    await save(path.join(root, 'regression-evidence.json'), { node: process.version, environment,
        scope: 'Retained-input normalization semantics only; no engine/graphics build or clean-release claim',
        sdkId, sources, sourceValidators: ['private TypeScript compile', 'runtime descriptors/build bindings', 'release script inventory', 'raw browser reports/PNG hashes', 'legacy SDK loading'],
        sourceFiles: await Promise.all(['runtime/builtins.cjs', 'runtime/verify-browser.cjs', 'scripts/build-runtime.cjs', 'scripts/prepare-game-sdk.mjs', 'src/sdk.ts', 'test/reproducibility.test.mjs']
            .map(async file => ({ path: file, sha256: hash(await readFile(path.join(devkit, file))) }))) });
});
