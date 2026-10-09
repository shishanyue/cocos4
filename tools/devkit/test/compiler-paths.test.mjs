import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import Module, { builtinModules, createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the actual guard setup/cleanup without exporting compiler internals,
// requiring a prepared SDK, or rebuilding shared host output. Win32 tests inject
// Node's path.win32 and resolver filenames, not a slash-normalizing substitute.
const game = ts.createSourceFile('game.ts', await readFile(new URL('../src/game.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const compile = game.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'compile');
assert(compile?.body);
const guarded = compile.body.statements.findIndex(ts.isTryStatement);
assert(guarded > 0 && compile.body.statements[guarded].finallyBlock);
const contracts = ts.createSourceFile('contracts.ts', await readFile(new URL('../src/contracts.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const appError = contracts.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AppError');
assert(appError);
const workerSource = ts.transpileModule(`
    ${appError.getText().replace(/^export /, '')}
    function install(toolchain: string) {
        ${compile.body.statements.slice(0, guarded).map(node => node.getText()).join('\n')}
        return () => ${compile.body.statements[guarded].finallyBlock.getText()};
    }
    install;
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const prepare = ts.createSourceFile('prepare-game-sdk.mjs', await readFile(new URL('../scripts/prepare-game-sdk.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const probes = [];
function visit(node) {
    if (ts.isTemplateExpression(node) && node.head.text.includes("const Module = require('node:module')")) probes.push(node);
    ts.forEachChild(node, visit);
}
visit(prepare);
assert.equal(probes.length, 1);

function installGuard(kind, toolchain, paths = path, commonjs = Module, require = createRequire) {
    if (kind === 'worker') return runInNewContext(workerSource,
        { path: paths, Module: commonjs, builtinModules, createRequire: require })(toolchain);
    const source = runInNewContext(probes[0].getText(), { path: paths, toolchainRoot: toolchain,
        projectDirectory: '', typesDirectory: '', outDirectory: '', names: [], profile: { variant: 'debug' } });
    const probe = ts.createSourceFile('probe.cjs', source, ts.ScriptTarget.Latest, true);
    const entry = probe.statements.findIndex(node => ts.isVariableStatement(node)
        && node.declarationList.declarations.some(declaration => ts.isObjectBindingPattern(declaration.name)
            && declaration.name.elements.some(element => element.name.getText() === 'compileGame')));
    assert(entry > 0);
    const original = commonjs._resolveFilename;
    runInNewContext(probe.statements.slice(0, entry).map(node => node.getText()).join('\n'), {
        require(name) {
            if (name === 'node:module') return commonjs;
            assert.equal(name, 'node:path');
            return paths;
        },
    });
    return () => { commonjs._resolveFilename = original; };
}

const rejected = kind => error => kind === 'worker'
    ? error.code === 'SDK_INCOMPLETE' && error.message === 'The SDK compiler attempted to resolve outside its private verified closure.'
    : error.message.startsWith('Compiler resolved outside the delivered toolchain: ');

for (const kind of ['worker', 'maintainer']) {
    test(`${kind} guard prevents poisoned ancestor dependencies from rescuing missing private dependencies`, async t => {
        const root = await mkdtemp(path.join(tmpdir(), 'cocos4-compiler-paths-'));
        const toolchain = path.join(root, 'sdk/toolchain');
        const compiler = path.join(toolchain, 'compiler/compile-game.cjs');
        const dependency = path.join(root, 'node_modules/ancestor-only/index.js');
        const marker = path.join(root, 'executed');
        const require = createRequire(path.join(toolchain, 'package.json'));
        t.after(async () => {
            for (const file of [compiler, dependency]) delete require.cache[file];
            await rm(root, { recursive: true, force: true });
        });
        await mkdir(path.dirname(compiler), { recursive: true });
        await mkdir(path.dirname(dependency), { recursive: true });
        await writeFile(dependency, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = 'rescued';`);
        await writeFile(compiler, `
            exports.required = () => require('ancestor-only');
            exports.optional = () => {
                try { return require.resolve('ancestor-only'); }
                catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return null; }
            };
            exports.absent = () => {
                try { return require.resolve('cocos4-compiler-paths-absent'); }
                catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return null; }
            };
            exports.builtin = () => require('node:path');
        `);
        assert.equal(createRequire(compiler).resolve('ancestor-only'), dependency, 'The poisoned ancestor really is resolvable');
        const original = Module._resolveFilename;
        const restore = installGuard(kind, toolchain);
        try {
            const probe = require(compiler);
            assert.equal(probe.builtin(), path);
            assert.equal(probe.absent(), null, 'Genuinely absent optional probes retain MODULE_NOT_FOUND');
            assert.throws(probe.required, rejected(kind));
            assert.throws(probe.optional, rejected(kind), 'An optional resolution must not disguise the boundary error as absence');
            await assert.rejects(readFile(marker), { code: 'ENOENT' });
        } finally { restore(); }
        assert.equal(Module._resolveFilename, original);
        if (kind === 'worker') assert.equal(require.cache[compiler], undefined);
        assert.equal(require(compiler).required(), 'rescued', 'Without the guard, the ancestor would rescue the dependency');
        assert.equal(await readFile(marker, 'utf8'), 'executed');
    });

    for (const [label, paths, root, inside, outside] of [
        ['posix', path.posix, '/sdk/toolchain',
            ['/sdk/toolchain/compiler/index.cjs', '/sdk/toolchain/..cache/index.js', '/sdk/toolchain/compiler/../node_modules/pkg/index.js'],
            ['/sdk/toolchain', '/sdk', '/sdk/node_modules/pkg/index.js', '/sdk/toolchain-extra/index.js', '/sdk/toolchain\\other/index.js', '/SDK/toolchain/index.js']],
        ['win32', path.win32, 'C:\\SDK\\toolchain',
            ['C:\\SDK\\toolchain\\compiler\\index.cjs', 'c:/sdk/TOOLCHAIN/node_modules/pkg/index.js', 'C:\\SDK\\toolchain\\..cache\\index.js',
                'C:\\SDK\\toolchain\\compiler\\..\\node_modules\\pkg\\index.js'],
            ['C:\\SDK\\toolchain', 'C:\\SDK', 'C:\\SDK\\node_modules\\pkg\\index.js', 'C:\\SDK\\toolchain-extra\\index.js',
                'C:\\SDK\\toolchain\\..\\outside.js', 'D:\\SDK\\toolchain\\index.js', '\\\\server\\share\\toolchain\\index.js']],
        ['win32 UNC', path.win32, '\\\\server\\share\\toolchain',
            ['\\\\server\\share\\toolchain\\compiler\\index.cjs', '//SERVER/share/TOOLCHAIN/node_modules/pkg/index.js'],
            ['\\\\server\\share\\toolchain', '\\\\server\\share', '\\\\server\\share\\toolchain-extra\\index.js',
                '\\\\server\\other\\toolchain\\index.js', '\\\\other\\share\\toolchain\\index.js']],
    ]) {
        test(`${kind} guard respects ${label} module and cache boundaries`, () => {
            const missing = Object.assign(new Error('Missing optional dependency'), { code: 'MODULE_NOT_FOUND' });
            const original = (request, _parent, ...args) => {
                if (request === 'absent') throw missing;
                assert.deepEqual(args, [false, { paths: ['optional-probe'] }]);
                return request;
            };
            const commonjs = { _resolveFilename: original, isBuiltin };
            const cache = Object.fromEntries([...inside, ...outside].map(file => [file, {}]));
            const restore = installGuard(kind, root, paths, commonjs, () => ({ cache }));
            const resolve = (request, filename) => commonjs._resolveFilename(request, filename ? { filename } : undefined,
                false, { paths: ['optional-probe'] });
            try {
                for (const parent of inside) {
                    for (const file of [...inside, 'fs', 'node:fs']) assert.equal(resolve(file, parent), file);
                    for (const file of outside) assert.throws(() => resolve(file, parent), rejected(kind), `${parent} -> ${file}`);
                    assert.throws(() => resolve('absent', parent), error => error === missing);
                }
                if (kind === 'worker') {
                    for (const parent of [...outside, undefined]) assert.equal(resolve(outside[0], parent), outside[0], 'Other host modules are not subject to the worker-local guard');
                } else {
                    assert.throws(() => resolve(outside[0]), rejected(kind), 'The maintainer probe guards even its entry require');
                }
            } finally { restore(); }
            assert.equal(commonjs._resolveFilename, original);
            assert.deepEqual(Object.keys(cache), kind === 'worker' ? outside : [...inside, ...outside]);
        });
    }
}
