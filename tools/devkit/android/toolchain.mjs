#!/usr/bin/env node
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseFlags, verifyAndroidProject } from './export-apk.mjs';
import { describeApk } from './apk-file.mjs';

const run = promisify(execFile);
const executable = name => name + (process.platform === 'win32' ? '.exe' : '');
const json = value => JSON.stringify(value, null, 2) + '\n';

async function ordinary(filename) {
    try { const stat = await fs.lstat(filename); return stat.isFile() && !stat.isSymbolicLink(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function diagnoseAndroid({ project, sdk, javaHome, gradleHome, work }) {
    const checks = [];
    const check = (name, success, detail) => { checks.push({ name, success, detail }); return success; };
    const paths = { project, sdk, javaHome, gradleHome, work };
    for (const [name, value] of Object.entries(paths)) {
        if (!check(name, typeof value === 'string' && path.isAbsolute(value), 'An explicit absolute path is required.')) return { success: false, checks };
    }
    let exported;
    try { exported = await verifyAndroidProject(project); check('project inventory', true, `${exported.fileCount} generated files match.`); }
    catch (error) { check('project inventory', false, error.message); return { success: false, checks }; }
    const java = path.join(javaHome, 'bin', executable('java'));
    const javac = path.join(javaHome, 'bin', executable('javac'));
    check('JDK', await ordinary(java) && await ordinary(javac), `JDK 17..23 required: ${javaHome}`);
    let gradleJar;
    let gradleVersion;
    try {
        const jars = (await fs.readdir(path.join(gradleHome, 'lib'))).filter(name => /^gradle-(?:gradle-cli-main|launcher)-8\.(?:9|1[0-4])(?:\.\d+)?\.jar$/.test(name));
        const main = jars.find(name => name.startsWith('gradle-gradle-cli-main-')) ?? jars[0];
        if (main) { gradleJar = path.join(gradleHome, 'lib', main); gradleVersion = /-(8\.[\d.]+)\.jar$/.exec(main)[1]; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    check('Gradle', !!gradleJar, 'AGP 8.7.3 requires Gradle 8.9..8.14.x; Gradle 9 is not supported by this exporter.');
    const androidJar = path.join(sdk, 'platforms', `android-${exported.config.compileSdk}`, 'android.jar');
    check('Android platform', await ordinary(androidJar), androidJar);
    const buildTools = path.join(sdk, 'build-tools', '35.0.0');
    check('Android build tools', await ordinary(path.join(buildTools, executable('aapt2')))
        && await ordinary(path.join(buildTools, 'lib', 'apksigner.jar')), `${buildTools}: aapt2 and apksigner required.`);
    check('SDK license', await ordinary(path.join(sdk, 'licenses', 'android-sdk-license')), 'Android SDK license must already be accepted by the toolchain owner.');
    if (checks.find(item => item.name === 'JDK')?.success) {
        try {
            const result = await run(java, ['-version'], { windowsHide: true, timeout: 15000, maxBuffer: 32768 });
            const version = /version "(?:1\.)?(\d+)/.exec(result.stderr + result.stdout)?.[1];
            const major = Number(version);
            const minor = Number(gradleVersion?.split('.')[1]);
            const supported = major >= 17 && major <= 23 && (major <= 22 || minor >= 10);
            check('Java version', supported, `${(result.stderr + result.stdout).trim().split('\n')[0]}; use JDK 17 or 21 with Gradle 8.9+.`);
        } catch (error) { check('Java version', false, error.message); }
    }
    return { success: checks.every(item => item.success), checks, java, gradleJar, gradleVersion, androidJar,
        config: exported.config, paths };
}

export async function buildAndroid(options) {
    const diagnostic = await diagnoseAndroid(options);
    if (!diagnostic.success) return { ...diagnostic, apkBuilt: false };
    const variant = options.variant ?? 'debug';
    const offline = options.offline ?? true;
    if (!['debug', 'release'].includes(variant) || typeof offline !== 'boolean') throw new Error('variant is debug/release and offline is boolean.');
    if (diagnostic.config.dynamicBackend && variant !== 'debug') throw new Error('dynamicBackend is only supported for a debug APK. Export a fixed backend for release.');
    const project = await fs.realpath(options.project);
    const work = path.resolve(options.work);
    if (process.platform === 'win32' && !/^D:\\/i.test(work)) throw new Error('Windows build work must be under D:\\ (repository work-directory policy).');
    const relative = path.relative(project, work);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Keep build work outside the generated project.');
    await fs.mkdir(work, { recursive: true });
    const temporary = path.join(work, 'tmp');
    const user = path.join(work, 'user');
    const gradleUser = path.join(work, 'gradle');
    const androidUser = path.join(work, 'android');
    for (const directory of [temporary, user, gradleUser, androidUser]) await fs.mkdir(directory, { recursive: true });
    const env = { ...process.env, JAVA_HOME: options.javaHome, ANDROID_HOME: options.sdk, ANDROID_SDK_ROOT: options.sdk,
        TEMP: temporary, TMP: temporary, TMPDIR: temporary, GRADLE_USER_HOME: gradleUser,
        ANDROID_USER_HOME: androidUser, ANDROID_EMULATOR_HOME: path.join(androidUser, 'emulator'),
        ANDROID_AVD_HOME: path.join(androidUser, 'avd'), JAVA_TOOL_OPTIONS: '', _JAVA_OPTIONS: '', JDK_JAVA_OPTIONS: '', GRADLE_OPTS: '' };
    const args = [`-Djava.io.tmpdir=${temporary}`, `-Duser.home=${user}`, '-classpath', diagnostic.gradleJar,
        'org.gradle.launcher.GradleMain', '--no-daemon', '--console=plain', '--stacktrace', '--max-workers=2',
        `-Dorg.gradle.java.home=${options.javaHome}`, `-Dorg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8 -Djava.io.tmpdir=${temporary} -Duser.home=${user}`,
        ...(offline ? ['--offline'] : []), variant === 'debug' ? ':app:assembleDebug' : ':app:assembleRelease'];
    const log = path.join(work, `assemble-${variant}.log`);
    try {
        // Direct Java invocation avoids cmd/batch quoting. The explicit Gradle installation is trusted code.
        const result = await run(diagnostic.java, args, { cwd: project, env, windowsHide: true,
            timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 ** 2 });
        await fs.writeFile(log, result.stdout + result.stderr);
    } catch (error) {
        await fs.writeFile(log, (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message);
        return { success: false, apkBuilt: false, code: 'GRADLE_BUILD_FAILED', log, checks: diagnostic.checks,
            detail: offline ? 'Check log. Offline mode requires a prepared Gradle cache; --offline false explicitly permits Gradle dependency resolution.' : 'Check log for SDK/dependency/compiler diagnostics.' };
    }
    const apk = path.join(project, 'app', 'build', 'outputs', 'apk', variant, variant === 'debug' ? 'app-debug.apk' : 'app-release-unsigned.apk');
    const artifact = await describeApk(apk);
    const result = { success: true, apkBuilt: true, deviceTested: false, signed: variant === 'debug',
        signing: variant === 'debug' ? 'Android debug key (testing only)' : 'Unsigned release; sign with your own release key.',
        apk, ...artifact, variant, log,
        toolchain: { java: diagnostic.java, gradle: diagnostic.gradleVersion, sdk: options.sdk } };
    await fs.writeFile(path.join(work, `assemble-${variant}.json`), json(result));
    return result;
}

async function main(args) {
    const command = args.shift();
    if (!['doctor', 'build'].includes(command)) throw new Error('Use doctor or build. See android/README.md.');
    const flags = parseFlags(args, ['--project', '--sdk', '--java-home', '--gradle-home', '--work', '--variant', '--offline']);
    if (flags['--offline'] && !['true', 'false'].includes(flags['--offline'])) throw new Error('--offline must be true or false.');
    const options = { project: flags['--project'], sdk: flags['--sdk'], javaHome: flags['--java-home'],
        gradleHome: flags['--gradle-home'], work: flags['--work'], variant: flags['--variant'], offline: flags['--offline'] !== 'false' };
    const result = command === 'doctor' ? await diagnoseAndroid(options) : await buildAndroid(options);
    console.log(json(result));
    if (!result.success) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => { console.error(json({ success: false, message: error.message })); process.exitCode = 1; });
}
