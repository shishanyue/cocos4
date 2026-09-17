const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const lock = require('./source-lock.json');
const patchLock = require('./patch-lock.json');

async function verifySource(directory, checkout = false) {
    const files = new Map();
    for (const [name, [source, hash]] of Object.entries(lock.files)) {
        const file = path.join(directory, checkout ? source : name);
        assert.ok((await fs.lstat(file)).isFile(), `Expected a regular compiler input: ${file}`);
        const bytes = await fs.readFile(file);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `Compiler input changed: ${file}`);
        files.set(name, bytes);
    }
    return files;
}

async function prepareSource(source, destination = path.join(__dirname, 'build/compiler')) {
    const files = await verifySource(source, true);
    await writeCompiler(files, destination);
}

async function writeCompiler(files, destination) {
    let existing;
    try {
        existing = await fs.lstat(destination);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (existing) {
        assert.ok(existing.isDirectory(), 'Compiler destination must be a real directory.');
        await verifyCompiler(destination, files);
        return;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const staging = await fs.mkdtemp(path.join(path.dirname(destination), 'compiler-staging-'));
    try {
        for (const [name, bytes] of files) await fs.writeFile(path.join(staging, name), bytes, { flag: 'wx' });
        await fs.rename(staging, destination);
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}

async function prepareCompiler(source, destination) {
    // Verify the original fixed bytes before loading or applying any local patch.
    const files = await verifySource(source);
    assert.equal(patchLock.revision, lock.revision, 'Compiler patch revision changed');
    const script = await fs.readFile(path.join(__dirname, 'compiler-patch.cjs'));
    assert.equal(createHash('sha256').update(script).digest('hex'), patchLock.scriptSha256, 'Compiler patch changed');
    const { applyCompilerPatch } = require('./compiler-patch.cjs');
    const patched = Buffer.from(applyCompilerPatch(files.get('shdc-lib.js').toString('utf8')));
    assert.equal(createHash('sha256').update(patched).digest('hex'), patchLock.outputSha256, 'Patched compiler changed');
    files.set('shdc-lib.js', patched);
    files.set('patch-manifest.json', Buffer.from(JSON.stringify(patchLock, null, 2) + '\n'));
    await writeCompiler(files, destination);
    return files;
}

async function verifyCompiler(directory, files) {
    assert.deepEqual((await fs.readdir(directory)).sort(), [...files.keys()].sort(), 'Compiler files changed');
    for (const [name, bytes] of files) {
        const file = path.join(directory, name);
        assert.ok((await fs.lstat(file)).isFile(), `Expected a regular compiler input: ${file}`);
        assert.ok(bytes.equals(await fs.readFile(file)), `Patched compiler input changed: ${file}`);
    }
}

module.exports = { prepareSource, verifySource, prepareCompiler, verifyCompiler };
if (require.main === module) {
    if (process.argv.length !== 3) {
        console.error('Usage: node prepare-source.cjs /path/to/pinned/cocos-cli');
        process.exitCode = 1;
    } else {
        prepareSource(path.resolve(process.argv[2]))
            .then(() => console.log(`[effect-compiler] verified ${lock.revision}`))
            .catch(error => { console.error(error); process.exitCode = 1; });
    }
}
