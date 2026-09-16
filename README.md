# Cocos 4 Mini-Game Engine

This fork targets mini games and vendor quick games. It keeps the TypeScript
2D/3D engine, Creator integration, browser preview, WebGL/WebGL2 and the
TypeScript WebGPU backend. Native application publishing, JSB, native platform
backends and the native simulator have been removed from the source tree.

See [中文说明](README.zh-CN.md) and [development boundaries](AGENTS.md).
The [development skills](.opencode/skills/README.md) cover engine maintenance and
game-project development, with source references and type-checked examples.

## Platforms

Implemented adapters include WeChat, ByteDance, Alipay, Taobao, Xiaomi, OPPO,
vivo, Huawei, Honor and Migu. WeChat Mini Program and Taobao Creative App have
separate container integrations. SUD, SUD V2 and Cocos Runtime have runtime
integration points but require their external publishing tools to be verified.
The Facebook Instant Games HTML5 template is retained. Baidu's old template is
not a supported build target.

`cc.config.json` is the engine build target allowlist. `HTML5` and `NODEJS` are
retained for development tools and preview. An adapter's presence is not a
claim that its current vendor SDK or real devices have passed release testing.

## Setup

Use Node.js 18 or newer, npm and Git. NDK, Xcode, SWIG and native platform SDKs
are not required for normal mini-game development.

```sh
npm ci
npm run setup:external
npm run build:declaration
```

Installation prepares the filtered PAL and adapters, applies checked patches
to the pinned `@cocos/ccbuild` and its `@cocos/tfig` declaration bundler, and
generates constants and error metadata.
The external setup separately installs the pinned Web/WASM artifacts into
`external/emscripten`, preserving the tracked compression and deserialize code.
An existing external checkout can be used offline:

```sh
npm run setup:external -- --source /path/to/cocos-engine-external
```

If dependency lifecycle scripts are disabled, run `npm run prepare:engine`
explicitly. Do not disable TLS verification or package integrity checks to
work around network failures. A configured npm registry mirror can be selected
with npm's normal `--registry` option.

## Build And Test

`build:declaration` checks both the engine sources and the generated runtime/editor
API declarations. Its output includes the WebGPU ambient types. Run `test:dts`
to recheck the existing declaration output without regenerating it.

```sh
npm run test:platforms
npm test -- --runInBand
npm run build:minigame -- WECHAT
npm run build:minigame -- OPPO
npm run build:minigame -- WECHAT base,3d,animation,skeletal-animation,gfx-webgl,gfx-webgl2
npm run build:dev
npm run build:cli-min
```

`build:minigame` builds an **engine bundle**, not a complete game project or a
vendor upload package. Asset conversion, platform registration and final game
packaging still require the corresponding Creator/builder integration.

Creator must use this engine's patched build dependency. Its Web preview
`/engine_external/` endpoint must serve this fork's `external/` directory;
the editor PAL uses `query-engine-info.typescript.path`, not a native engine
path. The complete editor and preview server are not part of this repository.

## Shared WASM Sources

Spine WASM/ASM.js sources and the versioned Spine runtime are in
`vendor/wasm/`. Their standalone build uses Emscripten, CMake and Ninja, not the
removed native application build. See the [Spine build guide](vendor/wasm/spine-wasm/README.md).
The shared GFX definition generator is in `scripts/gfx-define-generator/`.

Preserve third-party copyright notices and licenses, especially the separate
Spine runtime licensing terms. The engine's MIT license does not replace them.

## Validation Scope

Platform tests check target restrictions, dependency preparation and external
resource installation. They do not replace Creator, browser/GPU or vendor
device tests. Release checks must cover both mini-game and runtime-based
adapters, 2D/3D rendering, input, audio, subpackages and WASM loading.

Shared CI prerequisites are documented in [.github/WEB_CI.md](.github/WEB_CI.md).
