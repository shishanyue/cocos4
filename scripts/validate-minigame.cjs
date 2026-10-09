const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

// Resource bounds, not vendor package-size limits. Directories count as entries too.
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 32;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_BYTES = 32 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameStat = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

function validateMiniGame(directory, target) {
    if (target !== 'WECHAT' && target !== 'BYTEDANCE') throw new Error('Supported mini-game targets are exactly WECHAT and BYTEDANCE');
    if (typeof directory !== 'string' || !directory || directory.length > 4096 || directory.includes('\0')
        || directory.split(/[\\/]/).includes('..')) throw new Error('Unsafe mini-game directory path');
    const root = path.resolve(directory);
    let ancestor = path.parse(root).root;
    for (const part of root.slice(ancestor.length).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, part);
        const stat = fs.lstatSync(ancestor);
        if (stat.isSymbolicLink()) throw new Error('Symlink directory or ancestor is not allowed');
        if (!stat.isDirectory()) throw new Error('Expected a mini-game directory');
    }
    if (fs.realpathSync(root) !== root) throw new Error('Symlink directory or ancestor is not allowed');
    const records = new Map([['', fs.lstatSync(root)]]);
    const folded = new Set();
    let totalBytes = 0;

    function walk(dir, prefix = '', depth = 0) {
        if (depth > MAX_DEPTH) throw new Error(`Mini-game directory depth exceeds ${MAX_DEPTH}`);
        const handle = fs.opendirSync(dir);
        try {
            let entry;
            while ((entry = handle.readSync()) !== null) {
                const name = entry.name;
                const relative = prefix + name;
                if (records.size > MAX_ENTRIES) throw new Error(`Mini-game entry count exceeds ${MAX_ENTRIES}`);
                if (!name || name === '.' || name === '..' || /[\\:%<>"|?*\x00-\x1f\x7f]/.test(name)
                    || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
                    || Buffer.byteLength(relative) > 1024) throw new Error(`Unsafe output path: ${relative}`);
                const key = relative.normalize('NFC').toLowerCase();
                if (folded.has(key)) throw new Error(`Ambiguous output path: ${relative}`);
                folded.add(key);
                const filename = path.join(dir, name);
                const stat = fs.lstatSync(filename);
                if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${relative}`);
                records.set(relative, stat);
                if (stat.isDirectory()) walk(filename, `${relative}/`, depth + 1);
                else {
                    if (!stat.isFile()) throw new Error(`Expected a regular file: ${relative}`);
                    if (stat.nlink !== 1) throw new Error(`Hardlinks are not allowed: ${relative}`);
                    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || (totalBytes += stat.size) > MAX_TOTAL_BYTES) {
                        throw new Error('Mini-game source bytes exceed the 512 MiB validation limit');
                    }
                }
            }
        } finally { handle.closeSync(); }
    }
    walk(root);

    const required = ['game.js', 'game.json', 'project.config.json', 'application.js', 'web-adapter.js',
        'engine-adapter.js', 'fs-utils.js', 'loader.js', 'import-map.json', 'settings.json', 'cocos-js/cc.js', 'ENGINE-LICENSE',
        ...(target === 'WECHAT' ? ['WECHAT-ADAPTER-LICENSE'] : ['licenses/bytedance/package.json',
            'licenses/bytedance/README.md', 'licenses/bytedance/ENGINE-LICENSE', 'licenses/bytedance/NOTICE.txt'])];
    for (const file of required) {
        const stat = records.get(file);
        if (!stat?.isFile() || !stat.size) throw new Error(`Missing or empty required file: ${file}`);
    }

    function readJson(file, before) {
        const limit = ['game.json', 'project.config.json'].includes(file) ? MAX_CONFIG_BYTES : MAX_JSON_BYTES;
        if (before.size > limit) throw new Error(`JSON byte limit exceeded: ${file}`);
        const filename = path.join(root, file);
        if (fs.realpathSync(filename) !== filename) throw new Error(`Symlink path is not allowed: ${file}`);
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let bytes;
        try {
            if (!sameStat(before, fs.fstatSync(fd))) throw new Error(`Output changed during validation: ${file}`);
            // The extra byte detects growth without an unbounded readFile allocation.
            const buffer = Buffer.alloc(before.size + 1);
            let length = 0;
            while (length < buffer.length) {
                const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
                if (!count) break;
                length += count;
            }
            if (length !== before.size || !sameStat(before, fs.fstatSync(fd))) throw new Error(`Output changed during validation: ${file}`);
            bytes = buffer.subarray(0, length);
        } finally { fs.closeSync(fd); }
        let text;
        try {
            // Retain a BOM so JSON.parse rejects it instead of silently changing metadata.
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch { throw new Error(`Invalid UTF-8 JSON: ${file}`); }
        const stack = [];
        // Inspect tokens before parsing to bound nesting and detect keys JSON.parse discards.
        // Syntax is still checked by JSON.parse; strings shield embedded punctuation/numbers.
        for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
            const word = token[0];
            if (word === '{' || word === '[') {
                stack.push(word === '{' ? new Set() : null);
                if (stack.length > MAX_DEPTH) throw new Error(`JSON nesting depth exceeds ${MAX_DEPTH}: ${file}`);
            } else if (word === '}' || word === ']') stack.pop();
            else if (word.startsWith('"')) {
                let end = token.index + word.length;
                while (/[ \t\r\n]/.test(text[end] ?? '')) ++end;
                if (text[end] === ':') {
                    let key;
                    try { key = JSON.parse(word); } catch { throw new Error(`Invalid JSON: ${file}`); }
                    const keys = stack[stack.length - 1];
                    if (!keys || keys.has(key)) throw new Error(`Invalid or duplicate JSON key: ${file}`);
                    keys.add(key);
                }
            } else if (!Number.isFinite(Number(word))) throw new Error(`Non-finite JSON number: ${file}`);
        }
        try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${file}`); }
    }

    const configs = new Map();
    for (const [file, stat] of records) {
        if (!stat.isFile() || !/\.json$/i.test(file)) continue;
        const value = readJson(file, stat);
        if (['game.json', 'project.config.json', 'import-map.json', 'settings.json'].includes(file)) {
            if (!isObject(value)) throw new Error(`${file} must be an object`);
            configs.set(file, value);
        }
    }
    const game = configs.get('game.json');
    const project = configs.get('project.config.json');
    const prefix = target === 'WECHAT' ? 'wx' : 'tt';
    if (typeof project.appid !== 'string' || project.appid !== project.appid.trim() || project.appid.length > 128
        || !project.appid.startsWith(prefix) || !/^[A-Za-z0-9]+$/.test(project.appid.slice(2))) {
        throw new Error(`project.config.json requires a nonempty trimmed ${prefix}-prefixed appid`);
    }
    if (project.compileType !== undefined && project.compileType !== 'game') throw new Error('compileType must be game when present');
    for (const key of ['gameRoot', 'miniprogramRoot']) {
        if (project[key] !== undefined && !['', '.', './'].includes(project[key])) throw new Error(`${key} must refer to the game root`);
    }
    if (game.deviceOrientation !== undefined && !['portrait', 'landscape'].includes(game.deviceOrientation)) throw new Error('Invalid deviceOrientation');
    if (game.networkTimeout !== undefined) {
        if (!isObject(game.networkTimeout)) throw new Error('networkTimeout must be an object');
        for (const [key, value] of Object.entries(game.networkTimeout)) {
            if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid networkTimeout.${key}`);
        }
    }
    for (const [file, config] of [['game.json', game], ['project.config.json', project]]) {
        if (config.plugins !== undefined && (!isObject(config.plugins) || Object.keys(config.plugins).length)) {
            throw new Error(`${file}: plugins must be an empty object; plugin export is not implemented`);
        }
        for (const key of ['subpackages', 'subPackages']) {
            if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].length)) {
                throw new Error(`${file}: ${key} must be an empty array; subpackage export is not implemented`);
            }
        }
        for (const key of ['openDataContext', 'workers']) {
            if (config[key] !== undefined && config[key] !== '') throw new Error(`${file}: ${key} export is not implemented`);
        }
        for (const [key, value] of Object.entries(config)) {
            if (/^cloud/i.test(key) && value !== null && value !== false && value !== ''
                && !(Array.isArray(value) && !value.length) && !(isObject(value) && !Object.keys(value).length)) {
                throw new Error(`${file}: ${key} export is not implemented`);
            }
        }
    }

    // Detect ordinary concurrent edits; callers must provide a stable, private snapshot.
    for (const [file, before] of records) {
        const filename = path.join(root, file);
        if (!sameStat(before, fs.lstatSync(filename)) || fs.realpathSync(filename) !== filename) {
            throw new Error(`Output changed during validation: ${file || '.'}`);
        }
    }
    const warnings = [];
    if (totalBytes > 4 * 1024 * 1024) warnings.push('main: source files exceed 4 MiB; check the vendor-compiled package size.');
    if (totalBytes > 30 * 1024 * 1024) warnings.push('Source files exceed 30 MiB total; check the vendor-compiled package size.');
    // Count all source files, including maintainer metadata. Production payload policy,
    // bootstrap integrity, app authentication and vendor compilation belong to callers.
    return { target, appId: project.appid, packages: [{ name: 'main', root: '', bytes: totalBytes }], totalBytes, warnings };
}

module.exports = { validateMiniGame };
