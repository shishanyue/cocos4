import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bilibiliBootstrapHashes, bilibiliReleaseBootstrapHashes, bilibiliReportSchema, bilibiliRuntimeDescriptorSchema, browserReportSchema, browserSummarySchema,
    canonical, hash, loadSdk, manifestSchema, runtimeDescriptorSchema, runtimeFileAllowed, runtimeValidationLevels,
    summarizeBrowserReport, validateBilibiliRuntime, validateRuntime } from '../build/src/sdk.js';
import { prepareGameSdk } from '../scripts/prepare-game-sdk.mjs';

const run = promisify(execFile);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(devkit, 'runtime/build');
const base = process.env.BILIBILI_SDK_BASE_ROOT ?? path.join(devkit, 'build/readonly-sdk');
function runtimeInput({ target, id, variant }) {
    const bilibili = target === 'BILIBILI';
    if (variant === 'release') assert(process.env.RELEASE_RUNTIME_ROOT, 'Set RELEASE_RUNTIME_ROOT for a supplied release SDK.');
    const runtime = variant === 'release' ? path.join(process.env.RELEASE_RUNTIME_ROOT, target, id)
        : bilibili ? process.env[id === '2d-basic' ? 'BILIBILI_SDK_2D_RUNTIME' : 'BILIBILI_SDK_3D_RUNTIME']
            ?? path.join(artifacts, `bilibili-final-${id.slice(0, 2)}-20260918`)
            : path.join(process.env.GAME_SDK_RUNTIME_ROOT ?? path.join(artifacts, 'acceptance-Js6TDR'), id);
    return { runtime, ...(bilibili ? { localReport: variant === 'release' && process.env.RELEASE_LOCAL_REPORT_ROOT
        ? path.join(process.env.RELEASE_LOCAL_REPORT_ROOT, `${id}-local/local-report.json`)
        : path.join(`${runtime}-local`, 'local-report.json') } : { browserReport: path.join(`${runtime}-browser`, 'browser-report.json') }) };
}
let inputs = ['HTML5', 'BILIBILI'].flatMap(target => ['2d-basic', '3d-basic'].map(id => runtimeInput({ target, id, variant: 'debug' })));
const incomplete = error => error?.code === 'SDK_INCOMPLETE';
const profileKey = ({ target, profile, variant }) => `${target}/${profile}/${variant}`;
let temporary, prepared, sdk, index, unavailable;
before(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'cocos4-bilibili-sdk-'));
    prepared = process.env.COMBINED_SDK_ROOT ?? path.join(temporary, 'prepared');
    if (process.env.COMBINED_SDK_ROOT) {
        sdk = await loadSdk(prepared);
        inputs = ['debug', 'release'].flatMap(variant => ['HTML5', 'BILIBILI'].flatMap(target => ['2d-basic', '3d-basic']
            .filter(id => sdk.manifest.catalog.profiles.some(entry => entry.target === target && entry.id === id && entry.variant === variant))
            .map(id => runtimeInput({ target, id, variant }))));
    }
    try { for (const input of inputs) await lstat(path.join(input.runtime, 'runtime.json')); }
    catch (error) {
        if (error.code !== 'ENOENT' || process.env.GAME_SDK_INTEGRATION === '1' || process.env.COMBINED_SDK_ROOT
            || process.env.GAME_SDK_RUNTIME_ROOT || process.env.BILIBILI_SDK_2D_RUNTIME || process.env.BILIBILI_SDK_3D_RUNTIME) throw error;
        unavailable = 'Genuine HTML5 and BILIBILI runtime inputs are required.';
        return;
    }
    if (!sdk) {
        await prepareGameSdk({ base, runtimes: inputs, out: prepared });
        sdk = await loadSdk(prepared);
    }
    index = JSON.parse(await readFile(path.join(prepared, sdk.manifest.apiIndex.path)));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

async function manifestWrite(directory, manifest) {
    delete manifest.sdkId;
    manifest.sdkId = `sha256-${hash(canonical(manifest))}`;
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
}
async function copy(name) {
    const directory = path.join(temporary, name);
    await cp(prepared, directory, { recursive: true });
    return directory;
}

