const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Explicit contract mocks: no engine execution, GL, image decoding, audio playback or vendor services.
// The launcher, loader, adapters, Application and compiled public-cc game modules are real artifact bytes.
async function exerciseBilibili(files, { distinct = false, fault } = {}) {
    const json = name => JSON.parse(files.get(name).toString());
    const errors = [];
    const warnings = [];
    const loaded = [];
    const hostEvents = new EventEmitter();
    const classes = new Map();
    const director = new EventEmitter();
    let scene;
    let reports = 0;
    let runCallback;
    let releaseAsset;
    const assetGate = new Promise(resolve => { releaseAsset = resolve; });
    const bytes = file => {
        const value = files.get(file);
        if (!value || (fault === 'missing-asset' && file === 'assets/game/tile.png')) throw new Error(`MISSING_RESOURCE: ${file}`);
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
    downloader._downloaders['.wav'] = (file, options, cb) => {
        try { const data = bytes(file); const clip = new AudioClip(); clip.duration = data.readUInt32LE(40) / data.readUInt32LE(28); cb(null, clip); }
        catch (error) { cb(error); }
    };
    const assets = new Map();
    const builtins = json('builtin-report.json');
    for (const item of builtins.effects) assets.set(item.uuid, new Asset());
    for (const item of builtins.materials) assets.set(item.uuid, new Material());
    if (fault === 'missing-builtin') assets.delete(builtins.effects[0].uuid);
    if (fault === 'invalid-material') assets.get(builtins.materials[0].uuid).passes = [];
    const cc = {
        _decorator: { ccclass: name => Type => { classes.set(name, Type); return Type; }, property() {} },
        Asset, Material, Component, Node, Scene: Node, Camera, Canvas: Component, UITransform, Sprite, AudioSource,
        Color, AudioClip, SpriteFrame: Asset, Texture2D: Asset, ImageAsset: Asset, JsonAsset: Asset, Label: Component,
        EventKeyboard: class {}, KeyCode: { KEY_R: 82 }, Input: { EventType: { KEY_UP: 'key-up' } }, input,
        Layers: { Enum: { UI_2D: 1, DEFAULT: 2 } }, js: { getClassByName: name => classes.get(name) },
        MeshRenderer, primitives: { box: options => options }, utils: { createMesh: () => new Asset() },
        director, Director: { EVENT_AFTER_SCENE_LAUNCH: 'scene', EVENT_AFTER_DRAW: 'draw' }, isValid: value => !!value,
        assetManager: { assets, downloader,
            loadRemote(url, options, cb) {
                assetGate.then(() => {
                    const handler = downloader._downloaders[path.extname(url)];
                    if (!handler) { cb(new Error(`UNMOCKED_ASSET_TYPE: ${url}`)); return; }
                    handler(url, options, (error, asset) => cb(error, path.extname(url) === '.json' ? { json: asset } : asset));
                }).catch(cb);
            },
        },
        game: {
            async init(options) {
                assert.equal(options.settingsPath, 'settings.json');
                if (fault === 'init') throw new Error('INJECTED_INIT_FAILURE');
                await new Promise((resolve, reject) => downloader._downloadJson(options.settingsPath, {}, (error, settings) => {
                    if (error) { reject(error); return; }
                    try { assert.deepEqual([...settings.engine.builtinAssets].sort(), [...assets.keys()].sort()); resolve(); }
                    catch (error) { if (fault === 'missing-builtin') resolve(); else reject(error); }
                }));
            },
            run(callback) {
                if (fault === 'run') throw new Error('INJECTED_RUN_FAILURE');
                runCallback = callback;
                // Deliberately void and deferred, as in the engine API.
            },
        },
    };
    if (fault === 'missing-export') delete cc.Sprite;
    const host = {
        env: { USER_DATA_PATH: 'blfile://mock-user' },
        getLaunchOptionsSync: () => ({ scene: 'cold' }), launchSuccess: () => { ++reports; },
        getSystemInfoSync: () => ({ platform: 'android', screenWidth: 640, screenHeight: 480, pixelRatio: 1 }),
        createCanvas: () => ({ getContext() { throw new Error('NO_MOCK_GL: rendering is not a local validation boundary'); } }),
        createImage() { throw new Error('UNMOCKED_VENDOR_IMAGE'); },
        getFileSystemManager: () => ({
            readFileSync(file) { return bytes(file).toString(); },
            readFile({ filePath, encoding, success, fail }) {
                try { const data = bytes(filePath); success({ data: encoding ? data.toString() : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }); }
                catch (error) { fail(error); }
            },
        }),
    };
    for (const event of ['Show', 'Hide', 'WindowResize']) host[`on${event}`] = cb => hostEvents.on(event, cb);
    const context = vm.createContext({ bl: host, console: { ...console, error: (...args) => errors.push(args.map(String).join(' ')),
        warn: (...args) => warnings.push(args.map(String).join(' ')) },
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame() { throw new Error('NO_MOCK_RENDER_LOOP'); }, cancelAnimationFrame() {},
    });
    vm.runInContext(`globalThis.GameGlobal = ${distinct ? '{}' : 'globalThis'};`, context);
    const modules = new Map();
    function load(specifier, parent = 'game.js') {
        assert.ok(specifier.startsWith('.'), `UNKNOWN_COMMONJS_MODULE: ${specifier}`);
        let file = path.posix.normalize(path.posix.join(path.posix.dirname(parent), specifier));
        assert.ok(!file.startsWith('../') && !path.posix.isAbsolute(file), 'Module escapes runtime');
        if (!path.extname(file)) file += '.js';
        if (fault === 'missing-settings' && file === 'settings.json') throw new Error('MISSING_SETTINGS');
        if (modules.has(file)) return modules.get(file).exports;
        const source = bytes(file).toString();
        if (file.endsWith('.json')) return JSON.parse(source);
        const module = { exports: {} };
        modules.set(file, module);
        loaded.push(file);
        if (file === 'cocos-js/cc.js') {
            // Register only the explicit cc boundary through the actual loader's instantiate hook.
            context.System.register([], exports => ({ execute() { exports(cc); } }));
            return module.exports;
        }
        vm.runInContext(`(function(require, module, exports) {\n${source}\n})`, context, { filename: file, timeout: 5000 })(
            name => load(name, file), module, module.exports);
        if (file === 'loader.js') {
            assert.equal(context.System, context.GameGlobal.System);
        }
        return module.exports;
    }
    load('./game.js');
    assert.equal(vm.runInContext('GameGlobal !== globalThis', context), distinct);
    hostEvents.emit('Show', { scene: 'early' });
    assert.equal(context.__bilibili.launchOptions.scene, 'cold');
    assert.equal(context.__bilibili.lastShowOptions.scene, 'early');
    const startup = context.__bilibili.startup;
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
    for (let i = 0; i < 20 && !settled && !runCallback; ++i) await new Promise(resolve => setImmediate(resolve));
    assert.ok(settled || runCallback, 'Bootstrap did not initialize or reject');
    if (runCallback) {
        assert.equal(settled, false, 'Application.start must await the run callback');
        director.emit('draw');
        assert.equal(reports, 0, 'Splash draw is not a home draw');
        if (fault === 'start-sync' || fault === 'start-async') {
            const main = await context.System.import('./game/main.js');
            main.start = () => {
                director.emit('scene'); director.emit('draw');
                if (fault === 'start-sync') throw new Error('INJECTED_SYNC_START_FAILURE');
                return Promise.reject(new Error('INJECTED_ASYNC_START_FAILURE'));
            };
        }
        runCallback();
        await new Promise(resolve => setImmediate(resolve));
        if (!fault?.startsWith('start-')) assert.equal(settled, false, 'Application.start must await main.start assets');
        releaseAsset();
    }
    if (fault) {
        await assert.rejects(waitForStartup(), error => error.message !== 'LOCAL_LIFECYCLE_TIMEOUT');
        await new Promise(resolve => setImmediate(resolve));
        director.emit('scene'); director.emit('draw'); context.__bilibili.reportLaunchSuccess();
        assert.equal(reports, 0);
        assert.equal(errors.length, 1);
        assert.equal(director.listenerCount('scene'), 0);
        assert.equal(director.listenerCount('draw'), 0);
        assert.ok(context.__runtimeError);
        assert.deepEqual(warnings, []);
        return { fault, errors };
    }
    await waitForStartup();
    assert.equal(reports, 0);
    director.emit('draw'); director.emit('draw'); director.emit('scene');
    context.__bilibili.reportLaunchSuccess();
    assert.equal(reports, 1);
    const probe = context.__runtimeProbe;
    for (const name of ['ready', 'classRegistered', 'imageLoaded', 'jsonLoaded', 'audioLoaded']) assert.equal(probe[name], true, name);
    assert.equal(probe.decoratedDefault, 7);
    assert.equal(probe.world3d, json('runtime.json').profile === '3d-basic');
    scene.getChildByName('Canvas').getChildByName('ClickTile').emit('touch-end');
    assert.equal(probe.score, 7);
    scene.getChildByName('Canvas').getChildByName('Instructions').emit('touch-end');
    assert.equal(probe.score, 0);
    assert.equal(probe.restarts, 1);
    assert.equal(probe.starts, 2);
    assert.equal(input.listenerCount('key-up'), 1);
    hostEvents.emit('Show', { scene: 'reentry' });
    assert.equal(context.__bilibili.lastShowOptions.scene, 'reentry');
    await context.__checkMissingAsset();
    assert.equal(probe.missingRejected, true);
    await assert.rejects(context.System.import('unmapped-local-negative'), /Unresolved|Unable to resolve/);
    await assert.rejects(context.System.import('./game/missing-local-negative.js'), /MISSING_RESOURCE|Error loading/);
    assert.equal(await context.System.import('./game/main.js'), await context.System.import('./game/main.js'));
    assert.equal(loaded.filter(file => file === 'game/main.js').length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    return { distinct, loaded, launchSuccessCount: reports, errors, probe: { ...probe },
        negativeGates: ['unknown-module', 'missing-module', 'missing-asset'] };
}

module.exports = { exerciseBilibili };
