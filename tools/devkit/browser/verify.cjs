const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const { serveArtifact } = require('./server.cjs');
const { sha256 } = require('./files.cjs');

function pixel(image, x, y) {
    const offset = (Math.round(y / 480 * image.height) * image.width + Math.round(x / 640 * image.width)) * 4;
    return [...image.data.subarray(offset, offset + 4)];
}

function assertPixels(bytes, moved) {
    const image = PNG.sync.read(bytes);
    const x = moved ? 144 : 0;
    const expected = moved ? [48, 176, 240, 255] : [240, 80, 64, 255];
    const samples = { background: pixel(image, 100, 100), light: pixel(image, 288 + x, 240), dark: pixel(image, 352 + x, 240) };
    const near = (actual, target, message) => actual.forEach((value, index) => assert.ok(Math.abs(value - target[index]) <= 5, `${message}: ${actual} != ${target}`));
    near(samples.background, [16, 24, 40, 255], 'Camera clear');
    near(samples.light, expected, 'Image light half');
    near(samples.dark, expected.map((value, index) => index === 3 ? 255 : Math.round(value * 160 / 255)), 'Image dark half');
    if (moved) near(pixel(image, 288, 240), [16, 24, 40, 255], 'Old sprite position cleared');
    return { width: image.width, height: image.height, samples };
}

