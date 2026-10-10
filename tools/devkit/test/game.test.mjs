import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as fs from 'node:fs/promises';
import promises from 'node:fs/promises';
import { constants, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Module, { syncBuiltinESMExports } from 'node:module';
import { privateFixtureTree } from './fixtures/windows-private.mjs';

const build = new URL(process.env.GAME_TEST_BUILD_PREFIX ?? '../build/src/', import.meta.url);
const { runGameOperation, commitGameOutput } = await import(new URL('game.js', build));
const { withGameSnapshot, publishGameOutput } = await import(new URL('workspace.js', build));
const { artifactInventorySchema, reportSchema } = await import(new URL('contracts.js', build));
const { loadSdk, hash } = await import(new URL('sdk.js', build));
const { enforceWindowsPrivate, verifyWindowsTrust } = process.platform === 'win32'
    ? await import(new URL('windows-fs.js', build)) : {};
const execute = promisify(execFile);
const directoryLink = (target, link) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
async function grantOtherUsersRead(file) {
    const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/icacls.exe');
    await execute(icacls, [file, '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true });
}
const sdkRoot = process.env.GAME_OPERATION_SDK_ROOT ?? fileURLToPath(new URL('../build/game-sdk', import.meta.url));
const legacyRoot = path.resolve(process.env.LEGACY_HTML5_SDK_ROOT ?? fileURLToPath(new URL('../build/legacy-game-sdk', import.meta.url)));
let sdk;
let unavailable;
before(async () => {
    try { sdk = await loadSdk(sdkRoot); }
    catch (error) {
        try { await fs.lstat(sdkRoot); } catch (missing) {
            if (missing.code === 'ENOENT' && !process.env.GAME_OPERATION_SDK_ROOT && process.env.GAME_SDK_INTEGRATION !== '1') {
                unavailable = 'Real game SDK absent; set GAME_OPERATION_SDK_ROOT to a verified development pack.';
                return;
            }
        }
        throw error;
    }
});
const code = expected => error => { assert.equal(error.code, expected, error.stack); return true; };
const absent = filename => assert.rejects(fs.lstat(filename), error => error.code === 'ENOENT');

async function fixture(t, selectedSdk = sdk) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cocos4-game-operations-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    if (process.platform === 'win32') await enforceWindowsPrivate(root);
    const workspace = path.join(root, 'workspace');
    const state = path.join(root, 'state');
    const artifactsRoot = path.join(state, 'artifacts');
    await fs.mkdir(workspace);
    await fs.mkdir(state, { mode: 0o700 });
    await fs.mkdir(artifactsRoot, { mode: 0o700 });
    if (process.platform === 'win32') for (const directory of [workspace, state, artifactsRoot]) await enforceWindowsPrivate(directory);
    return { root, workspace, state, artifactsRoot, sdk: selectedSdk };
}
function request(paths, operation, input, extra = {}) {
    return { workspace: paths.workspace, sdkRoot: paths.sdk.root, expectedSdkId: paths.sdk.sdkId,
        staging: path.join(paths.state, randomUUID()), artifactsRoot: paths.artifactsRoot, artifactId: randomUUID(),
        permissions: { mode: 'develop', preview: false, executeTests: false }, operation, input, ...extra };
}
async function create(t, profile = '2d-basic', target = 'HTML5') {
    const paths = await fixture(t);
    const template = sdk.manifest.catalog.templates.find(item => item.profile === profile && item.target === target && item.variant === 'debug');
    assert.ok(template, `Missing real ${target}/${profile}/debug starter`);
    const input = { directory: 'game', projectName: 'my-test-game', templateId: template.id };
    const operation = request(paths, 'project_create', input);
    const report = await runGameOperation(operation, sdk);
    assert.equal(report.project, 'game');
    await absent(path.join(paths.workspace, 'game'));
    await commitGameOutput(operation, operation, report);
    return { ...paths, project: path.join(paths.workspace, 'game'), createRequest: operation, createReport: report };
}
const checkInput = profile => ({ project: 'game', target: 'HTML5', profile, checks: ['types'] });
const buildInput = profile => ({ project: 'game', target: 'HTML5', profile, variant: 'debug' });
async function allFiles(root, prefix = '') {
    const result = new Map();
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) for (const [child, bytes] of await allFiles(root, `${name}/`)) result.set(child, bytes);
        else result.set(name, await fs.readFile(path.join(root, name)));
    }
    return result;
}

