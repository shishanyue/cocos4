import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const { prepareLoader } = require('../runtime/prepare-loader.cjs');
const { inventory, sha256 } = require('../runtime/files.cjs');
const importMap = { imports: { cc: './cocos-js/cc.js' } };
// Retained HTML5/BILIBILI 2D/3D runtime and SDK loader artifacts, built with these options.
const loaderHashes = {
    'web-desktop': '5d1a25de07cc11276a6b1d6479cac7f12c0c561dd06941b8339e568c9d94f900',
    bilibili: 'f1bf370e6df5bf58763175b5135fc999c0b09e9a1b75f42e19eb37678c84c157',
};
const releaseLoaderHashes = {
    'web-desktop': '531803df1e9d4b632e01367aebfa5fb39af4d90db7a54de34da08093d529c16a',
    bilibili: '4cb96ea27aec89e9082927a56fd55c4429f326f69e94a79a9582da048972c2a9',
};

// Plain module fixtures, not an engine bundle or rendering acceptance test.
const modules = new Map([
    ['./cocos-js/cc.js', `System.register([], function (exports) {
        return { execute() { exports('answer', 40); } };
    });`],
    ['./game/relative.js', `System.register([], function (exports) {
        return { execute() { exports('offset', 2); } };
    });`],
    ['./game/lazy.js', `System.register(['cc', './relative.js'], function (exports) {
        let cc, relative;
        return {
            setters: [value => cc = value, value => relative = value],
            execute() { exports('answer', cc.answer + relative.offset); },
        };
    });`],
    ['./game/main.js', `System.register(['cc', './relative.js'], function (exports, context) {
        let cc, relative;
        return {
            setters: [value => cc = value, value => relative = value],
            execute() {
                exports('answer', cc.answer + relative.offset);
                exports('url', context.meta.url);
                exports('load', () => context.import('./lazy.js'));
                exports('loadMissing', () => context.import('./missing.js'));
            },
        };
    });`],
]);

function evaluate(source, context, filename) {
    return vm.runInContext(source, context, { filename, timeout: 1000 });
}

function fixtureLoader(context, loaded) {
    return (name) => {
        const source = modules.get(name);
        if (source === undefined) throw new Error(`Missing fixture: ${name}`);
        loaded.push(name);
        // Called only by the real loader's instantiate hook, never to preload registrations.
        evaluate(source, context, name);
        return {};
    };
}

async function verifyModules(system, base, loaded) {
    assert.equal((await system.import('cc')).answer, 40);
    const [main, cached] = await Promise.all([
        system.import('./game/main.js'), system.import('./game/main.js'),
    ]);
    assert.equal(main, cached);
    assert.equal(main.answer, 42);
    assert.equal(main.url, `${base}game/main.js`);
    assert.equal(loaded.includes('./game/lazy.js'), false);
    assert.equal((await main.load()).answer, 42);
    assert.deepEqual([...loaded].sort(), [...modules.keys()].sort());
    await assert.rejects(system.import('unmapped'), /Unresolved id|Unable to resolve bare specifier/);
    await assert.rejects(system.import('./game/missing.js'), /Missing fixture|Error loading .*missing\.js/);
    await assert.rejects(main.loadMissing(), /Missing fixture|Error loading .*missing\.js/);
}

