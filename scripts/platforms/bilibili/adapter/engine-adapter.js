'use strict';

const files = require('./fs-utils');
const adapted = new WeakSet();

module.exports = function adaptEngine(cc) {
    if (adapted.has(cc)) return;
    adapted.add(cc);
    const { downloader } = cc.assetManager;

    function read(reader) {
        return (url, options, complete) => files.resolveFile(url, options, (error, local) => {
            if (error) { complete(error); return; }
            reader(local, (error, data) => {
                if (error) files.invalidate(url);
                complete(error, data);
            }, options);
        });
    }
    const text = read(files.readText);
    const json = read(files.readJson);
    const binary = read(files.readArrayBuffer);
    function script(url, options, complete) {
        try {
            globalThis.__bilibiliRequire(`./${files.packagePath(url)}`);
            complete(null);
        } catch (error) { complete(error); }
    }
    const image = read((url, complete) => downloader.downloadDomImage(url, {}, complete));
    const font = read((url, complete) => {
        try {
            const family = bl.loadFont(url);
            complete(family ? null : new Error(`Failed to load font: ${url}`), family);
        } catch (error) { complete(error); }
    });

    const handlers = { '.js': script, '.json': json, '.ExportJson': json, default: text };
    for (const ext of ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'image', 'ico', 'tiff']) handlers[`.${ext}`] = image;
    for (const ext of ['bin', 'binary', 'dbbin', 'skel', 'pvr', 'pkm', 'astc']) handlers[`.${ext}`] = binary;
    for (const ext of ['font', 'ttf', 'ttc', 'woff', 'eot']) handlers[`.${ext}`] = font;
    for (const ext of ['mp3', 'ogg', 'wav', 'm4a']) {
        // AudioPlayer is private to PAL; preserve the engine's registered loader and metadata contract.
        const loadAudio = downloader._downloaders?.[`.${ext}`];
        handlers[`.${ext}`] = read((url, complete, options) => {
            if (!loadAudio) { complete(new Error('The audio engine feature is not included.')); return; }
            loadAudio(url, options, complete);
        });
    }
    // Replace web-specific handlers as well as the default text handler.
    for (const ext of ['txt', 'xml', 'vsh', 'fsh', 'atlas', 'tmx', 'tsx', 'plist', 'fnt', 'svg']) handlers[`.${ext}`] = text;

    handlers.bundle = (nameOrUrl, options, complete) => {
        const name = nameOrUrl.replace(/\/$/, '').split('/').pop();
        const version = options.version || downloader.bundleVers[name];
        const suffix = version ? `${version}.` : '';
        const subpackage = globalThis.__bilibiliConfig?.subpackages?.find(item => item.name === name);
        let base;
        let js;
        if (subpackage) {
            if (subpackage.root.endsWith('.js')) { complete(new Error('Asset bundles require directory subpackages.')); return; }
            base = subpackage.root.replace(/\/$/, '');
        } else if (/^https?:\/\//i.test(nameOrUrl)) {
            base = nameOrUrl.replace(/\/$/, '');
            js = `src/bundle-scripts/${name}/index.${suffix}js`;
        } else if (downloader.remoteBundles.includes(name)) {
            base = `${downloader.remoteServerAddress}remote/${name}`;
            js = `src/bundle-scripts/${name}/index.${suffix}js`;
        } else {
            base = `assets/${name}`;
            js = `${base}/index.${suffix}js`;
        }
        const loadConfig = () => json(`${base}/config.${suffix}json`, options, (error, data) => {
            if (error) { complete(error); return; }
            if (!data || typeof data !== 'object') { complete(new Error(`Invalid bundle configuration: ${name}`)); return; }
            if (data.isZip) { complete(new Error('Bilibili zipped bundles are not supported; export an uncompressed resource bundle.')); return; }
            complete(null, { ...data, base: `${base}/` });
        });
        if (subpackage) files.loadSubpackage(name, options.onFileProgress, error => error ? complete(error) : loadConfig());
        else script(js, options, error => error ? complete(error) : loadConfig());
    };
    downloader.register(handlers);
    downloader.downloadScript = script;
    downloader._downloadJson = json;
    downloader._downloadArrayBuffer = binary;

    if (cc.EditBox) {
        let active;
        cc.EditBox._EditBoxImpl = class BilibiliEditBox extends cc.EditBox._EditBoxImpl {
            init(delegate) { this._delegate = delegate; }
            beginEditing() {
                if (this._editing || !this._delegate) return;
                const required = ['showKeyboard', 'hideKeyboard', 'onKeyboardInput', 'offKeyboardInput', 'onKeyboardConfirm', 'offKeyboardConfirm', 'onKeyboardComplete', 'offKeyboardComplete'];
                if (required.some(name => typeof bl[name] !== 'function')) throw new Error('Bilibili host does not support the keyboard API.');
                active?.endEditing();
                active = this;
                this._editing = true;
                this.input = result => this._delegate?._editBoxTextChanged(result.value);
                this.confirm = result => this._delegate?._editBoxEditingReturn(result.value);
                this.complete = result => { if (result?.value !== undefined) this.input(result); this.endEditing(); };
                bl.onKeyboardInput(this.input);
                bl.onKeyboardConfirm(this.confirm);
                bl.onKeyboardComplete(this.complete);
                this._delegate._editBoxEditingDidBegan();
                bl.showKeyboard({ defaultValue: this._delegate.string, maxLength: this._delegate.maxLength < 0 ? 65535 : this._delegate.maxLength,
                    multiple: this._delegate.inputMode === cc.EditBox.InputMode.ANY, confirmHold: false,
                    confirmType: ['done', 'done', 'send', 'search', 'go', 'next'][this._delegate.returnType] || 'done',
                    fail: reason => { console.warn('[BILIBILI] Keyboard failed:', reason); this.endEditing(); } });
            }
            endEditing() {
                if (!this._editing) return;
                this._editing = false;
                if (active === this) active = undefined;
                bl.offKeyboardInput(this.input);
                bl.offKeyboardConfirm(this.confirm);
                bl.offKeyboardComplete(this.complete);
                bl.hideKeyboard({});
                this._delegate?._editBoxEditingDidEnded();
            }
            clear() { this.endEditing(); super.clear(); }
        };
    }
};
