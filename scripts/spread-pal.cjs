const fs = require('node:fs');
const path = require('node:path');

function spreadPal(engineRoot = path.join(__dirname, '..')) {
    const packageRoot = path.join(engineRoot, 'node_modules', '@cocos', 'engine-pal');
    const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (version !== '1.0.4') throw new Error(`Review PAL integration before using ${version}`);
    const source = path.join(packageRoot, 'dist');
    const target = path.join(engineRoot, 'pal');

    // Physical copies are required by relative imports and Creator's quick compiler.
    const patches = [
        ['input/nodejs/keyboard-input.d.ts', 'jsb.KeyboardEvent', 'Pick<KeyboardEvent, \'keyCode\'>'],
        ['wasm/wasm-nodejs.js', '/native/external/', '/external/'],
        ['wasm/wasm-web.js', '${info.native.path}/external/', '${info.typescript.path}/external/'],
    ];
    const patchedFiles = new Map();
    for (const [relative, before, after] of patches) {
        const text = fs.readFileSync(path.join(source, relative), 'utf8');
        if (!text.includes(before)) throw new Error(`PAL patch no longer matches: ${relative}`);
        patchedFiles.set(relative, text.replaceAll(before, after));
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, {
        recursive: true,
        filter: (file) => {
            const parts = path.relative(source, file).split(path.sep);
            return !parts.includes('native') && !/^pacer-native\./.test(path.basename(file))
                && !/^wasm-native\./.test(path.basename(file));
        },
    });
    for (const [relative, text] of patchedFiles) fs.writeFileSync(path.join(target, relative), text);
    console.log('[pal] Prepared mini-game, runtime, Web and Node.js implementations.');
}

module.exports = { spreadPal };
if (require.main === module) spreadPal();
