import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { networkInterfaces, release as kernelRelease } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
export const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value.split('/').every(part => /^[A-Za-z0-9_@.+=,-]+$/.test(part) && !['.', '..'].includes(part) && !part.endsWith('.'));

export function archiveChecksums(integrity) {
    if (integrity === undefined) return undefined;
    const match = /^(sha1|sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
    assert(match, 'Unsupported archive integrity');
    const bytes = Buffer.from(match[2], 'base64');
    assert.equal(bytes.length, { sha1: 20, sha256: 32, sha512: 64 }[match[1]], 'Malformed archive integrity');
    assert.equal(bytes.toString('base64'), match[2], 'Noncanonical archive integrity');
    return [{ algorithm: match[1].toUpperCase(), checksumValue: bytes.toString('hex') }];
}

export async function readRegular(root, relative, maximum = 256 * 1024 * 1024) {
    assert(safePath(relative), `Unsafe inventory path: ${relative}`);
    const filename = path.join(root, relative);
    assert.equal(await fs.realpath(filename), filename, `Symlink input: ${relative}`);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat();
        assert(before.isFile() && before.nlink === 1 && before.size <= maximum, `Unsafe/oversized input: ${relative}`);
        const bytes = await handle.readFile();
        const after = await fs.lstat(filename);
        assert(after.isFile() && after.dev === before.dev && after.ino === before.ino && after.size === bytes.length
            && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
        `Input changed: ${relative}`);
        return bytes;
    } finally { await handle.close(); }
}

