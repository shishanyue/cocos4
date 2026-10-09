const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { assertAbsent, canonicalDirectory, readRegular } = require('./files.cjs');

// module-system 0.0.21 uses its commonjs-like preset for Creator's wechatgame target.
const loaderPlatform = 'wechatgame';

async function prepareWechat({ engine, output }) {
    engine = await canonicalDirectory(engine);
    output = await canonicalDirectory(output);
    const rootRequire = createRequire(path.join(engine, 'package.json'));
    const packageRoot = 'node_modules/@cocos/engine-platforms';
    const metadata = JSON.parse(await readRegular(engine, `${packageRoot}/package.json`));
    assert.equal(metadata.name, '@cocos/engine-platforms');
    assert.equal(metadata.version, '1.0.6', 'Review the pinned WeChat adapters before upgrading');
    assert.equal(metadata.license, 'UNLICENSED', 'Review the adapter redistribution terms');
    const files = new Map();
    for (const name of ['web-adapter.js', 'engine-adapter.js']) {
        const relative = `bin/adapter/minigame/wechat/${name}`;
        const source = await readRegular(engine, `${packageRoot}/${relative}`);
        const prepared = await readRegular(engine, relative);
        assert.ok(source.length && source.equals(prepared), `Stale prepared WeChat adapter: ${name}; run npm run prepare:engine`);
        files.set(name, prepared);
    }

    // 1.0.6 bundles fs-utils inside web-adapter; do not invent a second filesystem adapter.
    const ast = rootRequire('@babel/parser').parse(files.get('web-adapter.js').toString(), { sourceType: 'script' });
    const modules = ast.program.body[0]?.expression?.arguments?.[0];
    assert.equal(modules?.type, 'ObjectExpression', 'Review the WeChat Browserify closure');
    const dependencies = modules.properties.flatMap(item => item.value.elements[1].properties);
    const fsLinks = dependencies.filter(item => item.key.value === '../fs-utils');
    assert.equal(fsLinks.length, 1, 'Review the embedded WeChat fs-utils entry');
    const fsModule = modules.properties.find(item => item.key.value === fsLinks[0].value.value);
    assert.equal(fsModule?.value.elements[0].type, 'FunctionExpression');
    assert.deepEqual(fsModule.value.elements[1].properties, [], 'WeChat fs-utils must remain self-contained');
    files.set('fs-utils.js', Buffer.from([
        "'use strict';",
        '// The implementation and its dependency closure are in the unmodified pinned web-adapter.',
        "require('./web-adapter.js');",
        'const fsUtils = globalThis.window && globalThis.window.fsUtils;',
        "if (!fsUtils || !fsUtils.fs) throw new Error('WECHAT_FILESYSTEM_REQUIRED');",
        'module.exports = fsUtils;',
        '',
    ].join('\n')));
    const readme = await readRegular(engine, `${packageRoot}/README.md`);
    files.set('WECHAT-ADAPTER-LICENSE', Buffer.from([
        '@cocos/engine-platforms 1.0.6',
        'Declared package license: UNLICENSED',
        'This notice is not a redistribution license. The engine MIT license does not replace these terms.',
        'The pinned package includes no standalone license file; its README is preserved verbatim below.',
        '',
        readme.toString(),
    ].join('\n')));
    files.set('game.js', await readRegular(__dirname, 'wechat-game.js'));
    files.set('application.js', await readRegular(__dirname, 'wechat-application.js'));
    const game = JSON.parse(await readRegular(engine, 'templates/wechatgame/game.json'));
    const project = JSON.parse(await readRegular(engine, 'templates/wechatgame/project.config.json'));
    assert.equal(project.compileType, 'game');
    const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
    // These root configs are maintainer fixtures. Game projects own platforms/wechat/*.json.
    files.set('game.json', json({ ...game, deviceOrientation: 'landscape' }));
    files.set('project.config.json', json({ ...project, description: 'TEST_ONLY: Cocos4 local validation; not a vendor app',
        appid: 'wx0000000000000000', projectname: 'cocos4-wechat-local-validation', miniprogramRoot: './' }));

    const main = (await readRegular(output, 'template/src/main.ts')).toString();
    const anchor = '        text.addComponent(UITransform).setContentSize(600, 100);';
    assert.equal(main.split(anchor).length, 2, 'Review the WeChat touch restart fixture patch');
    assert.ok(!main.includes('text.on(Node.EventType.TOUCH_END'), 'WeChat fixture already prepared');
    const rules = JSON.parse(await readRegular(output, 'template/assets/rules.json'));
    for (const name of files.keys()) await assertAbsent(path.join(output, name));
    for (const [name, bytes] of files) await fs.writeFile(path.join(output, name), bytes, { flag: 'wx' });
    await fs.writeFile(path.join(output, 'template/src/main.ts'), main.replace(anchor,
        `${anchor}\n        text.on(Node.EventType.TOUCH_END, () => this.keyUp({ keyCode: KeyCode.KEY_R } as EventKeyboard), this);`));
    await fs.writeFile(path.join(output, 'template/assets/rules.json'), json({ ...rules, restart: 'TOUCH THIS TEXT TO RESTART' }));
}

module.exports = { prepareWechat, loaderPlatform };
