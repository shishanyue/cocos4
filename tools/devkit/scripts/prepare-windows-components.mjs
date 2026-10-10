// Historical component assembly is Linux-only. extractWindowsNode is the offline
// Windows/Linux input preparation shared by the operational portable assembler.
// Neither path executes Windows binaries.
// Inputs and the canonical output parent must be trusted and quiescent; this is
// not a pinned workspace reader, general ZIP extractor, or application publisher.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { archiveWindows, verifyWindowsArchive, readStable, WINDOWS_ARCHIVE_LIMITS } from './windows-archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const engine = path.resolve(root, '../..');
const run = promisify(execFile);
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const json = value => Buffer.from(`${canonical(value)}\n`);
const maximum = WINDOWS_ARCHIVE_LIMITS.fileBytes;
export const WINDOWS_COMPONENT_ROOT = 'cocos4-windows-host-components-0.0.0-candidate-win32-x64';
const nodeSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const nodeBytes = 93580104;
export const WINDOWS_COMPONENT_BLOCKERS = Object.freeze([
    'Windows filesystem identity, reparse-point and stable-handle policy are not implemented for the application.',
    'Windows ACL/ownership, extraction and DLL search/dependency policies are not qualified.',
    'Windows private state, locks, recovery and job persistence are not implemented.',
    'Windows atomic no-replace application publication is not implemented.',
    'Windows compiler and package I/O integration is not implemented; no compiler or SDK is delivered.',
    'Windows preview authorization, serving and browser integration are not implemented.',
    'Windows launcher, application/MCP/CLI and supervisor integration are not implemented; no cocos4.exe or game capability is delivered.',
    'Real supported Windows 11 x64 host acceptance, including bundled Node and DLL/ACL behavior, has not run.',
    'Redistribution, complete linked-runtime license closure and source authentication are not approved by this checksum inventory.',
]);
const sources = [
    ['LICENSE', 'LICENSE'], ['AUTHORS.txt', 'AUTHORS.txt'],
    ...['runtime/supervise-win32.c', 'test/fixtures/windows-supervisor-fixture.c',
        'test/windows-supervisor.mjs', 'test/fixtures/windows-node-runner.mjs',
        'scripts/build-supervisor-win32.mjs', 'scripts/windows-archive.mjs',
        'scripts/prepare-windows-components.mjs', 'scripts/prepare-sdk.mjs',
        'packaging/node-win32-lock.json', 'packaging/WINDOWS-COMPONENTS.md',
        'test/windows-archive.test.mjs', 'test/windows-components.test.mjs'].map(name => [`tools/devkit/${name}`, name]),
    ['tools/devkit/package.json', 'provenance/devkit-package.json'],
    ['tools/devkit/package-lock.json', 'provenance/devkit-package-lock.json'],
];
export const WINDOWS_COMPONENT_FILES = Object.freeze([...sources.map(([, destination]) => destination), 'README.md', 'NOTICES.md',
    'runtime/node.exe', 'runtime/LICENSE', 'runtime/README.md',
    'build/windows-host/cocos4-supervise.exe', 'build/windows-host/cocos4-supervise.exe.json',
    'build/windows-host/windows-supervisor-fixture.exe', 'build/windows-host/windows-supervisor-fixture.exe.json',
    'evidence/node-pe.txt', 'evidence/node-pe.json', 'provenance/source-inputs.json',
    'provenance/git-status.porcelain-v1.z', 'notices/zig-LICENSE', 'notices/mingw-COPYING']);

export function requireWindowsNodePin(pin) {
    assert.equal(pin.schemaVersion, 1);
    assert.equal(pin.version, '24.21.0');
    assert.equal(pin.target, 'win-x64');
    assert.equal(pin.archiveRoot, 'node-v24.21.0-win-x64');
    assert.equal(pin.url, `https://nodejs.org/dist/v${pin.version}/${pin.archiveRoot}.zip`);
    assert.equal(pin.checksumsUrl, `https://nodejs.org/dist/v${pin.version}/SHASUMS256.txt`);
    assert.equal(pin.sha256, nodeSha256, 'Review a new Windows Node pin before changing it');
    assert.deepEqual(pin.files, ['node.exe', 'LICENSE', 'README.md']);
    return pin;
}