test('real 2D and 3D SDK starters create editable projects, genuinely typecheck, and build only current game/runtime payloads', async t => {
    if (unavailable) return t.skip(unavailable);
    for (const profile of ['2d-basic', '3d-basic']) await t.test(profile, async t => {
        const paths = await create(t, profile);
        const original = await allFiles(paths.project);
        const inventory = paths.createReport.items.filter(item => item.code === 'PROJECT_FILE');
        assert.deepEqual(inventory.map(item => item.file), [...original.keys()].sort());
        for (const item of inventory) {
            assert.equal(item.bytes, original.get(item.file).length);
            assert.equal(item.sha256, hash(original.get(item.file)));
        }
        const selected = sdk.manifest.catalog.profiles.find(item => item.id === profile && item.target === 'HTML5' && item.variant === 'debug');
        const profileIdentity = { sdkId: sdk.sdkId, target: 'HTML5', id: profile, variant: 'debug',
            descriptorSha256: sdk.manifest.files.find(item => item.path === selected.descriptor).sha256 };
        assert.deepEqual(paths.createReport.profile, profileIdentity);
        assert.equal(JSON.parse(original.get('package.json')).name, 'my-test-game');
        assert.deepEqual(JSON.parse(original.get('tsconfig.json')).compilerOptions.paths, { cc: ['./types/cc.d.ts'] });
        for (const name of original.keys()) {
            const file = path.join(paths.project, name);
            if (process.platform === 'win32') {
                await verifyWindowsTrust(file, true);
                await fs.access(file, constants.W_OK);
            } else assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        }
        await fs.appendFile(path.join(paths.project, 'src/main.ts'), '\nexport const gameRevision = "ACTUAL_USER_GAME_20260918";\n');
        await fs.writeFile(path.join(paths.project, 'assets/rules.json'), '{"title":"USER ASSET","restart":"R"}\n');
        await fs.writeFile(path.join(paths.project, 'assets/new.txt'), 'new user asset');
        await fs.writeFile(path.join(paths.project, 'babel.config.cjs'), 'throw new Error("PROJECT CONFIG EXECUTED");');
        const pkg = JSON.parse(original.get('package.json'));
        pkg.scripts = { build: 'THIS MUST NEVER RUN' };
        await fs.writeFile(path.join(paths.project, 'package.json'), JSON.stringify(pkg));
        const check = request(paths, 'project_check', checkInput(profile));
        const checked = await runGameOperation(check, sdk);
        assert(checked.validationLevels.includes('gameTypecheck'));
        assert.deepEqual(checked.profile, profileIdentity);
        assert.equal(checked.artifacts, undefined);
        await absent(path.join(check.staging, 'compiled'));
        assert.deepEqual(await fs.readdir(path.join(check.staging, 'output')), []);
        const operation = request(paths, 'game_build', buildInput(profile));
        operation.releaseId = `sha256-${'a'.repeat(64)}`;
        const report = await runGameOperation(operation, sdk);
        reportSchema.parse(report);
        assert.deepEqual(report.profile, profileIdentity);
        assert.equal(report.artifacts.length, 1);
        const artifact = report.artifacts[0];
        assert.deepEqual(artifact.provenance, { releaseId: operation.releaseId, profileSha256: profileIdentity.descriptorSha256 });
        assert.equal(artifact.artifactId, operation.artifactId);
        assert.equal(artifact.sdkId, sdk.sdkId);
        await absent(path.join(paths.artifactsRoot, `artifact-${artifact.artifactId}`));
        const output = path.join(operation.staging, 'output');
        const files = await allFiles(output);
        const raw = files.get('artifact-inventory.json');
        const artifactInventory = artifactInventorySchema.parse(JSON.parse(raw));
        assert.deepEqual(artifactInventory.provenance, artifact.provenance);
        assert.equal(artifact.sha256, hash(raw));
        assert.equal(artifact.files, artifactInventory.files.length);
        assert.equal(artifact.bytes, artifactInventory.files.reduce((sum, file) => sum + file.bytes, 0));
        assert.equal(files.size, artifact.files + 1);
        for (const file of artifactInventory.files) {
            assert.notEqual(file.path, 'artifact-inventory.json');
            assert.equal(hash(files.get(file.path)), file.sha256);
            assert.equal(files.get(file.path).length, file.bytes);
        }
        assert.match(files.get('game/main.js').toString(), /ACTUAL_USER_GAME_20260918/);
        assert.equal(files.get('assets/game/rules.json').toString(), '{"title":"USER ASSET","restart":"R"}\n');
        assert.equal(files.get('assets/game/new.txt').toString(), 'new user asset');
        assert(![...files.keys()].some(name => /^(?:template|types|toolchain|node_modules)\//.test(name)));
        for (const name of ['runtime.json', 'engine-build.json', 'compiler-dependencies.json', 'package.json', 'babel.config.cjs', 'game/__cocos4_bootstrap__.js']) assert(!files.has(name), name);
        const metadata = JSON.parse(files.get('game-compiler.json'));
        assert.deepEqual([metadata.typeChecked, metadata.profileChecked, metadata.emitted, metadata.checkOnly], [true, true, true, false]);
        assert.deepEqual([metadata.typeChecking.strict, metadata.typeChecking.skipLibCheck, metadata.typeChecking.skipDefaultLibCheck], [true, false, false]);
        assert(metadata.outputFiles.includes('main.js'));
        assert(!metadata.outputFiles.includes('__cocos4_bootstrap__.js'));
        for (const file of metadata.outputFiles) assert(files.has(`game/${file}`));
        const html = files.get('index.html').toString();
        for (const match of html.matchAll(/src="([^"]+)"/g)) assert(files.has(match[1]), match[1]);
        for (const target of Object.values(JSON.parse(files.get('import-map.json')).imports)) assert(files.has(target.slice(2)), target);
        assert.match(files.get('boot.js').toString(), /main\.start\(\)\.catch/);
        assert(files.has('assets/internal/config.json'));
        await assert.rejects(commitGameOutput({ ...operation, releaseId: `sha256-${'b'.repeat(64)}` }, operation, report),
            error => error.code === 'ARTIFACT_INVALID');
        await absent(path.join(paths.artifactsRoot, `artifact-${artifact.artifactId}`));
        await commitGameOutput(operation, operation, report);
        await absent(output);
        assert.deepEqual(await allFiles(path.join(paths.artifactsRoot, `artifact-${artifact.artifactId}`)), files);
    });
});

test('compiler errors become bounded failed reports, including 2D overflow and bootstrap mismatch', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    for (const [source, operation, expected] of [
        [Array.from({ length: 100 }, (_, i) => `export const broken${i}: number = "bad";`).join('\n'), 'project_check', 'TYPECHECK_FAILED'],
        ['import { MeshRenderer } from "cc"; export const forbidden = MeshRenderer;', 'project_check', 'FEATURE_NOT_IN_PROFILE'],
        ['export const notStart = 1;', 'game_build', 'TYPECHECK_FAILED'],
        ['export function start(): void {}', 'game_build', 'TYPECHECK_FAILED'],
        ['export interface start { (): Promise<void>; } export const marker = 1;', 'game_build', 'TYPECHECK_FAILED'],
    ]) {
        await fs.writeFile(path.join(paths.project, 'src/main.ts'), source);
        const job = request(paths, operation, operation === 'game_build' ? buildInput('2d-basic') : checkInput('2d-basic'));
        await assert.rejects(runGameOperation(job, sdk), error => {
            assert.equal(error.code, expected, error.stack);
            reportSchema.parse(error.report);
            assert.equal(error.report.profile.id, '2d-basic');
            assert.equal(error.report.profile.sdkId, sdk.sdkId);
            assert(error.report.items.some(item => item.status === 'failed'));
            assert(error.report.items.some(item => item.file && item.line && item.column));
            assert(Buffer.byteLength(JSON.stringify(error.report)) < 32 * 1024);
            assert.equal(error.report.artifacts, undefined);
            if (source.length > 2000) assert(error.report.items.some(item => item.code === 'DIAGNOSTICS_TRUNCATED'));
            return true;
        });
        assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
    }
});

test('build entry proof rejects erased declarations with saved SDK compilers on both targets, without changing checkOnly', async t => {
    if (unavailable) return t.skip(unavailable);
    for (const target of ['HTML5', 'BILIBILI']) await t.test(target, async t => {
        if (!sdk.manifest.catalog.profiles.some(item => item.target === target)) return t.skip('SDK does not contain this target.');
        const paths = await create(t, '2d-basic', target);
        const config = path.join(paths.project, 'game.json');
        if (target === 'BILIBILI') {
            const value = JSON.parse(await fs.readFile(config, 'utf8'));
            value.appId = 'compiler-export-test';
            await fs.writeFile(config, JSON.stringify(value));
        }
        for (const source of [
            'export declare function start(): Promise<void>; export const marker = 1;',
            'export declare const start: () => Promise<void>; export const marker = 1;',
            'export let start: () => Promise<void>; export const marker = 1;',
            `export declare function start(): Promise<void>;
export function decoy(_export: (name: string, value: unknown) => void): void { _export('start', async () => {}); }
export const marker = 'System.register([], function (_export) { _export("start", async () => {}); })';`,
        ]) {
            await fs.writeFile(path.join(paths.project, 'src/main.ts'), source);
            const checked = await runGameOperation(request(paths, 'project_check', { ...checkInput('2d-basic'), target }), sdk);
            assert(checked.validationLevels.includes('gameTypecheck'), 'Generic checkOnly does not impose a bootstrap runtime contract');
            const job = request(paths, 'game_build', { ...buildInput('2d-basic'), target });
            await assert.rejects(runGameOperation(job, sdk), error => {
                assert.equal(error.code, 'TYPECHECK_FAILED', error.stack);
                reportSchema.parse(error.report);
                assert(error.report.items.some(item => item.status === 'failed' && item.file === 'src/main.ts'
                    && /start/.test(item.message) && /runtime|implement/i.test(item.message)), JSON.stringify(error.report));
                assert(Buffer.byteLength(JSON.stringify(error.report)) < 32 * 1024);
                assert.equal(error.report.artifacts, undefined);
                return true;
            });
            assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
            await absent(path.join(job.staging, 'output/artifact-inventory.json'));
        }
    });
});

test('static entry proof accepts implemented, aliased and re-exported start without executing game code', async t => {
    if (unavailable) return t.skip(unavailable);
    for (const target of ['HTML5', 'BILIBILI']) await t.test(target, async t => {
        if (!sdk.manifest.catalog.profiles.some(item => item.target === target)) return t.skip('SDK does not contain this target.');
        const paths = await create(t, '2d-basic', target);
        if (target === 'BILIBILI') {
            const config = JSON.parse(await fs.readFile(path.join(paths.project, 'game.json'), 'utf8'));
            config.appId = 'compiler-export-test';
            await fs.writeFile(path.join(paths.project, 'game.json'), JSON.stringify(config));
        }
        await fs.mkdir(path.join(paths.project, 'src/nested'));
        await fs.writeFile(path.join(paths.project, 'src/entry.ts'), 'export async function begin(): Promise<void> { throw new Error("GAME MUST NOT EXECUTE"); }');
        await fs.writeFile(path.join(paths.project, 'src/nested/bridge.ts'), "export { begin as start } from '../entry.js';");
        await fs.writeFile(path.join(paths.project, 'src/js-entry.js'), 'export async function begin() { throw new Error("JS GAME MUST NOT EXECUTE"); }');
        for (const [name, source] of [
            ['direct', 'export async function start(): Promise<void> { throw new Error("GAME MUST NOT EXECUTE"); }'],
            ['local alias', 'const begin = async (): Promise<void> => {}; export { begin as start }; export const marker = 1;'],
            ['named reexport', "export { begin as start } from './entry.js';"],
            ['star and alias chain', "export * from './nested/bridge.js';"],
            ['import and export alias', "import { begin } from './entry.js'; export { begin as start };"],
            ['overload implementation', 'export function start(): Promise<void>; export async function start(): Promise<void> {}'],
            ['shadowed user exporter', `export async function start(): Promise<void> {}
export function decoy(_export: (name: string, value: unknown) => void): void { _export('notStart', 1); }
throw new Error('TOP LEVEL GAME MUST NOT EXECUTE');`],
        ]) await t.test(name, async () => {
            await fs.writeFile(path.join(paths.project, 'src/main.ts'), source);
            const report = await runGameOperation(request(paths, 'game_build', { ...buildInput('2d-basic'), target }), sdk);
            assert.equal(report.artifacts.length, 1);
        });
        await fs.unlink(path.join(paths.project, 'src/main.ts'));
        await t.test('JS entry and JS implementation', async () => {
            await fs.writeFile(path.join(paths.project, 'src/main.js'), "export { begin as start } from './js-entry.js';");
            const report = await runGameOperation(request(paths, 'game_build', { ...buildInput('2d-basic'), target }), sdk);
            assert.equal(report.artifacts.length, 1);
        });
    });
});

test('named and star reexports cannot hide a declare-only or uninitialized start implementation', async t => {
    if (unavailable) return t.skip(unavailable);
    for (const target of ['HTML5', 'BILIBILI']) await t.test(target, async t => {
        if (!sdk.manifest.catalog.profiles.some(item => item.target === target)) return t.skip('SDK does not contain this target.');
        const paths = await create(t, '2d-basic', target);
        if (target === 'BILIBILI') {
            const config = JSON.parse(await fs.readFile(path.join(paths.project, 'game.json'), 'utf8'));
            config.appId = 'compiler-export-test';
            await fs.writeFile(path.join(paths.project, 'game.json'), JSON.stringify(config));
        }
        await fs.writeFile(path.join(paths.project, 'src/bridge.ts'), "export { begin as start } from './entry.js';");
        for (const [name, main, entry] of [
            ['named declare-only', "export { begin as start } from './entry.js';", 'export declare function begin(): Promise<void>; export const marker = 1;'],
            ['star alias declare-only', "export * from './bridge.js';", 'export declare const begin: () => Promise<void>; export const marker = 1;'],
            ['import alias uninitialized', "import { begin } from './entry.js'; export { begin as start };", 'export let begin: () => Promise<void>; export const marker = 1;'],
        ]) await t.test(name, async () => {
            await fs.writeFile(path.join(paths.project, 'src/main.ts'), main);
            await fs.writeFile(path.join(paths.project, 'src/entry.ts'), entry);
            const job = request(paths, 'game_build', { ...buildInput('2d-basic'), target });
            await assert.rejects(runGameOperation(job, sdk), error => {
                assert.equal(error.code, 'TYPECHECK_FAILED', error.stack);
                reportSchema.parse(error.report);
                assert(error.report.items.some(item => item.status === 'failed' && item.file === 'src/main.ts' && /implemented|initialized/.test(item.message)));
                assert(Buffer.byteLength(JSON.stringify(error.report)) < 32 * 1024);
                assert.equal(error.report.artifacts, undefined);
                return true;
            });
            await absent(path.join(job.staging, 'output/artifact-inventory.json'));
        });
        assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
    });
});

test('a shadowed emitted exporter cannot forge evidence for an implemented source entry', async t => {
    if (unavailable) return t.skip(unavailable);
    for (const target of ['HTML5', 'BILIBILI']) await t.test(target, async t => {
        if (!sdk.manifest.catalog.profiles.some(item => item.target === target)) return t.skip('SDK does not contain this target.');
        const paths = await create(t, '2d-basic', target);
        if (target === 'BILIBILI') {
            const config = JSON.parse(await fs.readFile(path.join(paths.project, 'game.json'), 'utf8'));
            config.appId = 'compiler-export-test';
            await fs.writeFile(path.join(paths.project, 'game.json'), JSON.stringify(config));
        }
        await fs.writeFile(path.join(paths.project, 'src/main.ts'), 'export async function start(): Promise<void> {}');
        const original = promises.writeFile;
        let intercepted = false;
        // Corrupt only disposable emitted bytes, never SDK files or source inputs.
        promises.writeFile = async (filename, bytes, ...args) => {
            if (path.basename(String(filename)) === 'main.js' && path.basename(path.dirname(String(filename))) === 'compiled') {
                intercepted = true;
                bytes = `System.register([], function (_export, _context) {
    function decoy(_export) { _export("start", async function () {}); }
    _export("marker", 1);
    return { setters: [], execute: function () {} };
});`;
            }
            return original(filename, bytes, ...args);
        };
        try {
            await assert.rejects(runGameOperation(request(paths, 'game_build', { ...buildInput('2d-basic'), target }), sdk), error => {
                assert.equal(error.code, 'TYPECHECK_FAILED', error.stack);
                assert(error.report.items.some(item => item.file === 'src/main.ts' && /no verified runtime export/.test(item.message)));
                return true;
            });
        } finally { promises.writeFile = original; }
        assert(intercepted, 'The actual SDK compiler output must exercise the scope-aware guard');
        assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
    });
});

test('residual ES modules from old SDK type-only emit are rejected globally before publication', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    await fs.writeFile(path.join(paths.project, 'src/model.ts'), 'export interface GameState { score: number; }');
    for (const target of ['HTML5', 'BILIBILI']) {
        if (!sdk.manifest.catalog.profiles.some(item => item.target === target)) continue;
        if (target === 'BILIBILI') {
            const template = sdk.template(sdk.manifest.catalog.templates.find(item => item.target === target && item.profile === '2d-basic' && item.variant === 'debug').id);
            const config = JSON.parse(await fs.readFile(path.join(path.dirname(template.directory), 'game.json'), 'utf8'));
            config.appId = 'compiler-export-test';
            await fs.writeFile(path.join(paths.project, 'game.json'), JSON.stringify(config));
        }
        const job = request(paths, 'game_build', { ...buildInput('2d-basic'), target });
        let report;
        try { report = await runGameOperation(job, sdk); }
        catch (error) {
            assert.equal(error.code, 'UNSUPPORTED_PROJECT', error.stack);
            assert(error.report.items.some(item => /model\.js$/.test(item.file) && /upgrade|regenerate/i.test(item.message)), JSON.stringify(error.report));
            assert.equal(error.report.artifacts, undefined);
        }
        const output = await fs.readFile(path.join(job.staging, 'compiled/model.js'), 'utf8');
        if (output.includes('export {}')) assert.equal(report, undefined, 'Old invalid output must not be accepted as working compatibility');
        else assert.equal(report.artifacts.length, 1, 'A regenerated fixed SDK supports type-only modules');
        assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
    }
});

