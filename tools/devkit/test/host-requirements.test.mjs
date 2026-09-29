import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHostRequirements, verifyHost } from '../scripts/verify-portable.mjs';

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
