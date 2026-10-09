/* global wx, GameGlobal, System */
'use strict';

globalThis.__wechatRequire = require;
// The pinned WeChat PAL also uses this contract for separate engine modules.
globalThis.__wxRequire = require;
const entry = globalThis.__wechat = {
    launchOptions: null, lastShowOptions: null, lastHideOptions: null,
    hidden: false, phase: 'created', error: null,
};

entry.startup = new Promise((resolve) => {
    if (typeof wx === 'undefined' || !wx) throw new Error('WECHAT_HOST_REQUIRED: wx is not available');
    if (typeof GameGlobal !== 'object' || !GameGlobal) throw new Error('WECHAT_GAMEGLOBAL_REQUIRED');
    entry.launchOptions = wx.getLaunchOptionsSync();
    wx.onShow((options) => { entry.lastShowOptions = options; entry.hidden = false; });
    wx.onHide((options) => { entry.lastHideOptions = options; entry.hidden = true; });
    entry.config = globalThis.__wechatRequire('./game.json');
    // Match the WeChat template: Android screen dimensions settle on the next host frame.
    if (wx.getSystemInfoSync().platform.toLowerCase() === 'android') {
        entry.phase = 'waiting-for-frame';
        GameGlobal.requestAnimationFrame(() => resolve());
    } else resolve();
}).then(async () => {
    entry.phase = 'loading';
    if (typeof window === 'undefined') globalThis.window = GameGlobal;
    require('./web-adapter.js');
    require('./fs-utils.js');

    // Devices use GameGlobal; WeChat DevTools can retain their existing window instead.
    const adapterGlobal = globalThis.window;
    if (adapterGlobal !== globalThis) {
        for (const name of [...Object.keys(adapterGlobal), 'cc']) {
            if (['System', 'self', 'window'].includes(name) || (name in globalThis && name !== 'cc')) continue;
            Object.defineProperty(globalThis, name, { configurable: true, enumerable: true,
                get() { return adapterGlobal[name]; }, set(value) { adapterGlobal[name] = value; } });
        }
    }
    if (typeof self === 'undefined') globalThis.self = GameGlobal;
    // SystemJS installs on self; its extensions use the free System binding during evaluation.
    const loaderGlobal = globalThis.self;
    for (const root of new Set([globalThis, GameGlobal])) {
        if (root === loaderGlobal) continue;
        if (Object.getOwnPropertyDescriptor(root, 'System')?.configurable === false) {
            throw new Error('WECHAT_SYSTEM_BINDING_NOT_CONFIGURABLE');
        }
        if (root.System && loaderGlobal.System && root.System !== loaderGlobal.System) throw new Error('WECHAT_SYSTEM_CONFLICT');
        if (root.System) loaderGlobal.System = root.System;
        Object.defineProperty(root, 'System', { configurable: true,
            get() { return loaderGlobal.System; }, set(value) { loaderGlobal.System = value; } });
    }

    const info = wx.getSystemInfoSync();
    // pixelRatio is the wx field; do not overwrite DevTools' read-only devicePixelRatio.
    adapterGlobal.canvas.width = info.screenWidth * info.pixelRatio;
    adapterGlobal.canvas.height = info.screenHeight * info.pixelRatio;
    require('./loader.js');
    const importMap = globalThis.__wechatRequire('./import-map.json');
    System.warmup({ importMap, importMapUrl: './import-map.json',
        defaultHandler: url => globalThis.__wechatRequire('.' + url),
        handlers: { 'project:': url => globalThis.__wechatRequire(url) } });

    const { Application } = await System.import('./application.js');
    const application = entry.application = new Application();
    const cc = await System.import('cc');
    // Do not replace cclegacy with the public module namespace: the adapter needs its internals.
    if (!cc.cclegacy || globalThis.cc !== cc.cclegacy) throw new Error('WECHAT_ENGINE_GLOBAL_REQUIRED');
    require('./engine-adapter.js');
    entry.phase = 'initializing';
    await application.init(cc);
    entry.phase = 'starting';
    await application.start();
    entry.phase = 'running';
});
// Observe, but do not replace or swallow the original rejecting startup Promise.
entry.startup.catch((error) => {
    entry.phase = 'failed';
    entry.error = error;
    globalThis.__runtimeError = String(error?.stack ?? error);
    console.error('[WECHAT] Game startup failed:', error);
});
