/* global System */
System.register([], function (exports) {
    'use strict';
    class Application {
        init(cc) {
            if (this.initialization) return this.initialization;
            this.cc = cc;
            this.initialization = Promise.resolve().then(async () => {
                const metadata = globalThis.__wechatRequire('./game-compiler.json');
                for (const name of metadata.requiredCCExports) {
                    if (!(name in cc)) throw new Error(`FEATURE_NOT_IN_PROFILE: ${name}`);
                }
                await cc.game.init({ settingsPath: 'settings.json', debugMode: 1, overrideSettings: {} });
                const builtins = globalThis.__wechatRequire('./builtin-report.json');
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
            });
            return this.initialization;
        }

        start() {
            if (this.startup) return this.startup;
            // Game.run is void and may defer its callback. Never resolve before main.start settles.
            this.startup = new Promise((resolve, reject) => {
                let called = false;
                this.cc.game.run(() => {
                    if (called) return;
                    called = true;
                    Promise.resolve().then(() => this.main.start()).then(() => resolve(), reject);
                });
            });
            return this.startup;
        }
    }
    return { execute() { exports('Application', Application); } };
});
