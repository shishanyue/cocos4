---
name: cocos4-engine-dev
description: Use when developing or debugging this mini-game-only Cocos4 engine's internals, rendering, public APIs, PAL/adapters, cc.config.json, ccbuild/tfig patches, Web/WASM dependencies, declarations, or engine tests. Not for ordinary game-project gameplay code or upstream native Cocos development.
---

# Cocos4 Engine Development

Develop the engine without restoring removed native infrastructure or weakening
verification. Use `cocos4-minigame-dev` for application-level game work; use both
only when a reproduced game defect requires an engine change.

**Establish Context**
1. Locate the engine root: for this repository-local skill it is three directories
   above the skill directory. If installed elsewhere, resolve the intended checkout
   before issuing commands. All source paths below are engine-root-relative.
2. Read `AGENTS.md`, `README.md` or `README.zh-CN.md`, `package.json`, and the
   relevant portion of `cc.config.json`. Inspect worktree changes without reverting
   concurrent work. Treat current files as authoritative over this skill.
3. Record the affected subsystem, platform route, feature set, expected behavior,
   and smallest reproduction. Separate source bugs from missing preparation,
   external artifacts, editor integration, and vendor runtime failures.
4. Trace the public entry, implementation, caller, and nearest regression test
   before modifying code. Prefer the smallest change at the owning layer.

Baseline when authored: engine `4.0.0-alpha.34`, Node `>=18`, TypeScript `4.9.5`,
ccbuild `2.3.21`, tfig `3.3.4`, PAL `1.0.4`, platforms `1.0.6`.
These are review anchors, not permission to downgrade a newer checkout.

**Hard Boundaries**
- Keep 2D/3D, Creator integration, browser preview, Node tools, mini-game and
  runtime-based quick-game adapters. `cc.config.json.platforms` is the allowlist.
- Never restore native application backends, JSB wrappers, native simulators,
  native publishing templates, SDK downloads, or an engine-root `native/` tree.
- `NATIVE` and `JSB` are always-false import contracts. Reject enabling build flags;
  ensure ambient host globals cannot enable either constant without rejecting an
  otherwise valid editor/preview host.
- Do not delete by keyword: resource `native/`, `Asset.nativeAsset`, `nativeUrl`,
  serialized resource fields, Android/iOS host checks, `NATIVE_CODE_BUNDLE_MODE`,
  `isNativeModule`, and mini-game-host `nativePhysX` have legitimate shared uses.
- Retain TypeScript WebGPU, glslang/twgsl and standalone `vendor/wasm/` sources.
  Preserve third-party licenses and stable serialized enum values.
- Generated files are not the fix location. Do not patch PAL, adapter bundles,
  installed dependencies, or generated declarations by hand.
- Do not hide failures with empty declarations, widened `any`, disabled tests,
  `skipLibCheck`, removed editor APIs, or disabled TLS/integrity checks.

**Choose References**
Read only the reference relevant to the change, then inspect its cited source:

| Task | Read |
| --- | --- |
| Locate ownership, trace a feature, modify runtime/public API | [Source Map](references/source-map.md) |
| Install, reproduce, test, build, diagnose declarations/platforms | [Verification](references/verification.md) |
| Modify Spine WASM | `vendor/wasm/spine-wasm/README.md` and `.github/workflows/build-spine.sh` |
| Change Creator or external CI integration | `README.md` and `.github/WEB_CI.md` |

**Implementation Workflow**
1. Reproduce with a focused existing test or a minimal scene. Record failures before
   editing. Missing external assets are an environment blocker, not a code defect.
2. Add the smallest regression at the correct layer: engine Jest suite, Node tooling
   test, generated-declaration consumer, or real editor/device reproduction.
3. Change the owning source. Preserve lifecycle ordering, event delivery, render-dirty
   propagation, resource ownership, serialization metadata, and feature import order.
4. For public API changes, trace `exports/`, the feature in `cc.config.json`, and
   editor exports if applicable. Update docs and declaration-consumer assertions.
   Keep `@ccclass` names and serialized identities stable unless a migration is explicit.
5. For dependency changes, inspect upstream versions and patch anchors. Update the
   lockfile and checked preparation scripts together; retain version guards,
   idempotence, and all-or-nothing patch application. Test clean and repeated prep.
6. Run focused tests first, then the applicable matrix below. Review the diff for
   unrelated edits and changes to generated files before reporting completion.

Follow the surrounding TypeScript style: named exports, explicit return types,
four spaces, single quotes, engine logging, and allocation-conscious math APIs.
Engine code may use `internal:constants`, `cc.decorator`, and PAL contracts;
ordinary game scripts must not copy those internal import patterns.

**Verification Baseline**
Run commands from the engine root, after preparation and external setup:

```sh
npm run prepare:engine
npm run test:platforms
npm run build:declaration
npm test -- --runInBand
npm run build:minigame -- WECHAT
npm run build:minigame -- OPPO
git diff --check
```

For rendering/3D, preview, or tooling changes, add the relevant commands:

```sh
npm run build:minigame -- WECHAT base,3d,animation,skeletal-animation,gfx-webgl,gfx-webgl2
npm run build:dev
npm run build:cli-min
```

The custom feature list replaces defaults; the 3D example does not include UI,
audio, or a physics backend. Do not parallelize builds that write the same output
directory. `build:minigame` is an uncompressed SystemJS engine smoke build, not a
complete game package, preview server, or vendor upload command.

**Completion Contract**
Report the root cause, owning files changed, and commands actually run with results.
Separate preparation/platform checks, source/declaration checks, engine bundles,
Creator/browser validation, and vendor-device validation. Include feature sets and
unverified cases. Do not repeat historical test counts as current results.
No engine bundle or headless unit test establishes real-device rendering, resource
conversion, final packaging, or store acceptance. Do not commit unless requested.
