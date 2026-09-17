import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const importMap = { imports: { cc: './cocos-js/cc.js' } };

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
        const directory = await mkdtemp(join(tmpdir(), 'cocos4-loader-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const packageRoot = join(directory, 'module-system');
        const dependencies = fileURLToPath(new URL('../node_modules', import.meta.url));
        // Relocate the unchanged tsconfig so engine ancestor @types are not implicit inputs.
        await cp(dirname(require.resolve('@cocos/module-system/package.json')), packageRoot, { recursive: true });
        await symlink(dependencies, join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const packageRequire = createRequire(join(packageRoot, 'package.json'));
        const subprocess = { cwd: directory, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 };
        await t.test('unchanged published loader sources pass strict Cocos TypeScript checking without engine inputs',
            { timeout: 65_000 }, async () => {
                const result = await execute(process.execPath, [
                    packageRequire.resolve('@cocos/typescript/bin/tsc'), '--noEmit', '--pretty', 'false',
                    '--project', join(packageRoot, 'lib/tsconfig.json'), '--listFiles',
                ], subprocess);
                assert.equal(result.stderr.trim(), '');
                const files = result.stdout.trim().split(/\r?\n/).map(file => resolve(file));
                assert.ok(files.includes(join(packageRoot, 'lib/globals.ts')));
                for (const file of files) {
                    assert.ok([directory, dependencies].some(root => {
                        const path = relative(root, file);
                        return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
                    }), `Compiler input outside the isolated layout: ${file}`);
                }
            });
        const loaders = {};
        for (const platform of ['web-desktop', 'bilibili']) {
            const out = join(directory, `${platform}.js`);
            const options = { out, platform, sourceMap: false, minify: false, hmr: false, editor: false };
            const script = `require(${JSON.stringify(packageRoot)})
                .build(${JSON.stringify(options)})
                .catch(error => { console.error(error); process.exitCode = 1; });`;
            const result = await execute(process.execPath, ['--eval', script], subprocess);
            // The published builder can emit despite TS diagnostics; treat those as failures.
            assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\bTS\d+\b/, `${platform} compiler diagnostics`);
            if (result.stdout.trim()) t.diagnostic(`${platform} build stdout: ${result.stdout.trim()}`);
            if (result.stderr.trim()) t.diagnostic(`${platform} build stderr: ${result.stderr.trim()}`);
            loaders[platform] = await readFile(out, 'utf8');
            assert.ok(loaders[platform].length > 0);
        }
        assert.notEqual(loaders['web-desktop'], loaders.bilibili);

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
