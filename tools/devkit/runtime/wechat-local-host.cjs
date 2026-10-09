const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Trusted artifact verifier, not a sandbox. Only cc/vendor services are mocked;
// the actual launcher, loader, both pinned adapter bundles, Application and game modules execute.
async function exerciseWechat(files, { distinct = false, separateSelf = false, platform = 'android', fault } = {}) {
    const faults = {
        'missing-host': /WECHAT_HOST_REQUIRED/,
        'missing-fs': /WECHAT_FILESYSTEM_REQUIRED/,
        'missing-settings': /MISSING_RESOURCE: settings.json/,
        'missing-export': /FEATURE_NOT_IN_PROFILE: Sprite/,
        'missing-builtin': /BUILTIN_NOT_LOADED/,
        'invalid-material': /BUILTIN_MATERIAL_INVALID/,
        init: /INJECTED_INIT_FAILURE/,
        run: /INJECTED_RUN_FAILURE/,
        'start-sync': /INJECTED_SYNC_START_FAILURE/,
        'start-async': /INJECTED_ASYNC_START_FAILURE/,
        'missing-asset': /assets\/game\/tile.png.*does not exist/,
    };
    if (fault) assert.ok(Object.hasOwn(faults, fault), `Unknown WeChat fault: ${fault}`);
    const json = name => JSON.parse(bytes(name).toString());
    const errors = [];
    const warnings = [];
    const loaded = [];
    const reads = [];
    const hostEvents = new EventEmitter();
    const classes = new Map();
    const director = new EventEmitter();
    let scene;
    let frameCallback;
    let runCallback;
    let initCalls = 0;
    let runCalls = 0;
    let releaseAsset;
    let settings;
    const assetGate = new Promise(resolve => { releaseAsset = resolve; });
    function bytes(file) {
        const value = files.get(file);
        if (!value || (fault === 'missing-asset' && file === 'assets/game/tile.png')
            || (fault === 'missing-settings' && file === 'settings.json')) throw new Error(`MISSING_RESOURCE: ${file}`);
        return value;
    }
    class Asset { addRef() { return this; } }
    class Material extends Asset { constructor() { super(); this.passes = [{}]; } initialize() {} setProperty() {} }
    class SpriteFrame extends Asset {}
    class Texture2D extends Asset {}
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
            const binding = this.bindings.find(item => item.event === event && item.callback === callback && item.target === target);
            return super.off(event, binding ? binding.bound : callback);
        }
    }
    class Camera extends Component { static ProjectionType = { ORTHO: 0 }; static ClearFlag = { DEPTH_ONLY: 1 }; }
    class UITransform extends Component { setContentSize() {} }
    class Sprite extends Component { static SizeMode = { CUSTOM: 0 }; }
    class AudioSource extends Component {
        static EventType = { STARTED: 'audio-start', ENDED: 'audio-end' };
        play() { this.node.emit('audio-start'); this.node.emit('audio-end'); }
    }
    class AudioClip extends Asset { getDuration() { return this.duration; } }
    class Color { static WHITE = new Color(); constructor(...channels) { this.channels = channels; } }
    class MeshRenderer extends Component { setMaterial() {} }
    class Cache {
        constructor(map = {}) { this._map = map; }
        get(key) { return this._map[key]; }
        has(key) { return Object.hasOwn(this._map, key); }
        add(key, value) { this._map[key] = value; }
    }
    const input = new Node('input');
    const visit = (node, callback) => { for (const component of node.components) callback(component); for (const child of node.children) visit(child, callback); };
    director.runSceneImmediate = next => {
        if (scene) visit(scene, component => component.onDestroy?.());
        scene = next;
        visit(scene, component => component.start?.());
        director.emit('scene');
    };
    const downloader = { _downloaders: {}, bundleVers: {}, remoteBundles: [], remoteServerAddress: '',
        register(handlers) { Object.assign(this._downloaders, handlers); },
        downloadDomImage(file, options, callback) {
            try { const data = bytes(file); callback(null, { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }); }
            catch (error) { callback(error); }
        },
    };
    const parser = { _parsers: {}, register(handlers) { Object.assign(this._parsers, handlers); } };
    const assets = new Map();
    const builtins = json('builtin-report.json');
    const cc = {
        _decorator: { ccclass: name => Type => { classes.set(name, Type); return Type; }, property() {} },
        Asset, Material, Component, Node, Scene: Node, Camera, Canvas: Component, UITransform, Sprite, AudioSource,
        Color, AudioClip, SpriteFrame, Texture2D, ImageAsset: Asset, JsonAsset: Asset, Label: Component,
        EventKeyboard: class {}, KeyCode: { KEY_R: 82 }, Input: { EventType: { KEY_UP: 'key-up' } }, input,
        Layers: { Enum: { UI_2D: 1, DEFAULT: 2 } },
        js: { getClassByName: name => classes.get(name), extend(Type, Base) { Object.setPrototypeOf(Type.prototype, Base.prototype); } },
        MeshRenderer, primitives: { box: options => options }, utils: { createMesh: () => new Asset() },
        director, Director: { EVENT_AFTER_SCENE_LAUNCH: 'scene', EVENT_AFTER_DRAW: 'draw' }, isValid: value => !!value,
        assetManager: { assets, downloader, parser, presets: { scene: {} }, transformPipeline: { append() {} }, init() {},
            loadRemote(url, options, callback) {
                assetGate.then(() => {
                    const extension = path.posix.extname(url);
                    const download = downloader._downloaders[extension];
                    if (!download) throw new Error(`UNMOCKED_ASSET_TYPE: ${url}`);
                    download(url, options, (error, data) => {
                        if (error) { callback(error); return; }
                        const complete = (error, value) => {
                            if (error) { callback(error); return; }
                            if (extension === '.json') value = { json: value };
                            if (extension === '.wav') { const clip = new AudioClip(); clip.duration = value.duration; value = clip; }
                            callback(null, value);
                        };
                        const parse = parser._parsers[extension];
                        if (parse) parse(data, options, complete);
                        else complete(null, data);
                    });
                }).catch(callback);
            },
        },
        game: {
            async init(options) {
                ++initCalls;
                assert.equal(options.settingsPath, 'settings.json');
                if (fault === 'init') throw new Error('INJECTED_INIT_FAILURE');
                const download = (handler, file) => new Promise((resolve, reject) => handler(file, {},
                    (error, value) => error ? reject(error) : resolve(value)));
                settings = await download(downloader._downloadJson, options.settingsPath);
                const uuids = [...builtins.effects, ...builtins.materials].map(item => item.uuid).sort();
                assert.deepEqual([...settings.engine.builtinAssets].sort(), uuids);
                cc.assetManager.init();
                const bundle = await download(downloader._downloaders.bundle, 'assets/internal');
                assert.deepEqual([...bundle.uuids].sort(), uuids);
                for (const item of [...builtins.effects, ...builtins.materials]) {
                    // Real serialized bytes pass through the pinned downloader; deserialization is a cc mock.
                    await download(downloader._downloadJson, `${bundle.base}${bundle.importBase}/${item.uuid.slice(0, 2)}/${item.uuid}.json`);
                    assets.set(item.uuid, builtins.materials.includes(item) ? new Material() : new Asset());
                }
                if (fault === 'missing-builtin') assets.delete(builtins.effects[0].uuid);
                if (fault === 'invalid-material') assets.get(builtins.materials[0].uuid).passes = [];
            },
            run(callback) {
                ++runCalls;
                if (fault === 'run') throw new Error('INJECTED_RUN_FAILURE');
                runCallback = callback; // Deliberately deferred and void, like the engine API.
            },
        },
    };
    const legacy = cc.cclegacy = { ...cc, internal: { EditBox: { _EditBoxImpl: class {}, KeyboardReturnType: {} } },
        AssetManager: { Cache }, path: path.posix,
        sys: { platform: 'WECHAT_GAME', Platform: { WECHAT_GAME: 'WECHAT_GAME' }, OS: { ANDROID: 'android' } },
        settings: { querySettings: (category, name) => settings[category]?.[name] },
        AudioPlayer: { async load(file) {
            const data = bytes(file);
            return { duration: data.readUInt32LE(40) / data.readUInt32LE(28), type: 'mock-audio', url: file };
        } },
    };
    if (fault === 'missing-export') delete cc.Sprite;
    const userData = new Map([['wxfile://mock-user/gamecaches/cacheList.json', Buffer.from('{"version":"1.0","files":{}}')]]);
    const readHostFile = file => { reads.push(file); return userData.get(file) || bytes(file); };
    const filesystem = {
        readFileSync(file, encoding) { const data = readHostFile(file); return encoding ? data.toString() : data; },
        readFile({ filePath, encoding, success, fail }) {
            let data;
            try { data = readHostFile(filePath); } catch (error) { fail({ errMsg: error.message }); return; }
            success({ data: encoding ? data.toString() : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
        },
        access({ path: file, success, fail }) {
            try { readHostFile(file); } catch (error) { fail({ errMsg: error.message }); return; }
            success({});
        },
    };
    class HostCanvas {
        constructor() { this.width = 480; this.height = 640; }
        getContext() { throw new Error('NO_MOCK_GL: local verification does not render'); }
    }
    class HostImage { set src(value) { throw new Error(`NO_MOCK_IMAGE_DECODE: ${value}`); } }
    const host = {
        env: { USER_DATA_PATH: 'wxfile://mock-user' },
        getLaunchOptionsSync: () => ({ scene: 1001, query: { entry: 'cold' } }),
        getSystemInfoSync: () => ({ platform, system: 'Android 14', version: '8.0.0', language: 'en',
            screenWidth: 640, screenHeight: 480, windowWidth: 640, windowHeight: 480, pixelRatio: 2 }),
        createCanvas: () => new HostCanvas(), createImage: () => new HostImage(),
        getFileSystemManager: fault === 'missing-fs' ? undefined : () => filesystem,
        getOpenDataContext() { throw new Error('UNMOCKED_OPEN_DATA_CONTEXT'); },
    };
    for (const event of ['Show', 'Hide', 'TouchStart', 'TouchMove', 'TouchEnd', 'TouchCancel', 'NetworkStatusChange', 'DeviceOrientationChange']) {
        host[`on${event}`] = callback => hostEvents.on(event, callback);
    }
    const context = vm.createContext({ ...(fault === 'missing-host' ? {} : { wx: host }),
        console: { ...console, log() {}, error: (...args) => errors.push(args.map(String).join(' ')),
            warn: (...args) => warnings.push(args.map(String).join(' ')) },
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame(callback) {
            assert.equal(frameCallback, undefined, 'Only the initial host frame is mocked, not an engine render loop');
            frameCallback = callback;
            return 1;
        }, cancelAnimationFrame() {},
    });
    vm.runInContext(`globalThis.GameGlobal = ${distinct ? '{ setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame, cancelAnimationFrame }' : 'globalThis'};
        globalThis.self = ${separateSelf ? '{}' : 'GameGlobal'};`, context);
    if (platform === 'devtools') {
        // The vendor DevTools branch expects an existing window/document, unlike device hosts.
        vm.runInContext('globalThis.window = globalThis; GameGlobal.document = globalThis.document = {};', context);
    }
    const modules = new Map();
    function load(specifier, parent = 'game.js') {
        assert.ok(typeof specifier === 'string' && specifier.startsWith('.'), `UNKNOWN_COMMONJS_MODULE: ${specifier}`);
        const relative = path.posix.join(path.posix.dirname(parent), specifier);
        const file = path.posix.extname(relative) ? relative : `${relative}.js`;
        assert.ok(!file.startsWith('../') && !/[:\\]/.test(file) && !path.posix.isAbsolute(file), `Module escapes runtime: ${specifier}`);
        if (modules.has(file)) return modules.get(file).exports;
        const source = bytes(file).toString();
        const module = { exports: {} };
        modules.set(file, module);
        loaded.push(file);
        if (file.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports; }
        if (file === 'cocos-js/cc.js') {
            // Do not execute the engine or fabricate GL. This is the only substituted System module.
            context.System.register([], exports => ({ execute() { context.window.cc = legacy; exports(cc); } }));
        } else {
            vm.runInContext(`(function(require, module, exports) {\n${source}\n})`, context, { filename: file, timeout: 5000 })(
                name => load(name, file), module, module.exports);
        }
        return module.exports;
    }
    load('./game.js');
    assert.equal(vm.runInContext('GameGlobal !== globalThis', context), distinct);
    const entry = context.__wechat;
    const startup = entry.startup;
    assert.equal(typeof startup.then, 'function', 'Launcher must retain the startup Promise');
    let settled = false;
    startup.then(() => { settled = true; }, () => { settled = true; });
    if (fault !== 'missing-host') {
        hostEvents.emit('Show', { scene: 1007, query: { entry: 'early' } });
        assert.equal(entry.launchOptions.query.entry, 'cold');
        assert.equal(entry.lastShowOptions.query.entry, 'early');
        assert.deepEqual(entry.config, json('game.json'));
        if (platform === 'android') {
            assert.equal(entry.phase, 'waiting-for-frame');
            assert.equal(loaded.includes('web-adapter.js'), false, 'Android adapter initialization must wait for the host frame');
            assert.equal(settled, false);
            frameCallback();
        }
    }
    for (let i = 0; i < 30 && !settled && !runCallback; ++i) await new Promise(resolve => setImmediate(resolve));
    assert.ok(settled || runCallback, 'Bootstrap did not initialize or reject');
    if (runCallback) {
        assert.equal(settled, false, 'Application.start must wait for game.run');
        assert.equal(context.System, context.self.System);
        assert.equal(context.System, context.GameGlobal.System);
        assert.equal(context.cc, legacy, 'The public namespace must not replace cclegacy');
        assert.equal(context.window.fsUtils, load('./fs-utils.js'));
        assert.equal(context.window.fsUtils.fs, filesystem);
        assert.equal(context.window.canvas.width, 1280);
        assert.equal(context.window.canvas.height, 960);
        assert.equal(typeof legacy.internal.EditBox._EditBoxImpl.prototype.beginEditing, 'function');
        assert.equal(typeof SpriteFrame.prototype._checkPackable, 'function');
        if (fault === 'start-sync' || fault === 'start-async') {
            const main = await context.System.import('./game/main.js');
            main.start = () => {
                if (fault === 'start-sync') throw new Error('INJECTED_SYNC_START_FAILURE');
                return Promise.reject(new Error('INJECTED_ASYNC_START_FAILURE'));
            };
        }
        runCallback();
        await new Promise(resolve => setImmediate(resolve));
        if (!fault?.startsWith('start-')) assert.equal(settled, false, 'Application.start must wait for main.start assets');
        releaseAsset();
    }
    const waitForStartup = async () => {
        let timer;
        try {
            return await Promise.race([startup, new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('WECHAT_LOCAL_LIFECYCLE_TIMEOUT')), 5000);
            })]);
        } finally { clearTimeout(timer); }
    };
    if (fault) {
        await assert.rejects(waitForStartup(), faults[fault]);
        assert.equal(entry.startup, startup);
        assert.equal(entry.phase, 'failed');
        assert.match(entry.error.message, faults[fault]);
        assert.match(context.__runtimeError, faults[fault]);
        assert.equal(errors.length, 1);
        if (fault === 'missing-settings') {
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /Read file failed: path: settings.json/);
        } else assert.deepEqual(warnings, []);
        assert.ok(initCalls <= 1 && runCalls <= 1);
        return { fault, errors, warnings, loaded, initCalls, runCalls, phase: entry.phase };
    }
    assert.equal(await waitForStartup(), undefined, 'Startup has a Promise<void> boundary');
    assert.equal(entry.phase, 'running');
    assert.equal(entry.error, null);
    assert.equal(context.__runtimeError, undefined);
    const probe = context.__runtimeProbe;
    for (const name of ['ready', 'classRegistered', 'imageLoaded', 'jsonLoaded', 'audioLoaded']) assert.equal(probe[name], true, name);
    assert.equal(probe.decoratedDefault, 7);
    assert.equal(probe.world3d, json('runtime.json').profile === '3d-basic');
    let adapterTouchEvents = 0;
    context.document.addEventListener('touchend', event => {
        assert.equal(event.changedTouches[0].identifier, 1);
        ++adapterTouchEvents;
    });
    hostEvents.emit('TouchEnd', { touches: [], changedTouches: [{ identifier: 1, clientX: 320, clientY: 240 }], timeStamp: 1 });
    assert.equal(adapterTouchEvents, 1);
    scene.getChildByName('Canvas').getChildByName('ClickTile').emit('touch-end');
    assert.equal(probe.score, 7);
    scene.getChildByName('Canvas').getChildByName('Instructions').emit('touch-end');
    assert.equal(probe.score, 0);
    assert.equal(probe.restarts, 1);
    assert.equal(probe.starts, 2);
    assert.equal(input.listenerCount('key-up'), 1);
    hostEvents.emit('Hide', { reason: 'background' });
    assert.equal(entry.hidden, true);
    assert.equal(entry.lastHideOptions.reason, 'background');
    hostEvents.emit('Show', { scene: 1001, query: { entry: 'reentry' } });
    assert.equal(entry.hidden, false);
    assert.equal(entry.lastShowOptions.query.entry, 'reentry');
    await context.__checkMissingAsset();
    assert.equal(probe.missingRejected, true);
    await assert.rejects(context.System.import('unmapped-local-negative'), /Unresolved|Unable to resolve/);
    await assert.rejects(context.System.import('./game/missing-local-negative.js'), /MISSING_RESOURCE|Error loading/);
    assert.equal(await context.System.import('./game/main.js'), await context.System.import('./game/main.js'));
    assert.equal(loaded.filter(file => file === 'game/main.js').length, 1);
    await entry.application.init(cc);
    assert.equal(await entry.application.start(), undefined);
    assert.equal(initCalls, 1);
    assert.equal(runCalls, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    return { distinct, separateSelf, platform, loaded, reads, errors, warnings, initCalls, runCalls,
        phase: entry.phase, adapterTouchEvents, probe: { ...probe },
        negativeGates: ['unknown-module', 'missing-module', 'missing-asset'] };
}

module.exports = { exerciseWechat };
