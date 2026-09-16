const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildEngine, StatsQuery } = require('@cocos/ccbuild');
const config = require('../cc.config.json');

async function main() {
    if (process.argv.length > 4) throw new Error('Usage: build-minigame.cjs [platform] [feature,feature,...]');
    const platform = (process.argv[2] || 'WECHAT').toUpperCase();
    if (!config.platforms.includes(platform) || ['HTML5', 'NODEJS'].includes(platform)) {
        throw new Error(`Not a mini-game target: ${platform}`);
    }
    const engine = path.join(__dirname, '..');
    const stats = await StatsQuery.create(engine);
    const features = process.argv[3]?.split(',') || ['base', '2d', 'ui', 'audio', 'tween', 'gfx-webgl', 'gfx-webgl2'];
    for (const feature of features) {
        if (!stats.getFeatures().includes(feature)) throw new Error(`Unknown feature: ${feature}`);
    }
    // ccbuild reports some TypeScript failures as warnings; do not publish an unchecked bundle.
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--project', path.join(engine, 'tsconfig.json')], { stdio: 'inherit' });
    await buildEngine({
        engine, platform, features, mode: 'BUILD', moduleFormat: 'system',
        out: path.join(engine, 'bin', 'minigame', platform.toLowerCase()),
        compress: false, sourceMap: true,
    });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