// These maintainer paths must be trusted and quiescent. This rejects existing
// aliases/reparse links; it is not a general hostile-workspace handle policy.
async function canonicalDirectory(directory) {
    absolute(directory, 'directory');
    for (let current = directory;; current = path.dirname(current)) {
        const stat = await fs.lstat(current, { bigint: true });
        assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected a real directory without symlinks or reparse links');
        assert.equal(await fs.realpath(current), current, 'Directory aliases are not allowed');
        if (path.dirname(current) === current) break;
    }
    return fs.lstat(directory, { bigint: true });
}

/** Prepare only the three reviewed Node members into an existing empty directory.
 * No network, npm installation, Node execution, or external archive utility is
 * used. Windows stable reads additionally check reparse attributes. A mismatching
 * input fails before any output member is created.
 */
export async function extractWindowsNode(options) {
    assert(options && Object.keys(options).length === 2
        && Object.keys(options).every(key => ['nodeArchive', 'output'].includes(key)),
    'Only nodeArchive and output are accepted');
    const { nodeArchive, output } = options;
    assert(['linux', 'win32'].includes(process.platform), 'Windows Node preparation requires Windows or Linux');
    absolute(nodeArchive, 'Node archive');
    absolute(output, 'output directory');
    await canonicalDirectory(path.dirname(nodeArchive));
    const outputStat = await canonicalDirectory(output);
    assert.deepEqual(await fs.readdir(output), [], 'NODE_OUTPUT_CONFLICT: output directory must be empty');
    const pin = requireWindowsNodePin(JSON.parse(await readStable(path.join(root, 'packaging/node-win32-lock.json'), 64 * 1024)));
    const archive = await readStable(nodeArchive, maximum);
    assert.equal(hash(archive), pin.sha256, 'NODE_ARCHIVE_HASH_MISMATCH: no extraction performed');
    const { readPinnedNodeArchive } = await import('./windows-archive.mjs');
    const members = await readPinnedNodeArchive(archive, pin);
    assert.deepEqual([...members.keys()].sort(), [...pin.files].sort(), 'Exact reviewed Node member inventory');
    assert.equal(members.get('node.exe')?.length, nodeBytes, 'Reviewed Node member size');
    const files = [];
    for (const member of pin.files) {
        const current = await canonicalDirectory(output);
        assert(current.dev === outputStat.dev && current.ino === outputStat.ino, 'Node output directory changed');
        const bytes = members.get(member);
        assert(Buffer.isBuffer(bytes) && bytes.length <= (member === 'node.exe' ? maximum : 1024 ** 2), 'Node member size bound');
        await fs.writeFile(path.join(output, member), bytes, { flag: 'wx', mode: 0o444 });
        const written = await readStable(path.join(output, member), maximum);
        assert(written.equals(bytes), `Node member changed after extraction: ${member}`);
        files.push({ path: member, bytes: bytes.length, sha256: hash(bytes) });
    }
    const finalStat = await canonicalDirectory(output);
    assert(finalStat.dev === outputStat.dev && finalStat.ino === outputStat.ino, 'Node output directory changed');
    assert.deepEqual((await fs.readdir(output)).sort(), [...pin.files].sort(), 'Unexpected Node output entry');
    return { version: pin.version, archiveSha256: pin.sha256, files };
}

