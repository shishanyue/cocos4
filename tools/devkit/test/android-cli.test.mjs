import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const devkit = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(devkit, 'build/src/cli.js');
const root = process.env.COCOS4_ANDROID_TEST_WORK_ROOT ? path.resolve(process.env.COCOS4_ANDROID_TEST_WORK_ROOT) : path.join(devkit, 'build/android-cli-tests');
async function command(args) {
    try { return { code: 0, ...await execute(process.execPath, [cli, 'apk', ...args], { cwd: devkit, windowsHide: true, maxBuffer: 1024 * 1024 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function fixture(t) {
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'case-'));
    t.after(async () => { assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
    const input = path.join(directory, 'web');
    const output = path.join(directory, 'android');
    const config = path.join(directory, 'apk.json');
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, 'index.html'), '<html><head></head><body>APK CLI fixture</body></html>');
    await fs.writeFile(config, JSON.stringify({ appId: 'org.cocos4.clitest', appName: 'CLI test', backendUrl: 'https://backend.invalid', dynamicBackend: true }));
    return { directory, input, output, config };
}

test('unified CLI discovers APK commands independently of engine targets, workspace and state', async () => {
    const result = await command(['tools']);
    assert.equal(result.code, 0, result.stderr);
    const tools = JSON.parse(result.stdout);
    assert.equal(tools.engineTarget, 'HTML5');
    assert.equal(tools.native, false);
    assert.equal(tools.jsb, false);
    assert.equal(tools.bundledAndroidSdk, false);
    assert.ok(tools.commands.includes('build-direct'));
    assert.equal((await command(['--help'])).code, 0);
});

test('unified APK CLI preserves read-only defaults and never executes arbitrary commands', async t => {
    const { input, output, config } = await fixture(t);
    const args = ['export', '--input', input, '--output', output, '--config', config];
    const denied = await command(args);
    assert.equal(denied.code, 1);
    assert.equal(JSON.parse(denied.stderr).code, 'PERMISSION_DENIED');
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    for (const invalid of [['exec', '--command', 'anything'], ['tools', '--mode', 'develop'], [...args, '--mode', 'develop', '--execute-tests', 'true']]) {
        const result = await command(invalid);
        assert.equal(result.code, 1);
        assert.equal(JSON.parse(result.stderr).code, 'ARGUMENT_INVALID');
    }
});

test('unified APK CLI exports and verifies the actual local web project with explicit develop permission', async t => {
    const { input, output, config } = await fixture(t);
    const generated = await command(['export', '--input', input, '--output', output, '--config', config, '--mode', 'develop']);
    assert.equal(generated.code, 0, generated.stderr);
    assert.equal(JSON.parse(generated.stdout).projectGenerated, true);
    const verified = await command(['verify', '--project', output]);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).config.dynamicBackend, true);
    const repeated = await command(['export', '--input', input, '--output', output, '--config', config, '--mode', 'develop']);
    assert.equal(repeated.code, 1);
    assert.equal(JSON.parse(repeated.stderr).code, 'OUTPUT_EXISTS');
});
