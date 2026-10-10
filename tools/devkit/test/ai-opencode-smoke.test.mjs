import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { compileFunction } from 'node:vm';

// Exercise the trusted sibling's argument setup, not its imports/client calls.
const source = await readFile(new URL('./ai-opencode-smoke.mjs', import.meta.url), 'utf8');
const setup = source.match(/    const noEnv = [\s\S]*?(?=    const result = await new Promise)/)?.[0];
assert.ok(setup);
const captureArgs = compileFunction(`return (async () => { ${setup}\nreturn { command, actualArgs }; })();`,
    ['name', 'argv', 'build', 'sdkRoot', 'root', 'prepared', 'process', 'fs', 'path']);
const kit = '/trusted/kit';
const sdk = `${kit}/sdk`;
const root = '/private/fixture';
const executable = '/usr/bin/opencode';
const node = `${kit}/runtime/node`;
const error = code => Object.assign(new Error(code), { code });
const argsFor = (build, fs, name = 'mcp-list', argv = ['mcp', 'list']) => captureArgs(
    name, argv, build, sdk, root, { executable }, { execPath: node, platform: 'linux' }, fs, path.posix);

for (const [layout, build, modulesRoot, modules] of [
    ['packaged', `${kit}/app`, `${kit}/app/node_modules`, `${kit}/app/node_modules`],
    ['source hoisted', `${kit}/build`, `${kit}/node_modules`, `${kit}/node_modules`],
    ['focused hoisted symlink', `${kit}/app`, `${kit}/node_modules`, '/trusted/devkit/node_modules'],
]) {
    test(`${layout}: only the selected dependency tree is realpathed and mounted read-only`, async () => {
        const calls = [];
        const result = await argsFor(build, {
            async lstat(filename) {
                calls.push(['lstat', filename]);
                if (filename !== modulesRoot) throw error('ENOENT');
            },
            async realpath(filename) { calls.push(['realpath', filename]); return modules; },
        });
        assert.deepEqual(calls, [['lstat', `${build}/node_modules`], ['realpath', modulesRoot]]);
        assert.deepEqual(result, { command: '/usr/bin/bwrap', actualArgs: [
            '--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent',
            '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--ro-bind', kit, kit, '--ro-bind', modules, modules,
            '--ro-bind', sdk, sdk, '--bind', root, root,
            '--ro-bind', executable, executable, '--ro-bind', node, node,
            '--', executable, 'mcp', 'list',
        ] });
    });
}

test('non-namespace commands do not inspect dependencies', async () => {
    assert.deepEqual(await argsFor(`${kit}/app`, {}, 'version', ['--version']),
        { command: executable, actualArgs: ['--version'] });
});

test('Windows MCP discovery launches the selected client directly without Linux namespace dependencies', async () => {
    const executable = 'C:\\Trusted Kit\\opencode.exe';
    const argv = ['mcp', 'list'];
    assert.deepEqual(await captureArgs('mcp-list', argv, 'C:\\Trusted Kit\\app', 'C:\\Trusted Kit\\sdk',
        'C:\\Private\\fixture', { executable }, { execPath: 'C:\\Trusted Kit\\runtime\\node.exe', platform: 'win32' }, {}, path.win32),
    { command: executable, actualArgs: argv });
});

test('dependency lookup does not mask errors or search beyond the two layouts', async () => {
    for (const code of ['EACCES', 'ENOTDIR']) {
        await assert.rejects(argsFor(`${kit}/app`, { async lstat() { throw error(code); } }), { code });
    }
    for (const localExists of [true, false]) {
        const calls = [];
        await assert.rejects(argsFor(`${kit}/app`, {
            async lstat() { if (!localExists) throw error('ENOENT'); },
            async realpath(filename) { calls.push(filename); throw error('ENOENT'); },
        }), { code: 'ENOENT' });
        assert.deepEqual(calls, [localExists ? `${kit}/app/node_modules` : `${kit}/node_modules`]);
    }
});
