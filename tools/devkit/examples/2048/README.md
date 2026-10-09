# Packaged Devkit 2048

A small game and focused end-to-end check of the packaged Cocos4 tools. The game
uses only the delivered `cc` API, with no Creator project or engine-source imports.
Arrow keys or board swipes move tiles; New Game restarts while preserving the best
score. Game rules are kept separate from the scene code.

The October 1 local check exported WECHAT and BYTEDANCE with the new four-target
kit; it did not run a browser. The September 26 HTML5/BILIBILI kit and `run-02`
remain separate, valid historical evidence and the quick-play route below.

## Quick Play

From the repository root, reuse the older HTML5 kit and successful `run-02`
without rebuilding. Do not substitute the new kit for this identity-bound run:

```sh
EXAMPLE="$PWD/tools/devkit/examples/2048"
"$EXAMPLE/build/portable-candidate/runtime/node" "$EXAMPLE/play.mjs" \
  --kit "$EXAMPLE/build/portable-candidate" \
  --run "$EXAMPLE/build/run-02"
```

Open the printed preview URL and keep the terminal open. The helper accepts
`--kit KIT --run RUN [--ttl SECONDS]`, including relative kit/run paths, and must
be invoked with `KIT/runtime/node`. It validates successful run/report identities,
then invokes packaged `cocos4 call cocos4_preview_start` with a fresh UUID request
key and inherited stdio. Ctrl-C or the TTL stops it; the default is 1800 seconds.
`--help` starts nothing. The helper passed syntax/help checks and a direct
`--ttl 2` start/expiry check: preview reached `ready`, then `succeeded`, with exit 0.
This reused the existing artifact without rebuilding or rerunning game/browser tests.

## Files

Paths below are relative to this example directory. `src/` and `tests/` are the
maintained authoring inputs: `run.mjs` asks the packaged tools to create an editable
project, then copies those inputs into it. The generated project, private state,
exports and evidence remain under ignored `build/`.

### WeChat And ByteDance

| Item | Path |
| --- | --- |
| New packaged tools, including bundled Node | `../../build/minigame-delivery/portable-candidate/` |
| New tool archive | `../../build/minigame-delivery/portable-candidate.tar.gz` |
| New archive checksum | `../../build/minigame-delivery/portable-candidate.tar.gz.sha256` |
| Assembly receipt | `../../build/minigame-delivery/portable-candidate.build.json` |
| Editable project | `build/run-wechat-bytedance-01/workspace/game-2048/` |
| WECHAT source export (`game.js`) | `build/run-wechat-bytedance-01/exports/wechat/` |
| BYTEDANCE source export (`game.js`) | `build/run-wechat-bytedance-01/exports/bytedance/` |
| Run reports, including `result.json` and `exports.json` | `build/run-wechat-bytedance-01/evidence/` |

The new archive is 86,428,350 bytes, SHA-256
`34412b3316b6b456a319ec13ab9a64613f801296283ac030b4ba4f601660a918`.
Release ID: `sha256-935bd43e3dd7346afb106cfc274d8e78a6075b8dead7873994545cc9852d432d`.
SDK ID: `sha256-6b8bc73d6195c460e0ad6b4f8d3c1815e497bc78719f0b3ca12d10fb988db55a`.

### Historical HTML5/BILIBILI

| Item | Path |
| --- | --- |
| Packaged tools, including bundled Node | `build/portable-candidate/` |
| Tool archive | `build/portable-candidate.tar.gz` |
| Archive SHA-256 file | `build/portable-candidate.tar.gz.sha256` |
| Editable project | `build/run-02/workspace/game-2048/` |
| HTML5 export (`index.html`) | `build/run-02/exports/html5/` |
| BILIBILI source export (`game.js`) | `build/run-02/exports/bilibili/` |
| Run reports, including `result.json` and `exports.json` | `build/run-02/evidence/` |
| Browser report and six screenshots | `build/run-02/evidence/browser/` |

