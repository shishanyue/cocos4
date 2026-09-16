# Bilibili Integration

`BILIBILI` is an independent Cocos4 engine target. It uses the real `bl` host,
not a WeChat package converter or a `wx` alias. Runtime identity is
`sys.Platform.BILIBILI_MINI_GAME`; `NATIVE`, `JSB` and `WECHAT` are false.

The repository supplies the same integration layers as its other mini-game
targets: engine build selection, PAL, adapters and publishing templates. It does
not contain the complete editor or game-project builder. Creator 3.8.8 is not a
prerequisite for compiling this target, regardless of package metadata.

## Build And Test

After the normal repository dependency and external-artifact setup:

```sh
npm run prepare:engine
npm run test:platforms
npm run build:minigame -- BILIBILI
npm run build:minigame -- BILIBILI base,3d,animation,skeletal-animation,gfx-webgl,gfx-webgl2
```

The default feature set is `base,2d,ui,audio,tween,gfx-webgl,gfx-webgl2`. An explicit
feature list replaces it. Both commands write uncompressed SystemJS **engine**
output under `bin/minigame/bilibili/`; they do not produce a complete game or an
upload package. Do not run them concurrently or measure that directory against
release package limits. The second build can leave files from the first.

## Publisher Integration

Use the existing project's game/resource build pipeline; do not first export a
WeChat game. Select engine platform `BILIBILI` and adapter/template key `bilibili`.
An external builder must expose that selection itself; adding the engine target
does not automatically register an editor menu or a vendor CLI target.

1. Render `templates/bilibili/game.ejs` into the game's root `game.js`.
2. Populate `templates/bilibili/game.json` with the actual `appId`, `version`,
   orientation, network timeouts and subpackages. The empty sample `appId` is
   deliberately invalid. Configure request/download/socket domains in the vendor
   console separately.
3. Copy all three prepared files from `bin/adapter/minigame/bilibili/` to the game
   root: `web-adapter.js`, `engine-adapter.js`, `fs-utils.js`. For a compact release,
   copy their `.min.js` variants **renamed to those same canonical filenames**.
   The adapters are CommonJS modules, not a single bundled file.
4. Supply the game's Application module, settings, SystemJS loader, import map,
   engine chunks and converted resources using the existing build pipeline.
   Package all JavaScript locally. The template loads the host adapter before
   `cc` and calls `require('./engine-adapter')(cc)` before Application startup.
5. Run the package preflight below, then compile with Bilibili's tools and test the
   actual packaged game. An engine smoke bundle alone is not valid input.

Template variables follow the existing launcher conventions:

| Variable | Meaning |
| --- | --- |
| `polyfillsBundleFile` | Packaged polyfill module path; empty string when omitted |
| `systemJsBundleFile` | Packaged SystemJS loader module path |
| `importMapFile` | Packaged import-map module path; plain exports or `.default` |
| `applicationJs` | Application module specifier resolved by SystemJS |
| `useWebgl2` | Optional explicit WebGL2 request; requires all four documented high-performance flags in `game.json` |
| `autoLaunchSuccess` | Defaults to true; set false when the first scene is a loading scene rather than the game home |

The standard `templates/launcher/application.ejs` provides the Application
contract (`init(cc)`, `start()`). Module paths supplied to `require` must resolve
from the game root; engine resource URLs instead use package-root paths without
a CommonJS `./` prefix. No remote code download or engine plugin is supported.

## Startup And Lifecycle

The template registers `bl.onShow` synchronously, before asynchronous engine
loading. `globalThis.__bilibili.launchOptions` holds cold-start parameters;
`lastShowOptions` holds the most recent onShow payload, initially null. Games can
use these for early-entry recovery and subscribe directly to `bl.onShow` for
later business events. The host API surface is documented in [API.md](API.md).

The engine's built-in splash is retained. In automatic mode, launch success is
reported once after the first scene launch and its next engine draw, not after
splash or script evaluation. A rejected startup disables reporting. Headless
event tests cannot establish that pixels reached the actual device display.

If the first scene is not the game home, render with `autoLaunchSuccess: false`.
After the real home is ready, the game should wait for its draw before reporting:

```js
director.once(Director.EVENT_AFTER_DRAW, () => {
    globalThis.__bilibili.reportLaunchSuccess();
});
```

