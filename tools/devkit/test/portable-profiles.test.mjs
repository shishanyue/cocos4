import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyReleaseProfiles } from '../scripts/verify-portable.mjs';

const profiles = targets => targets.flatMap(target => ['2d-basic', '3d-basic'].flatMap(id =>
    ['debug', 'release'].map(variant => ({ target, id, variant }))));

test('release inventories retain the shipped base and accept complete added mini-game targets', () => {
    for (const targets of [['HTML5', 'BILIBILI'], ['HTML5', 'BILIBILI', 'WECHAT'],
        ['HTML5', 'BILIBILI', 'BYTEDANCE'], ['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE']]) {
        assert.doesNotThrow(() => verifyReleaseProfiles(profiles(targets).reverse()));
    }
});

test('new release targets cannot omit a profile or relabel duplicate/debug-only output', () => {
    const complete = profiles(['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE']);
    for (let index = 0; index < complete.length; index++) {
        assert.throws(() => verifyReleaseProfiles(complete.filter((_, i) => i !== index)));
    }
    assert.throws(() => verifyReleaseProfiles(complete.map(profile => ({ ...profile, variant: 'debug' }))));
    assert.throws(() => verifyReleaseProfiles([...complete.slice(1), complete[1]]));
    assert.throws(() => verifyReleaseProfiles(profiles(['HTML5', 'WECHAT'])));
});

test('unsupported and malformed release inventories fail before packaging', () => {
    for (const value of [undefined, null, {}, [], [null],
        profiles(['HTML5', 'BILIBILI', 'WECHAT_MINI_PROGRAM']),
        profiles(['HTML5', 'BILIBILI', 'ANDROID']),
        profiles(['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE', 'OPPO'])]) {
        assert.throws(() => verifyReleaseProfiles(value));
    }
});