// LLVM's bounded text report is retained verbatim. Import names are observations,
// not an allowlist proving OS availability or safe dynamic/transitive loading.
export function summarizeNodePe(text) {
    assert(typeof text === 'string' && Buffer.byteLength(text) <= 4 * 1024 ** 2, 'PE report bound');
    assert.match(text, /^Format: COFF-x86-64$/m);
    assert.match(text, /^  Machine: IMAGE_FILE_MACHINE_AMD64 \(0x8664\)$/m);
    assert.match(text, /^  Magic: 0x20B$/m);
    const number = name => {
        const match = text.match(new RegExp(`^\\s+${name}: (0x[0-9A-Fa-f]+|[0-9]+)$`, 'm'));
        assert(match, `Missing PE field ${name}`);
        return Number(match[1]);
    };
    const imports = [...text.matchAll(/^(Import|DelayImport) \{\n([\s\S]*?)^\}/gm)].map(([, kind, block]) => {
        const name = block.match(/^\s+Name: ([^\r\n]+)$/m)?.[1];
        assert(name && /^[A-Za-z0-9_.-]+\.dll$/i.test(name), 'Malformed DLL name');
        const symbols = [...block.matchAll(/^\s+Symbol: (.*?) \((\d+)\)$/gm)].map(([, name, ordinal]) => name || `#${ordinal}`);
        assert(symbols.length > 0 && symbols.length <= 16384, 'PE import symbol bound');
        return { kind: kind === 'Import' ? 'direct' : 'delay', library: name, symbols };
    });
    assert(imports.length > 0 && imports.length <= 128, 'PE import library bound');
    assert.equal(imports.length, [...text.matchAll(/^(?:Delay)?Import \{/gm)].length, 'Unparsed import block');
    const reviewedNames = new Set(['ADVAPI32.DLL', 'CRYPT32.DLL', 'DBGHELP.DLL', 'IPHLPAPI.DLL', 'KERNEL32.DLL',
        'OLE32.DLL', 'SHELL32.DLL', 'USER32.DLL', 'USERENV.DLL', 'WINMM.DLL', 'WS2_32.DLL']);
    const delay = { rva: number('DelayImportDescriptorRVA'), bytes: number('DelayImportDescriptorSize') };
    assert(!delay.bytes || imports.some(item => item.kind === 'delay'), 'Delay imports require a complete report');
    return { machine: 'AMD64', format: 'PE32+', imports, delayImportDirectory: delay,
        unreviewedLibraries: imports.filter(item => !reviewedNames.has(item.library.toUpperCase())).map(item => item.library),
        dependencyClosureVerified: false, executionTested: false, authenticodeVerified: false,
        certificateTableBytes: number('CertificateTableSize'),
        baseRelocationTableBytes: number('BaseRelocationTableSize'),
        dynamicLoadingSymbols: imports.flatMap(item => item.symbols).filter(name => /^(LoadLibrary|GetProcAddress)/.test(name)),
        scope: 'Direct/delay PE import observations only. Ordinal imports, dynamic loads, transitive DLLs, search paths and actual supported Windows hosts remain unqualified. Certificate presence is not signature verification; relocation directory size is not a full relocation audit.' };
}

function absolute(value, description = 'path') {
    assert(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && !value.includes('\0'),
        `Expected a canonical absolute ${description}`);
}
async function absent(filename) {
    await fs.lstat(filename).then(() => { throw new Error(`OUTPUT_CONFLICT: ${filename}`); }, error => {
        if (error.code !== 'ENOENT') throw error;
    });
}

// Metadata validity/integrity is deliberately distinct from operational qualification.
export function requireWindowsComponentsManifest(manifest) {
    assert.deepEqual(Object.keys(manifest).sort(), ['schema', 'kitVersion', 'archiveRoot', 'status', 'operationalDevkit',
        'distributionApproved', 'host', 'runtime', 'components', 'source', 'blockers', 'checksumScope', 'files', 'componentId'].sort(),
    'Exact component manifest schema');
    assert.equal(manifest.schema, 'cocos4-windows-host-components/v1');
    assert.equal(manifest.kitVersion, '0.0.0-candidate');
    assert.equal(manifest.status, 'blocked', 'Component status must remain blocked');
    assert.equal(manifest.operationalDevkit, false, 'Not an operational devkit');
    assert.equal(manifest.distributionApproved, false, 'Distribution is not approved');
    assert.deepEqual(manifest.host, { platform: 'win32', arch: 'x64', verified: false, acceptanceTarget: 'supported Windows 11 x64' });
    assert.equal(manifest.archiveRoot, WINDOWS_COMPONENT_ROOT);
    assert.deepEqual(manifest.blockers, WINDOWS_COMPONENT_BLOCKERS);
    assert(!('sdk' in manifest) && !('capabilities' in manifest), 'No SDK or game capability claims');
    assert(Array.isArray(manifest.files) && manifest.files.length <= 128, 'Component inventory bound');
    assert.deepEqual(manifest.files.map(file => file.path), [...WINDOWS_COMPONENT_FILES].sort(), 'Exact component-only file inventory');
    let total = 0;
    for (const file of manifest.files) {
        assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= maximum, 'Component file bound');
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
        assert(file.source && typeof file.source.kind === 'string', 'File source is required');
        total += file.bytes;
    }
    assert(total <= WINDOWS_ARCHIVE_LIMITS.totalBytes, 'Component total bound');
    const node = manifest.runtime?.node;
    assert.equal(node?.version, '24.21.0');
    assert.equal(node.archiveSha256, nodeSha256);
    assert.equal(node.bytes, nodeBytes);
    assert.equal(node.executionTested, false);
    assert.equal(node.sha256, manifest.files.find(file => file.path === 'runtime/node.exe').sha256);
    assert.equal(node.bytes, manifest.files.find(file => file.path === 'runtime/node.exe').bytes);
    assert.deepEqual(manifest.components, [['supervisor', 'cocos4-supervise.exe'], ['acceptance-fixture', 'windows-supervisor-fixture.exe']]
        .map(([component, basename]) => ({ component, file: `build/windows-host/${basename}`,
            sha256: manifest.files.find(file => file.path === `build/windows-host/${basename}`).sha256,
            evidence: `build/windows-host/${basename}.json`, executionTested: false })), 'Exact unexecuted component identities');
    assert.match(manifest.source.revision, /^[a-f0-9]{40,64}$/);
    assert.equal(typeof manifest.source.dirty, 'boolean');
    for (const key of ['statusSha256', 'inputsSha256']) assert.match(manifest.source[key], /^[a-f0-9]{64}$/);
    const { componentId, ...body } = manifest;
    assert.equal(componentId, `sha256-${hash(canonical(body))}`, 'Component manifest identity mismatch');
    return manifest;
}

