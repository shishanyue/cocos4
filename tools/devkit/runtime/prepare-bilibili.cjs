const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

// Maintainer-only template rendering. Neither EJS nor project-controlled templates ship as compiler dependencies.
async function prepareBilibili({ engine, output }) {
    const rootRequire = createRequire(path.join(engine, 'package.json'));
    const template = path.join(engine, 'templates/bilibili/game.ejs');
    const ejs = rootRequire(rootRequire.resolve('ejs', { paths: [path.dirname(rootRequire.resolve('@cocos/ccbuild'))] }));
    const launcher = ejs.render(await fs.readFile(template, 'utf8'), {
        polyfillsBundleFile: '', systemJsBundleFile: './loader.js', importMapFile: './import-map.json',
        applicationJs: './application.js', useWebgl2: false, autoLaunchSuccess: true,
    }, { filename: template });
    await fs.writeFile(path.join(output, 'game.js'), launcher, { flag: 'wx' });
    const config = JSON.parse(await fs.readFile(path.join(engine, 'templates/bilibili/game.json'), 'utf8'));
    await fs.writeFile(path.join(output, 'game.json'), JSON.stringify({ ...config,
        appId: 'cocos4-local-validation-only', version: '0.0.0-local-validation', deviceOrientation: 'landscape',
    }, null, 2) + '\n', { flag: 'wx' });
    const { transformSync } = rootRequire('@babel/core');
    for (const name of ['web-adapter.js', 'engine-adapter.js', 'fs-utils.js']) {
        const source = await fs.readFile(path.join(engine, 'scripts/platforms/bilibili/adapter', name), 'utf8');
        const { code } = transformSync(source, { babelrc: false, configFile: false, comments: true, compact: false, minified: false,
            presets: [[rootRequire.resolve('@babel/preset-env'), { targets: { chrome: '66' }, modules: false }]],
        });
        const prepared = await fs.readFile(path.join(engine, 'bin/adapter/minigame/bilibili', name));
        assert.equal(prepared.toString(), code, `Stale prepared Bilibili adapter: ${name}; run npm run prepare:engine`);
        await fs.writeFile(path.join(output, name), prepared, { flag: 'wx' });
    }
    await fs.copyFile(path.join(__dirname, 'bilibili-application.js'), path.join(output, 'application.js'));

    // Keep the browser-accepted fixture untouched; only the Bilibili maintainer copy gains touch restart.
    const main = path.join(output, 'template/src/main.ts');
    const source = await fs.readFile(main, 'utf8');
    const anchor = '        text.addComponent(UITransform).setContentSize(600, 100);';
    assert.equal(source.split(anchor).length, 2, 'Review Bilibili touch restart fixture patch');
    await fs.writeFile(main, source.replace(anchor, `${anchor}\n        text.on(Node.EventType.TOUCH_END, () => this.keyUp({ keyCode: KeyCode.KEY_R } as EventKeyboard), this);`));
    const rulesFile = path.join(output, 'template/assets/rules.json');
    const rules = JSON.parse(await fs.readFile(rulesFile, 'utf8'));
    await fs.writeFile(rulesFile, JSON.stringify({ ...rules, restart: 'TOUCH THIS TEXT TO RESTART' }) + '\n');
}

module.exports = { prepareBilibili };
