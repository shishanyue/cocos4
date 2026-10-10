# Mini-Game-Only Engine

This repository is a deliberately reduced Cocos 4 fork. Do not assume the
native architecture or publishing capabilities of upstream Cocos Creator.

## Scope

- Keep 2D and 3D, mini-game and runtime-based quick-game adapters, Creator
  integration, Node.js tooling and browser preview.
- Do not restore native application backends, JSB wrappers, native simulators,
  native templates, native SDK downloads or a `native/` engine directory.
- `cc.config.json.platforms` is the build allowlist. Android/iOS/desktop native
  targets are unsupported; those operating systems can still host mini games
  and development tools.
- `NATIVE` and `JSB` are always-false adapter import contracts, not feature
  switches. Builds must reject attempts to enable them.

## Shared Code That Must Remain

- `Asset.nativeAsset`, `nativeUrl`, resource `native/` folders and related
  serialization fields mean original resource data, not native applications.
- Device OS checks preserve mobile browser and mini-game compatibility.
- `NATIVE_CODE_BUNDLE_MODE` and `isNativeModule` describe WASM/ASM.js assets.
- `vendor/wasm/` is standalone WebAssembly source, not a native app engine.
- Keep third-party licenses and stable serialized enum values.

## Dependencies And Verification

- Generated PAL lives in `pal/`; adapters live in `bin/adapter/`. Edit their
  checked preparation scripts or upstream packages, not generated output.
- `scripts/patch-ccbuild.cjs` applies version-checked installation patches.
  Review those patches whenever upgrading ccbuild or its pinned tfig bundler.
- Web/WASM artifacts live in `external/emscripten`, prepared by
  `npm run setup:external`; never recreate an old native external path.
- Run `npm run prepare:engine`, `npm run test:platforms`,
  `npm run build:declaration`, `npm test -- --runInBand`, and representative
  `npm run build:minigame -- WECHAT` / `OPPO` builds after relevant changes.
- Engine bundles and unit tests do not prove complete vendor publishing or
  real-device rendering. Report missing external assets and editor/device
  validation explicitly; do not add empty declarations or skip type checking
  to hide missing dependencies.

## Development Skills

- Engine source and tooling: `.opencode/skills/cocos4-engine-dev/SKILL.md`.
- Game projects using this fork: `.opencode/skills/cocos4-minigame-dev/SKILL.md`.
- Discovery, cross-project usage and example checks: `.opencode/skills/README.md`.

## Local Windows Work Directories

- Keep downloads, extracted kits, test workspaces and temporary files on D: in
  the repository's ignored build directories or the single `D:\cocos4-work`
  directory. Set child-tool `TEMP`, `TMP` and `TMPDIR` explicitly.
- Do not create task directories at `C:\` or `C:\Users\Administrator`, or copy
  whole engine/dependency trees for each test. Remove unused generated copies;
  retain the current package, game sources and useful verification records.
- Use a private ACL on the designated work directory. A Devkit path-check
  failure is a tooling issue to diagnose, not a reason to scatter files on C:
  or change permissions for an entire drive.
