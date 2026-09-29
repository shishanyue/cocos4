const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const { PNG } = require('pngjs');
const { checkGame, checkRoot, engine, rootRequire } = require('./check.cjs');
const { features, sha256, inventory, readAssets } = require('./files.cjs');

const execute = promisify(execFile);
async function build(assetDirectory) {
    const assets = await readAssets(await fs.realpath(assetDirectory), engine);
    await fs.mkdir(path.join(__dirname, 'build'), { recursive: true });
    const run = await fs.mkdtemp(path.join(__dirname, 'build/probe-'));
    const output = path.join(run, 'artifact');
    const json = (name, data) => fs.writeFile(path.join(run, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    console.log(`Build evidence: ${run}`);
    try {
        await fs.mkdir(output);
        checkRoot();
        const typecheck = checkGame(path.join(output, 'game'));
        await json('typecheck.json', typecheck);
        assert.equal(rootRequire(path.join(engine, 'node_modules/@cocos/ccbuild/package.json')).version, '2.3.21');
        const { StatsQuery, buildEngine } = rootRequire('@cocos/ccbuild');
        const stats = await StatsQuery.create(engine);
        assert.ok(features.every(feature => stats.hasFeature(feature)));
        const flags = { ...stats.getOverriddenConstantsOfFeatures(features), DEBUG: true, NATIVE: false, JSB: false, EDITOR: false, PREVIEW: false };
        const constants = stats.constantManager.genBuildTimeConstants({ platform: 'HTML5', mode: 'BUILD', flags });
        for (const name of ['NATIVE', 'JSB', 'EDITOR', 'PREVIEW', 'TEST', 'NODEJS', 'MINIGAME']) assert.equal(constants[name], false, name);
        assert.equal(constants.HTML5, true);
        assert.equal(constants.BUILD, true);
        // Explicit syntax target preserves captured loop bindings in shader program setup.
        const options = { engine, out: path.join(output, 'engine'), platform: 'HTML5', mode: 'BUILD',
            moduleFormat: 'system', features, flags, compress: false, split: false, sourceMap: false, targets: { chrome: '100' } };
        const result = await buildEngine(options);
        assert.equal(result.hasCriticalWarns, false);
        assert.ok(result.exports.cc);
        await json('engine-build.json', { options, constants, result });

        const devkitRequire = createRequire(path.join(__dirname, '../package.json'));
        assert.equal(devkitRequire('@cocos/module-system/package.json').version, '0.0.21');
        const loader = path.join(run, 'module-system');
        const source = path.dirname(devkitRequire.resolve('@cocos/module-system/package.json'));
        await fs.cp(source, loader, { recursive: true, errorOnExist: true, force: false });
        await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(run, 'node_modules'), 'dir');
        const configFile = path.join(loader, 'lib/tsconfig.json');
        const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
        assert.equal(config.compilerOptions.strict, true);
        assert.equal(config.compilerOptions.skipLibCheck, undefined);
        // Only the private config copy changes; never inherit engine @types/systemjs.
        config.compilerOptions.typeRoots = ['../../node_modules/@types'];
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
        const loaderRequire = createRequire(path.join(loader, 'package.json'));
        const checked = await execute(process.execPath, [loaderRequire.resolve('@cocos/typescript/bin/tsc'), '--noEmit', '--pretty', 'false', '--project', configFile],
            { cwd: run, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
        await json('loader-typecheck.json', checked);
        const loaderOptions = { platform: 'web-desktop', out: path.join(output, 'loader.js'), sourceMap: false, minify: false, hmr: false, editor: false };
        await require(loader).build(loaderOptions);
        await json('loader-build.json', { version: '0.0.21', options: loaderOptions, publishedFiles: await inventory(source) });

        for (const [name, bytes] of assets.files) {
            if (!name.startsWith('assets/')) continue;
            await fs.mkdir(path.dirname(path.join(output, name)), { recursive: true });
            await fs.writeFile(path.join(output, name), bytes, { flag: 'wx' });
        }
        await fs.writeFile(path.join(run, 'effect-result.json'), assets.reportBytes);
        await fs.cp(path.join(__dirname, 'template'), output, { recursive: true });
        const imports = { cc: `./engine/${result.exports.cc}`, 'virtual:///prerequisite-imports/internal': './internal-prerequisites.js' };
        for (const [alias, name] of Object.entries(result.chunkAliases)) imports[alias] = `./engine/${name}`;
        await json('artifact/import-map.json', { imports });
        await json('artifact/builtin-manifest.json', [
            ...assets.report.effects.map(({ uuid, name }) => ({ uuid, name, kind: 'effect' })),
            ...assets.report.materials.map(({ uuid, name }) => ({ uuid, name, kind: 'material' })),
        ]);
        await json('artifact/settings.json', { ...assets.settings,
            rendering: { ...assets.settings.rendering, renderMode: 2 },
            screen: { designResolution: { width: 640, height: 480, policy: 4 }, frameRate: 60 },
            splashScreen: { totalTime: 0 }, assets: { projectBundles: ['internal'], preloadBundles: [], preloadAssets: [] },
            scripting: { scriptPackages: [] }, launch: { launchScene: '' }, profiling: { showFPS: false },
        });
        const image = new PNG({ width: 32, height: 32 });
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
            const i = (y * 32 + x) * 4;
            image.data.fill(x < 16 ? 255 : 160, i, i + 3);
            image.data[i + 3] = 255;
        }
        await fs.mkdir(path.join(output, 'assets/probe'));
        await fs.writeFile(path.join(output, 'assets/probe/tile.png'), PNG.sync.write(image));
        await fs.copyFile(path.join(engine, 'LICENSE'), path.join(output, 'ENGINE-LICENSE'));
        const files = await inventory(output);
        for (const file of files) {
            assert.doesNotMatch(file.path, /\.(?:ts|map|effect|chunk|mtl)$/);
            if (file.path.endsWith('.js')) assert.doesNotMatch(await fs.readFile(path.join(output, file.path), 'utf8'), /sourceMappingURL|sourcesContent/);
        }
        await json('build-report.json', {
            kind: 'cocos4-browser-bootstrap', node: process.version, profile: '2d-basic', features,
            effectReportSha256: sha256(assets.reportBytes), rootLockSha256: sha256(await fs.readFile(path.join(engine, 'package-lock.json'))),
            declarations: await inventory(path.join(engine, 'bin/.declarations')),
            sourceFiles: await inventory(__dirname, '', ['build', 'node_modules']),
            typecheck,
            validation: { rootTypecheck: true, gameTypecheck: true, loaderTypecheck: true, engineBuild: true, assetHashes: true,
                browserPixels: false, playableComplete: false, world3d: false, audio: false },
            files,
        });
        console.log(JSON.stringify({ artifact: output, report: path.join(run, 'build-report.json') }, null, 2));
        return output;
    } catch (error) {
        await fs.writeFile(path.join(run, 'failure.log'), String(error.stack || error));
        throw error;
    }
}

module.exports = { build };
if (require.main === module) {
    if (process.argv.length !== 4 || process.argv[2] !== '--assets') {
        console.error('Usage: node build.cjs --assets /absolute/path/to/2d-effect-artifact');
        process.exitCode = 1;
    } else build(path.resolve(process.argv[3])).catch(error => { console.error(error); process.exitCode = 1; });
}