test('startup permissions, logic execution, and private destinations fail closed', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await fixture(t);
    const denied = request(paths, 'project_check', checkInput('2d-basic'), { permissions: { mode: 'read-only', preview: false, executeTests: false } });
    await assert.rejects(runGameOperation(denied, sdk), code('PERMISSION_DENIED'));
    await absent(denied.staging);
    await assert.rejects(runGameOperation({ ...denied, permissions: undefined }, sdk), code('PERMISSION_DENIED'));
    const logic = request(paths, 'project_check', { ...checkInput('2d-basic'), checks: ['logic'] },
        { permissions: { mode: 'develop', preview: false, executeTests: true } });
    await assert.rejects(runGameOperation(logic, sdk), code('UNSUPPORTED_PROJECT'));
    await absent(logic.staging);
    await assert.rejects(runGameOperation(request(paths, 'game_build', buildInput('2d-basic'), { artifactId: undefined }), sdk), code('INVALID_ARGUMENTS'));
    await assert.rejects(runGameOperation(request(paths, 'project_check', checkInput('2d-basic'), { expectedSdkId: 'wrong' }), sdk), code('SDK_INCOMPLETE'));
    for (const directory of ['.', '../escape', '.git/new', '.env', '.cocos4-state/new', 'CON/game']) {
        await assert.rejects(runGameOperation(request(paths, 'project_create', { directory, projectName: 'test', templateId: sdk.manifest.catalog.templates[0].id }), sdk),
            error => ['OUTPUT_CONFLICT', 'PERMISSION_DENIED', 'PATH_OUTSIDE_WORKSPACE'].includes(error.code));
    }
});

