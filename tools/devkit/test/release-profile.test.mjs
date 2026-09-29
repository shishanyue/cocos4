import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { extractRuntimeExports } from '../build/src/api-index.js';
import { bilibiliReportSchema, browserReportSchema, canonical, hash, loadSdk, manifestSchema,
    runtimeDescriptorSchema, validateBilibiliRuntime, validateRuntime, validateRuntimeScripts } from '../build/src/sdk.js';
import { prepareGameSdk } from '../scripts/prepare-game-sdk.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { buildRuntime } = require('../scripts/build-runtime.cjs');
const { compileGame } = require('../runtime/compile-game.cjs');
const devkit = fileURLToPath(new URL('../', import.meta.url));
const debugSdkInput = process.env.GAME_OPERATION_SDK_ROOT ?? process.env.COMBINED_SDK_ROOT ?? process.env.RELEASE_GAME_SDK_ROOT;
const debugRoot = debugSdkInput ?? path.join(devkit, 'build/game-sdk-isolated');
const releaseRoot = process.env.RELEASE_RUNTIME_ROOT;
const releaseLocalReport = profile => path.join(process.env.RELEASE_LOCAL_REPORT_ROOT ?? path.join(releaseRoot, 'BILIBILI'),
    `${profile}-local`, 'local-report.json');