test('mixed target profiles preserve real descriptors, mandatory HTML5 browser evidence and distinct BILIBILI local gates', async t => {
    if (unavailable) return t.skip(unavailable);
    manifestSchema.parse(sdk.manifest);
    assert.equal(sdk.manifest.catalog.profiles.length, inputs.length);
    assert.equal(sdk.manifest.catalog.templates.length, inputs.length);
    assert.equal(JSON.parse(await readFile(path.join(prepared, 'toolchain/compiler-dependencies.json'))).packages.length, 84);
    let examples = 0;
    for (const input of inputs) {
        const original = await readFile(path.join(input.runtime, 'runtime.json'));
        const descriptor = runtimeDescriptorSchema.parse(JSON.parse(original));
        const profile = sdk.profile(descriptor.target, descriptor.profile, descriptor.variant);
        const entry = sdk.manifest.catalog.profiles.find(item => item.target === descriptor.target && item.id === descriptor.profile
            && item.variant === descriptor.variant);
        assert.deepEqual(await readFile(path.join(profile.directory, 'runtime.json')), original);
        assert.equal(profile.target, descriptor.target);
        assert.equal(profile.variant, descriptor.variant);
        assert.equal(profile.engineEntry, descriptor.engineEntry);
        assert.equal(profile.entry, descriptor.entry);
        assert.deepEqual(entry.validationLevels, runtimeValidationLevels[entry.target]);
        const bilibili = entry.target === 'BILIBILI';
        const report = bilibili ? entry.localReport : entry.browserReport;
        assert.equal(bilibili ? entry.browserReport : entry.localReport, undefined);
        const delivered = await readFile(path.join(prepared, report));
        const rawBytes = await readFile(bilibili ? input.localReport : input.browserReport);
        if (!bilibili && JSON.parse(delivered).kind === 'cocos4-browser-validation-summary') {
            const summary = browserSummarySchema.parse(JSON.parse(delivered));
            validateRuntime(descriptor, summary, hash(original));
            assert.deepEqual(delivered, Buffer.from(`${JSON.stringify(await summarizeBrowserReport(JSON.parse(rawBytes),
                file => readFile(path.join(path.dirname(input.browserReport), file))), null, 2)}\n`));
            const evidence = `${prepared}.evidence`;
            const receipt = JSON.parse(await readFile(path.join(evidence, 'receipt.json')));
            assert.equal(receipt.kind, 'cocos4-sdk-execution-receipt');
            assert.equal(receipt.schemaVersion, 1);
            assert.equal(receipt.sdkId, sdk.sdkId);
            assert.equal(receipt.manifestSha256, hash(await readFile(path.join(prepared, 'manifest.json'))));
            assert.deepEqual(receipt.files.find(file => file.path === report), { path: report, bytes: rawBytes.length, sha256: hash(rawBytes) });
            assert.deepEqual(await readFile(path.join(evidence, report)), rawBytes);
            for (const screenshot of JSON.parse(rawBytes).screenshots) {
                const relative = `${entry.directory}/evidence/${screenshot.path}`;
                const bytes = await readFile(path.join(path.dirname(input.browserReport), screenshot.path));
                assert.deepEqual(await readFile(path.join(evidence, relative)), bytes);
                assert.deepEqual(receipt.files.find(file => file.path === relative), { path: relative, bytes: bytes.length, sha256: hash(bytes) });
                assert(!sdk.manifest.files.some(file => file.path === relative));
            }
        } else {
            assert(bilibili || process.env.COMBINED_SDK_ROOT, 'Freshly prepared HTML5 evidence must be a summary');
            assert.deepEqual(delivered, rawBytes, 'Persisted raw browser reports and BILIBILI local reports stay byte-exact');
        }
        const template = sdk.template(`${bilibili ? 'bilibili-' : ''}${entry.id}${entry.variant === 'release' ? '-release' : ''}-starter`);
        assert.equal(template.target, entry.target);
        assert.equal(template.variant, entry.variant);
        assert.equal(template.directory, path.join(profile.directory, descriptor.template));
        examples += descriptor.files.filter(file => file.path.startsWith(`${descriptor.template}/`)
            && /\.(?:ts|js)$/.test(file.path) && !file.path.endsWith('.d.ts') && file.bytes).length;
        assert.equal(profile.ccExports.includes('MeshRenderer'), entry.id === '3d-basic');
        assert(profile.ccExports.includes('Node'));
        if (bilibili) {
            const local = bilibiliReportSchema.parse(JSON.parse(await readFile(path.join(prepared, report))));
            validateBilibiliRuntime(descriptor, local, hash(original), original.length);
            assert.equal(local.validationLevels.vendorBuild, false);
            assert.equal(local.validationLevels.device, false);
            assert.equal(browserReportSchema.safeParse(local).success, false);
            for (const [name, digest] of Object.entries(entry.variant === 'release' ? bilibiliReleaseBootstrapHashes : bilibiliBootstrapHashes)) {
                assert.equal(hash(await readFile(path.join(profile.directory, name))), digest);
            }
            assert(!entry.validationLevels.some(level => /browser|vendor|device/i.test(level)));
        }
    }
    assert.equal(sdk.manifest.apiIndex.examples, examples);
    assert.equal(index.entries.filter(entry => entry.kind === 'example').length, examples);
    for (const target of ['HTML5', 'BILIBILI']) {
        const profiles = sdk.manifest.catalog.profiles.filter(profile => profile.target === target);
        assert(profiles.length);
        assert.deepEqual(sdk.catalog({ section: 'profiles', target }).items, profiles);
        for (const variant of new Set(profiles.map(profile => profile.variant))) {
            assert.deepEqual(profiles.filter(profile => profile.variant === variant).map(profile => profile.id).sort(), ['2d-basic', '3d-basic']);
        }
        assert.equal(sdk.catalog({ section: 'platforms', target }).items[0].exportAvailable, true);
        assert.match(sdk.catalog({ section: 'profiles', target }).reason, /source-game-package assembly/);
    }
    assert.equal(sdk.catalog({ section: 'platforms', target: 'WECHAT' }).items[0].exportAvailable, false);
    assert(runtimeFileAllowed('cocos-js/cc.js', 'BILIBILI'));
    for (const name of ['engine/cc.js', 'index.html', 'cocos-js/fake.js', 'assets/game/unlisted.png', 'template/src/injected.ts', '../game.js']) {
        assert.equal(runtimeFileAllowed(name, 'BILIBILI'), false, name);
    }
});

