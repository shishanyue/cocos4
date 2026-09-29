import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyGame({ url, evidence, drivers, chromium, pngjs }) {
    for (const [name, value] of Object.entries({ evidence, drivers, chromium, pngjs })) {
        assert(typeof value === 'string' && isAbsolute(value), `${name} must be an explicit absolute path`);
    }
    assert((await stat(pngjs)).isDirectory(), 'pngjs must be a package directory');
    const origin = new URL(url).origin;
    assert(/^https?:\/\//.test(origin), 'Expected an HTTP(S) preview URL');
    const timeout = 30_000;
    const saveKey = 'cocos4.2048.v1';
    const fixture = { version: 1, board: [2, 2, ...Array(14).fill(0)], score: 0, best: 0, moves: 0 };
    const layout = {
        width: 480, height: 760,
        board: { x: 0, y: -22, width: 432, height: 432 },
        restart: { x: 152, y: 242, width: 128, height: 48 },
    };
    const report = {
        success: false,
        scope: '2048 HTML5 release: one desktop keyboard/mouse scenario and one mobile touch scenario',
        previewOrigin: origin,
        logicalLayout: layout,
        fixture: { source: 'Explicit deterministic localStorage test fixture, seeded once per context', key: saveKey, value: fixture },
        browser: { executable: chromium, version: null },
        scenarios: [], screenshots: [], errors: [],
        reportPath: join(evidence, 'browser-smoke.json'),
        limitations: [
            'Headless Chromium with SwiftShader software WebGL; no vendor runtime or physical-device validation.',
            'Artifact identity and fresh packaged-MCP provenance must be recorded by the parent runner.',
            'Win/game-over transitions and a full test suite are outside this focused smoke check.',
        ],
    };
    const recordError = (scenario, source, message) => report.errors.push({ scenario, source, message: String(message) });
    const bounded = async promise => {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Browser operation exceeded ${timeout} ms`)), timeout);
            })]);
        } finally {
            clearTimeout(timer);
        }
    };
    let browser;
    let page;
    let current = 'setup';
    let failure;
    await mkdir(evidence, { recursive: true });
    try {
        // Load explicitly selected external test dependencies, never use ancestor lookup.
        const require = createRequire(pathToFileURL(join(drivers, 'package.json')));
        const { chromium: browserDriver } = require(join(drivers, 'node_modules/playwright-core'));
        const { PNG } = require(pngjs);
        report.drivers = {
            directory: drivers,
            playwright: require(join(drivers, 'node_modules/playwright-core/package.json')).version,
            pngjsDirectory: pngjs,
            pngjs: require(join(pngjs, 'package.json')).version,
        };
        browser = await browserDriver.launch({
            executablePath: chromium, headless: true, timeout,
            args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        });
        report.browser.version = browser.version();

        for (const configuration of [
            { name: 'desktop', viewport: { width: 960, height: 800 }, hasTouch: false },
            { name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true },
        ]) {
            const { name, viewport, hasTouch } = configuration;
            current = name;
            const scenario = { ...configuration, success: false, assertions: [], states: {} };
            report.scenarios.push(scenario);
            const context = await bounded(browser.newContext({
                viewport, hasTouch, isMobile: hasTouch, deviceScaleFactor: 1, serviceWorkers: 'block',
                storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: saveKey, value: JSON.stringify(fixture) }] }] },
            }));
            context.setDefaultTimeout(timeout);
            context.setDefaultNavigationTimeout(timeout);
            await bounded(context.route('**/*', async route => {
                try {
                    const target = new URL(route.request().url());
                    if (target.origin === origin || ['data:', 'blob:'].includes(target.protocol)) {
                        await route.continue();
                    } else {
                        recordError(name, 'network-policy', `Blocked external request: ${target.href}`);
                        await route.abort('blockedbyclient');
                    }
                } catch (error) {
                    recordError(name, 'network-routing', error.message);
                }
            }));
            await bounded(context.routeWebSocket('**/*', async socket => {
                recordError(name, 'network-policy', `WebSocket is not the HTTP preview origin: ${socket.url()}`);
                try {
                    await bounded(socket.close({ code: 1008, reason: 'Only preview HTTP and data/blob requests are allowed' }));
                } catch (error) {
                    recordError(name, 'network-routing', error.message);
                }
            }));
            page = await bounded(context.newPage());
            page.on('pageerror', error => recordError(name, 'page', error.stack || error.message));
            page.on('crash', () => recordError(name, 'page', 'Browser page crashed'));
            page.on('console', message => {
                if (['error', 'assert'].includes(message.type())) recordError(name, 'console', message.text());
            });
            page.on('requestfailed', request => recordError(name, 'request', `${request.url()}: ${request.failure()?.errorText}`));
            page.on('response', response => {
                if (response.status() >= 400) recordError(name, 'http', `${response.status()} ${response.url()}`);
            });

            const observe = async (counters = {}) => {
                await page.waitForFunction(expected => {
                    const probe = globalThis.__runtimeProbe;
                    return !!globalThis.__runtimeError || (probe?.ready
                        && Object.entries(expected).every(([key, value]) => probe[key] >= value));
                }, counters, { timeout });
                // Let rendering and any duplicate/synthesized input settle before exact assertions.
                await page.waitForTimeout(400);
                const state = await bounded(page.evaluate(() => ({ probe: globalThis.__runtimeProbe, error: globalThis.__runtimeError })));
                if (state.error) recordError(name, 'game', state.error);
                assert.equal(report.errors.length, 0, 'Browser/game/network errors were recorded');
                assert.equal(state.probe?.ready, true, 'Game must be ready');
                assert(Array.isArray(state.probe.board) && state.probe.board.length === 16, 'Expected a 16-cell 2048 board');
                for (const key of ['score', 'best', 'moves', 'inputCount', 'restarts']) {
                    assert(Number.isSafeInteger(state.probe[key]) && state.probe[key] >= 0, `Invalid probe.${key}`);
                }
                assert.deepEqual(state.probe.layout, layout, 'Unexpected authored 2048 layout');
                const { board, score, best, moves, inputCount, restarts, won, over } = state.probe;
                return { board, score, best, moves, inputCount, restarts, won, over };
            };

            assert.equal((await page.goto(url, { waitUntil: 'load', timeout }))?.status(), 200);
            let state = await observe();
            assert.deepEqual(state.board, fixture.board, 'The deterministic save fixture must be restored');
            for (const key of ['score', 'best', 'moves', 'inputCount']) assert.equal(state[key], 0, `Initial ${key}`);
            scenario.states.seeded = state;
            scenario.runtime = await bounded(page.evaluate(() => Object.fromEntries(
                ['CC_DEBUG', 'CC_BUILD', 'CC_EDITOR', 'CC_PREVIEW', 'CC_JSB', 'CC_MINIGAME', 'CC_BILIBILI']
                    .map(key => [key, globalThis[key]]))));
            assert.deepEqual(scenario.runtime, {
                CC_DEBUG: false, CC_BUILD: true, CC_EDITOR: false, CC_PREVIEW: false,
                CC_JSB: false, CC_MINIGAME: false, CC_BILIBILI: false,
            }, 'Expected a release browser runtime, not a debug/starter preview');
            scenario.graphics = await bounded(page.evaluate(() => {
                const canvas = document.getElementById('GameCanvas');
                const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
                if (!gl) throw new Error('No WebGL context on GameCanvas');
                const extension = gl.getExtension('WEBGL_debug_renderer_info');
                return { version: gl.getParameter(gl.VERSION),
                    renderer: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER) };
            }));
            scenario.assertions.push('release-runtime', 'deterministic-save-loaded');

            const canvas = page.locator('#GameCanvas');
            const bounds = await canvas.boundingBox();
            assert(bounds && bounds.width > 0 && bounds.height > 0, 'Canvas must have visible bounds');
            assert(Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1
                && Math.abs(bounds.width - viewport.width) < 1 && Math.abs(bounds.height - viewport.height) < 1,
                'Canvas must fill the viewport');
            const scale = Math.min(bounds.width / layout.width, bounds.height / layout.height);
            const project = area => ({
                x: bounds.x + bounds.width / 2 + (area.x - area.width / 2) * scale,
                y: bounds.y + bounds.height / 2 - (area.y + area.height / 2) * scale,
                width: area.width * scale, height: area.height * scale,
            });
            const board = project(layout.board);
            const restart = project(layout.restart);
            for (const area of [board, restart]) {
                assert(area.x >= bounds.x && area.y >= bounds.y
                    && area.x + area.width <= bounds.x + bounds.width
                    && area.y + area.height <= bounds.y + bounds.height, 'Board/restart must not be clipped by the canvas');
                assert(area.x >= 0 && area.y >= 0 && area.x + area.width <= viewport.width
                    && area.y + area.height <= viewport.height, 'Board/restart must not be clipped by the viewport');
            }
            scenario.layout = { canvas: bounds, scale, board, restart };

            const capture = async label => {
                const path = join(evidence, `${name}-${label}.png`);
                const bytes = await page.screenshot({ type: 'png', scale: 'css', timeout });
                await writeFile(path, bytes, { flag: 'wx' });
                const shot = { path, sha256: createHash('sha256').update(bytes).digest('hex') };
                report.screenshots.push(shot);
                const image = PNG.sync.read(bytes);
                assert.equal(image.width, viewport.width);
                assert.equal(image.height, viewport.height);
                const left = Math.ceil(board.x), right = Math.floor(board.x + board.width);
                const top = Math.ceil(board.y), bottom = Math.floor(board.y + board.height);
                assert(left >= 0 && top >= 0 && right <= image.width && bottom <= image.height,
                    'The complete projected board must be inside the screenshot');
                const palette = new Set();
                const quadrants = Array.from({ length: 4 }, () => new Set());
                let colored = 0;
                for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
                    const offset = (y * image.width + x) * 4;
                    const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2];
                    const color = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
                    palette.add(color);
                    quadrants[(y < (top + bottom) / 2 ? 0 : 2) + (x < (left + right) / 2 ? 0 : 1)].add(color);
                    if (image.data[offset + 3] > 0 && Math.max(r, g, b) > 40 && Math.max(r, g, b) - Math.min(r, g, b) > 12) colored++;
                }
                Object.assign(shot, { width: image.width, height: image.height, boardPixels: (right - left) * (bottom - top),
                    coloredBoardPixels: colored, boardColors: palette.size, quadrantColors: quadrants.map(colors => colors.size) });
                assert(colored > shot.boardPixels * 0.02 && palette.size >= 4, 'Missing nonblank colored board pixels');
                assert(quadrants.every(colors => colors.size >= 2), 'Missing board drawing in one or more quadrants');
                return shot;
            };

            const seeded = await capture('seeded');
            if (hasTouch) {
                const session = await bounded(context.newCDPSession(page));
                const from = { x: board.x + board.width * 0.8, y: board.y + board.height / 2 };
                const to = { x: board.x + board.width * 0.2, y: from.y };
                scenario.swipe = { from, to };
                await bounded(session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] }));
                for (let step = 1; step <= 5; step++) {
                    await bounded(session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
                        { x: from.x + (to.x - from.x) * step / 5, y: from.y, id: 1 },
                    ] }));
                    await page.waitForTimeout(30);
                }
                await bounded(session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
                await bounded(session.detach());
            } else {
                await canvas.focus();
                await bounded(page.keyboard.press('ArrowLeft'));
            }
            state = await observe({ moves: 1 });
            assert.equal(state.board[0], 4, 'Real left input must merge the first two tiles');
            assert.equal(state.score, 4);
            assert.equal(state.best, 4);
            assert.equal(state.moves, 1, 'One gesture/key must produce one move');
            assert.equal(state.inputCount, 1, 'One gesture/key must reach exactly one input handler');
            assert.equal(state.board.filter(Boolean).length, 2, 'A successful merge must spawn exactly one tile');
            assert.equal(state.won, false);
            assert.equal(state.over, false);
            scenario.states.merged = state;
            const merged = await capture('merged');
            assert.notEqual(merged.sha256, seeded.sha256, 'Rendered pixels must change after the merge');
            scenario.assertions.push(hasTouch ? 'real-touch-swipe-merge-once' : 'real-keyboard-merge-once');

            const restartPoint = { x: restart.x + restart.width / 2, y: restart.y + restart.height / 2 };
            scenario.restartClicks = [];
            for (let count = 0; count < (hasTouch ? 1 : 2); count++) {
                const before = state;
                if (hasTouch) await bounded(page.touchscreen.tap(restartPoint.x, restartPoint.y));
                else await bounded(page.mouse.click(restartPoint.x, restartPoint.y));
                state = await observe({ restarts: before.restarts + 1 });
                assert.equal(state.restarts, before.restarts + 1, 'Restart input must not be handled twice');
                assert.equal(state.score, 0);
                assert.equal(state.moves, 0);
                assert.equal(state.best, before.best, 'Restart must preserve the best score');
                const tiles = state.board.filter(Boolean);
                assert.equal(tiles.length, 2, 'Restart must create exactly two tiles');
                assert(tiles.every(tile => tile === 2 || tile === 4), 'Invalid new-game tiles');
                assert.equal(state.won, false);
                assert.equal(state.over, false);
                scenario.restartClicks.push({ ...restartPoint, restarts: state.restarts, score: state.score, best: state.best, tiles });
            }
            await capture('restarted');
            scenario.assertions.push(hasTouch ? 'real-touch-restart' : 'two-real-mouse-restarts', 'restart-preserves-best');

            if (!hasTouch) {
                const before = state;
                // With only two tiles, moving toward the opposite half guarantees a changed board.
                const key = state.board.some((tile, index) => tile && index % 4 < 2) ? 'ArrowRight' : 'ArrowLeft';
                await canvas.focus();
                await bounded(page.keyboard.press(key));
                state = await observe({ inputCount: before.inputCount + 1 });
                assert.equal(state.inputCount, before.inputCount + 1, 'Restart must not accumulate input handlers');
                assert.equal(state.moves, before.moves + 1);
                assert(state.best >= before.best);
                scenario.singleHandlerCheck = { key, before: before.inputCount, after: state.inputCount };
                scenario.states.beforeReload = state;
                assert.equal((await page.reload({ waitUntil: 'load', timeout }))?.status(), 200);
                const restored = await observe();
                for (const key of ['score', 'best', 'moves']) assert.equal(restored[key], state[key], `Persisted ${key}`);
                assert.deepEqual(restored.board, state.board, 'Reload must restore the saved game, not reseed the fixture');
                scenario.states.reloaded = restored;
                scenario.assertions.push('single-handler-after-restarts', 'best-and-save-persist-across-reload');
            }
            await page.waitForLoadState('networkidle', { timeout });
            await observe();
            scenario.assertions.push('unclipped-board-and-restart', 'colored-pixels-in-all-board-quadrants', 'no-game-page-console-or-request-errors');
            await bounded(context.close());
            page = undefined;
            assert.equal(report.errors.length, 0, 'Browser errors were recorded during scenario cleanup');
            scenario.success = true;
        }
    } catch (error) {
        failure = error;
        recordError(current, 'verification', error.message || error);
        if (page && !page.isClosed()) {
            try {
                const path = join(evidence, `${current}-failure.png`);
                await writeFile(path, await page.screenshot({ type: 'png', timeout: 5_000 }), { flag: 'wx' });
                report.screenshots.push({ path, failure: true });
            } catch (error) {
                recordError(current, 'failure-screenshot', error.message || error);
            }
        }
    } finally {
        try {
            if (browser) await bounded(browser.close());
        } catch (error) {
            failure ??= error;
            recordError(current, 'browser-cleanup', error.message || error);
        }
        report.success = !failure && report.errors.length === 0;
        await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    }
    if (!report.success) {
        throw Object.assign(new Error(`2048 browser smoke failed; evidence: ${report.reportPath}`, { cause: failure }), { evidence: report });
    }
    return report;
}
