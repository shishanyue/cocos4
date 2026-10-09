// Maintainer-only, offline assembly. This never downloads, installs or publishes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { loadSdk } from '../build/src/sdk.js';
import { buildHostTool } from './build-publisher.mjs';
import { buildMcpLauncher } from './build-mcp-launch.mjs';
import { publishSdk } from './prepare-sdk.mjs';
import { archiveChecksums, canonical, hash, readRegular, safePath, verifyInventory, verifyReleaseProfiles } from './verify-portable.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const engine = path.resolve(root, '../..');
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SOURCE_DATE_EPOCH: '0' };
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function absent(filename) {
    try { await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error(`OUTPUT_CONFLICT: destination already exists: ${filename}`);
}
async function walk(directory, prefix = '', files = []) {
    assert.equal(await fs.realpath(directory), directory, 'Source directory aliases are not allowed');
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
        if (['node_modules', '.git', 'build'].includes(entry.name)) continue;
        const name = prefix + entry.name;
        assert(safePath(name) && (entry.isFile() || entry.isDirectory()), `Unsafe source entry: ${name}`);
        assert(files.length < 50000, 'Source file budget exceeded');
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + '/', files);
        else files.push(name);
    }
    return files;
}

export async function archiveRelease(source, archive, archiveRoot) {
    assert(safePath(archiveRoot) && !archiveRoot.includes('/'));
    await absent(archive);
    const temporary = await fs.mkdtemp(path.join(path.dirname(archive), '.cocos4-tar-'));
    try {
        const tar = path.join(temporary, 'payload.tar');
        // GNU tar transforms member paths, but not %d/%f in PAX header names.
        await run('/usr/bin/tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=posix',
            '--pax-option=delete=atime,delete=ctime,exthdr.name=PaxHeaders/entry', `--transform=s,^[^/]*,${archiveRoot},`,
            '-cf', tar, '-C', path.dirname(source), '--', path.basename(source)], { env, timeout: 120000, maxBuffer: 65536 });
        await pipeline(createReadStream(tar), createGzip({ level: 9 }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function prepareRelease({ sdkRoot, nodeArchive, out, kitVersion = '0.0.0-candidate' }) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64', 'Only Linux x64 has a host implementation');
    assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(kitVersion));
    for (const value of [sdkRoot, nodeArchive, out]) assert(path.isAbsolute(value) && path.resolve(value) === value && !value.includes('\0'));
    assert.equal(await fs.realpath(path.dirname(out)), path.dirname(out));
    for (const name of [out, `${out}.tar.gz`, `${out}.tar.gz.sha256`, `${out}.build.json`]) await absent(name);
    const sdk = await loadSdk(sdkRoot);
    assert.equal(sdk.manifest.kind, 'portable-development');
    verifyReleaseProfiles(sdk.manifest.catalog.profiles);
    const combinations = sdk.manifest.catalog.profiles.map(item => `${item.target}/${item.id}/${item.variant}`).sort();
    const lock = JSON.parse(await readRegular(root, 'packaging/node-lock.json'));
    assert.equal(lock.version, '24.21.0');
    assert.equal(lock.target, 'linux-x64');
    assert.deepEqual(lock.files, ['bin/node', 'LICENSE', 'README.md']);
    assert.equal(hash(await readRegular(path.dirname(nodeArchive), path.basename(nodeArchive))), lock.sha256, 'Node archive does not match the reviewed official pin');
    const packageLock = JSON.parse(await readRegular(root, 'package-lock.json'));
    const sourceInputs = [];
    for (const directory of ['src', 'skills', 'packaging']) for (const file of await walk(path.join(root, directory))) {
        const name = `${directory}/${file}`, bytes = await readRegular(root, name);
        sourceInputs.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'runtime/publish.c', 'runtime/supervise.c', 'runtime/mcp-launch.c',
        'scripts/build-publisher.mjs', 'scripts/build-supervisor.mjs', 'scripts/build-mcp-launch.mjs', 'scripts/prepare-release.mjs', 'scripts/verify-portable.mjs']) {
        const bytes = await readRegular(root, name);
        sourceInputs.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
    sourceInputs.sort((a, b) => compare(a.path, b.path));
    const revision = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: engine, env })).stdout.trim();
    const status = (await run('/usr/bin/git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: engine, env })).stdout;
    const work = await fs.mkdtemp(path.join(path.dirname(out), '.cocos4-release-build-'));
    let staging = await fs.mkdtemp(path.join(path.dirname(out), '.cocos4-release-'));
    const files = [], names = new Set(), packages = [], licenseGaps = [];
    let total = 0;
    const write = async (name, bytes, origin, executable = false) => {
        assert(safePath(name) && !names.has(name.toLowerCase()), `Duplicate/unsafe release entry: ${name}`);
        assert(files.length < 50000 && (total += bytes.length) < 2 * 1024 ** 3, 'Release exceeds fixed file/byte budget');
        names.add(name.toLowerCase());
        await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
        await fs.writeFile(path.join(staging, name), bytes, { flag: 'wx', mode: executable ? 0o555 : 0o444 });
        const record = { path: name, bytes: bytes.length, sha256: hash(bytes), mode: executable ? '0555' : '0444', origin };
        files.push(record);
        return record;
    };
    const copy = async (directory, file, destination, origin, executable = false) =>
        write(destination, await readRegular(directory, file), origin, executable);
    try {
        // Extract only reviewed members from a hash-verified official archive.
        const node = path.join(work, 'node');
        await fs.mkdir(node);
        await run('/usr/bin/tar', ['--extract', '--xz', '--file', nodeArchive, '--directory', node,
            '--no-same-owner', '--no-same-permissions', ...lock.files.map(name => `${lock.archiveRoot}/${name}`)], { env, timeout: 60000 });
        const nodeRoot = path.join(node, lock.archiveRoot);
        const nodeBytes = await readRegular(nodeRoot, 'bin/node');
        const actualNode = (await run(path.join(nodeRoot, 'bin/node'), ['--version'], { env, timeout: 10000 })).stdout.trim();
        assert.equal(actualNode, `v${lock.version}`);
        await write('runtime/node', nodeBytes, { kind: 'node-distribution', url: lock.url, archiveSha256: lock.sha256, member: 'bin/node' }, true);
        for (const file of ['LICENSE', 'README.md']) await copy(nodeRoot, file, `runtime/${file}`, { kind: 'node-distribution', member: file, archiveSha256: lock.sha256 });
        await copy(root, 'packaging/node-lock.json', 'provenance/node-lock.json', { kind: 'reviewed-source', path: 'packaging/node-lock.json' });
        packages.push({ name: 'Node.js', version: lock.version, download: lock.url, archiveSha256: lock.sha256, license: 'NOASSERTION', notices: ['runtime/LICENSE'] });

        // Compile the current application rather than copying a stale shared build.
        await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', path.join(root, 'tsconfig.json'),
            '--outDir', path.join(work, 'compiled')], { cwd: root, env, timeout: 120000, maxBuffer: 1024 * 1024 });
        for (const file of await walk(path.join(work, 'compiled/src'))) {
            assert(file.endsWith('.js'), 'Only compiled JavaScript belongs in app/src');
            await copy(path.join(work, 'compiled/src'), file, `app/src/${file}`, { kind: 'compiled-application', source: `src/${file.slice(0, -3)}.ts` });
        }
        const roots = ['@modelcontextprotocol/sdk', 'zod', 'ajv'];
        await write('app/package.json', json({ private: true, type: 'module', version: kitVersion, cocos4Portable: true,
            dependencies: Object.fromEntries(roots.map(name => [name, packageLock.packages[''].devDependencies[name]])) }), { kind: 'generated-app-manifest' });
        const queue = roots.map(name => `node_modules/${name}`), seen = new Set();
        const resolveDependency = async (from, name, optional) => {
            assert(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name), 'Unsafe npm package name');
            for (let directory = path.join(root, from); directory === root || directory.startsWith(root + '/'); directory = path.dirname(directory)) {
                if (path.basename(directory) === 'node_modules') continue;
                const relative = path.relative(root, path.join(directory, 'node_modules', name));
                if (packageLock.packages[relative]) return relative;
            }
            assert(optional, `Missing locked runtime dependency: ${from} -> ${name}`);
        };
        for (let i = 0; i < queue.length; ++i) {
            const directory = queue[i];
            if (seen.has(directory)) continue;
            assert(seen.size < 512, 'Application dependency closure exceeds budget');
            seen.add(directory);
            const info = JSON.parse(await readRegular(root, `${directory}/package.json`));
            const pinned = packageLock.packages[directory];
            assert(pinned && pinned.version === info.version && typeof pinned.integrity === 'string' && pinned.resolved?.startsWith('https://'), `Unpinned dependency: ${directory}`);
            const dependency = { name: info.name, version: info.version, download: pinned.resolved, integrity: pinned.integrity,
                packageJson: `app/${directory}/package.json`, packageSha256: hash(await readRegular(root, `${directory}/package.json`)),
                license: info.license ?? 'NOASSERTION', notices: [] };
            for (const file of await walk(path.join(root, directory))) {
                const destination = `app/${directory}/${file}`;
                await copy(path.join(root, directory), file, destination, { kind: 'npm', package: info.name, version: info.version, path: file });
                if (/(?:license|copying|notice)/i.test(path.posix.basename(file))) dependency.notices.push(destination);
            }
            if (!dependency.notices.length) licenseGaps.push({ component: `${info.name}@${info.version}`, reason: 'No packaged license/notice file found' });
            packages.push(dependency);
            for (const name of Object.keys({ ...info.dependencies, ...info.optionalDependencies, ...info.peerDependencies }).sort()) {
                const optional = !!info.optionalDependencies?.[name] || !!info.peerDependenciesMeta?.[name]?.optional;
                const resolved = await resolveDependency(directory, name, optional);
                if (resolved) queue.push(resolved);
            }
        }
        await copy(root, 'package-lock.json', 'provenance/app-lock.json', { kind: 'reviewed-source', path: 'package-lock.json' });

        const publisher = path.join(work, 'cocos4-publish');
        const publisherBuild = await buildHostTool(path.join(root, 'runtime/publish.c'), publisher);
        await copy(work, 'cocos4-publish', 'app/host/cocos4-publish', { kind: 'compiled-host-tool', sourceSha256: publisherBuild.sourceSha256 }, true);
        await copy(work, 'cocos4-publish.build.json', 'app/host/cocos4-publish.build.json', { kind: 'host-tool-provenance' });
        const mcpLaunchBuild = await buildMcpLauncher(path.join(work, 'cocos4-mcp-launch'));
        await copy(work, 'cocos4-mcp-launch', 'app/host/cocos4-mcp-launch',
            { kind: 'compiled-host-tool', sourceSha256: mcpLaunchBuild.sourceSha256 }, true);
        await copy(work, 'cocos4-mcp-launch.build.json', 'app/host/cocos4-mcp-launch.build.json', { kind: 'host-tool-provenance' });
        const host = path.join(work, 'host-builder');
        for (const directory of ['scripts', 'runtime']) await fs.mkdir(path.join(host, directory), { recursive: true });
        for (const file of ['scripts/build-supervisor.mjs', 'runtime/supervise.c']) await fs.writeFile(path.join(host, file), await readRegular(root, file));
        await fs.symlink(path.join(root, 'node_modules'), path.join(host, 'node_modules'));
        await run(process.execPath, [path.join(host, 'scripts/build-supervisor.mjs')], { env, timeout: 60000, maxBuffer: 65536 });
        for (const file of await walk(path.join(host, 'build/host'))) await copy(path.join(host, 'build/host'), file, `app/host/${file}`,
            { kind: 'host-supervisor-or-types', path: file }, file === 'cocos4-supervise');
        for (const [name, directory] of [['@types/node', 'node'], ['undici-types', 'undici-types']]) {
            const packageJson = `app/host/logic-types/${directory}/package.json`;
            const bytes = await readRegular(staging, packageJson), info = JSON.parse(bytes);
            const pinned = packageLock.packages[`node_modules/${name}`];
            assert.equal(info.name, name); assert.equal(info.version, pinned.version);
            const notices = files.filter(file => file.path.startsWith(`app/host/logic-types/${directory}/`)
                && /(?:license|copying|notice)/i.test(path.posix.basename(file.path))).map(file => file.path);
            if (!notices.length) licenseGaps.push({ component: `${name}@${info.version}`, reason: 'Host declaration dependency has no packaged license/notice file' });
            packages.push({ name, version: info.version, download: pinned.resolved, integrity: pinned.integrity,
                packageJson, packageSha256: hash(bytes), license: info.license, notices });
        }
        const launcher = path.join(work, 'cocos4');
        const launcherBuild = await buildHostTool(path.join(root, 'packaging/launcher.c'), launcher, true);
        await copy(work, 'cocos4', 'cocos4', { kind: 'compiled-host-launcher', sourceSha256: launcherBuild.sourceSha256 }, true);
        await copy(work, 'cocos4.build.json', 'provenance/launcher.json', { kind: 'host-tool-provenance' });
        for (const [from, to] of [['packaging/launch.mjs', 'app/launch.mjs'], ['scripts/verify-portable.mjs', 'app/verify-portable.mjs']]) {
            await copy(root, from, to, { kind: 'reviewed-source', path: from });
        }
        const { opencodeSupport } = await import(pathToFileURL(path.join(work, 'compiled/src/ai-opencode-schema.js')).href);
        packages.push({ name: 'opencode-config-schema', version: opencodeSupport.version, download: opencodeSupport.url,
            license: 'MIT', notices: ['app/src/ai-opencode-schema.js'],
            provenance: { upstream: opencodeSupport.upstream, responseSha256: opencodeSupport.sha256,
                schemaObjectSha256: opencodeSupport.schemaObjectSha256 } });
        packages.push({ name: 'cocos4-devkit-tools', version: kitVersion, download: 'NOASSERTION', license: 'NOASSERTION',
            notices: ['LICENSE'], provenance: { revision, sourceInputsSha256: hash(canonical(sourceInputs)) } });

        for (const record of sdk.manifest.files) {
            const copied = await copy(sdk.root, record.path, `sdk/${record.path}`, { kind: 'verified-sdk', sdkId: sdk.sdkId, path: record.path });
            assert.equal(copied.bytes, record.bytes); assert.equal(copied.sha256, record.sha256);
        }
        const sdkManifest = await copy(sdk.root, 'manifest.json', 'sdk/manifest.json', { kind: 'verified-sdk-manifest', sdkId: sdk.sdkId });
        for (const file of await walk(path.join(root, 'skills'))) await copy(path.join(root, 'skills'), file, `skills/${file}`, { kind: 'bundled-skill', path: `skills/${file}` });
        await copy(root, 'packaging/README.md', 'docs/getting-started.md', { kind: 'reviewed-source', path: 'packaging/README.md' });
        await copy(engine, 'LICENSE', 'LICENSE', { kind: 'source-license', path: 'LICENSE' });
        const compilerClosure = JSON.parse(await readRegular(sdk.root, 'toolchain/compiler-dependencies.json'));
        for (const info of compilerClosure.packages) {
            const pkg = JSON.parse(await readRegular(sdk.root, `toolchain/${info.path}/package.json`));
            const notices = files.filter(file => file.path.startsWith(`sdk/toolchain/${info.path}/`)
                && !file.path.slice(`sdk/toolchain/${info.path}/`.length).includes('node_modules/')
                && /(?:license|copying|notice)/i.test(path.posix.basename(file.path))).map(file => file.path);
            packages.push({ name: pkg.name, version: pkg.version, download: info.resolved ?? 'NOASSERTION',
                integrity: info.integrity, packageJson: `sdk/toolchain/${info.path}/package.json`,
                packageSha256: info.packageSha256, license: pkg.license ?? 'NOASSERTION', notices });
            if (!notices.length) licenseGaps.push({ component: `${pkg.name}@${pkg.version}`, reason: 'SDK compiler dependency has no license/notice file' });
        }
        for (const profile of sdk.manifest.catalog.profiles) packages.push({ name: `Cocos4-${profile.target}-${profile.id}-${profile.variant}`,
            version: sdk.manifest.engineVersion, download: 'NOASSERTION', license: 'NOASSERTION',
            notices: files.filter(file => file.path.startsWith(`sdk/${profile.directory}/`)
                && /(?:license|copying|notice)/i.test(path.posix.basename(file.path))).map(file => file.path),
            provenance: { descriptor: `sdk/${profile.descriptor}`, descriptorSha256: sdk.manifest.files.find(file => file.path === profile.descriptor).sha256 } });
        if (sdk.manifest.catalog.profiles.some(profile => ['WECHAT', 'BYTEDANCE'].includes(profile.target))) {
            licenseGaps.push({ component: '@cocos/engine-platforms@1.0.6',
                reason: 'The pinned WeChat/ByteDance adapters declare UNLICENSED. Original notices are retained; the engine MIT license does not authorize their redistribution.' });
        }
        licenseGaps.push({ component: 'Cocos4 engine/runtime/loader/Effect/external closure',
            reason: 'Root MIT metadata does not resolve restrictive source notices, loader/compiler metadata differences, or missing external license provenance. Human redistribution review remains required.' });
        const hostLibraries = [];
        for (const file of ['cocos4', 'runtime/node', 'app/host/cocos4-publish', 'app/host/cocos4-supervise', 'app/host/cocos4-mcp-launch']) {
            const { stdout } = await run('/usr/bin/readelf', ['-l', '-d', '-V', path.join(staging, file)], { env, timeout: 10000, maxBuffer: 1024 * 1024 });
            hostLibraries.push({ file, interpreter: /Requesting program interpreter: ([^\]]+)/.exec(stdout)?.[1] ?? null,
                sharedLibraries: [...stdout.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1]).sort(),
                versions: [...new Set(stdout.match(/\b(?:GLIBC|GLIBCXX|CXXABI)_[0-9.]+/g))].sort() });
            if (file === 'cocos4' || file === 'app/host/cocos4-mcp-launch') {
                assert.equal(hostLibraries.at(-1).interpreter, null, 'Environment-clearing launchers must have no dynamic interpreter');
                assert.deepEqual(hostLibraries.at(-1).sharedLibraries, [], 'Environment-clearing launchers must have no shared dependencies');
            }
        }
        const blockers = ['Candidate assembled from explicitly selected SDK inputs, not a clean end-to-end release rebuild.',
            ...(status ? ['The source checkout is dirty.'] : []), 'Redistribution license review is incomplete.',
            'No authenticated release signature/build attestation.', 'Clean-machine, supported-host and real-model gameplay acceptance are incomplete.'];
        await write('docs/acceptance.json', json({ distributionApproved: false, blockers, licenseGaps,
            hostLibraries, requiredKernelFeatures: ['procfs', 'renameat2(RENAME_NOREPLACE)', 'pidfd_open', 'pidfd_send_signal', 'subreapers'],
            unsupportedHosts: ['Windows x64', 'macOS arm64'], vendorCompilation: false, deviceValidation: false }), { kind: 'release-readiness-report' });
        await write('provenance/tool-inputs.json', json({ revision, dirty: !!status, sourceInputs,
            sdkInput: { sdkId: sdk.sdkId, manifestSha256: sdkManifest.sha256 }, nodeArchiveSha256: lock.sha256 }), { kind: 'source-provenance' });
        await write('THIRD_PARTY_NOTICES', Buffer.from('LOCAL CANDIDATE ONLY. NOT CLEARED FOR REDISTRIBUTION.\n'
            + 'Package metadata is recorded, not interpreted as a license grant. Preserve all original notices.\n\n'
            + packages.map(pkg => `${pkg.name}@${pkg.version}\nDeclared metadata: ${JSON.stringify(pkg.license)}\nNotices: ${pkg.notices.join(', ') || 'MISSING'}\n`).join('\n')
            + '\nOutstanding review:\n' + licenseGaps.map(item => `${item.component}: ${item.reason}`).join('\n') + '\n'), { kind: 'generated-notice-index' });
        const spdxFiles = [...files].sort((a, b) => compare(a.path, b.path));
        const knownLicenses = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'CC0-1.0']);
        await write('SBOM.spdx.json', json({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
            name: `cocos4-devkit-${kitVersion}-linux-x64`, documentNamespace: `https://cocos4.invalid/spdx/${hash(canonical(spdxFiles))}`,
            creationInfo: { created: '1970-01-01T00:00:00Z', creators: [`Tool: cocos4-devkit-prepare-release-${kitVersion}`] },
            packages: packages.map((pkg, i) => ({ SPDXID: `SPDXRef-Package-${i}`, name: pkg.name, versionInfo: pkg.version,
                downloadLocation: pkg.download, filesAnalyzed: false, licenseConcluded: 'NOASSERTION',
                licenseDeclared: knownLicenses.has(pkg.license) ? pkg.license : 'NOASSERTION', copyrightText: 'NOASSERTION',
                checksums: pkg.archiveSha256 ? [{ algorithm: 'SHA256', checksumValue: pkg.archiveSha256 }] : archiveChecksums(pkg.integrity),
                comment: JSON.stringify({ notices: pkg.notices, packageJson: pkg.packageJson, packageJsonSha256: pkg.packageSha256,
                    checksumScope: 'Upstream archive from reviewed pin/lock, not the copied package.json or component file set.',
                    provenance: pkg.provenance }) })),
            files: spdxFiles.map((file, i) => ({ SPDXID: `SPDXRef-File-${i}`, fileName: `./${file.path}`,
                checksums: [{ algorithm: 'SHA256', checksumValue: file.sha256 }], licenseConcluded: 'NOASSERTION',
                licenseInfoInFiles: ['NOASSERTION'], copyrightText: 'NOASSERTION', comment: JSON.stringify(file.origin) })),
            relationships: packages.map((_, i) => ({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: `SPDXRef-Package-${i}` })) }),
        { kind: 'generated-spdx-inventory', excludesSelfAndOuterManifest: true });
        for (const input of sourceInputs) assert.equal(hash(await readRegular(root, input.path)), input.sha256, `Source changed during assembly: ${input.path}`);
        assert.equal(hash(await readRegular(sdk.root, 'manifest.json')), sdkManifest.sha256);
        const manifest = { schema: 'cocos4-portable-release/v1', kitVersion, channel: 'candidate', distributionApproved: false,
            layout: { sdk: 'sdk', app: 'app', skills: 'skills' }, host: { platform: 'linux', arch: 'x64', verified: false, libraries: hostLibraries },
            runtime: { node: { version: lock.version, bundled: true, sha256: hash(nodeBytes), archiveSha256: lock.sha256 } },
            sdk: { sdkId: sdk.sdkId, manifestSha256: sdkManifest.sha256, profiles: combinations }, source: { revision, dirty: !!status,
                inputsSha256: hash(canonical(sourceInputs)) }, contractVersion: 1, blockers,
            files: files.sort((a, b) => compare(a.path, b.path)) };
        manifest.releaseId = `sha256-${hash(canonical(manifest))}`;
        await fs.writeFile(path.join(staging, 'release.json'), json(manifest), { flag: 'wx', mode: 0o444 });
        const readOnly = async directory => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await readOnly(path.join(directory, entry.name));
            await fs.chmod(directory, 0o555);
        };
        await readOnly(staging);
        await verifyInventory(staging);
        await publishSdk(staging, out); staging = undefined;
        const archiveRoot = `cocos4-devkit-${kitVersion}-linux-x64`;
        await archiveRelease(out, `${out}.tar.gz`, archiveRoot);
        const archiveBytes = await readRegular(path.dirname(out), `${path.basename(out)}.tar.gz`, 2 * 1024 ** 3);
        const result = { releaseId: manifest.releaseId, out, channel: manifest.channel, distributionApproved: false, sdkId: sdk.sdkId,
            files: files.length, payloadBytes: total, archiveBytes: archiveBytes.length, archiveSha256: hash(archiveBytes), blockers };
        await fs.writeFile(`${out}.tar.gz.sha256`, `${result.archiveSha256}  ${path.basename(out)}.tar.gz\n`, { flag: 'wx', mode: 0o600 });
        await fs.writeFile(`${out}.build.json`, json(result), { flag: 'wx', mode: 0o600 });
        return result;
    } catch (error) {
        // Keep a failed candidate inspectable; never erase inputs or an old SDK.
        throw new Error(`${error.message}${staging ? `; incomplete staging retained at ${staging}` : '; published candidate retained for diagnosis'}`, { cause: error });
    } finally { await fs.rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
        const key = { '--sdk-root': 'sdkRoot', '--node-archive': 'nodeArchive', '--out': 'out', '--kit-version': 'kitVersion' }[args[i]];
        assert(key && !(key in options) && args[i + 1], 'Usage: prepare-release.mjs --sdk-root ABSOLUTE --node-archive ABSOLUTE --out ABSENT_ABSOLUTE [--kit-version VERSION]');
        options[key] = args[i + 1];
    }
    prepareRelease(options).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
