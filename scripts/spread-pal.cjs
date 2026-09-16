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
        ['input/nodejs/keyboard-input.d.ts', 'jsb.KeyboardEvent', 'Pick<KeyboardEvent, \'keyCode\'>', 2],
        ['wasm/wasm-nodejs.js', '/native/external/', '/external/', 2],
        ['wasm/wasm-web.js', '${info.native.path}/external/', '${info.typescript.path}/external/', 2],
        ['system-info/enum-type/platform.js', 'Platform["WECHAT_GAME"]="WECHAT_GAME";', 'Platform["WECHAT_GAME"]="WECHAT_GAME";Platform["BILIBILI_MINI_GAME"]="BILIBILI_MINI_GAME";'],
        ['system-info/enum-type/platform.d.ts', '    WECHAT_GAME = "WECHAT_GAME",', '    WECHAT_GAME = "WECHAT_GAME",\n    BILIBILI_MINI_GAME = "BILIBILI_MINI_GAME",'],
        ['system-info/minigame/system-info.js', 'import { WECHAT,', 'import { BILIBILI, WECHAT,'],
        ['system-info/minigame/system-info.js', 'if(WECHAT){currentPlatform=Platform.WECHAT_GAME;}', 'if(BILIBILI){currentPlatform=Platform.BILIBILI_MINI_GAME;}else if(WECHAT){currentPlatform=Platform.WECHAT_GAME;}'],
    ];
    const patchedFiles = new Map();
    for (const [relative, before, after, count = 1] of patches) {
        const text = patchedFiles.get(relative) ?? fs.readFileSync(path.join(source, relative), 'utf8');
        if (text.split(before).length !== count + 1) throw new Error(`PAL patch no longer matches: ${relative}`);
        patchedFiles.set(relative, text.replaceAll(before, after));
    }
    const bilibili = path.join(__dirname, 'platforms/bilibili/pal');
    for (const file of ['host.ts', 'minigame.ts', 'system-info.ts', 'env.ts', 'wasm.ts']) {
        if (!fs.statSync(path.join(bilibili, file)).isFile()) throw new Error(`Missing Bilibili PAL: ${file}`);
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
    fs.cpSync(bilibili, path.join(target, 'bilibili'), { recursive: true });
    console.log('[pal] Prepared mini-game, runtime, Web and Node.js implementations.');
}

module.exports = { spreadPal };
if (require.main === module) spreadPal();
