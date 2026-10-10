import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSupervisorWin32, buildWindowsSupervisorFixture } from '../scripts/build-supervisor-win32.mjs';
import { prepareWindowsComponents, requireWindowsNodePin, requireWindowsComponentsManifest,
    verifyWindowsComponents, summarizeNodePe, WINDOWS_COMPONENT_ROOT, WINDOWS_COMPONENT_FILES,
    WINDOWS_COMPONENT_BLOCKERS } from '../scripts/prepare-windows-components.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const pin = JSON.parse(await fs.readFile(new URL('../packaging/node-win32-lock.json', import.meta.url), 'utf8'));
const legacyLinuxAssembly = { skip: process.platform !== 'linux' ? 'The retained component-only crossbuild uses Linux unzip/LLVM; Windows portable assembly has separate coverage.' : false };
function seal(value) {
    const { componentId, ...body } = value;
    return { ...body, componentId: `sha256-${hash(canonical(body))}` };
}
function metadata() {
    // Metadata-only fixtures: these are NOT valid executables or package evidence.
    const files = [...WINDOWS_COMPONENT_FILES].sort().map(name => ({ path: name,
        bytes: name === 'runtime/node.exe' ? 93580104 : 0, sha256: hash(''), source: { kind: 'metadata-test-fixture' } }));
    return seal({ schema: 'cocos4-windows-host-components/v1', kitVersion: '0.0.0-candidate',
        archiveRoot: WINDOWS_COMPONENT_ROOT, status: 'blocked', operationalDevkit: false, distributionApproved: false,
        host: { platform: 'win32', arch: 'x64', verified: false, acceptanceTarget: 'supported Windows 11 x64' },
        runtime: { node: { version: pin.version, bytes: 93580104, sha256: hash(''), archiveSha256: pin.sha256, executionTested: false } },
        components: [['supervisor', 'cocos4-supervise.exe'], ['acceptance-fixture', 'windows-supervisor-fixture.exe']]
            .map(([component, name]) => ({ component, file: `build/windows-host/${name}`, sha256: hash(''),
                evidence: `build/windows-host/${name}.json`, executionTested: false })),
        source: { revision: 'a'.repeat(40), dirty: true, statusSha256: hash('dirty'), inputsSha256: hash('test inputs') },
        blockers: [...WINDOWS_COMPONENT_BLOCKERS], files,
        checksumScope: 'Metadata fixture only; no authentication, execution or approval.' });
}
async function fixture(t) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cocos4-windows-components-test-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { directory, out: path.join(directory, 'components'), nodeArchive: path.join(directory, 'input.zip'),
        compiler: path.join(directory, 'unused-zig') };
}

test('reviewed Node pin cannot silently switch source, version, target or selected members', () => {
    assert.equal(requireWindowsNodePin(pin), pin);
    for (const change of [{ version: '24.22.0' }, { target: 'linux-x64' }, { archiveRoot: '../escape' },
        { url: 'https://example.com/node.zip' }, { checksumsUrl: 'http://nodejs.org/checksums' },
        { sha256: '0'.repeat(64) }, { files: ['node.exe', '../LICENSE', 'README.md'] }]) {
        assert.throws(() => requireWindowsNodePin({ ...pin, ...change }));
    }
});

test('configuration rejects relative/aliased/unsafe paths and SDK/release options before work', legacyLinuxAssembly, async t => {
    const options = await fixture(t);
    const { out, nodeArchive, directory, compiler } = options;
    assert.equal(path.dirname(directory), await fs.realpath(tmpdir()));
    for (const value of [undefined, {}, { out: 'relative', nodeArchive, compiler }, { out, nodeArchive: 'relative', compiler },
        { out: `${out}/../other`, nodeArchive, compiler }, { out, nodeArchive, compiler: 'zig' },
        { out, nodeArchive, compiler, sdkRoot: directory }, { out, nodeArchive, compiler, kitVersion: '1.0.0' },
        { out: path.join(directory, 'bad\nname'), nodeArchive, compiler }]) {
        await assert.rejects(prepareWindowsComponents(value));
    }
    const alias = path.join(directory, 'alias');
    await fs.symlink(directory, alias);
    await assert.rejects(prepareWindowsComponents({ out: path.join(alias, 'out'), nodeArchive, compiler }), /canonical/);
    assert.deepEqual(await fs.readdir(directory), ['alias']);
});