test('legacy debug-only SDK rejects unavailable release profiles before staging', { timeout: 120000 }, async t => {
    try { assert.ok((await fs.lstat(legacyRoot)).isDirectory(), 'LEGACY_HTML5_SDK_ROOT must be a directory'); }
    catch (error) {
        if (error.code === 'ENOENT' && process.env.LEGACY_HTML5_SDK_ROOT === undefined && process.env.GAME_SDK_INTEGRATION !== '1') {
            return t.skip('Saved debug-only SDK absent; set LEGACY_HTML5_SDK_ROOT to require missing-profile verification.');
        }
        throw error;
    }
    const manifestBytes = await fs.readFile(path.join(legacyRoot, 'manifest.json'));
    const legacy = await loadSdk(legacyRoot);
    assert.deepEqual(legacy.manifest.catalog.profiles.map(item => `${item.target}/${item.id}/${item.variant}`).sort(),
        ['HTML5/2d-basic/debug', 'HTML5/3d-basic/debug']);
    const paths = await fixture(t, legacy);
    const operation = request(paths, 'game_build', { ...buildInput('2d-basic'), variant: 'release' });
    const logs = [];
    await assert.rejects(runGameOperation(operation, legacy, text => logs.push(text)), code('PROFILE_NOT_AVAILABLE'));
    assert.deepEqual(logs, [], 'Profile rejection must precede snapshot and compiler work');
    await absent(operation.staging);
    assert.deepEqual(await fs.readdir(paths.workspace), []);
    assert.deepEqual(await fs.readdir(paths.state), ['artifacts']);
    assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
    assert.deepEqual(await fs.readFile(path.join(legacyRoot, 'manifest.json')), manifestBytes);
});

