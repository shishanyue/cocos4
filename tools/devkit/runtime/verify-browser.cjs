const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { PNG } = require('../../../node_modules/pngjs');
const { assertAbsent, inventory, readRegular, sha256 } = require('./files.cjs');

async function verifyBrowser({ runtimeDirectory, executablePath, outDirectory, headless = true }) {
    assert.ok(path.isAbsolute(executablePath), 'An explicit absolute Chrome executablePath is required');
    await fs.access(executablePath, fs.constants.X_OK);
    const executableSha256 = sha256(await fs.readFile(executablePath));
    const root = await fs.realpath(runtimeDirectory);
    const descriptorBytes = await readRegular(root, 'runtime.json');
    const descriptor = JSON.parse(descriptorBytes);
    assert.equal(descriptor.target, 'HTML5', 'Browser evidence requires an actual HTML5 runtime');
    assert.ok(['debug', 'release'].includes(descriptor.variant));
    assert.equal(descriptor.constants.DEBUG, descriptor.variant === 'debug');
    assert.equal(descriptor.compressed, descriptor.variant === 'release');
    assert.equal(descriptor.sourceMap, false);
    assert.deepEqual((await inventory(root)).filter(file => file.path !== 'runtime.json'), descriptor.files,
        'Runtime descriptor/file integrity mismatch');
    const output = path.resolve(outDirectory);
    await assertAbsent(output);
    await fs.mkdir(output);
    const report = { schemaVersion: 1, profile: descriptor.profile, runtimeSha256: sha256(descriptorBytes),
        ...(descriptor.buildOptions ? { build: { target: descriptor.target, variant: descriptor.variant,
            optionsSha256: sha256(JSON.stringify(descriptor.buildOptions)),
            engineSha256: descriptor.files.find(file => file.path === descriptor.engineEntry.slice(2)).sha256 } } : {}),
        executablePath, headless, browser: '',
        tools: { executableSha256, verifierSha256: sha256(await fs.readFile(__filename)),
            playwright: require('playwright-core/package.json').version, node: process.version },
        graphics: null, requests: [], console: [], pageErrors: [],
        screenshots: [], validation: {}, success: false,
        limitations: ['Real Chrome with explicit ANGLE SwiftShader software WebGL, not physical GPU/device validation',
            'Audio evidence observes decoded PCM, real WebAudio start/end and running context, not physical speaker output'] };
    const allowed = new Set(descriptor.files.map(file => file.path));
    const mime = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.png': 'image/png', '.wav': 'audio/wav' };
    const server = http.createServer(async (request, response) => {
        try {
            const file = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1) || 'index.html';
            if (file === 'favicon.ico') { response.writeHead(204).end(); return; }
            if (!allowed.has(file)) { response.writeHead(404).end('Not found'); return; }
            const bytes = await readRegular(root, file);
            response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            response.end(bytes);
        } catch { response.writeHead(500).end('Read failed'); }
    });
    let browser;
    let page;
    const screenshot = async name => {
        const bytes = await page.screenshot({ path: path.join(output, `${name}.png`) });
        const image = PNG.sync.read(bytes);
        let green = 0;
        let gold = 0;
        for (let i = 0; i < image.data.length; i += 4) {
            const [r, g, b] = image.data.subarray(i, i + 3);
            if (g > 150 && g > r * 2 && b > 90) green++;
            if (r > 170 && g > 100 && b < 100) gold++;
        }
        const result = { path: `${name}.png`, sha256: sha256(bytes), width: image.width, height: image.height, green, gold };
        report.screenshots.push(result);
        return result;
    };
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
        report.launchArgs = args;
        browser = await chromium.launch({ executablePath, headless, args });
        report.browser = browser.version();
        const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, hasTouch: true });
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        page = await context.newPage();
        page.on('console', message => report.console.push({ type: message.type(), text: message.text() }));
        page.on('pageerror', error => report.pageErrors.push(String(error.stack || error)));
        page.on('response', response => report.requests.push({ path: new URL(response.url()).pathname, status: response.status() }));
        await page.addInitScript(() => {
            // Observe native WebAudio calls without substituting the decoder, audio graph or playback.
            const start = AudioBufferSourceNode.prototype.start;
            globalThis.__nativeAudio = [];
            AudioBufferSourceNode.prototype.start = function (...args) {
                const result = Reflect.apply(start, this, args);
                const samples = this.buffer?.getChannelData(0);
                let peak = 0;
                if (samples) for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
                globalThis.__nativeAudio.push({ node: this, duration: this.buffer?.duration, peak });
                return result;
            };
        });
        await page.goto(origin, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.__runtimeProbe?.ready || globalThis.__runtimeError, null, { timeout: 60000 });
        assert.equal(await page.evaluate(() => globalThis.__runtimeError), undefined);
        await page.waitForTimeout(250);
        report.initial = await page.evaluate(() => globalThis.__runtimeProbe);
        report.runtimeConstants = await page.evaluate(() => Object.fromEntries(
            ['CC_DEBUG', 'CC_BUILD', 'CC_JSB', 'CC_EDITOR', 'CC_PREVIEW', 'CC_BILIBILI', 'CC_MINIGAME'].map(name => [name, globalThis[name]])));
        assert.deepEqual(report.runtimeConstants, { CC_DEBUG: descriptor.variant === 'debug', CC_BUILD: true,
            CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false, CC_BILIBILI: false, CC_MINIGAME: false });
        for (const field of ['classRegistered', 'imageLoaded', 'jsonLoaded', 'audioLoaded']) assert.equal(report.initial[field], true, field);
        assert.equal(report.initial.decoratedDefault, 7);
        assert.equal(report.initial.world3d, descriptor.profile === '3d-basic');
        report.builtins = await page.evaluate(() => globalThis.__runtimeBuiltins);
        assert.deepEqual(report.builtins, { effects: descriptor.builtins.effects.length, materials: descriptor.builtins.materials.length });
        report.graphics = await page.evaluate(() => {
            const canvas = document.getElementById('GameCanvas');
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) throw new Error('No actual WebGL context');
            const extension = gl.getExtension('WEBGL_debug_renderer_info');
            return { version: gl.getParameter(gl.VERSION), renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                width: canvas.width, height: canvas.height };
        });
        const first = await screenshot('first-frame');
        assert.ok(first.green > 12000, `Missing PNG sprite pixels: ${first.green}`);
        if (descriptor.profile === '3d-basic') assert.ok(first.gold > 1000, `Missing mesh pixels: ${first.gold}`);
        report.validation.firstFrame = true;
        await page.mouse.click(320, 240);
        await page.waitForFunction(() => globalThis.__runtimeProbe.score === 7 && globalThis.__runtimeProbe.audioEnded >= 1);
        const clicked = await screenshot('after-click');
        assert.notEqual(clicked.sha256, first.sha256);
        assert.ok(clicked.green < 1000, 'Sprite tint did not change');
        await page.touchscreen.tap(470, 240);
        await page.waitForFunction(() => globalThis.__runtimeProbe.score === 14 && globalThis.__runtimeProbe.audioEnded >= 2);
        assert.ok((await screenshot('after-touch')).green > 12000);
        report.validation.mouse = true;
        report.validation.touch = true;
        for (let index = 1; index <= 10; index++) {
            await page.keyboard.press('r');
            await page.waitForFunction(count => globalThis.__runtimeProbe.ready && globalThis.__runtimeProbe.restarts === count,
                index);
            const state = await page.evaluate(() => globalThis.__runtimeProbe);
            assert.equal(state.score, 0);
            assert.equal(state.starts, index + 1, 'Duplicate/missing component lifecycle');
            await page.mouse.click(320, 240);
            await page.waitForFunction(count => globalThis.__runtimeProbe.score === 7 && globalThis.__runtimeProbe.audioEnded === count + 2, index);
        }
        await page.waitForFunction(() => globalThis.__runtimeProbe.audioEnded === 12);
        report.validation.restarts = 10;
        report.scene = await page.evaluate(async () => {
            const cc = await System.import('cc');
            const scene = cc.director.getScene();
            const cube = scene.getChildByName('MeshCube');
            const component = cube?.getComponent('RuntimeCube');
            return { children: scene.children.length, cubeTilt: component?.tilt ?? null,
                cubeRegistered: component ? cc.js.getClassByName('RuntimeCube') === component.constructor : null };
        });
        assert.equal(report.scene.children, descriptor.profile === '3d-basic' ? 4 : 2);
        if (descriptor.profile === '3d-basic') {
            assert.equal(report.scene.cubeTilt, 25);
            assert.equal(report.scene.cubeRegistered, true);
        }
        report.audio = await page.evaluate(() => globalThis.__nativeAudio.map(({ node, duration, peak }) => ({ state: node.context.state, duration, peak })));
        assert.equal(report.audio.length, 12);
        assert.ok(report.audio.every(audio => audio.state === 'running' && audio.duration > 0 && audio.peak > 0.1));
        report.validation.webAudio = true;
        assert.deepEqual(report.pageErrors, []);
        assert.deepEqual(report.console.filter(message => message.type === 'error'), []);
        assert.ok(report.requests.every(request => request.status < 400));
        await page.evaluate(() => globalThis.__checkMissingAsset());
        report.final = await page.evaluate(() => globalThis.__runtimeProbe);
        assert.equal(report.final.missingRejected, true);
        assert.ok(report.requests.some(request => request.path.endsWith('/intentionally-missing.png') && request.status === 404));
        report.validation.missingAsset = true;
        const negativeErrorCount = report.console.filter(message => message.type === 'error').length;
        assert.ok(report.console.filter(message => message.type === 'error').every(message =>
            message.text.includes('intentionally-missing.png') || message.text.includes('status of 404')));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.keyboard.press('r');
        await page.waitForFunction(() => globalThis.__runtimeProbe.ready && globalThis.__runtimeProbe.restarts === 11);
        await page.waitForTimeout(250);
        const mobile = await screenshot('mobile');
        assert.ok(mobile.green > 2000, 'Mobile canvas missing sprite');
        report.validation.mobileLayout = true;
        await page.touchscreen.tap(195, 422);
        await page.waitForFunction(() => globalThis.__runtimeProbe.score === 7 && globalThis.__runtimeProbe.audioEnded === 13);
        report.validation.mobileTouch = true;
        report.final = await page.evaluate(() => globalThis.__runtimeProbe);
        assert.equal(report.console.filter(message => message.type === 'error').length, negativeErrorCount);
        assert.ok(report.requests.every(request => request.status < 400 || request.path.endsWith('/intentionally-missing.png')));
        assert.deepEqual(report.pageErrors, []);
        assert.equal(await page.evaluate(() => globalThis.__runtimeError), undefined);
        assert.equal(sha256(await readRegular(root, 'runtime.json')), report.runtimeSha256);
        assert.deepEqual((await inventory(root)).filter(file => file.path !== 'runtime.json'), descriptor.files);
        assert.equal(sha256(await fs.readFile(executablePath)), executableSha256, 'Browser executable changed during verification');
        report.success = true;
    } catch (error) {
        report.error = String(error.stack || error);
        if (page) {
            report.runtimeError = await page.evaluate(() => globalThis.__runtimeError).catch(() => null);
            report.final = await page.evaluate(() => globalThis.__runtimeProbe).catch(() => null);
            await screenshot('failure').catch(() => {});
        }
        throw new Error(`BROWSER_VERIFICATION_FAILED: ${output}\n${report.error}`);
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
    return { output, report: path.join(output, 'browser-report.json'), runtimeSha256: report.runtimeSha256, validation: report.validation };
}

module.exports = { verifyBrowser };
if (require.main === module) {
    if (process.argv.length !== 5) {
        console.error('Usage: node verify-browser.cjs <runtime-directory> <absolute-chrome-path> <absent-evidence-directory>');
        process.exitCode = 1;
    } else verifyBrowser({ runtimeDirectory: process.argv[2], executablePath: process.argv[3], outDirectory: process.argv[4] })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
