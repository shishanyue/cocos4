/* global System */
(async () => {
    const response = await fetch('game-compiler.json');
    if (!response.ok) throw new Error('Missing game compiler metadata');
    const metadata = await response.json();
    const cc = await System.import('cc');
    for (const name of metadata.requiredCCExports) {
        if (!(name in cc)) throw new Error(`FEATURE_NOT_IN_PROFILE: ${name}`);
    }
    await cc.game.init({ settingsPath: 'settings.json', debugMode: 1, overrideSettings: {} });
    const builtinResponse = await fetch('builtin-report.json');
    if (!builtinResponse.ok) throw new Error('Missing builtin metadata');
    const builtins = await builtinResponse.json();
    for (const { uuid } of [...builtins.effects, ...builtins.materials]) {
        const asset = cc.assetManager.assets.get(uuid);
        if (!asset || !cc.isValid(asset)) throw new Error(`BUILTIN_NOT_LOADED: ${uuid}`);
        if (asset instanceof cc.Material && !asset.passes.length) throw new Error(`BUILTIN_MATERIAL_INVALID: ${uuid}`);
    }
    globalThis.__runtimeBuiltins = { effects: builtins.effects.length, materials: builtins.materials.length };
    const main = await System.import('./game/main.js');
    globalThis.__runtimeProbe = main.probe;
    globalThis.__checkMissingAsset = main.checkMissingAsset;
    cc.game.run(() => {
        main.start().catch(fail);
    });
})().catch(fail);

function fail(error) {
    console.error(error);
    globalThis.__runtimeError = String(error.stack || error);
    const element = document.getElementById('error');
    element.hidden = false;
    element.textContent = globalThis.__runtimeError;
}
