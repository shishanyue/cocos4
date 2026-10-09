import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
    const flags = new Map();
    for (let i = 2; i < process.argv.length; i += 2) {
        const [name, value] = process.argv.slice(i, i + 2);
        assert(['--kit', '--out', '--drivers', '--pngjs', '--chromium', '--targets',
            '--bilibili-app-id', '--wechat-app-id', '--bytedance-app-id'].includes(name)
            && !flags.has(name) && value && !value.startsWith('--'),
            'Expected unique --kit/--out paths, optional --targets CSV and --bilibili-app-id/--wechat-app-id/--bytedance-app-id; '
            + 'HTML5 requires --drivers/--pngjs/--chromium paths');
        flags.set(name, value);
    }
    const targets = (flags.get('--targets') ?? 'HTML5,BILIBILI').split(',');
    assert(targets.every(target => ['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE'].includes(target))
        && new Set(targets).size === targets.length, '--targets must be a nonempty CSV of HTML5,BILIBILI,WECHAT,BYTEDANCE without duplicates');
    const html5Selected = targets.includes('HTML5');
    const checkTarget = targets.find(target => target === 'WECHAT' || target === 'BYTEDANCE') ?? targets[0];
    for (const name of ['--kit', '--out', ...['--drivers', '--pngjs', '--chromium'].filter(name => html5Selected || flags.has(name))]) {
        const value = flags.get(name);
        assert(value && path.isAbsolute(value) && path.resolve(value) === value, `${name} must be a canonical absolute path`);
        const existing = name === '--out' ? path.dirname(value) : value;
        assert.equal(await fs.realpath(existing), existing, `${name} must not contain symlinks`);
        const stat = await fs.stat(existing);
        assert(name === '--chromium' ? stat.isFile() : stat.isDirectory(), `${name} must refer to ${name === '--chromium' ? 'a file' : 'a directory (parent for --out)'}`);
        if (name === '--chromium') await fs.access(value, fs.constants.X_OK);
    }
    const kit = flags.get('--kit'), out = flags.get('--out');
    await assert.rejects(fs.lstat(out), { code: 'ENOENT' }, '--out must be absent; existing runs are never overwritten');
    // These defaults are local test identities, not publishable vendor app IDs.
    const appId = flags.get('--bilibili-app-id') ?? 'TEST_ONLY_2048_LOCAL';
    const wechatAppId = flags.get('--wechat-app-id') ?? 'wx0000000000000000';
    const bytedanceAppId = flags.get('--bytedance-app-id') ?? 'tt0000000000000000';
    assert(appId.trim() === appId && appId.length > 0 && appId.length <= 256, 'Invalid --bilibili-app-id');
    assert(wechatAppId.trim() === wechatAppId && /^wx[A-Za-z0-9]+$/.test(wechatAppId) && wechatAppId.length <= 128,
        '--wechat-app-id must be wx-prefixed alphanumeric, at most 128 characters');
    assert(bytedanceAppId.trim() === bytedanceAppId && /^tt[A-Za-z0-9]+$/.test(bytedanceAppId) && bytedanceAppId.length <= 128,
        '--bytedance-app-id must be tt-prefixed alphanumeric, at most 128 characters');
    assert.equal(await fs.realpath(process.execPath), path.join(kit, 'runtime/node'), 'Run this example with the selected kit\'s bundled Node');
    const release = JSON.parse(await fs.readFile(path.join(kit, 'release.json'), 'utf8'));
    assert.equal(process.versions.node, release.runtime.node.version);
    await fs.mkdir(out, { mode: 0o700 });
    const workspace = path.join(out, 'workspace'), state = path.join(out, 'state');
    const evidence = path.join(out, 'evidence'), exports = path.join(out, 'exports'), home = path.join(out, 'home');
    for (const directory of [workspace, evidence, exports, home]) await fs.mkdir(directory, { mode: 0o700 });
    const projectName = 'game-2048', project = path.join(workspace, projectName);
    const report = {
        schemaVersion: 1, scope: 'One 2048 game through a packaged MCP, not a full engine/platform test matrix',
        startedAt: new Date().toISOString(), success: false, kit, project, state, node: process.version,
        releaseId: release.releaseId, sdkId: release.sdk.sdkId, targets,
        distributionApproved: release.distributionApproved,
        bilibili: { appId, testOnlyAppId: appId === 'TEST_ONLY_2048_LOCAL', vendorOrDeviceTested: false },
        wechat: { appId: wechatAppId, testOnlyAppId: wechatAppId === 'wx0000000000000000', vendorOrDeviceTested: false },
        bytedance: { appId: bytedanceAppId, testOnlyAppId: bytedanceAppId === 'tt0000000000000000', vendorOrDeviceTested: false },
        browser: { performed: false, reason: html5Selected ? 'HTML5 browser verification has not started.'
            : 'HTML5 was not selected; no preview or browser verification was performed.' },
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
        args: ['mcp', '--workspace', workspace, '--state-root', state, '--mode', 'develop', '--preview', String(html5Selected), '--execute-tests', 'true'],
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
        for (const target of targets) {
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
        const platformConfigs = new Map();
        report.configs = [];
        for (const target of targets) {
            if (target !== 'WECHAT' && target !== 'BYTEDANCE') continue;
            const directory = `platforms/${target.toLowerCase()}`;
            await fs.mkdir(path.join(project, directory), { recursive: true });
            const configs = new Map();
            // Author project-owned metadata explicitly; never copy SDK validation configs.
            for (const [name, value] of Object.entries({
                'game.json': { deviceOrientation: 'portrait' },
                'project.config.json': { appid: target === 'WECHAT' ? wechatAppId : bytedanceAppId,
                    projectname: projectName, compileType: 'game', [target === 'WECHAT' ? 'miniprogramRoot' : 'gameRoot']: './' },
            })) {
                const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
                const relative = `${directory}/${name}`;
                await fs.writeFile(path.join(project, relative), bytes, { flag: 'wx' });
                configs.set(name, bytes);
                report.configs.push({ target, path: relative, exportPath: name, bytes: bytes.length, sha256: hash(bytes) });
            }
            platformConfigs.set(target, configs);
        }
        await json('authored-source.json', report.sources);
        await json('authored-config.json', report.configs);
        const checked = await wait(await call('project_check', {
            project: projectName, target: checkTarget, profile: '2d-basic', checks: ['types', 'logic'], requestKey: '2048-check',
        }));
        assert.equal(checked.report.profile.target, checkTarget);
        assert.equal(checked.report.profile.sdkId, report.sdkId);
        for (const level of ['gameTypecheck', 'profileLinkage']) assert(checked.report.validationLevels.includes(level), `${level} evidence missing`);
        assert(checked.report.logic?.passed > 0, 'The authored logic tests must actually execute');
        for (const key of ['failed', 'skipped', 'todo']) assert.equal(checked.report.logic[key], 0, key);
        report.logic = checked.report.logic;
        await json('project-check.json', checked);

        let html5Artifact;
        for (const target of targets) {
            const built = await wait(await call('game_build', {
                project: projectName, target, profile: '2d-basic', variant: 'release', requestKey: `2048-${target.toLowerCase()}`,
            }));
            await json(`build-${target.toLowerCase()}.json`, built);
            const artifact = built.report.artifacts[0];
            assert.equal(artifact.provenance.releaseId, report.releaseId);
            assert.equal(artifact.provenance.profileSha256, built.report.profile.descriptorSha256);
            assert.equal(artifact.sdkId, report.sdkId);
            assert.equal(artifact.profile, '2d-basic');
            assert.equal(artifact.variant, 'release');
            assert.equal(artifact.target, target);
            const source = path.join(state, hash(workspace), `artifact-${artifact.artifactId}`);
            const directory = path.join(exports, target.toLowerCase());
            const inventoryBytes = await readRegular(source, 'artifact-inventory.json');
            assert.equal(hash(inventoryBytes), artifact.sha256);
            const inventory = JSON.parse(inventoryBytes);
            assert.deepEqual(inventory.provenance, artifact.provenance);
            assert.equal(inventory.sdkId, report.sdkId);
            assert.equal(inventory.target, target);
            assert.equal(inventory.profile, artifact.profile);
            assert.equal(inventory.variant, 'release');
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
            for (const [name, authored] of platformConfigs.get(target) ?? []) {
                assert(inventory.files.some(file => file.path === name), `${target} inventory must include ${name}`);
                assert.deepEqual(await readRegular(directory, name), authored, `${target}/${name} must be exported verbatim`);
            }
            report.exports.push({ ...artifact, directory, copiedInventoryVerified: true,
                ...(platformConfigs.has(target) ? { platformConfigBytesVerified: true } : {}) });
            if (target === 'HTML5') html5Artifact = artifact;
        }
        for (const target of ['WECHAT', 'BYTEDANCE', 'ALIPAY', 'OPPO']) {
            if (profiles.some(profile => profile.target === target)) continue;
            report.unsupportedBuilds.push({ target, error: await call('game_build', {
                project: projectName, target, profile: '2d-basic', variant: 'release', requestKey: `2048-unsupported-${target.toLowerCase()}`,
            }, 'PROFILE_NOT_AVAILABLE') });
        }
        await json('exports.json', { exports: report.exports, unsupportedBuilds: report.unsupportedBuilds, platforms });
        if (html5Selected) {
            const receipt = await call('preview_start', { artifactId: html5Artifact.artifactId, ttlSeconds: 600, requestKey: '2048-preview' });
            previewJob = receipt.jobId;
            const ready = await wait(receipt, true);
            previewUrl = ready.job.preview.url;
            report.preview = ready.job.preview;
            await json('preview-ready.json', ready);
            const { verifyGame } = await import('./browser-smoke.mjs');
            report.browser = { performed: true };
            Object.assign(report.browser, await verifyGame({ url: previewUrl, evidence: path.join(evidence, 'browser'),
                drivers: flags.get('--drivers'), pngjs: flags.get('--pngjs'), chromium: flags.get('--chromium') }));
        }
        for (const source of report.sources) {
            assert.equal(hash(await fs.readFile(path.join(here, source.path))), source.sha256, 'Authored source changed during verification');
            assert.equal(hash(await fs.readFile(path.join(project, source.path))), source.sha256, 'Project source changed during verification');
        }
        for (const config of report.configs) {
            assert.equal(hash(await fs.readFile(path.join(project, config.path))), config.sha256, 'Project platform config changed during verification');
        }
    } catch (error) {
        failure = error;
        report.error = error.stack ?? String(error);
        if (error.evidence) report.browser = { performed: true, ...error.evidence };
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
