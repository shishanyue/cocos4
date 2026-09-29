# Browser Bootstrap Probe

Independent, source-built HTML5 BUILD maintainer test. Everything this probe
creates stays under this directory; engine, Effect, and parent devkit files are
read-only inputs. This is not a production SDK, complete playable game, Creator
export, vendor validation, or redistribution clearance.

## Run

From the engine repository root, with its prepared dependencies, PAL, external
assets, and real `bin/.declarations/{cc,cc.editor,webGPU}.d.ts` already present:

```sh
export PATH="$PWD/tools/devkit/build/node24/package/bin:$PATH"
npm ci --prefix tools/devkit/browser --ignore-scripts --engine-strict --no-audit --no-fund
npm test --prefix tools/devkit/browser
npm run check --prefix tools/devkit/browser
npm run check:baseline --prefix tools/devkit/browser
npm run build --prefix tools/devkit/browser -- --assets "$PWD/tools/devkit/effects/build/artifact-RDFOBC"
# Use the new artifact path printed by build, never a root mini-game output:
npm run verify --prefix tools/devkit/browser -- --artifact /absolute/path/to/browser/build/probe-ID/artifact --browser /opt/google/chrome-canary/chrome
```

Installation is an explicit network step, using this package's lockfile. No
browser download, OS package installation, or global configuration modification
is performed. The tested checkout already had Chrome Canary. `--browser` must
identify an existing absolute executable. Browser profiles and evidence are
retained in ignored `build/browser-*/`. Stop any running verification before
removing its profile. No persistent server remains after verification.

`--assets` is required, not auto-discovered. The input must be the actual
`2d-basic` Effect artifact with the exact eight-feature profile, five Effects,
ten materials and 18 resource files. All resource sizes/hashes, the complete
file inventory, builtin UUIDs and recorded engine source hashes are checked
before compilation. The exact input `result.json` is retained with its digest.
These checks provide integrity, not authentication of arbitrary maintainer inputs.
Never pass untrusted engine checkouts, packages, or Effect artifacts.

## Type Gate

`check` deliberately fails if the complete public declarations do not pass
full TypeScript strictness. On this checkout it finds 29 pre-existing
TS7008/TS7010 implicit-any diagnostics in DragonBones/Spine declarations.
No declarations or engine types are edited, stubbed, filtered, or patched.

The narrower `check:baseline` and build check the entire declarations using
the repository's existing contract: `strict: true, noImplicitAny: false`, as in
the root and `scripts/test-declarations/tsconfig.json`. A second program checks
`game.ts` with `noImplicitAny: true`. Both `skipLibCheck` and
`skipDefaultLibCheck` remain false. Build records every full-strict diagnostic
and `fullStrictDeclarations: false` in `typecheck.json` and `build-report.json`.
Thus browser success does not close the full-strict declaration gate.
Root `tsc --noEmit` runs before every build, without regenerating shared output.

## Runtime Contract

- Explicit features: `base,2d,ui,audio,tween,gfx-webgl,gfx-webgl2,legacy-pipeline`.
- Real root `@cocos/ccbuild@2.3.21`, HTML5/BUILD, System.register, debug,
  unsplit/uncompressed, `targets: { chrome: '100' }`, no source maps.
  The syntax target avoids the untargeted legacy captured-loop transform in
  shader program setup; it is not a claim of Chrome 100 compatibility.
- NATIVE/JSB/EDITOR/PREVIEW/TEST/NODEJS/MINIGAME must be false.
- Real parent `@cocos/module-system@0.0.21`, `platform: 'web-desktop'`, no HMR,
  editor support, minification or source maps. Only the private copied tsconfig
  selects the parent's local type root, avoiding ancestor SystemJS globals.
  Installed package sources and builder code remain unchanged.
- `game.init()` receives settings with legacy rendering, renderMode 2, disabled
  splash, no serialized launch scene, and the generated builtin UUID list.
  `game.run()` starts the code-created scene. The internal bundle's empty
  prerequisite module represents no game scripts, not fake engine/assets.
- Game code imports only public `cc`: Scene, orthographic Camera, Canvas,
  UI_2D, ImageAsset/Texture2D/SpriteFrame/Sprite, and Node touch input.
  A real 32x32 two-tone PNG loads through `assetManager.loadRemote`.
  Tapping/clicking changes red to blue and moves the tile 144 world units;
  the next input returns it. No handwritten shaders or builtin substitutes.

Each build has a unique `build/probe-*/artifact/engine/` directory. Only
`artifact/` is runtime: compiled engine/game/loader/bootstrap, settings, the
generated internal bundle and probe PNG. Types, source templates, build tools,
Effect provenance and reports stay outside it. The loopback server snapshots
only manifest-verified runtime bytes and cannot fall back to engine sources,
maps, build reports, sibling paths or arbitrary local files. It is a small
trusted-maintainer server, not the parent SDK preview/security implementation.

## Evidence

`verify` creates a separate hash-bound report, never upgrades build metadata
to browser success. It runs desktop WebGL2, portrait/touch-layout WebGL2, and
desktop WebGL1 fallback, using Chrome's actual ANGLE SwiftShader renderer.
This is software WebGL, not physical GPU, Android/iOS, or vendor-device evidence.

For each case it verifies all five loaded EffectAsset instances and ten named
materials with nonempty passes, requests the image, captures the engine's actual
WebGL context/version/renderer, waits for scene drawing, takes canvas PNGs and
checks camera-background and both texture-half pixels. Input is sent through
Playwright mouse/touch events, never by calling a game handler. Subsequent PNGs
must show the changed colour and position, clear the old position, and return
after a second input. The initial screenshot is after at least three scene
draws, not a measurement of the very first GPU swap or startup latency.

Console messages, page errors, HTTP statuses, browser executable/version/hash,
verifier source hashes, screenshot hashes and build/Effect identities are
retained even on failure. Unexpected errors fail. The deliberately forced
WebGL1 case must emit exactly the engine's E16405 message, `This device does
not support WebGL2`, before successful fallback; that message is retained,
not hidden. WebGL2 cases permit no console errors.

Tests cover unsafe paths, effect hash rejection, changed-artifact rejection,
source-not-served snapshot behavior and clear-only/wrong-colour pixel rejection.
These tests alone do not establish rendering. Inspect the separate browser
report for the exact bytes tested.

## Remaining Acceptance

Full-strict public declarations remain blocked as described above. 3D needs
its own explicit feature profile, full generated 3D builtin closure and a
code-created camera/mesh scene with new image evidence. This probe intentionally
does not reuse 2D resources as proof of 3D readiness. Decorated component
compilation/AST work belongs to the other workstream, not this bootstrap.

The image test is not general asset import: JSON/audio, error/retry paths,
reference cleanup across scene restart, prefabs, bundles, fonts, meshes and
user materials remain untested here. Audio and tween being in the engine profile
does not prove playback or animation. There is no score/win/loss/restart loop;
all reports retain `playableComplete: false`. No engine regression matrix,
editor acceptance, vendor publishing or license clearance is claimed.