Archive SHA-256 recorded in both the checksum file and `build/assembly.audit.json`:
`9da6e5d9d82a68a6b7cc6e8db8a0f40c32dce1b1abc4d3703d5ae40c11d1b450`.

## WeChat And ByteDance Rerun

Opt-in local type/logic checks and source exports, from the repository root:

```sh
EXAMPLE="$PWD/tools/devkit/examples/2048"
KIT="$PWD/tools/devkit/build/minigame-delivery/portable-candidate"
"$KIT/runtime/node" "$EXAMPLE/run.mjs" \
  --kit "$KIT" \
  --out "$EXAMPLE/build/run-wechat-bytedance-02" \
  --targets WECHAT,BYTEDANCE
```

Use canonical absolute paths without symlink components. `--out` must be fresh
and absent with an existing parent; choose another new name if that directory
exists. Never overwrite retained runs. With no HTML5 selected, the runner does
not start preview/browser checks and needs no browser-driver arguments.

The runner authors project metadata under `platforms/wechat/` and
`platforms/bytedance/`. Each target's `game.json` and `project.config.json` are
copied verbatim to its export root and byte-checked, not replaced by SDK validation
configs. Defaults are test IDs `wx0000000000000000` and `tt0000000000000000`.
Optional `--wechat-app-id YOUR_REAL_WX_ID` / `--bytedance-app-id YOUR_REAL_TT_ID`
set project `appid`; supplying an ID proves neither account access nor vendor or
device acceptance. This command is documented, not rerun for this README update.

## Optional Rerun

This opt-in command uses the older HTML5/BILIBILI kit to repeat the focused game
checks, exports and browser smoke, not the full engine test suite. Run from the
repository root:

```sh
EXAMPLE="$PWD/tools/devkit/examples/2048"
"$EXAMPLE/build/portable-candidate/runtime/node" "$EXAMPLE/run.mjs" \
  --kit "$EXAMPLE/build/portable-candidate" \
  --out "$EXAMPLE/build/run-03" \
  --drivers "$PWD/tools/devkit/runtime" \
  --pngjs "$PWD/node_modules/pngjs" \
  --chromium "$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
```

All five paths must be canonical absolute paths without symlink components.
`--out` must be a new, absent directory whose parent exists; choose another new
name if `run-03` exists. Never overwrite `run-01` or `run-02`. The existing
Playwright drivers, pngjs and Chromium are external test-only dependencies, not
game dependencies or quick-play requirements; this runner installs nothing.

Optionally append `--bilibili-app-id YOUR_REAL_APP_ID`. The default, and the ID in
the retained BILIBILI export, is `TEST_ONLY_2048_LOCAL`; it is not publishable.
Supplying a real ID does not establish vendor or device acceptance.

## Recorded Results

### October 1 Local Exports

- `build/run-wechat-bytedance-01/evidence/result.json` records `success: true`,
  strict game/logic type checks with library checks enabled, **8 logic passes**,
  zero failed/skipped/TODOs, and successful WECHAT/BYTEDANCE `2d-basic/release`
  builds through the new kit's packaged MCP and bundled Node 24.21.0.
- Its `exports.json` records matching release/SDK/profile provenance,
  `copiedInventoryVerified: true` and `platformConfigBytesVerified: true` for both
  exports. WECHAT: 35 files / 1,824,514 bytes; BYTEDANCE: 38 files / 1,826,935 bytes.
  Build-integrated static module closure, resource inventory and source preflight
  passed; dynamic resource loading and game rendering remain unverified.
- `browser.performed: false`: HTML5 was not selected, so no preview or browser
  smoke was performed. Both new platforms used the test IDs above, not real
  accounts. ALIPAY and OPPO requests returned `PROFILE_NOT_AVAILABLE`.
