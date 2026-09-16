'use strict';

const host = bl;
const root = typeof GameGlobal === 'object' ? GameGlobal : globalThis;
const fsUtils = require('./fs-utils');

class EventTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback, options) {
        if (!callback) return;
        let listeners = this.listeners.get(type);
        if (!listeners) this.listeners.set(type, listeners = new Map());
        if (!listeners.has(callback)) listeners.set(callback, !!(options && options.once));
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) {
        event.target = event.target || this;
        event.currentTarget = this;
        event.preventDefault = event.preventDefault || function () {};
        event.stopPropagation = event.stopPropagation || function () {};
        for (const [callback, once] of [...(this.listeners.get(event.type) || [])]) {
            if (once) this.removeEventListener(event.type, callback);
            if (typeof callback === 'function') callback.call(this, event);
            else callback.handleEvent(event);
        }
        this[`on${event.type}`]?.(event);
        return true;
    }
}

class Element extends EventTarget {
    constructor(tagName) {
        super();
        this.tagName = tagName.toUpperCase();
        this.style = {};
        this.children = [];
        this.parentNode = null;
    }
    appendChild(child) { child.parentNode?.removeChild(child); this.children.push(child); child.parentNode = this; return child; }
    removeChild(child) { const i = this.children.indexOf(child); if (i !== -1) this.children.splice(i, 1); child.parentNode = null; return child; }
    contains(child) { return child === this || this.children.some(item => item === child || item.contains?.(child)); }
    setAttribute(key, value) { this[key] = String(value); }
    getAttribute(key) { return this[key] ?? null; }
    getBoundingClientRect() {
        return { top: 0, left: 0, width: root.innerWidth, height: root.innerHeight, right: root.innerWidth, bottom: root.innerHeight };
    }
    get clientWidth() { return root.innerWidth; }
    get clientHeight() { return root.innerHeight; }
}

const canvases = new WeakSet();
const images = new WeakSet();
function createCanvas() {
    const canvas = host.createCanvas();
    const element = new Element('canvas');
    canvas.style = canvas.style || {};
    for (const method of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'getBoundingClientRect']) {
        if (!canvas[method]) canvas[method] = element[method].bind(element);
    }
    canvases.add(canvas);
    return canvas;
}

function Image() {
    const image = host.createImage();
    const events = new EventTarget();
    image.addEventListener = (type, cb, options) => events.addEventListener(type, cb, options);
    image.removeEventListener = (type, cb) => events.removeEventListener(type, cb);
    image.onload = () => events.dispatchEvent({ type: 'load', target: image });
    image.onerror = reason => events.dispatchEvent({ type: 'error', target: image, error: reason });
    images.add(image);
    return image;
}
class HTMLImageElement { static [Symbol.hasInstance](value) { return images.has(value); } }
class HTMLCanvasElement { static [Symbol.hasInstance](value) { return canvases.has(value); } }

class XMLHttpRequest extends EventTarget {
    constructor() {
        super();
        this.readyState = 0;
        this.status = 0;
        this.response = null;
        this.responseText = '';
        this.responseType = '';
        this.timeout = 0;
        this.headers = {};
        this.responseHeaders = {};
        this.generation = 0;
        this.pending = false;
    }
    open(method, url, async = true) {
        if (!async) throw new Error('Synchronous XMLHttpRequest is not supported on Bilibili.');
        this.abort();
        this.method = method;
        this.url = url;
        this.headers = {};
        this.responseHeaders = {};
        this.status = 0;
        this.response = null;
        this.responseText = '';
        this.changeState(1);
    }
    changeState(state) { this.readyState = state; this.dispatchEvent({ type: 'readystatechange' }); }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader(name) {
        const key = Object.keys(this.responseHeaders).find(key => key.toLowerCase() === name.toLowerCase());
        return key ? String(this.responseHeaders[key]) : null;
    }
    getAllResponseHeaders() { return Object.entries(this.responseHeaders).map(([key, value]) => `${key}: ${value}`).join('\r\n'); }
    send(data) {
        if (this.readyState !== 1 || this.pending) throw new Error('XMLHttpRequest is not OPENED.');
        const generation = ++this.generation;
        this.pending = true;
        this.dispatchEvent({ type: 'loadstart' });
        const fail = reason => {
            if (generation !== this.generation || !this.pending) return;
            this.pending = false;
            this.status = 0;
            this.changeState(4);
            const err = fsUtils.error(reason);
            this.dispatchEvent({ type: /timeout/i.test(err.message) ? 'timeout' : 'error', error: err });
            this.dispatchEvent({ type: 'loadend' });
        };
        const success = result => {
            if (generation !== this.generation || !this.pending) return;
            let response;
            try {
                response = this.responseType === 'json' && typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
            } catch (reason) { fail(reason); return; }
            this.status = result.statusCode;
            this.responseHeaders = result.header || {};
            this.changeState(2);
            if (generation !== this.generation) return;
            this.changeState(3);
            if (generation !== this.generation) return;
            this.response = response;
            this.responseText = typeof result.data === 'string' ? result.data : '';
            this.pending = false;
            this.changeState(4);
            if (generation !== this.generation) return;
            this.dispatchEvent({ type: 'load' });
            this.dispatchEvent({ type: 'loadend' });
        };
        try {
            if (/^https?:\/\//i.test(this.url)) {
                this.task = host.request({ url: this.url, method: this.method, data, header: this.headers, timeout: this.timeout || undefined,
                    responseType: this.responseType === 'arraybuffer' ? 'arraybuffer' : 'text', dataType: 'text', success, fail });
            } else {
                if (this.method.toUpperCase() !== 'GET') throw new Error('Packaged resources only support GET.');
                const read = this.responseType === 'arraybuffer' ? fsUtils.readArrayBuffer : this.responseType === 'json' ? fsUtils.readJson : fsUtils.readText;
                read(this.url, (err, value) => err ? fail(err) : success({ statusCode: 200, data: value }));
            }
        } catch (reason) { fail(reason); }
    }
    abort() {
        const pending = this.pending;
        ++this.generation;
        this.pending = false;
        this.task?.abort();
        this.task = null;
        if (pending) {
            this.status = 0;
            this.changeState(4);
            this.dispatchEvent({ type: 'abort' });
            this.dispatchEvent({ type: 'loadend' });
        }
        this.readyState = 0;
    }
}
for (const [name, value] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) {
    XMLHttpRequest[name] = XMLHttpRequest.prototype[name] = value;
}