test('read-only project files and directories remain unchanged after a real build', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    const contents = await allFiles(paths.project);
    const directories = [paths.workspace, paths.project, path.join(paths.project, 'src'), path.join(paths.project, 'types'), path.join(paths.project, 'assets')];
    for (const name of contents.keys()) await fs.chmod(path.join(paths.project, name), 0o444);
    for (const directory of directories) await fs.chmod(directory, 0o555);
    const stamps = new Map();
    for (const name of contents.keys()) {
        const stat = await fs.stat(path.join(paths.project, name), { bigint: true });
        stamps.set(name, `${stat.ino}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`);
    }
    try {
        const report = await runGameOperation(request(paths, 'game_build', buildInput('2d-basic')), sdk);
        assert.equal(report.artifacts.length, 1);
        assert.deepEqual(await allFiles(paths.project), contents);
        for (const name of contents.keys()) {
            const stat = await fs.stat(path.join(paths.project, name), { bigint: true });
            assert.equal(`${stat.ino}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`, stamps.get(name));
        }
    } finally { for (const directory of directories) await fs.chmod(directory, 0o700); }
});

test('SDK executable replacement after loadSdk is rejected before execution; replacement after snapshot cannot redirect require', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    const copy = path.join(paths.root, 'sdk');
    await fs.cp(sdkRoot, copy, { recursive: true });
    const copied = await loadSdk(copy);
    const compiler = path.join(copy, 'toolchain/compiler/compile-game.cjs');
    let changed = false;
    const job = request(paths, 'project_check', checkInput('2d-basic'), { sdkRoot: copy });
    const report = await runGameOperation(job, copied, text => {
        if (text.startsWith('Running')) {
            writeFileSync(compiler, 'globalThis.__unverifiedCompilerExecuted = true; throw new Error("UNVERIFIED SDK CODE");');
            changed = true;
        }
    });
    assert(changed);
    assert(report.validationLevels.includes('gameTypecheck'));
    assert.equal(globalThis.__unverifiedCompilerExecuted, undefined);
    await assert.rejects(runGameOperation(request(paths, 'project_check', checkInput('2d-basic'), { sdkRoot: copy }), copied), code('SDK_INCOMPLETE'));
    assert.equal(globalThis.__unverifiedCompilerExecuted, undefined);
});

