/* global System */
globalThis.__bootstrap = { phase: 'loader', error: '', builtins: [] };
function fail(error) {
    globalThis.__bootstrap.error = String(error.stack || error);
    console.error(error);
    const element = document.getElementById('error');
    element.hidden = false;
    element.textContent = globalThis.__bootstrap.error;
}
addEventListener('unhandledrejection', event => fail(event.reason));
(async () => {
    const cc = await System.import('cc');
    globalThis.__bootstrap.phase = 'init';
    await cc.game.init({ settingsPath: 'settings.json', debugMode: cc.DebugMode.INFO });
    const response = await fetch('builtin-manifest.json');
    if (!response.ok) throw new Error('Builtin manifest unavailable');
    const manifest = await response.json();
    for (const record of manifest) {
        const asset = cc.assetManager.assets.get(record.uuid);
        if (!asset || !cc.isValid(asset) || asset.name !== record.name) throw new Error(`Builtin not loaded: ${record.uuid}`);
        if (record.kind === 'effect' && !(asset instanceof cc.EffectAsset)) throw new Error(`Invalid Effect: ${record.name}`);
        if (record.kind === 'material' && (!(asset instanceof cc.Material) || !asset.passes.length)) throw new Error(`Invalid material: ${record.name}`);
        globalThis.__bootstrap.builtins.push(record);
    }
    globalThis.__bootstrap.phase = 'scene';
    const main = await System.import('./game/game.js');
    globalThis.__probe = main.state;
    cc.game.run(() => main.start().then(() => { globalThis.__bootstrap.phase = 'running'; }).catch(fail));
})().catch(fail);