class WebSocket extends EventTarget {
    constructor(url, protocols = []) {
        super();
        this.url = url;
        this.readyState = 0;
        this.binaryType = 'arraybuffer';
        this.task = host.connectSocket({ url, protocols: typeof protocols === 'string' ? [protocols] : protocols });
        this.task.onOpen(result => { this.readyState = 1; this.dispatchEvent({ type: 'open', ...result }); });
        this.task.onMessage(result => this.dispatchEvent({ type: 'message', data: result.data }));
        this.task.onError(reason => this.dispatchEvent({ type: 'error', error: fsUtils.error(reason) }));
        this.task.onClose(result => { this.readyState = 3; this.dispatchEvent({ type: 'close', ...result }); });
    }
    send(data) {
        if (this.readyState !== 1) throw new Error('WebSocket is not OPEN.');
        this.task.send({ data, fail: reason => this.dispatchEvent({ type: 'error', error: fsUtils.error(reason) }) });
    }
    close(code = 1000, reason = '') { this.readyState = 2; this.task.close({ code, reason }); }
}
for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    WebSocket[name] = WebSocket.prototype[name] = value;
}

const canvas = createCanvas();
canvas.id = 'GameCanvas';
const document = new Element('document');
document.documentElement = new Element('html');
document.body = new Element('body');
document.head = new Element('head');
document.documentElement.appendChild(document.head);
document.documentElement.appendChild(document.body);
document.body.appendChild(canvas);
document.createElement = tag => tag.toLowerCase() === 'canvas' ? createCanvas() : tag.toLowerCase() === 'img' ? new Image() : new Element(tag);
document.getElementById = id => id === canvas.id ? canvas : null;
document.getElementsByTagName = tag => tag === 'canvas' ? [canvas] : tag === 'body' ? [document.body] : tag === 'head' ? [document.head] : [];
document.querySelector = selector => selector === '#GameCanvas' || selector === 'canvas' ? canvas : null;
document.readyState = 'complete';
document.hidden = false;

const windowEvents = new EventTarget();
const localStorage = {
    get length() { return host.getStorageInfoSync().keys.length; },
    key(index) { return host.getStorageInfoSync().keys[index] ?? null; },
    getItem(key) { key = String(key); return host.getStorageInfoSync().keys.includes(key) ? String(host.getStorageSync(key)) : null; },
    setItem(key, value) { host.setStorageSync(String(key), String(value)); },
    removeItem(key) { host.removeStorageSync(String(key)); },
    clear() { host.clearStorageSync(); },
};

const globals = {
    window: root, self: root, document, canvas, Image, HTMLImageElement, HTMLCanvasElement,
    HTMLElement: Element, Element, XMLHttpRequest, WebSocket, localStorage, fsUtils,
    navigator: { userAgent: 'Cocos4 Bilibili MiniGame', platform: host.getSystemInfoSync().platform, language: host.getSystemInfoSync().language || 'en' },
    location: { href: 'game.js', protocol: 'game:', pathname: 'game.js' },
    performance: root.performance || globalThis.performance || { now: () => Date.now() },
    requestAnimationFrame: (root.requestAnimationFrame || globalThis.requestAnimationFrame).bind(root),
    cancelAnimationFrame: (root.cancelAnimationFrame || globalThis.cancelAnimationFrame).bind(root),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
    getComputedStyle: element => element.style,
};
Object.assign(root, globals);
if (root !== globalThis) Object.assign(globalThis, globals);

function resize() {
    const info = host.getSystemInfoSync();
    const dimensions = { innerWidth: info.windowWidth ?? info.screenWidth, innerHeight: info.windowHeight ?? info.screenHeight,
        devicePixelRatio: info.pixelRatio || info.devicePixelRatio || 1, screen: { width: info.screenWidth, height: info.screenHeight } };
    Object.assign(root, dimensions);
    if (root !== globalThis) Object.assign(globalThis, dimensions);
    windowEvents.dispatchEvent({ type: 'resize' });
}
resize();
canvas.width = root.innerWidth * root.devicePixelRatio;
canvas.height = root.innerHeight * root.devicePixelRatio;
host.onWindowResize?.(resize);
host.onHide(() => { document.hidden = true; document.dispatchEvent({ type: 'visibilitychange' }); });
host.onShow(() => { document.hidden = false; document.dispatchEvent({ type: 'visibilitychange' }); });

module.exports = { EventTarget, canvas };
