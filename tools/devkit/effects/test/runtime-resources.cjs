// Read-only resource probe. Reuses a prepared HTML5 engine/loader, never its assets or game fixture.
// Usage: node runtime-resources.cjs <artifact-directory> <html5-runtime-directory> <absolute-chrome-path>
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const { chromium } = createRequire(path.resolve(__dirname, '../../runtime/package.json'))('playwright-core');
const { collectBuiltinInputs, profiles } = require('../builtin-inputs.cjs');
const { readRegular, sha256 } = require('../../runtime/files.cjs');

async function main() {
    assert.equal(process.argv.length, 5, 'Expected artifact-directory, html5-runtime-directory, absolute-chrome-path');
    const artifact = await fs.realpath(process.argv[2]);
    const runtime = await fs.realpath(process.argv[3]);
    const executablePath = process.argv[4];
    assert.ok(path.isAbsolute(executablePath));
    const engine = path.resolve(__dirname, '../../../..');
    const resultBytes = await readRegular(artifact, 'result.json');
    const result = JSON.parse(resultBytes);
    const descriptorBytes = await readRegular(runtime, 'runtime.json');
    const descriptor = JSON.parse(descriptorBytes);
    assert.equal(descriptor.target, 'HTML5');
    assert.equal(descriptor.mode, 'BUILD');
    // Both profiles serialize the same EffectAsset/Material classes; this is not a profile-matched game run.
    assert.ok(Object.hasOwn(profiles, descriptor.profile), `Unknown prepared runtime profile: ${descriptor.profile}`);
    assert.deepEqual(descriptor.features, profiles[descriptor.profile]);
    assert.deepEqual(result.features, profiles[result.profile]);
    const missingRuntimeFeatures = result.features.filter(feature => !descriptor.features.includes(feature));
    for (const name of ['TEST', 'EDITOR', 'PREVIEW', 'NODEJS', 'NATIVE', 'JSB']) {
        assert.equal(descriptor.constants[name], false, name);
    }
    const files = new Map();
    for (const entry of result.files) {
        const bytes = await readRegular(artifact, entry.path);
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(sha256(bytes), entry.sha256, entry.path);
        files.set(entry.path, bytes);
    }
    const config = JSON.parse(files.get('assets/internal/config.json'));
    const fragment = JSON.parse(files.get('settings.fragment.json'));
    assert.deepEqual(config.uuids, fragment.engine.builtinAssets);
    assert.equal(fragment.rendering.customPipeline, false);
    const inputs = collectBuiltinInputs(engine, result.profile);
    const expected = inputs.assets.map(asset => ({ uuid: asset.uuid, type: asset.material ? 'cc.Material' : 'cc.EffectAsset',
        name: asset.material ? asset.name : path.relative(path.join(engine, 'editor/assets/effects'), asset.file)
            .replaceAll('\\', '/').replace(/\.effect$/, '') }));
    assert.deepEqual(config.uuids, expected.map(asset => asset.uuid));
    const sourceChanges = [...new Set([...Object.keys(result.inputs), ...inputs.inputs.keys()])]
        .filter(name => inputs.inputs.get(name) !== result.inputs[name]);
    const importMap = JSON.parse(await readRegular(runtime, 'import-map.json'));
    const runtimeFiles = new Set(['loader.js', 'import-map.json']);
    for (const url of Object.values(importMap.imports)) {
        assert.ok(url.startsWith('./'), `Nonlocal engine import: ${url}`);
        runtimeFiles.add(url.slice(2));
    }
    for (const entry of descriptor.files) {
        if (entry.path.startsWith('engine/')) runtimeFiles.add(entry.path);
    }
    const runtimeHashes = {};
    for (const name of runtimeFiles) {
        const bytes = await readRegular(runtime, name);
        const entry = descriptor.files.find(entry => entry.path === name);
        assert.ok(entry, `Unrecorded runtime file: ${name}`);
        assert.equal(sha256(bytes), entry.sha256, name);
        files.set(name, bytes);
        runtimeHashes[name] = entry.sha256;
    }
    const report = { artifact, runtime, artifactProfile: result.profile, runtimeProfile: descriptor.profile, missingRuntimeFeatures,
        artifactReportSha256: sha256(resultBytes), runtimeDescriptorSha256: sha256(descriptorBytes),
        runtimeHashes, sourceChanges, browser: '', requests: [], console: [], pageErrors: [], resources: null,
        validation: { resourceDeserialization: false, builtinLoading: false, shaderMetadata: false, graphics: false },
        limitations: ['Prepared engine build, not a fresh source build', 'Headless resource validation only; no scene, pixels or device validation'] };
    if (missingRuntimeFeatures.length) report.limitations.push(`Resource classes only; engine omits: ${missingRuntimeFeatures.join(', ')}`);
    files.set('settings.json', Buffer.from(JSON.stringify({ ...fragment,
        rendering: { ...fragment.rendering, renderMode: 2 }, splashScreen: { totalTime: 0 },
        screen: { designResolution: { width: 640, height: 480, policy: 4 } },
        assets: { projectBundles: ['internal'], preloadBundles: [], preloadAssets: [] },
        scripting: { scriptPackages: [] }, launch: { launchScene: '' }, profiling: { showFPS: false },
    })));
    files.set('', Buffer.from('<!doctype html><html><head><meta charset="utf-8"></head><body>'
        + '<div id="GameDiv"><div id="Cocos3dGameContainer"><canvas id="GameCanvas" width="640" height="480"></canvas></div></div>'
        + '<script src="loader.js"></script><script type="systemjs-importmap" src="import-map.json"></script></body></html>'));
    const server = http.createServer((request, response) => {
        const name = new URL(request.url, 'http://localhost').pathname.slice(1);
        const bytes = files.get(name);
        const status = name === 'favicon.ico' ? 204 : bytes ? 200 : 404;
        report.requests.push({ path: name, status });
        response.writeHead(status, { 'Content-Type': name.endsWith('.js') ? 'text/javascript'
            : name.endsWith('.json') ? 'application/json' : 'text/html', 'Cache-Control': 'no-store' });
        response.end(bytes);
    });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({ executablePath, headless: true,
            args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
        report.browser = browser.version();
        const page = await browser.newPage();
        await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        page.on('console', message => report.console.push({ type: message.type(), text: message.text() }));
        page.on('pageerror', error => report.pageErrors.push(String(error.stack || error)));
        await page.goto(origin, { waitUntil: 'load', timeout: 30000 });
        report.resources = await page.evaluate(async (expected) => {
            const cc = await System.import('cc');
            const check = (value, message) => { if (!value) throw new Error(message); };
            const rows = [];
            for (const entry of expected) {
                const response = await fetch(`assets/internal/import/${entry.uuid.slice(0, 2)}/${entry.uuid}.json`);
                check(response.ok, `Missing import: ${entry.uuid}`);
                const json = await response.json();
                const asset = cc.deserialize(json);
                check(asset instanceof (entry.type === 'cc.Material' ? cc.Material : cc.EffectAsset), `Wrong class: ${entry.uuid}`);
                check(asset.name === json._name, `Name lost: ${entry.uuid}`);
                if (asset instanceof cc.EffectAsset) {
                    check(JSON.stringify(asset.shaders) === JSON.stringify(json.shaders), `Reflection changed: ${entry.uuid}`);
                    check(JSON.stringify(asset.techniques) === JSON.stringify(json.techniques), `Passes changed: ${entry.uuid}`);
                }
                rows.push({ ...entry, serializedName: asset.name, effectUuid: json._effectAsset?.__uuid__,
                    techniques: json.techniques,
                    shaders: json.shaders?.map(({ glsl1, glsl3, glsl4, descriptors, ...reflection }) => ({ ...reflection,
                        descriptors: descriptors.map(set => ({ rate: set.rate, blocks: set.blocks.map(block => block.name),
                            samplerTextures: set.samplerTextures.map(sampler => sampler.name) })),
                        sourceLengths: [glsl1, glsl3, glsl4].map(source => [source.vert.length, source.frag.length]) })) });
            }
            const out = { deserialized: rows.length, rows, initError: null, loaded: [], registryMismatches: [], namespaceMismatches: [],
                attributesChecked: 0, conditionalAttributesChecked: 0, missingFormats: 0, reflectionIssues: [], legacyInitialization: null };
            try {
                await Promise.race([cc.game.init({ settingsPath: 'settings.json', debugMode: 1 }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('game.init timeout')), 30000))]);
            } catch (error) { out.initError = String(error.stack || error); }
            for (const row of rows) {
                const asset = cc.assetManager.assets.get(row.uuid);
                const isMaterial = asset instanceof cc.Material;
                out.loaded.push({ uuid: row.uuid, name: asset?.name, valid: !!asset && cc.isValid(asset),
                    nameMatches: asset?.name === row.name,
                    correctClass: asset instanceof (row.type === 'cc.Material' ? cc.Material : cc.EffectAsset),
                    builtinIdentity: cc.cclegacy.builtinResMgr.get(row.name) === asset && !!asset,
                    effectIdentity: row.effectUuid ? asset?.effectAsset === cc.assetManager.assets.get(row.effectUuid) : undefined,
                    passes: isMaterial ? asset.passes.map(pass => ({ program: pass.program, phase: pass.phase,
                        passIndex: pass.passIndex, propertyIndex: pass.propertyIndex, hash: pass.hash })) : undefined });
                if (row.type === 'cc.EffectAsset' && cc.EffectAsset.get(row.name) !== asset) {
                    out.registryMismatches.push({ uuid: row.uuid, expected: row.name, actual: asset?.name });
                }
                if (asset?.name !== row.name) out.namespaceMismatches.push({ uuid: row.uuid, expected: row.name, actual: asset?.name });
                for (const technique of row.techniques || []) {
                    for (const pass of technique.passes) {
                        if (!row.shaders.some(shader => shader.name === pass.program)) {
                            out.namespaceMismatches.push({ uuid: row.uuid, program: pass.program });
                        }
                    }
                }
                for (const shader of row.shaders || []) {
                    const template = cc.cclegacy.programLib.getTemplate(shader.name);
                    const info = template && cc.cclegacy.programLib.getTemplateInfo(shader.name);
                    if (!shader.name.startsWith(`${row.name}|`) || !template) {
                        out.namespaceMismatches.push({ uuid: row.uuid, program: shader.name });
                    }
                    const defineNames = new Set(shader.defines.map(define => define.name));
                    for (const [index, attribute] of shader.attributes.entries()) {
                        out.attributesChecked++;
                        if (attribute.defines?.length) out.conditionalAttributesChecked++;
                        const runtimeAttribute = info?.gfxAttributes[index];
                        const validFormat = Number.isInteger(attribute.format) && attribute.format > cc.gfx.Format.UNKNOWN
                            && attribute.format < cc.gfx.Format.COUNT && typeof cc.gfx.Format[attribute.format] === 'string';
                        if (!validFormat) out.missingFormats++;
                        if (!validFormat || !(runtimeAttribute instanceof cc.gfx.Attribute) || runtimeAttribute.format !== attribute.format) {
                            out.reflectionIssues.push({ program: shader.name, attribute: attribute.name,
                                defines: attribute.defines, issue: 'Missing/unknown/mismatched attribute format',
                                format: attribute.format, runtimeFormat: runtimeAttribute?.format });
                        }
                        if (!Array.isArray(attribute.defines) || !attribute.defines.every(condition =>
                            typeof condition === 'string' && /^!?[A-Za-z_]\w*$/.test(condition)
                            && defineNames.has(condition.replace(/^!/, '')))
                            || JSON.stringify(template?.attributes[index]?.defines) !== JSON.stringify(attribute.defines)
                            || !!runtimeAttribute?.isInstanced !== !!attribute.isInstanced
                            || !!runtimeAttribute?.isNormalized !== !!attribute.isNormalized) {
                            out.reflectionIssues.push({ program: shader.name, attribute: attribute.name,
                                defines: attribute.defines, issue: 'Invalid/mismatched conditional metadata' });
                        }
                    }
                }
            }
            const sceneData = cc.director.root?.pipeline?.pipelineSceneData;
            if (sceneData) out.legacyInitialization = {
                geometryEffect: !!cc.EffectAsset.get('internal/builtin-geometry-renderer'),
                geometryPasses: sceneData.geometryRendererPasses.length,
                occlusionEffect: !!cc.EffectAsset.get('internal/builtin-occlusion-query'),
                occlusionPass: !!sceneData.getOcclusionQueryPass(),
            };
            cc.game.pause();
            return out;
        }, expected);
        // Prove that config.json + the generated no-op index.js are not sufficient by themselves.
        const negative = await browser.newPage();
        await negative.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname !== '/import-map.json') return route.continue();
            const imports = { ...importMap.imports };
            delete imports['virtual:///prerequisite-imports/internal'];
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ imports }) });
        });
        await negative.goto(origin, { waitUntil: 'load', timeout: 30000 });
        report.withoutPrerequisite = await negative.evaluate(async () => {
            const cc = await System.import('cc');
            try {
                await cc.game.init({ settingsPath: 'settings.json', debugMode: 1 });
                return null;
            } catch (error) { return String(error.stack || error); }
            finally { cc.game.pause(); }
        });
        assert.match(report.withoutPrerequisite || '', /prerequisite-imports\/internal/);
        report.validation.resourceDeserialization = report.resources.deserialized === expected.length;
        report.validation.builtinLoading = !report.resources.initError && report.resources.loaded.length === expected.length
            && report.resources.loaded.every(asset =>
            asset.valid && asset.nameMatches && asset.correctClass && asset.builtinIdentity && asset.effectIdentity !== false
            && (!asset.passes || asset.passes.length > 0));
        report.validation.shaderMetadata = report.resources.attributesChecked > 0 && report.resources.reflectionIssues.length === 0;
        const errors = report.console.filter(message => message.type === 'error');
        report.success = report.validation.resourceDeserialization && report.validation.builtinLoading
            && report.resources.registryMismatches.length === 0 && report.resources.namespaceMismatches.length === 0
            && report.validation.shaderMetadata && !sourceChanges.length
            && !errors.length && !report.pageErrors.length && report.requests.every(request => request.status < 400);
        console.log(JSON.stringify(report, null, 2));
        if (!report.success) process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
