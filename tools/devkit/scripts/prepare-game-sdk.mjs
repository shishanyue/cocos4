// Trusted-maintainer packaging, not an engine build or a user-project installer.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, TextDecoder } from 'node:util';
import { browserReportSchema, canonical, compilerClosureSchema, hash, loadSdk, parseJson,
    runtimeDescriptorSchema, sdkPathSchema, validateCompilerClosure, validateRuntime } from '../build/src/sdk.js';
import { publishSdk } from './prepare-sdk.mjs';

const run = promisify(execFile);
const engineDefault = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const maximumBytes = 512 * 1024 * 1024;
const maximumFiles = 20000;
const levels = ['engineTypecheck', 'engineBuild', 'builtinIntegrity', 'gameTypecheck', 'loaderTypecheck', 'browserFirstFrame', 'browserInteraction'];
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function prepareGameSdk({ base, runtimes, out, engineRoot = engineDefault }) {
    assert.ok(Array.isArray(runtimes) && runtimes.length >= 2 && runtimes.length <= 16,
        'Both real 2d-basic and 3d-basic runtime/report pairs are required');
    runtimes = runtimes.map(item => {
        assert.ok(item && typeof item.runtime === 'string', 'Expected a runtime directory or runtime.json');
        const runtime = item.runtime.endsWith('/runtime.json') ? path.dirname(item.runtime) : item.runtime;
        return { runtime, browserReport: item.browserReport ?? `${runtime}-browser/browser-report.json` };
    });
    for (const value of [base, out, engineRoot, ...runtimes.flatMap(item => [item.runtime, item.browserReport])]) {
        assert.ok(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && !value.includes('\0'), 'Expected canonical absolute paths');
    }
    const parent = path.dirname(out);
    assert.equal(await realpath(parent), parent, 'Output parent must be canonical');
    assert.ok((await lstat(parent)).isDirectory());
    const absent = async () => {
        try { await lstat(out); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw new Error('OUTPUT_CONFLICT: destination already exists, even if empty.');
    };
    await absent();
    const readonly = await loadSdk(base);
    assert.equal(readonly.manifest.kind, 'readonly-development', '--base must be a validated readonly-development pack');
    const observed = new Map();
    const directory = async absolute => {
        const stat = await lstat(absolute);
        assert.ok(stat.isDirectory() && await realpath(absolute) === absolute, `Unsafe directory: ${absolute}`);
        observed.set(absolute, stat);
    };
    const read = async (root, relative, maximum = 128 * 1024 * 1024) => {
        sdkPathSchema.parse(relative);
        const absolute = path.join(root, relative);
        assert.equal(await realpath(absolute), absolute, `Source symlinks are not allowed: ${relative}`);
        const before = await lstat(absolute);
        assert.ok(before.isFile() && before.nlink === 1 && before.size <= maximum, `Invalid source file: ${relative}`);
        const previous = observed.get(absolute);
        assert.ok(!previous || (previous.dev === before.dev && previous.ino === before.ino && previous.size === before.size
            && previous.mtimeMs === before.mtimeMs && previous.ctimeMs === before.ctimeMs), `Source changed between reads: ${relative}`);
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await handle.stat();
            assert.ok(stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size, `Source replaced: ${relative}`);
            const bytes = Buffer.alloc(stat.size + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
                if (!bytesRead) break;
                offset += bytesRead;
            }
            const after = await handle.stat();
            assert.ok(offset === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs,
                `Source changed: ${relative}`);
            observed.set(absolute, stat);
            return bytes.subarray(0, offset);
        } finally { await handle.close(); }
    };
    let sourceEntries = 0;
    const walk = async (root, skipDependencies = false, prefix = '', files = []) => {
        await directory(path.join(root, prefix));
        for (const entry of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
            if (skipDependencies && !prefix && entry.name === 'node_modules') continue;
            assert.ok(++sourceEntries <= 40000, 'Source entry count exceeds bounds');
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            sdkPathSchema.parse(relative);
            assert.ok(entry.isFile() || entry.isDirectory(), `Special files/symlinks are not allowed: ${relative}`);
            if (entry.isDirectory()) await walk(root, skipDependencies, relative, files);
            else { files.push(relative); assert.ok(files.length <= maximumFiles, 'Source file count exceeds bounds'); }
        }
        return files;
    };
    let staging;
    let checks;
    try {
        staging = await mkdtemp(path.join(parent, '.cocos4-game-sdk-staging-'));
        checks = await mkdtemp(path.join(parent, '.cocos4-game-sdk-checks-'));
        const files = [];
        const names = new Set();
        let bytesTotal = 0;
        const write = async (relative, bytes, mode = 0o644) => {
            sdkPathSchema.parse(relative);
            assert.ok(!names.has(relative.toLowerCase()), `Duplicate destination: ${relative}`);
            names.add(relative.toLowerCase());
            bytesTotal += bytes.length;
            assert.ok(bytesTotal <= maximumBytes && files.length < maximumFiles, 'SDK exceeds packaging bounds');
            await mkdir(path.dirname(path.join(staging, relative)), { recursive: true });
            await writeFile(path.join(staging, relative), bytes, { flag: 'wx', mode });
            const item = { path: relative, bytes: bytes.length, sha256: hash(bytes) };
            files.push(item);
            return item;
        };
        const copy = async (root, file, destination = file.path) => {
            const bytes = await read(root, file.path);
            assert.ok(bytes.length === file.bytes && hash(bytes) === file.sha256, `Source inventory mismatch: ${file.path}`);
            return write(destination, bytes);
        };
        for (const file of readonly.manifest.files) await copy(base, file);
        await write('provenance/readonly-manifest.json', await read(base, 'manifest.json', 256 * 1024));
        const profiles = [];
        const templates = [];
        let closureBytes;
        let closure;
        for (const input of runtimes) {
            const bytes = await read(input.runtime, 'runtime.json', 2 * 1024 * 1024);
            const descriptor = runtimeDescriptorSchema.parse(parseJson(decode(bytes)));
            const reportRoot = path.dirname(input.browserReport);
            const reportBytes = await read(reportRoot, path.basename(input.browserReport), 2 * 1024 * 1024);
            const report = browserReportSchema.parse(parseJson(decode(reportBytes)));
            validateRuntime(descriptor, report, hash(bytes));
            assert.equal(descriptor.engineVersion, readonly.manifest.engineVersion, 'Engine version differs from base SDK');
            const expected = ['runtime.json', ...descriptor.files.map(file => file.path)].sort();
            assert.deepEqual((await walk(input.runtime)).sort(), expected, 'Runtime has missing or unlisted files');
            const directory = `engine/profiles/${descriptor.target}/${descriptor.profile}/${descriptor.variant}`;
            for (const file of descriptor.files) await copy(input.runtime, file, `${directory}/${file.path}`);
            await write(`${directory}/runtime.json`, bytes);
            await write(`${directory}/evidence/browser-report.json`, reportBytes);
            for (const screenshot of report.screenshots) {
                assert.ok(screenshot.path.endsWith('.png'), 'Only PNG screenshot evidence is supported');
                const image = await read(reportRoot, screenshot.path, 16 * 1024 * 1024);
                assert.equal(hash(image), screenshot.sha256, 'Browser screenshot hash mismatch');
                assert.ok(image.length >= 24 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG evidence');
                assert.equal(image.readUInt32BE(16), screenshot.width);
                assert.equal(image.readUInt32BE(20), screenshot.height);
                await write(`${directory}/evidence/${screenshot.path}`, image);
            }
            const dependencies = await read(input.runtime, 'compiler-dependencies.json', 2 * 1024 * 1024);
            if (closureBytes) assert.ok(dependencies.equals(closureBytes), 'Runtime compiler closures differ');
            else { closureBytes = dependencies; closure = compilerClosureSchema.parse(parseJson(decode(dependencies))); }
            profiles.push({ id: descriptor.profile, target: descriptor.target, variant: descriptor.variant, directory,
                descriptor: `${directory}/runtime.json`, browserReport: `${directory}/evidence/browser-report.json`,
                exports: `${directory}/cc-exports.json`, features: descriptor.features, delivery: 'PREBUILT', validationLevels: levels });
            templates.push({ id: `${descriptor.profile}-starter`, directory: `${directory}/template`,
                profile: descriptor.profile, target: descriptor.target, variant: descriptor.variant });
        }
        assert.ok(['2d-basic', '3d-basic'].every(id => profiles.some(profile => profile.id === id)), 'Both real profiles are required');
        const sourceLock = await read(engineRoot, 'package-lock.json', 8 * 1024 * 1024);
        assert.equal(hash(sourceLock), closure.rootLockSha256, 'Compiler source lock does not match runtime provenance');
        const dependencyInventory = [];
        const packageBytes = new Map();
        // Copy each recorded package separately, never its nested node_modules. Nested
        // resolutions are independently recorded packages in this same closure.
        for (const pkg of closure.packages) {
            const root = path.join(engineRoot, pkg.path);
            packageBytes.set(pkg.path, await read(root, 'package.json', 1024 * 1024));
            assert.equal(hash(packageBytes.get(pkg.path)), pkg.packageSha256, `Compiler package changed: ${pkg.path}`);
            for (const relative of await walk(root, true)) {
                const bytes = await read(root, relative);
                const file = await write(`toolchain/${pkg.path}/${relative}`, bytes);
                dependencyInventory.push({ ...file, path: `${pkg.path}/${relative}` });
            }
        }
        dependencyInventory.sort((a, b) => a.path < b.path ? -1 : 1);
        validateCompilerClosure(closure, sourceLock, packageBytes, dependencyInventory);
        await write('toolchain/compiler-dependencies.json', closureBytes);
        await write('toolchain/source-lock.json', sourceLock);
        await write('toolchain/inventory.json', jsonBytes(dependencyInventory));
        await write('toolchain/package.json', jsonBytes({ type: 'commonjs', private: true,
            dependencies: Object.fromEntries(Object.entries(closure.roots).map(([name, relative]) =>
                [name, closure.packages.find(pkg => pkg.path === relative).version])) }));
        const sourceFiles = [];
        for (const [sourcePath, destination] of [
            ['tools/devkit/runtime/compile-game.cjs', 'toolchain/compiler/compile-game.cjs'],
            ['tools/devkit/runtime/files.cjs', 'toolchain/compiler/files.cjs'],
        ]) sourceFiles.push({ ...await write(destination, await read(engineRoot, sourcePath, 1024 * 1024)), sourcePath });

        // Read export names from the actual System.register module, not the starter's
        // requiredCCExports (which is only a small subset). Never execute the engine.
        const toolchainRoot = path.join(staging, 'toolchain');
        const ts = createRequire(path.join(toolchainRoot, 'package.json'))('typescript');
        assert.equal(ts.version, '4.9.5');
        for (const profile of profiles) {
            const engineFile = `${profile.directory}/engine/cc.js`;
            const bytes = await read(staging, engineFile);
            const ast = ts.createSourceFile('cc.js', decode(bytes), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            assert.equal(ast.parseDiagnostics.length, 0, 'Invalid prebuilt JavaScript');
            const names = new Set();
            let registrations = 0;
            const visit = node => {
                if (ts.isCallExpression(node) && node.expression.getText(ast) === 'System.register') ++registrations;
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'exports') {
                    const arg = node.arguments[0];
                    if (ts.isStringLiteral(arg)) names.add(arg.text);
                    else {
                        assert.ok(ts.isObjectLiteralExpression(arg), 'Dynamic module export names are not supported');
                        for (const property of arg.properties) {
                            assert.ok(ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)), 'Dynamic module export key');
                            names.add(property.name.text);
                        }
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
            assert.equal(registrations, 1, 'Expected a standalone System.register cc module');
            assert.ok(names.size > 100, 'Incomplete engine export inventory');
            await write(profile.exports, jsonBytes({ engineSha256: hash(bytes), names: [...names].sort() }));
            const projectDirectory = path.join(staging, profile.directory, 'template');
            const typesDirectory = path.join(staging, profile.directory, 'types');
            const outDirectory = path.join(checks, profile.id);
            const { stdout } = await run(process.execPath, ['--input-type=commonjs', '-e', `
                const Module = require('node:module');
                const resolve = Module._resolveFilename;
                Module._resolveFilename = function (...args) {
                    const resolved = resolve.apply(this, args);
                    if (!Module.isBuiltin(resolved) && !resolved.startsWith(${JSON.stringify(`${toolchainRoot}/`)})) {
                        throw new Error('Compiler resolved outside the delivered toolchain: ' + resolved);
                    }
                    return resolved;
                };
                const { compileGame } = require(${JSON.stringify(path.join(toolchainRoot, 'compiler/compile-game.cjs'))});
                compileGame(${JSON.stringify({ toolchainDirectory: toolchainRoot, projectDirectory, typesDirectory, outDirectory, availableCCExports: [...names] })})
                    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
            `], { cwd: checks, env: { PATH: '', HOME: checks, LANG: 'C', LC_ALL: 'C' }, timeout: 120000, maxBuffer: 1024 * 1024 });
            const compiled = JSON.parse(stdout);
            assert.equal(compiled.typeChecked, true);
            assert.equal(compiled.profileChecked, true);
            assert.equal(compiled.emitted, true);
            assert.equal(compiled.typeChecking.skipLibCheck, false);
            assert.equal(compiled.typeChecking.skipDefaultLibCheck, false);
            assert.ok(compiled.requiredCCExports.every(name => names.has(name)), 'Starter imports outside the actual profile');
            assert.deepEqual([...compiled.outputFiles].sort(), ['main.js', 'world.js']);
            for (const file of compiled.outputFiles) assert.ok((await read(outDirectory, file))
                .equals(await read(staging, `${profile.directory}/game/${file}`)), `Transform differs from browser-verified game: ${file}`);
        }
        const manifest = { ...readonly.manifest,
            kind: 'portable-development',
            description: 'HTML5 debug 2D/3D prebuilt development pack, editable starters and a lock-checked standalone game compiler. Requires host Node; not a portable release, vendor publisher, or device certification.',
            capabilities: { ...readonly.manifest.capabilities, gameDevelopment: true, gameBuild: true, preview: true, export: true },
            files: files.sort((a, b) => a.path < b.path ? -1 : 1),
            catalog: {
                platforms: readonly.manifest.catalog.platforms.map(platform => ({ ...platform,
                    prebuiltAvailable: profiles.some(profile => profile.target === platform.id),
                    exportAvailable: profiles.some(profile => profile.target === platform.id),
                    validationLevels: profiles.some(profile => profile.target === platform.id) ? levels : [] })),
                features: readonly.manifest.catalog.features.map(feature => ({ ...feature,
                    prebuiltAvailable: profiles.some(profile => profile.features.includes(feature.id)) })),
                profiles: profiles.sort((a, b) => a.id < b.id ? -1 : 1), templates: templates.sort((a, b) => a.id < b.id ? -1 : 1),
            },
            development: { baseSdkId: readonly.sdkId, baseManifest: 'provenance/readonly-manifest.json',
                directory: 'toolchain', compiler: 'toolchain/compiler/compile-game.cjs',
                dependencies: 'toolchain/compiler-dependencies.json', inventory: 'toolchain/inventory.json', sourceLock: 'toolchain/source-lock.json', sourceFiles,
                licenseReview: 'required', missingLicenseFiles: closure.packages.filter(pkg => !dependencyInventory.some(file =>
                    file.path.startsWith(`${pkg.path}/`) && !file.path.slice(pkg.path.length + 1).includes('node_modules/')
                    && /(?:license|copying|notice)/i.test(path.posix.basename(file.path)))).map(pkg => pkg.path),
                node: { bundled: false, minimum: '18.20.8' } },
        };
        delete manifest.sdkId;
        manifest.sdkId = `sha256-${hash(canonical(manifest))}`;
        const manifestBytes = jsonBytes(manifest);
        assert.ok(manifestBytes.length <= 8 * 1024 * 1024 && bytesTotal + manifestBytes.length <= maximumBytes, 'SDK exceeds total bounds');
        await writeFile(path.join(staging, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 });
        // Staged source files were read for static inspection; only external inputs
        // must remain unchanged while new entries are added to staging.
        for (const [absolute, before] of observed) {
            if (absolute.startsWith(`${staging}/`) || absolute.startsWith(`${checks}/`)) continue;
            const after = await lstat(absolute);
            assert.ok(after.dev === before.dev && after.ino === before.ino && after.size === before.size
                && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && await realpath(absolute) === absolute,
            `Input changed while preparing SDK: ${absolute}`);
        }
        await loadSdk(staging);
        await absent();
        await publishSdk(staging, out);
        staging = undefined;
        return { sdkId: manifest.sdkId, root: out, kind: manifest.kind, profiles: profiles.map(({ id, target, variant }) => ({ id, target, variant })),
            templates: templates.map(({ id }) => id), dependencyCount: closure.packages.length, fileCount: files.length };
    } finally {
        if (staging) await rm(staging, { recursive: true, force: true });
        if (checks) await rm(checks, { recursive: true, force: true });
    }
}

async function main() {
    const options = {};
    const runtimes = [];
    const reports = [];
    const usage = 'Usage: node scripts/prepare-game-sdk.mjs --base <absolute readonly pack> --runtime <absolute directory or runtime.json> --runtime ... [--browser-report <absolute report.json> (one per runtime, in order; default: sibling <runtime>-browser/browser-report.json)] --out <absolute absent directory> [--engine-root <absolute trusted checkout>]';
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        const value = process.argv[index + 1];
        assert.ok(value && path.isAbsolute(value), usage);
        if (key === '--runtime') {
            runtimes.push({ runtime: value });
        } else if (key === '--browser-report') {
            reports.push(value);
        } else {
            const name = { '--base': 'base', '--out': 'out', '--engine-root': 'engineRoot' }[key];
            assert.ok(name && !options[name], usage);
            options[name] = value;
        }
    }
    assert.ok(options.base && options.out && runtimes.length >= 2 && (!reports.length || reports.length === runtimes.length), usage);
    for (let index = 0; index < reports.length; ++index) runtimes[index].browserReport = reports[index];
    process.stdout.write(`${JSON.stringify(await prepareGameSdk({ ...options, runtimes }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
