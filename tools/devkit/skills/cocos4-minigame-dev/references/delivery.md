# SDK Delivery

## Inputs And Limits

The code-project workflow uses ordinary `package.json`, `tsconfig.json`, `src/`
and `assets/` files, not a new serialized scene format. The delivered starter is a
real runnable starting point with its own code-created scene, image, JSON and WAV
inputs. A documentation code fragment is not a replacement for that whole starter.

The current assembler accepts PNG, JPEG, WebP, GIF, WAV, MP3, OGG, JSON and text
assets by extension. Copy acceptance does not prove every target decodes every
encoding or that a dynamically constructed URL exists. Use the real starter's PNG,
JSON and WAV for the initial slice, then test added assets in the actual container.
Validate game-owned JSON shape and report missing/malformed files to the player.

Unsupported import workflows include arbitrary raw Creator scenes/prefabs, FBX,
custom Effect compilation, compressed texture import, asset UUID generation and
third-party importer/build plugins. Preserve an existing Creator project's metadata
and use its verified editor workflow when those formats are required. Do not rename
or copy unsupported data and claim it became a runtime asset.

No automatic dependencies, package scripts, plugins, engine compilation or external
asset downloads run during normal SDK checks/builds. MCP `project_check` accepts
`checks: ["types"]`, `["logic"]` or `["types", "logic"]`. Logic checks run explicitly
trusted conventional tests under `tests/` using the fixed `node:test` runner on a
private snapshot. They require a separate MCP/CLI startup grant of
`--mode develop --execute-tests true`; tool arguments cannot grant it. The AI
launcher does not grant logic execution, even in develop mode.

Trusted test execution is **not a sandbox**: test code can access host files,
spawn processes and use the network. Use OS isolation for untrusted projects.
There is no arbitrary command, npm script or test-config selection. Logic checks
do not run `game_build`, an engine/headless renderer or complete game scenes;
they are not browser, rendering or device evidence.

## Strict Example Check

The packaged checker uses the same kit's application SDK verifier, the selected
SDK's real TypeScript 4.9.5, full declaration closure and actual profile exports.
It has no dependency on Creator, an engine checkout or a global TypeScript install.
It matches the existing game's declaration-consumer settings: `strict: true`,
`noImplicitAny: false`, `skipLibCheck: false`. The implicit-any exception is part
of the shipped compiler contract for legacy declaration members, not a new stub
or a skipped declaration check; the report records it explicitly.
Run it manually using the kit's bundled Node where delivered:

```sh
/absolute/path/to/node /absolute/path/to/skills/cocos4-minigame-dev/scripts/check-examples.mjs \
  --sdk-root /absolute/path/to/sdk --target HTML5 --profile 2d-basic
```

Optionally add `--variant debug` or `--variant release`; omission defaults to
`debug`. The exact target/profile/variant must be delivered in the SDK, and the
JSON report records the selected variant. Unavailable combinations fail without
downloading or substituting another variant.

This is a read-only declaration/linkage consumer check. It neither executes game
code nor emits files, skips library checking, stubs `cc`, or launches a model.
The launcher denies shell tools; do not use MCP to evade that restriction to run
the checker. Maintainers/authorized users run it as a separate verification step.

## Acceptance

Check the exact target/profile/variant in the catalog before building. A debug-only
pack cannot produce release by changing a string. A 2D profile cannot acquire absent
3D/physics exports merely because full `cc.d.ts` contains their declarations.
Change to a delivered profile, adapt source, and run fresh checks/builds. Do not
infer platform export support from `engineTargetAllowed` alone.

Strict type checks, export linkage and artifact inventories prove different things
from a browser. Browser acceptance should include drawing, mouse/touch, score and
restart, missing assets, audio after gesture, hide/show and repeated restarts without
duplicated listeners. Record browser/GPU and console errors. Previewing a server URL
is not acceptance unless someone actually opens and exercises that artifact.

For BILIBILI use genuine BILIBILI profiles and game-owned `game.json`. Local source
preflight is not vendor compilation or compressed vendor size. A mock host check
is not rendering/audio/device evidence. Vendor tools, account setup, signing,
upload/review and real devices remain separate, explicitly authorized workflows.

An actual AI acceptance demonstration must record client/model versions and the
trace for creating a playable game, changing gameplay, finding/fixing an introduced
type error, switching delivered profiles, building, previewing and exporting where
supported. Deterministic config/stdio tests remain necessary but cannot stand in
for that model-driven demonstration.
