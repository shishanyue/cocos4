import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { browserReportSchema, browserSummarySchema, canonical, hash, loadSdk, manifestSchema, summarizeBrowserReport } from '../build/src/sdk.js';
import { prepareGameSdk } from '../scripts/prepare-game-sdk.mjs';

const run = promisify(execFile);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const artifacts = process.env.GAME_SDK_RUNTIME_ROOT ?? path.join(devkit, 'runtime/build/acceptance-Js6TDR');
const runtimes = ['2d-basic', '3d-basic'].map(profile => ({ runtime: path.join(artifacts, profile),
    browserReport: path.join(artifacts, `${profile}-browser/browser-report.json`) }));
let temporary;
let base;
let prepared;
let sdk;
let unavailable;
const incomplete = error => error?.code === 'SDK_INCOMPLETE';
before(async () => {
    try { for (const input of runtimes) await lstat(path.join(input.runtime, 'runtime.json')); }
    catch (error) {
        if (error.code !== 'ENOENT' || process.env.GAME_SDK_RUNTIME_ROOT !== undefined
            || process.env.BILIBILI_SDK_BASE_ROOT !== undefined || process.env.GAME_SDK_INTEGRATION === '1') throw error;
        unavailable = 'Real runtime artifacts are absent; set GAME_SDK_RUNTIME_ROOT to the fresh 2D/3D acceptance directory.';
        return;
    }
    temporary = await mkdtemp(path.join(tmpdir(), 'cocos4-game-sdk-test-'));
    base = path.join(temporary, 'readonly');
    prepared = path.join(temporary, 'prepared');
    const persisted = process.env.BILIBILI_SDK_BASE_ROOT ?? path.join(devkit, 'build/readonly-sdk');
    try { await lstat(persisted); await cp(persisted, base, { recursive: true }); }
    catch (error) {
        if (error.code !== 'ENOENT' || process.env.BILIBILI_SDK_BASE_ROOT !== undefined) throw error;
        await run(process.execPath, [path.join(devkit, 'scripts/prepare-sdk.mjs'), '--out', base]);
    }
    const result = await prepareGameSdk({ base, runtimes: runtimes.map(item => ({ runtime: path.join(item.runtime, 'runtime.json') })), out: prepared });
    assert.equal(result.dependencyCount, 84);
    assert.equal(result.evidence, `${prepared}.evidence`);
    sdk = await loadSdk(prepared);
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

async function copy() {
    const directory = path.join(await mkdtemp(path.join(temporary, 'case-')), 'sdk');
    await cp(prepared, directory, { recursive: true });
    return directory;
}
async function mutate(directory, change) {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    await change(manifest);
    delete manifest.sdkId;
    manifest.sdkId = `sha256-${hash(canonical(manifest))}`;
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
}
async function replaceJson(directory, relative, change) {
    const value = JSON.parse(await readFile(path.join(directory, relative), 'utf8'));
    await change(value);
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(path.join(directory, relative), bytes);
    await mutate(directory, manifest => Object.assign(manifest.files.find(file => file.path === relative),
        { bytes: bytes.length, sha256: hash(bytes) }));
}

test('real profiles, templates, full exports and binary assets produce truthful manifest-derived capabilities', async t => {
    if (unavailable) return t.skip(unavailable);
    assert.equal(manifestSchema.safeParse(sdk.manifest).success, true);
    assert.equal(sdk.manifest.kind, 'portable-development');
    assert.equal(sdk.manifest.development.node.bundled, false);
    assert.equal(sdk.manifest.development.host, undefined, 'Packaging must not wait for the main agent host helper');
    assert.deepEqual(sdk.manifest.development.sourceFiles.map(file => file.path),
        ['toolchain/compiler/compile-game.cjs', 'toolchain/compiler/files.cjs']);
    assert.equal(sdk.manifest.development.licenseReview, 'required');
    assert.equal(sdk.toolchainRoot, path.join(prepared, 'toolchain'));
    assert(sdk.manifest.files.length > 2000, 'The compiler closure is not a thin package manifest stub');
    assert(sdk.manifest.files.reduce((sum, file) => sum + file.bytes, 0) < 512 * 1024 * 1024);
    const source = await loadSdk(base);
    assert.equal(sdk.manifest.development.baseSdkId, source.sdkId);
    assert.deepEqual(sdk.manifest.source, source.manifest.source);
    for (const section of ['profiles', 'templates']) {
        assert.equal(sdk.catalog({ section }).available, true);
        assert.deepEqual(sdk.catalog({ section }).items, sdk.manifest.catalog[section]);
        assert.equal(sdk.catalog({ section, target: 'BILIBILI' }).available, false);
    }
    assert.equal(sdk.catalog({ section: 'platforms', target: 'HTML5' }).items[0].exportAvailable, true);
    assert.equal(sdk.catalog({ section: 'platforms', target: 'BILIBILI' }).items[0].exportAvailable, false);
    assert(sdk.catalog({ section: 'features', target: 'WECHAT' }).items.every(feature => !feature.prebuiltAvailable));
    assert.match(sdk.catalog({ section: 'sdk' }).items[0].description, /not a portable release/);
    const evidence = `${prepared}.evidence`;
    const receipt = JSON.parse(await readFile(path.join(evidence, 'receipt.json')));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'cocos4-sdk-execution-receipt');
    assert.equal(receipt.sdkId, sdk.sdkId);
    assert.equal(receipt.manifestSha256, hash(await readFile(path.join(prepared, 'manifest.json'))));
    for (const file of receipt.files) {
        const bytes = await readFile(path.join(evidence, file.path));
        assert.equal(bytes.length, file.bytes);
        assert.equal(hash(bytes), file.sha256);
    }
    for (const entry of sdk.manifest.catalog.profiles) {
        const profile = sdk.profile(entry.target, entry.id, entry.variant);
        assert(Object.isFrozen(profile));
        assert(Object.isFrozen(profile.files));
        assert(Object.isFrozen(profile.ccExports));
        assert.equal(profile.directory, path.join(prepared, entry.directory));
        assert.equal(profile.typesDirectory, path.join(profile.directory, 'types'));
        assert(profile.ccExports.includes('Vec3'), 'Full exports must include APIs unused by the starter');
        assert(profile.ccExports.length > profile.tools.requiredCCExports.length * 5);
        assert.equal(profile.ccExports.includes('MeshRenderer'), entry.id === '3d-basic');
        assert.equal(profile.descriptor.validationLevels.portableSDK, false, 'Original runtime provenance must remain unchanged');
        const original = await readFile(path.join(artifacts, entry.id, 'runtime.json'));
        assert.deepEqual(await readFile(path.join(profile.directory, 'runtime.json')), original);
        const input = runtimes.find(input => path.basename(input.runtime) === entry.id);
        const rawBytes = await readFile(input.browserReport);
        const raw = browserReportSchema.parse(JSON.parse(rawBytes));
        const summaryBytes = await readFile(path.join(prepared, entry.browserReport));
        const summary = browserSummarySchema.parse(JSON.parse(summaryBytes));
        assert.equal(summary.runtimeSha256, hash(original));
        assert.equal(summary.profile, entry.id);
        assert.deepEqual(summaryBytes, Buffer.from(`${JSON.stringify(await summarizeBrowserReport(raw,
            file => readFile(path.join(path.dirname(input.browserReport), file))), null, 2)}\n`));
        assert.deepEqual(await readFile(path.join(evidence, entry.browserReport)), rawBytes);
        for (const screenshot of raw.screenshots) {
            const relative = `${entry.directory}/evidence/${screenshot.path}`;
            assert.deepEqual(await readFile(path.join(evidence, relative)), await readFile(path.join(path.dirname(input.browserReport), screenshot.path)));
            assert(!sdk.manifest.files.some(file => file.path === relative), 'Execution PNGs are not stable SDK payload');
        }
        const templateEntry = sdk.manifest.catalog.templates.find(template => template.profile === entry.id);
        const template = sdk.template(templateEntry.id);
        assert.equal(template.directory, path.join(profile.directory, 'template'));
        assert.equal(template.profile, entry.id);
        assert.equal(template.target, 'HTML5');
        assert.equal((await readFile(path.join(template.directory, 'assets/tile.png')))[0], 137);
    }
    for (const args of [['HTML5', '2d-basic', 'release'], ['BILIBILI', '2d-basic', 'debug'], ['HTML5', '../2d-basic', 'debug']]) {
        assert.throws(() => sdk.profile(...args), error => error.code === 'PROFILE_NOT_AVAILABLE');
    }
    assert.throws(() => sdk.template('../template'), error => error.code === 'PROFILE_NOT_AVAILABLE');
    assert.throws(() => sdk.profile({ toString: () => 'HTML5' }, '2d-basic', 'debug'), error => error.code === 'PROFILE_NOT_AVAILABLE');
    const first = sdk.catalog({ section: 'profiles', limit: 1 });
    assert(first.nextCursor);
    assert.equal(sdk.catalog({ section: 'profiles', limit: 1, cursor: first.nextCursor }).items.length, 1);
    assert.throws(() => sdk.catalog({ section: 'templates', limit: 1, cursor: first.nextCursor }), error => error.code === 'CURSOR_INVALID');
});

test('only the 84 lock-selected compiler packages and their license files are delivered with nested resolutions intact', async t => {
    if (unavailable) return t.skip(unavailable);
    const closure = JSON.parse(await readFile(path.join(sdk.toolchainRoot, 'compiler-dependencies.json')));
    const inventory = JSON.parse(await readFile(path.join(sdk.toolchainRoot, 'inventory.json')));
    assert.equal(closure.packages.length, 84);
    assert.equal(hash(await readFile(path.join(sdk.toolchainRoot, 'source-lock.json'))), closure.rootLockSha256);
    const sourceLock = JSON.parse(await readFile(path.join(sdk.toolchainRoot, 'source-lock.json')));
    for (const pkg of closure.packages) {
        assert.equal(hash(await readFile(path.join(sdk.toolchainRoot, pkg.path, 'package.json'))), pkg.packageSha256);
        assert.equal(sourceLock.packages[pkg.path].version, pkg.version);
        assert.equal(sourceLock.packages[pkg.path].integrity, pkg.integrity);
        const licenses = inventory.filter(file => file.path.startsWith(`${pkg.path}/`)
            && !file.path.slice(pkg.path.length + 1).includes('node_modules/') && /(?:license|copying|notice)/i.test(path.basename(file.path)));
        assert.equal(sdk.manifest.development.missingLicenseFiles.includes(pkg.path), licenses.length === 0);
        for (const file of licenses) assert.equal(hash(await readFile(path.join(sdk.toolchainRoot, file.path))), file.sha256);
    }
    assert(!closure.packages.some(pkg => pkg.name === '@cocos/ccbuild'));
    assert(!sdk.manifest.files.some(file => /^(?:cocos|exports|native|external|pal|bin|host)\//.test(file.path)));
    const nested = closure.packages.find(pkg => pkg.path === 'node_modules/@babel/code-frame/node_modules/chalk');
    assert.equal(nested.version, '2.4.2');
    assert.equal(nested.dependencies['supports-color'], 'node_modules/@babel/code-frame/node_modules/supports-color');
});

test('relocated SDK compiler checks and emits decorated projects with no checkout, PATH tools or ancestor node_modules', async t => {
    if (unavailable) return t.skip(unavailable);
    const isolated = await mkdtemp(path.join(temporary, 'isolated-'));
    const data = path.join(isolated, 'data');
    await cp(prepared, data, { recursive: true });
    const runtime = path.join(isolated, 'runtime');
    await mkdir(path.join(runtime, 'node_modules'), { recursive: true });
    for (const name of ['sdk.js', 'contracts.js', 'api-index.js']) await cp(path.join(devkit, 'build/src', name), path.join(runtime, name));
    await cp(path.join(devkit, 'node_modules/zod'), path.join(runtime, 'node_modules/zod'), { recursive: true });
    await writeFile(path.join(runtime, 'package.json'), '{"type":"module"}');
    const project = path.join(isolated, 'project');
    const template = sdk.template(sdk.manifest.catalog.templates[0].id);
    await cp(template.directory, project, { recursive: true });
    const fixture = `import { _decorator, Component, Vec3 } from 'cc';
const { ccclass, property } = _decorator;
@ccclass('PortableSdkFixture')
export class PortableSdkFixture extends Component {
    @property speed: number = 7;
    start(): void { this.node.setPosition(new Vec3(this.speed, 0, 0)); }
}
`;
    await writeFile(path.join(project, 'src/main.ts'), fixture);
    await writeFile(path.join(project, 'babel.config.cjs'), 'throw new Error("must never execute project Babel config");');
    await writeFile(path.join(project, 'package.json'), '{"type":"module","scripts":{"build":"exit 91"}}');
    const script = `
        import assert from 'node:assert/strict';
        import Module, { createRequire, isBuiltin } from 'node:module';
        import fs from 'node:fs/promises';
        import { TextDecoder } from 'node:util';
        import { loadSdk } from './runtime/sdk.js';
        const { readFile, writeFile } = fs;
        const decode = TextDecoder.prototype.decode;
        let decodedBytes = 0;
        TextDecoder.prototype.decode = function (bytes, ...args) {
            decodedBytes += bytes.byteLength;
            assert.notEqual(Buffer.from(bytes).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Binary PNG was decoded as UTF-8');
            return decode.call(this, bytes, ...args);
        };
        const sdk = await loadSdk(process.cwd() + '/data');
        TextDecoder.prototype.decode = decode;
        const apiIndex = JSON.parse(await readFile(sdk.root + '/' + sdk.manifest.apiIndex.path));
        const apiDecodeBudget = sdk.manifest.apiIndex.bytes + apiIndex.parser.bytes + apiIndex.profiles[0].declaration.bytes
            + apiIndex.profiles.reduce((total, item) => total + item.engine.bytes + item.exports.bytes, 0)
            + apiIndex.entries.reduce((total, item) => total + item.bytes * (item.kind === 'example' ? 2 : 1), 0);
        assert(decodedBytes >= sdk.manifest.apiIndex.bytes, 'The actual API index must be decoded and validated');
        assert(decodedBytes - apiDecodeBudget < sdk.manifest.files.reduce((total, file) => total + file.bytes, 0) / 4,
            'Only the source-bound API inputs may add decoding; remaining payload hashes must still stream');
        const profile = sdk.profile('HTML5', '2d-basic', 'debug');
        const require = createRequire(import.meta.url);
        const resolve = Module._resolveFilename;
        Module._resolveFilename = function (...args) {
            const resolved = resolve.apply(this, args);
            assert(isBuiltin(resolved) || resolved.startsWith(sdk.toolchainRoot + '/'), 'OUTSIDE_TOOLCHAIN_MODULE: ' + resolved);
            return resolved;
        };
        const { compileGame } = require(sdk.toolchainRoot + '/compiler/compile-game.cjs');
        const ts = require(sdk.toolchainRoot + '/node_modules/typescript');
        for (const name of ['readFile', 'readDirectory', 'fileExists', 'directoryExists', 'getDirectories']) {
            ts.sys[name] = () => { throw new Error('DEFAULT_TS_FILESYSTEM_USED: ' + name); };
        }
        for (const entry of sdk.manifest.catalog.profiles) {
            const selected = sdk.profile(entry.target, entry.id, entry.variant);
            const result = await compileGame({ toolchainDirectory: sdk.toolchainRoot,
                projectDirectory: selected.directory + '/template', typesDirectory: selected.typesDirectory,
                outDirectory: process.cwd() + '/' + entry.id, availableCCExports: selected.ccExports });
            assert.equal(result.profileChecked, true);
            for (const file of result.outputFiles) assert.deepEqual(await readFile(process.cwd() + '/' + entry.id + '/' + file),
                await readFile(selected.directory + '/game/' + file));
        }
        const options = { toolchainDirectory: sdk.toolchainRoot, projectDirectory: process.cwd() + '/project',
            typesDirectory: profile.typesDirectory, outDirectory: process.cwd() + '/emitted', availableCCExports: profile.ccExports };
        const mutators = ['writeFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm'];
        const originals = mutators.map(name => fs[name]);
        for (const name of mutators) fs[name] = () => { throw new Error('CHECK_ONLY_WRITE: ' + name); };
        const checked = await compileGame({ ...options, checkOnly: true });
        mutators.forEach((name, index) => { fs[name] = originals[index]; });
        assert.equal(checked.emitted, false);
        assert.equal(checked.profileChecked, true);
        assert.deepEqual(checked.outputFiles, []);
        await assert.rejects(fs.lstat(options.outDirectory), error => error.code === 'ENOENT');
        const compiled = await compileGame(options);
        assert.equal(compiled.typeChecking.skipLibCheck, false);
        assert.equal(compiled.typeChecking.skipDefaultLibCheck, false);
        assert(compiled.requiredCCExports.includes('Vec3'));
        assert(compiled.requiredCCExports.every(name => profile.ccExports.includes(name)));
        assert.match(await readFile(options.outDirectory + '/main.js', 'utf8'), /System.register/);
        const source = await readFile(options.projectDirectory + '/src/main.ts', 'utf8');
        await writeFile(options.projectDirectory + '/src/main.ts', source.replace('speed: number = 7', 'speed: number = "bad"'));
        await assert.rejects(compileGame({ ...options, checkOnly: true }), error => error.code === 'TYPECHECK_FAILED'
            && error.diagnostics.some(item => item.code === 2322 && item.file === 'src/main.ts' && item.line === 5 && item.column > 1));
        await writeFile(options.projectDirectory + '/src/main.ts', "export { MeshRenderer } from 'cc';");
        await assert.rejects(compileGame({ ...options, checkOnly: true }), error => error.code === 'FEATURE_NOT_IN_PROFILE');
        assert(Object.keys(require.cache).every(file => file.startsWith(process.cwd() + '/data/toolchain/')));
        console.log(JSON.stringify({ checked: checked.typeChecked, compiled: compiled.typeChecked, exports: compiled.requiredCCExports }));
    `;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script],
        { cwd: isolated, env: { PATH: '', HOME: isolated, LANG: 'C', LC_ALL: 'C' }, timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(JSON.parse(stdout).compiled, true);
    assert.equal(JSON.parse(stdout).checked, true);
    await assert.rejects(lstat(path.join(isolated, 'node_modules')), error => error.code === 'ENOENT');
});

test('profile corruption, false capability claims, unsafe paths and forged evidence fail even with a rehashed SDK ID', async t => {
    if (unavailable) return t.skip(unavailable);
    const directory = await copy();
    const manifestFile = path.join(directory, 'manifest.json');
    const original = await readFile(manifestFile);
    for (const change of [
        manifest => { manifest.catalog.profiles[0].variant = 'release'; },
        manifest => { manifest.catalog.profiles[0].directory = '../outside'; },
        manifest => { manifest.catalog.templates[0].directory = 'toolchain'; },
        manifest => { manifest.catalog.platforms.find(platform => platform.id === 'WECHAT').exportAvailable = true; },
        manifest => { manifest.catalog.profiles[0].validationLevels.push('device'); },
        manifest => { manifest.catalog.features.find(feature => !feature.prebuiltAvailable).prebuiltAvailable = true; },
        manifest => { manifest.development.node.bundled = true; },
        manifest => { manifest.capabilities.gameBuild = false; },
        manifest => { manifest.catalog.profiles.pop(); },
        manifest => { manifest.catalog.templates = []; },
        manifest => { manifest.development.sourceFiles[0].sourcePath = 'fake/compiler.cjs'; },
        manifest => { manifest.files[0].path = 'toolchain/node_modules/pkg/../../outside'; },
        manifest => { manifest.files[0].path = 'toolchain/node_modules/pkg/%2e%2e/outside'; },
        manifest => { manifest.files[0].path = 'toolchain/node_modules/pkg/CON.txt'; },
        manifest => { manifest.files[0].path = 'toolchain/node_modules/pkg/name.'; },
        manifest => { manifest.files[0].bytes = 128 * 1024 * 1024 + 1; },
        manifest => { for (const file of manifest.files.slice(0, 5)) file.bytes = 128 * 1024 * 1024; },
    ]) {
        await mutate(directory, change);
        await assert.rejects(loadSdk(directory), incomplete);
        await writeFile(manifestFile, original);
    }
    const profile = sdk.manifest.catalog.profiles[0];
    for (const [relative, change] of [
        [profile.browserReport, report => { report.runtimeSha256 = '0'.repeat(64); }],
        [profile.browserReport, report => { report.success = false; }],
        [profile.browserReport, report => { report.screenshots[0].width += 1; }],
        [profile.browserReport, report => { report.initial.world3d = true; }],
        [profile.exports, exports => { exports.engineSha256 = '0'.repeat(64); }],
    ]) {
        const originalFile = await readFile(path.join(directory, relative));
        await replaceJson(directory, relative, change);
        await assert.rejects(loadSdk(directory), incomplete);
        await writeFile(path.join(directory, relative), originalFile);
        await writeFile(manifestFile, original);
    }
    const originalDescriptor = await readFile(path.join(directory, profile.descriptor));
    const originalReport = await readFile(path.join(directory, profile.browserReport));
    await replaceJson(directory, profile.descriptor, descriptor => { descriptor.constants.NATIVE = true; });
    const changedDescriptor = await readFile(path.join(directory, profile.descriptor));
    await replaceJson(directory, profile.browserReport, report => { report.runtimeSha256 = hash(changedDescriptor); });
    await assert.rejects(loadSdk(directory), incomplete, 'Rebinding browser evidence does not permit native runtime flags');
    await writeFile(path.join(directory, profile.descriptor), originalDescriptor);
    await writeFile(path.join(directory, profile.browserReport), originalReport);
    await writeFile(manifestFile, original);
    const binary = path.join(directory, profile.directory, 'template/assets/tile.png');
    const bytes = await readFile(binary);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(binary, bytes);
    await assert.rejects(loadSdk(directory), incomplete);
});

test('legacy raw-report and PNG negatives remain enforced alongside fresh summaries', async t => {
    if (unavailable) return t.skip(unavailable);
    const directory = await copy();
    const profile = sdk.manifest.catalog.profiles.find(profile => profile.id === '2d-basic');
    const input = runtimes.find(input => path.basename(input.runtime) === profile.id);
    const rawBytes = await readFile(input.browserReport);
    const raw = browserReportSchema.parse(JSON.parse(rawBytes));
    // Restore genuine retained bytes in a private compatibility fixture. The
    // runtime descriptor is unchanged; this does not invent execution evidence.
    await writeFile(path.join(directory, profile.browserReport), rawBytes);
    const images = [];
    for (const screenshot of raw.screenshots) {
        const bytes = await readFile(path.join(path.dirname(input.browserReport), screenshot.path));
        const relative = `${profile.directory}/evidence/${screenshot.path}`;
        assert.equal(hash(bytes), screenshot.sha256);
        await writeFile(path.join(directory, relative), bytes);
        images.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
    await mutate(directory, manifest => {
        Object.assign(manifest.files.find(file => file.path === profile.browserReport), { bytes: rawBytes.length, sha256: hash(rawBytes) });
        manifest.files.push(...images);
        manifest.files.sort((a, b) => a.path < b.path ? -1 : 1);
    });
    await loadSdk(directory);
    const manifestFile = path.join(directory, 'manifest.json');
    const manifestBytes = await readFile(manifestFile);
    for (const change of [report => { report.runtimeSha256 = '0'.repeat(64); }, report => { report.success = false; },
        report => { report.initial.world3d = true; }, report => { report.pageErrors.push('unexpected error'); },
        report => { report.screenshots[0].width++; }, report => { report.screenshots[0].sha256 = '0'.repeat(64); }]) {
        await replaceJson(directory, profile.browserReport, change);
        await assert.rejects(loadSdk(directory), incomplete);
        await writeFile(path.join(directory, profile.browserReport), rawBytes);
        await writeFile(manifestFile, manifestBytes);
    }
    const image = images[0];
    const imageFile = path.join(directory, image.path);
    const original = await readFile(imageFile);
    for (const change of [bytes => { bytes[0] ^= 1; }, bytes => { bytes.writeUInt32BE(raw.screenshots[0].width + 1, 16); }]) {
        const bytes = Buffer.from(original);
        change(bytes);
        await writeFile(imageFile, bytes);
        await mutate(directory, manifest => Object.assign(manifest.files.find(file => file.path === image.path), { sha256: hash(bytes) }));
        await replaceJson(directory, profile.browserReport, report => { report.screenshots[0].sha256 = hash(bytes); });
        await assert.rejects(loadSdk(directory), incomplete, 'Rehashing cannot hide invalid PNG signatures or mismatched dimensions');
        await writeFile(imageFile, original);
        await writeFile(path.join(directory, profile.browserReport), rawBytes);
        await writeFile(manifestFile, manifestBytes);
    }
    await rm(imageFile);
    await assert.rejects(loadSdk(directory), incomplete);
});

test('missing and thinned nested compiler dependencies cannot be hidden by updating the outer inventory', async t => {
    if (unavailable) return t.skip(unavailable);
    const directory = await copy();
    const victim = 'toolchain/node_modules/@babel/code-frame/node_modules/chalk/index.js';
    assert(sdk.manifest.files.some(file => file.path === victim));
    await rm(path.join(directory, victim));
    await mutate(directory, manifest => { manifest.files = manifest.files.filter(file => file.path !== victim); });
    await assert.rejects(loadSdk(directory), incomplete);
    await replaceJson(directory, 'toolchain/inventory.json', inventory => {
        inventory.splice(inventory.findIndex(file => `toolchain/${file.path}` === victim), 1);
    });
    await assert.rejects(loadSdk(directory), incomplete, 'Package entrypoint is required even when the inventory was thinned');
    const linkRoot = await copy();
    const victimPath = path.join(linkRoot, victim);
    await rm(victimPath);
    await symlink(path.join(prepared, victim), victimPath);
    await assert.rejects(loadSdk(linkRoot), incomplete);
});

test('generator rejects unpaired, unbound and incomplete real inputs and never replaces an existing output', async t => {
    if (unavailable) return t.skip(unavailable);
    const script = path.join(devkit, 'scripts/prepare-game-sdk.mjs');
    await assert.rejects(run(process.execPath, [script, '--base', base, '--runtime', runtimes[0].runtime,
        '--out', path.join(temporary, 'bad-cli')]), /Usage/);
    await assert.rejects(run(process.execPath, [script, '--base', base, '--runtime', runtimes[0].runtime,
        '--runtime', runtimes[1].runtime, '--browser-report', runtimes[0].browserReport,
        '--out', path.join(temporary, 'unpaired-cli')]), /Usage/);
    const existing = path.join(temporary, 'existing');
    await mkdir(existing);
    const before = await lstat(existing);
    await assert.rejects(prepareGameSdk({ base, runtimes, out: existing }), /OUTPUT_CONFLICT/);
    assert.equal((await lstat(existing)).ino, before.ino);
    assert.deepEqual(await readdir(existing), []);
    await assert.rejects(prepareGameSdk({ base, runtimes: [
        { ...runtimes[0], browserReport: runtimes[1].browserReport }, runtimes[1],
    ], out: path.join(temporary, 'unbound') }), incomplete);
    const broken = path.join(temporary, 'broken-runtime');
    await cp(runtimes[0].runtime, broken, { recursive: true });
    await rename(path.join(broken, 'engine/cc.js'), path.join(broken, 'engine/unlisted.js'));
    await assert.rejects(prepareGameSdk({ base, runtimes: [{ ...runtimes[0], runtime: broken }, runtimes[1]],
        out: path.join(temporary, 'missing-profile-file') }), /missing or unlisted/);
    assert(!(await readdir(temporary)).some(name => name.startsWith('.cocos4-game-sdk-')));
});

test('CLI accepts grouped runtime descriptors and explicit browser reports and produces the same portable pack', async t => {
    if (unavailable) return t.skip(unavailable);
    const output = path.join(temporary, 'cli-pack');
    const { stdout } = await run(process.execPath, [path.join(devkit, 'scripts/prepare-game-sdk.mjs'), '--base', base,
        ...runtimes.flatMap(item => ['--runtime', path.join(item.runtime, 'runtime.json')]),
        ...runtimes.flatMap(item => ['--browser-report', item.browserReport]), '--out', output],
    { cwd: temporary, env: { PATH: '', HOME: temporary, LANG: 'C', LC_ALL: 'C' }, timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(JSON.parse(stdout).sdkId, sdk.sdkId);
    assert.deepEqual(await readFile(path.join(output, 'manifest.json')), await readFile(path.join(prepared, 'manifest.json')));
    assert.equal((await loadSdk(output)).sdkId, sdk.sdkId);
    assert(!(await readdir(temporary)).some(name => name.startsWith('.cocos4-game-sdk-')));
});
