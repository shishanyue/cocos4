const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { sha256 } = require('./files.cjs');

async function prepareLoader(workDirectory) {
    assert.equal(require('@cocos/module-system/package.json').version, '0.0.21');
    const source = path.dirname(require.resolve('@cocos/module-system/package.json'));
    const config = JSON.parse(await fs.readFile(path.join(source, 'lib/tsconfig.json'), 'utf8'));
    assert.deepEqual(config, { compilerOptions: {
        target: 'ES2021', module: 'ES2022', strict: true, downlevelIteration: true,
        esModuleInterop: true, moduleResolution: 'node', rootDir: '.',
    } }, 'Review the loader config boundary when the published config changes');

    const loader = path.join(workDirectory, 'module-system');
    await fs.cp(source, loader, { recursive: true, force: false, errorOnExist: true });
    await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(workDirectory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir');
    // The builder hard-codes this config and has no compiler-options override.
    // Preserve the isolated devkit type closure (Node alongside DOM), not ancestor @types.
    // Only this private config copy changes; published loader sources remain untouched.
    config.compilerOptions.typeRoots = ['../../node_modules/@types'];
    await fs.writeFile(path.join(loader, 'lib/tsconfig.json'), JSON.stringify(config, null, 2) + '\n');
    // The published build API does not expose Terser's worker option. Bound it in
    // this version-checked private copy; never edit installed dependencies.
    const buildFile = path.join(loader, 'dist/build.js');
    const buildSource = await fs.readFile(buildFile, 'utf8');
    assert.equal(sha256(buildSource), '880a011b579340bae96033d49d936a1f6e529a9350227c23c066fc230af079b4', 'Review the published loader builder');
    const anchor = '(0, rollup_plugin_terser_1.terser)({})';
    assert.equal(buildSource.split(anchor).length, 2, 'Review loader minifier worker preparation');
    await fs.writeFile(buildFile, buildSource.replace(anchor, '(0, rollup_plugin_terser_1.terser)({ numWorkers: 1 })'));
    return loader;
}

module.exports = { prepareLoader };
