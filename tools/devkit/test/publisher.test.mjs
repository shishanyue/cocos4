import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildHostTool, buildPublisherWin32 } from '../scripts/build-publisher.mjs';

const devkit = fileURLToPath(new URL('../', import.meta.url));

test('fixed publisher preserves descriptor checks and atomic no-replace without Python or PATH', { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
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

test('Windows publisher pins path identities and publishes without overwrite or copy fallback',
    { timeout: 300000, skip: process.platform !== 'win32' }, async t => {
        await fs.mkdir(path.join(devkit, 'build'), { recursive: true });
        const root = await fs.mkdtemp(path.join(devkit, 'build/publisher-win32-test-'));
        const helper = path.join(root, 'cocos4-publish.exe');
        const compiler = process.env.COCOS4_WINDOWS_COMPILER;
        if (compiler) assert(path.isAbsolute(compiler), 'COCOS4_WINDOWS_COMPILER must name an absolute supported compiler');
        const build = await buildPublisherWin32({ output: helper, compiler });
        const repeat = await buildPublisherWin32({ output: path.join(root, 'repeat.exe'), compiler });
        assert.equal(build.binarySha256, repeat.binarySha256, 'Fixed compiler inputs must reproduce the helper');
        assert.equal(build.protocol, 'cocos4-publish-v1');
        assert.equal(build.target, 'win32-x64');
        const source = path.join(root, 'staging');
        const output = path.join(source, 'output');
        const destination = path.join(root, 'destination');
        await fs.mkdir(output, { recursive: true });
        await fs.mkdir(destination);
        await fs.writeFile(path.join(output, 'keep'), 'original');
        const chain = async directory => {
            const result = [];
            let current = path.parse(directory).root;
            for (const component of ['', ...directory.slice(current.length).split(path.sep).filter(Boolean)]) {
                current = path.join(current, component);
                result.push({ directory: current, stat: await fs.lstat(current, { bigint: true }) });
            }
            return result;
        };
        let sourcePins = await chain(output), destinationPins = await chain(destination);
        const execute = args => new Promise((resolve, reject) => {
            const child = spawn(helper, args, { env: { SystemRoot: process.env.SystemRoot }, cwd: root,
                shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', bytes => { stdout += bytes; });
            child.stderr.on('data', bytes => { stderr += bytes; });
            child.once('error', reject);
            child.once('close', (code, signal) => {
                try { assert.equal(signal, null); assert.equal(stdout, ''); assert.equal(stderr, ''); resolve(code); }
                catch (error) { reject(error); }
            });
        });
        const argumentsFor = (name, source = sourcePins, destination = destinationPins, protocol = 'cocos4-publish-v1') =>
            [protocol, String(source.length), name, ...[...source, ...destination].flatMap(({ directory, stat }) =>
                [directory, String(stat.dev), String(stat.ino), String(stat.mode)])];
        const run = (name, mutate = args => args) => execute(mutate(argumentsFor(name)));
        for (const kind of ['empty', 'nonempty', 'file', 'junction']) await t.test(`reject existing ${kind}`, async () => {
            const file = path.join(destination, kind);
            if (kind === 'empty' || kind === 'nonempty') await fs.mkdir(file);
            if (kind === 'nonempty') await fs.writeFile(path.join(file, 'keep'), 'destination');
            if (kind === 'file') await fs.writeFile(file, 'destination');
            if (kind === 'junction') await fs.symlink(path.join(destination, 'empty'), file, 'junction');
            const before = await fs.lstat(file, { bigint: true });
            assert.equal(await run(kind), 70);
            assert.equal((await fs.lstat(file, { bigint: true })).ino, before.ino);
            assert.equal(await fs.readFile(path.join(output, 'keep'), 'utf8'), 'original');
        });
        await t.test('reject malformed protocol, reserved names, stale identity and missing ancestors', async () => {
            assert.equal(await run('new', args => { args[1] = '99'; return args; }), 64);
            for (const name of ['../escape', 'bad\\name', 'aux.txt', 'CON', 'x:', 'trailing.', 'trailing ']) {
                assert.equal(await run(name), 64, name);
            }
            assert.equal(await run('new', args => { args[5] = String(BigInt(args[5]) + 1n); return args; }), 73);
            assert.equal(await run('new', args => { args[0] = 'cocos4-publish-v2'; return args; }), 64);
            assert.equal(await run('new', args => { args[8] = output; return args; }), 64);
        });
        await t.test('reject source and destination ancestor replacement and reparse points', async () => {
            await fs.rename(output, `${output}-saved`);
            await fs.mkdir(output);
            assert.equal(await run('new'), 73);
            await fs.rmdir(output);
            await fs.symlink(`${output}-saved`, output, 'junction');
            assert.equal(await run('new'), 73);
            await fs.unlink(output);
            await fs.rename(`${output}-saved`, output);
            await fs.rename(destination, `${destination}-saved`);
            await fs.mkdir(destination);
            assert.equal(await run('new'), 73);
            await fs.rmdir(destination);
            await fs.symlink(`${destination}-saved`, destination, 'junction');
            assert.equal(await run('new'), 73);
            await fs.unlink(destination);
            await fs.rename(`${destination}-saved`, destination);
        });
        await t.test('cross-volume rename fails and retains source', async subtest => {
            const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cocos4-publish-'));
            try {
                const otherPins = await chain(other);
                if (otherPins.at(-1).stat.dev === sourcePins.at(-1).stat.dev) {
                    subtest.skip('This host exposes no second test volume through TEMP');
                    return;
                }
                assert.equal(await execute(argumentsFor('new', sourcePins, otherPins)), 72);
                assert.equal(await fs.readFile(path.join(output, 'keep'), 'utf8'), 'original');
                assert.deepEqual(await fs.readdir(other), []);
            } finally { await fs.rmdir(other); }
        });
        await t.test('concurrent publishers keep exactly one complete winner', async () => {
            const candidates = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
                const directory = path.join(root, `race-${index}`, 'output');
                await fs.mkdir(directory, { recursive: true });
                await fs.writeFile(path.join(directory, 'winner'), String(index));
                return chain(directory);
            }));
            const codes = await Promise.all(candidates.map(pins => execute(argumentsFor('race', pins))));
            assert.equal(codes.filter(code => code === 0).length, 1);
            assert(codes.every(code => code === 0 || code === 70), JSON.stringify(codes));
            const winner = Number(await fs.readFile(path.join(destination, 'race', 'winner'), 'utf8'));
            assert.equal(codes[winner], 0);
            for (let index = 0; index < candidates.length; ++index) {
                if (index !== winner) assert.equal(await fs.readFile(path.join(candidates[index].at(-1).directory, 'winner'), 'utf8'), String(index));
            }
        });
        await t.test('short and extended source/destination pairs retain Unicode no-replace publication', async () => {
            for (const [name, longSource, longDestination] of [['ss', false, false], ['ls', true, false], ['sl', false, true], ['ll', true, true]]) {
                const scenario = path.join(root, 'paths', name);
                const source = path.join(scenario, ...(longSource ? ['source ' + 'x'.repeat(180)] : []), 'stage', 'output');
                const destination = path.join(scenario, ...(longDestination ? ['destination ' + 'x'.repeat(180)] : []), 'destination');
                const published = 'published game \u6e38\u620f';
                await fs.mkdir(source, { recursive: true }); await fs.mkdir(destination, { recursive: true });
                await fs.writeFile(path.join(source, 'payload.txt'), name);
                assert.equal(source.length > 260, longSource, 'The source must exercise its declared path-length category');
                assert.equal(path.join(destination, published).length > 260, longDestination, 'The destination must exercise its declared path-length category');
                const sourceChain = await chain(source), destinationChain = await chain(destination);
                assert.equal(await execute(argumentsFor(published, sourceChain, destinationChain)), 0, name);
                assert.equal(await fs.readFile(path.join(destination, published, 'payload.txt'), 'utf8'), name);
                await assert.rejects(fs.stat(source), { code: 'ENOENT' });
                await fs.mkdir(source); await fs.writeFile(path.join(source, 'payload.txt'), 'unchanged');
                const retry = await chain(source);
                assert.equal(await execute(argumentsFor(published, retry, destinationChain)), 70, `Existing destination must not be replaced: ${name}`);
                assert.equal(await fs.readFile(path.join(destination, published, 'payload.txt'), 'utf8'), name);
                assert.equal(await fs.readFile(path.join(source, 'payload.txt'), 'utf8'), 'unchanged');
            }
        });
        await t.test('publish absent Unicode and space name', async () => {
            const name = 'game \u6e38\u620f';
            assert.equal(await run(name), 0);
            assert.equal(await fs.readFile(path.join(destination, name, 'keep'), 'utf8'), 'original');
            await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
        });
        await t.test('maintainer protocol publishes only sibling directories', async () => {
            const directory = path.join(root, 'candidate-staging');
            await fs.mkdir(directory);
            await fs.writeFile(path.join(directory, 'keep'), 'candidate');
            sourcePins = await chain(directory);
            assert.equal(await execute(argumentsFor('candidate', sourcePins, destinationPins, 'cocos4-prepare-publish-v1')), 64);
            destinationPins = await chain(root);
            assert.equal(await execute(argumentsFor('candidate', sourcePins, destinationPins, 'cocos4-prepare-publish-v1')), 0);
            assert.equal(await fs.readFile(path.join(root, 'candidate', 'keep'), 'utf8'), 'candidate');
        });
        await fs.writeFile(path.join(root, 'evidence.json'), `${JSON.stringify({ build, platform: process.platform,
            testResult: 'Use the Node test runner result; subtest failures are not inferred from this build receipt.' })}\n`);
        t.diagnostic(`Retained Windows publisher evidence: ${root}`);
    });