test('target schemas and local evidence reject forged flags, missing gates, foreign reports and false browser/vendor claims', async t => {
    if (unavailable) return t.skip(unavailable);
    const bytes = await readFile(path.join(inputs[2].runtime, 'runtime.json'));
    const original = JSON.parse(bytes);
    const evidence = JSON.parse(await readFile(inputs[2].localReport));
    for (const change of [
        descriptor => { descriptor.target = 'HTML5'; },
        descriptor => { descriptor.kind = 'cocos4-html5-runtime'; },
        descriptor => { descriptor.engineEntry = './engine/cc.js'; },
        descriptor => { descriptor.entry = 'index.html'; },
        descriptor => { descriptor.tools.loaderPlatform = 'web-desktop'; },
        ...['HTML5', 'WECHAT', 'NATIVE', 'JSB', 'NODEJS', 'RUNTIME_BASED'].map(key => descriptor => { descriptor.constants[key] = true; }),
        ...['BILIBILI', 'MINIGAME', 'BUILD'].map(key => descriptor => { descriptor.constants[key] = false; }),
        descriptor => { descriptor.constants.DEBUG = !descriptor.constants.DEBUG; },
        descriptor => { descriptor.constants.USE_3D = true; },
        descriptor => { descriptor.validationLevels.browserFirstFrame = true; },
        descriptor => { descriptor.validationLevels.device = true; },
        descriptor => { descriptor.features.push('3d'); },
        descriptor => { descriptor.files.push({ path: 'assets/game/unlisted.png', bytes: 1, sha256: '0'.repeat(64) }); },
        descriptor => { descriptor.files.find(file => file.path === 'loader.js').sha256 = '0'.repeat(64); },
    ]) {
        const descriptor = structuredClone(original);
        change(descriptor);
        assert.throws(() => validateBilibiliRuntime(descriptor, evidence, hash(bytes), bytes.length));
    }
    for (const change of [
        report => { report.kind = 'cocos4-html5-runtime'; },
        report => { report.profile = '3d-basic'; },
        report => { report.runtimeSha256 = '0'.repeat(64); },
        ...Object.keys(evidence.checks).map(key => report => { report.checks[key] = false; }),
        report => { report.validationLevels.vendorBuild = true; },
        report => { report.validationLevels.browserFirstFrame = true; },
        report => { report.notes[2] = 'Real engine and devices were tested'; },
        report => { report.evidence.shared.probe.world3d = true; },
        report => { report.evidence.distinct.loaded.pop(); },
        report => { report.evidence.failures[0] = report.evidence.failures[1]; },
        report => { report.evidence.closure.moduleEdges[0].to = 'engine/cc.js'; },
        report => { report.evidence.preflight.totalBytes++; },
    ]) {
        const report = structuredClone(evidence);
        change(report);
        assert.throws(() => validateBilibiliRuntime(original, report, hash(bytes), bytes.length));
    }
    assert.equal(bilibiliRuntimeDescriptorSchema.safeParse(JSON.parse(await readFile(path.join(inputs[0].runtime, 'runtime.json')))).success, false);
});

