const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => path.relative(left, right) === '';
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameFile = (left, right) => sameIdentity(left, right)
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
// Node 18 needs extended paths; Node 24 rejects namespaced drive roots with EISDIR.
const realpath = filename => fs.realpath(process.platform === 'win32' && filename !== path.parse(filename).root
    ? path.toNamespacedPath(filename) : filename);

function safeRelative(relative) {
    return typeof relative === 'string' && relative.length && !/[\\:\x00-\x1f]/.test(relative)
        && relative.split('/').every(part => part && part !== '.' && part !== '..'
            && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

async function canonicalDirectory(directory) {
    const absolute = path.resolve(directory);
    let ancestor = path.parse(absolute).root;
    const observed = [];
    for (const part of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, part);
        const stat = await fs.lstat(ancestor, { bigint: true });
        assert.ok(!stat.isSymbolicLink(), 'Symlink directory/ancestor not allowed');
        assert.ok(stat.isDirectory(), 'Expected a directory');
        observed.push({ absolute: ancestor, stat });
    }
    const canonical = await realpath(absolute);
    const stat = await fs.lstat(absolute, { bigint: true });
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected an ordinary directory');
    // Windows realpath also expands genuine 8.3 aliases (including TEMP on
    // some hosts). Confirm object identity instead of requiring its spelling.
    const physical = await fs.lstat(canonical, { bigint: true });
    assert.ok(sameIdentity(stat, physical) && (process.platform === 'win32' || samePath(canonical, absolute)),
        'Symlink directory/ancestor not allowed');
    for (const item of observed) {
        const current = await fs.lstat(item.absolute, { bigint: true });
        assert.ok(current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, item.stat),
            'Directory/ancestor changed while resolving');
    }
    return canonical;
}

async function readRegular(root, relative) {
    assert.ok(safeRelative(relative), `Unsafe path: ${relative}`);
    let file = await canonicalDirectory(root);
    const parts = relative.split('/');
    for (const [index, part] of parts.entries()) {
        file = path.join(file, part);
        const stat = await fs.lstat(file);
        assert.ok(!stat.isSymbolicLink(), `Symlink not allowed: ${relative}`);
        if (index !== parts.length - 1) assert.ok(stat.isDirectory(), `Not a directory: ${relative}`);
    }
    assert.ok(samePath(await realpath(file), file), `Symlink not allowed: ${relative}`);
    const expected = await fs.lstat(file, { bigint: true });
    assert.ok(expected.isFile() && !expected.isSymbolicLink(), `Not a regular file: ${relative}`);
    assert.equal(expected.nlink, 1n, `Hardlinked input not allowed: ${relative}`);
    // Windows has no O_NOFOLLOW. The path and handle identities are checked on
    // both sides of the read, including the final directory/ancestor walk.
    const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
        const before = await handle.stat({ bigint: true });
        assert.ok(before.isFile() && sameFile(before, expected), `Input changed before reading: ${relative}`);
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        const current = await fs.lstat(file, { bigint: true });
        assert.ok(BigInt(bytes.length) === before.size && sameFile(before, after)
            && current.isFile() && !current.isSymbolicLink() && sameFile(after, current), `Input changed while reading: ${relative}`);
        await canonicalDirectory(path.dirname(file));
        assert.ok(samePath(await realpath(file), file), `Input path changed while reading: ${relative}`);
        return bytes;
    } finally { await handle.close(); }
}

async function inventory(root, prefix = '') {
    assert.ok(prefix === '' || (prefix.endsWith('/') && safeRelative(prefix.slice(0, -1))), `Unsafe path: ${prefix}`);
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
