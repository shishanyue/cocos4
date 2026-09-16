const fs = require('node:fs');
const path = require('node:path');

function validateBilibili(directory) {
    const root = fs.realpathSync(directory);
    const files = new Map();
    function walk(dir, prefix = '') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relative = prefix + entry.name;
            if (entry.isSymbolicLink()) throw new Error(`Bilibili output must not contain symlinks: ${relative}`);
            if (entry.isDirectory()) walk(path.join(dir, entry.name), `${relative}/`);
            else if (entry.isFile()) files.set(relative, fs.statSync(path.join(dir, entry.name)).size);
            else throw new Error(`Unexpected output file type: ${relative}`);
        }
    }
    walk(root);
    const mainFiles = ['game.js', 'game.json', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js'];
    for (const file of mainFiles) {
        if (!files.get(file)) throw new Error(`Missing or empty Bilibili output file: ${file}`);
    }
    const config = JSON.parse(fs.readFileSync(path.join(root, 'game.json'), 'utf8'));
    if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('game.json must be an object');
    for (const key of ['appId', 'version']) {
        if (typeof config[key] !== 'string' || !config[key].trim() || config[key] !== config[key].trim()) {
            throw new Error(`game.json requires a nonempty ${key}`);
        }
    }
    if (config.deviceOrientation !== undefined && !['portrait', 'landscape'].includes(config.deviceOrientation)) throw new Error('Invalid deviceOrientation');
    if (config.plugins && Object.keys(config.plugins).length) throw new Error('WeChat-style engine plugins are not supported on Bilibili');
    if (config.openDataContext) throw new Error('Bilibili open-data domain export is not implemented');
    for (const key of ['iOSHighPerformance', 'iOSHighPerformance+', 'androidHighPerformance', 'androidHighPerformance+']) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`Invalid ${key}`);
    }
    if (config.networkTimeout !== undefined) {
        if (!config.networkTimeout || Array.isArray(config.networkTimeout) || typeof config.networkTimeout !== 'object') throw new Error('networkTimeout must be an object');
        for (const key of ['request', 'connectSocket', 'uploadFile', 'downloadFile']) {
            const value = config.networkTimeout[key];
            if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`Invalid networkTimeout.${key}`);
        }
    }
    if (config.subpackages !== undefined && !Array.isArray(config.subpackages)) throw new Error('subpackages must be an array');
    const names = new Set();
    const roots = [];
    const allocated = new Set();
    const packages = [];
    for (const item of config.subpackages || []) {
        if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name !== item.name.trim() || names.has(item.name)) throw new Error('Invalid or duplicate subpackage name');
        if (typeof item.root !== 'string') throw new Error('Invalid subpackage root');
        const subroot = item.root.replace(/\/$/, '');
        if (!subroot || /[:\\]/.test(subroot) || subroot.startsWith('/') || subroot.split('/').some(part => !part || part === '.' || part === '..')) {
            throw new Error(`Unsafe subpackage root: ${item.root}`);
        }
        if (roots.some(parent => subroot === parent || subroot.startsWith(`${parent}/`))) throw new Error('Subpackages must be unique and ordered child before parent');
        const entry = subroot.endsWith('.js') ? subroot : `${subroot}/game.js`;
        if (!files.get(entry)) throw new Error(`Missing subpackage entry: ${entry}`);
        names.add(item.name);
        roots.push(subroot);
        let bytes = 0;
        for (const [file, size] of files) {
            if (!allocated.has(file) && (file === subroot || file.startsWith(`${subroot}/`))) { bytes += size; allocated.add(file); }
        }
        packages.push({ name: item.name, root: subroot, bytes });
    }
    if (mainFiles.some(file => allocated.has(file))) throw new Error('Main bootstrap files cannot belong to a subpackage');
    let mainBytes = 0;
    let totalBytes = 0;
    for (const [file, size] of files) {
        if (/\.wasm\.br$/i.test(file)) throw new Error(`Bilibili does not support WASM Brotli: ${file}`);
        if (/(?:^|\/)config(?:\.[\w-]+)?\.json$/.test(file)) {
            const bundle = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
            if (bundle?.isZip) throw new Error(`Export uncompressed Bilibili resource bundles: ${file}`);
        }
        totalBytes += size;
        if (!allocated.has(file)) mainBytes += size;
    }
    packages.unshift({ name: 'main', root: '', bytes: mainBytes });
    const warnings = packages.filter(item => item.bytes > 4 * 1024 * 1024).map(item => `${item.name}: source files exceed 4 MiB; check the vendor-compiled package size.`);
    if (totalBytes > 30 * 1024 * 1024) warnings.push('Source files exceed 30 MiB total; check the vendor-compiled package size.');
    return { appId: config.appId, version: config.version, packages, totalBytes, warnings };
}

module.exports = { validateBilibili };
if (require.main === module) {
    try {
        if (process.argv.length !== 3) throw new Error('Usage: validate-bilibili.cjs <complete-game-output>');
        console.log(JSON.stringify(validateBilibili(process.argv[2]), null, 2));
    } catch (error) { console.error(error); process.exitCode = 1; }
}
