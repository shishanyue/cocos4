const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const startupFaults = {
    'missing-game-config': /MISSING_RESOURCE: game.json/,
    'invalid-game-config': /JSON|Unexpected|Expected property/,
    'web-adapter': /INJECTED_WEB_ADAPTER_FAILURE/,
    loader: /INJECTED_LOADER_FAILURE/,
    'engine-adapter': /INJECTED_ENGINE_ADAPTER_FAILURE/,
    'missing-settings': /MISSING_RESOURCE: settings.json/,
    'missing-export': /FEATURE_NOT_IN_PROFILE: Sprite/,
    'missing-builtin': /BUILTIN_NOT_LOADED/,
    'invalid-material': /BUILTIN_MATERIAL_INVALID/,
    'init-sync': /INJECTED_SYNC_INIT_FAILURE/,
    init: /INJECTED_INIT_FAILURE/,
    run: /INJECTED_RUN_FAILURE/,
    'start-sync': /INJECTED_SYNC_START_FAILURE/,
    'start-async': /INJECTED_ASYNC_START_FAILURE/,
    'missing-main': /MISSING_RESOURCE: game\/main.js/,
    'missing-asset': /assets\/game\/tile.png.*does not exist/,
};

// Trusted maintainer artifacts only. Real loader/launcher/adapters/Application/game bytes,
// explicit tt and cc boundaries: no engine, renderer, decoder, audio playback or vendor service execution.
async function exerciseBytedance(files, { distinct = false, fault, devtools = false } = {}) {
    if (fault) assert.ok(Object.hasOwn(startupFaults, fault), `UNKNOWN_STARTUP_FAULT: ${fault}`);
    const json = name => JSON.parse(files.get(name).toString());
    const errors = [];
    const warnings = [];
    const loaded = [];
    const fileReads = [];
    const hostEvents = new EventEmitter();
    const classes = new Map();
    const director = new EventEmitter();
    let scene;
    let initCount = 0;
    let runCount = 0;
    let runCallback;
    let releaseAsset;
    const assetGate = new Promise(resolve => { releaseAsset = resolve; });
    const bytes = file => {
        const missing = { 'missing-game-config': 'game.json', 'missing-settings': 'settings.json',
            'missing-main': 'game/main.js', 'missing-asset': 'assets/game/tile.png' };
        const value = files.get(file);
        if (!value || missing[fault] === file) throw new Error(`MISSING_RESOURCE: ${file}`);
        if (fault === 'invalid-game-config' && file === 'game.json') return Buffer.from('{');
        return value;
    };
    class Asset { addRef() { return this; } }
    class Material extends Asset { constructor() { super(); this.passes = [{}]; } initialize() {} setProperty() {} }
    class Component {}
    class Node extends EventEmitter {
        static EventType = { TOUCH_END: 'touch-end' };
        constructor(name) { super(); this.name = name; this.children = []; this.components = []; this.bindings = []; }
        addChild(child) { this.children.push(child); }
        addComponent(Type) { const value = new Type(); value.node = this; this.components.push(value); return value; }
        getComponent(Type) { return this.components.find(value => value instanceof Type); }
        getChildByName(name) { return this.children.find(child => child.name === name); }
        setPosition() {} setRotationFromEuler() {}
        on(event, callback, target) {
            const bound = target ? callback.bind(target) : callback;
            this.bindings.push({ event, callback, bound, target });
            return super.on(event, bound);
        }
        off(event, callback, target) {
            const index = this.bindings.findIndex(item => item.event === event && item.callback === callback && item.target === target);
            const binding = index < 0 ? null : this.bindings.splice(index, 1)[0];
            return super.off(event, binding ? binding.bound : callback);
        }
    }
    class Cache {
        constructor(map = {}) { this._map = map; }
        get(key) { return this._map[key]; }
        has(key) { return Object.hasOwn(this._map, key); }
        add(key, value) { this._map[key] = value; }
        remove(key) { const value = this._map[key]; delete this._map[key]; return value; }
        forEach(callback) { for (const [key, value] of Object.entries(this._map)) callback(value, key); }
    }
    class Camera extends Component { static ProjectionType = { ORTHO: 0 }; static ClearFlag = { DEPTH_ONLY: 1 }; }
    class UITransform extends Component { setContentSize() {} }
    class Sprite extends Component { static SizeMode = { CUSTOM: 0 }; }
    class Label extends Component { static _canvasPool = {}; }
    class AudioSource extends Component {
        static EventType = { STARTED: 'audio-start', ENDED: 'audio-end' };
        play() { this.node.emit('audio-start'); this.node.emit('audio-end'); }
    }
    class AudioClip extends Asset { getDuration() { return this.duration; } }
    class Color { static WHITE = new Color(); constructor(...channels) { this.channels = channels; } }
    class MeshRenderer extends Component { setMaterial() {} }
    class EditBox { static KeyboardReturnType = {}; static InputMode = { ANY: 0 }; static _EditBoxImpl = class {}; }
    const originalEditBox = EditBox._EditBoxImpl;
    const input = new Node('input');
    const visitScene = (node, callback) => { for (const component of node.components) callback(component); for (const child of node.children) visitScene(child, callback); };
    director.runSceneImmediate = next => {
        if (scene) visitScene(scene, component => component.onDestroy?.());
        scene = next;
        visitScene(scene, component => component.start?.());
        director.emit('scene');
    };
    const downloader = { _downloaders: {}, bundleVers: {}, remoteBundles: [], remoteServerAddress: '',
        register(handlers) { Object.assign(this._downloaders, handlers); },
        downloadDomImage(file, options, cb) {
            try { const data = bytes(file); cb(null, { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }); }
            catch (error) { cb(error); }
        },
    };
    const parser = { _parsers: {}, register(handlers) { Object.assign(this._parsers, handlers); } };
    const assets = new Map();
    const builtins = json('builtin-report.json');
    for (const item of builtins.effects) assets.set(item.uuid, new Asset());
    for (const item of builtins.materials) assets.set(item.uuid, new Material());
    if (fault === 'missing-builtin') assets.delete(builtins.effects[0].uuid);
    if (fault === 'invalid-material') assets.get(builtins.materials[0].uuid).passes = [];
    let settings;
    const cc = {
        _decorator: { ccclass: name => Type => { classes.set(name, Type); return Type; }, property() {} },
        Asset, Material, Component, Node, Scene: Node, Camera, Canvas: Component, UITransform, Sprite, AudioSource,
        Color, AudioClip, SpriteFrame: Asset, Texture2D: Asset, ImageAsset: Asset, JsonAsset: Asset, Label,
        EventKeyboard: class {}, KeyCode: { KEY_R: 82 }, Input: { EventType: { KEY_UP: 'key-up' } }, input,
        Layers: { Enum: { UI_2D: 1, DEFAULT: 2 } },
        js: { getClassByName: name => classes.get(name), extend: (Type, Base) => Object.setPrototypeOf(Type.prototype, Base.prototype) },
        MeshRenderer, primitives: { box: options => options }, utils: { createMesh: () => new Asset() },
        director, Director: { EVENT_AFTER_SCENE_LAUNCH: 'scene', EVENT_AFTER_DRAW: 'draw' }, isValid: value => !!value,
        AudioPlayer: { async load(file) {
            const data = bytes(file);
            return { duration: data.readUInt32LE(40) / data.readUInt32LE(28), type: 'mock-audio-player' };
        } },
        AssetManager: { Cache }, path: path.posix,
        settings: { querySettings: (category, key) => settings[category]?.[key] },
        sys: { platform: 'BYTEDANCE_MINI_GAME', Platform: { BYTEDANCE_MINI_GAME: 'BYTEDANCE_MINI_GAME' }, OS: {} },
        Game: { EVENT_ENGINE_INITED: 'engine-inited' },
        assetManager: { assets, downloader, parser, presets: { scene: {} },
            transformPipeline: { append(callback) { this.transform = callback; } }, init() {},
            loadRemote(url, options, cb) {
                assetGate.then(() => {
                    const ext = path.extname(url);
                    const download = downloader._downloaders[ext];
                    if (!download) { cb(new Error(`UNMOCKED_ASSET_TYPE: ${url}`)); return; }
                    download(url, options, (error, data) => {
                        if (error) { cb(error); return; }
                        const finish = (error, value) => {
                            if (error) { cb(error); return; }
                            // These asset wrappers, image header reads and audio metadata are mocks, not decoders.
                            if (ext === '.json') value = { json: value };
                            if (ext === '.wav') value = Object.assign(new AudioClip(), { duration: value.duration });
                            cb(null, value);
                        };
                        const parse = parser._parsers[ext];
                        if (parse) parse(data, options, finish); else finish(null, data);
                    });
                }).catch(cb);
            },
        },
        game: Object.assign(new EventEmitter(), {
            init(options) {
                ++initCount;
                assert.equal(options.settingsPath, 'settings.json');
                if (fault === 'init-sync') throw new Error('INJECTED_SYNC_INIT_FAILURE');
                if (fault === 'init') return Promise.reject(new Error('INJECTED_INIT_FAILURE'));
                return new Promise((resolve, reject) => downloader._downloadJson(options.settingsPath, {}, (error, value) => {
                    if (error) { reject(error); return; }
                    settings = value;
                    resolve();
                })).then(async () => {
                    assert.deepEqual([...settings.engine.builtinAssets].sort(), [...builtins.effects, ...builtins.materials].map(item => item.uuid).sort());
                    cc.assetManager.init({});
                    await new Promise((resolve, reject) => downloader._downloaders.bundle('internal', {}, (error, config) => {
                        if (error) { reject(error); return; }
                        try { assert.equal(config.base, 'assets/internal/'); resolve(); } catch (error) { reject(error); }
                    }));
                    await context.System.import('virtual:///prerequisite-imports/internal');
                    cc.game.emit(cc.Game.EVENT_ENGINE_INITED);
                });
            },
            run(callback) {
                ++runCount;
                if (fault === 'run') throw new Error('INJECTED_RUN_FAILURE');
                runCallback = callback;
                // Intentionally void and deferred, like the engine API.
            },
        }),
    };
    // The adapter uses a separate legacy namespace, populated by the engine on window.
    const legacy = { ...cc, internal: { EditBox } };
    if (fault === 'missing-export') delete cc.Sprite;
    const host = {
        env: { USER_DATA_PATH: 'ttfile://mock-user' },
        getLaunchOptionsSync: () => ({ scene: 'cold' }),
        getSystemInfoSync: () => ({ platform: devtools ? 'devtools' : 'android', system: 'Android 14',
            version: '1.0.0', language: 'en', screenWidth: 640, screenHeight: 480, windowWidth: 640, windowHeight: 480,
            pixelRatio: 2, devicePixelRatio: 2 }),
        createCanvas: () => ({ width: 480, height: 640, getContext(type) {
            if (type !== '2d') throw new Error('NO_MOCK_GL: rendering is not a local validation boundary');
            return { mock: 'unused-label-canvas-context' };
        } }),
        createImage: () => ({}),
        getOpenDataContext: () => ({}),
        getFileSystemManager: () => ({
            readFileSync(file) {
                fileReads.push(file);
                if (file === 'ttfile://mock-user/gamecaches/cacheList.json') return '{"version":"1.0","files":{}}';
                return bytes(file).toString();
            },
            readFile({ filePath, encoding, success, fail }) {
                fileReads.push(filePath);
                try { const data = bytes(filePath); success({ data: encoding ? data.toString() : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }); }
                catch (error) { fail({ errMsg: error.message }); }
            },
            access({ path: file, success, fail }) { try { bytes(file); success(); } catch (error) { fail({ errMsg: error.message }); } },
        }),
    };
    for (const event of ['Show', 'Hide', 'TouchStart', 'TouchMove', 'TouchEnd', 'TouchCancel', 'NetworkStatusChange', 'DeviceOrientationChange']) {
        host[`on${event}`] = cb => hostEvents.on(event, cb);
    }
    const context = vm.createContext({ tt: host, console: { ...console, log() {},
        error: (...args) => errors.push(args.map(String).join(' ')), warn: (...args) => warnings.push(args.map(String).join(' ')) },
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame() { throw new Error('NO_MOCK_RENDER_LOOP'); }, cancelAnimationFrame() {},
    });
    vm.runInContext(`globalThis.GameGlobal = ${distinct ? '{}' : 'globalThis'};
        GameGlobal.TTWebAssembly = { instantiate() { throw new Error('NO_MOCK_WASM'); } };`, context);
    if (devtools) vm.runInContext('globalThis.window = GameGlobal; GameGlobal.document = {};', context);
    const modules = new Map();
    function load(specifier, parent = 'game.js') {
        assert.ok(specifier.startsWith('.'), `UNKNOWN_COMMONJS_MODULE: ${specifier}`);
        let file = path.posix.normalize(path.posix.join(path.posix.dirname(parent), specifier));
        assert.ok(!file.startsWith('../') && !/[:\\]/.test(file) && !path.posix.isAbsolute(file), 'Module escapes runtime');
        if (!path.extname(file)) file += '.js';
        if (modules.has(file)) return modules.get(file).exports;
        if (fault && file === `${fault}.js`) throw new Error(`INJECTED_${fault.toUpperCase().replaceAll('-', '_')}_FAILURE`);
        const module = { exports: {} };
        if (file === 'cocos-js/cc.js') {
            // No synthetic engine file is read or executed. The actual loader imports this explicit cc boundary.
            modules.set(file, module);
            loaded.push(file);
            context.System.register([], exports => ({ execute() { context.window.cc = legacy; exports(cc); } }));
            return module.exports;
        }
        const source = bytes(file).toString();
        if (file.endsWith('.json')) {
            module.exports = JSON.parse(source);
            modules.set(file, module);
            return module.exports;
        }
        modules.set(file, module);
        loaded.push(file);
        vm.runInContext(`(function(require, module, exports) {\n${source}\n})`, context, { filename: file, timeout: 5000 })(
            name => load(name, file), module, module.exports);
        if (file === 'loader.js') assert.equal(context.System, context.GameGlobal.System);
        return module.exports;
    }
    load('./game.js');
    const entry = context.__bytedance;
    assert.equal(vm.runInContext('GameGlobal !== globalThis', context), distinct);
    assert.equal(vm.runInContext('typeof wx + ":" + typeof bl', context), 'undefined:undefined');
    hostEvents.emit('Show', { scene: 'early' });
    assert.equal(entry.launchOptions.scene, 'cold');
    assert.equal(entry.lastShowOptions.scene, 'early');
    const startup = entry.startup;
    const waitForStartup = async () => {
        let timer;
        try {
            await Promise.race([startup, new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('LOCAL_LIFECYCLE_TIMEOUT')), 5000);
            })]);
        } finally { clearTimeout(timer); }
    };
    let settled = false;
    startup.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 40 && !settled && !runCallback; ++i) await new Promise(resolve => setImmediate(resolve));
    assert.ok(settled || runCallback, 'Bootstrap did not initialize or reject');
    if (runCallback) {
        assert.equal(settled, false, 'Application.start must await the run callback');
        if (fault === 'start-sync' || fault === 'start-async') {
            const main = await context.System.import('./game/main.js');
            main.start = () => {
                if (fault === 'start-sync') throw new Error('INJECTED_SYNC_START_FAILURE');
                return Promise.reject(new Error('INJECTED_ASYNC_START_FAILURE'));
            };
        }
        runCallback();
        runCallback();
        await new Promise(resolve => setImmediate(resolve));
        if (!fault?.startsWith('start-')) assert.equal(settled, false, 'Application.start must await main.start assets');
        releaseAsset();
    }
    if (fault) {
        let rejected;
        await assert.rejects(waitForStartup(), error => { rejected = error; assert.match(error.message, startupFaults[fault]); return true; });
        assert.equal(entry.error, rejected);
        assert.equal(entry.state, 'failed');
        assert.equal(errors.length, 1);
        assert.ok(context.__runtimeError);
        assert.ok(initCount <= 1 && runCount <= 1);
        const counts = [initCount, runCount];
        hostEvents.emit('Hide'); hostEvents.emit('Show', { scene: 'after-failure' });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual([initCount, runCount], counts);
        assert.equal(entry.startup, startup);
        assert.equal(entry.state, 'failed');
        return { fault, errors, warnings, initCount, runCount };
    }
    await waitForStartup();
    assert.equal(entry.state, 'started');
    assert.equal(initCount, 1); assert.equal(runCount, 1);
    assert.equal(context.cc, legacy);
    assert.equal(context.fsUtils, context.window.fsUtils);
    assert.equal(load('./fs-utils.js'), context.fsUtils);
    assert.equal(context.System, context.GameGlobal.System);
    assert.equal(context.self, context.GameGlobal);
    assert.notEqual(EditBox._EditBoxImpl, originalEditBox);
    assert.equal(Label._canvasPool.get().context.mock, 'unused-label-canvas-context');
    assert.equal(context.canvas.width, 1280); assert.equal(context.canvas.height, 960);
    assert.equal(context.CCWebAssembly, context.GameGlobal.TTWebAssembly);
    assert.equal(context.__bytedanceRequire('./game-compiler.json').requiredCCExports.length, json('game-compiler.json').requiredCCExports.length);
    const probe = context.__runtimeProbe;
    for (const name of ['ready', 'classRegistered', 'imageLoaded', 'jsonLoaded', 'audioLoaded']) assert.equal(probe[name], true, name);
    assert.equal(probe.decoratedDefault, 7);
    assert.equal(probe.world3d, json('runtime.json').profile === '3d-basic');
    let touches = 0;
    context.document.addEventListener('touchend', () => { ++touches; });
    hostEvents.emit('TouchEnd', { touches: [], changedTouches: [], timeStamp: 1 });
    assert.equal(touches, 1, 'Prepared adapter must deliver tt touch events to its document');
    // UI hit testing is not mocked: component events are explicit lifecycle probes.
    scene.getChildByName('Canvas').getChildByName('ClickTile').emit('touch-end');
    assert.equal(probe.score, 7);
    scene.getChildByName('Canvas').getChildByName('Instructions').emit('touch-end');
    assert.equal(probe.score, 0); assert.equal(probe.restarts, 1); assert.equal(probe.starts, 2);
    assert.equal(input.listenerCount('key-up'), 1);
    hostEvents.emit('Hide'); assert.equal(entry.hidden, true);
    hostEvents.emit('Show', { scene: 'reentry' }); assert.equal(entry.hidden, false);
    assert.equal(entry.lastShowOptions.scene, 'reentry'); assert.equal(entry.launchOptions.scene, 'cold');
    assert.equal(entry.startup, startup); assert.equal(initCount, 1); assert.equal(runCount, 1);
    await context.__checkMissingAsset();
    assert.equal(probe.missingRejected, true);
    await assert.rejects(context.System.import('unmapped-local-negative'), /Unresolved|Unable to resolve/);
    await assert.rejects(context.System.import('./game/missing-local-negative.js'), /MISSING_RESOURCE|Error loading/);
    assert.equal(await context.System.import('./game/main.js'), await context.System.import('./game/main.js'));
    assert.equal(loaded.filter(file => file === 'game/main.js').length, 1);
    assert.ok(!loaded.includes('game/missing-local-negative.js'), 'A rejected missing module was not loaded');
    assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
    return { distinct, devtools, loaded, fileReads, initCount, runCount, errors, warnings, probe: { ...probe },
        negativeGates: ['unknown-module', 'missing-module', 'missing-asset'] };
}

module.exports = { exerciseBytedance, startupFaults };