test('partial or cross-target SDK manifests and report substitutions fail even with a new SDK hash', async t => {
    if (unavailable) return t.skip(unavailable);
    const directory = await copy('manifest-tamper');
    const original = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
    const bili = original.catalog.profiles.find(profile => profile.target === 'BILIBILI');
    for (const change of [
        manifest => { manifest.catalog.profiles = manifest.catalog.profiles.filter(profile => !(profile.target === 'BILIBILI' && profile.id === '3d-basic' && profile.variant === bili.variant)); },
        manifest => { manifest.catalog.profiles = manifest.catalog.profiles.filter(profile => !(profile.target === 'HTML5' && profile.id === '3d-basic' && profile.variant === bili.variant)); },
        manifest => { manifest.catalog.profiles[0].target = 'HTML5'; },
        manifest => { manifest.catalog.profiles[0].localReport = manifest.catalog.profiles.find(profile => profile.target === 'HTML5').browserReport; },
        manifest => { manifest.catalog.profiles[0].validationLevels.push('browserFirstFrame'); },
        manifest => { manifest.catalog.templates.find(template => template.target === 'BILIBILI').directory = manifest.catalog.templates.find(template => template.target === 'HTML5').directory; },
        manifest => { manifest.catalog.platforms.find(platform => platform.id === 'BILIBILI').validationLevels.push('vendorBuild'); },
        manifest => { delete manifest.apiIndex; },
    ]) {
        const manifest = structuredClone(original);
        change(manifest);
        await manifestWrite(directory, manifest);
        await assert.rejects(loadSdk(directory), incomplete);
    }
    const foreign = await readFile(inputs[0].browserReport);
    await writeFile(path.join(directory, bili.localReport), foreign);
    const manifest = structuredClone(original);
    Object.assign(manifest.files.find(file => file.path === bili.localReport), { bytes: foreign.length, sha256: hash(foreign) });
    await manifestWrite(directory, manifest);
    await assert.rejects(loadSdk(directory), incomplete);
});

test('rehashed no-op bootstrap and hidden files cannot pass source pins or exact payload closure', async t => {
    if (unavailable) return t.skip(unavailable);
    const directory = await copy('payload-tamper');
    const original = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
    const profile = original.catalog.profiles.find(profile => profile.target === 'BILIBILI');
    const descriptorBytes = await readFile(path.join(directory, profile.descriptor));
    const reportBytes = await readFile(path.join(directory, profile.localReport));
    for (const relative of ['game.js', 'loader.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js', 'assets/game/hidden.js']) {
        const filePath = `${profile.directory}/${relative}`;
        const previous = original.files.some(file => file.path === filePath) ? await readFile(path.join(directory, filePath)) : null;
        const bytes = Buffer.from('/* replaced source */');
        await writeFile(path.join(directory, filePath), bytes);
        const descriptor = JSON.parse(descriptorBytes);
        const manifest = structuredClone(original);
        const info = { path: relative, bytes: bytes.length, sha256: hash(bytes) };
        if (previous) Object.assign(descriptor.files.find(file => file.path === relative), info);
        else descriptor.files.push(info);
        const packed = { ...info, path: filePath };
        if (previous) Object.assign(manifest.files.find(file => file.path === filePath), packed);
        else manifest.files.push(packed);
        const updatedDescriptor = Buffer.from(JSON.stringify(descriptor));
        await writeFile(path.join(directory, profile.descriptor), updatedDescriptor);
        Object.assign(manifest.files.find(file => file.path === profile.descriptor), { bytes: updatedDescriptor.length, sha256: hash(updatedDescriptor) });
        const report = JSON.parse(reportBytes);
        report.runtimeSha256 = hash(updatedDescriptor);
        const total = descriptor.files.reduce((sum, file) => sum + file.bytes, updatedDescriptor.length);
        report.evidence.preflight.totalBytes = total;
        report.evidence.preflight.packages[0].bytes = total;
        const updatedReport = Buffer.from(JSON.stringify(report));
        await writeFile(path.join(directory, profile.localReport), updatedReport);
        Object.assign(manifest.files.find(file => file.path === profile.localReport), { bytes: updatedReport.length, sha256: hash(updatedReport) });
        await manifestWrite(directory, manifest);
        await assert.rejects(loadSdk(directory), incomplete);
        if (previous) await writeFile(path.join(directory, filePath), previous);
        else await rm(path.join(directory, filePath));
    }
});