test('assembler and both crossbuilders require an explicit absolute compiler without building', legacyLinuxAssembly, async t => {
    const { out, nodeArchive, directory } = await fixture(t);
    await assert.rejects(prepareWindowsComponents({ out, nodeArchive }), /absolute compiler/);
    await assert.rejects(buildSupervisorWin32(), /explicit absolute Zig/);
    for (const compiler of [undefined, null, '', 'zig', './zig']) {
        await assert.rejects(prepareWindowsComponents({ out, nodeArchive, compiler }), /absolute compiler/);
        for (const build of [buildSupervisorWin32, buildWindowsSupervisorFixture]) {
            await assert.rejects(build({ output: path.join(directory, 'unused.exe'), compiler }), /explicit absolute Zig/);
        }
    }
    assert.deepEqual(await fs.readdir(directory), []);
});

test('Windows acceptance is outside Linux test discovery and explicitly rejects the wrong host', legacyLinuxAssembly, async t => {
    assert.equal(process.platform, 'linux', 'This regression checks wrong-host rejection on Linux');
    const { directory } = await fixture(t);
    const harness = 'windows-supervisor.mjs';
    const tests = await fs.readdir(new URL('./', import.meta.url));
    assert(tests.includes(harness));
    assert(!tests.filter(name => name.endsWith('.test.mjs')).some(name => name.startsWith('windows-supervisor')));
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/);
    assert(WINDOWS_COMPONENT_FILES.includes(`test/${harness}`));
    assert(!WINDOWS_COMPONENT_FILES.includes('test/windows-supervisor.test.mjs'));
    const env = { ...process.env, COCOS4_WINDOWS_ACCEPTANCE_DIR: path.join(directory, 'must-not-exist') };
    delete env.NODE_TEST_CONTEXT;
    await assert.rejects(run(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL(harness, import.meta.url))],
        { env, timeout: 10000, maxBuffer: 65536 }), error => {
        assert.equal(error.code, 1);
        assert.match(error.stdout + error.stderr, /requires a win32 host/);
        assert.match(error.stdout, /^# skipped 0$/m);
        assert.doesNotMatch(error.stdout, /# SKIP/);
        return true;
    });
    assert.deepEqual(await fs.readdir(directory), []);
});

test('every existing destination/companion is retained before archive access or compilation', legacyLinuxAssembly, async t => {
    for (const suffix of ['', '.zip', '.zip.sha256', '.build.json']) {
        const { directory, out, nodeArchive, compiler } = await fixture(t);
        const conflict = `${out}${suffix}`;
        await fs.writeFile(conflict, 'retain');
        await assert.rejects(prepareWindowsComponents({ out, nodeArchive, compiler }), /OUTPUT_CONFLICT/);
        assert.equal(await fs.readFile(conflict, 'utf8'), 'retain');
        assert.deepEqual(await fs.readdir(directory), [path.basename(conflict)]);
    }
    for (const kind of ['directory', 'symlink']) {
        const { directory, out, nodeArchive, compiler } = await fixture(t);
        if (kind === 'directory') await fs.mkdir(out);
        else await fs.symlink(path.join(directory, 'missing'), out);
        const before = await fs.lstat(out);
        await assert.rejects(prepareWindowsComponents({ out, nodeArchive, compiler }), /OUTPUT_CONFLICT/);
        assert.equal((await fs.lstat(out)).ino, before.ino);
    }
});

test('missing or tampered Node input fails before extraction, tool invocation or staging', legacyLinuxAssembly, async t => {
    const { directory, out, nodeArchive, compiler } = await fixture(t);
    await assert.rejects(prepareWindowsComponents({ out, nodeArchive, compiler }), { code: 'ENOENT' });
    await fs.writeFile(nodeArchive, 'not the official ZIP');
    await assert.rejects(prepareWindowsComponents({ out, nodeArchive, compiler }), /NODE_ARCHIVE_HASH_MISMATCH/);
    assert.deepEqual(await fs.readdir(directory), ['input.zip']);
    const link = path.join(directory, 'link.zip');
    await fs.symlink(nodeArchive, link);
    await assert.rejects(prepareWindowsComponents({ out, nodeArchive: link, compiler }), /regular file/);
});

test('valid blocked metadata is not operational, authenticated, or Windows acceptance evidence', () => {
    const manifest = requireWindowsComponentsManifest(metadata());
    assert.equal(manifest.status, 'blocked');
    assert.equal(manifest.host.verified, false);
    assert.equal(manifest.operationalDevkit, false);
    assert.equal(manifest.distributionApproved, false);
    assert.equal(manifest.source.dirty, true);
    assert(!manifest.files.some(file => file.path === 'cocos4.exe' || file.path.startsWith('sdk/')));
    assert(WINDOWS_COMPONENT_BLOCKERS.some(text => text.includes('Windows 11')));
});

