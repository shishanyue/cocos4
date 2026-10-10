import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { extractWindowsNode } from '../scripts/prepare-windows-components.mjs';

async function fixture(t) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cocos4-windows-node-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'runtime');
    await fs.mkdir(output);
    return { directory, output, nodeArchive: path.join(directory, 'node.zip') };
}

test('offline Node preparation rejects invalid options and nonempty output before archive access', async t => {
    const { directory, output, nodeArchive } = await fixture(t);
    for (const options of [undefined, {}, { output, nodeArchive: 'relative.zip' }, { output: 'relative', nodeArchive },
        { output, nodeArchive, download: true }]) await assert.rejects(extractWindowsNode(options));
    await fs.writeFile(path.join(output, 'retain'), 'existing');
    await assert.rejects(extractWindowsNode({ output, nodeArchive }), /NODE_OUTPUT_CONFLICT/);
    assert.equal(await fs.readFile(path.join(output, 'retain'), 'utf8'), 'existing');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['runtime']);
});

test('offline Node preparation verifies the complete archive hash before writing members', async t => {
    const { directory, output, nodeArchive } = await fixture(t);
    await fs.writeFile(nodeArchive, 'a ZIP header is not an authenticated Node archive');
    await assert.rejects(extractWindowsNode({ output, nodeArchive }), /NODE_ARCHIVE_HASH_MISMATCH/);
    assert.deepEqual(await fs.readdir(output), []);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['node.zip', 'runtime']);
});

test('offline Node preparation rejects directory aliases and hardlinked archives', async t => {
    const { directory, output, nodeArchive } = await fixture(t);
    await fs.writeFile(nodeArchive, 'invalid');
    const alias = path.join(directory, 'alias');
    await fs.symlink(output, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(extractWindowsNode({ output: alias, nodeArchive }), /real directory|aliases/);
    const hardlink = path.join(directory, 'hardlink.zip');
    await fs.link(nodeArchive, hardlink);
    await assert.rejects(extractWindowsNode({ output, nodeArchive: hardlink }), /regular file/);
    await fs.unlink(hardlink);
    assert.deepEqual(await fs.readdir(output), []);
});