test('API indexing parses every actual declaration byte set and all target/variant-specific engine paths', async t => {
    if (unavailable) return t.skip(unavailable);
    const bindings = sdk.manifest.catalog.profiles.map(entry => ({ target: entry.target, profile: entry.id, variant: entry.variant,
        declaration: sdk.manifest.files.find(file => file.path === `${entry.directory}/types/cc.d.ts`),
        exports: sdk.manifest.files.find(file => file.path === entry.exports),
        engine: sdk.manifest.files.find(file => file.path === `${entry.directory}/${sdk.profile(entry.target, entry.id, entry.variant).engineEntry.slice(2)}`) }));
    assert.deepEqual(index.profiles.map(canonical).sort(), bindings.map(canonical).sort());
    const declarations = [...new Set(bindings.map(binding => binding.declaration.sha256))].sort();
    for (const binding of index.profiles) {
        const profile = sdk.profile(binding.target, binding.profile, binding.variant);
        assert.equal(binding.engine.path, `engine/profiles/${binding.target}/${binding.profile}/${binding.variant}/${profile.engineEntry.slice(2)}`);
        for (const file of [binding.declaration, binding.engine, binding.exports]) {
            assert.equal(hash(await readFile(path.join(prepared, file.path))), file.sha256);
        }
    }
    const node = sdk.search({ query: 'cc.Node.setPosition', kind: 'api' }).items.find(item => item.title === 'cc.Node.setPosition');
    assert.deepEqual(node.api.declarationHashes?.slice().sort(), declarations.length > 1 ? declarations : undefined);
    assert.deepEqual(node.runtimeAvailability.map(profileKey).sort(), bindings.map(profileKey).sort());
    assert(node.runtimeAvailability.every(item => item.status === 'export-present'));
    const mesh = sdk.search({ query: 'cc.MeshRenderer', kind: 'api', limit: 100 }).items.find(item => item.title === 'cc.MeshRenderer');
    assert.deepEqual(mesh.runtimeAvailability.map(profileKey).sort(), bindings.map(profileKey).sort());
    assert(mesh.runtimeAvailability.every(item => item.status === (item.profile === '2d-basic' ? 'export-absent' : 'export-present')));
    const byName = new Map();
    for (const entry of index.entries.filter(entry => entry.kind === 'api' && entry.api.declarationHashes?.length === 1)) {
        const list = byName.get(entry.title) ?? [];
        list.push(entry); byName.set(entry.title, list);
    }
    const variants = [...byName.values()].filter(entries => entries.length > 1);
    assert.deepEqual(variants.map(entries => entries[0].title).sort(), declarations.length > 1 ? [
        'cc.dragonBones.Animation.fadeIn', 'cc.dragonBones.Animation.gotoAndPlay', 'cc.dragonBones.AnimationConfig.fadeOutMode',
    ] : [], 'Keep the three genuine tfig private-name spelling differences');
    for (const entries of variants) {
        assert.equal(entries.length, declarations.length);
        assert.equal(new Set(entries.map(entry => entry.id)).size, declarations.length);
        assert.equal(new Set(entries.map(entry => entry.sha256)).size, declarations.length);
        assert.deepEqual(entries.flatMap(entry => entry.api.declarationHashes).sort(), declarations);
        for (const entry of entries) {
            assert.equal(entry.api.declarationHashes.length, 1);
            const document = sdk.read({ documentId: entry.id });
            assert.deepEqual(document.runtimeAvailability.map(profileKey).sort(), bindings
                .filter(binding => entry.api.declarationHashes.includes(binding.declaration.sha256)).map(profileKey).sort());
            for (const anchor of document.anchors) {
                const bytes = await readFile(path.join(prepared, anchor.source.path));
                assert.equal(hash(bytes), anchor.source.sha256);
            }
        }
    }
    const examples = sdk.search({ query: 'MeshRenderer', kind: 'example', profile: '3d-basic' }).items;
    assert.deepEqual([...new Set(examples.map(item => profileKey(item.example)))].sort(), bindings
        .filter(binding => binding.profile === '3d-basic').map(profileKey).sort());
    assert.equal(sdk.resources().length, sdk.manifest.docs.length + 1);
});

