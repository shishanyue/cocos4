const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function canonicalDirectory(directory) {
    const absolute = path.resolve(directory);
    let ancestor = path.parse(absolute).root;
    for (const part of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, part);
        const stat = await fs.lstat(ancestor);
        assert.ok(!stat.isSymbolicLink(), 'Symlink directory/ancestor not allowed');
        assert.ok(stat.isDirectory(), 'Expected a directory');
    }
    assert.equal(await fs.realpath(absolute), absolute, 'Symlink directory/ancestor not allowed');
    assert.ok((await fs.lstat(absolute)).isDirectory(), 'Expected a directory');
    return absolute;
}

async function readRegular(root, relative) {
    assert.ok(typeof relative === 'string' && relative.length && !relative.includes('\\')
        && !relative.includes(':') && !relative.includes('\0')
        && relative.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe path: ${relative}`);
    let file = await canonicalDirectory(root);
    for (const part of relative.split('/')) {
        file = path.join(file, part);
        const stat = await fs.lstat(file);
        assert.ok(!stat.isSymbolicLink(), `Symlink not allowed: ${relative}`);
    }
    assert.equal(await fs.realpath(file), file, `Symlink not allowed: ${relative}`);
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = await handle.stat();
        assert.ok(before.isFile(), `Not a regular file: ${relative}`);
        const bytes = await handle.readFile();
        const after = await handle.stat();
        assert.ok(bytes.length === before.size && before.size === after.size
            && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `Input changed while reading: ${relative}`);
        assert.equal(await fs.realpath(file), file, `Input path changed while reading: ${relative}`);
        return bytes;
    } finally { await handle.close(); }
}

async function inventory(root, prefix = '') {
    assert.ok(prefix === '' || (prefix.endsWith('/') && !/[\\:\0]/.test(prefix)
        && prefix.slice(0, -1).split('/').every(part => part && part !== '.' && part !== '..')), `Unsafe path: ${prefix}`);
    await canonicalDirectory(path.join(root, prefix));
    const files = [];
    for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) files.push(...await inventory(root, `${name}/`));
        else {
            const bytes = await readRegular(root, name);
            assert.ok(bytes.length, `Empty output: ${name}`);
            files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
        }
    }
    return files;
}

async function assertAbsent(file) {
    try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error(`OUTPUT_CONFLICT: ${file}`);
}

module.exports = { sha256, readRegular, inventory, assertAbsent, canonicalDirectory };