export async function verifyInventory(root) {
    assert(path.isAbsolute(root) && path.resolve(root) === root);
    assert.equal(await fs.realpath(root), root);
    const manifest = JSON.parse(await readRegular(root, 'release.json', 32 * 1024 * 1024));
    const { releaseId, ...body } = manifest;
    assert.equal(manifest.schema, 'cocos4-portable-release/v1');
    assert.equal(releaseId, `sha256-${hash(canonical(body))}`, 'Outer release identity mismatch');
    assert.equal(manifest.layout.sdk, 'sdk');
    assert.equal(manifest.runtime.node.version, '24.21.0');
    assert.equal(manifest.runtime.node.bundled, true);
    assert.equal(manifest.channel, 'candidate', 'Official release approval is not implemented');
    assert.equal(manifest.distributionApproved, false);
    assert(Array.isArray(manifest.files) && manifest.files.length > 20 && manifest.files.length < 50000);
    const expected = new Map(manifest.files.map(file => [file.path, file]));
    assert.equal(expected.size, manifest.files.length);
    assert.equal(new Set(manifest.files.map(file => file.path.toLowerCase())).size, expected.size);
    assert.deepEqual(manifest.files.map(file => file.path), [...expected.keys()].sort());
    const directories = new Set(['']);
    let total = 0;
    for (const file of manifest.files) {
        assert(safePath(file.path) && file.path !== 'release.json');
        assert(/^(?:app\/|runtime\/|sdk\/|skills\/|docs\/|licenses\/|provenance\/|LICENSE$|THIRD_PARTY_NOTICES$|SBOM\.spdx\.json$|cocos4$)/.test(file.path));
        assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256));
        assert(['0444', '0555'].includes(file.mode) && file.origin && typeof file.origin.kind === 'string');
        total += file.bytes;
        for (let parent = path.posix.dirname(file.path); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
    }
    assert(total < 2 * 1024 ** 3, 'Release exceeds its byte budget');
    const walk = async relative => {
        const directory = path.join(root, relative);
        const before = await fs.lstat(directory);
        assert(before.isDirectory() && await fs.realpath(directory) === directory && (before.mode & 0o7777) === 0o555,
            `Release directory is not read-only: ${relative}`);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory() && directories.delete(name)) await walk(name);
            else {
                assert(entry.isFile(), `Special/unlisted directory: ${name}`);
                if (name === 'release.json') continue;
                const file = expected.get(name);
                assert(file, `Unlisted file: ${name}`);
                const bytes = await readRegular(root, name);
                assert.equal(bytes.length, file.bytes, name);
                assert.equal(hash(bytes), file.sha256, `Hash mismatch: ${name}`);
                assert.equal((await fs.lstat(path.join(root, name))).mode & 0o7777, parseInt(file.mode, 8), name);
                expected.delete(name);
            }
        }
        const after = await fs.lstat(directory);
        assert.equal(after.ino, before.ino);
        assert.equal(after.mtimeMs, before.mtimeMs, `Directory changed: ${relative}`);
    };
    await walk('');
    assert.equal(expected.size, 0, 'Missing files');
    assert.equal(directories.size, 1, 'Missing directories');
    assert.equal((await fs.lstat(path.join(root, 'release.json'))).mode & 0o7777, 0o444);
    assert.equal(hash(await readRegular(root, 'sdk/manifest.json')), manifest.sdk.manifestSha256);
    const sdk = JSON.parse(await readRegular(root, 'sdk/manifest.json'));
    assert.equal(sdk.sdkId, manifest.sdk.sdkId);
    assert.equal(sdk.development.node.bundled, false, 'Nested SDK must remain truthful and unchanged');
    const sbom = JSON.parse(await readRegular(root, 'SBOM.spdx.json'));
    const inventory = new Map(manifest.files.map(file => [`./${file.path}`, file]));
    inventory.delete('./SBOM.spdx.json');
    assert.equal(sbom.spdxVersion, 'SPDX-2.3');
    assert.equal(sbom.SPDXID, 'SPDXRef-DOCUMENT');
    const ids = new Set([sbom.SPDXID]);
    for (const file of sbom.files) {
        assert(!ids.has(file.SPDXID)); ids.add(file.SPDXID);
        const delivered = inventory.get(file.fileName);
        assert(delivered, `Unlisted/duplicate SPDX file: ${file.fileName}`);
        assert.deepEqual(file.checksums, [{ algorithm: 'SHA256', checksumValue: delivered.sha256 }]);
        inventory.delete(file.fileName);
    }
    assert.equal(inventory.size, 0, 'Missing SPDX files');
    const appLock = JSON.parse(await readRegular(root, 'provenance/app-lock.json'));
    const compiler = JSON.parse(await readRegular(root, 'sdk/toolchain/compiler-dependencies.json'));
    for (const pkg of sbom.packages) {
        assert(!ids.has(pkg.SPDXID)); ids.add(pkg.SPDXID);
        const info = JSON.parse(pkg.comment);
        assert(Array.isArray(info.notices));
        for (const notice of info.notices) assert(manifest.files.some(file => file.path === notice && file.bytes > 0), `Missing notice: ${notice}`);
        if (info.packageJson) {
            const bytes = await readRegular(root, info.packageJson), declared = JSON.parse(bytes);
            assert.equal(declared.name, pkg.name); assert.equal(declared.version, pkg.versionInfo);
            assert.equal(hash(bytes), info.packageJsonSha256, 'package.json identity mismatch');
            const pinned = info.packageJson.startsWith('sdk/toolchain/')
                ? compiler.packages.find(item => `sdk/toolchain/${item.path}/package.json` === info.packageJson)
                : appLock.packages[info.packageJson.startsWith('app/host/logic-types/') ? `node_modules/${pkg.name}`
                    : info.packageJson.slice('app/'.length, -'/package.json'.length)];
            assert(pinned && pinned.version === pkg.versionInfo, 'Missing locked SPDX package');
            assert.equal(pkg.downloadLocation, pinned.resolved);
            assert.deepEqual(pkg.checksums, archiveChecksums(pinned.integrity), 'Archive checksum must come from the archive lock, not package.json');
        } else if (pkg.name === 'Node.js') {
            assert.deepEqual(pkg.checksums, [{ algorithm: 'SHA256', checksumValue: manifest.runtime.node.archiveSha256 }]);
        } else assert.equal(pkg.checksums, undefined, 'Do not invent archive checksums for unarchived components');
    }
    for (const name of ['Node.js', 'cocos4-devkit-tools', '@types/node', 'undici-types', 'opencode-config-schema']) {
        assert(sbom.packages.some(pkg => pkg.name === name), `Missing SPDX component: ${name}`);
    }
    for (const relationship of sbom.relationships) assert(ids.has(relationship.spdxElementId) && ids.has(relationship.relatedSpdxElement));
    return manifest;
}

