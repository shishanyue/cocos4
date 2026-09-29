const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const path = require('node:path');
const { promisify } = require('node:util');
const { profiles } = require('../effects/builtin-inputs.cjs');
const { readBuiltins } = require('../runtime/builtins.cjs');
const { compileGame } = require('../runtime/compile-game.cjs');
const { makeFixtureAssets } = require('../runtime/make-fixture-assets.cjs');
const { compilerDependencies } = require('../runtime/compiler-dependencies.cjs');
const { assertAbsent, inventory, sha256 } = require('../runtime/files.cjs');
const { prepareBilibili } = require('../runtime/prepare-bilibili.cjs');
const { prepareLoader } = require('../runtime/prepare-loader.cjs');

const engine = path.resolve(__dirname, '../../..');
const runtime = path.resolve(__dirname, '../runtime');
const rootRequire = createRequire(path.join(engine, 'package.json'));
const execute = promisify(execFile);

async function buildRuntime({ profile, builtinDirectory, outDirectory, target = 'HTML5', variant = 'debug' }) {
    assert.ok(['HTML5', 'BILIBILI'].includes(target), `TARGET_NOT_AVAILABLE: ${target}`);
    assert.ok(['debug', 'release'].includes(variant), `VARIANT_NOT_AVAILABLE: ${variant}`);
    const release = variant === 'release';
    const bilibili = target === 'BILIBILI';
    const engineDirectory = bilibili ? 'cocos-js' : 'engine';
    const loaderPlatform = bilibili ? 'bilibili' : 'web-desktop';
    assert.ok(Object.hasOwn(profiles, profile), `PROFILE_NOT_AVAILABLE: ${profile}`);
    assert.equal(typeof builtinDirectory, 'string');
    assert.equal(typeof outDirectory, 'string');
    const output = path.resolve(outDirectory);
    const parent = await fs.realpath(path.dirname(output));
    assert.equal(parent, path.dirname(output), 'Output parent must be canonical, without symlinks');
    await assertAbsent(output);
    const evidence = `${output}.evidence`;
    await assertAbsent(evidence);
    const builtin = await readBuiltins({ engine, profile, builtinDirectory });
    const lock = await fs.open(`${output}.lock`, 'wx');
    let staging;
    let loaderWork;
    let evidenceStaging;
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
        const { StatsQuery } = rootRequire('@cocos/ccbuild');
        const stats = await StatsQuery.create(engine);
        const features = [...profiles[profile]];
        assert.ok(features.every(feature => stats.hasFeature(feature)));
        const flags = { ...stats.getOverriddenConstantsOfFeatures(features),
            DEBUG: !release, NATIVE: false, JSB: false, EDITOR: false, PREVIEW: false };
        const constants = stats.constantManager.genBuildTimeConstants({ platform: target, mode: 'BUILD', flags });
        for (const name of ['NATIVE', 'JSB', 'EDITOR', 'PREVIEW', 'TEST', 'NODEJS']) assert.equal(constants[name], false, name);
        assert.equal(constants.BUILD, true);
        assert.equal(constants.DEBUG, !release);
        for (const name of ['MINIGAME', 'BILIBILI']) assert.equal(constants[name], bilibili, name);
        assert.equal(constants.HTML5, !bilibili);
        assert.equal(constants.WECHAT, false);
        const subprocess = { cwd: engine, timeout: 300000, maxBuffer: 16 * 1024 * 1024 };
        const checkedExecute = async (...args) => {
            const result = await execute(...args);
            if (result.stdout) process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            return result;
        };
        const buildStage = (stage, options, execution = subprocess) => checkedExecute(process.execPath,
            ['--max-old-space-size=2048', path.join(runtime, 'build-stage.cjs'), stage, JSON.stringify(options)], execution);
        // The untargeted legacy Babel path miscompiles captured loop bindings in program-lib.
        // This is a syntax target only, not a claim of vendor host compatibility.
        const targets = { chrome: '100' };
        await checkedExecute(process.execPath, [rootRequire.resolve('typescript/bin/tsc'), '--noEmit', '--project', path.join(engine, 'tsconfig.json')], subprocess);
        const engineOptions = { platform: target, mode: 'BUILD', moduleFormat: 'system', features, flags,
            compress: release, sourceMap: false, split: false, targets };
        await buildStage('engine', { engine, out: path.join(staging, engineDirectory), ...engineOptions, report: path.join(staging, 'engine-build.json') });
        const result = JSON.parse(await fs.readFile(path.join(staging, 'engine-build.json'), 'utf8'));
        assert.equal(result.hasCriticalWarns, false, 'Critical engine build warnings');
        assert.ok(result.exports.cc, 'Missing cc entry');
        const types = path.join(staging, 'types');
        await buildStage('types', { engine, outDirectory: types, workDirectory: staging });

        // Isolate types explicitly, even when preparation stays inside the engine checkout.
        loaderWork = await fs.mkdtemp(path.join(parent, '.runtime-loader-'));
        const loader = await prepareLoader(loaderWork);
        const loaderRequire = createRequire(path.join(loader, 'package.json'));
        await checkedExecute(process.execPath, [loaderRequire.resolve('@cocos/typescript/bin/tsc'), '--noEmit', '--pretty', 'false',
            '--project', path.join(loader, 'lib/tsconfig.json')], { ...subprocess, cwd: loaderWork });
        const loaderOptions = { platform: loaderPlatform, sourceMap: false, minify: release, hmr: false, editor: false };
        const loaderResult = await buildStage('loader', { loader, buildOptions: { ...loaderOptions, out: path.join(staging, 'loader.js') } },
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
        if (bilibili) await prepareBilibili({ engine, output: staging });
        const game = await compileGame({ projectDirectory: path.join(staging, 'template'), typesDirectory: types, outDirectory: path.join(staging, 'game'), variant });
        await fs.cp(path.join(staging, 'template/assets'), path.join(staging, 'assets/game'), { recursive: true });
        await writeJson('game-compiler.json', game);
        const imports = { cc: `./${engineDirectory}/${result.exports.cc}`,
            'virtual:///prerequisite-imports/internal': './internal-prerequisites.js' };
        for (const [alias, file] of Object.entries(result.chunkAliases)) imports[alias] = `./${engineDirectory}/${file}`;
        await writeJson('import-map.json', { imports });
        await writeJson('settings.json', {
            ...builtin.settings,
            rendering: { ...builtin.settings.rendering, renderMode: 2 },
            screen: { designResolution: { width: 640, height: 480, policy: 4 }, frameRate: 60 },
            splashScreen: { totalTime: 0 },
            assets: { projectBundles: ['internal'], preloadBundles: [], preloadAssets: [] },
            scripting: { scriptPackages: [] }, launch: { launchScene: '' }, profiling: { showFPS: false },
        });
        for (const name of bilibili ? ['internal-prerequisites.js'] : ['index.html', 'boot.js', 'internal-prerequisites.js']) {
            await fs.copyFile(path.join(runtime, name), path.join(staging, name));
        }
        if (release) {
            const { transformAsync } = rootRequire('@babel/core');
            for (const name of bilibili ? ['game.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js', 'internal-prerequisites.js']
                : ['boot.js', 'internal-prerequisites.js']) {
                const { code, map } = await transformAsync(await fs.readFile(path.join(staging, name), 'utf8'), {
                    sourceType: 'script', babelrc: false, configFile: false, browserslistConfigFile: false,
                    sourceMaps: false, minified: true, compact: true, comments: false,
                    shouldPrintComment: comment => /@license|@preserve|copyright|permission is hereby granted/i.test(comment),
                });
                assert.ok(code && !map, `Missing compressed bootstrap: ${name}`);
                await fs.writeFile(path.join(staging, name), code);
            }
        }
        await fs.copyFile(path.join(engine, 'LICENSE'), path.join(staging, 'ENGINE-LICENSE'));
        const descriptor = {
            schemaVersion: 1, kind: bilibili ? 'cocos4-bilibili-runtime' : 'cocos4-html5-runtime', profile, target, mode: 'BUILD', variant,
            moduleFormat: 'system', sourceMap: false, compressed: release, features, constants, targets,
            buildOptions: { engine: engineOptions, loader: { ...loaderOptions, minifierWorkers: 1 }, game: game.emission,
                bootstrap: { minified: release, sourceMaps: false, comments: release ? 'license-only' : 'preserve' } },
            engineVersion: rootRequire('./package.json').version,
            rootLockSha256: sha256(rootLockBytes),
            tools: { ccbuild: '2.3.21', moduleSystem: '0.0.21', loaderPlatform, ...game },
            builtins: { report: 'builtin-report.json', reportSha256: builtin.reportSha256,
                effects: builtin.report.effects, materials: builtin.report.materials },
            entry: bilibili ? 'game.js' : 'index.html', engineEntry: imports.cc, types: 'types/cc.d.ts', template: 'template',
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
                bilibili ? 'Local mocked lifecycle evidence is separate and hash-bound; vendor compilation and device rendering are unverified'
                    : 'Browser evidence is a separate hash-bound report, not inferred from compilation',
                ...(bilibili ? ['Syntax targets: engine Chrome 100; prepared adapters Chrome 66; game compiler removes TS/decorators without preset-env; launcher/Application use ES2017; loader TypeScript target ES2021, module ES2022, Rollup IIFE',
                    'game.json appId/version are explicit local-validation placeholders, not vendor credentials'] : []),
                'Engine/compiler/loader redistribution license review remains required'],
            files: await inventory(staging),
        };
        await writeJson('runtime.json', descriptor);
        evidenceStaging = await fs.mkdtemp(path.join(parent, '.runtime-evidence-'));
        await fs.writeFile(path.join(evidenceStaging, 'builtin-result.json'), builtin.executionBytes, { flag: 'wx' });
        await fs.writeFile(path.join(evidenceStaging, 'receipt.json'), JSON.stringify({
            schemaVersion: 1, kind: 'cocos4-runtime-execution-receipt',
            runtimeSha256: sha256(await fs.readFile(path.join(staging, 'runtime.json'))),
            builtinIdentitySha256: builtin.reportSha256, files: await inventory(evidenceStaging),
        }, null, 2) + '\n', { flag: 'wx' });
        // Publish evidence first, without replacement. An interrupted publication
        // may leave a receipt, never a successful runtime whose evidence was lost.
        const { publishSdk } = await import('./prepare-sdk.mjs');
        await publishSdk(evidenceStaging, evidence);
        evidenceStaging = undefined;
        await assertAbsent(output);
        await publishSdk(staging, output);
        staging = undefined;
        return { output, evidence, descriptor: path.join(output, 'runtime.json'), target, profile, variant,
            sha256: sha256(await fs.readFile(path.join(output, 'runtime.json'))), validationLevels: descriptor.validationLevels };
    } finally {
        if (staging) await fs.rm(staging, { recursive: true, force: true });
        if (loaderWork) await fs.rm(loaderWork, { recursive: true, force: true });
        if (evidenceStaging) await fs.rm(evidenceStaging, { recursive: true, force: true });
        await lock.close();
        await fs.unlink(`${output}.lock`);
    }
}

module.exports = { buildRuntime };
if (require.main === module) {
    if (![5, 6, 7].includes(process.argv.length)) {
        console.error('Usage: node build-runtime.cjs <2d-basic|3d-basic> <builtin-directory> <absent-output-directory> [HTML5|BILIBILI] [debug|release]');
        process.exitCode = 1;
    } else buildRuntime({ profile: process.argv[2], builtinDirectory: process.argv[3], outDirectory: process.argv[4], target: process.argv[5], variant: process.argv[6] })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