export async function verifyWindowsComponents(directory, expectedId = undefined) {
    assert(['linux', 'win32'].includes(process.platform), 'Component verification requires Windows or Linux');
    absolute(directory);
    assert.equal(await fs.realpath(directory), directory, 'Component directory alias');
    const bytes = await readStable(path.join(directory, 'components.json'), 4 * 1024 ** 2);
    const manifest = requireWindowsComponentsManifest(JSON.parse(bytes));
    assert(bytes.equals(json(manifest)), 'Manifest must use canonical JSON');
    if (expectedId !== undefined) assert.equal(manifest.componentId, expectedId, 'Unexpected component identity');
    const expected = new Set(['components.json', ...manifest.files.map(file => file.path)]);
    for (const file of [...expected]) for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) expected.add(`${parent}/`);
    const found = new Set();
    async function walk(prefix = '') {
        for await (const entry of await fs.opendir(path.join(directory, prefix))) {
            const name = `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`;
            assert(expected.has(name) && !found.has(name), `Unexpected component entry: ${name}`);
            assert(entry.isFile() || entry.isDirectory(), 'Component symlink/special file');
            found.add(name);
            if (entry.isDirectory()) await walk(name);
        }
    }
    await walk();
    assert.deepEqual([...found].sort(), [...expected].sort(), 'Missing component entries');
    for (const file of manifest.files) {
        const bytes = await readStable(path.join(directory, file.path), maximum);
        assert.equal(bytes.length, file.bytes, `Component size mismatch: ${file.path}`);
        assert.equal(hash(bytes), file.sha256, `Component hash mismatch: ${file.path}`);
    }
    const inputs = JSON.parse(await readStable(path.join(directory, 'provenance/source-inputs.json'), 4 * 1024 ** 2));
    assert.equal(hash(canonical(inputs)), manifest.source.inputsSha256, 'Source inventory hash mismatch');
    assert.deepEqual(inputs.map(input => input.path), sources.map(([source]) => source).sort(), 'Exact selected source inventory');
    for (const input of inputs) {
        const destination = sources.find(([source]) => source === input.path)[1];
        const file = manifest.files.find(file => file.path === destination);
        assert.equal(input.sha256, file.sha256, `Source binding mismatch: ${input.path}`);
        assert.equal(input.bytes, file.bytes, `Source size mismatch: ${input.path}`);
    }
    assert.equal(manifest.source.statusSha256, manifest.files.find(file => file.path === 'provenance/git-status.porcelain-v1.z').sha256);
    return manifest;
}