test('compiler dependency resolution cannot escape the private closure to engine/root fallback', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    const outside = path.join(paths.root, 'outside.cjs');
    await fs.writeFile(outside, 'globalThis.__fallbackExecuted = true; throw new Error("FALLBACK EXECUTED");');
    const original = Module._resolveFilename;
    let redirected = false;
    Module._resolveFilename = function (request, ...args) {
        if (request.endsWith(path.join('node_modules', 'typescript', 'lib', 'typescript.js'))) { redirected = true; return outside; }
        return original.call(this, request, ...args);
    };
    try {
        await assert.rejects(runGameOperation(request(paths, 'project_check', checkInput('2d-basic')), sdk), error => {
            assert.match(JSON.stringify(error.report), /outside its private verified closure/);
            return true;
        });
        assert(redirected);
        assert.equal(globalThis.__fallbackExecuted, undefined);
    } finally { Module._resolveFilename = original; }
});

test('real compiler input changes prevent success and never publish worker output', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    let changed = false;
    const job = request(paths, 'game_build', buildInput('2d-basic'));
    await assert.rejects(runGameOperation(job, sdk, text => {
        if (text.startsWith('Running')) { writeFileSync(path.join(paths.project, 'src/world.ts'), 'changed'); changed = true; }
    }), code('INPUT_CHANGED'));
    assert(changed);
    assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
});

