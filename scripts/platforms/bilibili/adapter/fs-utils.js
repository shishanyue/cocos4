'use strict';

const host = bl;
const fs = host.getFileSystemManager();
const cacheRoot = `${host.env.USER_DATA_PATH}/cocos4-cache`;
const cached = new Map();
let serial = 0;

function error(reason) {
    return reason instanceof Error ? reason : new Error(reason && reason.errMsg || String(reason));
}

function packagePath(url) {
    const value = url.replace(/^\.\//, '');
    if (!value || /[:\\]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid package path: ${url}`);
    }
    return value;
}

function readJsonSync(url) {
    try {
        // Packaged JSON is compiled by the vendor tool; user files remain ordinary files.
        if (!url.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            return JSON.parse(JSON.stringify(globalThis.__bilibiliRequire(`./${packagePath(url)}`)));
        }
        return JSON.parse(fs.readFileSync(url, 'utf8'));
    } catch (reason) { return error(reason); }
}

function readFile(url, encoding, callback) {
    try {
        fs.readFile({ filePath: url, encoding, success: result => callback(null, result.data), fail: reason => callback(error(reason)) });
    } catch (reason) { callback(error(reason)); }
}

function saveIndex() {
    try { fs.writeFileSync(`${cacheRoot}/index`, JSON.stringify([...cached]), 'utf8'); } catch (reason) {
        // A cache quota/write failure must not prevent using an already downloaded asset.
        console.warn('[BILIBILI] Could not persist asset cache:', reason);
    }
}

function invalidate(url) {
    const file = cached.get(url);
    if (!file) return;
    cached.delete(url);
    try { fs.unlink({ filePath: file, fail() {} }); } catch (reason) { /* Cache removal is best effort. */ }
    saveIndex();
}

function downloadFile(url, filePath, header, onProgress, callback) {
    try {
        const task = host.downloadFile({
            url, filePath: filePath || undefined, header,
            success(result) {
                if (result.statusCode < 200 || result.statusCode >= 300) {
                    callback(new Error(`Download failed (${result.statusCode}): ${url}`));
                } else if (!result.tempFilePath && !result.filePath) {
                    callback(new Error(`Download returned no file: ${url}`));
                } else callback(null, result.filePath || result.tempFilePath);
            },
            fail: reason => callback(error(reason)),
        });
        if (onProgress && task && task.onProgressUpdate) task.onProgressUpdate(onProgress);
        return task;
    } catch (reason) { callback(error(reason)); }
}

function resolveFile(url, options, callback) {
    if (!/^https?:\/\//i.test(url)) { callback(null, url); return; }
    const download = () => downloadFile(url, null, options.header, options.onFileProgress, (err, temp) => {
        if (err || options.cacheEnabled !== true) { callback(err, temp); return; }
        try { fs.mkdirSync(cacheRoot, true); } catch (reason) { /* Already exists, or caching is unavailable. */ }
        const extension = /\.[a-z0-9]+$/i.exec(url.split(/[?#]/)[0]);
        const dest = `${cacheRoot}/${Date.now()}-${serial++}${extension ? extension[0] : '.bin'}`;
        try {
            fs.copyFile({
                srcPath: temp, destPath: dest,
                success() {
                    invalidate(url);
                    // Bound the number of persistent files; quota errors fall back to the temp file.
                    if (cached.size >= 100) invalidate(cached.keys().next().value);
                    cached.set(url, dest);
                    saveIndex();
                    callback(null, dest);
                },
                fail: () => callback(null, temp),
            });
        } catch (reason) { callback(null, temp); }
    });
    if (options.reload) invalidate(url);
    const file = cached.get(url);
    if (!file) { download(); return; }
    try {
        fs.access({ path: file, success: () => callback(null, file), fail() { invalidate(url); download(); } });
    } catch (reason) { invalidate(url); download(); }
}

try {
    const index = JSON.parse(fs.readFileSync(`${cacheRoot}/index`, 'utf8'));
    if (Array.isArray(index)) {
        for (const entry of index.slice(-100)) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
                && entry[1].startsWith(`${cacheRoot}/`) && /^[\w.-]+$/.test(entry[1].slice(cacheRoot.length + 1))) {
                cached.set(entry[0], entry[1]);
            }
        }
    }
} catch (reason) { /* An absent or corrupt index is an empty cache. */ }

module.exports = {
    fs, error, packagePath, resolveFile, invalidate, downloadFile, readJsonSync,
    getUserDataPath: () => host.env.USER_DATA_PATH,
    readText: (url, cb) => readFile(url, 'utf8', cb),
    readArrayBuffer: (url, cb) => readFile(url, undefined, cb),
    readJson(url, callback) {
        const result = readJsonSync(url);
        callback(result instanceof Error ? result : null, result instanceof Error ? undefined : result);
    },
    loadSubpackage(name, onProgress, callback) {
        if (!host.loadSubpackage) { callback(new Error('Bilibili host does not support subpackages.')); return; }
        try {
            const task = host.loadSubpackage({ name, success: () => callback(null), fail: reason => callback(error(reason)) });
            if (onProgress && task && task.onProgressUpdate) task.onProgressUpdate(onProgress);
        } catch (reason) { callback(error(reason)); }
    },
};