async function temporary(t) {
    const directory = await mkdtemp(path.join(devkit, 'build/release-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('variant selection rejects invalid values before filesystem access or engine work', async () => {
    for (const variant of ['', 'Release', null, true, 'native']) {
        await assert.rejects(buildRuntime({ profile: '2d-basic', target: 'HTML5', variant }), /VARIANT_NOT_AVAILABLE/);
        await assert.rejects(compileGame({ projectDirectory: '/absent', typesDirectory: '/absent', checkOnly: true, variant }),
            error => error.code === 'UNSUPPORTED_PROJECT' && /Invalid compileGame options/.test(error.message));
    }
});

test('export indexing follows the actual SystemJS callback binding, including minified and shadowed identifiers', () => {
    const globals = { CC_DEBUG: false, CC_BUILD: true };
    const source = 'System.register([],function(e){return{execute:function(){'
        + 'g("CC_DEBUG",!1);g("CC_BUILD",!0);e("Node",class{});e({MeshRenderer:class{}});'
        + 'function shadow(e){e("NotAnExport",0)}function exports(x){return x}exports("NotTheCallback");}}});';
    assert.deepEqual(extractRuntimeExports(ts, source, globals), ['MeshRenderer', 'Node']);
    for (const changed of [source.replace('"CC_DEBUG",!1', '"CC_DEBUG",!0'), source.replace('g("CC_DEBUG",!1);', ''),
        source.replace('e("Node",class{})', 'e(computedName,class{})'), `${source}${source}`]) {
        assert.throws(() => extractRuntimeExports(ts, changed, globals), /Invalid declaration API index/);
    }
});

test('release script inventory rejects embedded maps, raw engine TypeScript and stale hashes', async () => {
    for (const [file, source] of [['engine/cc.js', '//# sourceMappingURL=data:application/json;base64,e30='],
        ['game/main.js', 'const map={"sourcesContent":["private source"]};'], ['engine/source.ts', 'const privateSource = 1;'],
        ['engine/cc.js.map', '{}']]) {
        const bytes = Buffer.from(source);
        await assert.rejects(validateRuntimeScripts({ variant: 'release', files: [{ path: file, bytes: bytes.length, sha256: hash(bytes) }] },
            async () => bytes), error => error.code === 'SDK_INCOMPLETE');
    }
    const bytes = Buffer.from('System.register([],function(e){return{execute:function(){e("value",1)}}});');
    await validateRuntimeScripts({ variant: 'release', files: [{ path: 'game/main.js', bytes: bytes.length, sha256: hash(bytes) }] }, async () => bytes);
    await assert.rejects(validateRuntimeScripts({ variant: 'release', files: [{ path: 'game/main.js', bytes: bytes.length, sha256: '0'.repeat(64) }] },
        async () => bytes), error => error.code === 'SDK_INCOMPLETE');
});

test('saved debug SDKs still load without migration or release aliases', { timeout: 180000 }, async t => {
    // CURRENT SDKs may include release profiles; compatibility inputs must stay separate.
    const legacy = process.env.LEGACY_HTML5_SDK_ROOT;
    for (const root of legacy === undefined ? [path.join(devkit, 'build/game-sdk-isolated'), path.join(devkit, 'build/legacy-game-sdk')] : [legacy]) {
        try { await lstat(root); } catch (error) {
            if (error.code !== 'ENOENT' || legacy !== undefined) throw error;
            t.diagnostic(`Saved fixture absent: ${root}`); continue;
        }
        const before = await readFile(path.join(root, 'manifest.json'));
        const sdk = await loadSdk(root);
        assert.deepEqual(await readFile(path.join(root, 'manifest.json')), before);
        for (const entry of sdk.manifest.catalog.profiles) {
            const profile = sdk.profile(entry.target, entry.id, 'debug');
            assert.equal(profile.constants.DEBUG, true);
            assert.equal(profile.compressed, false);
            assert(profile.ccExports.includes('Node'));
            assert.equal(profile.ccExports.includes('MeshRenderer'), entry.id === '3d-basic');
            assert.throws(() => sdk.profile(entry.target, entry.id, 'release'), error => error.code === 'PROFILE_NOT_AVAILABLE');
            const template = sdk.template(`${entry.target === 'BILIBILI' ? 'bilibili-' : ''}${entry.id}-starter`);
            assert.equal(template.variant, 'debug');
        }
        t.diagnostic(`${path.basename(root)}: ${sdk.sdkId}; ${sdk.manifest.catalog.profiles.length} original debug profiles`);
    }
});

test('release game emission uses the existing strict, isolated compiler and keeps debug output byte-compatible', { timeout: 180000 }, async t => {
    try { await lstat(debugRoot); } catch (error) {
        if (error.code !== 'ENOENT' || debugSdkInput !== undefined || process.env.GAME_SDK_INTEGRATION === '1') throw error;
        return t.skip('Saved real debug SDK required');
    }
    const directory = await temporary(t);
    const types = path.join(debugRoot, 'engine/profiles/HTML5/2d-basic/debug/types');
    const template = path.join(debugRoot, 'engine/profiles/HTML5/2d-basic/debug/template');
    const project = path.join(directory, 'project');
    await cp(template, project, { recursive: true });
    const engineBytes = await readFile(path.join(debugRoot, 'engine/profiles/HTML5/2d-basic/debug/engine/cc.js'), 'utf8');
    const availableCCExports = extractRuntimeExports(ts, engineBytes);
    const options = { projectDirectory: project, typesDirectory: types, toolchainDirectory: path.join(debugRoot, 'toolchain'), availableCCExports };
    for (const variant of ['debug', 'release']) {
        const outDirectory = path.join(directory, variant);
        const result = await compileGame({ ...options, variant, outDirectory });
        assert.equal(result.typeChecked, true);
        assert.equal(result.profileChecked, true);
        assert.equal(result.typeChecking.strict, true);
        assert.equal(result.typeChecking.skipLibCheck, false);
        assert.equal(result.typeChecking.skipDefaultLibCheck, false);
        assert.deepEqual(result.emission, { variant, sourceMaps: false, minified: variant === 'release', compact: variant === 'release',
            comments: variant === 'release' ? 'license-only' : 'preserve' });
        for (const file of result.outputFiles) {
            const bytes = await readFile(path.join(outDirectory, file));
            const original = await readFile(path.join(debugRoot, 'engine/profiles/HTML5/2d-basic/debug/game', file));
            if (variant === 'debug') assert.deepEqual(bytes, original);
            else { assert(bytes.length < original.length); assert.doesNotMatch(bytes.toString(), /sourceMappingURL|sourcesContent/); }
        }
    }
    const original = await readFile(path.join(project, 'src/main.ts'), 'utf8');
    await writeFile(path.join(project, 'src/main.ts'), original.replace('pointsPerClick = 7', 'pointsPerClick: number = "wrong"'));
    for (const checkOnly of [true, false]) await assert.rejects(compileGame({ ...options, variant: 'release', checkOnly, outDirectory: path.join(directory, 'invalid') }),
        error => error.code === 'TYPECHECK_FAILED' && error.diagnostics.some(diagnostic => diagnostic.code === 2322));
    await assert.rejects(lstat(path.join(directory, 'invalid')), { code: 'ENOENT' });
    await writeFile(path.join(project, 'src/main.ts'), original);
    const badTypes = path.join(directory, 'bad-types');
    await cp(types, badTypes, { recursive: true });
    await writeFile(path.join(badTypes, 'cc.editor.d.ts'), '\ndeclare type ReleaseLibraryCheck = MissingReleaseLibraryType;\n', { flag: 'a' });
    await assert.rejects(compileGame({ ...options, typesDirectory: badTypes, variant: 'release', checkOnly: true }), error => error.code === 'TYPECHECK_FAILED'
        && error.diagnostics.some(diagnostic => diagnostic.code === 2304 && diagnostic.file === 'types/cc.editor.d.ts'));
});

test('four independently built release runtimes bind flags, actual exports, renderer/builtins and target-specific evidence',
    { skip: releaseRoot === undefined, timeout: 180000 }, async t => {
        const { inspectClosure, readRuntime, verifyBilibili } = require('../runtime/verify-bilibili.cjs');
        const engineHashes = new Set();
        for (const target of ['HTML5', 'BILIBILI']) for (const profile of ['2d-basic', '3d-basic']) {
            const root = path.join(releaseRoot, target, profile);
            const raw = await readFile(path.join(root, 'runtime.json'));
            const descriptor = runtimeDescriptorSchema.parse(JSON.parse(raw));
            assert.equal(descriptor.variant, 'release');
            assert.equal(descriptor.constants.DEBUG, false);
            assert.equal(descriptor.constants.NATIVE, false);
            assert.equal(descriptor.constants.JSB, false);
            assert.equal(descriptor.compressed, true);
            assert.equal(descriptor.buildOptions.engine.compress, true);
            assert.equal(descriptor.buildOptions.engine.flags.DEBUG, false);
            assert.equal(descriptor.buildOptions.loader.minify, true);
            assert.equal(descriptor.buildOptions.game.minified, true);
            assert(descriptor.features.includes('legacy-pipeline'));
            assert.equal(descriptor.validationLevels.device, false);
            const engine = await readFile(path.join(root, descriptor.engineEntry));
            const saved = await readFile(path.join(debugRoot, `engine/profiles/${target}/${profile}/debug`, descriptor.engineEntry));
            assert(engine.length < saved.length * 0.75, 'Release must be separately optimized, not a renamed debug bundle');
            assert.notEqual(hash(engine), hash(saved));
            engineHashes.add(hash(engine));
            const names = extractRuntimeExports(ts, engine.toString(), { CC_DEBUG: false, CC_BUILD: true, CC_JSB: false,
                CC_EDITOR: false, CC_PREVIEW: false, CC_BILIBILI: target === 'BILIBILI', CC_MINIGAME: target === 'BILIBILI' });
            assert(names.includes('Node'));
            assert.equal(names.includes('MeshRenderer'), profile === '3d-basic');
            await validateRuntimeScripts(descriptor, name => readFile(path.join(root, name)));
            const reportName = target === 'HTML5' ? 'browser' : 'local';
            const report = (target === 'HTML5' ? browserReportSchema : bilibiliReportSchema).parse(
                JSON.parse(await readFile(target === 'BILIBILI' ? releaseLocalReport(profile) : `${root}-${reportName}/${reportName}-report.json`)));
            const validate = target === 'HTML5' ? validateRuntime : validateBilibiliRuntime;
            validate(descriptor, report, hash(raw), raw.length);
            if (target === 'BILIBILI') {
                const closure = inspectClosure((await readRuntime(root)).files);
                assert.equal(closure.engineExportCount, names.length, 'Local evidence must count only the lexical SystemJS export callback');
                assert.deepEqual(closure, report.evidence.closure);
                await assert.rejects(verifyBilibili({ runtimeDirectory: root, outDirectory: path.dirname(releaseLocalReport(profile)) }), /OUTPUT_CONFLICT/);
                await assert.rejects(verifyBilibili({ runtimeDirectory: root, outDirectory: path.join(root, 'evidence') }), /Evidence output must be outside the runtime/);
            }
            else {
                assert.equal(report.runtimeConstants.CC_DEBUG, false);
                assert.equal(report.validation.restarts, 10);
                assert.equal(report.validation.webAudio, true);
            }
            for (const change of [value => { value.constants.DEBUG = true; }, value => { value.compressed = false; },
                value => { delete value.buildOptions; }, value => { value.buildOptions.loader.minify = false; },
                value => { value.buildOptions.engine.flags.NATIVE = true; }, value => { value.tools.emission.minified = false; }]) {
                const changed = structuredClone(descriptor); change(changed);
                assert.throws(() => validate(changed, report, hash(raw), raw.length));
            }
            for (const change of [value => { delete value.build; }, value => { value.build.variant = 'debug'; },
                value => { value.build.engineSha256 = hash(saved); }, value => { value.runtimeSha256 = '0'.repeat(64); }]) {
                const changed = structuredClone(report); change(changed);
                assert.throws(() => validate(descriptor, changed, hash(raw), raw.length));
            }
            t.diagnostic(`${target}/${profile}/release: runtime=${hash(raw)}, engine=${hash(engine)}, bytes=${engine.length}`);
        }
        assert.equal(engineHashes.size, 4);
    });

test('mixed debug/release SDK preparation preserves all eight identities, templates and API evidence',
    { skip: releaseRoot === undefined, timeout: 300000 }, async t => {
        const directory = process.env.RELEASE_SDK_OUT ? path.dirname(process.env.RELEASE_SDK_OUT) : await temporary(t);
        const out = process.env.RELEASE_SDK_OUT ?? path.join(directory, 'sdk');
        const base = process.env.BILIBILI_SDK_BASE_ROOT ?? path.join(devkit, 'build/readonly-sdk');
        const runtimes = ['HTML5', 'BILIBILI'].flatMap(target => ['2d-basic', '3d-basic'].flatMap(profile => [
            { runtime: target === 'HTML5' ? path.join(process.env.GAME_SDK_RUNTIME_ROOT ?? path.join(devkit, 'runtime/build/acceptance-Js6TDR'), profile)
                : process.env[profile === '2d-basic' ? 'BILIBILI_SDK_2D_RUNTIME' : 'BILIBILI_SDK_3D_RUNTIME']
                    ?? path.join(devkit, `runtime/build/bilibili-final-${profile.slice(0, 2)}-20260918`) },
            { runtime: path.join(releaseRoot, target, profile), ...(target === 'BILIBILI' ? { localReport: releaseLocalReport(profile) } : {}) },
        ]));
        const result = await prepareGameSdk({ base, runtimes, out });
        const sdk = await loadSdk(out);
        assert.equal(result.sdkId, sdk.sdkId);
        assert.equal(sdk.manifest.catalog.profiles.length, 8);
        assert.equal(sdk.manifest.catalog.templates.length, 8);
        assert.equal(sdk.manifest.apiIndex.examples, 16);
        for (const entry of sdk.manifest.catalog.profiles) {
            const profile = sdk.profile(entry.target, entry.id, entry.variant);
            assert.equal(profile.variant, entry.variant);
            assert.equal(profile.constants.DEBUG, entry.variant === 'debug');
            const id = `${entry.target === 'BILIBILI' ? 'bilibili-' : ''}${entry.id}${entry.variant === 'release' ? '-release' : ''}-starter`;
            const template = sdk.template(id);
            assert.equal(template.variant, entry.variant);
            assert.equal(template.directory, path.join(profile.directory, 'template'));
        }
        const node = sdk.search({ query: 'cc.Node.setPosition', kind: 'api' }).items.find(item => item.title === 'cc.Node.setPosition');
        assert.equal(node.runtimeAvailability.length, 8);
        const keys = node.runtimeAvailability.map(item => `${item.target}/${item.profile}/${item.variant}`);
        assert.equal(new Set(keys).size, 8);
        for (const item of node.runtimeAvailability) {
            const profile = sdk.profile(item.target, item.profile, item.variant);
            assert.equal(item.engineSha256, hash(await readFile(path.join(profile.directory, profile.engineEntry))));
            assert.equal(item.status, 'export-present');
        }
        const mesh = sdk.search({ query: 'cc.MeshRenderer', kind: 'api', limit: 100 }).items.find(item => item.title === 'cc.MeshRenderer');
        assert.equal(mesh.runtimeAvailability.length, 8);
        assert(mesh.runtimeAvailability.every(item => item.status === (item.profile === '3d-basic' ? 'export-present' : 'export-absent')));
        const examples = sdk.search({ query: 'MeshRenderer', kind: 'example', profile: '3d-basic' }).items;
        assert.deepEqual([...new Set(examples.map(item => `${item.example.target}/${item.example.variant}`))].sort(),
            ['BILIBILI/debug', 'BILIBILI/release', 'HTML5/debug', 'HTML5/release']);
        const partial = structuredClone(sdk.manifest);
        partial.catalog.profiles = partial.catalog.profiles.filter(item => !(item.target === 'HTML5' && item.id === '3d-basic' && item.variant === 'release'));
        assert.equal(manifestSchema.safeParse(partial).success, false, 'A debug profile cannot fill a missing release profile');
        await assert.rejects(prepareGameSdk({ base, runtimes, out }), /OUTPUT_CONFLICT/);
        const original = await readFile(path.join(out, 'manifest.json'));
        // Tampering is confined to a new copy, never to retained evidence or SDK inputs.
        const tamper = path.join(await temporary(t), 'sdk');
        await cp(out, tamper, { recursive: true });
        const manifest = JSON.parse(original);
        const entry = manifest.catalog.profiles.find(item => item.variant === 'release');
        entry.variant = 'debug';
        delete manifest.sdkId;
        manifest.sdkId = `sha256-${hash(canonical(manifest))}`;
        await writeFile(path.join(tamper, 'manifest.json'), JSON.stringify(manifest));
        await assert.rejects(loadSdk(tamper), error => error.code === 'SDK_INCOMPLETE');
        assert.deepEqual(await readFile(path.join(out, 'manifest.json')), original);
        t.diagnostic(`Mixed SDK: ${out}; ${result.sdkId}; ${result.fileCount} files; ${result.dependencyCount} compiler packages`);
    });
