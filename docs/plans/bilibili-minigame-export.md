# Bilibili Mini-Game Export

Status: local implementation and automated regression complete; external
acceptance outstanding. Updated 2026-09-16.

## Goal

Add Bilibili as a first-class platform in this Cocos4 engine, at the same
integration level as WECHAT: build ID, PAL, dedicated adapters and local publishing
templates. The user clarified this scope during implementation; creating a new
editor, requiring Creator 3.8.8, or inventing a new game project format is not part
of the request. Old Creator plugins are reference material only.

Engine target: `BILIBILI`. Adapter/template target: `bilibili`.
Keep 2D/3D, browser preview, Node tooling and all existing supported targets.
Do not restore native application infrastructure; `NATIVE` and `JSB` remain false.

## Implementation Order

1. Establish the current Cocos4 platform contract and available source.
   Record official Bilibili APIs and constraints in
   `docs/bilibili_minigame/`. Identify unsupported or contradictory capabilities.
2. Add platform constants, PAL routing, platform identity and declaration coverage.
   Integrate maintained source through version-checked, repeatable preparation.
   Never manually modify `pal/`, `bin/adapter/`, or installed dependencies.
3. Implement the `bl` host and engine resource adapters. Cover canvas, scheduling,
   input, screen/safe area, audio, keyboard, networking, storage, file loading,
   caches and subpackages. Test a host without `wx` and optional API failures.
4. Add local publishing templates, SystemJS/CommonJS bootstrap, first screen,
   configuration validation and package checks using existing engine conventions.
   Fail explicitly on unsupported build options or incomplete inputs.
5. Run automated regression and engine builds. Separately validate integration in
   the actual project's publishing pipeline, Bilibili tooling and Android/iOS
   devices when available. Record evidence by validation layer.

Each phase must add focused tests before it is marked complete. Update this plan
with concrete implementation decisions, commands, results and remaining blockers.

## Source Ownership

- `cc.config.json`: target allowlist, constants and PAL routing.
- `scripts/spread-pal.cjs`: prepares `@cocos/engine-pal@1.0.4`.
- `scripts/spread-adapter.cjs`: prepares `@cocos/engine-platforms@1.0.6`.
- `scripts/platforms/bilibili/`: maintained local PAL and adapter source; generated
  copies live in `pal/bilibili/` and `bin/adapter/minigame/bilibili/`.
- `scripts/patch-ccbuild.cjs`: checked patches for ccbuild 2.3.21/tfig 3.3.4.
- `templates/`: existing platform bootstraps, not complete Creator builders.
- `templates/bilibili/`, `scripts/validate-bilibili.cjs`: local publishing bootstrap
  and read-only package preflight, documented in `docs/bilibili_minigame/README.md`.
- `scripts/tests/minigame.test.cjs`, `tests/`, `scripts/test-declarations/`:
  existing tooling, runtime and public API regression gates.

The installed PAL and adapter packages contain prebuilt output, not their source.
Confirm source availability and redistribution permissions before incorporating
third-party implementations. The reference 2.x plugin has no declared license.

## Platform Decisions

- Use `bl`, not `wx = bl`, and do not compile a WeChat engine under a Bilibili name.
- Preserve package-root resource paths and distinguish them from CommonJS module
  paths and `bl.env.USER_DATA_PATH`. Packaged JSON may be compiled by vendor tools;
  local JSON loading needs explicit validation after vendor packaging.
- Default to the broadly compatible graphics path. WebGL2 requires the documented
  high-performance options and successful runtime capability checks.
- Do not assume WebAssembly exists. Validate the host's actual instantiate
  contract; preserve ASM.js fallback. Do not enable WASM Brotli compression.
- Call `bl.launchSuccess()` once after the game home screen renders successfully,
  not when `game.js` finishes evaluating or when a splash is displayed.
- Capture `bl.onShow` synchronously during bootstrap so cold/hot entry data is not
  lost while engine and game modules load.
- Validate main/subpackage sizes (documented limits: 4M each, 30M total), names,
  roots and child-before-parent ordering. Vendor packaged sizes are authoritative.
- Login, payment, ads, server credentials and rewards belong to the game. Document
  mandatory sidebar/shortcut integration without claiming an engine supplies the
  required game UX or business logic. Upload/review automation is out of scope.

## Publishing Boundary

`build:minigame` produces an engine bundle on every platform, including WECHAT.
It does not compile game projects or convert their resources. Keep this existing
boundary explicit for BILIBILI too. Add actual adapters and templates, not a
WeChat postprocessor or a fictitious editor registration API. The package's
`creator.version` metadata does not change the Cocos4 engine version or make that
editor version a prerequisite for this implementation.

