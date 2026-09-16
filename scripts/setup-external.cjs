const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const required = [
    'external-wasm.d.ts', 'bullet/bullet.d.ts', 'physx/physx.d.ts',
    'physx/phy.d.ts', 'box2d/b2.d.ts',
    'webgpu/webgpu.d.ts', 'spine/spine.d.ts', 'meshopt/meshopt_decoder.d.ts', 'box2d/box2d.d.ts',
    ...['bullet', 'physx', 'box2d'].flatMap(name =>
        ['wasm.js', 'wasm.wasm', 'asm.js'].map(ext => `${name}/${name}.release.${ext}`)),
    ...['wasm.js', 'wasm.wasm', 'asm.js'].map(ext => `meshopt/meshopt_decoder.${ext}`),
    ...['glslang.js', 'glslang.wasm', 'twgsl.js', 'twgsl.wasm'].map(name => `webgpu/${name}`),
    ...['3.8', '4.2'].flatMap(version =>
        ['wasm.js', 'wasm', 'asm.js', 'js.mem'].map(ext => `spine/${version}/spine.${ext}`)),
];

function setupExternal({ root = path.join(__dirname, '..'), source } = {}) {
    const { from } = JSON.parse(fs.readFileSync(path.join(root, 'external-config.json'), 'utf8'));
    const output = path.join(root, 'external');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-web-external-'));
    let transaction;
    try {
        const origin = source ? `source:${path.resolve(source)}` : `${from.owner}/${from.name}@${from.checkout}`;
        if (source) {
            source = path.resolve(source);
        } else {
            source = path.join(temporary, 'checkout');
            const repository = `https://github.com/${from.owner}/${from.name}.git`;
            execFileSync('git', ['clone', '--depth=1', '--filter=blob:none', '--sparse', '--branch', from.checkout, repository, source], { stdio: 'inherit', timeout: 120000 });
            execFileSync('git', ['sparse-checkout', 'set', 'emscripten', 'licenses'], { cwd: source, stdio: 'inherit', timeout: 120000 });
        }
        const staged = path.join(temporary, 'emscripten');
        const copyOptions = {
            recursive: true,
            filter: file => {
                if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`External artifacts must not contain symlinks: ${file}`);
                return true;
            },
        };
        fs.cpSync(path.join(source, 'emscripten'), staged, copyOptions);
        for (const file of required) {
            const stat = fs.statSync(path.join(staged, file), { throwIfNoEntry: false });
            if (!stat?.isFile() || stat.size === 0) throw new Error(`Incomplete Web external: ${file}`);
        }
        const stagedLicenses = path.join(temporary, 'licenses');
        fs.mkdirSync(stagedLicenses);
        for (const name of fs.readdirSync(source)) {
            if (/licen[cs]e|copyright|notice/i.test(name)) {
                fs.cpSync(path.join(source, name), path.join(stagedLicenses, name), copyOptions);
            }
        }
        for (const dir of [output, path.join(output, 'emscripten'), path.join(output, 'licenses')]) {
            if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
                throw new Error(`Refusing to replace a shared external symlink: ${dir}`);
            }
        }
        fs.mkdirSync(output, { recursive: true });
        // Stage on the destination filesystem before replacing only generated artifacts.
        transaction = fs.mkdtempSync(path.join(output, '.setup-'));
        fs.cpSync(staged, path.join(transaction, 'emscripten'), { recursive: true });
        fs.cpSync(stagedLicenses, path.join(transaction, 'licenses'), { recursive: true });
        fs.writeFileSync(path.join(transaction, '.version'), `${origin}\n`);
        const installed = [];
        const backedUp = [];
        try {
            for (const name of ['emscripten', 'licenses', '.version']) {
                const target = path.join(output, name);
                if (fs.existsSync(target)) {
                    fs.renameSync(target, path.join(transaction, `${name}.previous`));
                    backedUp.push(name);
                }
                fs.renameSync(path.join(transaction, name), target);
                installed.push(name);
            }
        } catch (error) {
            for (const name of installed) fs.rmSync(path.join(output, name), { recursive: true, force: true });
            for (const name of backedUp) fs.renameSync(path.join(transaction, `${name}.previous`), path.join(output, name));
            throw error;
        }
        console.log(`[external] Prepared Web/WASM artifacts from ${origin}`);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
        if (transaction) fs.rmSync(transaction, { recursive: true, force: true });
    }
}

module.exports = { setupExternal, required };
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--source' || !args[1] || args[1].startsWith('--'))) {
        throw new Error('Usage: setup-external.cjs [--source <external checkout path>]');
    }
    setupExternal({ source: args[1] });
}
