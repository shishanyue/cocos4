import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { verifyBrowserGame } from './browser-game.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const required = process.env.RELEASE_GAME_INTEGRATION === '1';
const sdkRoot = process.env.RELEASE_GAME_SDK_ROOT && resolve(process.env.RELEASE_GAME_SDK_ROOT);
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const targets = ['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE'];
const profiles = ['2d-basic', '3d-basic'];
const sourcePreflights = { BILIBILI: 'bilibiliSourcePreflight', WECHAT: 'wechatSourcePreflight', BYTEDANCE: 'bytedanceSourcePreflight' };

test('official MCP builds actual edited release games for all four targets and both profiles and preserves failed-build evidence',
    { skip: !sdkRoot && !required, timeout: 1200000 }, async t => {
        assert(sdkRoot, 'RELEASE_GAME_SDK_ROOT is required for explicit release acceptance');
        if (required) assert(process.env.GAME_CHROME_EXECUTABLE, 'Explicit acceptance requires real edited-game browser verification');
        const before = await fs.readFile(join(sdkRoot, 'manifest.json'));
        const manifest = JSON.parse(before);
        assert.deepEqual(manifest.catalog.profiles.map(item => `${item.target}/${item.id}/${item.variant}`).sort(),
            targets.flatMap(target => profiles.flatMap(profile => ['debug', 'release'].map(variant => `${target}/${profile}/${variant}`))).sort());
        const root = await fs.realpath(await fs.mkdtemp(join(devkit, 'build/release-development-')));
        const workspace = join(root, 'workspace');
        const stateRoot = join(root, 'state');
        const home = join(root, 'home');
        for (const directory of [workspace, home]) await fs.mkdir(directory, { mode: 0o700 });
        const state = join(stateRoot, hash(await fs.realpath(workspace)));
        const ajv = new AjvJsonSchemaValidator();
        const client = new Client({ name: 'cocos4-release-acceptance', version: '1.0.0' }, { jsonSchemaValidator: ajv });
        const transport = new StdioClientTransport({ command: process.execPath,
            args: [join(devkit, 'build/src/cli.js'), 'mcp', '--sdk-root', sdkRoot, '--workspace', workspace,
                '--state-root', stateRoot, '--mode', 'develop', '--preview', 'true'],
            cwd: workspace, env: { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'),
                APPDATA: join(home, 'AppData/Roaming'), PATH: '', NODE_PATH: '', NODE_OPTIONS: '', npm_config_offline: 'true' }, stderr: 'pipe' });
        const evidence = { node: process.version, sdkId: manifest.sdkId, sdkManifestSha256: hash(before),
            success: false, jobs: [], browsers: [], sourceOnlyTargets: Object.keys(sourcePreflights), vendorOrDeviceValidated: false };
        let stderr = '';
        transport.stderr.on('data', bytes => { stderr += bytes; });
        t.after(async () => {
            await client.close();
            await fs.writeFile(join(root, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            assert.equal(stderr, '');
        });
        await client.connect(transport, { timeout: 120000 });
        const { tools } = await client.listTools();
        const validators = new Map(tools.map(tool => [tool.name, ajv.getValidator(tool.outputSchema)]));
        const call = async (operation, args, error = null) => {
            const name = `cocos4_${operation}`;
            const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 30000 });
            assert.equal(validators.get(name)(result.structuredContent).valid, true);
            assert.equal(result.isError, error !== null, JSON.stringify(result.structuredContent));
            assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
            assert(Buffer.byteLength(JSON.stringify(result)) < 65536);
            if (error) assert.equal(result.structuredContent.error.code, error);
            else assert.equal(result.structuredContent.sdkId, manifest.sdkId);
            return result.structuredContent.data;
        };
        const finished = async receipt => {
            const end = Date.now() + 180000;
            while (Date.now() < end) {
                const page = await call('job_get', { jobId: receipt.jobId, limit: 100 });
                if (terminal.has(page.job.state)) {
                    assert.equal(page.nextCursor, null);
                    evidence.jobs.push(page);
                    return page;
                }
                await delay(50);
            }
            assert.fail(`Job ${receipt.jobId} did not finish; evidence is retained at ${root}`);
        };
        const succeeded = page => {
            assert.equal(page.job.state, 'succeeded', JSON.stringify(page));
            assert.equal(page.job.exitCode, 0);
            assert.equal(page.job.signal, null);
            assert.equal(page.job.discardedLogBytes, 0);
            return page;
        };
        let completed = 0;
        for (const target of targets) for (const profile of profiles) {
            await t.test(`${target}/${profile}/release`, async t => {
                const project = `${target.toLowerCase()}-${profile}`;
                const template = manifest.catalog.templates.find(item => item.target === target && item.profile === profile && item.variant === 'release');
                assert(template);
                const createArgs = { directory: project, projectName: project, templateId: template.id, requestKey: `create-${project}` };
                await call('project_create', { ...createArgs, requestKey: undefined }, 'INVALID_ARGUMENTS');
                const created = succeeded(await finished(await call('project_create', createArgs)));
                assert.equal(created.report.profile.variant, 'release');
                const files = created.report.items.filter(item => item.code === 'PROJECT_FILE');
                assert(files.length >= 8);
                for (const item of files) {
                    const bytes = await fs.readFile(join(workspace, project, item.file));
                    assert.equal(bytes.length, item.bytes);
                    assert.equal(hash(bytes), item.sha256);
                }
                const main = join(workspace, project, 'src/main.ts');
                const source = (await fs.readFile(main, 'utf8')).replace('pointsPerClick = 7', 'pointsPerClick = 11')
                    + `\nexport const releaseRevision = ${JSON.stringify(project)};\n`;
                await fs.writeFile(main, source);
                await fs.writeFile(join(workspace, project, 'assets/release.txt'), project);
                let gameJson, projectConfigJson;
                if (target !== 'HTML5') {
                    const configDirectory = target === 'BILIBILI' ? join(workspace, project)
                        : join(workspace, project, 'platforms', target.toLowerCase());
                    const filename = join(configDirectory, 'game.json');
                    const config = JSON.parse(await fs.readFile(filename));
                    if (target === 'BILIBILI') config.appId = 'TEST_ONLY_RELEASE_ACCEPTANCE';
                    gameJson = ` \n${JSON.stringify(config, null, 2)}\n`;
                    await fs.writeFile(filename, gameJson);
                    if (target !== 'BILIBILI') {
                        const projectFilename = join(configDirectory, 'project.config.json');
                        const projectConfig = JSON.parse(await fs.readFile(projectFilename));
                        assert.equal(projectConfig.appid, '', 'Editable starters must require a user-owned platform appid');
                        projectConfig.appid = `${target === 'WECHAT' ? 'wx' : 'tt'}0000000000000000`;
                        projectConfigJson = ` \n${JSON.stringify(projectConfig, null, 2)}\n`;
                        await fs.writeFile(projectFilename, projectConfigJson);
                    }
                }
                const checkArgs = { project, target, profile, checks: ['types'], requestKey: `check-${project}`, timeoutMs: 3600000 };
                const checked = succeeded(await finished(await call('project_check', checkArgs)));
                assert.equal(checked.job.deadline - checked.job.createdAt, 3600000);
                assert.equal(checked.report.profile.variant, 'debug', 'Type checks select the delivered debug profile');
                const args = { project, target, profile, variant: 'release', requestKey: `build-${project}`, timeoutMs: 180000 };
                const receipt = await call('game_build', args);
                assert.equal((await call('game_build', args)).jobId, receipt.jobId);
                await call('game_build', { ...args, timeoutMs: 180001 }, 'REQUEST_CONFLICT');
                const built = succeeded(await finished(receipt));
                const artifact = built.report.artifacts[0];
                assert.equal(artifact.variant, 'release');
                assert.equal(artifact.target, target);
                assert.equal(built.job.deadline - built.job.createdAt, args.timeoutMs);
                const delivered = manifest.catalog.profiles.find(item => item.target === target && item.id === profile && item.variant === 'release');
                assert.equal(built.report.profile.descriptorSha256, manifest.files.find(file => file.path === delivered.descriptor).sha256);
                const directory = join(state, `artifact-${artifact.artifactId}`);
                const raw = await fs.readFile(join(directory, 'artifact-inventory.json'));
                assert.equal(hash(raw), artifact.sha256);
                const inventory = JSON.parse(raw);
                for (const file of inventory.files) {
                    const bytes = await fs.readFile(join(directory, file.path));
                    assert.equal(hash(bytes), file.sha256);
                    assert.equal(bytes.length, file.bytes);
                    assert(!/\.map$|^types\/|^template\/|^toolchain\//.test(file.path));
                    if (file.path.endsWith('.js')) assert.doesNotMatch(bytes.toString(), /sourceMappingURL|sourcesContent/);
                }
                const compiler = JSON.parse(await fs.readFile(join(directory, 'game-compiler.json')));
                assert.deepEqual(compiler.emission, { variant: 'release', sourceMaps: false, minified: true, compact: true, comments: 'license-only' });
                assert.deepEqual([compiler.typeChecking.strict, compiler.typeChecking.skipLibCheck, compiler.typeChecking.skipDefaultLibCheck], [true, false, false]);
                assert((await fs.readFile(join(directory, 'game/main.js'), 'utf8')).includes(project));
                assert.equal(await fs.readFile(join(directory, 'assets/game/release.txt'), 'utf8'), project);
                const previewArgs = { artifactId: artifact.artifactId, ttlSeconds: 180, requestKey: `preview-${project}` };
                if (target !== 'HTML5') {
                    assert.equal(await fs.readFile(join(directory, 'game.json'), 'utf8'), gameJson);
                    if (projectConfigJson) assert.equal(await fs.readFile(join(directory, 'project.config.json'), 'utf8'), projectConfigJson);
                    assert(built.report.validationLevels.includes(sourcePreflights[target]));
                    await call('preview_start', previewArgs, 'UNSUPPORTED_PROJECT');
                } else if (process.env.GAME_CHROME_EXECUTABLE) {
                    const previewReceipt = await call('preview_start', previewArgs);
                    let job;
                    for (let count = 0; count < 600; count++) {
                        job = (await call('job_get', { jobId: previewReceipt.jobId })).job;
                        assert(!terminal.has(job.state), JSON.stringify(job));
                        if (job.phase === 'ready') break;
                        await delay(50);
                    }
                    assert.equal(job.phase, 'ready');
                    try {
                        const browser = await verifyBrowserGame({ preview: job.preview, artifact, artifactDirectory: directory,
                            executablePath: process.env.GAME_CHROME_EXECUTABLE });
                        evidence.browsers.push({ artifactId: artifact.artifactId, directory: browser.evidenceDirectory, validation: browser.report.validation });
                    } finally { await call('preview_stop', { jobId: job.jobId }); }
                    await assert.rejects(fetch(job.preview.url, { signal: AbortSignal.timeout(5000) }));
                }
                await fs.appendFile(main, '\nexport const broken: number = "release error";\n');
                const failed = await finished(await call('game_build', { ...args, requestKey: randomUUID() }));
                assert.equal(failed.job.state, 'failed');
                assert.equal(failed.job.exitCode, 0, 'A zero worker exit does not turn a domain failure into success');
                assert.equal(failed.job.error.code, 'TYPECHECK_FAILED');
                assert.equal(failed.report.profile.variant, 'release');
                assert.equal(failed.report.artifacts, undefined);
                await fs.writeFile(main, source);
                if (target === 'HTML5' && profile === '2d-basic') {
                    const timed = await finished(await call('game_build', { ...args, timeoutMs: 1000, requestKey: randomUUID() }));
                    assert.equal(timed.job.state, 'timed_out');
                    assert.equal(timed.job.error.code, 'TIMEOUT');
                    assert.equal(timed.report, null);
                }
                assert.equal(hash(await fs.readFile(join(directory, 'artifact-inventory.json'))), artifact.sha256);
                assert(!(await fs.readdir(state)).some(name => name.startsWith('staging-')));
                completed++;
                t.diagnostic(`${target}/${profile}/release: ${artifact.sha256}; ${artifact.bytes} source bytes`);
            });
        }
        assert.deepEqual(await fs.readFile(join(sdkRoot, 'manifest.json')), before);
        evidence.success = completed === targets.length * profiles.length;
        assert.equal(completed, 8, 'Every target/profile must pass all acceptance steps');
        t.diagnostic(`Retained release MCP evidence: ${root}`);
    });
