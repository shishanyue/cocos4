#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportAndroid, parseFlags, verifyAndroidProject } from './export-apk.mjs';
import { buildDirect } from './direct-build.mjs';
import { buildAndroid, diagnoseAndroid } from './toolchain.mjs';

export const apkTools = Object.freeze({
    schemaVersion: 1, kind: 'cocos4-html5-apk-tools', engineTarget: 'HTML5', native: false, jsb: false,
    commands: ['tools', 'export', 'verify', 'doctor', 'build', 'build-direct'],
    mutationMode: 'develop', backendModes: ['fixed', 'dynamic-debug'],
    hostingModes: ['connect-only', 'lan-host'], hostingAdapterEntry: '__cocos4_host/index.html',
    hostBridge: { java: 'Cocos4Host', adapter: '__COCOS4_HOST_ADAPTER__', controlBase: '/__cocos4/host' },
    bundledAndroidSdk: false, bundledJdk: false, automaticSdkDownloads: false,
});
const flagsByCommand = {
    export: ['--input', '--output', '--config', '--hosting-dir', '--mode'],
    verify: ['--project', '--mode'],
    doctor: ['--project', '--sdk', '--java-home', '--gradle-home', '--work', '--mode'],
    build: ['--project', '--sdk', '--java-home', '--gradle-home', '--work', '--variant', '--offline', '--mode'],
    'build-direct': ['--project', '--sdk', '--java-home', '--work', '--variant', '--platform', '--build-tools', '--mode'],
};
const usage = `Cocos4 HTML5 WebView APK tools
Usage: cocos4 apk tools|export|verify|doctor|build|build-direct [options]
  apk export --input ABS_STATIC_DIR --output ABS_NEW_PROJECT --config ABS_JSON [--hosting-dir ABS_ADAPTER] --mode develop
  apk verify --project ABS_PROJECT
  apk doctor --project ABS_PROJECT --sdk ABS_SDK --java-home ABS_JDK --gradle-home ABS_GRADLE --work ABS_WORK
  apk build --project ABS_PROJECT --sdk ABS_SDK --java-home ABS_JDK --gradle-home ABS_GRADLE --work ABS_WORK --variant debug --offline true --mode develop
  apk build-direct --project ABS_PROJECT --sdk ABS_SDK --java-home ABS_JDK --work ABS_WORK --platform 36 --build-tools 36.0.0 --variant debug --mode develop
Export/build require explicit --mode develop; verify/doctor are read-only. SDK/JDK tools are external prerequisites.
Windows build work stays on D:. No engine Android target, NATIVE/JSB, SDK installation or project-code execution.
hostingMode connect-only (default) omits all host code/backend assets; lan-host requires --hosting-dir with a browser-compatible __cocos4_host adapter. Dynamic backend settings support debug only; fixed backend release APKs need the maintainer's signing key.
`;

export async function runAndroidCli(args) {
    if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
        process.stdout.write(usage);
        return;
    }
    const [command, ...options] = args;
    if (command === 'tools') {
        if (options.length) throw Object.assign(new Error('apk tools accepts no options.'), { code: 'ARGUMENT_INVALID' });
        process.stdout.write(JSON.stringify(apkTools) + '\n');
        return;
    }
    if (!Object.hasOwn(flagsByCommand, command)) throw Object.assign(new Error('Unknown APK command. Use apk --help.'), { code: 'ARGUMENT_INVALID' });
    const flags = parseFlags(options, flagsByCommand[command]);
    const mode = flags['--mode'] ?? 'read-only';
    if (!['read-only', 'develop'].includes(mode)) throw Object.assign(new Error('--mode must be read-only or develop.'), { code: 'ARGUMENT_INVALID' });
    if (['export', 'build', 'build-direct'].includes(command) && mode !== 'develop') {
        throw Object.assign(new Error('APK export/build requires explicit --mode develop.'), { code: 'PERMISSION_DENIED' });
    }
    for (const name of ['--input', '--output', '--config', '--hosting-dir', '--project', '--sdk', '--java-home', '--gradle-home', '--work']) {
        if (flags[name] !== undefined && (!path.isAbsolute(flags[name]) || flags[name].includes('\0'))) {
            throw Object.assign(new Error(`${name} must be an explicit absolute path.`), { code: 'PATH_INVALID' });
        }
    }
    if (flags['--offline'] !== undefined && !['true', 'false'].includes(flags['--offline'])) {
        throw Object.assign(new Error('--offline must be true or false.'), { code: 'ARGUMENT_INVALID' });
    }
    let result;
    if (command === 'export') {
        if (!flags['--config']) throw Object.assign(new Error('--config is required.'), { code: 'ARGUMENT_INVALID' });
        const config = JSON.parse(await fs.readFile(flags['--config'], 'utf8'));
        result = await exportAndroid({ input: flags['--input'], output: flags['--output'], config, hostingDir: flags['--hosting-dir'] });
    } else if (command === 'verify') result = await verifyAndroidProject(flags['--project']);
    else {
        const settings = { project: flags['--project'], sdk: flags['--sdk'], javaHome: flags['--java-home'],
            gradleHome: flags['--gradle-home'], work: flags['--work'], variant: flags['--variant'], offline: flags['--offline'] !== 'false' };
        if (command === 'doctor') result = await diagnoseAndroid(settings);
        else if (command === 'build') result = await buildAndroid(settings);
        else result = await buildDirect({ ...settings, platform: flags['--platform'] === undefined ? 36 : Number(flags['--platform']),
            buildTools: flags['--build-tools'] });
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.success) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    runAndroidCli(process.argv.slice(2)).catch(error => {
        process.stderr.write(JSON.stringify({ success: false, code: error.code ?? 'APK_FAILED', message: error.message }) + '\n');
        process.exitCode = 1;
    });
}

