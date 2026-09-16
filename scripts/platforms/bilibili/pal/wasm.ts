import { WASM_SUBPACKAGE } from 'internal:constants';
import { host } from './host';

declare const fsUtils: {
    readArrayBuffer(path: string, callback: (error: Error | null, data: ArrayBuffer) => void): void;
};

export async function fetchUrl (url: string): Promise<string> {
    if (/^[a-z]+:/i.test(url) || url.startsWith('/') || url.split('/').includes('..')) {
        throw new Error(`Invalid packaged binary path: ${url}`);
    }
    return `cocos-js/${url.replace(/^\.\//, '')}`;
}

export async function fetchBuffer (url: string): Promise<ArrayBuffer> {
    const path = await fetchUrl(url);
    return new Promise((resolve, reject) => {
        fsUtils.readArrayBuffer(path, (error, data) => { if (error) reject(error); else resolve(data); });
    });
}

export async function instantiateWasm (url: string, imports: WebAssembly.Imports): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
        throw new Error('WebAssembly is unavailable in this Bilibili host; build with ASM.js fallback.');
    }
    return WebAssembly.instantiate(await fetchBuffer(url), imports);
}

let ready: Promise<void> | undefined;
export function ensureWasmModuleReady (): Promise<void> {
    if (!WASM_SUBPACKAGE) return Promise.resolve();
    if (!ready) {
        ready = Promise.all(['__ccWasmAssetSubpkg__', '__ccWasmChunkSubpkg__'].map((name) => new Promise<void>((resolve, reject) => {
            if (!host.loadSubpackage) { reject(new Error('Bilibili host does not support subpackages.')); return; }
            host.loadSubpackage({ name, success: () => resolve(), fail: (error) => reject(error) });
        }))).then(() => undefined).catch((error) => { ready = undefined; throw error; });
    }
    return ready;
}
