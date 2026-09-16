const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { test } = require('node:test');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');

function hostFixture() {
    const listeners = {};
    const host = { info: { platform: 'android', screenWidth: 360, screenHeight: 640, pixelRatio: 2, safeArea: { top: 20, left: 0, right: 360, bottom: 640, width: 360, height: 620 } } };
    host.getSystemInfoSync = function () { assert.equal(this, host); return { ...host.info }; };
    for (const name of ['Show', 'Hide', 'WindowResize', 'TouchStart', 'TouchMove', 'TouchEnd', 'TouchCancel', 'AudioInterruptionBegin', 'AudioInterruptionEnd', 'AccelerometerChange']) {
        listeners[name] = new Set();
        host[`on${name}`] = function (cb) { assert.equal(this, host); listeners[name].add(cb); };
        host[`off${name}`] = function (cb) { assert.equal(this, host); listeners[name].delete(cb); };
    }
    host.createInnerAudioContext = function () { assert.equal(this, host); return {}; };
    host.getFileSystemManager = function () { assert.equal(this, host); return {}; };
    host.loadFont = function (file) { assert.equal(this, host); return file; };
    host.startAccelerometer = () => {};
    host.stopAccelerometer = () => {};
    return { host, listeners };
}

function palFixture(host, overrides = {}) {
    const constants = { BILIBILI: true, TEST: true, ...overrides.constants };
    const context = vm.createContext({ bl: host, console, setTimeout, clearTimeout, setInterval, clearInterval, ...overrides.globals });
    const modules = new Map();
    function load(relative) {
        let file = path.join(root, 'pal', relative);
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            file = ['.ts', '.js', '/index.js'].map(ext => file + ext).find(file => fs.existsSync(file));
        }
        assert.ok(file, `Missing PAL module ${relative}`);
        if (modules.has(file)) return modules.get(file);
        const exports = {};
        modules.set(file, exports);
        const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
        const requireModule = name => {
            if (name === 'internal:constants') return constants;
            if (name === 'pal/minigame') return load('bilibili/minigame.ts');
            if (name.startsWith('@cocos/engine/cocos/core/event')) return { EventTarget: EventEmitter };
            if (name === '@cocos/engine/cocos/core/platform/debug') return { warn() {}, log() {} };
            assert.ok(name.startsWith('.'), `Unexpected import ${name}`);
            return load(path.relative(path.join(root, 'pal'), path.resolve(path.dirname(file), name)));
        };
        vm.runInContext(`(function(require, exports) { ${source}\n})`, context)(requireModule, exports);
        return exports;
    }
    return { load, context };
}

test('BILIBILI is an independent mini-game target with specific PAL routes', async () => {
    const { StatsQuery } = require('@cocos/ccbuild');
    const stats = await StatsQuery.create(root);
    const constants = stats.constantManager.genBuildTimeConstants({ platform: 'BILIBILI', mode: 'BUILD' });
    for (const key of ['BILIBILI', 'MINIGAME', 'BUILD']) assert.equal(constants[key], true, key);
    for (const key of ['WECHAT', 'BYTEDANCE', 'NATIVE', 'JSB', 'RUNTIME_BASED', 'SUPPORT_JIT']) assert.equal(constants[key], false, key);
    const routes = stats.evaluateModuleOverrides({ platform: 'BILIBILI', mode: 'BUILD', buildTimeConstants: constants });
    for (const [name, file] of [['minigame', 'minigame'], ['system-info', 'system-info'], ['wasm', 'wasm'], ['env', 'env']]) {
        assert.equal(routes[`pal/${name}`], path.join(root, `pal/bilibili/${file}.ts`));
    }
});

