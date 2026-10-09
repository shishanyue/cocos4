/* global tt, GameGlobal, System */
globalThis.__bytedanceRequire = require;
const entry = globalThis.__bytedance = {
    launchOptions: null, lastShowOptions: null, hidden: false, state: 'starting',
};

// The executor also captures synchronous host/config/adapter/loader failures.
entry.startup = new Promise((resolve) => {
    if (typeof tt === 'undefined' || typeof GameGlobal === 'undefined') throw new Error('BYTEDANCE_HOST_REQUIRED');
    entry.launchOptions = tt.getLaunchOptionsSync();
    tt.onShow((options) => { entry.lastShowOptions = options; entry.hidden = false; });
    tt.onHide(() => { entry.hidden = true; });
    GameGlobal.__bytedance = entry;
    GameGlobal.__bytedanceRequire = globalThis.__bytedanceRequire;
    entry.config = require('./game.json');

    // The published adapter writes to GameGlobal and assigns the pre-existing window binding.
    if (typeof globalThis.window === 'undefined') globalThis.window = GameGlobal;
    for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']) {
        if (typeof GameGlobal[name] === 'undefined') GameGlobal[name] = globalThis[name];
    }
    require('./web-adapter.js');
    const adapterGlobal = globalThis.window;
    if (adapterGlobal !== globalThis) {
        for (const name of ['document', 'canvas', 'screen', 'navigator', 'location', 'performance',
            'innerWidth', 'innerHeight', 'devicePixelRatio', 'XMLHttpRequest', 'WebSocket', 'Image', 'ImageBitmap',
            'Audio', 'FileReader', 'HTMLElement', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLMediaElement',
            'HTMLAudioElement', 'HTMLVideoElement', 'WebGLRenderingContext', 'TouchEvent', 'MouseEvent',
            'DeviceMotionEvent', 'localStorage', 'DOMParser', '__globalAdapter', 'WebAssembly', 'CCWebAssembly',
            'cc', 'ccwindow', 'CocosEngine', 'fsUtils']) {
            Object.defineProperty(globalThis, name, { configurable: true,
                get() { return adapterGlobal[name]; }, set(value) { adapterGlobal[name] = value; } });
        }
    }
    // Unlike the Bilibili adapter, the ByteDance bundle does not establish self.
    // The loader installs on self, then its extensions access the unqualified System binding.
    globalThis.self = GameGlobal;
    GameGlobal.self = GameGlobal;
    if (globalThis.self !== globalThis) {
        const loaderGlobal = globalThis.self;
        if (globalThis.System) loaderGlobal.System = globalThis.System;
        Object.defineProperty(globalThis, 'System', { configurable: true,
            get() { return loaderGlobal.System; }, set(value) { loaderGlobal.System = value; } });
    }
    require('./loader.js');

    // Preserve the Creator ByteDance template's iOS orientation and initial high-DPI sizing.
    const canvas = adapterGlobal.canvas;
    const screen = adapterGlobal.screen;
    if ((screen.width < screen.height && canvas.width > canvas.height)
        || (screen.width >= screen.height && canvas.width < canvas.height)) {
        const width = canvas.width;
        canvas.width = canvas.height;
        canvas.height = width;
    }
    if (adapterGlobal.devicePixelRatio >= 2) { canvas.width *= 2; canvas.height *= 2; }

    const importMapModule = require('./import-map.json');
    const importMap = importMapModule.default || importMapModule;
    if (importMap.imports.cc !== './cocos-js/cc.js') throw new Error('BYTEDANCE_ENGINE_ENTRY_REQUIRED');
    System.warmup({ importMap, importMapUrl: './import-map.json',
        defaultHandler: (url) => globalThis.__bytedanceRequire('.' + url),
        handlers: { 'project:': (url) => globalThis.__bytedanceRequire(url) },
    });
    resolve(System.import('./application.js').then(({ Application }) => {
        if (typeof Application !== 'function') throw new Error('APPLICATION_REQUIRED');
        const application = new Application();
        return System.import('cc').then((cc) => {
            // This adapter uses legacy window.cc, including internal APIs, not the module namespace.
            if (!adapterGlobal.cc || adapterGlobal.cc.game !== cc.game) throw new Error('BYTEDANCE_ENGINE_GLOBAL_REQUIRED');
            require('./engine-adapter.js');
            require('./fs-utils.js');
            return application.init(cc);
        }).then(() => application.start());
    }).then(() => { entry.state = 'started'; }));
});
entry.startup.catch((error) => {
    entry.state = 'failed';
    entry.error = error;
    globalThis.__runtimeError = String(error && error.stack || error);
    console.error('[BYTEDANCE] Game startup failed:', error);
});