test('omitted declaration variants or forged index/profile linkage fail after rehashing', async t => {
    if (unavailable) return t.skip(unavailable);
    const directory = await copy('index-tamper');
    const original = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
    for (const change of [
        value => { value.profiles[0].engine.path = value.profiles.find(profile => profile.target === 'HTML5').engine.path; },
        value => {
            const entry = value.entries.find(entry => entry.api?.qualifiedName === 'cc.dragonBones.Animation.fadeIn');
            const hashes = entry.api.declarationHashes ?? [entry.parts[0].source.sha256];
            const foreign = value.profiles.find(profile => !hashes.includes(profile.declaration.sha256));
            entry.api.declarationHashes = [...hashes, foreign?.declaration.sha256 ?? hashes[0]];
        },
        value => { value.entries.splice(value.entries.findIndex(entry => entry.api?.qualifiedName === 'cc.dragonBones.Animation.fadeIn'), 1); },
        value => { value.profiles.pop(); },
    ]) {
        const value = structuredClone(index);
        change(value);
        const bytes = Buffer.from(JSON.stringify(value));
        await writeFile(path.join(directory, original.apiIndex.path), bytes);
        const manifest = structuredClone(original);
        const update = { bytes: bytes.length, sha256: hash(bytes) };
        Object.assign(manifest.files.find(file => file.path === manifest.apiIndex.path), update);
        Object.assign(manifest.apiIndex, update, { symbols: value.entries.filter(entry => entry.kind === 'api').length });
        await manifestWrite(directory, manifest);
        await assert.rejects(loadSdk(directory), incomplete);
    }
});

test('preparer rejects partial pairs and mismatched report kinds; mixed CLI reports are target-ordered and reproducible', async t => {
    if (unavailable) return t.skip(unavailable);
    for (const runtimes of [inputs.slice(0, 3), inputs.slice(2, 4), [inputs[0], inputs[2], inputs[3]]]) {
        await assert.rejects(prepareGameSdk({ base, runtimes, out: path.join(temporary, 'partial') }), /Both real .* profiles/);
    }
    await assert.rejects(prepareGameSdk({ base, runtimes: [inputs[0], inputs[1], { ...inputs[2], browserReport: inputs[0].browserReport }, inputs[3]],
        out: path.join(temporary, 'wrong-report') }), /Report kind/);
    // A retained SDK may contain an older compiler. Reproducibility compares two
    // fresh generations of the same current source/runtime/report inputs instead.
    const reference = path.join(temporary, 'reference');
    const repeated = await prepareGameSdk({ base, runtimes: inputs, out: reference });
    const manifestBytes = await readFile(path.join(reference, 'manifest.json'));
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes));
    assert.equal(repeated.sdkId, manifest.sdkId);
    assert.deepEqual(await readFile(path.join(reference, manifest.development.baseManifest)), await readFile(path.join(base, 'manifest.json')));
    for (const file of manifest.development.sourceFiles) {
        const source = await readFile(path.resolve(devkit, '../..', file.sourcePath));
        assert.equal(file.sha256, hash(source));
        assert.equal(file.bytes, source.length);
        assert.deepEqual(await readFile(path.join(reference, file.path)), source);
        const saved = sdk.manifest.development.sourceFiles.find(item => item.path === file.path);
        if (saved.sha256 !== file.sha256) t.diagnostic(`${file.sourcePath}: retained ${saved.sha256}; fresh ${file.sha256}`);
    }
    const output = path.join(temporary, 'cli');
    const ordered = [inputs[2], inputs[0], inputs[3], inputs[1], ...inputs.slice(4)];
    const result = await run(process.execPath, [path.join(devkit, 'scripts/prepare-game-sdk.mjs'), '--base', base,
        ...ordered.flatMap(input => ['--runtime', input.runtime]),
        ...ordered.filter(input => input.browserReport).flatMap(input => ['--browser-report', input.browserReport]),
        ...ordered.filter(input => input.localReport).flatMap(input => ['--local-report', input.localReport]), '--out', output],
    { cwd: temporary, env: { PATH: '', HOME: temporary, LANG: 'C', NODE_OPTIONS: '' }, timeout: 180000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(result.stdout), { ...repeated, root: output, evidence: `${output}.evidence` });
    assert.deepEqual(await readFile(path.join(output, 'manifest.json')), manifestBytes);
    const referenceReceipt = JSON.parse(await readFile(path.join(repeated.evidence, 'receipt.json')));
    const cliReceipt = JSON.parse(await readFile(path.join(`${output}.evidence`, 'receipt.json')));
    assert.equal(referenceReceipt.sdkId, repeated.sdkId);
    assert.equal(cliReceipt.sdkId, repeated.sdkId);
    assert.equal(referenceReceipt.manifestSha256, hash(manifestBytes));
    assert.equal(cliReceipt.manifestSha256, hash(manifestBytes));
    assert.deepEqual(cliReceipt.files, referenceReceipt.files, 'Input ordering does not change retained report/PNG bytes');
    for (const file of manifest.development.sourceFiles) {
        assert.deepEqual(await readFile(path.join(output, file.path)), await readFile(path.join(reference, file.path)));
    }
    await assert.rejects(prepareGameSdk({ base, runtimes: inputs, out: output }), /OUTPUT_CONFLICT/);
    assert.deepEqual(await readFile(path.join(output, 'manifest.json')), manifestBytes);
    t.diagnostic(`Fresh same-input SDK: ${repeated.sdkId}; ${repeated.profiles.length} profiles; retained SDK: ${sdk.sdkId}`);
});

