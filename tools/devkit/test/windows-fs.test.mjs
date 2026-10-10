import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildFsWin32 } from '../scripts/build-fs-win32.mjs';
import { compileWindowsSource } from '../scripts/build-supervisor-win32.mjs';
import { hostRealpath } from '../build/src/windows-fs.js';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = filename => Buffer.from(filename, 'utf16le').toString('hex');

test('Windows filesystem helper pins paths, rejects aliases and checks ACLs',
    { skip: process.platform !== 'win32', timeout: 300000 }, async t => {
        const parent = await fs.realpath(os.tmpdir());
        const root = await fs.mkdtemp(path.join(parent, 'cocos4-windows-fs-'));
        const helper = path.join(root, 'cocos4-fs.exe');
        const build = await buildFsWin32({ output: helper, compiler: process.env.COCOS4_WINDOWS_COMPILER });
        const repeated = await buildFsWin32({ output: path.join(root, 'repeat.exe'), compiler: process.env.COCOS4_WINDOWS_COMPILER });
        assert.equal(build.binarySha256, repeated.binarySha256);
        assert.equal(build.protocol, 'cocos4-fs-v1');
        const child = spawn(helper, ['cocos4-fs-v1'], { shell: false, windowsHide: true, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
        const pending = new Map(), records = [];
        let sequence = 0, stderr = '', closed = false;
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.stdin.on('error', () => {});
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
            const fields = line.split(' '), entry = pending.get(fields[0]);
            if (!entry) return;
            pending.delete(fields[0]); clearTimeout(entry.timer); records.push({ command: entry.command, response: fields.slice(1) });
            entry.resolve(fields.slice(1));
        });
        child.once('close', (code, signal) => {
            closed = true;
            for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Filesystem helper closed (${code ?? signal}): ${stderr}`)); }
            pending.clear();
        });
        const request = command => new Promise((resolve, reject) => {
            assert(!closed);
            const id = String(++sequence);
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Filesystem helper timed out: ${command}`)); child.kill(); }, 15000);
            pending.set(id, { command, resolve, reject, timer }); child.stdin.write(`${id} ${command}\n`);
        });
        const open = async (filename, flags = 0) => {
            const fields = await request(`P ${flags} ${encoded(filename)}`);
            assert.equal(fields[0], 'OK', JSON.stringify(fields));
            assert.equal(fields.length, 3);
            return { token: fields[1], absolute: Buffer.from(fields[2], 'hex').toString('utf16le') };
        };
        const release = token => request(`R ${token}`).then(fields => assert.deepEqual(fields, ['OK']));
        const acl = (...args) => execute(path.join(process.env.SystemRoot, 'System32/icacls.exe'), args,
            { windowsHide: true, shell: false, timeout: 15000 });
        t.after(async () => {
            child.stdin.end();
            if (!closed) await new Promise(resolve => { child.once('close', resolve); setTimeout(() => { child.kill(); resolve(); }, 3000).unref(); });
            await fs.writeFile(path.join(root, 'evidence.json'), `${JSON.stringify({ platform: process.platform, arch: process.arch,
                osRelease: os.release(), node: process.version, build, repeatedSha256: repeated.binarySha256,
                actualSha256: hash(await fs.readFile(helper)), records, stderr,
                testResult: 'Use the Node test runner result; subtest failures are not inferred from this receipt.' }, null, 2)}\n`);
            t.diagnostic(`Retained Windows filesystem evidence: ${root}`);
        });
        assert.deepEqual(await request('H'), ['OK', 'cocos4-fs-v1']);
        const directory = path.join(root, 'Directory space \u6e38\u620f');
        const payload = path.join(directory, 'payload.txt');
        await fs.mkdir(directory); await fs.writeFile(payload, 'original');
        assert.deepEqual(await request(`A ${encoded(directory)}`), ['OK']);
        assert.deepEqual(await request(`A ${encoded(payload)}`), ['OK']);

        await t.test('physical casing, Unicode and spaces are canonicalized', async () => {
            const lease = await open(payload.toUpperCase(), 4);
            assert.equal(lease.absolute, await fs.realpath(payload));
            assert.deepEqual(await request(`C ${lease.token}`), ['OK']);
            await release(lease.token);
        });
        await t.test('extended paths retain ordinary canonical outputs and pinned identities', async () => {
            const filesystemRoot = path.parse(directory).root;
            assert.equal(await hostRealpath(filesystemRoot), filesystemRoot);
            const filename = path.join(directory, 'long ' + 'x'.repeat(180), 'child ' + 'x'.repeat(40), 'payload.txt');
            await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, 'long-path payload');
            assert(filename.length > 260, 'This regression requires a real path beyond MAX_PATH');
            const lease = await open(filename);
            try {
                assert.equal(await hostRealpath(filename), lease.absolute);
                assert.equal(await hostRealpath(filename.toUpperCase()), lease.absolute);
                assert.equal((await fs.readFile(filename)).toString(), 'long-path payload');
                assert.deepEqual(await request(`C ${lease.token}`), ['OK']);
            } finally { await release(lease.token); }
        });
        await t.test('file and ancestor leases prevent replacement while permitting content writes', async () => {
            const lease = await open(payload, 4);
            await assert.rejects(fs.rename(payload, `${payload}.moved`), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
            await assert.rejects(fs.rename(directory, `${directory}-moved`), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
            await fs.writeFile(payload, 'updated');
            assert.deepEqual(await request(`C ${lease.token}`), ['OK']);
            await release(lease.token);
            await fs.rename(directory, `${directory}-moved`); await fs.rename(`${directory}-moved`, directory);
        });
        await t.test('immutable leases reject an existing writer and prevent new writes', async () => {
            const writer = await fs.open(payload, 'r+');
            try { assert.equal((await request(`P 12 ${encoded(payload)}`))[0], 'ERR'); }
            finally { await writer.close(); }
            const lease = await open(payload, 12);
            try { await assert.rejects(fs.writeFile(payload, 'blocked'), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)); }
            finally { await release(lease.token); }
            assert.equal(await fs.readFile(payload, 'utf8'), 'updated');
        });
        await t.test('hardlinks and junction ancestors are rejected', async () => {
            const hardlink = path.join(directory, 'hardlink');
            await fs.link(payload, hardlink);
            try { assert.deepEqual((await request(`P 0 ${encoded(payload)}`)).slice(0, 2), ['ERR', 'path']); }
            finally { await fs.unlink(hardlink); }
            const junction = path.join(root, 'junction');
            await fs.symlink(directory, junction, 'junction');
            try { assert.deepEqual((await request(`P 0 ${encoded(path.join(junction, 'payload.txt'))}`)).slice(0, 2), ['ERR', 'path']); }
            finally { await fs.unlink(junction); }
        });
        await t.test('noncanonical paths, DOS aliases and alternate streams are rejected', async () => {
            for (const filename of ['relative', 'C:relative', `\\\\?\\${payload}`, `${payload}:stream`, `${directory}\\..\\payload.txt`,
                `${directory}\\CON.txt`, `${directory}\\CON .txt`, `${directory}\\COM\u00b9`, `${directory}\\trailing.`, `${directory}\\trailing `]) {
                assert.deepEqual((await request(`P 0 ${encoded(filename)}`)).slice(0, 2), ['ERR', 'path'], filename);
            }
        });
        await t.test('private and trusted ACL checks detect permission changes on retained handles', async () => {
            const lease = await open(payload, 6);
            try {
                await acl(payload, '/grant', '*S-1-1-0:(R)');
                assert.deepEqual((await request(`C ${lease.token}`)).slice(0, 2), ['ERR', 'acl']);
                const publicReader = await open(payload, 4); await release(publicReader.token);
                await acl(payload, '/grant', '*S-1-1-0:(M)');
                assert.deepEqual((await request(`P 4 ${encoded(payload)}`)).slice(0, 2), ['ERR', 'acl']);
            } finally { await release(lease.token); }
            assert.deepEqual(await request(`A ${encoded(payload)}`), ['OK']);
            const privateLease = await open(payload, 6); await release(privateLease.token);
        });
        await t.test('fixed-volume root metadata rights do not permit unsafe ancestor or leaf ACLs', async () => {
            // Exercise the exact root ACL policy on a disposable directory;
            // testing it must never rewrite permissions on a real drive root.
            const source = await fs.readFile(new URL('../runtime/fs-win32.c', import.meta.url), 'utf8');
            const probeSource = path.join(root, 'root-policy-probe.c');
            const probe = path.join(root, 'root-policy-probe.exe');
            await fs.writeFile(probeSource, `#define wmain cocos4_fs_rpc_main\n${source}\n#undef wmain\n
int wmain(int argc, wchar_t **argv) {
    if (argc != 3 || !init_sids()) return 64;
    HANDLE handle = CreateFileW(argv[1], GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (handle == INVALID_HANDLE_VALUE) return 74;
    int mode = _wtoi(argv[2]);
    int ok = security(handle, mode == 3, mode != 2 && mode != 3, mode == 0);
    CloseHandle(handle);
    return ok ? 0 : 73;
}\n`);
            await compileWindowsSource({ compiler: process.env.COCOS4_WINDOWS_COMPILER ?? build.compiler.path,
                source: probeSource, output: probe, reproducible: true });
            const parent = path.join(directory, 'acl-parent');
            await fs.mkdir(parent); await fs.writeFile(path.join(parent, 'payload'), 'unchanged');
            assert.deepEqual(await request(`A ${encoded(parent)}`), ['OK']);
            await acl(parent, '/grant:r', '*S-1-1-0:(M)');
            await execute(probe, [parent, '0'], { windowsHide: true, shell: false });
            for (const mode of ['1', '2', '3']) {
                await assert.rejects(execute(probe, [parent, mode], { windowsHide: true, shell: false }), error => error.code === 73);
            }
            assert.deepEqual((await request(`P 4 ${encoded(path.join(parent, 'payload'))}`)).slice(0, 2), ['ERR', 'acl']);
            // An existing lease rechecks an ordinary ancestor's permissions.
            assert.deepEqual(await request(`A ${encoded(parent)}`), ['OK']);
            const lease = await open(path.join(parent, 'payload'), 4);
            try {
                await acl(parent, '/grant:r', '*S-1-1-0:(M)');
                assert.deepEqual((await request(`C ${lease.token}`)).slice(0, 2), ['ERR', 'acl']);
            } finally { await release(lease.token); }
            for (const permission of ['WDAC', 'WO', 'DC']) {
                await acl(parent, '/grant:r', `*S-1-1-0:(${permission})`);
                await assert.rejects(execute(probe, [parent, '0'], { windowsHide: true, shell: false }), error => error.code === 73);
            }
            assert.deepEqual(await request(`A ${encoded(parent)}`), ['OK']);
        });
        await t.test('read-only creation removes mutation permission and unknown or closed leases fail', async () => {
            const readonly = path.join(directory, 'readonly.txt'); await fs.writeFile(readonly, 'fixed');
            assert.deepEqual(await request(`O ${encoded(readonly)}`), ['OK']);
            const lease = await open(readonly, 14); await release(lease.token);
            await assert.rejects(fs.writeFile(readonly, 'changed'), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
            assert.deepEqual((await request(`C ${lease.token}`)).slice(0, 2), ['ERR', 'changed']);
            assert.deepEqual((await request('R 999999')).slice(0, 2), ['ERR', 'changed']);
        });
        await t.test('read-only files and directories can return to private writable state', async () => {
            const file = path.join(directory, 'transition.txt'); await fs.writeFile(file, 'initial');
            for (let index = 0; index < 3; index++) {
                assert.deepEqual(await request(`O ${encoded(file)}`), ['OK']);
                const readonlyLease = await open(file, 14); await release(readonlyLease.token);
                await assert.rejects(fs.writeFile(file, 'blocked'), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
                assert.deepEqual(await request(`A ${encoded(file)}`), ['OK']);
                const writableLease = await open(file, 6); await release(writableLease.token);
                await fs.writeFile(file, `writable-${index}`);
            }
            const folder = path.join(directory, 'transition-directory'); await fs.mkdir(folder);
            assert.deepEqual(await request(`O ${encoded(folder)}`), ['OK']);
            const readonlyLease = await open(folder, 7); await release(readonlyLease.token);
            await assert.rejects(fs.writeFile(path.join(folder, 'blocked'), 'blocked'), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
            assert.deepEqual(await request(`A ${encoded(folder)}`), ['OK']);
            const writableLease = await open(folder, 7); await release(writableLease.token);
            await fs.writeFile(path.join(folder, 'allowed'), 'writable');
        });
        await t.test('ACL restoration still rejects foreign-owned files without altering them', async () => {
            const file = path.join(directory, 'foreign-owner.txt'); await fs.writeFile(file, 'unchanged');
            await acl(file, '/setowner', '*S-1-1-0');
            for (const command of ['A', 'O']) assert.deepEqual((await request(`${command} ${encoded(file)}`)).slice(0, 2), ['ERR', 'acl']);
            assert.equal(await fs.readFile(file, 'utf8'), 'unchanged');
            await acl(file, '/setowner', '*S-1-5-32-544');
            assert.deepEqual(await request(`A ${encoded(file)}`), ['OK']);
            const lease = await open(file, 6); await release(lease.token);
        });
    });