No Creator executable or `bili-sgame-cli` was found on PATH during initial
inspection. This does not block the engine target. No complete game project or
its publisher was supplied for end-to-end acceptance; availability elsewhere has
not been established. Official Bilibili IDE downloads currently list Windows and
macOS, not Linux. No particular Creator version is required by this plan.

## Verification

Run focused tooling/adapter tests, then:

```sh
npm run prepare:engine
npm run test:platforms
npm run build:declaration
npm run test:dts
npm test -- --runInBand
npm run build:minigame -- BILIBILI
npm run build:minigame -- BILIBILI base,3d,animation,skeletal-animation,gfx-webgl,gfx-webgl2
npm run build:minigame -- WECHAT
npm run build:minigame -- OPPO
git diff --check
```

Do not run builds sharing an output directory concurrently. Missing external
artifacts are blockers, not a reason to suppress type checking.

External acceptance requires real 2D and 3D projects exported through their
publishing integration, then vendor packaging and device tests for first screen,
input, audio interruption, pause/resume, local/remote resources, JSON, cache
recovery, subpackage failures, WebGL variants and WASM/ASM.js selection.

## Progress

- [x] Read the local 2.x plugin and current engine preparation/build contracts.
- [x] Clarify the requested scope: parity with existing Cocos4 mini-game targets.
- [x] Create this implementation plan.
- [x] Record API contracts and capability matrix.
- [x] Implement platform and runtime support with regression tests.
- [x] Implement and test local publishing templates and configuration checks.
- [x] Complete automated regression matrix.
- [ ] Complete vendor tool/device acceptance.

Initial reference download: the official 3.x plugin URL returned HTTP 403 in this
environment. No downloaded plugin code has been executed or incorporated.

### Local Evidence

- `npm run prepare:engine`: passed, including local adapter generation.
- `npm run test:platforms`: 28 passed, including 15 Bilibili tests. Covers independent
  constants/routes, PAL identity and binding, screen/sensor changes, byte-based
  WASM failures/retry, debug/compact host facade, XHR, JSON/cache, bundle/subpackage
  loading, actual engine audio-loader integration, socket isolation, keyboard
  cleanup, rendered startup timing, failure suppression/manual reporting,
  configuration and package preflight.
- Final contract review reproduced an audio failure: `AudioPlayer` is a private
  PAL import, not a `cc` export. The adapter now wraps the engine's registered
  audio handlers, preserving options and metadata. The regression imports the
  real `cocos/audio/audio-downloader.ts` and fails with the original adapter.
- `npm run build:declaration` and `npm run test:dts`: passed. Declaration tooling
  emits TypeScript API deprecation warnings, without suppressing type checking.
- `npm test -- --runInBand`: 161 suites passed, one skipped; 1124 tests passed,
  two skipped, 16 todo; 34 snapshots passed. Headless jsdom canvas warnings and
  test-purpose diagnostic logs remain; this is not a rendering test.
- `npm run build:minigame -- BILIBILI`: passed with default 2D/UI/audio/tween and
  WebGL1/2 features.
- `npm run build:minigame -- BILIBILI base,3d,animation,skeletal-animation,gfx-webgl,gfx-webgl2`:
  passed. This explicit feature list does not include UI, audio or a physics backend.
- `npm run build:minigame -- WECHAT` and `npm run build:minigame -- OPPO`: passed
  with default features, preserving mini-game and runtime PAL routes.
- `git diff --check`: passed. Generated PAL, adapters and bundles remain untracked
  build output; no dependency versions or third-party license notices were changed.
- No actual vendor packaging, complete game export, GPU rendering or device
  validation has been performed. In particular, host mocks cannot validate SDK
  availability, compiled JSON layout, graphics/WASM compatibility or store review.

## References

- [Local 2.x reference](../bilibili_minigame/biligame-builder-2x/)
- [Bilibili API overview](https://miniapp.bilibili.com/small-game-doc/api/intro)
- [Official Cocos integration](https://miniapp.bilibili.com/small-game-doc/engine/common)
- [Configuration](https://miniapp.bilibili.com/small-game-doc/framework/config)
- [Modules](https://miniapp.bilibili.com/small-game-doc/guide/module)
- [Subpackages](https://miniapp.bilibili.com/small-game-doc/ability/subpackage)
- [WebGL2](https://miniapp.bilibili.com/small-game-doc/engine/webGL2)
- [Launch success](https://miniapp.bilibili.com/small-game-doc/api/base/launchSuccess)
- [Creator custom build hooks](https://docs.cocos.com/creator/3.8/manual/zh/editor/publish/custom-build-plugin.html)
