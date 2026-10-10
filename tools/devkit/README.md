# Devkit Tools And Probes

Development tools and feasibility tests for the [portable devkit plan](../../docs/plans/cocos4-mcp-devkit.md).
The [development MCP/CLI](MCP.md) exposes 10 tools by default in read-only mode,
13 with `--mode develop`, and 15 with `--mode develop --preview true`. Verified
development packs enumerate their delivered HTML5/BILIBILI/WECHAT/BYTEDANCE,
2D/3D and debug/release profiles, editable starters, a self-contained strict game
compiler, and separately authorized
loopback serving of retained artifacts. Project scripts/plugins never execute
implicitly; pure logic tests require separate `--execute-tests true` authorization
and run trusted code, not a sandbox. Mini-game source-package assembly and static
closure/canonical preflight are available only for profiles delivered in the SDK;
vendor compilation, upload and device acceptance are not. Indexed packs provide
declaration-driven [API and example
queries](API-DOCS.md), not invented API/feature mappings.
This is **not** a complete portable release, Creator replacement, or completion
of the full MCP/game goal.

The source-only [Android WebView exporter](android/README.md) packages an existing
static HTML5 client and its assets in an APK shell with a configurable backend.
It emits a Gradle project, validates local references and provides explicit
Android toolchain diagnostics/build commands. This is a post-export packaging
step; it does not add an engine target or alter a delivered SDK/run9 release.

