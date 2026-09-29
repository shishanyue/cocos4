# Packaged Devkit 2048

A small game and focused end-to-end check of the packaged Cocos4 tools. The game
uses only the delivered `cc` API, with no Creator project or engine-source imports.
Arrow keys or board swipes move tiles; New Game restarts while preserving the best
score. Game rules are kept separate from the scene code.

## Quick Play

From the repository root, reuse the existing kit and successful run without rebuilding:

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

## Optional Rerun

This opt-in command repeats the focused game checks, exports and browser smoke,
not the full engine test suite. Run from the repository root:

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

The retained evidence is from 2026-09-26, not a new test run for this README:

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

Current game exports are **HTML5 and BILIBILI only**, not the full engine allowlist.
WECHAT, BYTEDANCE, ALIPAY and OPPO were explicitly requested and rejected with
`PROFILE_NOT_AVAILABLE`; they were not successful game builds. BILIBILI is an
unsplit source package with source preflight, not a vendor-compiled or uploaded
release. Browser checks used headless Chromium 151.0.7922.34 and SwiftShader
software WebGL, including emulated mobile touch, not physical devices. Browser
win/game-over transitions and a full engine/platform matrix were not covered.

This is a local Linux x64 candidate with bundled Node 24.21.0 and
`distributionApproved: false`, assembled from selected SDK inputs in a dirty
checkout rather than a clean end-to-end release rebuild. Redistribution-license
review, authenticated signatures/build attestation, clean-machine/supported-host
and real-model gameplay acceptance remain incomplete. These results do not
establish formal license, model, Creator, vendor-publishing or real-device acceptance.