test('build rejects unimported Creator assets and does not publish stale starter assets', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    await fs.writeFile(path.join(paths.project, 'assets/level.scene'), '{}');
    await assert.rejects(runGameOperation(request(paths, 'game_build', buildInput('2d-basic')), sdk), code('UNSUPPORTED_PROJECT'));
    assert.deepEqual(await fs.readdir(paths.artifactsRoot), []);
});

test('project publication never replaces an existing directory/file/symlink and pins destination ancestors', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await fixture(t);
    const job = request(paths, 'project_create', { directory: 'nested/new-game', projectName: 'test', templateId: sdk.manifest.catalog.templates[0].id });
    const report = await runGameOperation(job, sdk);
    const nested = path.join(paths.workspace, 'nested');
    const destination = path.join(nested, 'new-game');
    await fs.mkdir(nested);
    for (const kind of ['empty-directory', 'file', 'symlink']) {
        if (kind === 'empty-directory') await fs.mkdir(destination);
        else if (kind === 'file') await fs.writeFile(destination, 'KEEP USER DATA');
        else await directoryLink(paths.root, destination);
        await assert.rejects(commitGameOutput(job, job, report), code('OUTPUT_CONFLICT'));
        if (kind === 'file') assert.equal(await fs.readFile(destination, 'utf8'), 'KEEP USER DATA');
        await fs.rm(destination, { recursive: true });
        assert((await fs.stat(path.join(job.staging, 'output'))).isDirectory());
    }
    await fs.rmdir(nested);
    await directoryLink(paths.root, nested);
    await assert.rejects(commitGameOutput(job, job, report), code('PATH_OUTSIDE_WORKSPACE'));
    await absent(path.join(paths.root, 'new-game'));
});

test('parent rejects payload/hash/inventory tampering and artifact destination conflicts', async t => {
    if (unavailable) return t.skip(unavailable);
    const paths = await create(t);
    const job = request(paths, 'game_build', buildInput('2d-basic'));
    const report = await runGameOperation(job, sdk);
    const artifact = report.artifacts[0];
    const output = path.join(job.staging, 'output');
    const main = path.join(output, 'game/main.js');
    const original = await fs.readFile(main);
    await fs.chmod(main, 0o600);
    await fs.writeFile(main, 'TAMPERED');
    await assert.rejects(commitGameOutput(job, job, report), code('ARTIFACT_INVALID'));
    await fs.writeFile(main, original);
    if (process.platform === 'win32') await grantOtherUsersRead(main);
    else await fs.chmod(main, 0o644);
    await assert.rejects(commitGameOutput(job, job, report), code('ARTIFACT_INVALID'));
    if (process.platform === 'win32') await enforceWindowsPrivate(main);
    else await fs.chmod(main, 0o600);
    await fs.mkdir(path.join(output, 'empty-unlisted'), { mode: 0o700 });
    await assert.rejects(commitGameOutput(job, job, report), code('ARTIFACT_INVALID'));
    await fs.rmdir(path.join(output, 'empty-unlisted'));
    await fs.writeFile(path.join(output, 'extra.txt'), 'unlisted');
    await assert.rejects(commitGameOutput(job, job, report), code('ARTIFACT_INVALID'));
    await fs.unlink(path.join(output, 'extra.txt'));
    await assert.rejects(commitGameOutput(job, job, { ...report, artifacts: [{ ...artifact, sha256: '0'.repeat(64) }] }), code('ARTIFACT_INVALID'));
    const inventory = path.join(output, 'artifact-inventory.json');
    const inventoryBytes = await fs.readFile(inventory);
    await fs.chmod(inventory, 0o600);
    await fs.writeFile(inventory, '{');
    await assert.rejects(commitGameOutput(job, job, { ...report, artifacts: [{ ...artifact, sha256: hash('{') }] }), code('ARTIFACT_INVALID'));
    await fs.writeFile(inventory, inventoryBytes);
    const destination = path.join(paths.artifactsRoot, `artifact-${artifact.artifactId}`);
    await fs.mkdir(destination);
    await assert.rejects(commitGameOutput(job, job, report), code('OUTPUT_CONFLICT'));
    assert.deepEqual(await fs.readdir(destination), []);
    await fs.rmdir(destination);
    await commitGameOutput(job, job, report);
    assert.equal(hash(await fs.readFile(path.join(destination, 'artifact-inventory.json'))), artifact.sha256);
});