- `../../build/minigame-delivery/sdk-result.json` records successful assembly of
  16 profiles across HTML5/BILIBILI/WECHAT/BYTEDANCE, each 2D/3D debug/release.
  The eight new target runtimes/local reports are retained in
  `../../build/minigame-exporters-20260930/summary.json`; their host/`cc` mocks and
  static engine checks are not engine execution or real-device proof.

`build/run-wechat-bytedance-01/evidence/entrypoints/result.json` records four further
successful packaged-tool checks: both platform starters emit blank app IDs and
the requested project names, and both exported source packages pass the standalone
`cocos4_package_validate` tool. Those checks used a single session without preview
or test-execution grants and left the original game, exports and artifacts unchanged.
The new kit's SDK-only `doctor` also passed with empty `PATH` and no `HOME`.

### September 26 Browser Check

The retained evidence below is from 2026-09-26 and the older kit, not a new test
run or a pass transferred to the four-target candidate:

- `build/assembly.audit.json` records unchanged selected assembly inputs.
  `build/doctor.result.json` records an SDK-only pass (exit 0); its release/SDK
  identities match the assembly and successful `build/run-02/evidence/result.json`.
- `result.json` records strict game/logic type checks, **8 logic passes**, zero
  failed/skipped tests, and successful HTML5/BILIBILI `2d-basic/release` builds.
- `exports.json` records copied artifact inventory verification, including byte
  sizes and SHA-256 hashes: HTML5 has 29 files / 1,776,428 bytes; BILIBILI has
  33 files / 1,721,183 bytes. Both have `copiedInventoryVerified: true`.
- `browser/browser-smoke.json` records real browser keyboard merge input, two
  mouse restarts and a single-handler check at 960x800; touch swipe/merge and
  touch restart at 390x844; preserved best scores and desktop save/reload
  persistence. These used an explicit deterministic localStorage fixture.
- Both browser scenarios passed unclipped-layout and colored-board-pixel checks
  with no game/page/console/request errors. Six SHA-256-recorded screenshots are
  `desktop-{seeded,merged,restarted}.png` and `mobile-{seeded,merged,restarted}.png`
  under the browser evidence directory.

Keep the historical `build/run-01/evidence/` failure, including its browser report
and `browser/desktop-failure.png`. `GraphicsComponent as Graphics` failed at
`getAssembler` because `2d-basic` excludes the optional graphics assembler.
`run-02` repairs the panels with procedural `Texture2D` plus sliced `Sprite`
rendering rather than assuming that a public alias includes the optional feature.

## Acceptance Limits

The new kit delivers **HTML5, BILIBILI, WECHAT and BYTEDANCE**, not the full engine
allowlist; ALIPAY and OPPO remain unsupported exporters. The older kit is still
HTML5/BILIBILI-only: its WECHAT/BYTEDANCE/ALIPAY/OPPO requests were rejected with
`PROFILE_NOT_AVAILABLE`, not successful game builds. These historical rejections
are not the new kit's WECHAT/BYTEDANCE result.

Mini-game exports are unsplit source packages with local preflight, not
vendor-compiled, uploaded or device-rendered releases. The old browser check used
headless Chromium 151.0.7922.34 and SwiftShader software WebGL, including emulated
mobile touch, not physical devices; the new run performed no browser check.
Browser win/game-over transitions and a full engine/platform matrix were not covered.

The new kit is a local Linux x64 candidate with bundled Node 24.21.0 and
`distributionApproved: false`, assembled from selected SDK inputs in a dirty
checkout rather than a clean end-to-end release rebuild. Redistribution-license
review, authenticated signatures/build attestation, clean-machine/supported-host
and real-model gameplay acceptance remain incomplete. Initial devkit/2048 source
was committed as `8adf2bac99` before this implementation; the new exporter work is
currently uncommitted. The adapter package `@cocos/engine-platforms@1.0.6` retains
its `UNLICENSED` metadata; preservation is not redistribution permission. These
results do not establish formal license, model, Creator, real-account,
vendor-publishing or real-device acceptance.
