import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { canonicalDirectory, inventory, readRegular } = createRequire(import.meta.url)('../runtime/files.cjs');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'cocos4 Runtime 文件 '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'Directory'));
    await fs.writeFile(path.join(root, 'Directory/payload.txt'), 'unchanged');
    return root;
}

test('runtime file reads accept physical Win32 casing and portable Unicode/space paths', async t => {
    const root = await fixture(t);
    const requested = process.platform === 'win32' ? root.toUpperCase() : root;
    assert.equal(await canonicalDirectory(requested), await fs.realpath(root));
    assert.equal((await readRegular(requested, 'Directory/payload.txt')).toString(), 'unchanged');
    assert.deepEqual((await inventory(requested)).map(file => file.path), ['Directory/payload.txt']);
    for (const name of ['../file', '/file', 'a\\file', 'a:file', 'a//file', 'a./file', 'a /file', 'NUL', 'COM1.txt', 'file\0']) {
        await assert.rejects(readRegular(root, name), /Unsafe path/);
    }
});

test('Windows runtime file reads retain identity checks beyond MAX_PATH', { skip: process.platform !== 'win32' }, async t => {
    const root = await fixture(t);
    const directory = path.join(root, 'long ' + 'x'.repeat(180), 'child ' + 'x'.repeat(40));
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'payload.txt'), 'unchanged');
    assert(path.join(directory, 'payload.txt').length > 260, 'The fixture must cross MAX_PATH');
    assert.equal(await canonicalDirectory(directory.toUpperCase()), directory);
    assert.equal((await readRegular(directory, 'payload.txt')).toString(), 'unchanged');
    assert.deepEqual((await inventory(directory)).map(file => file.path), ['payload.txt']);
    const hardlink = path.join(directory, 'hardlink');
    await fs.link(path.join(directory, 'payload.txt'), hardlink);
    try { await assert.rejects(readRegular(directory, 'payload.txt'), /Hardlinked input/); }
    finally { await fs.unlink(hardlink); }
    const redirect = path.join(root, 'redirect-long'); await fs.symlink(directory, redirect, 'junction');
    await assert.rejects(readRegular(redirect, 'payload.txt'), /Symlink/);
});

test('runtime reads reject linked files and junction/symlink ancestors', async t => {
    const root = await fixture(t);
    await fs.link(path.join(root, 'Directory/payload.txt'), path.join(root, 'hardlink'));
    await assert.rejects(readRegular(root, 'hardlink'), /Hardlinked input/);
    await fs.unlink(path.join(root, 'hardlink'));
    await fs.symlink(path.join(root, 'Directory'), path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readRegular(root, 'redirect/payload.txt'), /Symlink/);
    await assert.rejects(canonicalDirectory(path.join(root, 'redirect')), /Symlink/);
    await fs.symlink(path.join(root, 'Directory/payload.txt'), path.join(root, 'file-link'), 'file');
    await assert.rejects(readRegular(root, 'file-link'), /Symlink/);
});

test('runtime reads reject a same-size path replacement after opening the file', async t => {
    const root = await fixture(t);
    const original = fs.open;
    let replaced = false;
    fs.open = async (file, ...args) => {
        const handle = await original(file, ...args);
        if (path.basename(file) !== 'payload.txt') return handle;
        const read = handle.readFile.bind(handle);
        handle.readFile = async (...options) => {
            const bytes = await read(...options);
            await fs.rename(file, path.join(root, 'old-payload'));
            await fs.writeFile(file, 'different');
            replaced = true;
            return bytes;
        };
        return handle;
    };
    try { await assert.rejects(readRegular(root, 'Directory/payload.txt'), /Input changed while reading/); }
    finally { fs.open = original; }
    assert.equal(replaced, true);
    assert.equal(await fs.readFile(path.join(root, 'Directory/payload.txt'), 'utf8'), 'different');
});
