const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { assertAbsent, canonicalDirectory, readRegular, sha256 } = require('./files.cjs');

// 0.0.21 accepts a platform string: only the three web IDs select its browser preset.
const loaderPlatform = 'bytedance-mini-game';
const adapterHashes = {
    'web-adapter.js': '6956a6256ae4a15a1b0c6dd41883acd1cba655e049681e0490f9a301f96443e3',
    'engine-adapter.js': '634012352eb5c560b26337c055ef836cd3726aba67e88e39b9afcb165ff2c56c',
};

async function prepareBytedance({ engine, output }) {
    engine = await canonicalDirectory(engine);
    output = await canonicalDirectory(output);
    const packageRoot = 'node_modules/@cocos/engine-platforms';
    const packageBytes = await readRegular(engine, `${packageRoot}/package.json`);
    const manifest = JSON.parse(packageBytes);
    assert.equal(manifest.name, '@cocos/engine-platforms');
    assert.equal(manifest.version, '1.0.6', 'Review ByteDance adapter integration before upgrading');
    assert.equal(manifest.license, 'UNLICENSED', 'Review ByteDance adapter licensing metadata');
    assert.equal(require('@cocos/module-system/package.json').version, '0.0.21');
    assert.equal(sha256(await readRegular(engine, 'templates/bytedance-mini-game/game.ejs')),
        '5c10d77ebc5f15b927a31910efec5153507db0f54204f1b9a4487ca57845e47a',
        'Review bytedance-game.js against the changed Creator template');

    const files = new Map();
    for (const [name, hash] of Object.entries(adapterHashes)) {
        const published = await readRegular(engine, `${packageRoot}/bin/adapter/minigame/bytedance/${name}`);
        assert.equal(sha256(published), hash, `Review published ByteDance adapter: ${name}`);
        const prepared = await readRegular(engine, `bin/adapter/minigame/bytedance/${name}`);
        assert.ok(prepared.equals(published), `Stale prepared ByteDance adapter: ${name}; run npm run prepare:engine`);
        files.set(name, prepared);
    }
    files.set('game.js', await readRegular(__dirname, 'bytedance-game.js'));
    files.set('application.js', await readRegular(__dirname, 'bytedance-application.js'));
    // The published Browserify engine adapter embeds ../fs-utils (module 8).
    // Expose that very instance, not a second implementation or a different platform's fs API.
    files.set('fs-utils.js', Buffer.from("'use strict';\nrequire('./engine-adapter.js');\n"
        + "if (!window.fsUtils || !window.fsUtils.fs) throw new Error('BYTEDANCE_FS_UTILS_REQUIRED');\n"
        + 'module.exports = window.fsUtils;\n'));
    const game = JSON.parse(await readRegular(engine, 'templates/bytedance-mini-game/game.json'));
    const project = JSON.parse(await readRegular(engine, 'templates/bytedance-mini-game/project.config.json'));
    const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
    files.set('game.json', json({ ...game, deviceOrientation: 'landscape' }));
    // Runtime verification only. createProject must put configs in platforms/bytedance/ and blank appid.
    files.set('project.config.json', json({ ...project, appid: 'tt0000000000000000', projectname: 'cocos4-local-validation-only' }));
    files.set('licenses/bytedance/package.json', packageBytes);
    files.set('licenses/bytedance/README.md', await readRegular(engine, `${packageRoot}/README.md`));
    files.set('licenses/bytedance/ENGINE-LICENSE', await readRegular(engine, 'LICENSE'));
    files.set('licenses/bytedance/NOTICE.txt', Buffer.from(
        '@cocos/engine-platforms 1.0.6 declares UNLICENSED and ships no standalone license file.\n'
        + 'Its package metadata and README are preserved verbatim alongside the engine license.\n'
        + 'The engine license does not grant rights to this separate package or its bundled third-party code.\n'
        + 'Redistribution/license review remains required; this is local integration evidence only.\n'));

    // Only the private maintainer fixture gains a touch restart. Never edit the shared fixture.
    const main = (await readRegular(output, 'template/src/main.ts')).toString();
    const anchor = '        text.addComponent(UITransform).setContentSize(600, 100);';
    assert.equal(main.split(anchor).length, 2, 'Review ByteDance touch restart fixture patch');
    assert.ok(!main.includes('text.on(Node.EventType.TOUCH_END'), 'ByteDance fixture already prepared');
    const rules = JSON.parse(await readRegular(output, 'template/assets/rules.json'));
    for (const name of files.keys()) await assertAbsent(path.join(output, name));
    for (const [name, bytes] of files) {
        await fs.mkdir(path.dirname(path.join(output, name)), { recursive: true });
        await fs.writeFile(path.join(output, name), bytes, { flag: 'wx' });
    }
    await fs.writeFile(path.join(output, 'template/src/main.ts'), main.replace(anchor,
        `${anchor}\n        text.on(Node.EventType.TOUCH_END, () => this.keyUp({ keyCode: KeyCode.KEY_R } as EventKeyboard), this);`));
    await fs.writeFile(path.join(output, 'template/assets/rules.json'), json({ ...rules, restart: 'TOUCH THIS TEXT TO RESTART' }));
    return { loaderPlatform };
}

module.exports = { prepareBytedance, loaderPlatform };
