import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildHostTool } from '../scripts/build-publisher.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));

test('fixed publisher preserves descriptor checks and atomic no-replace without Python or PATH', { timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(devkit, 'build/publisher-test-'));
    const helper = path.join(root, 'cocos4-publish');
    const build = await buildHostTool(path.join(devkit, 'runtime/publish.c'), helper);
    const repeat = await buildHostTool(path.join(devkit, 'runtime/publish.c'), path.join(root, 'repeat'));
    assert.equal(build.binarySha256, repeat.binarySha256, 'Fixed compiler inputs must reproduce the helper');
    const source = path.join(root, 'staging');
    const output = path.join(source, 'output');
    const destination = path.join(root, 'destination');
    await fs.mkdir(source, { mode: 0o700 });
    await fs.mkdir(output, { mode: 0o700 });
    await fs.mkdir(destination, { mode: 0o700 });
    await fs.writeFile(path.join(output, 'keep'), 'original', { mode: 0o400 });
    const chain = async directory => {
        const result = [];
        let current = path.parse(directory).root;
        for (const component of ['', ...directory.slice(current.length).split('/')]) {
            current = path.join(current, component);
            const handle = await fs.open(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            result.push({ handle, directory: current, stat: await handle.stat({ bigint: true }) });
        }
        return result;
    };
    const sourcePins = await chain(output);
    let destinationPins = await chain(destination);
    const run = (name, mutate = args => args) => new Promise((resolve, reject) => {
        const pins = [...sourcePins, ...destinationPins];
        const args = ['cocos4-publish-v1', String(sourcePins.length), name, ...pins.flatMap(({ directory, stat }) =>
            [directory, String(stat.dev), String(stat.ino), String(stat.mode)])];
        const child = spawn(helper, mutate(args), { env: {}, cwd: '/',
            stdio: ['ignore', 'pipe', 'pipe', ...pins.map(pin => pin.handle.fd)] });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => { stdout += bytes; });
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.once('error', reject);
        child.once('close', (code, signal) => {
            try { assert.equal(signal, null); assert.equal(stdout, ''); assert.equal(stderr, ''); resolve(code); }
            catch (error) { reject(error); }
        });
    });
    t.after(async () => { for (const pin of [...sourcePins, ...destinationPins]) await pin.handle.close(); });
    for (const kind of ['empty', 'nonempty', 'file', 'symlink']) await t.test(`reject existing ${kind}`, async () => {
        const name = path.join(destination, kind);
        if (kind === 'empty' || kind === 'nonempty') await fs.mkdir(name);
        if (kind === 'nonempty') await fs.writeFile(path.join(name, 'keep'), 'destination');
        if (kind === 'file') await fs.writeFile(name, 'destination');
        if (kind === 'symlink') await fs.symlink(path.join(destination, 'empty'), name);
        assert.equal(await run(kind), 70);
        assert.equal(await fs.readFile(path.join(output, 'keep'), 'utf8'), 'original');
    });
    await t.test('reject malformed descriptors and stale pinned identity', async () => {
        assert.equal(await run('new', args => { args[1] = '99'; return args; }), 64);
        assert.equal(await run('../escape'), 64);
        assert.equal(await run('new', args => { args[5] = String(BigInt(args[5]) + 1n); return args; }), 73);
        assert.equal(await run('new', args => { args[0] = 'cocos4-publish-v2'; return args; }), 64);
    });
    await t.test('reject source and destination ancestor replacement', async () => {
        await fs.rename(output, `${output}-saved`);
        await fs.mkdir(output);
        assert.equal(await run('new'), 73);
        await fs.rmdir(output);
        await fs.rename(`${output}-saved`, output);
        await fs.rename(destination, `${destination}-saved`);
        await fs.mkdir(destination);
        assert.equal(await run('new'), 73);
        await fs.rmdir(destination);
        await fs.rename(`${destination}-saved`, destination);
    });
    await t.test('EXDEV is a failure, never copy or ordinary rename', async () => {
        const other = await fs.mkdtemp('/dev/shm/cocos4-publish-');
        const otherPins = await chain(other);
        try {
            assert.notEqual(otherPins.at(-1).stat.dev, sourcePins.at(-1).stat.dev, 'This regression requires two actual filesystems');
            const original = destinationPins;
            destinationPins = otherPins;
            try { assert.equal(await run('new'), 72); } finally { destinationPins = original; }
            assert.equal(await fs.readFile(path.join(output, 'keep'), 'utf8'), 'original');
            assert.deepEqual(await fs.readdir(other), []);
        } finally { for (const pin of otherPins) await pin.handle.close(); await fs.rmdir(other); }
    });
    await t.test('publish an absent Unicode and space name', async () => {
        const name = 'game \u6e38\u620f';
        assert.equal(await run(name), 0);
        assert.equal(await fs.readFile(path.join(destination, name, 'keep'), 'utf8'), 'original');
        await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    });
    await fs.writeFile(path.join(root, 'evidence.json'), `${JSON.stringify({ success: true, build, checks: 9 })}\n`);
    t.diagnostic(`Retained publisher evidence: ${root}`);
});
