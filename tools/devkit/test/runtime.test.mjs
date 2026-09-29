import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const engine = fileURLToPath(new URL('../../..', import.meta.url));
const runtime = fileURLToPath(new URL('../runtime', import.meta.url));
const { buildRuntime } = require('../scripts/build-runtime.cjs');
const { readBuiltins } = require('../runtime/builtins.cjs');
const { compileGame } = require('../runtime/compile-game.cjs');
const { compilerDependencies, compilerRoots } = require('../runtime/compiler-dependencies.cjs');
const { assertAbsent, inventory, readRegular, sha256 } = require('../runtime/files.cjs');

async function temporary(t) {
    const root = resolve(process.env.TMPDIR ?? join(runtime, 'build'));
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'cocos4-runtime-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('buildRuntime rejects unknown profiles and existing outputs before building', async t => {
    const directory = await temporary(t);
    await assert.rejects(buildRuntime({ profile: 'native', builtinDirectory: directory, outDirectory: join(directory, 'out') }), /PROFILE_NOT_AVAILABLE/);
    await assert.rejects(buildRuntime({ profile: '2d-basic', builtinDirectory: directory, outDirectory: directory }), /OUTPUT_CONFLICT/);
    await assert.rejects(buildRuntime({ profile: '2d-basic', builtinDirectory: directory, outDirectory: join(directory, 'out') }), /ENOENT/);
    assert.deepEqual(await readdir(directory), []);
});

test('runtime inventory rejects traversal, symlinks, empty output, and output conflicts', async t => {
    const directory = await temporary(t);
    await writeFile(join(directory, 'valid'), 'value');
    assert.deepEqual(await inventory(directory), [{ path: 'valid', bytes: 5, sha256: sha256('value') }]);
    for (const name of ['../valid', '/valid', 'a\\b', 'a:b', './valid', 'a//valid']) {
        await assert.rejects(readRegular(directory, name), /Unsafe path/);
    }
    await symlink(join(directory, 'valid'), join(directory, 'link'));
    await assert.rejects(inventory(directory), /Symlink not allowed/);
    await assert.rejects(assertAbsent(join(directory, 'link')), /OUTPUT_CONFLICT/);
    await rm(join(directory, 'link'));
    await symlink(directory, join(directory, 'root-link'));
    await assert.rejects(inventory(join(directory, 'root-link')), /Symlink directory/);
    await assert.rejects(inventory(directory, '../'), /Unsafe path/);
    await rm(join(directory, 'root-link'));
    await writeFile(join(directory, 'empty'), '');
    await assert.rejects(inventory(directory), /Empty output/);
});

test('compiler dependency closure resolves exact installed versions, peers, and lock integrity', async () => {
    const closure = await compilerDependencies(engine);
    assert.deepEqual(Object.keys(closure.roots), compilerRoots);
    assert.ok(closure.packages.length > 20);
    const paths = new Set(closure.packages.map(pkg => pkg.path));
    for (const pkg of closure.packages) {
        assert.ok(pkg.integrity.startsWith('sha512-') || pkg.integrity.startsWith('sha1-'));
        for (const dependency of Object.values(pkg.dependencies)) assert.ok(paths.has(dependency));
    }
    assert.equal(closure.packages.find(pkg => pkg.name === 'typescript').version, '4.9.5');
});

test('compiler rejects unsupported module closures and collisions without emitting', async t => {
    const directory = await temporary(t);
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2017"}}');
    const compile = () => compileGame({ projectDirectory: directory, typesDirectory: join(directory, 'absent-types'), outDirectory: join(directory, 'out') });
    for (const [source, message] of [
        ["import 'untrusted-package';", /Unsupported import/],
        ["import './missing.js';", /outside source closure/],
        ["import('./dynamic.js');", /Dynamic imports/],
        ["import * as cc from 'cc';", /named cc imports/],
        ["export * from 'cc';", /named cc exports/],
        ["import { cclegacy as cc } from 'cc'; export const value = cc['MeshRenderer'];", /cclegacy bypasses/],
        ["export { cclegacy as cc } from 'cc';", /cclegacy bypasses/],
        ["export const value = (import.meta as any).import('cc');", /import.meta/],
        ['// @ts-ignore\nexport const value: number = "wrong";', /@ts-ignore/],
        ['// @ts-expect-error\nexport const value: number = "wrong";', /@ts-expect-error/],
    ]) {
        await writeFile(join(directory, 'src/main.ts'), source);
        await assert.rejects(compile(), message);
        await assertAbsent(join(directory, 'out'));
    }
    await writeFile(join(directory, 'src/main.js'), 'export const value = 1;');
    await assert.rejects(compile(), /Colliding TS\/JS/);
});

