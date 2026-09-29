import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Maintainer/package-build step only. The installed application never invokes a
// compiler, resolves ancestor packages, installs dependencies, or rewrites SDKs.
const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.platform, 'linux', 'Only the verified Linux supervisor is implemented.');
assert.equal(process.argv.length, 2, 'Usage: node scripts/build-supervisor.mjs (fixed build/host output)');
const output = path.join(root, 'build/host');
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const temporary = path.join(output, `.prepare-${randomUUID()}`);
await fs.mkdir(temporary, { mode: 0o700 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
try {
    await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
            '-fstack-protector-strong', '-Wl,-z,relro,-z,now', path.join(root, 'runtime/supervise.c'), '-o', path.join(temporary, 'cocos4-supervise')],
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        let diagnostic = '';
        for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-8192); });
        child.on('error', reject);
        child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Host compiler failed (${code ?? signal}): ${diagnostic}`)));
    });
    const types = path.join(temporary, 'logic-types');
    await fs.mkdir(types, { mode: 0o700 });
    const files = [];
    for (const [name, version, destination] of [['@types/node', '18.19.130', 'node'], ['undici-types', '5.26.5', 'undici-types']]) {
        const source = path.join(root, 'node_modules', name);
        const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
        assert.equal(manifest.name, name);
        assert.equal(manifest.version, version, 'Review and pin host declaration upgrades explicitly.');
        async function copy(directory, prefix) {
            const stat = await fs.lstat(directory);
            assert(stat.isDirectory() && !stat.isSymbolicLink());
            await fs.mkdir(path.join(types, prefix), { recursive: true, mode: 0o700 });
            for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
                assert(!entry.isSymbolicLink());
                if (entry.isDirectory()) { await copy(path.join(directory, entry.name), `${prefix}/${entry.name}`); continue; }
                assert(entry.isFile());
                if (!entry.name.endsWith('.d.ts') && !['package.json', 'LICENSE'].includes(entry.name)) continue;
                const bytes = await fs.readFile(path.join(directory, entry.name));
                const relative = `${prefix}/${entry.name}`;
                await fs.writeFile(path.join(types, relative), bytes, { flag: 'wx', mode: 0o400 });
                files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
            }
        }
        await copy(source, destination);
    }
    await fs.writeFile(path.join(types, 'inventory.json'), JSON.stringify({ version: 1, node: '18.19.130', undici: '5.26.5', files }, null, 2) + '\n', { mode: 0o400 });
    const binary = await fs.readFile(path.join(temporary, 'cocos4-supervise'));
    await fs.writeFile(path.join(temporary, 'supervisor.json'), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch,
        file: 'cocos4-supervise', sha256: sha256(binary), bytes: binary.length,
        sourceSha256: sha256(await fs.readFile(path.join(root, 'runtime/supervise.c'))) }, null, 2) + '\n', { mode: 0o400 });
    // Only this fixed, generated host namespace is replaced. Never touch saved SDKs.
    await fs.rm(path.join(output, 'logic-types'), { recursive: true, force: true });
    for (const name of ['logic-types', 'cocos4-supervise', 'supervisor.json']) await fs.rename(path.join(temporary, name), path.join(output, name));
    process.stdout.write(JSON.stringify({ output, supervisorSha256: sha256(binary), typeFiles: files.length }) + '\n');
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
