import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { compileGame } from '../runtime/compile-game.cjs';

// Exercise the maintained compiler, not the compiler saved in this immutable SDK.
const sdkRoot = path.resolve(process.env.GAME_OPERATION_SDK_ROOT ?? fileURLToPath(new URL('../build/game-sdk', import.meta.url)));
test('source compiler erases type-only modules before SystemJS and preserves Cocos decorators and regular modules', async t => {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(sdkRoot, 'manifest.json'), 'utf8')); }
    catch (error) {
        if (error.code !== 'ENOENT' || process.env.GAME_OPERATION_SDK_ROOT || process.env.GAME_SDK_INTEGRATION === '1') throw error;
        return t.skip('Set GAME_OPERATION_SDK_ROOT to a genuine game SDK with the pinned 84-package toolchain.');
    }
    const toolchainDirectory = path.join(sdkRoot, 'toolchain');
    const require = createRequire(path.join(toolchainDirectory, 'package.json'));
    const ts = require('./node_modules/typescript');
    assert.equal(ts.version, '4.9.5');
    assert.equal(JSON.parse(await readFile(path.join(toolchainDirectory, 'compiler-dependencies.json'))).packages.length, 84);
    const profile = manifest.catalog.profiles.find(item => item.target === 'HTML5' && item.id === '2d-basic');
    const directory = await mkdtemp(path.join(tmpdir(), 'cocos4-compiler-exports-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const projectDirectory = path.join(directory, 'project');
    await mkdir(path.join(projectDirectory, 'src'), { recursive: true });
    const sources = {
        'model.ts': 'export interface GameState { score: number; }',
        'alias.ts': 'export type Score = number;',
        'types.ts': "export type { GameState } from './model.js'; export { type Score } from './alias.js';",
        'logic.ts': 'export function advance(score: number): number { return score + 1; }',
        'regular.js': "export { advance as step } from './logic.js'; export default 'regular';",
        'main.ts': `import { _decorator, Component } from 'cc';
import type { GameState, Score } from './types.js';
import { step } from './regular.js';
const { ccclass, property } = _decorator;
@ccclass('CompilerExportFixture')
export class CompilerExportFixture extends Component {
    @property score: Score = 7;
    advance(): GameState { return { score: step(this.score) }; }
}
export async function start(): Promise<void> { throw new Error('GAME MUST NOT EXECUTE'); }
`,
    };
    for (const [name, source] of Object.entries(sources)) await writeFile(path.join(projectDirectory, 'src', name), source);
    const options = { projectDirectory, typesDirectory: path.join(sdkRoot, profile.directory, 'types'), toolchainDirectory,
        outDirectory: path.join(directory, 'compiled') };
    const checked = await compileGame({ ...options, checkOnly: true });
    assert.equal(checked.emitted, false);
    assert.deepEqual(checked.outputFiles, []);
    const compiled = await compileGame(options);
    assert.equal(compiled.typeChecked, true);
    assert.equal(compiled.typeChecking.strict, true);
    assert.equal(compiled.typeChecking.skipLibCheck, false);
    const babel = require('./node_modules/@babel/core');
    assert.equal(babel.version, '7.19.6');
    for (const name of compiled.outputFiles) await t.test(name, async () => {
        const output = await readFile(path.join(options.outDirectory, name), 'utf8');
        assert.match(output, /^System\.register\(/);
        assert.doesNotThrow(() => new Script(output), 'Every emitted file must be valid classic SystemJS, including type-only modules');
        if (['model.js', 'alias.js', 'types.js'].includes(name)) {
            const ast = ts.createSourceFile(name, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            assert.equal(ast.statements.length, 1);
        } else {
            const sourceName = name === 'regular.js' ? name : name.replace(/\.js$/, '.ts');
            const previous = babel.transformSync(sources[sourceName], { filename: path.join(projectDirectory, 'src', sourceName),
                sourceType: 'module', babelrc: false, configFile: false, browserslistConfigFile: false, sourceMaps: false,
                presets: [[require.resolve('./node_modules/@cocos/babel-preset-cc'),
                    { allowDeclareFields: true, onlyRemoveTypeImports: true, useDefineForClassFields: false }]],
                plugins: [require.resolve('./node_modules/@babel/plugin-transform-modules-systemjs')] });
            assert.equal(output, previous.code, 'Ordinary modules and legacy Cocos decorators retain their emitted behavior');
        }
    });
    await t.test('interface-only main remains a valid generic compiler input', async () => {
        await writeFile(path.join(projectDirectory, 'src/main.ts'), 'export interface GameState { score: number; }');
        const outDirectory = path.join(directory, 'type-only-main');
        const metadata = await compileGame({ ...options, outDirectory });
        assert.equal(metadata.typeChecked, true);
        const output = await readFile(path.join(outDirectory, 'main.js'), 'utf8');
        assert.match(output, /^System\.register\(/);
        assert.doesNotThrow(() => new Script(output));
    });
    await t.test('neither Babel pass probes hostile ancestor Browserslist configuration', async () => {
        const cwd = process.cwd();
        const working = path.join(directory, 'working');
        await mkdir(working);
        await writeFile(path.join(directory, 'package.json'), JSON.stringify({ browserslist: ['extends browserslist-config-hostile'] }));
        for (const name of ['browserslist', '.browserslistrc']) await writeFile(path.join(directory, name), 'extends browserslist-config-hostile\n');
        const forbidden = new Set();
        for (const root of [working, path.join(projectDirectory, 'src')]) {
            for (let parent = root; ; parent = path.dirname(parent)) {
                for (const name of ['package.json', 'browserslist', '.browserslistrc']) forbidden.add(path.join(parent, name));
                if (parent === path.dirname(parent)) break;
            }
        }
        const attempts = [];
        const restore = [];
        for (const [object, names] of [[fs, ['existsSync', 'statSync', 'readFileSync', 'openSync']], [fsp, ['access', 'stat', 'readFile', 'open']]]) {
            for (const name of names) {
                const original = object[name];
                restore.push(() => { object[name] = original; });
                object[name] = function (file, ...args) {
                    if (typeof file === 'string' && forbidden.has(path.resolve(file))) {
                        attempts.push({ operation: name, file });
                        throw new Error(`BROWSERSLIST_CONFIG_PROBE: ${name} ${file}`);
                    }
                    return original.call(this, file, ...args);
                };
            }
        }
        try {
            process.chdir(working);
            const metadata = await compileGame({ ...options, outDirectory: path.join(directory, 'isolated-game') });
            assert.equal(metadata.emitted, true);
        } finally {
            process.chdir(cwd);
            for (const reset of restore) reset();
            assert.deepEqual(attempts, [], 'Even caught/ignored filesystem probes violate compiler isolation');
        }
    });
});