test('compiler option and filesystem failures always carry structured diagnostics', async t => {
    const directory = await temporary(t);
    for (const options of [null, [], 1, {}, { projectDirectory: directory, typesDirectory: directory, checkOnly: 'true' },
        { projectDirectory: directory, typesDirectory: directory, checkOnly: true }]) {
        await assert.rejects(compileGame(options), error => {
            assert.equal(error.code, 'UNSUPPORTED_PROJECT');
            assert.ok(error.diagnostics.length > 0);
            for (const diagnostic of error.diagnostics) {
                assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'column', 'file', 'line', 'message', 'severity']);
                assert.equal(diagnostic.severity, 'error');
                assert.equal(diagnostic.file, null);
            }
            return true;
        });
    }
});

test('compiler rejects config-based filesystem discovery before reading declaration inputs', async t => {
    const directory = await temporary(t);
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src/main.ts'), 'export const value = 1;');
    for (const config of [
        { extends: '../outside.json' }, { references: [{ path: '../outside' }] },
        { files: ['../outside.ts'] }, { include: ['../**/*.ts'] }, { exclude: ['src/main.ts'] },
        { compilerOptions: null },
        ...[
            { typeRoots: ['../outside'] }, { types: ['../outside'] }, { rootDirs: ['../outside'] },
            { paths: { cc: ['../outside.d.ts'] } }, { paths: { secret: ['../outside.d.ts'] } },
            { baseUrl: '../outside' }, { plugins: [{ name: '../outside.cjs' }] },
            { skipLibCheck: true }, { noCheck: true }, { strict: false }, { lib: ['../../outside'] },
        ].map(compilerOptions => ({ compilerOptions })),
    ]) {
        await writeFile(join(directory, 'tsconfig.json'), JSON.stringify(config));
        await assert.rejects(compileGame({ projectDirectory: directory, typesDirectory: join(directory, 'absent-types'), checkOnly: true }),
            error => error.code === 'UNSUPPORTED_PROJECT' && Array.isArray(error.diagnostics));
        assert.deepEqual((await readdir(directory)).sort(), ['src', 'tsconfig.json']);
    }
});