test('Bilibili PAL binds the actual host, refreshes screen state and removes exact sensor callbacks', () => {
    const { host, listeners } = hostFixture();
    const fixture = palFixture(host);
    const { minigame } = fixture.load('bilibili/minigame.ts');
    assert.equal(minigame.isLandscape, false);
    assert.equal(minigame.getSystemInfoSync().windowWidth, 360);
    assert.equal(minigame.getSafeArea().top, 20);
    minigame.createInnerAudioContext();
    let sample;
    const cb = data => { sample = data; };
    minigame.onAccelerometerChange(cb);
    minigame.onAccelerometerChange(cb);
    assert.equal(listeners.AccelerometerChange.size, 1);
    host.info = { ...host.info, screenWidth: 640, screenHeight: 360, safeArea: undefined };
    for (const listener of listeners.AccelerometerChange) listener({ x: 1, y: 2, z: 3 });
    assert.deepEqual({ ...sample }, { x: -2, y: 1, z: 3 });
    assert.equal(minigame.getSafeArea().right, 640);
    minigame.offAccelerometerChange(cb);
    assert.equal(listeners.AccelerometerChange.size, 0);
    assert.equal('wx' in fixture.context, false);
});

test('Bilibili system identity and capabilities do not inherit WeChat assumptions', async () => {
    const { host } = hostFixture();
    delete host.startAccelerometer;
    const fixture = palFixture(host, { globals: { WebAssembly: undefined } });
    const { systemInfo } = fixture.load('bilibili/system-info.ts');
    const { Feature, Platform } = fixture.load('system-info/enum-type');
    assert.equal(systemInfo.platform, Platform.BILIBILI_MINI_GAME);
    assert.equal(systemInfo.platform, 'BILIBILI_MINI_GAME');
    assert.equal(systemInfo.isNative, false);
    assert.equal(systemInfo.hasFeature(Feature.WASM), false);
    assert.equal(systemInfo.hasFeature(Feature.SAFE_AREA), true);
    assert.equal(systemInfo.hasFeature(Feature.EVENT_ACCELEROMETER), false);
    await systemInfo.init();
});

test('Bilibili WASM loads bytes, rejects read failures and retries failed subpackages', async () => {
    const { host } = hostFixture();
    let readError;
    const bytes = new ArrayBuffer(8);
    let subpackageFailure = true;
    host.loadSubpackage = ({ name, success, fail }) => { if (subpackageFailure) fail(new Error(name)); else success(); };
    const fixture = palFixture(host, {
        constants: { WASM_SUBPACKAGE: true },
        globals: {
            fsUtils: { readArrayBuffer(file, cb) { assert.equal(file, 'cocos-js/external/test.wasm'); cb(readError, bytes); } },
            WebAssembly: { instantiate(buffer) { assert.equal(buffer, bytes); return Promise.resolve({ instance: {} }); } },
        },
    });
    const wasm = fixture.load('bilibili/wasm.ts');
    await wasm.instantiateWasm('external/test.wasm', {});
    readError = new Error('original read error');
    await assert.rejects(wasm.fetchBuffer('external/test.wasm'), /original read error/);
    await assert.rejects(wasm.fetchUrl('../escape.wasm'), /Invalid packaged binary/);
    await assert.rejects(wasm.ensureWasmModuleReady(), /__ccWasm/);
    subpackageFailure = false;
    await wasm.ensureWasmModuleReady();
});

