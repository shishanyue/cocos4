const fs = require('node:fs');
const path = require('node:path');

function spreadAdapter(engineRoot = path.join(__dirname, '..')) {
    const { version } = JSON.parse(fs.readFileSync(path.join(engineRoot, 'node_modules', '@cocos', 'engine-platforms', 'package.json'), 'utf8'));
    if (version !== '1.0.6') throw new Error(`Review adapter integration before using ${version}`);
    const source = path.join(engineRoot, 'node_modules', '@cocos', 'engine-platforms', 'bin', 'adapter');
    const target = path.join(engineRoot, 'bin', 'adapter');
    const groups = ['minigame', 'runtime', 'nodejs'];
    for (const group of groups) {
        if (!fs.statSync(path.join(source, group)).isDirectory()) throw new Error(`Missing adapter group: ${group}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    for (const group of groups) fs.cpSync(path.join(source, group), path.join(target, group), { recursive: true });
    console.log('[adapter] Prepared mini-game, runtime and editor adapters.');
}

module.exports = { spreadAdapter };
if (require.main === module) spreadAdapter();
