/* global System */
System.register([], function (exports) {
    'use strict';
    class Application {
        async init(cc) {
            this.cc = cc;
            const metadata = globalThis.__bilibiliRequire('./game-compiler.json');
            for (const name of metadata.requiredCCExports) {
                if (!(name in cc)) throw new Error(`FEATURE_NOT_IN_PROFILE: ${name}`);
            }
            await cc.game.init({ settingsPath: 'settings.json', debugMode: 1, overrideSettings: {} });
            const builtins = globalThis.__bilibiliRequire('./builtin-report.json');
            for (const { uuid } of [...builtins.effects, ...builtins.materials]) {
                const asset = cc.assetManager.assets.get(uuid);
                if (!asset || !cc.isValid(asset)) throw new Error(`BUILTIN_NOT_LOADED: ${uuid}`);
                if (asset instanceof cc.Material && !asset.passes.length) throw new Error(`BUILTIN_MATERIAL_INVALID: ${uuid}`);
            }
            globalThis.__runtimeBuiltins = { effects: builtins.effects.length, materials: builtins.materials.length };
            this.main = await System.import('./game/main.js');
            if (typeof this.main.start !== 'function') throw new Error('GAME_START_REQUIRED');
            globalThis.__runtimeProbe = this.main.probe;
            globalThis.__checkMissingAsset = this.main.checkMissingAsset;
        }

        start() {
            // Game.run returns void, not the Promise returned by the onStart callback.
            return new Promise((resolve, reject) => {
                this.cc.game.run(() => {
                    Promise.resolve().then(() => this.main.start()).then(resolve, reject);
                });
            });
        }
    }
    return { execute() { exports('Application', Application); } };
});
