const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { profiles } = require('../effects/builtin-inputs.cjs');
const { readBuiltins } = require('../runtime/builtins.cjs');
const { compileGame } = require('../runtime/compile-game.cjs');
const { buildTypes } = require('../runtime/build-types.cjs');
const { makeFixtureAssets } = require('../runtime/make-fixture-assets.cjs');
const { compilerDependencies } = require('../runtime/compiler-dependencies.cjs');
const { assertAbsent, inventory, sha256 } = require('../runtime/files.cjs');

const engine = path.resolve(__dirname, '../../..');
const runtime = path.resolve(__dirname, '../runtime');
const rootRequire = createRequire(path.join(engine, 'package.json'));
const devkitRequire = createRequire(path.resolve(__dirname, '../package.json'));
const execute = promisify(execFile);

async function buildRuntime({ profile, builtinDirectory, outDirectory }) {
    assert.ok(Object.hasOwn(profiles, profile), `PROFILE_NOT_AVAILABLE: ${profile}`);
    assert.equal(typeof builtinDirectory, 'string');
    assert.equal(typeof outDirectory, 'string');
    const output = path.resolve(outDirectory);
    const parent = await fs.realpath(path.dirname(output));
    assert.equal(parent, path.dirname(output), 'Output parent must be canonical, without symlinks');
    await assertAbsent(output);
    const builtin = await readBuiltins({ engine, profile, builtinDirectory });
    const lock = await fs.open(`${output}.lock`, 'wx');
    let staging;
    let loaderWork;
    try {
        await assertAbsent(output);
        staging = await fs.mkdtemp(path.join(parent, '.runtime-staging-'));
        const writeJson = (name, value) => fs.writeFile(path.join(staging, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
        const rootLockBytes = await fs.readFile(path.join(engine, 'package-lock.json'));
        const rootLock = JSON.parse(rootLockBytes);
        const compilerClosure = await compilerDependencies(engine);
        await writeJson('compiler-dependencies.json', compilerClosure);
        for (const name of ['@cocos/ccbuild', 'typescript', '@cocos/babel-preset-cc', '@babel/core']) {
            assert.equal(rootRequire(path.join(engine, 'node_modules', name, 'package.json')).version, rootLock.packages[`node_modules/${name}`].version,
                `Installed root tool differs from lock: ${name}`);
        }
        assert.equal(rootRequire(path.join(engine, 'node_modules/@cocos/ccbuild/package.json')).version, '2.3.21');
        const { buildEngine, StatsQuery } = rootRequire('@cocos/ccbuild');
        const stats = await StatsQuery.create(engine);
        const features = [...profiles[profile]];
        assert.ok(features.every(feature => stats.hasFeature(feature)));
        const flags = { ...stats.getOverriddenConstantsOfFeatures(features),
            DEBUG: true, NATIVE: false, JSB: false, EDITOR: false, PREVIEW: false };
        const constants = stats.constantManager.genBuildTimeConstants({ platform: 'HTML5', mode: 'BUILD', flags });
        for (const name of ['NATIVE', 'JSB', 'EDITOR', 'PREVIEW', 'TEST', 'NODEJS']) assert.equal(constants[name], false, name);
        assert.equal(constants.BUILD, true);
        const subprocess = { cwd: engine, timeout: 300000, maxBuffer: 16 * 1024 * 1024 };
        // The untargeted legacy Babel path miscompiles captured loop bindings in program-lib.
        // This profile intentionally targets modern Chrome rather than claiming legacy-browser support.
        const targets = { chrome: '100' };
        await execute(process.execPath, [rootRequire.resolve('typescript/bin/tsc'), '--noEmit', '--project', path.join(engine, 'tsconfig.json')], subprocess);
        const result = await buildEngine({ engine, platform: 'HTML5', mode: 'BUILD', moduleFormat: 'system', features, flags,
            out: path.join(staging, 'engine'), compress: false, sourceMap: false, split: false, targets });
        assert.equal(result.hasCriticalWarns, false, 'Critical engine build warnings');
        assert.ok(result.exports.cc, 'Missing cc entry');
        await writeJson('engine-build.json', result);
        const types = path.join(staging, 'types');
        await buildTypes({ engine, outDirectory: types, workDirectory: staging });

        // Relocate the unmodified loader package: its tsconfig must not discover engine ancestor ambient types.
        assert.equal(devkitRequire('@cocos/module-system/package.json').version, '0.0.21');
        loaderWork = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos4-runtime-loader-'));
        const loader = path.join(loaderWork, 'module-system');
        await fs.cp(path.dirname(devkitRequire.resolve('@cocos/module-system/package.json')), loader, { recursive: true });
        await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(loaderWork, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const loaderRequire = createRequire(path.join(loader, 'package.json'));
        await execute(process.execPath, [loaderRequire.resolve('@cocos/typescript/bin/tsc'), '--noEmit', '--pretty', 'false',
            '--project', path.join(loader, 'lib/tsconfig.json')], { ...subprocess, cwd: loaderWork });
        const loaderOptions = { out: path.join(staging, 'loader.js'), platform: 'web-desktop', sourceMap: false, minify: false, hmr: false, editor: false };
        const loaderResult = await execute(process.execPath, ['--eval',
            `require(${JSON.stringify(loader)}).build(${JSON.stringify(loaderOptions)}).catch(e=>{console.error(e);process.exitCode=1})`],
        { ...subprocess, cwd: loaderWork });
        assert.doesNotMatch(loaderResult.stdout + loaderResult.stderr, /\bTS\d+\b/, 'Loader compilation diagnostics');

        for (const [file, bytes] of builtin.files) {
            if (!file.startsWith('assets/')) continue;
            await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
            await fs.writeFile(path.join(staging, file), bytes, { flag: 'wx' });
        }
        await fs.writeFile(path.join(staging, 'builtin-report.json'), builtin.reportBytes, { flag: 'wx' });
        await fs.cp(path.join(runtime, 'fixture'), path.join(staging, 'template'), { recursive: true });
        if (profile === '3d-basic') await fs.copyFile(path.join(runtime, 'fixture3d/world.ts'), path.join(staging, 'template/src/world.ts'));
        const templateConfig = JSON.parse(await fs.readFile(path.join(staging, 'template/tsconfig.json'), 'utf8'));
        templateConfig.compilerOptions.paths.cc = ['../types/cc.d.ts'];
        await fs.writeFile(path.join(staging, 'template/tsconfig.json'), JSON.stringify(templateConfig, null, 2) + '\n');
        await makeFixtureAssets(path.join(staging, 'template/assets'));
        const game = await compileGame({ projectDirectory: path.join(staging, 'template'), typesDirectory: types, outDirectory: path.join(staging, 'game') });
        await fs.cp(path.join(staging, 'template/assets'), path.join(staging, 'assets/game'), { recursive: true });
        await writeJson('game-compiler.json', game);
        const imports = { cc: `./engine/${result.exports.cc}`,
            'virtual:///prerequisite-imports/internal': './internal-prerequisites.js' };
        for (const [alias, file] of Object.entries(result.chunkAliases)) imports[alias] = `./engine/${file}`;
        await writeJson('import-map.json', { imports });
        await writeJson('settings.json', {
            ...builtin.settings,
            rendering: { ...builtin.settings.rendering, renderMode: 2 },
            screen: { designResolution: { width: 640, height: 480, policy: 4 }, frameRate: 60 },
            splashScreen: { totalTime: 0 },
            assets: { projectBundles: ['internal'], preloadBundles: [], preloadAssets: [] },
            scripting: { scriptPackages: [] }, launch: { launchScene: '' }, profiling: { showFPS: false },
        });
        for (const name of ['index.html', 'boot.js', 'internal-prerequisites.js']) await fs.copyFile(path.join(runtime, name), path.join(staging, name));
        await fs.copyFile(path.join(engine, 'LICENSE'), path.join(staging, 'ENGINE-LICENSE'));
        const descriptor = {
            schemaVersion: 1, kind: 'cocos4-html5-runtime', profile, target: 'HTML5', mode: 'BUILD', variant: 'debug',
            moduleFormat: 'system', sourceMap: false, compressed: false, features, constants, targets,
            engineVersion: rootRequire('./package.json').version,
            rootLockSha256: sha256(rootLockBytes),
            tools: { ccbuild: '2.3.21', moduleSystem: '0.0.21', loaderPlatform: 'web-desktop', ...game },
            builtins: { report: 'builtin-report.json', reportSha256: builtin.reportSha256,
                effects: builtin.report.effects, materials: builtin.report.materials },
            entry: 'index.html', engineEntry: imports.cc, types: 'types/cc.d.ts', template: 'template',
            delivery: 'PREBUILT',
            typeFiles: (await inventory(types)).map(file => `types/${file.path}`),
            gameCompiler: { entry: 'tools/devkit/runtime/compile-game.cjs', export: 'compileGame',
                dependencies: 'compiler-dependencies.json', dependencyCount: compilerClosure.packages.length,
                sourceFiles: ['tools/devkit/runtime/compile-game.cjs', 'tools/devkit/runtime/files.cjs'],
                requiresEngineCheckout: true },
            validationLevels: { engineTypecheck: true, engineBuild: true, builtinIntegrity: true,
                gameTypecheck: true, loaderTypecheck: true, browserFirstFrame: false, browserInteraction: false,
                vendorBuild: false, device: false, portableSDK: false },
            limitations: ['Maintainer source build, not a portable SDK release',
                'Browser evidence is a separate hash-bound report, not inferred from compilation',
                'Engine/compiler/loader redistribution license review remains required'],
            files: await inventory(staging),
        };
        await writeJson('runtime.json', descriptor);
        await assertAbsent(output);
        await fs.rename(staging, output);
        staging = undefined;
        return { output, descriptor: path.join(output, 'runtime.json'), profile,
            sha256: sha256(await fs.readFile(path.join(output, 'runtime.json'))), validationLevels: descriptor.validationLevels };
    } finally {
        if (staging) await fs.rm(staging, { recursive: true, force: true });
        if (loaderWork) await fs.rm(loaderWork, { recursive: true, force: true });
        await lock.close();
        await fs.unlink(`${output}.lock`);
    }
}

module.exports = { buildRuntime };
if (require.main === module) {
    if (process.argv.length !== 5) {
        console.error('Usage: node build-runtime.cjs <2d-basic|3d-basic> <builtin-directory> <absent-output-directory>');
        process.exitCode = 1;
    } else buildRuntime({ profile: process.argv[2], builtinDirectory: process.argv[3], outDirectory: process.argv[4] })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