test('even rehashed manifests cannot promote status, host, execution, SDK or distribution claims', () => {
    const changes = [value => { value.status = 'qualified'; }, value => { value.operationalDevkit = true; },
        value => { value.distributionApproved = true; }, value => { value.host.verified = true; },
        value => { value.host.acceptanceTarget = 'Windows 10'; }, value => { value.sdk = {}; },
        value => { value.capabilities = ['game-build']; }, value => { value.blockers.pop(); },
        value => { value.runtime.node.executionTested = true; }, value => { value.components[0].executionTested = true; },
        value => { value.files.pop(); }, value => { value.files[0].path = '../escape'; },
        value => { value.files[0].path = 'cocos4.exe'; }, value => { value.source.dirty = 'false'; }];
    for (const change of changes) {
        const value = metadata();
        change(value);
        assert.throws(() => requireWindowsComponentsManifest(seal(value)));
    }
});

test('metadata tampering is an integrity error; a recomputed checksum is still not source authentication', async t => {
    const value = metadata();
    value.files[0].sha256 = hash('tampered');
    assert.throws(() => requireWindowsComponentsManifest(value), /identity mismatch/);
    const rewritten = seal(value);
    assert.equal(requireWindowsComponentsManifest(rewritten).status, 'blocked');
    assert.notEqual(rewritten.componentId, metadata().componentId);
    const { directory } = await fixture(t);
    await fs.writeFile(path.join(directory, 'components.json'), `${canonical(value)}\n`);
    await assert.rejects(verifyWindowsComponents(directory), /identity mismatch/);
    await fs.writeFile(path.join(directory, 'components.json'), `${canonical(metadata())}\n`);
    await assert.rejects(verifyWindowsComponents(directory, rewritten.componentId), /Unexpected component identity/);
    await assert.rejects(verifyWindowsComponents(directory), /Missing component entries/);
});

const peText = (library = 'KERNEL32.dll') => `Format: COFF-x86-64
  Machine: IMAGE_FILE_MACHINE_AMD64 (0x8664)
  Magic: 0x20B
  DelayImportDescriptorRVA: 0x0
  DelayImportDescriptorSize: 0x0
  CertificateTableSize: 0x100
  BaseRelocationTableSize: 0x200
Import {
  Name: ${library}
  Symbol: LoadLibraryW (1)
  Symbol: GetProcAddress (2)
  Symbol:  (116)
}
`;

test('PE summaries preserve ordinal/dynamic imports and flag unknown DLLs without declaring safety', () => {
    const known = summarizeNodePe(peText());
    assert.deepEqual(known.imports[0].symbols, ['LoadLibraryW', 'GetProcAddress', '#116']);
    assert.deepEqual(known.dynamicLoadingSymbols, ['LoadLibraryW', 'GetProcAddress']);
    assert.deepEqual(known.unreviewedLibraries, []);
    assert.equal(known.dependencyClosureVerified, false);
    assert.equal(known.executionTested, false);
    assert.equal(known.authenticodeVerified, false);
    assert.equal(known.certificateTableBytes, 256);
    const unknown = summarizeNodePe(peText('UNREVIEWED.dll'));
    assert.deepEqual(unknown.unreviewedLibraries, ['UNREVIEWED.dll']);
    assert.equal(unknown.dependencyClosureVerified, false);
});

test('PE parsing rejects missing, truncated, oversized or unaccounted delay import evidence', () => {
    for (const text of ['', peText().replace('0x8664', '0x14C'), peText().replace('}\n', ''),
        peText().replace('DelayImportDescriptorSize: 0x0', 'DelayImportDescriptorSize: 0x20'),
        peText('../outside.dll'), 'x'.repeat(4 * 1024 ** 2 + 1)]) assert.throws(() => summarizeNodePe(text));
    const delay = peText().replace('DelayImportDescriptorSize: 0x0', 'DelayImportDescriptorSize: 0x20')
        + 'DelayImport {\n  Name: NEW.dll\n  Symbol: Delayed (1)\n}\n';
    const summary = summarizeNodePe(delay);
    assert.equal(summary.imports[1].kind, 'delay');
    assert.deepEqual(summary.unreviewedLibraries, ['NEW.dll']);
    assert.equal(summary.dependencyClosureVerified, false);
});
