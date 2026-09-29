import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyGame } from './browser-smoke.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
    const flags = new Map();
    for (let i = 2; i < process.argv.length; i += 2) {
        const [name, value] = process.argv.slice(i, i + 2);
        assert(['--kit', '--out', '--drivers', '--pngjs', '--chromium', '--bilibili-app-id'].includes(name)
            && !flags.has(name) && value, 'Expected unique --kit/--out/--drivers/--pngjs/--chromium paths and optional --bilibili-app-id');
        flags.set(name, value);
    }
    for (const name of ['--kit', '--out', '--drivers', '--pngjs', '--chromium']) {
        const value = flags.get(name);
        assert(value && path.isAbsolute(value) && path.resolve(value) === value, `${name} must be a canonical absolute path`);
        assert.equal(await fs.realpath(name === '--out' ? path.dirname(value) : value), name === '--out' ? path.dirname(value) : value);
    }
    const kit = flags.get('--kit'), out = flags.get('--out');
    assert.equal(await fs.realpath(process.execPath), path.join(kit, 'runtime/node'), 'Run this example with the selected kit\'s bundled Node');
    const release = JSON.parse(await fs.readFile(path.join(kit, 'release.json'), 'utf8'));
    assert.equal(process.versions.node, release.runtime.node.version);
    const appId = flags.get('--bilibili-app-id') ?? 'TEST_ONLY_2048_LOCAL';
    assert(appId.trim() === appId && appId.length > 0 && appId.length <= 256);
    await fs.mkdir(out, { mode: 0o700 });
    const workspace = path.join(out, 'workspace'), state = path.join(out, 'state');
    const evidence = path.join(out, 'evidence'), exports = path.join(out, 'exports'), home = path.join(out, 'home');
    for (const directory of [workspace, evidence, exports, home]) await fs.mkdir(directory, { mode: 0o700 });
    const projectName = 'game-2048', project = path.join(workspace, projectName);
    const report = {
        schemaVersion: 1, scope: 'One 2048 game through a packaged MCP, not a full engine/platform test matrix',
        startedAt: new Date().toISOString(), success: false, kit, project, state, node: process.version,
        releaseId: release.releaseId, sdkId: release.sdk.sdkId,
        distributionApproved: release.distributionApproved,
        bilibili: { appId, testOnlyAppId: appId === 'TEST_ONLY_2048_LOCAL', vendorOrDeviceTested: false },
        calls: [], jobs: [], exports: [], unsupportedBuilds: [], stderr: '',
    };
    const json = (name, value) => fs.writeFile(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const dependency = name => import(pathToFileURL(path.join(kit, 'app/node_modules/@modelcontextprotocol/sdk/dist/esm', name)).href);
    const { Client } = await dependency('client/index.js');
    const { StdioClientTransport } = await dependency('client/stdio.js');
    const { CallToolResultSchema } = await dependency('types.js');
    const { AjvJsonSchemaValidator } = await dependency('validation/ajv-provider.js');
    const { waitForJob, readRegular, safePath } = await import(pathToFileURL(path.join(kit, 'app/verify-portable.mjs')).href);
    const ajv = new AjvJsonSchemaValidator();
    const client = new Client({ name: 'cocos4-2048-example', version: '1.0.0' }, { jsonSchemaValidator: ajv });
    report.command = {
        command: path.join(kit, 'cocos4'),
        args: ['mcp', '--workspace', workspace, '--state-root', state, '--mode', 'develop', '--preview', 'true', '--execute-tests', 'true'],
        cwd: workspace, env: { PATH: '', HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    };
    await json('command.json', report.command);
    const transport = new StdioClientTransport({ ...report.command, stderr: 'pipe' });
    transport.stderr.on('data', bytes => { report.stderr += bytes; });
    let previewJob, previewUrl, call, failure;
    try {
        await client.connect(transport, { timeout: 180000 });
        const { tools } = await client.listTools();
        report.tools = tools.map(tool => tool.name);
        const validators = new Map(tools.map(tool => [tool.name, ajv.getValidator(tool.outputSchema)]));
        const phases = new Map();
        call = async (name, args = {}, expectedError) => {
            const tool = `cocos4_${name}`;
            const result = await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { timeout: 30000 });
            assert.equal(validators.get(tool)(result.structuredContent).valid, true, `Invalid ${tool} output`);
            assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
            assert.equal(result.isError, !!expectedError, JSON.stringify(result.structuredContent));
            if (name !== 'job_get') report.calls.push({ tool, arguments: args, error: result.structuredContent.error ?? null });
            if (expectedError) {
                assert.equal(result.structuredContent.error.code, expectedError);
                return result.structuredContent.error;
            }
            const data = result.structuredContent.data;
            if (name === 'job_get') {
                const status = `${data.job.state}/${data.job.phase}`;
                if (phases.get(data.job.jobId) !== status) {
                    process.stdout.write(`${data.job.operation}: ${status}\n`);
                    phases.set(data.job.jobId, status);
                }
            }
            return data;
        };
        const wait = (receipt, preview = false) => waitForJob(call, receipt, report, preview);
        const profiles = (await call('catalog', { section: 'profiles', limit: 100 })).items;
        const platforms = (await call('catalog', { section: 'platforms', limit: 100 })).items;
        const templates = (await call('catalog', { section: 'templates', limit: 100 })).items;
        report.profiles = profiles;
        report.platforms = platforms;
        for (const target of ['HTML5', 'BILIBILI']) {
            assert(profiles.some(profile => profile.target === target && profile.id === '2d-basic' && profile.variant === 'release'), `${target} release profile missing`);
        }
        const template = templates.find(item => item.target === 'HTML5' && item.profile === '2d-basic' && item.variant === 'debug');
        assert(template, 'The real HTML5 2D starter is required');
        const created = await wait(await call('project_create', {
            directory: projectName, projectName, templateId: template.id, requestKey: '2048-create',
        }));
        await json('project-create.json', created);

        // Only this just-created project is edited; no existing user project is replaced.
        for (const directory of ['src', 'tests', 'assets']) await fs.rm(path.join(project, directory), { recursive: true, force: true });
        report.sources = [];
        for (const relative of ['src/main.ts', 'src/logic.ts', 'tests/logic.test.ts']) {
            const bytes = await fs.readFile(path.join(here, relative));
            await fs.mkdir(path.dirname(path.join(project, relative)), { recursive: true });
            await fs.writeFile(path.join(project, relative), bytes, { flag: 'wx' });
            report.sources.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
        }
        await fs.writeFile(path.join(project, 'game.json'), `${JSON.stringify({ appId, version: '0.1.0', deviceOrientation: 'portrait' }, null, 2)}\n`, { flag: 'wx' });
        await json('authored-source.json', report.sources);
        const checked = await wait(await call('project_check', {
            project: projectName, target: 'HTML5', profile: '2d-basic', checks: ['types', 'logic'], requestKey: '2048-check',
        }));
        assert(checked.report.logic?.passed > 0, 'The authored logic tests must actually execute');
        for (const key of ['failed', 'skipped', 'todo']) assert.equal(checked.report.logic[key], 0, key);
        report.logic = checked.report.logic;
        await json('project-check.json', checked);

        let html5Artifact;
        for (const target of ['HTML5', 'BILIBILI']) {
            const built = await wait(await call('game_build', {
                project: projectName, target, profile: '2d-basic', variant: 'release', requestKey: `2048-${target.toLowerCase()}`,
            }));
            await json(`build-${target.toLowerCase()}.json`, built);
            const artifact = built.report.artifacts[0];
            assert.equal(artifact.provenance.releaseId, report.releaseId);
            assert.equal(artifact.provenance.profileSha256, built.report.profile.descriptorSha256);
            assert.equal(artifact.sdkId, report.sdkId);
            assert.equal(artifact.variant, 'release');
            assert.equal(artifact.target, target);
            const source = path.join(state, hash(workspace), `artifact-${artifact.artifactId}`);
            const directory = path.join(exports, target.toLowerCase());
            const inventoryBytes = await readRegular(source, 'artifact-inventory.json');
            assert.equal(hash(inventoryBytes), artifact.sha256);
            const inventory = JSON.parse(inventoryBytes);
            assert.equal(inventory.provenance.releaseId, report.releaseId);
            await fs.cp(source, directory, { recursive: true, force: false, errorOnExist: true });
            let bytes = 0;
            for (const file of inventory.files) {
                assert(safePath(file.path));
                const copied = await readRegular(directory, file.path);
                assert.equal(copied.length, file.bytes, file.path);
                assert.equal(hash(copied), file.sha256, file.path);
                bytes += copied.length;
            }
            assert.equal(bytes, artifact.bytes);
            assert.equal(inventory.files.length, artifact.files);
            assert.equal(hash(await readRegular(directory, 'artifact-inventory.json')), artifact.sha256);
            report.exports.push({ ...artifact, directory, copiedInventoryVerified: true });
            if (target === 'HTML5') html5Artifact = artifact;
        }
        for (const target of ['WECHAT', 'BYTEDANCE', 'ALIPAY', 'OPPO']) {
            if (profiles.some(profile => profile.target === target && profile.id === '2d-basic' && profile.variant === 'release')) continue;
            report.unsupportedBuilds.push({ target, error: await call('game_build', {
                project: projectName, target, profile: '2d-basic', variant: 'release', requestKey: `2048-unsupported-${target.toLowerCase()}`,
            }, 'PROFILE_NOT_AVAILABLE') });
        }
        await json('exports.json', { exports: report.exports, unsupportedBuilds: report.unsupportedBuilds, platforms });
        const receipt = await call('preview_start', { artifactId: html5Artifact.artifactId, ttlSeconds: 600, requestKey: '2048-preview' });
        previewJob = receipt.jobId;
        const ready = await wait(receipt, true);
        previewUrl = ready.job.preview.url;
        report.preview = ready.job.preview;
        await json('preview-ready.json', ready);
        report.browser = await verifyGame({ url: previewUrl, evidence: path.join(evidence, 'browser'),
            drivers: flags.get('--drivers'), pngjs: flags.get('--pngjs'), chromium: flags.get('--chromium') });
        for (const source of report.sources) {
            assert.equal(hash(await fs.readFile(path.join(here, source.path))), source.sha256, 'Authored source changed during verification');
            assert.equal(hash(await fs.readFile(path.join(project, source.path))), source.sha256, 'Project source changed during verification');
        }
    } catch (error) {
        failure = error;
        report.error = error.stack ?? String(error);
        if (error.evidence) report.browser = error.evidence;
    } finally {
        try {
            if (previewJob) {
                report.previewStop = await call('preview_stop', { jobId: previewJob });
                assert.equal(report.previewStop.accepted, true);
                if (previewUrl) await assert.rejects(fetch(previewUrl, { signal: AbortSignal.timeout(5000) }));
            }
            await client.close();
            assert.equal(report.stderr, '', report.stderr);
        } catch (error) {
            failure ??= error;
            report.cleanupError = error.stack ?? String(error);
        } finally {
            await transport.close().catch(error => { failure ??= error; report.transportError = String(error); });
            report.success = !failure;
            report.finishedAt = new Date().toISOString();
            await json('result.json', report);
        }
    }
    if (failure) throw new Error(`2048 check failed; retained evidence: ${path.join(evidence, 'result.json')}`, { cause: failure });
    process.stdout.write(`${JSON.stringify({ success: true, project, exports: report.exports.map(item => item.directory), evidence,
        logic: report.logic, releaseId: report.releaseId, unsupportedTargets: report.unsupportedBuilds.map(item => item.target) }, null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error.stack}\n${error.cause?.stack ?? ''}\n`); process.exitCode = 1; });