test('snapshot primitives reject project symlinks/hardlinks/private files and unsafe staging', async t => {
    const paths = await fixture(t);
    const trusted = path.join(paths.root, 'sdk');
    await fs.mkdir(trusted);
    await fs.writeFile(path.join(trusted, 'compiler.cjs'), 'trusted');
    const inventory = { root: trusted, files: [{ path: 'compiler.cjs', bytes: 7, sha256: hash('trusted') }] };
    const snapshot = (staging = path.join(paths.state, randomUUID())) => withGameSnapshot(paths.workspace, '.', staging, inventory, async () => 'safe');
    await fs.symlink(path.join(trusted, 'compiler.cjs'), path.join(paths.workspace, 'file'), 'file');
    await assert.rejects(snapshot(), code('PATH_OUTSIDE_WORKSPACE'));
    await fs.unlink(path.join(paths.workspace, 'file'));
    await fs.link(path.join(trusted, 'compiler.cjs'), path.join(paths.workspace, 'file'));
    await assert.rejects(snapshot(), code('PERMISSION_DENIED'));
    await fs.unlink(path.join(paths.workspace, 'file'));
    await fs.writeFile(path.join(paths.workspace, '.env'), 'DO NOT COPY');
    await assert.rejects(snapshot(), code('PERMISSION_DENIED'));
    await fs.unlink(path.join(paths.workspace, '.env'));
    const publicState = path.join(paths.root, 'public-state');
    await fs.mkdir(publicState, { mode: 0o755 });
    if (process.platform === 'win32') await grantOtherUsersRead(publicState);
    await assert.rejects(snapshot(publicState), code('PERMISSION_DENIED'));
    await assert.rejects(snapshot(path.join(paths.workspace, 'state')), code('PERMISSION_DENIED'));
    await directoryLink(paths.state, path.join(paths.root, 'state-link'));
    await assert.rejects(snapshot(path.join(paths.root, 'state-link', 'job')), code('PATH_OUTSIDE_WORKSPACE'));
});

test('atomic publication uses inherited no-follow pins: destination and ancestor races fail closed', async t => {
    const paths = await fixture(t);
    const staging = path.join(paths.state, 'job');
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.mkdir(path.join(staging, 'output'), { mode: 0o700 });
    await fs.writeFile(path.join(staging, 'output/file'), 'payload', { mode: 0o600 });
    await privateFixtureTree(staging);
    const parent = path.join(paths.workspace, 'parent');
    await fs.mkdir(parent);
    const context = { ...paths, staging };
    await assert.rejects(publishGameOutput(context, { project: 'parent/game' }, () => {
        writeFileSync(path.join(parent, 'game'), 'CONCURRENT USER FILE');
    }), code('OUTPUT_CONFLICT'));
    assert.equal(await fs.readFile(path.join(parent, 'game'), 'utf8'), 'CONCURRENT USER FILE');
    await fs.unlink(path.join(parent, 'game'));
    if (process.platform === 'win32') {
        // The Windows backend holds non-delete-shared leases. A concurrent
        // ancestor rename is prevented while the original output is published.
        let attempted = false;
        await publishGameOutput(context, { project: 'parent/game' }, files => {
            attempted = true;
            assert.equal(files.get('file').toString(), 'payload');
            assert.throws(() => renameSync(parent, path.join(paths.workspace, 'moved')), error =>
                ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
        });
        assert(attempted);
        assert.equal(await fs.readFile(path.join(parent, 'game/file'), 'utf8'), 'payload');
        await absent(path.join(paths.workspace, 'moved'));
        return;
    }
    const original = promises.open;
    let swapped = false;
    promises.open = async (filename, flags, ...args) => {
        const handle = await original(filename, flags, ...args);
        if (!swapped && (flags & constants.O_DIRECTORY) && String(filename).endsWith('/parent')) {
            swapped = true;
            await fs.rename(parent, path.join(paths.workspace, 'moved'));
            await fs.mkdir(parent);
        }
        return handle;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(publishGameOutput(context, { project: 'parent/game' }, () => {}), code('INPUT_CHANGED')); }
    finally { promises.open = original; syncBuiltinESMExports(); }
    assert(swapped);
    assert.equal(await fs.readFile(path.join(staging, 'output/file'), 'utf8'), 'payload');
    await absent(path.join(parent, 'game'));
});