test('published Cocos 0.0.21 loaders: isolated VM module probes, not browser/rendering acceptance',
    { timeout: 210_000 }, async (t) => {
        assert.equal(require('@cocos/module-system/package.json').version, '0.0.21');
        // Keep all preparation in the checkout, including when TMPDIR is unset.
        const temporaryRoot = fileURLToPath(new URL('../build/test-tmp', import.meta.url));
        await mkdir(temporaryRoot, { recursive: true });
        const directory = await mkdtemp(join(temporaryRoot, 'cocos4-loader-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const hostileTypes = join(directory, 'node_modules/@types/loader-ancestor');
        await mkdir(hostileTypes, { recursive: true });
        await writeFile(join(hostileTypes, 'index.d.ts'), 'declare const System: "hostile ancestor";\n');
        const work = join(directory, 'work');
        await mkdir(work);
        const publishedRoot = dirname(require.resolve('@cocos/module-system/package.json'));
        const publishedFiles = await inventory(publishedRoot);
        const packageRoot = await prepareLoader(work);
        const dependencies = fileURLToPath(new URL('../node_modules', import.meta.url));
        const configPath = join(packageRoot, 'lib/tsconfig.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        const publishedConfig = JSON.parse(await readFile(join(publishedRoot, 'lib/tsconfig.json'), 'utf8'));
        assert.deepEqual(config, { ...publishedConfig, compilerOptions: {
            ...publishedConfig.compilerOptions, typeRoots: ['../../node_modules/@types'],
        } });
        assert.equal(await readFile(join(packageRoot, 'dist/build.js'), 'utf8'),
            (await readFile(join(publishedRoot, 'dist/build.js'), 'utf8'))
                .replace('(0, rollup_plugin_terser_1.terser)({})', '(0, rollup_plugin_terser_1.terser)({ numWorkers: 1 })'));
        const packageRequire = createRequire(join(packageRoot, 'package.json'));
        const subprocess = { cwd: work, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 };
        await t.test('strict loader type closure retains local Node/DOM and excludes hostile and engine ancestor types',
            { timeout: 65_000 }, async () => {
                const result = await execute(process.execPath, [
                    packageRequire.resolve('@cocos/typescript/bin/tsc'), '--noEmit', '--pretty', 'false',
                    '--project', configPath, '--listFiles',
                ], subprocess);
                assert.equal(result.stderr.trim(), '');
                const files = await Promise.all(result.stdout.trim().split(/\r?\n/).map(file => realpath(resolve(work, file))));
                assert.ok(files.includes(join(packageRoot, 'lib/globals.ts')));
                assert.ok(files.includes(packageRequire.resolve('@cocos/typescript/lib/lib.dom.d.ts')));
                for (const name of ['node', 'estree', 'resolve']) {
                    assert.ok(files.some(file => file.startsWith(join(dependencies, '@types', name) + sep)), `Missing local @types/${name}`);
                }
                for (const file of files) {
                    assert.ok([packageRoot, dependencies].some(root => {
                        const path = relative(root, file);
                        return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
                    }), `Compiler input outside the isolated layout: ${file}`);
                }
            });
        const loaders = {};
        for (const platform of ['web-desktop', 'bilibili']) {
            const out = join(directory, `${platform}.js`);
            const options = { out, platform, sourceMap: false, minify: false, hmr: false, editor: false };
            const stage = fileURLToPath(new URL('../runtime/build-stage.cjs', import.meta.url));
            const result = await execute(process.execPath, [stage, 'loader', JSON.stringify({ loader: packageRoot, buildOptions: options })], subprocess);
            // The published builder can emit despite TS diagnostics; treat those as failures.
            assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\bTS\d+\b/, `${platform} compiler diagnostics`);
            if (result.stdout.trim()) t.diagnostic(`${platform} build stdout: ${result.stdout.trim()}`);
            if (result.stderr.trim()) t.diagnostic(`${platform} build stderr: ${result.stderr.trim()}`);
            loaders[platform] = await readFile(out, 'utf8');
            assert.equal(sha256(loaders[platform]), loaderHashes[platform], `${platform} retained loader bytes`);
            const releaseOut = join(directory, `${platform}-release.js`);
            const release = await execute(process.execPath, [stage, 'loader', JSON.stringify({ loader: packageRoot,
                buildOptions: { ...options, out: releaseOut, minify: true } })], subprocess);
            assert.doesNotMatch(`${release.stdout}\n${release.stderr}`, /\bTS\d+\b/);
            const releaseSource = await readFile(releaseOut, 'utf8');
            assert.equal(sha256(releaseSource), releaseLoaderHashes[platform], `${platform} separately minified loader`);
            assert(releaseSource.length < loaders[platform].length);
            assert.doesNotMatch(releaseSource, /sourceMappingURL|sourcesContent/);
        }
        assert.notEqual(loaders['web-desktop'], loaders.bilibili);
        const sourceFiles = files => files.filter(file => !['lib/tsconfig.json', 'dist/build.js'].includes(file.path));
        assert.deepEqual(sourceFiles(await inventory(packageRoot)), sourceFiles(publishedFiles), 'Copied loader sources changed');
        assert.deepEqual(await inventory(publishedRoot), publishedFiles, 'Installed loader package changed');

        for (const distinct of [false, true]) {
            const contract = distinct ? 'distinct GameGlobal with explicit System forwarding' : 'shared host global';
            await t.test(`BILIBILI warmup: ${contract}; cc, relative/dynamic imports, cache and rejection`,
                { timeout: 5000 }, async () => {
                    const context = vm.createContext({ console });
                    evaluate(`globalThis.GameGlobal = ${distinct ? '{}' : 'globalThis'};
                        globalThis.self = GameGlobal; globalThis.window = GameGlobal;`, context, 'host.js');
                    assert.equal(evaluate('GameGlobal !== globalThis', context, 'host-identity.js'), distinct);
                    if (distinct) {
                        // Required host contract, not a fake System or an automatic adapter fix.
                        evaluate(`Object.defineProperty(globalThis, 'System', {
                            get() { return GameGlobal.System; },
                            set(value) { GameGlobal.System = value; },
                        });`, context, 'explicit-system-bridge.js');
                    }
                    evaluate(loaders.bilibili, context, 'bilibili-loader.js');
                    const system = context.System;
                    assert.equal(system, context.GameGlobal.System);
                    assert.equal(typeof system.warmup, 'function');
                    const loaded = [];
                    const hostRequire = fixtureLoader(context, loaded);
                    system.warmup({
                        importMap, importMapUrl: './import-map.json',
                        defaultHandler: url => hostRequire('.' + url),
                        handlers: { 'project:': url => hostRequire(url) },
                    });
                    assert.equal(system.resolve('cc'), 'no-schema:/cocos-js/cc.js');
                    await verifyModules(system, 'no-schema:/', loaded);
                });
        }

        await t.test('upstream limitation: distinct self/GameGlobal without global System forwarding throws',
            { timeout: 5000 }, () => {
                const context = vm.createContext({ console, GameGlobal: {} });
                evaluate('globalThis.self = GameGlobal; globalThis.window = GameGlobal;', context, 'host.js');
                assert.throws(() => evaluate(loaders.bilibili, context, 'bilibili-loader.js'), {
                    name: 'ReferenceError', message: 'System is not defined',
                });
                assert.equal(context.System, undefined);
                assert.equal(typeof context.GameGlobal.System.import, 'function');
                assert.equal(context.GameGlobal.System.warmup, undefined);
            });

        await t.test('web-desktop: external import map and script events in a VM document harness; no warmup',
            { timeout: 5000 }, async () => {
                const origin = 'https://loader.invalid';
                const context = vm.createContext({ console, location: { origin, href: `${origin}/index.html` } });
                evaluate('globalThis.self = globalThis; globalThis.window = globalThis;', context, 'host.js');
                const loaded = [];
                const load = fixtureLoader(context, loaded);
                const windowEvents = new Map();
                context.addEventListener = (name, callback) => windowEvents.set(name, callback);
                let mapRequests = 0;
                context.fetch = async (url) => {
                    assert.equal(url, `${origin}/import-map.json`);
                    ++mapRequests;
                    return { ok: true, text: async () => JSON.stringify(importMap) };
                };
                const scripts = [{ type: 'systemjs-importmap', src: `${origin}/import-map.json` }];
                context.document = {
                    readyState: 'complete',
                    querySelector(selector) { assert.equal(selector, 'base[href]'); return null; },
                    querySelectorAll(selector) { assert.equal(selector, 'script'); return scripts; },
                    createElement(tag) {
                        assert.equal(tag, 'script');
                        return { events: new Map(), addEventListener(name, callback) { this.events.set(name, callback); } };
                    },
                    head: {
                        appendChild(script) {
                            scripts.push(script);
                            queueMicrotask(() => {
                                try {
                                    assert.equal(new URL(script.src).origin, origin);
                                    load('.' + new URL(script.src).pathname);
                                } catch (error) {
                                    script.events.get('error')({ error });
                                    return;
                                }
                                script.events.get('load')();
                            });
                        },
                        removeChild(script) {
                            const index = scripts.indexOf(script);
                            assert.notEqual(index, -1);
                            scripts.splice(index, 1);
                        },
                    },
                };
                evaluate(loaders['web-desktop'], context, 'web-loader.js');
                assert.equal(typeof context.System.import, 'function');
                assert.equal(context.System.warmup, undefined);
                await verifyModules(context.System, `${origin}/`, loaded);
                assert.equal(mapRequests, 1);
                assert.equal(windowEvents.has('DOMContentLoaded'), true);
            });
    });