export function checkHostRequirements(manifest, host) {
    assert.equal(host.platform, manifest.host.platform, 'Host operating system does not match this release');
    assert.equal(host.arch, manifest.host.arch, 'Host architecture does not match this release');
    assert.equal(host.node, `v${manifest.runtime.node.version}`, 'Use the pinned bundled Node runtime');
    assert(typeof host.glibc === 'string' && /^\d+(?:\.\d+){1,2}$/.test(host.glibc), 'This release requires a detectable GNU libc runtime');
    const binaries = ['cocos4', 'runtime/node', 'app/host/cocos4-publish', 'app/host/cocos4-supervise', 'app/host/cocos4-mcp-launch'];
    assert(Array.isArray(manifest.host.libraries) && manifest.host.libraries.length === binaries.length, 'Incomplete host ABI inventory');
    const libraries = new Map(manifest.host.libraries.map(item => [item.file, item]));
    assert.equal(libraries.size, binaries.length, 'Duplicate host ABI records');
    const compareVersions = (a, b) => {
        const left = a.split('.').map(Number), right = b.split('.').map(Number);
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
            const difference = (left[i] ?? 0) - (right[i] ?? 0);
            if (difference) return difference;
        }
        return 0;
    };
    let minimumGlibc = '0.0';
    for (const name of binaries) {
        const item = libraries.get(name);
        assert(item && Array.isArray(item.versions) && Array.isArray(item.sharedLibraries), `Missing host ABI record: ${name}`);
        if (name === 'cocos4' || name === 'app/host/cocos4-mcp-launch') {
            assert.equal(item.interpreter, null, 'Environment-clearing launchers must be static');
            assert.deepEqual(item.sharedLibraries, [], 'Environment-clearing launchers must have no shared dependencies');
            assert.deepEqual(item.versions, [], 'Environment-clearing launchers must have no dynamic ABI requirements');
        } else if (name !== 'runtime/node') {
            // Node's dependencies are already loaded. The additional C helpers
            // only use libc; future dependencies require their own host checks.
            assert.deepEqual(item.sharedLibraries, ['libc.so.6'], `Unsupported helper dependencies: ${name}`);
            assert.equal(item.interpreter, libraries.get('runtime/node')?.interpreter, `Unsupported helper interpreter: ${name}`);
            assert(item.versions.length && item.versions.every(version => /^GLIBC_\d+(?:\.\d+){1,2}$/.test(version)), `Unsupported helper ABI: ${name}`);
        }
        for (const version of item.versions) {
            const required = /^GLIBC_(\d+(?:\.\d+){1,2})$/.exec(version)?.[1];
            if (required && compareVersions(required, minimumGlibc) > 0) minimumGlibc = required;
        }
    }
    assert(compareVersions(host.glibc, minimumGlibc) >= 0,
        `Host glibc ${host.glibc} is below the complete kit requirement ${minimumGlibc}`);
    return { platform: host.platform, arch: host.arch, node: host.node, glibc: host.glibc, minimumGlibc };
}

export async function verifyHost(root, manifest) {
    assert.equal(process.platform, 'linux', 'This host verifier supports the Linux kit only');
    assert.equal(await fs.realpath('/proc/self/exe'), path.join(root, 'runtime/node'), 'Use the executing release\'s bundled Node, not a system or copied interpreter');
    return checkHostRequirements(manifest, { platform: process.platform, arch: process.arch, node: process.version,
        glibc: process.report.getReport().header.glibcVersionRuntime });
}