export async function prepareWindowsComponents(options) {
    assert.equal(process.platform, 'linux', 'Component assembly requires Linux');
    assert(options && Object.keys(options).every(key => ['out', 'nodeArchive', 'compiler'].includes(key)), 'Only out, nodeArchive and compiler are accepted');
    const { out, nodeArchive, compiler } = options;
    absolute(out); absolute(nodeArchive);
    absolute(compiler, 'compiler');
    assert(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(path.basename(out)), 'Unsafe output basename');
    assert.equal(await fs.realpath(path.dirname(out)), path.dirname(out), 'Output parent must be canonical and exist');
    const suffixes = ['', '.zip', '.zip.sha256', '.build.json'];
    for (const suffix of suffixes) await absent(`${out}${suffix}`);
    const inputs = [];
    const contents = new Map();
    for (const [source] of sources) {
        const bytes = await readStable(path.join(engine, source), 4 * 1024 ** 2);
        inputs.push({ path: source, bytes: bytes.length, sha256: hash(bytes) });
        contents.set(source, bytes);
    }
    inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const pin = requireWindowsNodePin(JSON.parse(contents.get('tools/devkit/packaging/node-win32-lock.json')));
    const suppliedArchive = await readStable(nodeArchive, maximum);
    assert.equal(hash(suppliedArchive), pin.sha256, 'NODE_ARCHIVE_HASH_MISMATCH: no extraction or compilation performed');
    const { publishSdk } = await import('./prepare-sdk.mjs');
    const revision = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: engine, env, timeout: 10000, maxBuffer: 4096 })).stdout.trim();
    const status = (await run('/usr/bin/git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { cwd: engine, env, timeout: 10000, maxBuffer: 4 * 1024 ** 2, encoding: 'buffer' })).stdout;
    const source = { revision, dirty: status.length > 0, statusSha256: hash(status), inputsSha256: hash(canonical(inputs)),
        scope: 'Actual selected working-tree bytes, including dirty/untracked inputs. Git status is a point-in-time observation, not a clean-tree or source-authentication claim.' };
    const work = await fs.mkdtemp(path.join(path.dirname(out), '.windows-components-work-'));
    const staging = await fs.mkdtemp(path.join(path.dirname(out), '.windows-components-'));
    const files = [];
    const generated = { kind: 'generated', script: 'scripts/prepare-windows-components.mjs', inputsSha256: source.inputsSha256 };
    const write = async (name, bytes, origin) => {
        assert(WINDOWS_COMPONENT_FILES.includes(name) && !files.some(file => file.path === name), `Unexpected/duplicate payload: ${name}`);
        await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
        await fs.writeFile(path.join(staging, name), bytes, { flag: 'wx', mode: 0o444 });
        const file = { path: name, bytes: bytes.length, sha256: hash(bytes), source: origin };
        files.push(file);
        return file;
    };
    try {
        for (const [source, destination] of sources) await write(destination, contents.get(source), { kind: 'repository-source', path: source });
        await write('README.md', contents.get('tools/devkit/packaging/WINDOWS-COMPONENTS.md'),
            { kind: 'repository-source', path: 'tools/devkit/packaging/WINDOWS-COMPONENTS.md' });
        await write('provenance/source-inputs.json', json(inputs), generated);
        await write('provenance/git-status.porcelain-v1.z', status, generated);
        // Extract only these literal members from a private, hash-verified copy.
        const privateZip = path.join(work, 'node.zip');
        await fs.writeFile(privateZip, suppliedArchive, { flag: 'wx', mode: 0o400 });
        const extraction = path.join(work, 'node');
        await fs.mkdir(extraction, { mode: 0o700 });
        await run('/usr/bin/unzip', ['-q', '-n', privateZip, ...pin.files.map(name => `${pin.archiveRoot}/${name}`), '-d', extraction],
            { env, timeout: 120000, maxBuffer: 65536 });
        for (const member of pin.files) {
            const bytes = await readStable(path.join(extraction, pin.archiveRoot, member), member === 'node.exe' ? maximum : 1024 ** 2);
            if (member === 'node.exe') assert.equal(bytes.length, nodeBytes, 'Reviewed Node member size');
            await write(`runtime/${member}`, bytes, { kind: 'official-node-archive', url: pin.url, archiveSha256: pin.sha256, member: `${pin.archiveRoot}/${member}` });
        }
        assert.equal(hash(await readStable(privateZip, maximum)), pin.sha256, 'Private archive changed during extraction');
        const { buildSupervisorWin32, buildWindowsSupervisorFixture, inspectPeWin32 } = await import('./build-supervisor-win32.mjs');
        const components = [];
        for (const [build, basename] of [[buildSupervisorWin32, 'cocos4-supervise.exe'], [buildWindowsSupervisorFixture, 'windows-supervisor-fixture.exe']]) {
            const built = await build({ output: path.join(work, basename), compiler });
            const bytes = await readStable(built.output, 32 * 1024 ** 2);
            const evidenceBytes = await readStable(built.evidencePath, 1024 ** 2);
            const evidence = JSON.parse(evidenceBytes);
            assert.equal(hash(bytes), evidence.sha256);
            assert.equal(bytes.length, evidence.bytes);
            assert.equal(evidence.sourceSha256, hash(contents.get(`tools/devkit/${evidence.source}`)), 'Build evidence must match packaged C source');
            assert.deepEqual(evidence.pe, inspectPeWin32(bytes));
            const file = `build/windows-host/${basename}`;
            await write(file, bytes, { kind: 'crossbuilt-component', source: evidence.source, sourceSha256: evidence.sourceSha256, evidence: `${file}.json` });
            await write(`${file}.json`, evidenceBytes, { ...generated, kind: 'crossbuild-evidence', binarySha256: evidence.sha256 });
            components.push({ component: evidence.component, file, sha256: evidence.sha256, evidence: `${file}.json`, executionTested: false });
            if (components.length === 1) {
                for (const [relative, destination] of [['LICENSE', 'notices/zig-LICENSE'], ['lib/libc/mingw/COPYING', 'notices/mingw-COPYING']]) {
                    const filename = path.join(path.dirname(evidence.compiler.path), relative);
                    await write(destination, await readStable(filename, 1024 ** 2), { kind: 'compiler-installation-notice', path: filename, compilerSha256: evidence.compiler.sha256 });
                }
            }
        }
        const tool = await fs.realpath('/usr/bin/llvm-readobj');
        const toolHash = hash(await readStable(tool, maximum));
        const argumentsUsed = ['--file-headers', '--sections', '--coff-imports', '--coff-load-config', 'runtime/node.exe'];
        const peRun = await run('/usr/bin/llvm-readobj', argumentsUsed, { cwd: staging, env, timeout: 30000, maxBuffer: 4 * 1024 ** 2 });
        assert.equal(peRun.stderr, '', 'Unexpected LLVM PE diagnostic');
        const pe = summarizeNodePe(peRun.stdout);
        const node = files.find(file => file.path === 'runtime/node.exe');
        const peText = await write('evidence/node-pe.txt', Buffer.from(peRun.stdout), { ...generated, binarySha256: node.sha256 });
        const toolVersion = (await run('/usr/bin/llvm-readobj', ['--version'], { env, timeout: 10000, maxBuffer: 8192 })).stdout.trim();
        assert.equal(hash(await readStable(tool, maximum)), toolHash, 'PE inspection tool changed');
        await write('evidence/node-pe.json', json({ ...pe, node: { bytes: node.bytes, sha256: node.sha256, archiveSha256: pin.sha256 },
            report: { path: peText.path, sha256: peText.sha256 }, source,
            tool: { path: tool, sha256: toolHash, version: toolVersion, arguments: argumentsUsed, closureVerified: false } }), generated);
        await write('NOTICES.md', Buffer.from('# Component Notices\n\n'
            + 'Cocos4 source: LICENSE and AUTHORS.txt. Official Node and bundled third-party notices: runtime/LICENSE; upstream documentation: runtime/README.md.\n\n'
            + 'Crossbuild notices copied from the actual compiler installation: notices/zig-LICENSE and notices/mingw-COPYING. This is not a complete linked-object/toolchain license audit; per-file exceptions and compiler resource/cache closure remain unreviewed.\n\n'
            + 'No third-party Windows DLLs, npm, compiler or SDK are bundled for execution. Import names do not prove DLL availability or safe loading. Redistribution is NOT approved. Checksums provide integrity/source binding, not source authentication, signature verification or license clearance.\n'), generated);
        for (const input of inputs) assert.equal(hash(await readStable(path.join(engine, input.path), 4 * 1024 ** 2)), input.sha256, `Source changed: ${input.path}`);
        const manifest = { schema: 'cocos4-windows-host-components/v1', kitVersion: '0.0.0-candidate', archiveRoot: WINDOWS_COMPONENT_ROOT,
            status: 'blocked', operationalDevkit: false, distributionApproved: false,
            host: { platform: 'win32', arch: 'x64', verified: false, acceptanceTarget: 'supported Windows 11 x64' },
            runtime: { node: { version: pin.version, bytes: node.bytes, sha256: node.sha256, archiveSha256: pin.sha256, executionTested: false } },
            components, source, blockers: [...WINDOWS_COMPONENT_BLOCKERS],
            checksumScope: 'Integrity and selected-source binding only; not source authentication or operational/redistribution approval.',
            files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
        manifest.componentId = `sha256-${hash(canonical(manifest))}`;
        await fs.writeFile(path.join(staging, 'components.json'), json(manifest), { flag: 'wx', mode: 0o444 });
        await verifyWindowsComponents(staging, manifest.componentId);
        const inventory = await archiveWindows(staging, `${staging}.zip`, WINDOWS_COMPONENT_ROOT);
        const zipFiles = inventory.filter(item => item.type === 'file').map(item => ({ path: item.name.slice(WINDOWS_COMPONENT_ROOT.length + 1), bytes: item.size, sha256: item.sha256 }));
        assert.deepEqual(zipFiles, [...files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
            { path: 'components.json', bytes: json(manifest).length, sha256: hash(json(manifest)) }].sort((a, b) => a.path < b.path ? -1 : 1));
        await verifyWindowsArchive(`${staging}.zip`, WINDOWS_COMPONENT_ROOT, inventory);
        const archive = await readStable(`${staging}.zip`, WINDOWS_ARCHIVE_LIMITS.archiveBytes);
        const result = { schema: manifest.schema, status: 'blocked', operationalDevkit: false, distributionApproved: false, host: manifest.host,
            componentId: manifest.componentId, out, archive: `${out}.zip`, checksum: `${out}.zip.sha256`, buildReport: `${out}.build.json`,
            archiveBytes: archive.length, archiveSha256: hash(archive), manifestSha256: hash(json(manifest)),
            source, node: manifest.runtime.node, components, blockers: manifest.blockers, archiveInventory: inventory,
            verification: { payloadHashes: true, canonicalZipInventory: true, windowsExecution: false, dllClosure: false, acl: false } };
        await fs.writeFile(`${staging}.zip.sha256`, `${result.archiveSha256}  ${path.basename(out)}.zip\n`, { flag: 'wx', mode: 0o600 });
        await fs.writeFile(`${staging}.build.json`, json(result), { flag: 'wx', mode: 0o600 });
        for (const suffix of suffixes) await absent(`${out}${suffix}`);
        // Each sibling rename is atomic/no-replace. The four artifacts are NOT a
        // single transaction; publish the completion receipt last, retain conflicts.
        for (const suffix of suffixes) await publishSdk(`${staging}${suffix}`, `${out}${suffix}`);
        return result;
    } catch (error) {
        throw new Error(`${error.message}; inspect staging ${staging} and any published outputs (never overwritten or rolled back)`, { cause: error });
    } finally {
        await fs.rm(work, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
        const key = { '--out': 'out', '--node-archive': 'nodeArchive', '--compiler': 'compiler' }[process.argv[i]];
        assert(key && !(key in options) && process.argv[i + 1], 'Usage: prepare-windows-components.mjs --out ABSENT_ABSOLUTE --node-archive ABSOLUTE --compiler ABSOLUTE_ZIG');
        options[key] = process.argv[i + 1];
    }
    prepareWindowsComponents(options).then(({ archiveInventory, ...result }) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