The [acceptance checklist](ACCEPTANCE.md) maps the complete contract to current
evidence. Linux candidate assembly, bundled Node 24.21.0, SPDX/file inventories and
offline namespace verification are implemented; candidate status is not formal
redistribution approval or fresh-VM/multi-host acceptance. See [MCP instructions](MCP.md)
for `prepare:release` / `verify:portable` and the required offline Node archive.
The historical v5-a candidate remains at `build/portable-candidate-20260922-v5-a`.
The [Packaged 2048 Check](ACCEPTANCE.md#packaged-2048-check) records the
earlier HTML5/BILIBILI candidate and focused results, not the new exporters; the
[September 24-25 checkpoint](ACCEPTANCE.md#september-24-25-checkpoint) retains
earlier identities, skill checks and interrupted verification.

New portable exports include root `AGENTS.md`, copied from the reviewed
[AI guide template](packaging/AGENTS.md). It explains bundled skills, MCP setup,
CLI fallback, external projects/state, profiles and job results. The
[run9 ZIP](build/windows-agents-delivery-20261010-run9/devkit-win32-run9.zip)
contains this guide and updated getting-started instructions; its
[packaging verification](build/windows-agents-delivery-20261010-run9/agents-packaging-verification.json)
binds guide bytes, relative links, source provenance and ZIP membership. The real
packaged startup/relocation and modified-guide rejection check passed. Its SDK,
engine and compiler payloads match run7; the new guide release has its own ID.
The sixteen-game/browser results below remain evidence for run7.

The Windows run7 candidate passed local packaged checks: sixteen edited
HTML5/BILIBILI/WECHAT/BYTEDANCE 2D/3D debug/release exports in two independent
workspaces, plus four real HTML5 browser cases. Download the
[ZIP](build/windows-delivery-20261010-run7/devkit-win32-run7.zip) (326,191,219 bytes)
and inspect the [delivery summary](build/windows-delivery-20261010-run7/acceptance-summary.json).
SHA-256 is `1ef233818583773cde45e18c75c2728f93f336d1c7b4c389c4e499d158636a5e`.
Use the protected D-drive task directory below. The two target groups are not a
single sixteen-profile run; current full source matrices remain unaccepted.
Existing engine/MCP results retain their own scopes. Exact identities, browser
results and remaining gates are in [Windows Local Delivery](ACCEPTANCE.md#windows-local-delivery-october-10).

The current Codex conversation separately completed
[Signal Switch](build/windows-delivery-20261010-run7/signal-switch/acceptance-summary.json)
through the packaged CLI: creation, TS2322, strict repair, build and real browser
gameplay. Victory/failure/timer, mouse/touch/keyboard, thirteen restarts and native
WebAudio PCM passed. This proves that CLI route; installed Codex MCP discovery
and the independent OpenCode/provider session remain unaccepted. The package is
a local candidate with `distributionApproved: false`.

Earlier [Effect work](effects/README.md) resolved the strict 3D EFX2404 blocker
without dropping builtin roots or disabling parser/driver validation. The
separate [runtime pipeline](runtime/README.md) records prior decorated 2D/3D
browser, assets, input, audio and restart evidence. That evidence belongs to its
exact runtime artifacts, not newly emitted MCP builds. Successful compilation or
an HTTP-ready preview alone does not establish browser rendering or interaction.

## Run

HTML5 clients can be packaged with the [APK CLI](android/README.md):
`npm run apk -- tools`, or `node build/src/cli.js apk tools` after building this
package. New portable candidates include the verified tools under `app/android/`
and expose `cocos4.exe apk` / `cocos4 apk`; immutable run9 predates that route.
APK export/build require `--mode develop` and explicit external Android SDK/JDK
paths. This is a Java WebView shell for HTML5, not a native engine target or MCP
game-build profile.

From an extracted Linux candidate:

```sh
./cocos4 doctor
./cocos4 doctor --workspace /absolute/path/to/games --state-root /absolute/path/to/private-cocos4-state
./cocos4 ai --client opencode --executable /absolute/path/to/opencode \
  --workspace /absolute/path/to/games --mode develop --preview true
```

From an extracted Windows x64 candidate under the selected protected task directory:

```powershell
& 'D:\cocos4-work\devkit-win32-run7\cocos4.exe' doctor
& 'D:\cocos4-work\devkit-win32-run7\cocos4.exe' mcp --workspace 'D:\cocos4-work\games' --state-root 'D:\cocos4-work\state' --mode develop --preview true
```

The Windows launcher uses its bundled Node and helpers. Existing workspace and
state directories must pass the handle and ACL checks. The selected subtree
must be private and protected from foreign modification; an ordinary shared
writable ancestor still fails even when the leaf is private. The fixed-volume
root has a separate ancestor rule; its ACL need not be changed. Keep workspace,
SDK and state as disjoint paths. Configure TEMP and browser profiles under the
same task subtree, and pass `--state-root` explicitly to keep task output on D.
The [package guide](packaging/README.md) records
Windows startup and installed-client requirements, and the [acceptance
ledger](ACCEPTANCE.md) records the exact workflows tested.

OpenCode is optional. The `ai` command integrates that reviewed reference client;
CLI commands and the stdio MCP server run independently. A compatible MCP
client can connect to the package launcher without using the OpenCode adapter.

Portable `doctor` without `--workspace` is SDK-only: no workspace, `HOME`, XDG state
configuration or private state is needed or created. It checks release/SDK integrity
and host read capabilities, not projects, client availability or gameplay; output
is one JSON object with `scope: "sdk-only"`. Explicit-workspace doctor keeps the
worker/job flow and external private state. Without a workspace, state options and
execution grants are rejected. Portable `ai` requires the absolute `--executable`
of an installed supported OpenCode. The launcher fixes the SDK and rejects
`--sdk-root`; source-mode CLI commands instead require all three explicit roots.
For workspace commands, state defaults to `$XDG_STATE_HOME/cocos4` or
`$HOME/.local/state/cocos4` on Linux, and `%LOCALAPPDATA%\cocos4` or
`%USERPROFILE%\AppData\Local\cocos4` on Windows, unless `--state-root` is supplied.

Maintainer source workflow, from the engine repository root:

```sh
npm ci --prefix tools/devkit --ignore-scripts --engine-strict --no-audit --no-fund
npm run check --prefix tools/devkit
npm test --prefix tools/devkit
```

Installation is an explicit, network-using maintainer step. Default source-catalog,
workspace, compiler and job tests use temporary data and existing dependencies;
they do not install project dependencies or run lifecycle scripts. Expensive
source runtime builds and real browser checks have their own prerequisites and
explicit integration settings; see the runtime guide. A checked/served artifact
is not a substitute for those browser checks.

Maintainer SDK preparation uses Linux `/usr/bin/python3` and
`renameat2(RENAME_NOREPLACE)`, or the Windows host publisher on Windows.
Installed publication uses the compiled
`cocos4-publish` helper instead; `npm run build` compiles the host helpers into
`build/host/` and portable candidates include them. Staging and destination must
share a filesystem and the canonical destination parent must exist. Publication
uses pinned descriptor chains and a five-second timeout, without Python, a shell
or check-then-rename/copy fallback in the installed game workflow.
AI-spawned MCP uses the verified Linux x64 `cocos4-mcp-launch`, a `static-no-libc`
helper with no ELF interpreter or shared libraries, to set a clean environment
before Node starts. It eliminates runtime `/usr/bin/env` and host-env fallback;
Node and the other helpers still have their own library requirements. The separate
OpenCode/provider authentication environment remains preserved, not forwarded to MCP.
TypeScript emits application and probe JS into ignored `build/src/` and
`build/probes/`. No MCP/client configuration, global skills, background service
or release artifacts are installed. Explicit preview requests bind a temporary
token-protected IPv4 loopback listener until TTL or shutdown.

The package has its own lockfile and TypeScript configuration. Engine TypeScript
4.9.5, root dependencies, and the engine's Node >=18 baseline are unchanged.
This private probe package requires Node >=18.20.8, the oldest tested runtime;
that does not establish support for every earlier Node 18 patch. Node 18 is only
a compatibility test target, not a runtime recommendation for a new release.

## Game Operations

See [MCP setup, exact input schemas and limits](MCP.md) before enabling develop
mode. Workspace, SDK and private state roots must be absolute and disjoint.
`scripts/prepare-sdk.mjs` creates the readonly catalog/validator pack;
`scripts/prepare-game-sdk.mjs` packages verified existing runtimes, templates,
declarations and the locked compiler closure. Source-mode use needs Node and the
built helpers; `prepare-release.mjs` supplies these in its enclosing candidate.
Manifests establish integrity, not release clearance.
Keep maintained code in the project and retained SDKs/evidence in ignored
`tools/devkit/build/`, not only in system temporary storage. The retained eight-profile
SDK is identified in the [acceptance checkpoint](ACCEPTANCE.md#packaged-2048-check).
Legacy eight-profile HTML5/BILIBILI SDKs remain valid. The new four-target kit is
expected to contain 16 profiles (each target's 2D/3D debug/release combinations).
The October 1 Linux delivery is recorded in [the acceptance ledger](ACCEPTANCE.md);
Windows has its own assembly and validation records. Query the
actual catalog rather than assuming these source changes upgrade an installed SDK.
Historical SDKs remain at `build/game-sdk-isolated` (debug) and
`build/game-sdk-release-workstream-20260919-lexical` (eight profiles). A compatibility fixture
is retained at `build/legacy-game-sdk` with provenance in `build/legacy-sdk-preparation`.

- `cocos4_project_create` requires `directory`, `templateId`, `projectName` and
  `requestKey`. It creates only an absent directory, with editable
  sources/assets and local declaration mapping; it never merges or overwrites.
- `cocos4_project_check` requires `project`, `target`, `profile`, `checks` and
  `requestKey`. Checks is a nonempty unique array of `types` and/or `logic`;
  logic additionally requires startup execution permission. It uses strict real
  SDK declarations and the fixed supervised Node test runner, not npm scripts.
- `cocos4_game_build` requires `project`, `target`, `profile`, `variant` and
  `requestKey`. Only delivered debug/release combinations are available. It compiles
  current game sources and packages necessary runtime files plus standard assets,
  not the old fixture's compiled game. It does not compile the engine or import
  arbitrary Creator assets.
- BILIBILI starters add root `game.json` with an empty appId. Supply your appId and
  review version/platform settings before building; source config bytes are kept
  unchanged, never replaced by the SDK validation fixture. This root layout remains
  supported for shipped BILIBILI projects.
- WECHAT/BYTEDANCE starters add `platforms/wechat/{game.json,project.config.json}`
  or `platforms/bytedance/{game.json,project.config.json}`. Creation blanks `appid`;
  set your real `wx`/`tt`-prefixed ID in that target's `project.config.json`. Build
  copies both config files verbatim to the export root. These use genuine `wx`/`tt`
  adapters, matching loaders and engine flags, not renamed BILIBILI bundles.
  Subpackages, plugins, open-data contexts, workers and cloud export are unsupported.
- Mini-game outputs are unsplit source packages with `game.js` entry and preserved
  licenses/notices; only HTML5 (`index.html`) can be browser-previewed. Static
  closure/source preflight does not establish vendor compilation, upload or device
  behavior. See [MCP instructions](MCP.md#2048-target-selection) for the implemented
  2048 `--targets WECHAT,BYTEDANCE` workflow, which runs no browser when HTML5 is omitted.
- Checks/builds accept `timeoutMs` from 1000 to 3600000 (default 600000), bound into
  request-key identity and including queue/preparation time.
- Separate `--preview true` enables `cocos4_preview_start` (`artifactId`, required
  `requestKey`, optional `ttlSeconds`) and `cocos4_preview_stop` (`jobId`). Start returns a
  receipt; poll `job.phase === "ready"` for the random tokenized loopback URL.
  The CLI emits that URL and stays alive until TTL or shutdown. Opening it runs
  the emitted game in the browser, not in the server worker.
- Compiler source and its complete manifest-verified dependency closure are
  copied and rehashed into private staging before loading. Engine/ancestor/global
  dependency fallback is blocked. TypeScript is strict with neither library
  check skipped; structured compiler diagnostics remain in failed job reports.
- One preview may coexist with one heavy worker. Registered build payloads are
  limited to 128 MiB each, 512 MiB and 64 outputs across the workspace/SDKs.
  Artifact UUIDs equal build job IDs. Job metadata/logs/keys expire after seven
  days; the independent SDK-scoped artifact registry and delivered files do not.
  Outputs keep their original producer when another release opens the same SDK's
  state. Expired HTML5 builds remain previewable and all outputs count toward the
  quota. Unregistered directories block new artifact publication instead of being
  silently adopted or ignored.
  Stop the server before moving unneeded outputs outside private state to free quota.
- Metadata v5 records each new job's verified outer `releaseId` and each new
  artifact's `provenance: { releaseId, profileSha256 }` in its receipt/inventory.
  The profile hash comes from the actual selected descriptor. Source tools use
  `releaseId: null`. Valid v2/v3/v4 imports preserve ownership without inventing
  missing producer/profile provenance or relabeling old outputs.
- New packaged request keys bind SDK and verified release as well as normalized
  arguments/timeout: another release or unknown legacy producer cannot supply a
  cached result. The same verified release may relocate with the same workspace
  and state without losing deduplication. Source-mode input identity remains bound
  to the SDK root. Use a new key after editing game sources; keys do not track file contents.
- The parent serializes publication after successful worker exit. Accepted
  cancellation cannot become success. A persisted `committing` phase records
  publication intent, not a complete transaction journal: process loss can leave
  a created project whose job is interrupted. Inspect it before retrying; no
  automatic project rollback/replay occurs. Unregistered artifacts are preserved
  for manual inspection, not automatically served or deleted. Linux authorized
  logic has real process-tree tests; power-loss and other hosts remain unverified.

For focused compilation/publication tests after the devkit TypeScript build:

```sh
GAME_OPERATION_SDK_ROOT=/absolute/path/to/game-sdk GAME_SDK_INTEGRATION=1 \
  node --test tools/devkit/test/game.test.mjs tools/devkit/test/workspace.test.mjs
```

Game-operation test temporary roots use canonical `os.tmpdir()`. The default SDK
fixture is `tools/devkit/build/game-sdk`; selecting the explicit integration settings makes
missing SDK inputs fatal rather than skipping. These tests check actual 2D/3D
compilation, diagnostics, profile overflow, file/permission invariants, snapshot
races, atomic conflicts, inventory integrity and bootstrap consistency. They do
not establish rendering of newly emitted games or a full MCP-to-browser flow.

## Locked Inputs

| Input | Version | Purpose |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.30.0 | Official stdio client/server and protocol schemas |
| `typescript` | 5.9.3 | Strict probe checking, including dependency declarations |
| `zod` | 3.25.76 | Strict input/output schemas |
| `json5` | 2.2.3 | Offline source catalog preparation without engine dependencies |
| `@types/node` | 18.19.130 | Node type baseline |
| `@cocos/module-system` | 0.0.21 | Actual web and CommonJS-like loader producer |
| `@cocos/typescript` | 4.9.5-cocos.4, transitive | Published loader source checking |
| `@hono/node-server` | 1.19.9, SDK-scoped override | Keep the SDK dependency tree installable on tested Node 18 |

The SDK permits Hono node-server `^1.19.9 || ^2.0.5`. Unconstrained resolution
selected 2.1.1, which requires Node >=20. The override stays inside the SDK's
supported range; no package source or engine requirement is patched. MCP-over-HTTP
and OAuth are not exercised or exposed; artifact preview is a separate loopback
HTTP server, not an MCP transport. Reassess this override on SDK upgrades.
Tarball locations and integrity hashes, including all transitive packages, are
recorded in `package-lock.json`. This is not a release SBOM or license clearance.

## Executed Evidence

[Run7 delivery](build/windows-delivery-20261010-run7/acceptance-summary.json)
binds the exact ZIP/release/SDK to sixteen exports and four Edge/SwiftShader
browser reports, with package and archive unchanged. It records standard
Windows extraction, Unicode/long-path relocation, SDK-only doctor and actual
official-client MCP calls. HTML5 desktop/mobile pixels, input, native WebAudio,
missing assets and ten restarts passed; browser/driver remain explicit external
dependencies. Mini-game evidence is local source preflight, not vendor rendering.
[Signal Switch](build/windows-delivery-20261010-run7/signal-switch/acceptance-summary.json)
adds the current Codex packaged-CLI loop and clean preview TTL exit 0.

The [D-drive checks](ACCEPTANCE.md#d-working-directories-october-10) passed
filesystem/runtime 16/16 on each pinned Node and strictly loaded the actual SDK.
The current source matrix was interrupted, with null totals and `success: false`;
these scopes are not combined into a full-matrix pass. The
[cleanup summary](build/c-drive-cleanup-20261010/summary.json) records zero task
items in C-root and user-home scopes; useful small evidence is retained on D.
VM, non-admin, offline/source-hidden/read-only-mount, device/hardware, vendor,
authenticated source and redistribution acceptance remain open.

Earlier checkpoints below retain their original scope and identity.

`build/minigame-exporters-20260930/summary.json` records eight successful new
WECHAT/BYTEDANCE 2D/3D debug/release runtime builds and local reports. Local checks
use explicit host/`cc` mocks and static engine inspection, not engine execution or
rendering; browser, vendor, device and portable-SDK validation remain false.
The parent reports 26 focused shared production-validator tests passed. This doc
update at that checkpoint ran no tests/builds and claimed no final new SDK/candidate/demo result;
final proof belongs in [ACCEPTANCE.md](ACCEPTANCE.md).

The current [acceptance ledger](ACCEPTANCE.md) separates retained reports from
parent-reported terminal-only tests. The historical v5-a candidate's Node 24 startup/archive
report records 34 passed, zero failed/skipped/cancelled and unchanged inputs;
the namespace workflow records eight builds and four browser reports with
release/profile identity assertions. Parent direct runs passed 139
job/log/artifact/preview cases on each pinned Node and 49 game cases on Node 24.
No current full Node 18/24 matrix pass is established. See the
[historical packaged checkpoint](ACCEPTANCE.md#packaged-2048-check) and historical
[September 26 focused verification](ACCEPTANCE.md#september-26-focused-verification).
The verification-script fixes passed scoped source/harness checks; no further full
runs were performed at that checkpoint. The later candidate assembly supersedes "not rebuilt"
without inheriting earlier matrix passes.

The actual OpenCode 1.18.21 `opencode/big-pickle` attempt retained in
`build/ai-model-20260921-7Qm4waaE/REPORT.md` and `audit.redacted.json` received HTTP
403 `FreeTierError`, zero model text and zero tool calls. The gameplay workflow did
not run. This is a specific failed attempt, not success or proof all models are
unavailable. Historical agent evidence has been archived under `build/`; the
checklist records the five archive hashes. Retention is not a rerun.

Initial protocol/loader evidence on 2026-09-16, Linux x64, engine baseline `2736376eb7`:

| Check | Result |
| --- | --- |
| Probe TypeScript 5.9.3, `skipLibCheck: false` | Passed |
| Node 18.20.8, strict checking and full probe suite | Passed, 8 tests, no skips |
| Node 24.21.0, strict checking and full probe suite | Passed, 8 tests, no skips |
| Local Node 26.7.0, `npm test` | Passed, 8 tests, no skips |
| Unmodified loader sources, Cocos TypeScript `--noEmit` | Passed in relocated layout |
| Clean `npm ci --ignore-scripts --engine-strict` with Node 18.20.8 / npm 10.9.4 | Passed |
| Root engine `tsc --noEmit --pretty false` | Passed with engine TypeScript 4.9.5 |
| Root `npm run test:platforms` | Passed, 28 tests |
| Root `npm test -- --runInBand` | 161 suites / 1124 tests passed; existing 1 suite / 2 tests skipped, 16 todo; 34 snapshots passed |
| Real browser/GPU, decorated game components, vendor runtime | Not run |
| Process groups, Windows Job Objects, server/worker strong-kill cleanup | Not implemented or tested |

Engine Jest remains headless and logs existing JSDOM canvas limitations; its
passing result is not a graphics acceptance. The subsequent Effect work changes
the mappings import boundary and reruns engine preparation, declarations and
platform bundles; see the separate Effect record rather than treating the
initial counts above as current regression results.

The two additional Node versions were explicitly obtained as pinned
`node-linux-x64` npm packages in temporary storage and invoked by absolute path.
They are test executables, not bundled devkit runtimes or verified release inputs.
The current CI workflow instead defines provisioned Node 18.20.8 and 24.21.0
integration lanes with host/GL prerequisites, engine/tool dependencies, real runtime
reports, reviewed official Node archive verification and offline candidate assembly
before the unfiltered suite. Earlier six-test `verification-inputs` runs passed per
pinned Node in parent-reported direct runs. No clean-checkout or hosted rehearsal
has been performed; workflow/source assertions are not completed CI or release acceptance.

### MCP Results

`probes/mcp-server.ts` is a fixed, in-memory fixture named `p0_echo`, deliberately
not any of the planned `cocos4_*` tools. `probes/mcp-client.ts` uses the official
SDK over a real child-process stdio transport. It verifies:

- Protocol negotiation to `2025-11-25`, discovery, tool calls and resource reads.
- Strict input/output JSON Schemas and matching text/structured success and
  intentional business-error responses, below the 64 KiB response budget.
- Rejection of invalid/unknown inputs, unknown methods/tools and arbitrary file URIs.
- No unsolicited stdout, diagnostics on stderr, and exit on stdin EOF without a signal.

**The SDK's high-level defaults do not satisfy the planned production contract.**
`McpServer` advertises `listChanged: true` for tools/resources, catches unknown
tools as tool errors rather than protocol errors, and returns text-only schema
errors. The tests record those upstream behaviors instead of pretending that
the fixture is the P3 implementation. Production must explicitly control
capabilities, error routing and envelopes, using the SDK's lower-level `Server`
API where necessary. This historical fixture exercises no actual job manager;
the separate `src/` application and `test/mcp.test.mjs` now cover that implementation.
Closing this trivial fixture does not prove process-tree supervision.
The probe bounds requests to 3 seconds and closes its transport on test abort,
with teardown registered before connecting. Reusing one abort signal for all
SDK 1.30 requests accumulated listeners on Node 18; transport-level cancellation
avoids that leak without disabling warnings or raising listener limits.

### Loader Results

`test/loader.test.mjs` calls the real package's `build()` twice, with
`platform: 'web-desktop'` and `platform: 'bilibili'`. It does not mock warmup.
Both outputs have source maps, minification, HMR and editor integration disabled.
The published API accepts `platform`, not the newer upstream repository's
`preset`; passing `HTML5` would incorrectly select its non-browser branch.

Both loaders resolve a bare `cc` mapping, relative and dynamic imports, preserve
module caching, and reject missing modules. The web probe uses a VM document
harness, not a real DOM/browser. Modules are plain `System.register` fixtures,
not `cc.js` or a game. No result here establishes graphics or vendor support.

Two integration issues were reproduced:

- Building the installed package in place inherits the engine's ancestor
  `@types/systemjs`, producing TS2451 even though the builder emits JS. The test
  relocates the **unchanged** package to a temporary directory and links only
  devkit dependencies. It separately runs its strict checker, validates all
  compiler input paths, and fails on build TS diagnostics. No `skipLibCheck`,
  ambient stub, or installed-package patch is used.
- When `self === GameGlobal` but `GameGlobal !== globalThis`, the loader creates
  `GameGlobal.System` and then throws `ReferenceError: System is not defined`.
  A separate positive probe demonstrates explicit global `System` forwarding.
  This is a required host integration contract, **not** an implemented BILIBILI
  adapter fix. The unbridged failure remains an explicit regression assertion.

## Runtime Evidence And Gaps

The delivered profiles explicitly include `legacy-pipeline`; the separate smoke
CLI default still does not register a renderer. See `exports/legacy-pipeline.ts`
and `cocos/root.ts:setRenderPipeline`. The HTML5 runtime uses BUILD,
`rendering.customPipeline: false`, no serialized launch scene and a disabled
splash, then creates scenes through public APIs after `game.init()`.
A resolved init or an AFTER_DRAW event alone is not pixel evidence.

`builtin-res-mgr.ts:init()` generates textures, **not** Effects or materials.
`loadBuiltinAssets()` consumes `engine.builtinAssets` from an `internal` bundle
and registers by asset name. The UUID roots in `cc.config.json` resolve to
`editor/assets` metadata; material references and shader chunks add dependency
edges. Copying `.effect`/`.mtl` sources is not runtime compilation. The material
names also need normalization. Test builtin fixtures are not production inputs.

The following independent compiler has now been installed and executed in the
separate maintainer Effect probe (not in this Node 18-compatible package):

- Repository: [`cocos/cocos-cli`](https://github.com/cocos/cocos-cli/tree/8595d1b2f1dff34fb1111d3c5de88fc5f08da9f9/src/core/assets/effect-compiler).
- Pinned research revision: `8595d1b2f1dff34fb1111d3c5de88fc5f08da9f9`, CLI
  `0.0.1-alpha.42`; its `repo.json` selects Cocos4 `4.0.0-alpha.34`.
- The library exposes `addChunk`, `buildEffect` and `stripEditorSupport`; it
  produces GLSL1/3/4 plus reflection, binding and property metadata.
- Inputs include the checked-in Effects/chunks and `cc/editor/offline-mappings`.
  Its lockfile selects `glsl-tokenizer@2.1.5`, `glsl-parser@2.0.1`,
  `js-yaml@4.1.0` and native host validator `gl@9.0.0-rc.10` (Node >=20).
- The compiler eagerly initializes headless WebGL and validates shaders;
  `skipParserTest` is not a substitute. Establish a separate maintainer build
  environment, not a Node minimum increase or a native engine backend.

The earlier strict deferred-lighting EFX2404 failure came from parsing disabled
conditional branches after stripping preprocessor directives. The separately
pinned `glsl1-conditional-validation` patch uses real GLSL preprocessing before
the ordinary AST check and retains driver validation of the original source.
The Effect record now contains successful 2D and full configured 3D builtin
compilation and reproducible resource digests. This resolves that historical
blocker; it is not a claim that the Effect tests were rerun with this doc update.

Prior runtime acceptance adds real Chrome/ANGLE SwiftShader 2D/3D pixels, builtin
loading, decorated game code, input, image/JSON/audio and scene restarts. Software
WebGL is not physical GPU or vendor-device evidence. See the hash-bound browser
reports and runtime guide for the tested artifacts and configurations. Emitted
MCP artifacts intentionally record compiler/linkage/inventory evidence without
inheriting browser success from the SDK template. Any new build-to-preview
end-to-end acceptance must identify and test those new output bytes separately.

General Creator asset import and vendor compilation/upload remain outside the
first local beta. BILIBILI/WECHAT/BYTEDANCE source assembly and Linux supervision have separate
evidence; redistribution, fresh-machine and multi-host acceptance remain open.
Neither the historical eight probe tests nor the development tool count completes
those gates; consult the current requirement-to-evidence checklist.

## Redistribution Gate

Do not publish a bundle based solely on package `license` fields:

- Root `LICENSE` says MIT, while `exports/base.ts:6-15` contains restrictive
  Creator game-development/tool-distribution wording. Both notices remain
  unchanged; their applicability needs clarification before devkit distribution.
- The compiler candidate has a MIT root license but ISC package metadata.
- `@cocos/module-system` declares ISC; its tarball includes the embedded SystemJS
  MIT notice but no top-level ISC notice. Preserve and resolve attribution.
- `@cocos/engine-platforms@1.0.6` declares `UNLICENSED` and ships no standalone
  license file. The WECHAT/BYTEDANCE exports preserve adapter metadata/notices;
  the engine MIT license does not resolve their redistribution authorization.
- Effects/chunks carry original copyright notices. Fonts and selected external
  WASM require their own provenance/notice inventory. Do not infer clearance
  from an existing developer cache or silently include unneeded fonts.
- The loader build dependencies include deprecated `rollup-plugin-terser` and
  `sourcemap-codec`. This private experiment is not an audited shipping toolchain.

These are observed notice/dependency gaps, not legal conclusions. Resolving them
is a release gate; removing headers is not a fix.