Use `Director` and `director` from `cc`. The helper suppresses duplicate reports
and disables reporting after a rejected startup; the game owns the home-ready condition.
Sidebar/shortcut UI, entry rewards, login, payment, ads and server verification
are game responsibilities, not automatically supplied by the engine.

## Resources And Capabilities

- Packaged JSON uses `require` because vendor tools can compile it into modules.
  Each resource read returns an independent JSON value. Downloaded/user JSON uses
  the file system; text and binary resources use `getFileSystemManager`.
- Ordinary bundles use `assets/<name>/index[.<version>].js` and
  `config[.<version>].json`. Remote bundle data uses the configured server URL,
  but its script must be packaged as `src/bundle-scripts/<name>/index[.<version>].js`.
  Asset-bundle subpackages must use directory roots with a `game.js` that registers
  the bundle's code; loading waits for `bl.loadSubpackage` before reading config.
- Remote persistent caching is opt-in through asset request option
  `{ cacheEnabled: true }`. Cached files live under
  `bl.env.USER_DATA_PATH + '/cocos4-cache'`, with at most 100 index entries. Existing
  cache hits are reused; `reload: true` invalidates them. Missing cached files are
  downloaded again. Copy/quota failures fall back to the downloaded temporary file.
  The limit is a file count, not a byte budget; errors invalidate corrupt resources
  so the engine's normal retry can fetch them again.
- WebGL1 is the conservative path. Including `gfx-webgl2` in an engine bundle does
  not prove host support: the engine checks `WebGL2RenderingContext` and context
  initialization. Explicit WebGL2 publishing requires `androidHighPerformance`,
  `androidHighPerformance+`, `iOSHighPerformance`, `iOSHighPerformance+` all true.
- WASM capability is detected at runtime. The PAL reads
  `cocos-js/<emitted-binary-url>` as bytes before standard `WebAssembly.instantiate`.
  Keep WASM + ASM.js fallback. If the publisher enables `WASM_SUBPACKAGE`, it must
  supply `__ccWasmAssetSubpkg__` and `__ccWasmChunkSubpkg__` without breaking those
  resource paths. This layout still needs vendor-tool/device acceptance.
- Keyboard, optional accelerometer, screen/safe area, lifecycle, audio, XHR,
  per-connection WebSocket and string storage are adapted. Sensor/subpackage
  capabilities are checked; unsupported keyboard/subpackage use reports errors.
  This is not a browser DOM implementation or full coverage of every `bl` API.
- Zip bundles, WASM Brotli, WeChat engine plugins and open-data-domain publishing
  are not implemented. No support for native applications is added.

## Package Preflight

```sh
npm run validate:bilibili -- /absolute/path/to/complete-game-output
```

This read-only command checks required root files, configuration types, nonempty
`appId`/`version`, subpackage names/roots/entries and child-before-parent ownership.
It rejects symlinks, unsupported plugins/open-data settings, zipped bundle config
and `.wasm.br` files. It estimates package sizes without double-counting children.

The documented limits are 4M per main/subpackage and 30M total. Source sizes above
4 MiB/30 MiB produce **warnings**, not a false claim about vendor-compiled sizes.
The tool does not resolve the entire module/import-map graph, convert resources,
authenticate app IDs, validate server domains or certify review compliance.

## Maintenance And Acceptance

Edit `scripts/platforms/bilibili/pal/` and `scripts/platforms/bilibili/adapter/`,
then run `prepare:engine`. Never edit generated `pal/bilibili/` or `bin/adapter/`.
Preparation checks pinned PAL/platform versions, patches the platform enum and
identity, and compiles local adapter variants. Keep the accompanying tests in
`scripts/tests/bilibili.test.cjs` and declaration consumers up to date.

The legacy `biligame-builder-2x/` is reference material, not used by these builds.
Its downloaded code has not been incorporated. No new build-time network fetch
or upload credential is required by this target.

See the [implementation evidence](../plans/bilibili-minigame-export.md) for actual
commands and results. Local tests/builds do not establish full-game publishing or
rendering. External acceptance remains: actual 2D/3D game output, compiled JSON,
texture/font/audio loading, touch/keyboard, interruption/resume, remote resources,
cache recovery, subpackage failures, WebGL1/2, WASM/ASM.js, first-home reporting,
and mandatory re-entry features in Bilibili tools and Android/iOS clients.
