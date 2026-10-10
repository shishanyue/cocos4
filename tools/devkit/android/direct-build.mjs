#!/usr/bin/env node
// Build the dependency-free HTML5 shell with an explicitly selected, installed SDK.
// This invokes Android's packaging tools only; no Gradle, downloads, NATIVE or JSB.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseFlags, verifyAndroidProject } from './export-apk.mjs';
import { describeApk } from './apk-file.mjs';
import { normalizeZipEntryNames } from './zip-name-normalizer.mjs';

const execute = promisify(execFile);
const suffix = process.platform === 'win32' ? '.exe' : '';
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function within(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function directory(value, name, create = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('PATH_INVALID', `${name} must be an explicit absolute path.`);
    const resolved = path.resolve(value);
    if (create) await fs.mkdir(resolved, { recursive: true });
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(await fs.realpath(resolved), resolved) !== '') {
        fail('PATH_INVALID', `${name} must be an ordinary directory without aliases: ${resolved}`);
    }
    return resolved;
}

async function requireFile(filename) {
    let stat;
    try { stat = await fs.lstat(filename); } catch (error) {
        if (error.code === 'ENOENT') fail('TOOLCHAIN_MISSING', `Required installed tool/file is missing: ${filename}`);
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('TOOLCHAIN_INVALID', `Expected an ordinary tool/file: ${filename}`);
    return filename;
}

async function filesUnder(root, extension) {
    const files = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const filename = path.join(root, entry.name);
        if (entry.isDirectory()) files.push(...await filesUnder(filename, extension));
        else if (entry.isFile() && entry.name.endsWith(extension)) files.push(filename);
    }
    return files.sort();
}