test('relocated read-only combined SDK and its index need no checkout or ambient compiler', async t => {
    if (unavailable) return t.skip(unavailable);
    const isolated = path.join(temporary, 'isolated');
    const data = path.join(isolated, 'data');
    await cp(prepared, data, { recursive: true });
    const tool = path.join(isolated, 'tool');
    await mkdir(path.join(tool, 'node_modules'), { recursive: true });
    for (const name of ['sdk.js', 'api-index.js', 'contracts.js']) await cp(path.join(devkit, 'build/src', name), path.join(tool, name));
    await cp(path.join(devkit, 'node_modules/zod'), path.join(tool, 'node_modules/zod'), { recursive: true });
    await writeFile(path.join(tool, 'package.json'), '{"type":"module"}');
    const paths = [];
    async function walk(directory) {
        for (const name of await readdir(directory)) {
            const file = path.join(directory, name);
            if ((await lstat(file)).isDirectory()) await walk(file);
            paths.push(file);
        }
    }
    await walk(data);
    try {
        for (const file of paths) await chmod(file, (await lstat(file)).isDirectory() ? 0o555 : 0o444);
        await chmod(data, 0o555);
        const { stdout } = await run(process.execPath, ['--max-old-space-size=512', '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { loadSdk } from './tool/sdk.js';
            const sdk = await loadSdk(process.cwd() + '/data');
            for (const entry of sdk.manifest.catalog.profiles.filter(entry => entry.target === 'BILIBILI')) {
                const profile = sdk.profile(entry.target, entry.id, entry.variant);
                assert.equal(profile.entry, 'game.js');
                assert.equal(profile.descriptor.engineEntry, './cocos-js/cc.js');
            }
            const node = sdk.search({query:'cc.Node.setPosition',kind:'api'}).items.find(item=>item.title==='cc.Node.setPosition');
            assert.deepEqual(node.runtimeAvailability.map(item => [item.target, item.profile, item.variant].join('/')).sort(),
                sdk.manifest.catalog.profiles.map(item => [item.target, item.id, item.variant].join('/')).sort());
            assert(sdk.read({documentId:node.documentId}).anchors.length);
            console.log(sdk.sdkId);
        `], { cwd: isolated, env: { PATH: '', HOME: isolated, NODE_OPTIONS: '', LANG: 'C' }, timeout: 120000 });
        assert.equal(stdout.trim(), sdk.sdkId);
    } finally {
        await chmod(data, 0o755);
        for (const file of paths.reverse()) await chmod(file, (await lstat(file)).isDirectory() ? 0o755 : 0o644);
    }
});
