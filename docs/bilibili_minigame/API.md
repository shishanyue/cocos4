# Bilibili Mini-Game API Reference

Reviewed: 2026-09-16. This is an integration-oriented index and summary, not a
replacement for the official API specification. Links below point to that
specification. A documented host API is not evidence of Cocos4 device validation.

## Calling Convention

[Official overview](https://miniapp.bilibili.com/small-game-doc/api/intro)

- Host APIs live on `bl`. Do not alias it to `wx` or enable WeChat build constants.
- `onX(callback)` subscribes to events; retain the same callback for `offX`.
- `*Sync` APIs return directly and can throw. Factories such as `createCanvas`
  are also synchronous despite not having that suffix.
- Most asynchronous calls accept `success`, `fail` and `complete`. A successful
  callback normally has `errMsg: '<api>:ok'`; only some APIs define `errCode`.
- Some calls also return a task object. For example, download and subpackage tasks
  expose progress; do not replace them with promises at the host boundary.

## Engine Integration Map

The groups below describe host contracts, not blanket implementation claims.
See [Cocos4 integration](README.md) for implemented paths and limitations, and the
[implementation plan](../plans/bilibili-minigame-export.md) for local test evidence.
None of these groups has been device-validated in this checkout.

| Area | Host APIs | Engine responsibility |
| --- | --- | --- |
| System | [getSystemInfoSync](https://miniapp.bilibili.com/small-game-doc/api/device/getSystemInfoSync), [getSystemInfo](https://miniapp.bilibili.com/small-game-doc/api/device/getSystemInfo), [getAppBaseInfo](https://miniapp.bilibili.com/small-game-doc/api/device/getAppBaseInfo) | OS, screen dimensions, pixel ratio, safe area and feature detection |
| Lifecycle | [onShow](https://miniapp.bilibili.com/small-game-doc/api/base/applet/onShow), offShow, [onHide](https://miniapp.bilibili.com/small-game-doc/api/base/applet/onHide), offHide, [getLaunchOptionsSync](https://miniapp.bilibili.com/small-game-doc/api/life/getLaunchOptionsSync), [getEnterOptionsSync](https://miniapp.bilibili.com/small-game-doc/api/life/getEnterOptionsSync) | Pause/resume and preserve latest entry parameters |
| Errors | [onError](https://miniapp.bilibili.com/small-game-doc/api/base/applet/onError), offError | Keep failures observable; never report launch success after startup failure |
| Canvas | [createCanvas](https://miniapp.bilibili.com/small-game-doc/api/render/createCanvas), [Canvas.getContext](https://miniapp.bilibili.com/small-game-doc/api/render/Canvas.getContext) | Main/offscreen canvas and WebGL context selection |
| Scheduling | [requestAnimationFrame](https://miniapp.bilibili.com/small-game-doc/api/render/requestAnimationFrame), cancelAnimationFrame, [setPreferredFramesPerSecond](https://miniapp.bilibili.com/small-game-doc/api/render/setPreferredFramesPerSecond) | Frame pacing; RAF is a host global, not assumed to be a `bl` member |
| Images/fonts | [createImage](https://miniapp.bilibili.com/small-game-doc/api/render/createImage), [loadFont](https://miniapp.bilibili.com/small-game-doc/api/render/loadFont) | Texture/text loading and errors |
| Touch | [onTouchStart](https://miniapp.bilibili.com/small-game-doc/api/base/applet/onTouchStart), onTouchMove, onTouchEnd, onTouchCancel and matching off methods | Preserve touch identifiers and coordinate spaces |
| Screen | [onWindowResize](https://miniapp.bilibili.com/small-game-doc/api/ui/onWindowResize), offWindowResize, [getDeviceOrientationSync](https://miniapp.bilibili.com/small-game-doc/api/device/bl.getDeviceOrientationSync) | Refresh size/safe area; avoid applying pixel ratio twice |
| Keyboard | [showKeyboard](https://miniapp.bilibili.com/small-game-doc/api/ui/showKeyboard), updateKeyboard, hideKeyboard, on/offKeyboardInput, on/offKeyboardConfirm, on/offKeyboardComplete | EditBox input and callback cleanup |
| Motion | [startAccelerometer](https://miniapp.bilibili.com/small-game-doc/api/ui/startAccelerometer), stopAccelerometer, on/offAccelerometerChange | Optional sensor capability and landscape coordinates |
| Audio | [createInnerAudioContext](https://miniapp.bilibili.com/small-game-doc/api/media/createInnerAudioContext), [InnerAudioContext](https://miniapp.bilibili.com/small-game-doc/api/media/InnerAudioContext/InnerAudioContext), on/offAudioInterruptionBegin, on/offAudioInterruptionEnd | Playback, seek, volume, disposal and interruption recovery |
| HTTP | [request](https://miniapp.bilibili.com/small-game-doc/api/network/request) | XHR facade, headers, response types, cancellation and errors |
| Download | [downloadFile](https://miniapp.bilibili.com/small-game-doc/api/network/downloadFile), [DownloadTask](https://miniapp.bilibili.com/small-game-doc/api/network/DownloadTask) | Remote assets, progress and HTTP status checks |
| WebSocket | [connectSocket](https://miniapp.bilibili.com/small-game-doc/websocket/connectSocket), SocketTask onOpen/onMessage/onError/onClose/send/close | Per-connection socket facade; do not use singleton socket events |
| Storage | [getStorageSync](https://miniapp.bilibili.com/small-game-doc/api/storage/getStorageSync), setStorageSync, removeStorageSync, clearStorageSync, getStorageInfoSync | localStorage facade, string values and missing-key handling |
| Files | [getFileSystemManager](https://miniapp.bilibili.com/small-game-doc/api/file/getFileSystemManager), readFile/readFileSync, writeFile, access, mkdir, copyFile, unlink, unzip | Packaged resources and persistent cache, with failures propagated |
| Subpackages | [loadSubpackage](https://miniapp.bilibili.com/small-game-doc/api/network/bl.loadSubpackage), [LoadSubpackageTask](https://miniapp.bilibili.com/small-game-doc/api/network/LoadSubpackageTask) | Await success before module/resource use; propagate failure and progress |
| Startup | [launchSuccess](https://miniapp.bilibili.com/small-game-doc/api/base/launchSuccess) | Once after the game's home screen successfully renders, not at splash or module evaluation |

## Resources and Modules

[Modules](https://miniapp.bilibili.com/small-game-doc/guide/module),
[directory structure](https://miniapp.bilibili.com/small-game-doc/framework/structure),
[file system](https://miniapp.bilibili.com/small-game-doc/ability/file-system)

- The required project entry/configuration are `game.js` and `game.json`.
- Code uses CommonJS `require`, `module.exports` and `exports`. Engine/game SystemJS
  modules need a packaged loader and import map, not browser script injection.
- Resource paths start at the game package root. A relative CommonJS module path
  is not a valid relative image/audio/file path.
- Vendor tools compile packaged JSON, so it may not remain accessible as an
  ordinary file. Validate the JSON module-loading path after vendor packaging.
- Packaged files are read-only. Use `bl.env.USER_DATA_PATH` for persistent user
  files. `bl.env.SHARE_DATA_PATH` is device-wide for this app, not user-isolated.
- Downloaded temporary paths are valid only in the current lifecycle. Persist
  actual files with `copyFile`/`saveFile`, never just their temporary paths.
- Documented local cache/user storage budget is 200MB combined; shared files 50MB.
  Cache errors must not turn a successfully downloaded resource into a fatal load.

## Configuration and Limits

[Configuration](https://miniapp.bilibili.com/small-game-doc/framework/config),
[subpackages](https://miniapp.bilibili.com/small-game-doc/ability/subpackage)

- `game.json` requires `appId` (capital I) and `version`.
- `deviceOrientation` is `portrait` or `landscape`.
- `networkTimeout` uses milliseconds for request, connectSocket, uploadFile and
  downloadFile. Configure server domains in the vendor console as well.
- `subpackages` entries have `name` and `root`. A directory root uses its `game.js`
  as entry; the platform also documents JS-file roots.
- The documented limits are 4M per main/subpackage and 30M total. Final compiled
  package measurements from vendor tools take precedence over local estimates.
- Nested subpackages must list children before parents. Open-data-domain content
  cannot be a subpackage or reside inside one.

## Graphics and WASM

[WebGL2](https://miniapp.bilibili.com/small-game-doc/engine/webGL2),
[Cocos compatibility](https://miniapp.bilibili.com/small-game-doc/engine/common)

- WebGL2 on Android/iOS requires high-performance mode. The dedicated WebGL2 page
  lists `androidHighPerformance`, `androidHighPerformance+`, `iOSHighPerformance`
  and `iOSHighPerformance+`; the general config table omits the last field.
- Do not infer WebGL2 support from the platform name. Check context creation and
  preserve the WebGL1 path.
- The directory page says WASM is Android-only, but the config page recommends
  iOS high-performance mode for WASM. Treat this as unresolved documentation,
  not proof that WASM always exists or that iOS always lacks it.
- The Cocos guide recommends WASM + ASM.js and says WASM Brotli is unsupported.
  Its WeChat compatibility advice does not define a `BLWebAssembly` API.
  Do not invent one or assume a URL-based instantiate contract for standard
  `WebAssembly`, which takes bytes/modules instead.
- The guide calls out async/await compatibility support. Preserve the publishing
  pipeline's polyfills and validate generated syntax on the intended host.

## Game-Owned APIs

These are available through `bl`; they are not automatically implemented as game
logic by adding engine support:

- [Login](https://miniapp.bilibili.com/small-game-doc/open/login): login/checkSession,
  user information, authorization and the server-side session exchange.
- [Sharing](https://miniapp.bilibili.com/small-game-doc/open/share/share): share menu,
  shareAppMessage and onShareAppMessage.
- [Payment](https://miniapp.bilibili.com/small-game-doc/open/recharge/Recharge):
  requestRecharge and server-side order verification.
- [Rewarded ads](https://miniapp.bilibili.com/small-game-doc/open/ad/IncentiveVideo):
  createRewardedVideoAd, load/show/destroy and lifecycle events.
- [Open data](https://miniapp.bilibili.com/small-game-doc/open/open-data): cloud
  storage, open data context and cross-domain messages. Requires a separate
  implementation/acceptance path; host availability alone does not enable it.
- [Updates](https://miniapp.bilibili.com/small-game-doc/api/base/getUpdateManager),
  video/camera, recorder, clipboard, vibration, location, Bluetooth, navigation,
  subscription messages and analytics: consult the API overview for the full list.

### Mandatory Re-entry Features

[Sidebar](https://miniapp.bilibili.com/small-game-doc/open/sidebar) and
[desktop shortcut](https://miniapp.bilibili.com/small-game-doc/open/shortcut)
are marked mandatory by the official guides.

- Register `bl.onShow` synchronously in the bootstrap, before asynchronous engine
  initialization, and retain the latest entry parameters on every re-entry.
- Sidebar: check availability using `checkScene`; user interaction calls
  `navigateToScene`. Use the latest entry event, not only cold-launch options.
- Shortcut: use `addShortcut`; the guide identifies entry scene `10002` and says
  this reward workflow does not require `checkShortcut`.
- The game supplies the UI and daily/idempotent rewards, ideally verified by its
  server. Engine tests do not establish review compliance.

## Developer Tools and Reference Plugins

[Tools](https://miniapp.bilibili.com/small-game-doc/guide/cli/),
[IDE releases](https://miniapp.bilibili.com/small-game-doc/open/ide-update)

- The official CLI is `bili-sgame-cli`, with serve/upload commands; the IDE download
  page lists Windows/macOS builds. Neither tool is required to compile this engine.
- The local `biligame-builder-2x/` is a reference converter from WeChat output,
  not Cocos4 platform source. It fetches unpinned adaptation files during builds.
- Do not execute or redistribute downloaded adaptation code without reviewing its
  source, provenance and license. Do not store upload credentials in templates.
