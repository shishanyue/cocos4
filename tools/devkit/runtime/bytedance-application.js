/* global System */
System.register([], function (exports) {
    'use strict';
    class Application {
        init(cc) {
            if (!this.initialization) this.initialization = Promise.resolve().then(async () => {
                this.cc = cc;
                const metadata = globalThis.__bytedanceRequire('./game-compiler.json');
                for (const name of metadata.requiredCCExports) {
                    if (!(name in cc)) throw new Error(`FEATURE_NOT_IN_PROFILE: ${name}`);
                }
                await cc.game.init({ settingsPath: 'settings.json', debugMode: 1, overrideSettings: {} });
                const builtins = globalThis.__bytedanceRequire('./builtin-report.json');
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
            if (!this.startup) this.startup = new Promise((resolve, reject) => {
                if (!this.main) throw new Error('APPLICATION_NOT_INITIALIZED');
                let called = false;
                // Game.run returns void. Both a thrown run and a rejected/thrown main.start must reject startup.
                this.cc.game.run(() => {
                    if (called) return;
                    called = true;
                    Promise.resolve().then(() => this.main.start()).then(resolve, reject);
                });
            });
            return this.startup;
        }
    }
    return { execute() { exports('Application', Application); } };
});