async function verify(artifact, executablePath) {
    assert.ok(path.isAbsolute(executablePath), 'Use an explicit absolute browser executable');
    await fs.mkdir(path.join(__dirname, 'build'), { recursive: true });
    const evidence = await fs.mkdtemp(path.join(__dirname, 'build/browser-'));
    const report = { kind: 'cocos4-browser-bootstrap-evidence', artifact: path.resolve(artifact), browserExecutable: executablePath,
        node: process.version, passed: false, playableComplete: false, world3d: false, audio: false, cases: [] };
    let server;
    let context;
    console.log(`Browser evidence: ${evidence}`);
    try {
        report.verifierSources = await Promise.all(['verify.cjs', 'server.cjs', 'files.cjs', 'package-lock.json'].map(async name => ({
            path: name, sha256: sha256(await fs.readFile(path.join(__dirname, name))),
        })));
        server = await serveArtifact(artifact);
        report.buildReportSha256 = server.reportSha256;
        report.effectReportSha256 = server.report.effectReportSha256;
        report.browserExecutableSha256 = sha256(await fs.readFile(executablePath));
        for (const mode of [
            { name: 'desktop-webgl2', viewport: { width: 640, height: 480 }, touch: false, webgl1: false },
            { name: 'mobile-webgl2', viewport: { width: 360, height: 640 }, touch: true, webgl1: false },
            { name: 'desktop-webgl1', viewport: { width: 640, height: 480 }, touch: false, webgl1: true },
        ]) {
            const result = { ...mode, console: [], errors: [], requests: [], passed: false };
            report.cases.push(result);
            // Explicit software WebGL, not physical-GPU or vendor-device evidence.
            const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
                ...(mode.webgl1 ? ['--disable-webgl2'] : [])];
            result.launchArgs = args;
            context = await chromium.launchPersistentContext(path.join(evidence, `${mode.name}-profile`), {
                executablePath, headless: true, args, viewport: mode.viewport, deviceScaleFactor: 1,
                hasTouch: mode.touch, isMobile: mode.touch, timeout: 30000,
            });
            result.browserVersion = context.browser().version();
            const page = await context.newPage();
            page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
            page.on('pageerror', error => result.errors.push(String(error.stack || error)));
            page.on('requestfailed', request => result.errors.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`));
            page.on('response', response => result.requests.push({ url: response.url(), status: response.status() }));
            const origin = new URL(server.url).origin;
            await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
            // Capture the actual engine context, without replacing its renderer or shaders.
            await page.addInitScript(() => {
                const original = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = function (...args) {
                    const context = Reflect.apply(original, this, args);
                    if (this.id === 'GameCanvas' && context && /^webgl|experimental-webgl/.test(args[0])) {
                        globalThis.__probeGL = context;
                        globalThis.__probeGLType = args[0];
                    }
                    return context;
                };
            });
            try {
                await page.goto(server.url, { waitUntil: 'load', timeout: 30000 });
                await page.waitForFunction(() => globalThis.__bootstrap?.error || (globalThis.__probe?.ready && globalThis.__probe.frames >= 3), null, { timeout: 30000 });
                result.bootstrap = await page.evaluate(() => globalThis.__bootstrap);
                assert.equal(result.bootstrap.error, '');
                assert.equal(result.bootstrap.builtins.filter(asset => asset.kind === 'effect').length, 5);
                assert.equal(result.bootstrap.builtins.filter(asset => asset.kind === 'material').length, 10);
                result.gl = await page.evaluate(() => {
                    const gl = globalThis.__probeGL;
                    if (!gl) throw new Error('No engine WebGL context');
                    const debug = gl.getExtension('WEBGL_debug_renderer_info');
                    return { type: globalThis.__probeGLType, version: gl.getParameter(gl.VERSION), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                        contextLost: gl.isContextLost(), userAgent: navigator.userAgent };
                });
                assert.equal(result.gl.contextLost, false);
                assert.equal(result.gl.type, mode.webgl1 ? 'webgl' : 'webgl2');
                const canvas = page.locator('#GameCanvas');
                const before = await canvas.screenshot({ path: path.join(evidence, `${mode.name}-first-frame.png`) });
                result.firstFrame = { sha256: sha256(before), pixels: assertPixels(before, false) };
                const bounds = await canvas.boundingBox();
                assert.ok(bounds);
                const activate = async x => {
                    const point = { x: bounds.x + x / 640 * bounds.width, y: bounds.y + bounds.height / 2 };
                    if (mode.touch) await page.touchscreen.tap(point.x, point.y);
                    else await page.mouse.click(point.x, point.y);
                };
                await activate(288);
                await page.waitForFunction(() => globalThis.__probe.clicks === 1 && globalThis.__probe.x === 144);
                const after = await canvas.screenshot({ path: path.join(evidence, `${mode.name}-after-input.png`) });
                result.input = { sha256: sha256(after), pixels: assertPixels(after, true), source: mode.touch ? 'touchscreen.tap' : 'mouse.click' };
                await activate(432);
                await page.waitForFunction(() => globalThis.__probe.clicks === 2 && globalThis.__probe.x === 0);
                result.returnPixels = assertPixels(await canvas.screenshot({ path: path.join(evidence, `${mode.name}-return.png`) }), false);
                result.state = await page.evaluate(() => globalThis.__probe);
                assert.equal(result.state.imageLoaded, true);
                assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
                // webgl2-device.ts:161 emits E16405 before the real WebGL1 fallback.
                result.expectedConsoleErrors = mode.webgl1 ? ['This device does not support WebGL2'] : [];
                assert.deepEqual(result.console.filter(message => message.type === 'error').map(message => message.text), result.expectedConsoleErrors);
                assert.ok(result.requests.every(request => request.status === 200), JSON.stringify(result.requests));
                assert.ok(result.requests.some(request => request.url.endsWith('/assets/probe/tile.png')));
                result.passed = true;
            } catch (error) {
                result.failure = String(error.stack || error);
                await page.screenshot({ path: path.join(evidence, `${mode.name}-failure.png`) }).catch(() => {});
                result.bootstrap = await page.evaluate(() => globalThis.__bootstrap).catch(() => null);
                throw error;
            } finally {
                await context.close();
                context = undefined;
            }
        }
        report.passed = true;
    } catch (error) {
        report.failure = String(error.stack || error);
        throw error;
    } finally {
        if (context) await context.close();
        if (server) { report.servedRequests = server.requests; await server.close(); }
        report.screenshots = (await fs.readdir(evidence)).filter(name => name.endsWith('.png'));
        report.screenshotHashes = await Promise.all(report.screenshots.map(async name => ({
            path: name, sha256: sha256(await fs.readFile(path.join(evidence, name))),
        })));
        await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ evidence, passed: report.passed, playableComplete: false }));
    }
}

module.exports = { assertPixels, verify };
if (require.main === module) {
    if (process.argv.length !== 6 || process.argv[2] !== '--artifact' || process.argv[4] !== '--browser') {
        console.error('Usage: node verify.cjs --artifact /path/to/artifact --browser /absolute/path/to/chrome');
        process.exitCode = 1;
    } else verify(process.argv[3], process.argv[5]).catch(error => { console.error(error); process.exitCode = 1; });
}