export async function buildDirect({ project, sdk, javaHome, work, variant = 'debug', platform = 36, buildTools = '36.0.0' }) {
    if (!['debug', 'release'].includes(variant)) fail('CONFIG_INVALID', 'variant must be debug or release.');
    if (!Number.isInteger(platform) || platform < 26 || platform > 100 || !/^\d+\.\d+\.\d+$/.test(buildTools)) {
        fail('CONFIG_INVALID', 'platform must be an Android API level and buildTools an installed stable version.');
    }
    project = await directory(project, 'project');
    sdk = await directory(sdk, 'sdk');
    javaHome = await directory(javaHome, 'javaHome');
    if (typeof work !== 'string' || !path.isAbsolute(work)) fail('PATH_INVALID', 'work must be an explicit absolute path.');
    work = path.resolve(work);
    if (process.platform === 'win32' && !/^D:\\/i.test(work)) fail('PATH_INVALID', 'Windows build work must be on D: (repository work-directory policy).');
    if ([project, sdk, javaHome].some(root => within(root, work) || within(work, root))) fail('PATH_OVERLAP', 'Build work must be separate from the project, SDK and JDK.');
    const exported = await verifyAndroidProject(project);
    const config = exported.config;
    if (config.dynamicBackend && variant !== 'debug') fail('CONFIG_INVALID', 'dynamicBackend is only supported for a debug APK. Export a fixed backend for release.');
    if (platform < config.compileSdk) fail('PLATFORM_TOO_OLD', `Installed platform ${platform} is older than project compileSdk ${config.compileSdk}.`);
    const androidJar = await requireFile(path.join(sdk, 'platforms', `android-${platform}`, 'android.jar'));
    const toolsRoot = path.join(sdk, 'build-tools', buildTools);
    const java = await requireFile(path.join(javaHome, 'bin', 'java' + suffix));
    const javac = await requireFile(path.join(javaHome, 'bin', 'javac' + suffix));
    const jar = await requireFile(path.join(javaHome, 'bin', 'jar' + suffix));
    const keytool = variant === 'debug' ? await requireFile(path.join(javaHome, 'bin', 'keytool' + suffix)) : undefined;
    const aapt2 = await requireFile(path.join(toolsRoot, 'aapt2' + suffix));
    const zipalign = await requireFile(path.join(toolsRoot, 'zipalign' + suffix));
    const d8 = await requireFile(path.join(toolsRoot, 'lib', 'd8.jar'));
    const apksigner = await requireFile(path.join(toolsRoot, 'lib', 'apksigner.jar'));
    work = await directory(work, 'work', true);
    const run = await fs.mkdtemp(path.join(work, `direct-${variant}-`));
    const temporary = path.join(run, 'tmp');
    const user = path.join(run, 'user');
    const androidUser = path.join(run, 'android');
    const generated = path.join(run, 'generated');
    const classes = path.join(run, 'classes');
    const dex = path.join(run, 'dex');
    const source = path.join(run, 'source');
    for (const item of [temporary, user, androidUser, generated, classes, dex, source]) await fs.mkdir(item);
    const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
        TEMP: temporary, TMP: temporary, TMPDIR: temporary, GRADLE_USER_HOME: path.join(run, 'gradle'),
        ANDROID_USER_HOME: androidUser, ANDROID_EMULATOR_HOME: path.join(androidUser, 'emulator'),
        ANDROID_AVD_HOME: path.join(androidUser, 'avd') };
    for (const option of ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'GRADLE_OPTS']) delete env[option];
    const jvm = [`-Djava.io.tmpdir=${temporary}`, `-Duser.home=${user}`, '-Duser.language=en', '-Duser.country=US', '-Dfile.encoding=UTF-8'];
    const jdkJvm = jvm.map(argument => '-J' + argument);
    const log = path.join(run, 'build.log');
    const steps = [];
    async function call(name, executable, args) {
        await fs.appendFile(log, `\n[${name}]\n`);
        try {
            const result = await execute(executable, args, { cwd: run, env, windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 ** 2 });
            await fs.appendFile(log, result.stdout + result.stderr);
            steps.push({ name, success: true });
            return result.stdout + result.stderr;
        } catch (error) {
            await fs.appendFile(log, (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message + '\n');
            steps.push({ name, success: false });
            fail('ANDROID_TOOL_FAILED', `${name} failed; see ${log}`);
        }
    }
    try {
        const javaVersion = await call('Java version', java, [...jvm, '-version']);
        const major = Number(/version "(?:1\.)?(\d+)/.exec(javaVersion)?.[1]);
        if (major < 17 || major > 23 || !Number.isInteger(major)) fail('JAVA_UNSUPPORTED', 'Use an installed JDK 17..23 (JDK 21 recommended).');
        // Snapshot only inventoried shell sources/assets. Do not run or copy Gradle code.
        const receipt = JSON.parse(await fs.readFile(path.join(project, 'cocos4-android-export.json'), 'utf8'));
        const sourcePrefix = 'app/src/main/';
        for (const item of receipt.files.filter(item => item.path.startsWith(sourcePrefix))) {
            const bytes = await fs.readFile(path.join(project, item.path));
            if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) fail('PROJECT_CHANGED', `Project changed while copying: ${item.path}`);
            const destination = path.join(source, item.path.slice(sourcePrefix.length));
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, bytes, { flag: 'wx' });
        }
        let manifest = await fs.readFile(path.join(source, 'AndroidManifest.xml'), 'utf8');
        if (/\bpackage\s*=/.test(manifest) || /android:debuggable\s*=/.test(manifest)) fail('MANIFEST_UNSUPPORTED', 'Direct build expects the exported manifest without package/debuggable overrides.');
        manifest = manifest.replace('<manifest ', `<manifest package="${xml(config.appId)}" `)
            .replace('<application', `<application android:debuggable="${variant === 'debug'}"`);
        await fs.writeFile(path.join(source, 'AndroidManifest.xml'), manifest);
        const resources = path.join(run, 'resources.zip');
        await call('Compile Android resources', aapt2, ['compile', '--dir', path.join(source, 'res'), '-o', resources]);
        const linked = path.join(run, 'linked.apk');
        await call('Link Android resources and assets', aapt2, ['link', '-o', linked, '--manifest', path.join(source, 'AndroidManifest.xml'),
            '-I', androidJar, '-A', path.join(source, 'assets'), '--java', generated, '--min-sdk-version', String(config.minSdk),
            '--target-sdk-version', String(config.targetSdk), '--version-code', String(config.versionCode), '--version-name', config.versionName,
            '--compile-sdk-version-code', String(platform), ...['wasm', 'data', 'bin', 'mp3', 'ogg', 'mp4', 'webm'].flatMap(extension => ['-0', extension]), resources]);
        await fs.writeFile(path.join(generated, 'BuildConfig.java'), `package ${config.appId};\npublic final class BuildConfig { public static final boolean DEBUG = ${variant === 'debug'}; }\n`);
        const sources = [...await filesUnder(path.join(source, 'java'), '.java'), ...await filesUnder(generated, '.java')];
        await call('Compile Java shell', javac, [...jdkJvm, '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-bootclasspath', androidJar, '-d', classes, ...sources]);
        const classJar = path.join(run, 'classes.jar');
        await call('Package Java classes', jar, [...jdkJvm, '--create', '--file', classJar, '--no-manifest', '-C', classes, '.']);
        await call('Compile Android DEX', java, [...jvm, '-cp', d8, 'com.android.tools.r8.D8', '--lib', androidJar,
            '--min-api', String(config.minSdk), '--output', dex, classJar]);
        const dexFiles = (await fs.readdir(dex)).filter(name => /^classes(?:\d+)?\.dex$/.test(name)).sort();
        if (!dexFiles.length) fail('DEX_MISSING', 'D8 did not produce classes.dex.');
        await call('Add DEX to APK', jar, [...jdkJvm, '--update', '--file', linked, ...dexFiles.flatMap(name => ['-C', dex, name])]);
        // Windows aapt2 and jar store asset names with backslash separators (assets/www\index.html).
        // Android AssetManager resolves "www/index.html" as an exact "assets/www/index.html" lookup,
        // so an archive left unnormalized 404s every local asset on device. Rewrite only the ZIP name
        // fields here, after the last tool that writes entries and before alignment and signing.
        const normalized = await normalizeZipEntryNames(linked);
        steps.push({ name: 'Normalize ZIP entry names', success: true, entries: normalized.entries,
            backslashNamesBefore: normalized.backslashNamesBefore, patchedLocalNames: normalized.patchedLocalNames,
            patchedCentralNames: normalized.patchedCentralNames });
        const aligned = path.join(run, 'app-release-unsigned.apk');
        await call('Align APK', zipalign, ['-P', '16', '-f', '4', linked, aligned]);
        let apk = aligned;
        let keystore;
        if (variant === 'debug') {
            // Reusing this explicit work directory preserves the install/update identity.
            keystore = path.join(work, 'debug.keystore');
            const keyReceipt = path.join(work, 'debug-key.json');
            let existing;
            try { existing = await fs.lstat(keystore); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (existing) {
                if (!existing.isFile() || existing.isSymbolicLink()) fail('DEBUG_KEY_INVALID', 'Debug key must be an ordinary file.');
                const identity = JSON.parse(await fs.readFile(keyReceipt, 'utf8'));
                if (identity.kind !== 'cocos4-testing-debug-key' || identity.sha256 !== digest(await fs.readFile(keystore))) fail('DEBUG_KEY_INVALID', 'Existing key is not owned by this exporter. Select another work directory.');
            } else {
                await call('Generate testing-only debug key', keytool, [...jdkJvm, '-genkeypair', '-keystore', keystore, '-storetype', 'JKS',
                    '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048',
                    '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US', '-noprompt']);
                await fs.writeFile(keyReceipt, json({ kind: 'cocos4-testing-debug-key', sha256: digest(await fs.readFile(keystore)) }), { flag: 'wx' });
            }
            apk = path.join(run, 'app-debug.apk');
            await call('Sign debug APK', java, [...jvm, '-jar', apksigner, 'sign', '--ks', keystore, '--ks-key-alias', 'androiddebugkey',
                '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', apk, aligned]);
            await call('Verify APK signature', java, [...jvm, '-jar', apksigner, 'verify', '--verbose', '--print-certs', apk]);
        }
        await call('Verify APK alignment', zipalign, ['-c', '-P', '16', '4', apk]);
        const badging = await call('Inspect packaged manifest', aapt2, ['dump', 'badging', apk]);
        if (!badging.includes(`package: name='${config.appId}'`) || !badging.includes(`targetSdkVersion:'${config.targetSdk}'`)) {
            fail('APK_MANIFEST_MISMATCH', 'Packaged manifest does not match the application ID and target SDK.');
        }
        const artifact = await describeApk(apk);
        const result = { success: true, apkBuilt: true, deviceTested: false, signed: variant === 'debug',
            signing: variant === 'debug' ? 'Android debug key (testing only; reuse this work directory to update the installation).' : 'Unsigned release; sign with your own release key.',
            apk, ...artifact, variant, project, log, steps, ...(keystore ? { keystore } : {}),
            zipNames: { entries: normalized.entries, backslashNamesBefore: normalized.backslashNamesBefore,
                patchedEntries: normalized.patchedEntries, patchedLocalNames: normalized.patchedLocalNames,
                patchedCentralNames: normalized.patchedCentralNames },
            toolchain: { route: 'installed-sdk-direct', java, javaVersion: javaVersion.match(/^(?:openjdk|java) version [^\r\n]+/m)?.[0] ?? javaVersion.trim().split('\n')[0], sdk, platform, buildTools,
                projectCompileSdk: config.compileSdk, minSdk: config.minSdk, targetSdk: config.targetSdk, dependencyDownloads: false } };
        await fs.writeFile(path.join(run, 'build.json'), json(result));
        return result;
    } catch (error) {
        const result = { success: false, apkBuilt: false, deviceTested: false, code: error.code ?? 'DIRECT_BUILD_FAILED', detail: error.message, log, steps };
        await fs.writeFile(path.join(run, 'build.json'), json(result));
        return result;
    }
}

async function main(args) {
    const flags = parseFlags(args, ['--project', '--sdk', '--java-home', '--work', '--variant', '--platform', '--build-tools']);
    const result = await buildDirect({ project: flags['--project'], sdk: flags['--sdk'], javaHome: flags['--java-home'],
        work: flags['--work'], variant: flags['--variant'], platform: flags['--platform'] === undefined ? 36 : Number(flags['--platform']), buildTools: flags['--build-tools'] });
    console.log(json(result));
    if (!result.success) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => { console.error(json({ success: false, apkBuilt: false, code: error.code ?? 'DIRECT_BUILD_FAILED', detail: error.message })); process.exitCode = 1; });
}
