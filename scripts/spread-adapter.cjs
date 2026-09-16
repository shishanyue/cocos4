const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('@babel/core');

function spreadAdapter(engineRoot = path.join(__dirname, '..')) {
    const { version } = JSON.parse(fs.readFileSync(path.join(engineRoot, 'node_modules', '@cocos', 'engine-platforms', 'package.json'), 'utf8'));
    if (version !== '1.0.6') throw new Error(`Review adapter integration before using ${version}`);
    const source = path.join(engineRoot, 'node_modules', '@cocos', 'engine-platforms', 'bin', 'adapter');
    const target = path.join(engineRoot, 'bin', 'adapter');
    const groups = ['minigame', 'runtime', 'nodejs'];
    for (const group of groups) {
        if (!fs.statSync(path.join(source, group)).isDirectory()) throw new Error(`Missing adapter group: ${group}`);
    }
    const bilibili = new Map();
    for (const file of ['web-adapter', 'engine-adapter', 'fs-utils']) {
        const source = fs.readFileSync(path.join(__dirname, 'platforms/bilibili/adapter', `${file}.js`), 'utf8');
        for (const minified of [false, true]) {
            const { code } = transformSync(source, {
                babelrc: false, configFile: false, comments: !minified, compact: minified, minified,
                presets: [[require.resolve('@babel/preset-env'), { targets: { chrome: '66' }, modules: false }]],
            });
            bilibili.set(`${file}${minified ? '.min' : ''}.js`, code);
        }
    }
    fs.rmSync(target, { recursive: true, force: true });
    for (const group of groups) fs.cpSync(path.join(source, group), path.join(target, group), { recursive: true });
    const bilibiliTarget = path.join(target, 'minigame/bilibili');
    fs.mkdirSync(bilibiliTarget, { recursive: true });
    for (const [file, text] of bilibili) fs.writeFileSync(path.join(bilibiliTarget, file), text);
    console.log('[adapter] Prepared mini-game, runtime and editor adapters.');
}

module.exports = { spreadAdapter };
if (require.main === module) spreadAdapter();
