import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Acceptance for newly emitted MCP artifacts, not the SDK's prebuilt fixture.
export async function verifyBrowserGame({ preview, artifact, artifactDirectory, executablePath, pointsPerClick = 11 }) {
    const require = createRequire(new URL('../runtime/package.json', import.meta.url));
    const { chromium } = require('playwright-core');
    const { PNG } = require('pngjs');
    const evidenceDirectory = await fs.mkdtemp(join(fileURLToPath(new URL('../build/', import.meta.url)), 'development-browser-'));
    const report = { sdkId: artifact.sdkId, target: artifact.target, profile: artifact.profile, variant: artifact.variant,
        artifactId: artifact.artifactId, artifactSha256: artifact.sha256, success: false, screenshots: [],
        responses: [], console: [], pageErrors: [], hardwareOrVendorDeviceEvidence: false };
    let browser;
    try {
        browser = await chromium.launch({ executablePath, headless: true,
            args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
        report.browser = browser.version();
        const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, hasTouch: true });
        const origin = new URL(preview.url).origin;
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        page.on('pageerror', error => report.pageErrors.push(String(error)));
        page.on('console', message => report.console.push({ type: message.type(), text: message.text() }));
        page.on('response', response => report.responses.push({ path: new URL(response.url()).pathname, status: response.status() }));
        await page.addInitScript(() => {
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
        assert.equal((await page.goto(preview.url)).status(), 200);
        await page.waitForFunction(() => globalThis.__runtimeProbe?.ready || globalThis.__runtimeError, null, { timeout: 60000 });
        assert.equal(await page.evaluate(() => globalThis.__runtimeError), undefined);
        report.initial = await page.evaluate(() => globalThis.__runtimeProbe);
        for (const field of ['classRegistered', 'imageLoaded', 'jsonLoaded', 'audioLoaded']) assert.equal(report.initial[field], true, field);
        assert.equal(report.initial.decoratedDefault, pointsPerClick, 'The browser must run edited source, not the prebuilt starter');
        assert.equal(report.initial.world3d, artifact.profile === '3d-basic');
        report.constants = await page.evaluate(() => ({ DEBUG: CC_DEBUG, BUILD: CC_BUILD, JSB: CC_JSB, EDITOR: CC_EDITOR, PREVIEW: CC_PREVIEW }));
        assert.deepEqual(report.constants, { DEBUG: artifact.variant === 'debug', BUILD: true, JSB: false, EDITOR: false, PREVIEW: false });
        report.graphics = await page.evaluate(() => {
            const canvas = document.getElementById('GameCanvas');
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            const extension = gl.getExtension('WEBGL_debug_renderer_info');
            return { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER) };
        });
        const screenshot = async name => {
            const bytes = await page.screenshot();
            const image = PNG.sync.read(bytes);
            let green = 0;
            let gold = 0;
            for (let offset = 0; offset < image.data.length; offset += 4) {
                const [r, g, b] = image.data.subarray(offset, offset + 3);
                if (g > 150 && g > r * 2 && b > 90) green++;
                if (r > 170 && g > 100 && b < 100) gold++;
            }
            const result = { path: `${name}.png`, sha256: hash(bytes), width: image.width, height: image.height, green, gold };
            await fs.writeFile(join(evidenceDirectory, result.path), bytes, { flag: 'wx' });
            report.screenshots.push(result);
            return result;
        };
        await page.waitForTimeout(250);
        const initial = await screenshot('first-frame');
        assert(initial.green > 12000, `Missing rendered sprite: ${initial.green} green pixels`);
        if (artifact.profile === '3d-basic') assert(initial.gold > 1000, `Missing rendered mesh: ${initial.gold} gold pixels`);
        await page.mouse.click(320, 240);
        await page.waitForFunction(points => globalThis.__runtimeProbe.score === points && globalThis.__runtimeProbe.audioEnded === 1, pointsPerClick);
        assert((await screenshot('after-click')).green < 1000, 'Sprite tint did not change after input');
        await page.touchscreen.tap(470, 240);
        await page.waitForFunction(points => globalThis.__runtimeProbe.score === points * 2 && globalThis.__runtimeProbe.audioEnded === 2, pointsPerClick);
        for (let count = 1; count <= 10; count++) {
            await page.keyboard.press('r');
            await page.waitForFunction(count => globalThis.__runtimeProbe.ready && globalThis.__runtimeProbe.restarts === count, count);
            const state = await page.evaluate(() => globalThis.__runtimeProbe);
            assert.equal(state.score, 0);
            assert.equal(state.starts, count + 1, 'Duplicate or missing component lifecycle');
            await page.mouse.click(320, 240);
            await page.waitForFunction(({ count, points }) => globalThis.__runtimeProbe.score === points
                && globalThis.__runtimeProbe.audioEnded === count + 2, { count, points: pointsPerClick });
        }
        report.audio = await page.evaluate(() => globalThis.__nativeAudio.map(({ node, duration, peak }) => ({ state: node.context.state, duration, peak })));
        assert.equal(report.audio.length, 12);
        assert(report.audio.every(audio => audio.state === 'running' && audio.duration > 0 && audio.peak > 0.1));
        report.validation = { mouse: true, touch: true, restarts: 10, webAudio: true };
        assert.deepEqual(report.pageErrors, []);
        assert(report.responses.every(response => response.status < 400 || response.path === '/favicon.ico'));
        assert(report.console.filter(message => message.type === 'error').every(message => message.text.includes('404')));
        await page.evaluate(() => globalThis.__checkMissingAsset());
        assert.equal(await page.evaluate(() => globalThis.__runtimeProbe.missingRejected), true);
        assert(report.responses.some(response => response.status === 404 && response.path.endsWith('/intentionally-missing.png')));
        report.validation.missingAsset = true;
        await page.setViewportSize({ width: 390, height: 844 });
        await page.keyboard.press('r');
        await page.waitForFunction(() => globalThis.__runtimeProbe.ready && globalThis.__runtimeProbe.restarts === 11);
        await page.waitForTimeout(250);
        assert((await screenshot('mobile')).green > 2000, 'Mobile layout has no rendered sprite');
        await page.touchscreen.tap(195, 422);
        await page.waitForFunction(points => globalThis.__runtimeProbe.score === points && globalThis.__runtimeProbe.audioEnded === 13, pointsPerClick);
        report.validation.mobileTouch = true;
        report.final = await page.evaluate(() => globalThis.__runtimeProbe);
        assert.deepEqual(report.pageErrors, []);
        assert.equal(await page.evaluate(() => globalThis.__runtimeError), undefined);
        assert(report.responses.every(response => response.status < 400 || response.path === '/favicon.ico'
            || response.path.endsWith('/intentionally-missing.png')));
        assert(report.console.filter(message => message.type === 'error').every(message => /404|intentionally-missing\.png/.test(message.text)));
        const inventory = await fs.readFile(join(artifactDirectory, 'artifact-inventory.json'));
        assert.equal(hash(inventory), artifact.sha256);
        await fs.writeFile(join(evidenceDirectory, 'artifact-inventory.json'), inventory, { flag: 'wx' });
        report.success = true;
    } catch (error) {
        report.error = String(error.stack ?? error);
        throw error;
    } finally {
        if (browser) await browser.close();
        await fs.writeFile(join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    }
    return { evidenceDirectory, report };
}