test('copied SDK compiler: no checkout reads, check-only, structured diagnostics and real fixture transforms',
    { skip: !process.env.RUNTIME_COMPILER_FIXTURES, timeout: 240000 }, async t => {
        const fixtureRoot = resolve(process.env.RUNTIME_COMPILER_FIXTURES);
        const directory = await temporary(t);
        const maintainer = await compileGame({ projectDirectory: join(fixtureRoot, '2d-basic/template'),
            typesDirectory: join(fixtureRoot, '2d-basic/types'), outDirectory: join(directory, 'maintainer-game') });
        assert.equal(maintainer.emitted, true);
        assert.equal(maintainer.profileChecked, false);
        const toolchain = join(directory, 'sdk/toolchain');
        await mkdir(join(toolchain, 'compiler'), { recursive: true });
        for (const name of ['compile-game.cjs', 'files.cjs']) await cp(join(runtime, name), join(toolchain, 'compiler', name));
        await writeFile(join(toolchain, 'package.json'), '{"private":true}');
        const closure = await compilerDependencies(engine);
        // Copy the already recorded package graph, not a second SDK packager. An SDK owner can supply its packaged tree instead.
        if (process.env.RUNTIME_TOOLCHAIN) {
            await cp(join(resolve(process.env.RUNTIME_TOOLCHAIN), 'node_modules'), join(toolchain, 'node_modules'), { recursive: true });
        } else {
            for (const pkg of closure.packages) {
                const source = join(engine, pkg.path);
                await cp(source, join(toolchain, pkg.path), { recursive: true,
                    filter: file => file === source || !file.slice(source.length + 1).split('/').includes('node_modules') });
            }
        }
        for (const profile of ['2d-basic', '3d-basic']) {
            const destination = join(directory, 'sdk/profiles', profile);
            await mkdir(destination, { recursive: true });
            for (const name of ['types', 'template', 'game', 'game-compiler.json']) {
                await cp(join(fixtureRoot, profile, name), join(destination, name), { recursive: true });
            }
            const ts = require('typescript');
            const ast = ts.createSourceFile('cc.js', await readFile(join(fixtureRoot, profile, 'engine/cc.js'), 'utf8'), ts.ScriptTarget.Latest, true);
            const names = new Set();
            const visit = node => {
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'exports') {
                    const arg = node.arguments[0];
                    if (ts.isStringLiteral(arg)) names.add(arg.text);
                    else {
                        assert.ok(ts.isObjectLiteralExpression(arg), 'Expected static runtime export names');
                        for (const property of arg.properties) {
                            assert.ok(ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)));
                            names.add(property.name.text);
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
            assert.ok(names.size > 100);
            assert.equal(names.has('MeshRenderer'), profile === '3d-basic');
            await writeFile(join(destination, 'cc-exports.json'), JSON.stringify([...names].sort()));
        }
        const working = join(directory, 'working');
        await mkdir(working);
        await writeFile(join(directory, 'package.json'), JSON.stringify({ browserslist: ['extends browserslist-config-hostile'] }));
        for (const name of ['browserslist', '.browserslistrc']) await writeFile(join(directory, name), 'extends browserslist-config-hostile\n');
        const script = join(directory, 'acceptance.cjs');
        await writeFile(script, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createRequire, isBuiltin } = require('node:module');
const Module = require('node:module');
const toolchainDirectory = path.join(__dirname, 'sdk/toolchain');
const { compileGame: backend } = require(path.join(toolchainDirectory, 'compiler/compile-game.cjs'));
let inputRoots;
let configFile;
async function compileGame(options) {
    inputRoots = [toolchainDirectory, path.join(options.projectDirectory, 'src'), options.typesDirectory];
    configFile = path.join(options.projectDirectory, 'tsconfig.json');
    const before = blockedInputAttempts.length;
    try { return await backend(options); } finally {
        inputRoots = undefined;
        assert.deepEqual(blockedInputAttempts.slice(before), [], 'Caught/ignored outside probes are still isolation failures');
    }
}
const ts = createRequire(path.join(toolchainDirectory, 'package.json'))('typescript');
for (const name of ['readFile', 'readDirectory', 'fileExists', 'directoryExists', 'getDirectories']) {
    ts.sys[name] = () => { throw new Error('DEFAULT_TS_FILESYSTEM_USED: ' + name); };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (...args) {
    const resolved = originalResolve.apply(this, args);
    if (!isBuiltin(resolved)) assert.ok(resolved.startsWith(toolchainDirectory + path.sep), 'CHECKOUT_MODULE_READ: ' + resolved);
    if (checking) assert.ok(!resolved.includes(path.sep + '@babel' + path.sep), 'CHECK_ONLY_TRANSFORM_LOADED: ' + resolved);
    return resolved;
};
const outside = path.join(__dirname, 'outside');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'leak.d.ts'), 'export interface Leak { value: string }');
fs.writeFileSync(path.join(outside, 'leak.ts'), 'export const leak = 1;');
const readAttempts = [];
const blockedInputAttempts = [];
const writes = [];
let checking = false;
for (const [object, names] of [[fs, ['readFileSync', 'openSync', 'existsSync', 'statSync']], [fsp, ['readFile', 'open']]]) {
    for (const name of names) {
        const original = object[name];
        object[name] = function (file, ...args) {
            if (typeof file === 'string' && (inputRoots || !['existsSync', 'statSync'].includes(name))) {
                readAttempts.push(file);
                if (inputRoots && !(path.resolve(file) === configFile
                    || inputRoots.some(root => path.resolve(file).startsWith(root + path.sep)))) blockedInputAttempts.push({ operation: name, file });
                assert.ok(!path.resolve(file).startsWith(outside + path.sep), 'OUTSIDE_INPUT_READ: ' + file);
                if (inputRoots) assert.ok(path.resolve(file) === configFile
                    || inputRoots.some(root => path.resolve(file).startsWith(root + path.sep)), 'UNALLOWLISTED_READ: ' + file);
                if (checking && name.toLowerCase().includes('open')) assert.equal(args[0] & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
            }
            return original.call(this, file, ...args);
        };
    }
}
for (const name of ['writeFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm']) {
    const original = fsp[name];
    fsp[name] = function (...args) {
        if (checking) { writes.push(name); throw new Error('CHECK_ONLY_WRITE: ' + name); }
        return original.apply(this, args);
    };
}
const code = expected => error => error.code === expected && Array.isArray(error.diagnostics);
async function main() {
    const results = [];
    for (const profile of ['2d-basic', '3d-basic']) {
        const root = path.join(__dirname, 'sdk/profiles', profile);
        const projectDirectory = path.join(__dirname, profile);
        await fsp.cp(path.join(root, 'template'), projectDirectory, { recursive: true });
        for (const file of ['babel.config.cjs', '.babelrc.js', 'tsconfig.js']) {
            await fsp.writeFile(path.join(projectDirectory, file), 'throw new Error("PROJECT_CONFIG_EXECUTED");');
        }
        await fsp.writeFile(path.join(projectDirectory, 'package.json'), JSON.stringify({ scripts: { prepare: 'exit 99' }, type: 'module' }));
        const options = { projectDirectory, typesDirectory: path.join(root, 'types'), toolchainDirectory,
            availableCCExports: JSON.parse(await fsp.readFile(path.join(root, 'cc-exports.json'))) };
        checking = true;
        const checked = await compileGame({ ...options, checkOnly: true, outDirectory: path.join(outside, 'must-not-exist/output') });
        checking = false;
        assert.equal(checked.emitted, false);
        assert.equal(checked.checkOnly, true);
        assert.equal(checked.profileChecked, true);
        assert.deepEqual(checked.outputFiles, []);
        assert.deepEqual(checked.diagnostics, []);
        assert.deepEqual(writes, []);
        assert.equal(fs.existsSync(path.join(outside, 'must-not-exist')), false);
        const outDirectory = path.join(__dirname, profile + '-game');
        const compiled = await compileGame({ ...options, outDirectory });
        assert.equal(compiled.emitted, true);
        for (const file of compiled.outputFiles) assert.equal(await fsp.readFile(path.join(outDirectory, file), 'utf8'),
            await fsp.readFile(path.join(root, 'game', file), 'utf8'), 'Fresh transform changed browser-verified fixture: ' + file);
        await assert.rejects(compileGame({ ...options, outDirectory }), code('UNSUPPORTED_PROJECT'));
        const mainFile = path.join(projectDirectory, 'src/main.ts');
        await fsp.writeFile(mainFile, "import { _decorator, Component } from 'cc';\\n@_decorator.ccclass('Invalid')\\nexport class Invalid extends Component { @_decorator.property score: number = 'wrong'; }\\n");
        checking = true;
        let failure;
        try { await compileGame({ ...options, checkOnly: true }); } catch (error) { failure = error; }
        checking = false;
        assert.equal(failure.code, 'TYPECHECK_FAILED');
        const diagnostic = failure.diagnostics.find(item => item.code === 2322);
        assert.equal(diagnostic.file, 'src/main.ts');
        assert.equal(diagnostic.line, 3);
        assert.equal(diagnostic.severity, 'error');
        assert.ok(diagnostic.column > 1);
        assert.match(diagnostic.message, /string.*number/);
        results.push({ profile, checkOnly: checked.typeChecked, byteIdenticalTransform: true, diagnostic });
        await fsp.writeFile(mainFile, "export { MeshRenderer as Model } from 'cc';");
        if (profile === '2d-basic') await assert.rejects(compileGame({ ...options, checkOnly: true }), code('FEATURE_NOT_IN_PROFILE'));
        else assert.ok((await compileGame({ ...options, checkOnly: true })).requiredCCExports.includes('MeshRenderer'));
    }
    const projectDirectory = path.join(__dirname, 'adversarial');
    const typesDirectory = path.join(__dirname, 'sdk/profiles/2d-basic/types');
    await fsp.mkdir(path.join(projectDirectory, 'src'), { recursive: true });
    const mainFile = path.join(projectDirectory, 'src/main.ts');
    const options = { projectDirectory, typesDirectory, toolchainDirectory, checkOnly: true };
    await fsp.writeFile(mainFile, 'export const value = 1;');
    for (const config of [
        { compilerOptions: { typeRoots: [outside] } },
        { compilerOptions: { types: [path.join(outside, 'leak')] } },
        { compilerOptions: { paths: { cc: [path.join(outside, 'leak.d.ts')] } } },
        { compilerOptions: { rootDirs: [outside] } },
        { extends: path.join(outside, 'tsconfig.json') },
        { files: [path.join(outside, 'leak.ts')] },
        { compilerOptions: { plugins: [{ name: path.join(outside, 'plugin.cjs') }] } },
    ]) {
        await fsp.writeFile(path.join(projectDirectory, 'tsconfig.json'), JSON.stringify(config));
        await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
    }
    await fsp.rm(path.join(projectDirectory, 'tsconfig.json'));
    const cases = [
        '/// <reference path="../../outside/leak.d.ts" />\\nexport const value = 1;',
        '/// <reference types="../../outside/leak" />\\nexport const value = 1;',
        '/// <reference lib="../../outside/leak" />\\nexport const value = 1;',
        '/// <reference no-default-lib="true" />\\nexport const value = 1;',
        "import Outside = require('../../outside/leak');",
        "declare module 'cc' { export const secret: number; }",
        'declare global { interface Window { secret: number } }',
        "type Leak = import('../../outside/leak.js').Leak;",
        "import '../../outside/leak.js';",
        "import * as cc from 'cc'; export const Node = cc.Node;",
        "export * from 'cc';",
        "import { cclegacy } from 'cc'; export const value = cclegacy['MeshRenderer'];",
        "export { cclegacy as cc } from 'cc';",
        "export const value = (import.meta as any).import('cc');",
        '// @ts-nocheck\\nexport const value: number = "bad";',
        '// @ts-ignore\\nexport const value: number = "bad";',
        '// @ts-expect-error\\nexport const value: number = "bad";',
    ];
    for (const source of cases) {
        await fsp.writeFile(mainFile, source);
        await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
    }
    for (const source of ["export { MeshRenderer as Model } from 'cc';", "import { MeshRenderer as Model } from 'cc'; export const value = Model;"]) {
        await fsp.writeFile(mainFile, source);
        await assert.rejects(compileGame({ ...options, availableCCExports: ['Node'] }), error =>
            error.code === 'FEATURE_NOT_IN_PROFILE' && error.diagnostics[0].file === 'src/main.ts');
    }
    await fsp.writeFile(mainFile, 'export const value: = 1;');
    await assert.rejects(compileGame(options), error => error.code === 'TYPECHECK_FAILED'
        && error.diagnostics.some(item => typeof item.code === 'number' && item.line === 1 && item.file === 'src/main.ts'));
    await fsp.writeFile(mainFile, "import type { MeshRenderer } from 'cc'; export type Renderer = MeshRenderer;");
    assert.equal((await compileGame({ ...options, availableCCExports: [] })).typeChecked, true);
    await fsp.writeFile(mainFile, "import type * as CC from 'cc'; export type Renderer = CC.MeshRenderer; export class Ordinary { constructor() { void new.target; } }");
    assert.equal((await compileGame({ ...options, availableCCExports: [] })).typeChecked, true);
    await fsp.writeFile(mainFile, 'export const value = 1; throw new Error("PROJECT_EXECUTED");');
    assert.equal((await compileGame(options)).typeChecked, true); // No tsconfig is required.
    await fsp.rm(mainFile);
    await fsp.symlink(path.join(outside, 'leak.ts'), mainFile);
    await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
    await fsp.rm(mainFile);
    await fsp.writeFile(mainFile, 'export const value = 1;');
    await fsp.symlink(projectDirectory, path.join(__dirname, 'linked-project'));
    await assert.rejects(compileGame({ ...options, projectDirectory: path.join(__dirname, 'linked-project') }), code('UNSUPPORTED_PROJECT'));
    await fsp.symlink(typesDirectory, path.join(__dirname, 'linked-types'));
    await assert.rejects(compileGame({ ...options, typesDirectory: path.join(__dirname, 'linked-types') }), code('UNSUPPORTED_PROJECT'));
    const ccFile = path.join(typesDirectory, 'cc.d.ts');
    const cc = await fsp.readFile(ccFile, 'utf8');
    for (const injection of [
        '/// <reference path="../../../../outside/leak.d.ts" />\\n',
        '/// <reference types="../../../../outside/leak" />\\n',
        'declare module "cc" { export type Leak = import("../../../../outside/leak").Leak; }\\n',
    ]) {
        await fsp.writeFile(ccFile, injection + cc);
        await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
    }
    await fsp.writeFile(ccFile, cc);
    const companion = path.join(typesDirectory, 'webGPU.d.ts');
    const companionSource = await fsp.readFile(companion, 'utf8');
    await fsp.writeFile(companion, companionSource + '\\ndeclare const invalidLibrary: MissingLibraryType;\\n');
    await assert.rejects(compileGame(options), error => error.code === 'TYPECHECK_FAILED'
        && error.diagnostics.some(item => item.code === 2304 && item.file === 'types/webGPU.d.ts'));
    await fsp.writeFile(companion, companionSource);
    for (const file of [path.join(typesDirectory, 'webGPU.d.ts'), path.join(toolchainDirectory, 'node_modules/typescript/lib/lib.dom.d.ts')]) {
        const original = await fsp.readFile(file);
        await fsp.rm(file);
        await fsp.symlink(path.join(outside, 'leak.d.ts'), file);
        await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
        await fsp.rm(file);
        await fsp.writeFile(file, original);
    }
    for (const file of [path.join(toolchainDirectory, 'package.json'),
        path.join(toolchainDirectory, 'node_modules/typescript/package.json'),
        path.join(toolchainDirectory, 'node_modules/@babel/parser/lib/index.js')]) {
        const original = await fsp.readFile(file);
        await fsp.rm(file);
        await fsp.symlink(path.join(outside, 'leak.d.ts'), file);
        await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
        await fsp.rm(file);
        await fsp.writeFile(file, original);
    }
    const tsManifest = path.join(toolchainDirectory, 'node_modules/typescript/package.json');
    const manifest = await fsp.readFile(tsManifest, 'utf8');
    for (const change of [{ main: path.join(outside, 'leak.ts') }, { version: '5.0.0' }]) {
        await fsp.writeFile(tsManifest, JSON.stringify({ ...JSON.parse(manifest), ...change }));
        await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
    }
    await fsp.writeFile(tsManifest, manifest);
    const parser = path.join(toolchainDirectory, 'node_modules/@babel/parser');
    await fsp.rename(parser, path.join(__dirname, 'saved-parser'));
    await fsp.mkdir(path.join(__dirname, 'node_modules/@babel'), { recursive: true });
    await fsp.symlink(outside, path.join(__dirname, 'node_modules/@babel/parser'));
    await assert.rejects(compileGame(options), error => code('UNSUPPORTED_PROJECT')(error)
        && /Missing toolchain dependency within node_modules: @babel\\/parser/.test(error.message));
    await fsp.rename(path.join(__dirname, 'saved-parser'), parser);
    await fsp.rm(mainFile);
    const jsFile = path.join(projectDirectory, 'src/main.js');
    await fsp.writeFile(jsFile, '/** @typedef {import("../../outside/leak.js").Leak} Leak */\\nexport const value = 1;');
    await assert.rejects(compileGame(options), code('UNSUPPORTED_PROJECT'));
    await fsp.writeFile(jsFile, '/** @type {number} */\\nexport const value = "wrong";');
    await assert.rejects(compileGame(options), error => error.code === 'TYPECHECK_FAILED'
        && error.diagnostics.some(item => item.code === 2322 && item.file === 'src/main.js'));
    await fsp.writeFile(jsFile, "import { Node } from 'cc'; export const node = new Node('js'); throw new Error('PROJECT_EXECUTED');");
    const js = await compileGame({ ...options, checkOnly: false, outDirectory: path.join(__dirname, 'js-game'), availableCCExports: ['Node'] });
    assert.deepEqual(js.outputFiles, ['main.js']);
    assert.ok(!readAttempts.some(file => /(?:babel.config.cjs|\\.babelrc.js|tsconfig.js)$/.test(file)));
    assert.deepEqual(blockedInputAttempts, []);
    assert.deepEqual(writes, []);
    console.log(JSON.stringify({ node: process.version, isolatedToolchain: true, noDefaultTsFilesystem: true,
        noOutsideReads: true, blockedInputAttempts: blockedInputAttempts.length, noProjectExecution: true,
        checkOnlyWrites: writes.length, cases: cases.length, results }, null, 2));
}
main().catch(error => { console.error(error, error.diagnostics); process.exitCode = 1; });
`);
        const result = await execute(process.execPath, [script], { cwd: working, timeout: 210000,
            env: { PATH: '', HOME: directory, TMPDIR: directory, LANG: 'C', NODE_PATH: '' }, maxBuffer: 1024 * 1024 });
        t.diagnostic(`Copied ${closure.packages.length} locked packages. ${result.stdout.trim()}`);
        assert.equal(result.stderr, '');
    });

test('fresh HTML5 BUILD profiles: typed fixtures, builtins, actual Chrome pixels/input/audio/restart',
    { skip: process.env.RUNTIME_INTEGRATION !== '1', timeout: 1200000 }, async t => {
        const executablePath = process.env.RUNTIME_CHROME;
        assert.ok(executablePath, 'Set RUNTIME_CHROME to the current host Chrome executable');
        await mkdir(join(runtime, 'build'), { recursive: true });
        const evidenceRoot = await mkdtemp(join(runtime, 'build/acceptance-'));
        t.diagnostic(`Persistent runtime/evidence artifacts: ${evidenceRoot}`);
        const { verifyBrowser } = require('../runtime/verify-browser.cjs');
        for (const [profile, variable] of [['2d-basic', 'RUNTIME_BUILTINS_2D'], ['3d-basic', 'RUNTIME_BUILTINS_3D']]) {
            await t.test(profile, { timeout: 600000 }, async () => {
                assert.ok(process.env[variable], `Set ${variable} to an existing verified builtin artifact`);
                const builtinDirectory = resolve(process.env[variable]);
                const outDirectory = join(evidenceRoot, profile);
                const result = await buildRuntime({ profile, builtinDirectory, outDirectory });
                const bytes = await readFile(result.descriptor);
                assert.equal(result.sha256, sha256(bytes));
                const descriptor = JSON.parse(bytes);
                assert.equal(descriptor.delivery, 'PREBUILT');
                assert.equal(descriptor.constants.BUILD, true);
                for (const name of ['NATIVE', 'JSB', 'PREVIEW', 'EDITOR', 'TEST', 'NODEJS']) assert.equal(descriptor.constants[name], false);
                assert.ok(descriptor.features.includes('legacy-pipeline'));
                assert.ok(!descriptor.features.includes('gfx-empty'));
                assert.deepEqual(descriptor.typeFiles, ['types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts']);
                assert.equal(descriptor.builtins.effects.length, profile === '2d-basic' ? 5 : 8);
                assert.equal(descriptor.builtins.materials.length, 10);
                await execute(process.execPath, [join(engine, 'node_modules/typescript/bin/tsc'), '--project', join(outDirectory, 'template/tsconfig.json')]);
                await assert.rejects(buildRuntime({ profile, builtinDirectory, outDirectory }), /OUTPUT_CONFLICT/);
                const invalid = join(evidenceRoot, `invalid-${profile}`);
                await cp(join(outDirectory, 'template'), invalid, { recursive: true });
                await writeFile(join(invalid, 'src/main.ts'), "import { _decorator, Component } from 'cc';\n@_decorator.ccclass('Invalid')\nexport class Invalid extends Component { @_decorator.property score: number = 'wrong'; }\n");
                await assert.rejects(compileGame({ projectDirectory: invalid, typesDirectory: join(outDirectory, 'types'), outDirectory: join(invalid, 'output') }), /TS2322/);
                await assertAbsent(join(invalid, 'output'));
                await rm(invalid, { recursive: true });
                const builtin = await readBuiltins({ engine, profile, builtinDirectory });
                assert.equal(builtin.reportSha256, descriptor.builtins.reportSha256);
                await assert.rejects(readBuiltins({ engine, profile: profile === '2d-basic' ? '3d-basic' : '2d-basic', builtinDirectory }), /profile mismatch/);
                const browser = await verifyBrowser({ runtimeDirectory: outDirectory, executablePath,
                    outDirectory: join(evidenceRoot, `${profile}-browser`) });
                assert.equal(browser.runtimeSha256, result.sha256);
                t.diagnostic(JSON.stringify({ ...result, browser }));
            });
        }
    });