function adapterFixture(minified = false) {
    const { host, listeners } = hostFixture();
    const disk = new Map();
    const storage = new Map();
    const packages = new Map();
    const loaded = [];
    const fsApi = {
        readFileSync(file) { if (!disk.has(file)) throw new Error(`ENOENT: ${file}`); return disk.get(file); },
        writeFileSync(file, data) { disk.set(file, data); },
        readFile({ filePath, success, fail }) { if (disk.has(filePath)) success({ data: disk.get(filePath) }); else fail({ errMsg: `ENOENT: ${filePath}` }); },
        mkdirSync() {},
        copyFile({ srcPath, destPath, success, fail }) { if (!disk.has(srcPath)) fail({ errMsg: 'missing source' }); else { disk.set(destPath, disk.get(srcPath)); success(); } },
        unlink({ filePath }) { disk.delete(filePath); },
        access({ path, success, fail }) { if (disk.has(path)) success(); else fail({ errMsg: 'missing file' }); },
    };
    host.env = { USER_DATA_PATH: 'blfile://user' };
    host.getFileSystemManager = () => fsApi;
    host.createCanvas = () => ({ width: 0, height: 0, getContext: type => ({ type }) });
    host.createImage = () => ({ width: 4, height: 4 });
    host.getStorageInfoSync = () => ({ keys: [...storage.keys()] });
    host.getStorageSync = key => storage.get(key);
    host.setStorageSync = (key, value) => storage.set(key, value);
    host.removeStorageSync = key => storage.delete(key);
    host.clearStorageSync = () => storage.clear();
    host.request = options => { host.requestOptions = options; return { abort() { host.aborted = true; } }; };
    let downloads = 0;
    host.downloadFile = options => {
        ++downloads;
        const temp = `bltmp://download-${downloads}`;
        disk.set(temp, `download ${options.url}`);
        options.success({ statusCode: 200, tempFilePath: temp });
        return { onProgressUpdate(cb) { cb({ progress: 100 }); } };
    };
    const context = vm.createContext({
        bl: host, GameGlobal: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: cb => setTimeout(cb, 1), cancelAnimationFrame: clearTimeout,
        __bilibiliRequire(file) {
            loaded.push(file);
            if (!packages.has(file)) throw new Error(`Missing package module: ${file}`);
            return packages.get(file);
        },
    });
    const modules = new Map();
    function load(name) {
        name = name.replace(/^\.\//, '');
        if (modules.has(name)) return modules.get(name).exports;
        const module = { exports: {} };
        modules.set(name, module);
        const file = path.join(root, 'bin/adapter/minigame/bilibili', `${name}${minified ? '.min' : ''}.js`);
        vm.runInContext(`(function(require, module, exports) { ${fs.readFileSync(file, 'utf8')}\n})`, context)(load, module, module.exports);
        return module.exports;
    }
    return { host, listeners, context, disk, fsApi, packages, loaded, load, get downloads() { return downloads; } };
}

for (const minified of [false, true]) {
    test(`Bilibili ${minified ? 'minified' : 'debug'} host facade uses real image/canvas objects and string storage`, () => {
        const fixture = adapterFixture(minified);
        fixture.load('web-adapter');
        const { context, host, listeners } = fixture;
        assert.equal('wx' in context, false);
        assert.equal(context.canvas.width, 720);
        assert.equal(context.canvas.height, 1280);
        assert.equal(context.window, context.GameGlobal);
        const image = new context.Image();
        assert.equal(image instanceof context.HTMLImageElement, true);
        assert.equal(image instanceof context.HTMLCanvasElement, false);
        assert.equal(context.canvas instanceof context.HTMLCanvasElement, true);
        let count = 0;
        image.addEventListener('load', () => { ++count; }, { once: true });
        image.onload(); image.onload();
        assert.equal(count, 1);
        context.localStorage.setItem('empty', '');
        context.localStorage.setItem('number', 0);
        assert.equal(context.localStorage.getItem('empty'), '');
        assert.equal(context.localStorage.getItem('number'), '0');
        assert.equal(context.localStorage.getItem('missing'), null);
        host.info = { ...host.info, screenWidth: 640, screenHeight: 360 };
        for (const cb of listeners.WindowResize) cb();
        assert.equal(context.innerWidth, 640);
        assert.equal(context.window.innerWidth, 640);
    });
}

test('Bilibili XHR handles response headers, JSON, abort and local binary errors', () => {
    const fixture = adapterFixture();
    fixture.load('web-adapter');
    const { context, host } = fixture;
    const xhr = new context.XMLHttpRequest();
    const events = [];
    for (const type of ['load', 'error', 'abort', 'loadend']) xhr.addEventListener(type, () => events.push(type));
    xhr.open('GET', 'https://example.test/config');
    xhr.responseType = 'json';
    xhr.setRequestHeader('X-Test', 'value');
    xhr.send();
    assert.equal(host.requestOptions.header['X-Test'], 'value');
    host.requestOptions.success({ data: '{"ok":true}', statusCode: 200, header: { 'Content-Type': 'application/json' } });
    assert.equal(xhr.response.ok, true);
    assert.equal(xhr.getResponseHeader('content-type'), 'application/json');
    assert.deepEqual(events, ['load', 'loadend']);
    events.length = 0;
    xhr.open('GET', 'https://example.test/slow');
    xhr.send();
    const late = host.requestOptions.success;
    xhr.abort();
    late({ data: '{}', statusCode: 200 });
    assert.deepEqual(events, ['abort', 'loadend']);
    assert.equal(xhr.readyState, 0);
    events.length = 0;
    xhr.open('GET', 'missing.bin');
    xhr.responseType = 'arraybuffer';
    xhr.send();
    assert.deepEqual(events, ['error', 'loadend']);
});

test('Bilibili file helpers distinguish compiled JSON, temporary files and persistent cache', () => {
    const fixture = adapterFixture();
    const files = fixture.load('fs-utils');
    fixture.packages.set('./assets/main/config.json', { scenes: [] });
    assert.ok(files.readJsonSync('assets/main/config.json').scenes);
    files.readJsonSync('assets/main/config.json').scenes.push('changed');
    assert.equal(files.readJsonSync('assets/main/config.json').scenes.length, 0);
    fixture.disk.set('bltmp://config', '{"downloaded":true}');
    assert.equal(files.readJsonSync('bltmp://config').downloaded, true);
    assert.match(files.readJsonSync('../escape.json').message, /Invalid package path/);
    assert.throws(() => files.packagePath('https://example.test/script.js'), /Invalid package path/);
    assert.throws(() => files.packagePath('assets\\..\\script.js'), /Invalid package path/);
    const url = 'https://example.test/asset.bin';
    let cachedPath;
    files.resolveFile(url, { cacheEnabled: true }, (error, file) => { assert.ifError(error); cachedPath = file; });
    assert.match(cachedPath, /^blfile:\/\/user\/cocos4-cache\//);
    files.resolveFile(url, {}, (error, file) => { assert.ifError(error); assert.equal(file, cachedPath); });
    assert.equal(fixture.downloads, 1);
    fixture.disk.delete(cachedPath);
    files.resolveFile(url, {}, error => assert.ifError(error));
    assert.equal(fixture.downloads, 2);
    fixture.fsApi.copyFile = ({ fail }) => fail({ errMsg: 'quota exceeded' });
    files.resolveFile(url, { cacheEnabled: true }, (error, file) => { assert.ifError(error); assert.match(file, /^bltmp:/); });
    fixture.fsApi.copyFile = () => { throw new Error('cache unavailable'); };
    files.resolveFile(url, { cacheEnabled: true }, (error, file) => { assert.ifError(error); assert.match(file, /^bltmp:/); });
});

function engineFixture() {
    const fixture = adapterFixture();
    const handlers = {};
    const cc = {
        assetManager: { downloader: {
            bundleVers: {}, remoteBundles: [], remoteServerAddress: '',
            register(map) { Object.assign(handlers, map); },
            downloadDomImage(file, options, cb) { cb(null, { image: file }); },
        } },
    };
    fixture.load('engine-adapter')(cc);
    return { ...fixture, handlers, cc };
}

test('Bilibili bundles wait for subpackage success and use packaged scripts for remote bundles', () => {
    const fixture = engineFixture();
    const { host, handlers, context, packages, loaded, cc } = fixture;
    context.__bilibiliConfig = { subpackages: [{ name: 'level', root: 'subpackages/level' }] };
    let pending;
    host.loadSubpackage = options => { pending = options; return {}; };
    packages.set('./subpackages/level/config.json', { name: 'level' });
    let result;
    handlers.bundle('level', {}, (error, value) => { result = { error, value }; });
    assert.equal(result, undefined);
    assert.equal(loaded.length, 0);
    pending.fail({ errMsg: 'subpackage failed' });
    assert.match(result.error.message, /subpackage failed/);
    handlers.bundle('level', {}, (error, value) => { assert.ifError(error); result = value; });
    pending.success();
    assert.equal(result.base, 'subpackages/level/');
    cc.assetManager.downloader.remoteBundles = ['remote'];
    cc.assetManager.downloader.remoteServerAddress = 'https://example.test/';
    packages.set('./src/bundle-scripts/remote/index.js', {});
    host.downloadFile = ({ success }) => { fixture.disk.set('bltmp://remote', '{"name":"remote"}'); success({ statusCode: 200, tempFilePath: 'bltmp://remote' }); return {}; };
    handlers.bundle('remote', {}, (error, value) => { assert.ifError(error); result = value; });
    assert.equal(result.base, 'https://example.test/remote/remote/');
    assert.ok(loaded.includes('./src/bundle-scripts/remote/index.js'));
    handlers['.js']('https://example.test/evil.js', {}, error => assert.match(error.message, /Invalid package path/));
});

test('Bilibili audio reuses the actual engine loader without a public AudioPlayer export', async () => {
    const fixture = adapterFixture(true);
    const downloader = { _downloaders: {}, register(map) { Object.assign(this._downloaders, map); } };
    const factories = {};
    const player = { duration: 2, type: 3 };
    const cc = { assetManager: { downloader } };
    const source = ts.transpileModule(fs.readFileSync(path.join(root, 'cocos/audio/audio-downloader.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInContext(`(function(require, exports) { ${source}\n})`, fixture.context)(name => {
        if (name === 'pal/audio') return { AudioPlayer: { load(url, options) {
            assert.match(url, /^bltmp:\/\//);
            assert.equal(options.audioLoadMode, 3);
            return Promise.resolve(player);
        } } };
        if (name === './audio-clip') return { AudioClip: class {} };
        if (name === '../asset/asset-manager/downloader') return { default: downloader };
        if (name === '../asset/asset-manager/factory') return { default: { register(map) { Object.assign(factories, map); } } };
        throw new Error(`Unexpected audio import: ${name}`);
    }, {});
    fixture.load('engine-adapter')(cc);
    const meta = await new Promise((resolve, reject) => {
        downloader._downloaders['.mp3']('https://example.test/music.mp3', { audioLoadMode: 3 }, (error, data) => error ? reject(error) : resolve(data));
    });
    assert.equal(meta.player, player);
    factories['.mp3']('music', meta, {}, (error, clip) => {
        assert.ifError(error);
        assert.equal(clip._nativeAsset.player, player);
        assert.equal(clip.duration, 2);
    });
});

test('Bilibili WebSocket connections keep independent task events', () => {
    const fixture = adapterFixture();
    const tasks = [];
    fixture.host.connectSocket = () => {
        const task = { send(options) { task.sent = options.data; }, close(options) { task.closed = options; } };
        for (const name of ['Open', 'Message', 'Error', 'Close']) task[`on${name}`] = cb => { task[name] = cb; };
        tasks.push(task);
        return task;
    };
    fixture.load('web-adapter');
    const first = new fixture.context.WebSocket('wss://example.test/first');
    const second = new fixture.context.WebSocket('wss://example.test/second');
    const messages = [];
    second.onmessage = event => messages.push(event.data);
    assert.throws(() => first.send('early'), /not OPEN/);
    tasks[0].Open({}); tasks[1].Open({});
    first.send('first');
    tasks[1].Message({ data: 'second' });
    assert.equal(tasks[0].sent, 'first');
    assert.deepEqual(messages, ['second']);
    second.close(); tasks[1].Close({ code: 1000 });
    assert.equal(first.readyState, first.OPEN);
    assert.equal(second.readyState, second.CLOSED);
});

test('Bilibili EditBox unregisters callbacks on focus switch and disposal', () => {
    const fixture = adapterFixture();
    const callbacks = {};
    for (const name of ['Input', 'Confirm', 'Complete']) {
        callbacks[name] = new Set();
        fixture.host[`onKeyboard${name}`] = cb => callbacks[name].add(cb);
        fixture.host[`offKeyboard${name}`] = cb => callbacks[name].delete(cb);
    }
    fixture.host.showKeyboard = options => { fixture.host.keyboardOptions = options; };
    fixture.host.hideKeyboard = () => {};
    class Base { clear() { this._delegate = null; } }
    const cc = { assetManager: { downloader: { register() {} } }, EditBox: { _EditBoxImpl: Base, InputMode: { ANY: 0 } } };
    fixture.load('engine-adapter')(cc);
    const changed = [];
    let ended = 0;
    const delegate = { string: '', maxLength: 20, inputMode: 0, returnType: 2,
        _editBoxTextChanged(value) { changed.push(value); }, _editBoxEditingDidBegan() {},
        _editBoxEditingDidEnded() { ++ended; }, _editBoxEditingReturn() {} };
    const first = new cc.EditBox._EditBoxImpl(); first.init(delegate); first.beginEditing();
    assert.equal(fixture.host.keyboardOptions.confirmType, 'send');
    for (const cb of callbacks.Input) cb({ value: 'hello' });
    const second = new cc.EditBox._EditBoxImpl(); second.init(delegate); second.beginEditing();
    assert.equal(callbacks.Input.size, 1);
    assert.equal(ended, 1);
    second.clear();
    assert.equal(callbacks.Input.size, 0);
    assert.equal(callbacks.Confirm.size, 0);
    assert.equal(callbacks.Complete.size, 0);
    assert.deepEqual(changed, ['hello']);
});

function bootstrapFixture(options = {}) {
    const ejs = require(require.resolve('ejs', { paths: [path.dirname(require.resolve('@cocos/ccbuild'))] }));
    const template = path.join(root, 'templates/bilibili/game.ejs');
    const code = ejs.render(fs.readFileSync(template, 'utf8'), {
        polyfillsBundleFile: '', systemJsBundleFile: './system.js', importMapFile: './import-map.json', applicationJs: './application.js', ...options,
    }, { filename: template });
    const fixture = adapterFixture();
    const errors = [];
    let reported = 0;
    fixture.host.getLaunchOptionsSync = () => ({ scene: 'cold' });
    fixture.host.launchSuccess = () => { ++reported; };
    const director = new EventEmitter();
    const cc = { Director: { EVENT_AFTER_SCENE_LAUNCH: 'scene', EVENT_AFTER_DRAW: 'draw' }, director,
        assetManager: { downloader: { register() {} } } };
    fixture.context.console = { ...console, error: (...args) => errors.push(args) };
    fixture.context.System = {
        warmup() {},
        import(name) {
            if (name === 'cc') return Promise.resolve(cc);
            return Promise.resolve({ Application: class {
                init() { if (options.failInit) throw new Error('initialization failed'); }
                start() { fixture.started = true; }
            } });
        },
    };
    const requireModule = file => {
        if (file === './game.json') return options.config || {};
        if (file === './import-map.json') return { default: { imports: {} } };
        if (file === './system.js') return {};
        return fixture.load(file);
    };
    vm.runInContext(`(function(require) { ${code}\n})`, fixture.context)(requireModule);
    return { ...fixture, director, errors, get reported() { return reported; } };
}

test('Bilibili template captures early re-entry and reports only after the first scene draw, once', async () => {
    const fixture = bootstrapFixture();
    for (const cb of fixture.listeners.Show) cb({ scene: '10002' });
    assert.equal(fixture.context.__bilibili.lastShowOptions.scene, '10002');
    await new Promise(resolve => setImmediate(resolve));
    fixture.director.emit('draw');
    assert.equal(fixture.reported, 0);
    fixture.director.emit('scene');
    assert.equal(fixture.reported, 0);
    fixture.director.emit('draw'); fixture.director.emit('scene'); fixture.director.emit('draw');
    fixture.context.__bilibili.reportLaunchSuccess();
    assert.equal(fixture.reported, 1);
    assert.deepEqual(fixture.errors, []);
});

test('Bilibili template disables automatic reporting for loading scenes and never reports failed startup', async () => {
    const manual = bootstrapFixture({ autoLaunchSuccess: false });
    const failed = bootstrapFixture({ failInit: true });
    await new Promise(resolve => setImmediate(resolve));
    for (const fixture of [manual, failed]) { fixture.director.emit('scene'); fixture.director.emit('draw'); assert.equal(fixture.reported, 0); }
    manual.context.__bilibili.reportLaunchSuccess();
    assert.equal(manual.reported, 1);
    failed.context.__bilibili.reportLaunchSuccess();
    assert.equal(failed.reported, 0);
    assert.equal(failed.errors.length, 1);
    assert.equal(failed.director.listenerCount('scene'), 0);
    assert.throws(() => bootstrapFixture({ useWebgl2: true }), /WebGL2 requires/);
});

test('Bilibili preflight validates configuration, subpackage ownership and unsupported output', t => {
    const { validateBilibili } = require('../validate-bilibili.cjs');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-bilibili-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    function write(file, data) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), data); }
    for (const file of ['game.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js', 'levels/game.js', 'levels/boss/game.js']) write(file, 'fixture');
    const config = { appId: 'biligame-test', version: '1.0.0', subpackages: [{ name: 'boss', root: 'levels/boss' }, { name: 'levels', root: 'levels' }] };
    const save = data => write('game.json', JSON.stringify(data));
    save(config);
    const result = validateBilibili(directory);
    assert.equal(result.packages[1].bytes, 7);
    assert.equal(result.packages[2].bytes, 7);
    assert.equal(result.packages.reduce((sum, item) => sum + item.bytes, 0), result.totalBytes);
    for (const [invalid, message] of [
        [{ ...config, appId: '' }, /appId/],
        [{ ...config, deviceOrientation: false }, /deviceOrientation/],
        [{ ...config, networkTimeout: 'invalid' }, /networkTimeout/],
        [{ ...config, networkTimeout: { request: 0 } }, /networkTimeout.request/],
        [{ ...config, iOSHighPerformance: 'true' }, /iOSHighPerformance/],
        [{ ...config, subpackages: [...config.subpackages].reverse() }, /child before parent/],
        [{ ...config, subpackages: [{ name: 'x', root: '../escape' }] }, /Unsafe/],
        [{ ...config, subpackages: [{ name: 'x', root: 'game.js' }] }, /bootstrap/],
        [{ ...config, openDataContext: 'open-data' }, /open-data/],
        [{ ...config, plugins: { wx: {} } }, /plugins/],
    ]) { save(invalid); assert.throws(() => validateBilibili(directory), message); }
    save(config);
    write('physics.wasm.br', 'fixture');
    assert.throws(() => validateBilibili(directory), /Brotli/);
    fs.unlinkSync(path.join(directory, 'physics.wasm.br'));
    write('assets/main/config.json', '{"isZip":true}');
    assert.throws(() => validateBilibili(directory), /uncompressed/);
    write('assets/main/config.json', '{}');
    write('large.bin', Buffer.alloc(4 * 1024 * 1024));
    assert.match(validateBilibili(directory).warnings[0], /4 MiB/);
    fs.symlinkSync(path.join(directory, 'game.js'), path.join(directory, 'linked.js'));
    assert.throws(() => validateBilibili(directory), /symlinks/);
    fs.unlinkSync(path.join(directory, 'linked.js'));
    fs.unlinkSync(path.join(directory, 'fs-utils.js'));
    assert.throws(() => validateBilibili(directory), /fs-utils.js/);
});
