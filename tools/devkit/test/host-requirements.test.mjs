import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHostRequirements, portablePaths, verifyHost } from '../scripts/verify-portable.mjs';

function fixture() {
    const staticBinary = file => ({ file, interpreter: null, sharedLibraries: [], versions: [] });
    return { host: { platform: 'linux', arch: 'x64', libraries: [staticBinary('cocos4'),
        { file: 'runtime/node', interpreter: '/lib64/ld-linux-x86-64.so.2', sharedLibraries: ['libc.so.6', 'libstdc++.so.6'], versions: ['GLIBC_2.28', 'GLIBCXX_3.4.21'] },
        { file: 'app/host/cocos4-publish', interpreter: '/lib64/ld-linux-x86-64.so.2', sharedLibraries: ['libc.so.6'], versions: ['GLIBC_2.2.5', 'GLIBC_2.34'] },
        { file: 'app/host/cocos4-supervise', interpreter: '/lib64/ld-linux-x86-64.so.2', sharedLibraries: ['libc.so.6'], versions: ['GLIBC_2.38'] },
        staticBinary('app/host/cocos4-mcp-launch'),
    ] }, runtime: { node: { version: '24.21.0' } } };
}
const host = { platform: 'linux', arch: 'x64', node: 'v24.21.0', glibc: '2.38' };

test('minimum libc covers every helper, not just Node, and uses numeric versions', () => {
    assert.equal(checkHostRequirements(fixture(), host).minimumGlibc, '2.38');
    for (const glibc of ['2.28', '2.34', '2.37.9', '2.9']) {
        assert.throws(() => checkHostRequirements(fixture(), { ...host, glibc }), /complete kit requirement 2\.38/);
    }
    for (const glibc of ['2.38.0', '2.39', '2.100', '3.0']) assert.equal(checkHostRequirements(fixture(), { ...host, glibc }).glibc, glibc);
});

test('unsupported platform, architecture, runtime or undetectable libc cannot pass', () => {
    for (const change of [{ platform: 'darwin' }, { arch: 'arm64' }, { node: 'v18.20.8' },
        { glibc: undefined }, { glibc: 'musl' }, { glibc: '2.38 suffix' }]) {
        assert.throws(() => checkHostRequirements(fixture(), { ...host, ...change }));
    }
});

test('missing or unexpected helper ABIs fail closed instead of silently lowering requirements', () => {
    const changes = [
        manifest => { manifest.host.libraries.pop(); },
        manifest => { manifest.host.libraries[0].file = 'runtime/node'; },
        manifest => { manifest.host.libraries[0].interpreter = '/unreviewed-loader'; },
        manifest => { manifest.host.libraries.at(-1).sharedLibraries.push('libc.so.6'); },
        manifest => { manifest.host.libraries[2].sharedLibraries.push('libextra.so'); },
        manifest => { manifest.host.libraries[2].interpreter = '/missing-loader'; },
        manifest => { manifest.host.libraries[3].versions = []; },
        manifest => { manifest.host.libraries[3].versions.push('UNRECOGNIZED_ABI'); },
    ];
    for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => checkHostRequirements(manifest, host)); }
});

test('direct CLI cannot claim a release produced by a different interpreter', async () => {
    await assert.rejects(verifyHost('/deliberately-not-the-executing-release', fixture()), /bundled Node/);
});

function windowsFixture() {
    return { host: { platform: 'win32', arch: 'x64', minimumRelease: '10.0.22000', libraries:
        portablePaths('win32').binaries.map(file => ({ file, machine: 'AMD64', format: 'PE32+',
            sharedLibraries: ['KERNEL32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'],
            hardening: { dynamicBase: true, highEntropyVA: true, nxCompatible: true,
                relocationsPresent: true, writableExecutableSections: [] } })) },
    runtime: { node: { version: '24.21.0' } } };
}
const windowsHost = { platform: 'win32', arch: 'x64', node: 'v24.21.0', windowsVersion: '10.0.26200' };

test('Windows host checks require the bundled runtime, Windows 11 and all six PE identities', () => {
    assert.deepEqual(checkHostRequirements(windowsFixture(), windowsHost), { ...windowsHost, minimumWindowsVersion: '10.0.22000' });
    for (const windowsVersion of ['10.0.19045', '10.0.21999', '6.3.9600', 'unknown', undefined]) {
        assert.throws(() => checkHostRequirements(windowsFixture(), { ...windowsHost, windowsVersion }));
    }
    for (const change of [{ platform: 'linux' }, { arch: 'arm64' }, { node: 'v24.16.0' }]) {
        assert.throws(() => checkHostRequirements(windowsFixture(), { ...windowsHost, ...change }));
    }
});

test('Windows verification rejects missing helpers, PE hardening and unreviewed DLLs', () => {
    for (const change of [
        manifest => { manifest.host.libraries.pop(); },
        manifest => { manifest.host.minimumRelease = '10.0.0'; },
        manifest => { manifest.host.libraries[1].machine = 'ARM64'; },
        manifest => { manifest.host.libraries[1].format = 'PE32'; },
        manifest => { manifest.host.libraries[1].sharedLibraries.push('plugin.dll'); },
        manifest => { manifest.host.libraries[1].sharedLibraries.push('kernel32.DLL'); },
        manifest => { manifest.host.libraries[1].hardening.nxCompatible = false; },
        manifest => { manifest.host.libraries[1].hardening.writableExecutableSections.push('.text'); },
    ]) {
        const manifest = windowsFixture(); change(manifest);
        assert.throws(() => checkHostRequirements(manifest, windowsHost));
    }
});
