import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { exportAndroid, validateConfig, verifyAndroidProject } from '../android/export-apk.mjs';
import { diagnoseAndroid } from '../android/toolchain.mjs';

const root = process.env.COCOS4_ANDROID_TEST_WORK_ROOT ? path.resolve(process.env.COCOS4_ANDROID_TEST_WORK_ROOT) : path.resolve(fileURLToPath(new URL('../build/android-tests/', import.meta.url)));
const baseConfig = { appId: 'org.cocos4.test', appName: "卫戍 ' & <测试>", backendUrl: 'https://api.example.test/game', configGlobal: '__SP_CLIENT_CONFIG__' };

async function fixture(t, content = {}) {
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'case-'));
    const input = path.join(directory, 'web');
    await fs.mkdir(input);
    for (const [name, bytes] of Object.entries({
        'index.html': '<!doctype html><html><head><meta charset="utf-8"><script src="client-config.js"></script><link rel="stylesheet" href="style.css"></head><body><script type="module" src="main.js"></script></body></html>',
        'client-config.js': 'globalThis.__SP_CLIENT_CONFIG__ ??= {backendUrl: ""};',
        'main.js': 'import { score } from "./logic.js"; globalThis.score = score;',
        'logic.js': 'export const score = 42;',
        'style.css': 'body { background-image: url("./images/tile.png"); }',
        'images/tile.png': Buffer.from([137, 80, 78, 71]),
        'vendor/engine.wasm': Buffer.from([0, 97, 115, 109]),
        ...content,
    })) {
        await fs.mkdir(path.dirname(path.join(input, name)), { recursive: true });
        await fs.writeFile(path.join(input, name), bytes);
    }
    t.after(async () => {
        assert.equal(path.dirname(directory), root);
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { input, output: path.join(directory, 'android'), directory };
}

test('exports a local HTML5 closure with injected backend configuration and verifies every file', async t => {
    const { input, output } = await fixture(t);
    const before = await fs.readFile(path.join(input, 'index.html'), 'utf8');
    const result = await exportAndroid({ input, output, config: baseConfig });
    assert.equal(result.success, true);
    assert.equal(result.apkBuilt, false);
    assert.equal(result.deviceTested, false);
    const receipt = JSON.parse(await fs.readFile(result.receipt, 'utf8'));
    assert.equal(receipt.engineTarget, 'HTML5');
    assert.equal(receipt.native, false);
    assert.equal(receipt.jsb, false);
    assert.equal(receipt.references.checked, 5);
    const local = path.join(output, 'app/src/main/assets/www');
    const html = await fs.readFile(path.join(local, 'index.html'), 'utf8');
    assert.ok(html.indexOf('cocos4-shell-config.js') < html.indexOf('client-config.js'));
    const globals = {};
    runInNewContext(await fs.readFile(path.join(local, 'cocos4-shell-config.js'), 'utf8'), globals);
    runInNewContext(await fs.readFile(path.join(local, 'client-config.js'), 'utf8'), globals);
    assert.equal(globals.__SP_CLIENT_CONFIG__.backendUrl, baseConfig.backendUrl);
    assert.equal(globals.__COCOS4_ANDROID__.assetOrigin, 'https://appassets.androidplatform.net');
    assert.deepEqual(await fs.readFile(path.join(local, 'vendor/engine.wasm')), Buffer.from([0, 97, 115, 109]));
    assert.equal(await fs.readFile(path.join(input, 'index.html'), 'utf8'), before);
    assert.equal((await verifyAndroidProject(output)).success, true);
    await fs.appendFile(path.join(local, 'logic.js'), '\n/* changed */');
    await assert.rejects(verifyAndroidProject(output), { code: 'PROJECT_CHANGED' });
});

test('fails before output creation for missing scripts or relative module dependencies', async t => {
    for (const content of [
        { 'index.html': '<script src="missing.js"></script>' },
        { 'main.js': 'export { missing } from "./missing.js";' },
        { 'style.css': 'body { background: url(missing.png); }' },
    ]) {
        const fixturePaths = await fixture(t, content);
        await assert.rejects(exportAndroid({ ...fixturePaths, config: baseConfig }), { code: 'ASSET_REFERENCE_MISSING' });
        await assert.rejects(fs.stat(fixturePaths.output), { code: 'ENOENT' });
    }
});

test('debug backend settings expose their shell contract before game configuration loads', async t => {
    const paths = await fixture(t);
    await exportAndroid({ ...paths, config: { ...baseConfig, dynamicBackend: true, allowCleartext: true } });
    const globals = {};
    const local = path.join(paths.output, 'app/src/main/assets/www');
    runInNewContext(await fs.readFile(path.join(local, 'cocos4-shell-config.js'), 'utf8'), globals);
    runInNewContext(await fs.readFile(path.join(local, 'client-config.js'), 'utf8'), globals);
    assert.equal(globals.__COCOS4_ANDROID__.dynamicBackend, true);
    assert.equal(globals.__COCOS4_ANDROID__.allowCleartext, true);
    assert.equal(globals.__COCOS4_ANDROID__.defaultBackendUrl, baseConfig.backendUrl);
    assert.equal(globals.__SP_CLIENT_CONFIG__.backendUrl, baseConfig.backendUrl);
    assert.equal((await verifyAndroidProject(paths.output)).config.dynamicBackend, true);
});

test('lan-host always enables the dynamic shell backend so a reload keeps the saved local endpoint', () => {
    const config = validateConfig({ ...baseConfig, backendUrl: '', hostingMode: 'lan-host', allowCleartext: true });
    assert.equal(config.dynamicBackend, true, 'lan-host must export the runtime-managed backend contract');
    assert.equal(config.hostingMode, 'lan-host');
    const explicit = validateConfig({ ...baseConfig, backendUrl: '', hostingMode: 'lan-host', allowCleartext: true, dynamicBackend: false });
    assert.equal(explicit.dynamicBackend, true, 'an explicit false must not disable the lan-host reload contract');
    assert.throws(() => validateConfig({ ...baseConfig, backendUrl: '', hostingMode: 'lan-host' }), { code: 'HOSTING_CLEARTEXT_REQUIRED' });
    assert.equal(validateConfig({ ...baseConfig, hostingMode: 'connect-only' }).dynamicBackend, false, 'connect-only keeps the caller choice');
});

test('rejects remote static resources, reserved configuration and private source trees', async t => {
    for (const [content, code] of [
        [{ 'index.html': '<script src="https://cdn.example.test/engine.js"></script>' }, 'EXTERNAL_ASSETS'],
        [{ 'main.js': 'import "https://cdn.example.test/engine.js";' }, 'EXTERNAL_ASSETS'],
        [{ 'main.js': 'export { engine } from "https://cdn.example.test/engine.js";' }, 'EXTERNAL_ASSETS'],
        [{ 'main.js': 'await import("https://cdn.example.test/engine.js");' }, 'EXTERNAL_ASSETS'],
        [{ 'cocos4-shell-config.js': 'reserved' }, 'CONFIG_COLLISION'],
        [{ '.env': 'TOKEN=secret' }, 'NOT_STATIC_OUTPUT'],
        [{ 'node_modules/pkg/index.js': 'export default 1;' }, 'NOT_STATIC_OUTPUT'],
    ]) {
        const paths = await fixture(t, content);
        await assert.rejects(exportAndroid({ ...paths, config: baseConfig }), { code });
    }
});

test('never overwrites output or writes inside input, and rejects directory junctions', async t => {
    const paths = await fixture(t);
    await fs.mkdir(paths.output);
    await fs.writeFile(path.join(paths.output, 'keep.txt'), 'keep');
    await assert.rejects(exportAndroid({ ...paths, config: baseConfig }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await fs.readFile(path.join(paths.output, 'keep.txt'), 'utf8'), 'keep');
    await assert.rejects(exportAndroid({ ...paths, output: path.join(paths.input, 'android'), config: baseConfig }), { code: 'PATH_OVERLAP' });
    const target = path.join(paths.directory, 'outside');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'private.txt'), 'private');
    await fs.symlink(target, path.join(paths.input, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportAndroid({ ...paths, output: path.join(paths.directory, 'new'), config: baseConfig }), { code: 'ASSET_LINK' });
});

test('validates package IDs, asset paths, backend URLs and SDK bounds without code injection', () => {
    for (const patch of [
        { appId: 'org.class.game' }, { appId: 'org.foo;evil' }, { appName: 'bad\nname' }, { entry: '../index.html' },
        { entry: 'sub\\index.html' }, { entry: '/index.html' }, { entry: 'a%2findex.html' },
        { backendUrl: 'javascript:alert(1)' }, { backendUrl: 'https://user:password@example.test' },
        { backendUrl: 'https://api.example.test?secret=1' }, { backendUrl: 'https://appassets.androidplatform.net' },
        { backendUrl: 'https://api.example.test?' }, { backendUrl: 'https://api.example.test#' },
        { backendUrl: 'https://api.example.test/' + '游戏'.repeat(500) },
        { backendUrl: 'http://api.example.test' }, { allowCleartext: true }, { configGlobal: '__proto__' },
        { configGlobal: 'window' }, { configGlobal: 'x];evil()' }, { minSdk: 36 }, { targetSdk: 25 }, { compileSdk: 34 },
        { configGlobal: true }, { configGlobal: null },
        { versionCode: 0 }, { unexpected: true },
        { dynamicBackend: 'true' },
    ]) assert.throws(() => validateConfig({ ...baseConfig, ...patch }));
    const config = validateConfig({ ...baseConfig, backendUrl: 'http://192.168.1.10:8080/game/', allowCleartext: true });
    assert.equal(config.backendUrl, 'http://192.168.1.10:8080/game');
    assert.equal(config.orientation, 'sensorLandscape');
    const dynamic = validateConfig({ ...baseConfig, dynamicBackend: true, allowCleartext: true });
    assert.equal(dynamic.dynamicBackend, true);
    assert.equal(dynamic.allowCleartext, true);
});

test('nested entry preserves root absolute assets and injects configuration before game code', async t => {
    const paths = await fixture(t, { 'ui/play.html': '<!doctype html><script type="module" src="/main.js"></script>' });
    const result = await exportAndroid({ ...paths, config: { ...baseConfig, entry: 'ui/play.html' } });
    assert.equal(result.success, true);
    const html = await fs.readFile(path.join(paths.output, 'app/src/main/assets/www/ui/play.html'), 'utf8');
    assert.ok(html.indexOf('/cocos4-shell-config.js') < html.indexOf('/main.js'));
});

test('quoted SVG data URLs are consumed as one CSS value, including nested filter URLs', async t => {
    const paths = await fixture(t, { 'style.css': `body { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><filter id='n'/><rect filter='url(%23n)'/></svg>"); }` });
    assert.equal((await exportAndroid({ ...paths, config: baseConfig })).success, true);
});

test('module closure ignores comments and quoted examples while checking real imports', async t => {
    const paths = await fixture(t, { 'main.js': [
        '// import { example } from "./battle/runner.js"',
        '/* export * from "https://cdn.example.test/example.js"; */',
        'const example = "import \\\"./missing.js\\\"";',
        'const pattern = /[/*]import("missing")/;',
        'const template = `import "./missing-template.js"`;',
        'import /* comment */ { score } from /* comment */ "./logic.js";',
        'await import /* comment */ ("./logic.js");',
        'const interpolation = `${await import("./logic.js")}`;',
    ].join('\n') });
    assert.equal((await exportAndroid({ ...paths, config: baseConfig })).success, true);
    for (const source of [
        'await import /* comment */ ("./missing.js");',
        'const message = `${await import("./missing.js")}`;',
        'import "./\\u006dissing.js";',
    ]) {
        const missing = await fixture(t, { 'main.js': source });
        await assert.rejects(exportAndroid({ ...missing, config: baseConfig }), { code: 'ASSET_REFERENCE_MISSING' });
    }
});

test('inline module and dynamic imports obey the same local asset closure', async t => {
    for (const [source, code] of [
        ['<script type="module">import "./missing.js";</script>', 'ASSET_REFERENCE_MISSING'],
        ['<script>import("https://cdn.example.test/engine.js");</script>', 'EXTERNAL_ASSETS'],
    ]) {
        const paths = await fixture(t, { 'index.html': source });
        await assert.rejects(exportAndroid({ ...paths, config: baseConfig }), { code });
    }
    const paths = await fixture(t, { 'index.html': '<script type="module">import "./logic.js";</script><script type="text/plain">import "./ignored.js";</script><script src="main.js">import "./ignored.js";</script>' });
    assert.equal((await exportAndroid({ ...paths, config: baseConfig })).success, true);
});

test('doctor reports missing Android tools without claiming an APK build', async t => {
    const paths = await fixture(t);
    await exportAndroid({ ...paths, config: baseConfig });
    const missing = path.join(paths.directory, 'missing');
    const report = await diagnoseAndroid({ project: paths.output, sdk: missing, javaHome: missing,
        gradleHome: missing, work: path.join(paths.directory, 'work') });
    assert.equal(report.success, false);
    for (const name of ['JDK', 'Gradle', 'Android platform', 'Android build tools', 'SDK license']) {
        assert.equal(report.checks.find(item => item.name === name)?.success, false, name);
    }
});
