#!/usr/bin/env node
// HTML5 packaging only: this does not build a NATIVE/JSB engine or change the SDK.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { androidProjectFiles } from './templates.mjs';
import { moduleReferences } from './module-references.mjs';

export const ASSET_ORIGIN = 'https://appassets.androidplatform.net';
const RECEIPT = 'cocos4-android-export.json';
const INJECTED = 'cocos4-shell-config.js';
const MAX_FILES = 100000;
const MAX_BYTES = 2 * 1024 ** 3;
const identifier = /^[A-Za-z_$][\w$]{0,127}$/;
const javaKeywords = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null'.split(' '));
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), { code }); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function relativeAssetPath(value) {
    if (typeof value !== 'string' || !value || value.length > 768 || value.includes('\\')
        || /[\x00-\x1f<>:"|?*%#]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..'
            || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
        fail('ASSET_PATH_INVALID', `Unsafe relative asset path: ${String(value)}`);
    }
    return value;
}

export function validateConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONFIG_INVALID', 'Expected a JSON object.');
    const defaults = { entry: 'index.html', appName: 'Cocos4 Game', versionCode: 1, versionName: '1.0.0',
        orientation: 'sensorLandscape', minSdk: 26, targetSdk: 35, compileSdk: 35, backendUrl: '', allowCleartext: false,
        dynamicBackend: false, hostingMode: 'connect-only' };
    const allowed = new Set([...Object.keys(defaults), 'appId', 'configGlobal']);
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail('CONFIG_INVALID', `Unknown config field: ${key}`);
    const config = { ...defaults, ...value };
    if (typeof config.appId !== 'string' || config.appId.length > 150 || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(config.appId)
        || config.appId.split('.').some(part => javaKeywords.has(part))) fail('CONFIG_INVALID', 'appId must be a valid lowercase Java/Android package, such as org.example.game.');
    for (const key of ['appName', 'versionName']) if (typeof config[key] !== 'string' || !config[key].trim()
        || config[key].length > 100 || /[\x00-\x1f\x7f]/.test(config[key])) fail('CONFIG_INVALID', `${key} must be a short printable string.`);
    relativeAssetPath(config.entry);
    if (!/\.html?$/i.test(config.entry)) fail('CONFIG_INVALID', 'entry must be an HTML file.');
    if (!['sensorLandscape', 'sensorPortrait', 'fullSensor'].includes(config.orientation)) fail('CONFIG_INVALID', 'orientation must be sensorLandscape, sensorPortrait or fullSensor.');
    if (!Number.isInteger(config.versionCode) || config.versionCode < 1 || config.versionCode > 2100000000) fail('CONFIG_INVALID', 'versionCode must be an integer in 1..2100000000.');
    for (const key of ['minSdk', 'targetSdk']) if (!Number.isInteger(config[key]) || config[key] < 26 || config[key] > 35) fail('CONFIG_INVALID', `${key} must be an integer in 26..35 for the pinned Android toolchain.`);
    if (config.compileSdk !== 35) fail('CONFIG_INVALID', 'compileSdk is pinned to 35 for the Gradle project.');
    if (config.minSdk > config.targetSdk || config.targetSdk > config.compileSdk) fail('CONFIG_INVALID', 'Require minSdk <= targetSdk <= compileSdk.');
    if (typeof config.allowCleartext !== 'boolean') fail('CONFIG_INVALID', 'allowCleartext must be boolean.');
    if (typeof config.dynamicBackend !== 'boolean') fail('CONFIG_INVALID', 'dynamicBackend must be boolean.');
    if (!['connect-only', 'lan-host'].includes(config.hostingMode)) fail('CONFIG_INVALID', 'hostingMode must be connect-only or lan-host.');
    if (config.hostingMode === 'lan-host' && !config.allowCleartext) fail('HOSTING_CLEARTEXT_REQUIRED', 'lan-host requires allowCleartext:true for the local HTTP/ws listener.');
    // A lan-host APK always owns a runtime-managed local backend: the game page saves
    // http://127.0.0.1:<port> through /__cocos4/backend and reloads, so the shell must serve the
    // persisted endpoint on every reload. connect-only keeps the caller's explicit choice.
    if (config.hostingMode === 'lan-host') config.dynamicBackend = true;
    if (config.configGlobal !== undefined && (typeof config.configGlobal !== 'string' || !identifier.test(config.configGlobal)
        || ['__proto__', 'constructor', 'prototype', 'location', 'document', 'window', 'globalThis', '__COCOS4_ANDROID__'].includes(config.configGlobal))) fail('CONFIG_INVALID', 'configGlobal must name a dedicated JavaScript config global.');
    if (typeof config.backendUrl !== 'string' || config.backendUrl.length > 2048) fail('CONFIG_INVALID', 'backendUrl must be an HTTP(S) URL or empty.');
    if (config.backendUrl) {
        let url;
        try { url = new URL(config.backendUrl); } catch { fail('CONFIG_INVALID', 'backendUrl is not an absolute URL.'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search
            || url.origin === ASSET_ORIGIN || /[\s<>"'\\?#]/.test(config.backendUrl)) fail('CONFIG_INVALID', 'backendUrl must be a credential-free HTTP(S) origin/path, without query or fragment.');
        if (url.protocol === 'http:' && !config.allowCleartext) fail('CLEARTEXT_REQUIRES_OPT_IN', 'HTTP backend requires allowCleartext:true; use HTTPS for deployment.');
        config.backendUrl = url.href.replace(/\/$/, '');
        if (config.backendUrl.length > 2048) fail('CONFIG_INVALID', 'The encoded backendUrl must not exceed 2048 characters.');
    } else if (config.allowCleartext && !config.dynamicBackend) fail('CONFIG_INVALID', 'allowCleartext requires an explicit HTTP backend.');
    if (config.allowCleartext && !config.dynamicBackend && config.backendUrl && !config.backendUrl.startsWith('http:')) fail('CONFIG_INVALID', 'allowCleartext is only valid for an HTTP backend.');
    return config;
}

export function injectConfig(html) {
    if (html.includes(INJECTED)) fail('CONFIG_COLLISION', `${INJECTED} already occurs in the HTML entry.`);
    // An external synchronous script runs before either classic or module game code.
    const tag = `<script src="/${INJECTED}"></script>`;
    const head = /<head\b[^>]*>/i.exec(html);
    if (head) return html.slice(0, head.index + head[0].length) + '\n' + tag + html.slice(head.index + head[0].length);
    const doc = /^\s*<!doctype[^>]*>/i.exec(html);
    const offset = doc ? doc[0].length : 0;
    return html.slice(0, offset) + '\n' + tag + '\n' + html.slice(offset);
}

function configScript(config) {
    const shell = { schemaVersion: 1, backendUrl: config.backendUrl, assetOrigin: ASSET_ORIGIN, platform: 'android-webview',
        hostingMode: config.hostingMode,
        ...(config.allowCleartext ? { allowCleartext: true } : {}),
        ...(config.dynamicBackend ? { dynamicBackend: true, defaultBackendUrl: config.backendUrl } : {}),
        ...(config.hostingMode === 'lan-host' ? { localHosting: { enabled: true, controlBase: '/__cocos4/host', state: 'stopped', backendUrl: '', wsUrl: '', lanUrls: [] } } : {}) };
    let source = `'use strict';\nglobalThis.__COCOS4_ANDROID__ = Object.freeze(${JSON.stringify(shell)});\n`;
    if (config.configGlobal) {
        const target = `globalThis[${JSON.stringify(config.configGlobal)}]`;
        source += `${target} = Object.assign({}, ${target}, {backendUrl: ${JSON.stringify(config.backendUrl)}});\n`;
    }
    return source;
}

async function requireAbsent(filename) {
    try { await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    fail('OUTPUT_EXISTS', `Refusing to replace ${filename}. Choose a new output directory.`);
}
async function publishOutput(staging, output) {
    // Windows scanners can briefly retain handles to a freshly written tree.
    // Keep publication atomic and never replace an output that appeared meanwhile.
    for (let attempt = 0; ; attempt++) {
        await requireAbsent(output);
        try { await fs.rename(staging, output); return; }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
            await delay(50 * (attempt + 1));
        }
    }
}
function absolute(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('PATH_INVALID', 'Input and output paths must be absolute.');
    return path.resolve(value);
}
function within(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function canonicalDirectory(value) {
    const result = absolute(value);
    const stat = await fs.lstat(result);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PATH_INVALID', `Directory is not an ordinary directory: ${result}`);
    const real = await fs.realpath(result);
    if (path.relative(real, result) !== '') fail('PATH_INVALID', `Directory aliases are unsupported: ${result}`);
    return real;
}
async function fileHash(filename) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}
async function scan(directory) {
    const records = [];
    const lower = new Set();
    let bytes = 0;
    async function visit(prefix) {
        for (const entry of (await fs.readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
            const relative = relativeAssetPath(prefix + entry.name);
            const key = relative.toLowerCase();
            if (lower.has(key)) fail('ASSET_COLLISION', `Case-insensitive duplicate: ${relative}`);
            lower.add(key);
            if (entry.name === '.git' || entry.name === 'node_modules' || /^\.env(?:\.|$)/i.test(entry.name)) fail('NOT_STATIC_OUTPUT', `Export a static client closure, not a source/secret directory: ${relative}`);
            const filename = path.join(directory, relative);
            const stat = await fs.lstat(filename);
            if (stat.isSymbolicLink()) fail('ASSET_LINK', `Links are not copied: ${relative}`);
            if (stat.isDirectory()) { await visit(relative + '/'); continue; }
            if (!stat.isFile()) fail('ASSET_TYPE', `Only ordinary files are supported: ${relative}`);
            bytes += stat.size;
            if (records.length >= MAX_FILES || bytes > MAX_BYTES) fail('ASSET_BUDGET', 'Static output exceeds 100000 files or 2 GiB.');
            records.push({ path: relative, bytes: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
    await visit('');
    return records;
}

// Check literal HTML/CSS/module references. Computed game URLs need browser/device tests.
export async function validateStaticReferences(root, entries) {
    const available = new Set(entries.map(item => item.path));
    let checked = 0;
    const external = new Set();
    for (const item of entries) {
        if (!/\.(?:html?|css|m?js)$/i.test(item.path) || item.bytes > 16 * 1024 ** 2) continue;
        const source = await fs.readFile(path.join(root, item.path), 'utf8');
        const refs = [];
        const addModules = text => {
            for (const ref of moduleReferences(text)) {
                // Bare module names may be resolved by a local import map.
                if (ref.startsWith('.') || ref.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) refs.push(ref);
            }
        };
        if (/\.html?$/i.test(item.path)) {
            const html = source.replace(/<!--[\s\S]*?-->/g, '');
            for (const tag of html.matchAll(/<(?:script|link|img|source|video|audio)\b[^>]*>/gi)) {
                const match = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/i.exec(tag[0]);
                if (match) refs.push(match[2]);
            }
            for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
                if (/\bsrc\s*=/i.test(script[1])) continue;
                const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(script[1]);
                const language = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().toLowerCase();
                if (['', 'module', 'text/javascript', 'application/javascript'].includes(language)) addModules(script[2]);
            }
        } else if (/\.css$/i.test(item.path)) {
            // Consume a complete quoted URL, including SVG data strings containing their own url(...).
            for (const match of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)'";]+))\s*\)|@import\s+["']([^"']+)["']/g)) refs.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
        } else {
            addModules(source);
        }
        for (const ref of refs) {
            if (!ref || /^(?:data:|blob:|#)/i.test(ref)) continue;
            let url;
            try { url = new URL(ref.replace(/&amp;/g, '&'), `${ASSET_ORIGIN}/${item.path}`); }
            catch { fail('ASSET_REFERENCE_INVALID', `Invalid reference in ${item.path}: ${ref}`); }
            if (url.origin !== ASSET_ORIGIN) { external.add(url.href); continue; }
            let name;
            try { name = decodeURIComponent(url.pathname.slice(1)); }
            catch { fail('ASSET_REFERENCE_INVALID', `Malformed URL escape in ${item.path}: ${ref}`); }
            if (!available.has(name)) fail('ASSET_REFERENCE_MISSING', `${item.path} references missing local asset ${name || '/'}.`);
            checked++;
        }
    }
    return { checked, external: [...external].sort(), limitation: 'Literal HTML/CSS/ES module references only; computed asset URLs need browser/device verification.' };
}

export async function exportAndroid({ input, output, config: raw, hostingDir }) {
    const config = validateConfig(raw);
    if (config.hostingMode === 'lan-host' && !hostingDir) fail('HOSTING_ADAPTER_REQUIRED', 'lan-host requires --hosting-dir pointing at the browser-compatible adapter.');
    if (config.hostingMode === 'connect-only' && hostingDir) fail('HOSTING_ADAPTER_UNEXPECTED', 'connect-only rejects --hosting-dir so no hosting code or backend files are packaged.');
    input = await canonicalDirectory(input);
    output = absolute(output);
    const parent = await canonicalDirectory(path.dirname(output));
    if (within(input, output) || within(output, input)) fail('PATH_OVERLAP', 'Input and output must be disjoint directories.');
    await requireAbsent(output);
    const source = await scan(input);
    if (!source.some(item => item.path === config.entry)) fail('ENTRY_MISSING', `HTML entry does not exist: ${config.entry}`);
    if (source.some(item => item.path.toLowerCase() === INJECTED)) fail('CONFIG_COLLISION', `${INJECTED} is reserved for the shell.`);
    if (source.some(item => item.path.toLowerCase().startsWith('__cocos4_host/'))) fail('HOSTING_COLLISION', 'The client closure must not contain __cocos4_host/.');
    const references = await validateStaticReferences(input, source);
    if (references.external.length) fail('EXTERNAL_ASSETS', `Static assets must be local before APK export: ${references.external.slice(0, 10).join(', ')}`);
    let hosting = null;
    if (hostingDir) {
        hostingDir = await canonicalDirectory(hostingDir);
        if ([input, output].some(root => within(root, hostingDir) || within(hostingDir, root))) fail('PATH_OVERLAP', 'Hosting adapter must be disjoint from the client and output.');
        hosting = await scan(hostingDir);
        for (const item of hosting) {
            if (/\.(?:apk|a|o|so|dex|class|jar|map)$/i.test(item.path)) fail('HOSTING_ASSET_INVALID', `Hosting adapter contains a native/build/source-map file: ${item.path}`);
        }
        if (!hosting.some(item => item.path === 'index.html')) fail('HOSTING_ENTRY_MISSING', 'Hosting adapter must contain index.html at its root.');
    }
    const staging = await fs.mkdtemp(path.join(parent, '.cocos4-android-'));
    const files = [];
    const write = async (name, bytes) => {
        const filename = path.join(staging, name);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, bytes, { flag: 'wx' });
        files.push({ path: name, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) });
    };
    try {
        for (const [name, bytes] of androidProjectFiles(config)) await write(relativeAssetPath(name), bytes);
        for (const item of source) {
            const name = `app/src/main/assets/www/${item.path}`;
            const filename = path.join(staging, name);
            await fs.mkdir(path.dirname(filename), { recursive: true });
            const original = path.join(input, item.path);
            if (item.path === config.entry) await write(name, injectConfig(await fs.readFile(original, 'utf8')));
            else {
                await fs.copyFile(original, filename, 1);
                files.push({ path: name, bytes: item.bytes, sha256: await fileHash(filename) });
            }
            const after = await fs.lstat(original);
            if (after.isSymbolicLink() || after.size !== item.bytes || after.mtimeMs !== item.mtimeMs) fail('INPUT_CHANGED', `Source changed during export: ${item.path}`);
        }
        if (hosting) {
            for (const item of hosting) {
                const name = `app/src/main/assets/www/__cocos4_host/${item.path}`;
                const filename = path.join(staging, name);
                await fs.mkdir(path.dirname(filename), { recursive: true });
                const original = path.join(hostingDir, item.path);
                await fs.copyFile(original, filename, 1);
                files.push({ path: name, bytes: item.bytes, sha256: await fileHash(filename) });
                const after = await fs.lstat(original);
                if (after.isSymbolicLink() || after.size !== item.bytes || after.mtimeMs !== item.mtimeMs) fail('INPUT_CHANGED', `Hosting adapter changed during export: ${item.path}`);
            }
        }
        await write(`app/src/main/assets/www/${INJECTED}`, configScript(config));
        const receipt = { schemaVersion: 1, kind: 'cocos4-android-webview-project', engineTarget: 'HTML5',
            native: false, jsb: false, assetOrigin: ASSET_ORIGIN, config, hosting: hosting ? {
                mode: 'lan-host', adapter: { entry: '__cocos4_host/index.html', files: hosting.map(item => item.path).sort(),
                    bytes: hosting.reduce((sum, item) => sum + item.bytes, 0) },
                bridge: { java: 'Cocos4Host', adapter: '__COCOS4_HOST_ADAPTER__', controlBase: '/__cocos4/host' },
            } : { mode: 'connect-only' },
            toolchain: { gradle: '8.9', agp: '8.7.3', java: '17..23', buildTools: '35.0.0' },
            source: { input, files: source.length, bytes: source.reduce((sum, item) => sum + item.bytes, 0) }, references,
            files: files.sort((a, b) => compare(a.path, b.path)), verification: { projectGenerated: true, apkBuilt: false, deviceTested: false } };
        await fs.writeFile(path.join(staging, RECEIPT), json(receipt), { flag: 'wx' });
        await publishOutput(staging, output);
        return { success: true, output, receipt: path.join(output, RECEIPT), ...receipt.verification,
            hostingMode: config.hostingMode, hostingAdapter: receipt.hosting.adapter ?? null,
            fileCount: files.length, assetBytes: receipt.source.bytes };
    } catch (error) {
        if (!within(parent, staging) || path.dirname(staging) !== parent || !path.basename(staging).startsWith('.cocos4-android-')) throw error;
        await fs.rm(staging, { recursive: true, force: true });
        throw error;
    }
}

export async function verifyAndroidProject(project) {
    project = await canonicalDirectory(project);
    const receipt = JSON.parse(await fs.readFile(path.join(project, RECEIPT), 'utf8'));
    if (receipt.kind !== 'cocos4-android-webview-project' || receipt.schemaVersion !== 1 || !Array.isArray(receipt.files)) fail('PROJECT_INVALID', 'Unsupported project receipt.');
    validateConfig(receipt.config);
    const hostingMode = receipt.config.hostingMode;
    const hasHostAssets = receipt.files.some(item => item.path.startsWith('app/src/main/assets/www/__cocos4_host/'));
    const hasHostJava = receipt.files.some(item => item.path.endsWith('/HostRuntime.java'))
        && receipt.files.some(item => item.path.endsWith('/HostWebSocket.java'));
    if (hostingMode === 'lan-host') {
        if (!hasHostAssets || !hasHostJava || receipt.hosting?.mode !== 'lan-host') fail('PROJECT_INVALID', 'lan-host project is missing its adapter or host Java transport.');
    } else if (hasHostAssets || hasHostJava || (receipt.hosting && receipt.hosting.mode !== 'connect-only')) {
        fail('PROJECT_INVALID', 'connect-only project contains hosting code or backend assets.');
    }
    for (const item of receipt.files) {
        const filename = path.join(project, relativeAssetPath(item.path));
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || await fileHash(filename) !== item.sha256) fail('PROJECT_CHANGED', `Exported file changed: ${item.path}`);
    }
    return { success: true, project, fileCount: receipt.files.length, config: receipt.config };
}

export function parseFlags(args, allowed) {
    const flags = {};
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        if (!allowed.includes(key) || Object.hasOwn(flags, key) || !args[index + 1] || args[index + 1].startsWith('--')) fail('ARGUMENT_INVALID', `Unknown, duplicate or incomplete option: ${key}`);
        flags[key] = args[index + 1];
    }
    return flags;
}

async function main(args) {
    if (!args.length || args[0] === '--help') {
        console.log('Cocos4 HTML5 → Android WebView project\nnode export-apk.mjs --input ABS_STATIC_DIR --output ABS_NEW_DIR --config ABS_JSON [--hosting-dir ABS_ADAPTER]\nnode export-apk.mjs verify --project ABS_DIR\nnode toolchain.mjs doctor|build --project ABS_DIR --sdk ABS_SDK --java-home ABS_JDK --gradle-home ABS_GRADLE --work ABS_DIR\nExisting output is never replaced. No SDK/package downloads, signing credentials or NATIVE/JSB compilation.\nDefault hostingMode connect-only omits host code; lan-host requires --hosting-dir with a browser-compatible adapter.');
        return;
    }
    if (args[0] === 'verify') {
        const flags = parseFlags(args.slice(1), ['--project']);
        console.log(json(await verifyAndroidProject(flags['--project'])));
        return;
    }
    const flags = parseFlags(args, ['--input', '--output', '--config', '--hosting-dir']);
    const config = JSON.parse(await fs.readFile(absolute(flags['--config']), 'utf8'));
    console.log(json(await exportAndroid({ input: flags['--input'], output: flags['--output'], config, hostingDir: flags['--hosting-dir'] })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => { console.error(json({ success: false, code: error.code ?? 'EXPORT_FAILED', message: error.message })); process.exitCode = 1; });
}