export async function waitForJob(call, receipt, report, preview = false) {
    const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
    let deadline;
    for (;;) {
        const page = await call('job_get', { jobId: receipt.jobId, limit: 100 });
        assert.equal(page.job.releaseId, report.releaseId, 'Job must identify the executing release, not only its SDK');
        assert(Number.isSafeInteger(page.job.deadline), 'Missing or invalid job deadline');
        deadline ??= page.job.deadline;
        assert.equal(page.job.deadline, deadline, 'Job deadline changed');
        if (preview && page.job.phase === 'ready') return page;
        if (terminal.has(page.job.state)) {
            report.jobs.push(page);
            assert.equal(page.job.state, 'succeeded', JSON.stringify(page));
            assert(!page.report.items.some(item => item.status === 'failed'), JSON.stringify(page));
            return page;
        }
        // The job owns its deadline; allow bounded cleanup to publish the terminal report.
        if (Date.now() >= deadline + 30000) throw new Error(`Job deadline: ${receipt.jobId}`);
        await delay(100);
    }
}

export async function verifyWorkflow(root, evidence, verifyBrowser) {
    const manifest = await verifyInventory(root);
    assert.equal(process.version, 'v24.21.0');
    await fs.mkdir(evidence, { mode: 0o700 });
    const workspace = path.join(evidence, 'workspace');
    const home = path.join(evidence, 'home');
    for (const directory of [workspace, home]) await fs.mkdir(directory, { mode: 0o700 });
    const dependency = name => import(pathToFileURL(path.join(root, 'app/node_modules/@modelcontextprotocol/sdk/dist/esm', name)).href);
    const { Client } = await dependency('client/index.js');
    const { StdioClientTransport } = await dependency('client/stdio.js');
    const { CallToolResultSchema } = await dependency('types.js');
    const { AjvJsonSchemaValidator } = await dependency('validation/ajv-provider.js');
    const ajv = new AjvJsonSchemaValidator();
    const client = new Client({ name: 'cocos4-portable-acceptance', version: '1.0.0' }, { jsonSchemaValidator: ajv });
    const transport = new StdioClientTransport({ command: path.join(root, 'cocos4'),
        args: ['mcp', '--mode', 'develop', '--preview', 'true'], cwd: workspace,
        env: { HOME: home, XDG_STATE_HOME: path.join(evidence, 'private'), PATH: '', LANG: 'C.UTF-8',
            NODE_OPTIONS: '--require=/deliberately-absent-preload.cjs', NODE_PATH: '/deliberately-absent-modules' }, stderr: 'pipe' });
    const report = { schemaVersion: 1, releaseId: manifest.releaseId, sdkId: manifest.sdk.sdkId,
        node: process.version, kernel: kernelRelease(), success: false, emptyPath: true, sdkReadOnly: true,
        sourceCheckoutRequired: false, fullVM: false, browserRenderingTested: false, vendorOrDeviceTested: false,
        networkInterfaces: networkInterfaces(), jobs: [], previews: [], browsers: [], stderr: '' };
    transport.stderr.on('data', bytes => { report.stderr += bytes; });
    let completed = false;
    try {
        await client.connect(transport, { timeout: 180000 });
        report.server = client.getServerVersion();
        assert.deepEqual(client.getServerCapabilities(), { tools: {}, resources: {} });
        const { tools } = await client.listTools();
        report.tools = tools.map(tool => tool.name);
        const validators = new Map(tools.map(tool => [tool.name, ajv.getValidator(tool.outputSchema)]));
        const call = async (name, args = {}, error) => {
            name = `cocos4_${name}`;
            const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 30000 });
            assert.equal(validators.get(name)(result.structuredContent).valid, true);
            assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
            assert(Buffer.byteLength(JSON.stringify(result)) < 65536);
            assert.equal(result.isError, !!error, JSON.stringify(result.structuredContent));
            if (error) assert.equal(result.structuredContent.error.code, error);
            return result.structuredContent.data;
        };
        const wait = (receipt, preview = false) => waitForJob(call, receipt, report, preview);
        const profiles = (await call('catalog', { section: 'profiles', limit: 100 })).items;
        assert.equal(profiles.length, 8, 'Requires the actual eight-profile SDK');
        const templates = (await call('catalog', { section: 'templates', limit: 100 })).items;
        const docs = await call('docs_search', { query: 'Node', kind: 'api', limit: 1 });
        assert(docs.items.length);
        await call('docs_read', { documentId: docs.items[0].documentId });
        const resources = await client.listResources();
        await client.readResource({ uri: resources.resources[0].uri });
        await wait(await call('doctor', { depth: 'full' }));
        for (const profile of profiles) {
            const project = `${profile.target.toLowerCase()}-${profile.id}-${profile.variant}`;
            const template = templates.find(item => item.target === profile.target && item.profile === profile.id && item.variant === profile.variant);
            assert(template);
            await wait(await call('project_create', { directory: project, projectName: project, templateId: template.id, requestKey: `create-${project}` }));
            const main = path.join(workspace, project, 'src/main.ts');
            const source = await fs.readFile(main, 'utf8');
            assert(source.includes('pointsPerClick = 7'), 'The real interactive starter is required');
            await fs.writeFile(main, source.replace('pointsPerClick = 7', 'pointsPerClick = 11')
                + `\nexport const portableRevision = ${JSON.stringify(project)};\n`);
            if (profile.target === 'BILIBILI') {
                const filename = path.join(workspace, project, 'game.json');
                const config = JSON.parse(await fs.readFile(filename));
                config.appId = 'TEST_ONLY_PORTABLE_ACCEPTANCE';
                await fs.writeFile(filename, `${JSON.stringify(config)}\n`);
            }
            await wait(await call('project_check', { project, target: profile.target, profile: profile.id,
                checks: ['types'], requestKey: `check-${project}` }));
            const built = await wait(await call('game_build', { project, target: profile.target, profile: profile.id,
                variant: profile.variant, requestKey: `build-${project}` }));
            const artifact = built.report.artifacts[0];
            assert.equal(artifact.variant, profile.variant);
            assert.deepEqual(artifact.provenance, { releaseId: manifest.releaseId,
                profileSha256: manifest.files.find(file => file.path === `sdk/${profile.descriptor}`).sha256 });
            const input = { artifactId: artifact.artifactId, ttlSeconds: 300, requestKey: `preview-${project}` };
            if (profile.target === 'BILIBILI') await call('preview_start', input, 'UNSUPPORTED_PROJECT');
            else {
                const ready = await wait(await call('preview_start', input), true);
                const url = ready.job.preview.url;
                const html = await fetch(url);
                assert.equal(html.status, 200);
                assert.match(await html.text(), /<canvas/);
                const source = await fetch(new URL('game/main.js', url));
                assert.equal(source.status, 200);
                assert((await source.text()).includes(project));
                if (verifyBrowser) report.browsers.push(await verifyBrowser({ preview: ready.job.preview, artifact,
                    artifactDirectory: path.join(evidence, 'private/cocos4', hash(workspace), `artifact-${artifact.artifactId}`) }));
                await call('preview_stop', { jobId: ready.job.jobId });
                await assert.rejects(fetch(url, { signal: AbortSignal.timeout(5000) }));
                report.previews.push({ profile: `${profile.target}/${profile.id}/${profile.variant}`, stopped: true, httpOnly: !verifyBrowser });
            }
        }
        if (verifyBrowser) { assert.equal(report.browsers.length, 4); report.browserRenderingTested = true; }
        completed = true;
    } catch (error) {
        report.error = error.stack ?? String(error);
        throw error;
    } finally {
        try {
            await client.close();
            report.payloadUnchanged = (await verifyInventory(root)).releaseId === manifest.releaseId;
            assert.equal(report.stderr, '');
            report.success = completed;
        } catch (error) {
            report.success = false; report.error = error.stack ?? String(error);
            throw error;
        } finally {
            await fs.writeFile(path.join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        }
    }
    return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2), flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
        assert(['--release', '--evidence'].includes(args[i]) && !flags.has(args[i]) && args[i + 1] && path.isAbsolute(args[i + 1]),
            'Usage: bundled-node verify-portable.mjs --release ABSOLUTE [--evidence ABSENT_ABSOLUTE_DIRECTORY]');
        flags.set(args[i], args[i + 1]);
    }
    assert(flags.has('--release'));
    (flags.has('--evidence') ? verifyWorkflow(flags.get('--release'), flags.get('--evidence')) : verifyInventory(flags.get('--release')))
        .then(result => process.stdout.write(`${JSON.stringify({ releaseId: result.releaseId, success: true, evidence: flags.get('--evidence') ?? null })}\n`))
        .catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
