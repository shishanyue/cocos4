# Complete Devkit Acceptance

The objective is a complete standalone MCP and offline portable development kit,
not just registered tool names. The normative requirements are in
[`docs/plans/cocos4-mcp-devkit.md`](../../docs/plans/cocos4-mcp-devkit.md).
The table maps that contract to implementation and inspectable evidence. A source
test, fixture, startup receipt, or historical pass is not a portable release pass.
Unknown, skipped, interrupted, and unverified requirements remain open.

The current focused checkpoint is the [WeChat And ByteDance Delivery](#wechat-and-bytedance-delivery).
The earlier [Packaged 2048 Check](#packaged-2048-check),
[September 24-25 checkpoint](#september-24-25-checkpoint) and
[September 26 source/harness fixes](#september-26-focused-verification) remain
historical; no current full Node 18/24 pass is established.
The current user instruction is no further full matrix runs, only necessary
focused checks. Selected tests and retained archives do not establish full acceptance.
All `build/` evidence paths below are relative to `tools/devkit/`.

## Requirement Map

| Plan / Requirement | Artifact Or Verification Entry | Current Evidence / Remaining Work |
| --- | --- | --- |
| 1, 3.1, P1: No engine checkout, Creator, system Node/npm, or first-use download | `packaging/launcher.c`, `packaging/launch.mjs`, `scripts/prepare-release.mjs`, `scripts/verify-portable-host.mjs` | Historical candidate v5-a passed eight builds and four actual browser scenarios in an offline, non-admin namespace without source/home/system executable mounts; browser and driver mounts are explicit test prerequisites. SDK-only `./cocos4 doctor` needs no workspace/HOME/state; explicit workspace retains jobs. Fresh VM, model and other hosts remain open. |
| 3.1, 3.4: Fixed runtime/dependency closure, reproducible payload, manifest, archive checksum and provenance | `scripts/prepare-game-sdk.mjs`, `src/sdk.ts`, `src/release.ts`, outer `release.json`, SPDX inventory | New four-target candidate identity/size/checksum below; v5-a is retained separately. Historical e/f have identical payload and archive hashes, not a repeated current build. New artifacts bind verified release/profile provenance; legacy imports are not relabeled. Clean end-to-end source provenance and authentication remain open. |
| 3.1, 11.1: Linux x64, Windows x64, macOS arm64 host verification | Real per-host portable matrix | Linux candidate and namespace evidence only; no full VM or Windows/macOS acceptance. Do not advertise the other hosts. |
| 3.2, 11.1: Locked dependencies and strict independent TypeScript | `package-lock.json`, `tsconfig.json`, `npm run build` | Strict tool compilation and pinned Node 18.20.8 / 24.21.0 tests exist; final merged matrix is open. |
| 3.3: Independently built HTML5/BILIBILI/WECHAT/BYTEDANCE, 2D/3D, debug/release | `scripts/build-runtime.cjs`, `scripts/prepare-game-sdk.mjs`, `test/release-profile.test.mjs` | Current 16-profile SDK: [WeChat And ByteDance Delivery](#wechat-and-bytedance-delivery); eight new target runtimes plus retained HTML5/BILIBILI inputs. Earlier eight-profile SDK: [September checkpoint](#september-24-25-checkpoint). Historical SDK `build/game-sdk-release-workstream-20260919-lexical`, ID `sha256-68bbd6aa9b7e56f9d22c61a35541d8f5113c8d7920cac9033a5382f40a720a28`, contains eight profiles. Four public release cases passed on both pinned runtimes for that earlier evidence; final merged matrix remains open. |
| 3.3, 6.3: Capability levels derived from allowlist and delivered profiles | `src/sdk.ts`, `src/app.ts`, catalog tests | Implemented; final merged protocol and payload matrix required. No white-list entry alone promises an exporter. |
| 4.1: Independent module loader, real init, builtins, strict Effects and decorated game behavior | `runtime/`, `effects/`, runtime/loader/compiler tests | Real 2D/3D runtime and browser evidence exists; packaging must preserve the verified closures and demonstrate it without source access. |
| 4.2, 6.3: Standard editable TS/JS projects and supported resources, no implicit scripts/plugins | `src/game.ts`, `runtime/compile-game.cjs`, `test/game.test.mjs` | Creation, strict checking and builds implemented. Unknown resources, profile linkage and failed-build preservation have regressions; full current matrix open. |
| 4.2, 6.3: BILIBILI game bootstrap, adapter, module/resource closure and canonical preflight | `src/bilibili.ts`, `runtime/verify-bilibili.cjs`, `scripts/validate-bilibili.cjs`, BILIBILI tests | Shadowed-exporter defect repaired using lexical bindings. Real public 2D/3D release builds now passed on Node 18/24. Local host simulation is not vendor rendering. |
| 4.2, 6.3, P5: WECHAT/BYTEDANCE source exporters and project-owned metadata | Target-specific `runtime/` preparers/verifiers, `src/bilibili.ts`, `scripts/validate-minigame.cjs` | Eight genuine target runtime builds/local reports and packaged 2048 `2d-basic/release` exports passed at the current checkpoint. Config bytes and copied inventories verified; local host/cc mocks and static checks are not engine execution, vendor compilation or device rendering. |
| 5, P4: Temporary installed OpenCode connection, no global configuration mutation | `src/ai.ts`, `src/ai-config.ts`, `src/ai-files.ts`, `runtime/mcp-launch.c`, `test/ai-run-focused.mjs` | Historical OpenCode 1.18.21 non-root Linux checks: `build/ai-p4-BLF0Lw/` (Node 18), `build/ai-p4-RLoMPw/` (Node 24), 37 focused tests and 93 real file-tool checks each. Current static-no-libc MCP helper removes runtime `/usr/bin/env`; separate provider auth environment is unchanged. Portable AI requires `--executable`, rejects `--sdk-root`. Real model attempt below failed; no gameplay demonstration. |
| 6.1-6.2: Official SDK stdio, strict schemas, resources, error routing, bounded matching text/structured responses | `src/server.ts`, `src/app.ts`, `probes/mcp-client.ts`, protocol tests | Implemented; revalidate current merged source with official client. No experimental Tasks or arbitrary file resource exposure. |
| 6.3: All fourteen named MCP tools and CLI parity | `src/app.ts`, `src/cli.ts`, `src/operations.ts` | Ten default / thirteen develop / fifteen with preview, including additional preview_stop; logic is an authorized check option, not a new arbitrary execution tool. |
| 6.3, 8: Explicit execute-tests permission and useful pure logic results | `src/logic.ts`, `src/logic-runner.ts`, `src/process.ts`, `runtime/supervise.c` | Public develop + execute-tests grant, fixed Node tests, real declarations and TS/JS/MJS/CJS compiler checks implemented. Both pinned logic/lifecycle matrices: 35/35. Trusted execution is not a sandbox. |
| 7: Required request keys, seven-day idempotency, deadlines, exits and report inventories | `src/jobs.ts`, `src/contracts.ts`, `test/jobs.test.mjs`, `test/artifact-lifecycle.test.mjs` | Metadata v5 keeps SDK artifact ownership independent of seven-day jobs/logs/keys and preserves original producers. New release-aware keys cannot reuse another release or unknown legacy producer; the same verified release may relocate. Parent direct Node 18/24 runs each passed 139 job/log/artifact/preview tests, zero failures/skips. v2/v3/v4 migration invents no provenance. Full merged revalidation remains open. |
| 7: Queue/locks, unique terminal states, cancellation and disconnect | `src/jobs.ts`, `src/worker.ts`, lifecycle tests | Linux fixed workers and real supervised process trees passed the selected matrices below. Other hosts remain unimplemented. |
| 7: Server SIGKILL, worker crash, disk full, backpressure, startup cancellation | Job/process failure tests | Real Linux kill/EOF/crash/cancellation and write-failure injection covered. Full physical filesystem exhaustion/power-loss and every host/schedule are not established. |
| 7: Seven-day logs, 8 MiB/job, 256 MiB/workspace, continued draining and expired cursors | `src/jobs.ts`, `src/app.ts`, `test/job-logs.test.mjs` | 24 MiB stdout, 8 MiB log limit, 256 MiB eviction, expired cursors and 64-record admission preserving seven-day keys passed. Metadata and logs are separate. |
| 7: Validated staging, no overwrite, snapshot consistency, immutable artifacts | `src/workspace.ts`, `runtime/publish.c`, `test/publisher.test.mjs`, `test/jobs.test.mjs` | Fixed compiled descriptor-pinned helper replaces runtime Python. Real no-replace/EXDEV/ancestor/Unicode cases passed. Delivered files no longer expire with job metadata; rename and metadata remain separate crash outcomes. |
| 8, 11.1: Path/alias/race limits, secrets, authority boundaries | Workspace, preview and AI file-tool tests | Descriptor-pinned MCP paths and guarded client tools exist. AI alias/patch-destination failures reproduced and repaired; final integrated acceptance remains open. |
| 8: Preview only owned HTML5 artifacts on tokenized loopback, TTL/Host/Origin protection | `src/preview.ts`, `test/preview.test.mjs`, browser tests | Implemented. BILIBILI browser preview is rejected; final merged matrix open. |
| 9: Offline API, skills, valid references and real declaration examples | `src/api-index.ts`, `API-DOCS.md`, `skills/`, API/skill tests | Historical eight-profile index contains 13,792 API/member symbols and 16 template source examples. All-eight-variant example checks are completed in the [September checkpoint](#september-24-25-checkpoint); final candidate acceptance remains open. |
| 9, 11.2: Actual AI create/edit/error/fix/profile/build/preview/export loop | Installed client/model session plus deterministic replay | Open: retained OpenCode 1.18.21 `opencode/big-pickle` invocation received HTTP 403 `FreeTierError`, zero model text/tools; the gameplay prompt was not submitted. This is not success or proof all models are unavailable. Client tool smoke tests do not fulfill the demonstration. |
| 11.1: Offline, no source mount/cache/system tools, relocation, read-only SDK, non-admin | `build/portable-host-WU6Ruj/` and later candidate reports | Initial namespace workflow passed with real archive extraction, Unicode/space/long-path relocation, UID 1000, empty PATH, read-only kit and loopback-only network. This is explicitly not a new VM. |
| 11.1: Redistributable closure, licenses, SBOM, notices | `LICENSE`, dependency license files, external provenance, release inventory | Open: external license inventory and compiler/engine license metadata conflicts require review. Preserve notices; never invent a license grant. |
| 11.2: Real 2D/3D browser pixels, desktop/mobile input/layout, images/JSON/audio, failure and ten restarts | `test/browser-game.mjs`, `test/release-development.test.mjs`, namespace browser driver | Source release matrices passed both HTML5 cases and both BILIBILI builds. Package v5-a separately passed four edited HTML5 browser cases (2D/3D, debug/release) under namespace isolation, with release/profile identity assertions. Chromium/SwiftShader is not device or hardware-GPU proof. |
| 11.3: Source engine regression commands | Commands below; `build/engine-verification-20260919T032859Z-source-gates/` | All eleven commands exited 0 on that unchanged source snapshot, host Node 26.7.0. Re-run when relevant engine inputs change. |
| 11.4: Honest local/vendor/device/release support statements | CLI reports, README/MCP docs, release gates | Vendor compile/upload/device acceptance remains unverified and is not inferred from local builds. No release publication is authorized. |
| 12: Current progress and user documentation | `README.md`, `MCP.md`, plan progress section | Current [WeChat And ByteDance Delivery](#wechat-and-bytedance-delivery), with earlier checkpoints retained as historical. Retain full open scope. |

## Engine Gate Commands

These are real source-engine checks, not substitutes for portable game checks:

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
npm run build:dev
git diff --check
```

The referenced engine report records 29 platform tests passed, and 161 Jest
suites / 1,125 tests passed, with one skipped suite, two skipped tests and 16 todo
tests. The exact logs and fingerprints, not those historical counts, are evidence.

## Evidence Rules

Use `scripts/verify-tests.mjs` for retained selected/full devkit runs and inspect
the final `result.json`, TAP totals and before/after input hashes. Its initial
`state: running` response is not success. Explicit integration environment
variables make missing SDKs/runtimes fail instead of silently skipping them.

`build/matrix-node24-928Xj4/result.json` is a **failed** release integration:
7 tests, 4 passed, 3 failed, none cancelled/skipped, inputs unchanged. Historical
Node 18/24 interrupted matrices are not passes. Never overwrite these records or
use the SDK manifest's integrity status to imply all requirements above passed.
In particular, `build/matrix-node24-ktQbxU/result.json` retains `interrupted: true`,
exit 1, all totals `null`, `unchanged: true` and `success: false`. Do not reconstruct
passing totals from partial output. The preceding `build/matrix-node24-E9bbpP/`
failure (510 tests, 492 passed / 18 failed) remains separate and preserved.

## Current Evidence

### WeChat And ByteDance Delivery

September 30 runtime builds and October 1 SDK/candidate/2048 assembly are complete
at the local source-export level. This documentation update reads existing evidence;
it does not rerun tests/builds or modify generated artifacts. Initial devkit/2048
source work was committed as `8adf2bac99` before this implementation. The new
exporter work is currently uncommitted; the candidate records that base revision
with `source.dirty: true`, not a commit containing the exporter changes.

- `build/minigame-exporters-20260930/summary.json`: `success: true`, eight genuinely
  built WECHAT/BYTEDANCE runtimes, each with its own `2d-basic`/`3d-basic`,
  `debug`/`release` descriptor, receipt and hashed local report. Node 24.21.0;
  engine/game/loader type checks, engine builds, builtin integrity, module closure,
  canonical preflight and bootstrap/lifecycle/failure checks passed.
- Runtime outputs are under `build/minigame-exporters-20260930/<TARGET>/<profile>-<variant>/`;
  reports are in adjacent `<profile>-<variant>-local/local-report.json` paths.
  These use the actual target flags, `wx`/`tt` adapters and respective loaders,
  not renamed BILIBILI bundles. Local verification uses explicit host/`cc` mocks
  and static engine inspection, not engine execution or rendering. The original
  reports retain browser/vendor/device/portableSDK levels as false, including
  source-size warnings that are not vendor-compiled package sizes.
- `build/minigame-delivery/sdk-result.json`: `success: true`, 16 delivered profiles
  across HTML5, BILIBILI, WECHAT and BYTEDANCE, each 2D/3D and debug/release.
  `sdk-inputs.json` records reuse of the September HTML5/BILIBILI runtimes plus the
  eight new runtimes. SDK assembly does not upgrade headless local-host mocks to
  real-device proof or relabel the older runtime reports.

`build/minigame-delivery/portable-candidate.build.json`, the candidate's
`release.json` and `portable-candidate.tar.gz.sha256` record:

| Field | Retained Value |
| --- | --- |
| SDK | `build/minigame-delivery/sdk` |
| SDK ID | `sha256-6b8bc73d6195c460e0ad6b4f8d3c1815e497bc78719f0b3ca12d10fb988db55a` |
| Kit | `build/minigame-delivery/portable-candidate` |
| Release ID | `sha256-935bd43e3dd7346afb106cfc274d8e78a6075b8dead7873994545cc9852d432d` |
| Payload | 6,480 files; 353,639,177 bytes |
| Archive | `build/minigame-delivery/portable-candidate.tar.gz`; 86,428,350 bytes |
| Archive SHA-256 | `34412b3316b6b456a319ec13ab9a64613f801296283ac030b4ba4f601660a918` |
| Status | Linux x64 local candidate, bundled Node 24.21.0; `distributionApproved: false`, `host.verified: false`, dirty source |

`examples/2048/build/run-wechat-bytedance-01/evidence/result.json` records
`success: true`: packaged MCP strict game/logic type checks with library checks
enabled, **8 logic tests passed**, zero failed/skipped/TODOs, and both
WECHAT/BYTEDANCE `2d-basic/release` builds succeeded. `exports.json` records matching
release/SDK/profile provenance and both `copiedInventoryVerified: true` and
`platformConfigBytesVerified: true` for each export:

| Export | Path | Inventoried Files / Bytes |
| --- | --- | --- |
| WECHAT (`game.js`) | `examples/2048/build/run-wechat-bytedance-01/exports/wechat/` | 35 / 1,824,514 |
| BYTEDANCE (`game.js`) | `examples/2048/build/run-wechat-bytedance-01/exports/bytedance/` | 38 / 1,826,935 |

Project-owned `platforms/wechat/{game.json,project.config.json}` and
`platforms/bytedance/{game.json,project.config.json}` are copied verbatim to the
selected export root, not replaced with SDK validation metadata. This run uses
test IDs `wx0000000000000000` and `tt0000000000000000`; no real account was tested.
ALIPAY/OPPO still return `PROFILE_NOT_AVAILABLE`. HTML5 was not selected for export,
so `browser.performed: false`: no preview/browser run or new rendering evidence.
See the [2048 rerun command](examples/2048/README.md#wechat-and-bytedance-rerun)
for the new kit and a fresh, absent output directory. The older HTML5/BILIBILI
kit and `run-02` quick play remain valid for their own recorded identities.

Focused source results reported in the handoff are listed by known scope, not
reconstructed full invocations or a summed matrix total. These were not rerun here:

| Scope | Reported Result |
| --- | --- |
| Canonical preflight, `scripts/tests/minigame-package.test.cjs` (repository root) | 27 passed; previous-agent report |
| WeChat bootstrap, `test/wechat-runtime.test.mjs` | 26 passed; previous-agent report |
| ByteDance bootstrap, `test/bytedance-runtime.test.mjs` | 33 passed; previous-agent report |
| Production validation, `test/minigame-production.test.mjs` | 26 passed; parent report |
| SDK contracts, `test/minigame-sdk.test.mjs` | 11 passed after the real-report metric fix; parent report |
| Release-profile checks | 3 passed; selected scope only |
| Workspace worker regressions, `test/workspace.test.mjs` | 2 passed: real-worker doctor/preflight and typed argument/artifact/SDK-integrity errors; not the whole file |

`examples/2048/build/run-wechat-bytedance-01/evidence/entrypoints/result.json`
records four additional successful checks in one packaged MCP session: the real
WeChat and ByteDance starters create platform configs with blank app IDs and the
requested project names, and `cocos4_package_validate` accepts unchanged copies
of both exported packages with their target-specific preflight levels. Preview
and test-execution grants were disabled. The original 2048 source, exports,
registered artifacts and prior job records were verified unchanged; the session
closed normally. Commands, calls and before/after hashes are retained beside it.
The parent also ran the new kit's `cocos4 doctor` with empty `PATH` and no `HOME`;
it exited 0 with `scope: "sdk-only"`, matching the release/SDK identities above.
That direct terminal result is not a new browser or vendor check.

There is no new full matrix, real-model, vendor build,
upload, media/device or hardware-rendering acceptance. The adapter package
`@cocos/engine-platforms@1.0.6` retains its `UNLICENSED` metadata/README; retaining
those and engine notices grants no redistribution rights. Clean-source,
authenticated-release, licensing, fresh-VM and multi-host gates remain open.

### Packaged 2048 Check

Historical September 26 focused deliverable, using the then-fresh Linux x64 candidate
`examples/2048/build/portable-candidate` with bundled Node 24.21.0.
The [assembly audit](examples/2048/build/assembly.audit.json) records unchanged
SDK inputs and an exact source/delivered/manifest match for `verify-portable.mjs`.

| Field | Retained Value |
| --- | --- |
| Release ID | `sha256-278e9f0c92dd25166a904515a18bf4f032fadb058ada4cc6a6948bc09894a835` |
| SDK ID (unchanged) | `sha256-c29f715f9e9a2f07e93acb8032192f74821b01b38546301a3e784f2977114246` |
| Archive | `examples/2048/build/portable-candidate.tar.gz`; 76,204,967 bytes |
| Archive SHA-256 | `9da6e5d9d82a68a6b7cc6e8db8a0f40c32dce1b1abc4d3703d5ae40c11d1b450` |

That candidate superseded the earlier "not rebuilt" status at this checkpoint.
The engine/SDK was not rebuilt; no older matrix, startup or namespace passes
transfer to it. This remains the old HTML5/BILIBILI-only pack, not the new
four-target candidate above.

- [SDK-only doctor](examples/2048/build/doctor.result.json): exit 0, `success: true`,
  offline with empty PATH and no workspace/HOME/state, as recorded in its
  [command](examples/2048/build/doctor.command.json).
- [run-02](examples/2048/build/run-02/evidence/result.json): `success: true`, strict
  types with library checks enabled and **8/8 logic tests passed**, zero failures,
  skips or TODOs. [Exports](examples/2048/build/run-02/evidence/exports.json) record
  hash-verified `HTML5` and `BILIBILI` `2d-basic/release` outputs with matching
  release/SDK/profile provenance and `copiedInventoryVerified: true`.
- [HTML5 browser smoke](examples/2048/build/run-02/evidence/browser/browser-smoke.json):
  Chromium 151.0.7922.34 / SwiftShader, actual desktop `960x800` keyboard/mouse
  and mobile-emulated `390x844` swipe/tap passed. Best-preserving restarts passed
  (two desktop, one touch), as did both layouts/board-pixel checks and desktop
  best/save persistence across reload. `errors: []`; six hash-recorded screenshots
  are retained beside the report. Browser/drivers are separate maintainer inputs.
- `WECHAT`, `BYTEDANCE`, `ALIPAY` and `OPPO` build requests explicitly returned
  `PROFILE_NOT_AVAILABLE`; no fake platform packages were emitted. BILIBILI is
  source-package preflight only; test appId `TEST_ONLY_2048_LOCAL` is not publishable.

The [run-01 browser failure](examples/2048/build/run-01/evidence/browser/browser-smoke.json)
remains failed: the `GraphicsComponent` optional-assembler alias issue
(`getAssembler` on null). The sample switched to public `Texture2D` + `Sprite`,
not an engine/SDK fix.

At that checkpoint, only this focused deliverable was complete. No full matrix, new model request,
vendor or device test was performed for this check; browser win/game-over checks
are out of scope. The dirty-source candidate is `distributionApproved: false`;
licensing, formal release/authentication, clean-VM/multi-host, real-model and
device gates remain open.

### September 24-25 Checkpoint

Historical evidence, retained for the September 25 candidate:

`build/current-release-20260924-kLvvst/sdk-identities.json` and
`build/current-release-20260924-kLvvst/continuation-09mrXa/candidate.json` record:

| Field | Retained Value |
| --- | --- |
| Eight-profile SDK | `build/current-release-20260924-kLvvst/combined-sdk` |
| SDK ID | `sha256-c29f715f9e9a2f07e93acb8032192f74821b01b38546301a3e784f2977114246` |
| September 25 candidate | `build/current-release-20260924-kLvvst/continuation-09mrXa/portable-candidate` |
| Release ID | `sha256-876efa015180852b72e292e3cd7ab41bd7b665a73b2bccb671d62e939253e659` |
| Payload / archive | 6,023 files; 297,686,904 payload bytes; 76,204,741 archive bytes |
| Archive SHA-256 | `c852c1fb86b36922ec1cf4891f0c06f3aa79a004f40dfe8b70f019b13ff5a080` |
| Release status | Local candidate; dirty source, `distributionApproved: false` |

The continuation's `reused-inputs.json` records unchanged eight-profile runtime/SDK
inputs and fresh candidate assembly with the variant-aware skill payload.
Its candidate step completed on September 25 at 03:09 UTC. This is a distinct
candidate, not a relabeling of v5-a; the older startup/namespace evidence below
does not transfer to it. Clean-source provenance, authentication and release
acceptance remain open.

`build/ai-skill-variants-20260925-r1/summary.json`, with each runtime's `test.tap`
and `skills-types-evidence.json`, records **5/5 passed on Node 18.20.8 and 5/5 on
Node 24.21.0**, zero failures/skips/cancellations and unchanged inputs. The checks
cover all eight target/profile/variant combinations, invalid/unavailable variants
and an introduced type error using real declarations/profile exports. This is
deterministic skill checking, not model, game-runtime or candidate acceptance.
That task's `candidateRebuilt: false` remains historical; the subsequent
`continuation-09mrXa` assembly above includes the updated skill payload.

The latest retained Node 18 matrix, `build/matrix-node18-iIgM7E/result.json`, ended
on September 25 at 04:29:31.663 UTC: exit 1, `interrupted: true`, trigger `SIGTERM`,
all six totals `null`, `completeTotals: false`, `unchanged: true`, and both
`success` and `fullSuccess` false. Its `command.json` selects the SDK/candidate
above. The continuation's stale `status.json` phase `matrix-node18` is not evidence
of an ongoing run; the terminal result takes precedence. No current full Node
18/24 pass is established. Retained partial failures in `test.log` remain evidence,
not complete totals or proof of fixes.

### September 26 Focused Verification

Source changes select the eight-profile AI SDK, preserve the optional AI evidence
directory, recheck interruption before spawning a stage and publishing final
results, and give interruption precedence over success. Result/receipt staging
is followed by synchronous promotion; it is not a crash-atomic two-file transaction.
Portable job polling now follows the returned, immutable job deadline with a
30-second cleanup allowance instead of an unrelated four-minute limit. Release
identity and terminal/report failure assertions remain intact.

A single Node 18.20.8 `loadSdk` observation on the SDK above, with a 512 MiB
old-space limit, succeeded in 44.465 seconds. This is main-process SDK validation,
not worker/compilation timing. The development harness's compiler-start and new-CLI
preview waits now use their existing 120-second default instead of 30 seconds;
production deadlines and integrity checks are unchanged. That integration suite
was not rerun, so its longer parent/CLI/preparer budget findings remain unresolved.

Direct parent-observed commands from the repository root:

```sh
TMPDIR=/tmp/opencode timeout --signal=TERM --kill-after=5s 115s tools/devkit/build/node18/package/bin/node --test --test-reporter=tap --test-concurrency=1 tools/devkit/test/portable-workflow.test.mjs tools/devkit/test/host-requirements.test.mjs tools/devkit/test/verification-inputs.test.mjs tools/devkit/test/verification-runner.test.mjs
TMPDIR=/tmp/opencode timeout --signal=TERM --kill-after=5s 115s tools/devkit/build/node18/package/bin/node --test --test-reporter=tap tools/devkit/test/verification-runner.test.mjs
tools/devkit/build/node18/package/bin/node tools/devkit/node_modules/typescript/bin/tsc --noEmit --project tools/devkit/tsconfig.json
tools/devkit/build/node18/package/bin/node --check tools/devkit/test/development.test.mjs
git diff --check
```

- The first command exited 1: 31 tests, 29 passed and 2 failed (the runner's SIGTERM
  child and enclosing test), no skips/cancellations/TODOs, 39.159 seconds. All 21
  input/host/polling checks passed. The runner polled a partially written readiness
  JSON file, not a failed SDK/game operation.
- The fixture now writes its readiness JSON to a sibling temporary file and
  renames it only after writing completes; JSON parse errors are not suppressed.
  Only that runner file was retried: exit 0, 10/10 passed, no
  skips/cancellations/TODOs, 31.046 seconds. No combined/full matrix was rerun.
- Devkit TypeScript `--noEmit`, development-harness syntax and whitespace checks
  passed. The new polling regressions first reproduced three failures against the
  old fixed-limit implementation, then all six passed after the fix.
- Runner-only records from both attempts are retained in
  `build/retained-verification-runner-node18-20260926.tar.gz`, SHA-256
  `2e179ec093877cef3fb964483a62a537ab9df4abdaf3066f22fc5d71edcb6f9a`.
  The archive contains `verification-runner-node18-pLmOr4` (failed attempt) and
  `verification-runner-node18-19Q5Jm` (successful retry), including fixture logs,
  hashes and process observations. These are not SDK/candidate input fingerprints
  or a newly fabricated full-suite result. No matching fixture processes remained.

No engine/SDK build, full matrix, model request or browser/vendor/device run was
performed for these fixes. The September 25 candidate was preserved and does not
contain the updated bundled `verify-portable.mjs`; these source results do not
transfer to that candidate. Clean provisioning and actual signal/crash timing at
the final receipt publication boundary remain unverified.

### Retained v5 Candidate

Historical September 22 evidence, preserved for its own candidate only:

`build/portable-candidate-20260922-v5-a.build.json`, the candidate's `release.json`
and its `.tar.gz.sha256` receipt record:

| Field | Retained Value |
| --- | --- |
| Candidate | `build/portable-candidate-20260922-v5-a` |
| Release ID | `sha256-44a4eca9d05bdaf38da2b859fecb6d68674a470ddcaf5d5ab04074839e47aab1` |
| SDK ID | `sha256-68bbd6aa9b7e56f9d22c61a35541d8f5113c8d7920cac9033a5382f40a720a28` |
| Payload | 6,037 files; 300,964,724 bytes |
| Archive | `build/portable-candidate-20260922-v5-a.tar.gz`; 76,394,705 bytes |
| Archive SHA-256 | `e091b23a2e3b522445b3e5e0971509678f2011ce7ac8e667a74cd6fa00406b04` |
| Release status | Local candidate; `distributionApproved: false`, `source.dirty: true` |

- Startup/archive: `build/matrix-node24-93jqOD/result.json`, Node 24.21.0, exit 0,
  34 passed, zero failed/skipped/cancelled/todo, `interrupted: false`, complete
  totals and `unchanged: true`. `command.json` selects portable-startup,
  portable-manifest and the fixed MCP probes against v5-a. Its `success: true`
  and `fullSuccess: false` mean selected verification only, not a full matrix pass.
- Namespace/browser: `build/portable-host-bAPi9z/result.json`, exit 0, no
  interruption, `success: true`, bound to the exact release/SDK/archive above.
  `isolated/workflow/report.json` retains eight actual builds and four successful
  HTML5 browser reports, with matching job release IDs and artifact profile SHA-256
  assertions. Payload/archive identity was rechecked. Browser/driver mounts are
  explicit test inputs (Playwright Core 1.58.2, pngjs 6.0.0), not kit dependencies.
  This is non-admin Linux namespace evidence, not a fresh VM, another OS, a model
  workflow, vendor compilation or device/hardware-GPU acceptance.

New jobs use the executing application's verified `releaseId`; unpackaged source
tools use `null`. New artifact receipts/inventories record
`provenance: { releaseId, profileSha256 }` against the actual selected profile
descriptor. SDK-scoped output ownership survives seven-day job/log/key expiry and
keeps its original producer even when another release opens that SDK's state.
Valid v2/v3/v4 imports preserve known ownership, without inventing absent release
or profile provenance. A legacy job's default null ID does not establish its
producer; missing artifact provenance stays missing. New packaged keys never
reuse another release or unknown legacy producer, while the same verified release
can relocate with the same workspace/state and normalized arguments.

### Parent Direct Tests

These are parent-reported terminal command results, not fabricated retained
`result.json` reports and not reruns by this documentation task:

- Node 18.20.8 and 24.21.0: `node --test test/artifact-lifecycle.test.mjs test/jobs.test.mjs test/job-logs.test.mjs test/preview.test.mjs`,
  139 passed each, zero failed/skipped. This includes v5 lifecycle/migration and
  release-aware request-key behavior; the historical 136-test reports below remain historical.
- Node 24.21.0: `node --test test/game.test.mjs`, 49 passed, including actual
  selected-profile SHA-256 in receipt/inventory and rejection of a mismatched
  producing release before publication. The injected release ID in this direct
  compiler regression is not publisher authentication; packaged identity is
  separately asserted by the retained namespace workflow.
- Node 18.20.8 and 24.21.0: `node --test test/verification-inputs.test.mjs`, six
  passed per runtime. New CI prerequisites cover host probes, reviewed Node archive
  validation, mandatory real integration inputs, clean/offline assembly wiring
  and rejection of incomplete/failing/skipped TAP totals. No clean-checkout or
  hosted provisioner rehearsal has been performed; these are orchestration tests.

### Real Model Attempt

`build/ai-model-20260921-7Qm4waaE/REPORT.md` and `audit.redacted.json` retain one
actual OpenCode 1.18.21 invocation of `opencode/big-pickle` using historical
candidate e. It received HTTP 403, non-retryable `APIError` / `FreeTierError`, with
zero model text and zero tool-use events. The provider's message is not evidence
that a different client was used. The connectivity gate failed, so the gameplay
prompt was not submitted; no model-created game, job or artifact exists.
No retry, provider substitution or simulated response was used. This concrete
failure does not establish that all models are unavailable. Real-model gameplay
acceptance, including the [current candidate](#wechat-and-bytedance-delivery), remains open.

The later `build/ai-connectivity-research-20260924-e66eX2hg/REPORT.md` records
model discovery only: zero model requests/tools and no established selected
default. A user-selected provider/model and an approved existing-auth route
compatible with the isolated launcher are still needed. Listing models proves
neither connectivity nor gameplay acceptance.

### Historical Evidence

- Node 18 logic/lifecycle: `build/logic-lifetime-node18-4qoBo5/source/build/matrix-node18-opMcuq/result.json`, 35/35, no skips/cancellations, input hashes unchanged.
- Node 24 logic/lifecycle: `build/logic-lifetime-node24-sT9wFv/source/build/matrix-node24-GrcSy3/result.json`, same totals and integrity checks.
- Node 18 release-development: `build/logic-lifetime-node18-4qoBo5/source/build/matrix-node18-22Yagl/result.json`, 7/7 including four target/profile cases and two official SDK probes, no skips/cancellations, inputs unchanged.
- Node 24 release-development: `build/logic-lifetime-node24-sT9wFv/source/build/matrix-node24-FoIGCO/result.json`, same coverage. These frozen snapshots predate the artifact-expiry fix, so they do not replace the final merged matrix.
- Earlier direct `node --test test/jobs.test.mjs`: Node 18.20.8 and 24.21.0, 31/31 each. The new expiry regression first reproduced deletion against the old build, then passed after rebuilding. Older test assumptions were updated to required keys and separate 8 MiB logs, not by weakening the implementation.
- Earlier direct `node --test test/portable-manifest.test.mjs`: two tests per runtime. A real long-path archive regression first exposed staging paths in GNU tar PAX header names, then passed with fixed header names; existing archives are never overwritten.
- First candidate workflow: `build/portable-host-WU6Ruj/result.json`, exit 0, `success: true`; inspect `isolated/isolation.json`, `isolated/workflow/report.json`, archive identity and namespace arguments for actual scope. Candidate a predates the later SPDX corrections and artifact-expiry fix.
- Candidates `build/portable-candidate-20260921-e` and `build/portable-candidate-20260921-f`: independently assembled 6,034-file payloads, 300,927,374 bytes each. Release ID `sha256-0f5335052f3dde9c4f05f07e8b0b85a34d6430fefdb946736bcc7b0f80de07b7`; both 76,380,308-byte archives have SHA-256 `0a5e0439101bf4c49f54f6748258bf063be6f6e46c7232de7db03e8047f1186a`. Both explicitly remain unapproved local candidates.
- Preserve failed candidate b staging `build/.cocos4-release-2dTzZu`, unequal c/d archive receipts and failed browser-harness run `build/portable-host-Ivx5we/`. They exposed missing undici notice metadata, PAX nondeterminism and an incorrect harness dependency location; they are not successful runs.
- Package e browser workflow: `build/portable-host-SXR2mN/result.json`, exit 0, no interruption, `success: true`. Its retained `isolated/workflow/report.json` covers eight builds and four successful browser reports with screenshot/asset/artifact hashes. Driver versions are Playwright Core 1.58.2 and pngjs 6.0.0; they are a separate test harness, not hidden kit dependencies. Read-only payload and archive identities were rechecked afterward.
- Merged Node 24 `build/matrix-node24-E9bbpP/result.json`: exit 1, 510 tests, 492 passed / 18 failed, none skipped/cancelled, inputs unchanged. Failures covered API/profile fixture assumptions, artifact lifetime, old-vs-new compiler SDK digest comparison, development startup, and absent `RUNTIME_BUILTINS_2D`/`RUNTIME_BUILTINS_3D` inputs. This report is preserved, not a pass.
- API/docs and SDK preparation fixes: Node 18 `build/matrix-node18-l1AgLg/` / `build/matrix-node18-Ux476C/`, Node 24 `build/matrix-node24-QNHfLt/` / `build/matrix-node24-ROpeOt/`. Each passed 19 tests with four-profile and eight-profile SDKs respectively, no skips/cancellations and unchanged inputs. Reproducibility now compares fresh same-input generations, not a retained SDK containing an older compiler.
- Development fixes: `build/matrix-node18-BsAjpG/` and `build/matrix-node24-vG7zIl/`, each 14 passed with no skips/cancellations and unchanged inputs, including real edited 2D/3D browser checks. The stale Xauthority and early-failure cleanup issues were diagnosed without weakening browser assertions. These runs precede metadata v4.
- Metadata v4 regression: the previous build reproduced all eight lifecycle failures in `build/matrix-node24-shjE0W/`. After the implementation and fixture deadline correction, `build/matrix-node18-jVwvnM/` and `build/matrix-node24-UJENF7/` each passed 136 job/log/artifact/preview tests including the two fixed MCP probes, no skips/cancellations and unchanged inputs. Delivered files are never auto-deleted; absent-output quota reconciliation cannot re-adopt directories from old job reports.
- Full merged Node 18/24 acceptance remains open; the later retained v5 package checks above do not close it. The verifier forwards both builtin input variables. The verified inputs are `effects/build/artifact-hJGwrf` (2D, report SHA-256 `2a198be50f31b1c297857ff769efd26a7ed9848e6770ede4f92ade4b92b81a94`) and `effects/build/artifact-5flSlp` (3D, `94fa68345a89ff886ad1dc0092d6b51cdc9af1a106355a2a60c3fd1d38f032d0`); the read-only builtin validator accepted both. This is not a new shader compilation.

### Archived Agent Evidence

Historical agent temporary evidence is retained in these `build/` archives. The
SHA-256 values below are the archival handoff values; this documentation update
does not rerun or upgrade the enclosed evidence. Archives are retention, not new
tests or proof of the current full matrices.

| Archive | SHA-256 |
| --- | --- |
| `build/retained-cocos4-ai-focused-YudAD6.tar.gz` | `4c4e2b5c60a7bedb74bb9708f084ca5a2a49b93d487c43ecc1d4e3de86e35a85` |
| `build/retained-cocos4-ai-focused-p6Vx2l.tar.gz` | `ee58d18a6bef87ee7327dcd06f58ff167673a45e4a20d040fbfab693d93eec5b` |
| `build/retained-cocos4-doctor-evidence-pzatp9.tar.gz` | `375339f8d1e07047026c30245f749a08f9baa76e90234bf98e6631f4aa52ef18` |
| `build/retained-verification-runner-node18-bEZxLV.tar.gz` | `09bc9aa2cb918ea4809fe935948072dfa591c07989d92983bfc63158f96033f0` |
| `build/retained-verification-runner-node24-0l2ovC.tar.gz` | `fa7ec01d24e60d3fde71b3f9ebad27e377667515868d84952b9ebae1e6d6e372` |

## Remaining Gates

- Full merged Node 18/24 acceptance remains open; the latest Node 18 run ended
  interrupted, not still running. Selected passes cannot replace complete totals
  and unchanged input fingerprints. This gate does not authorize further full runs.
- Clean-checkout and hosted CI provisioner rehearsals remain unperformed. The new
  six-test prerequisite checks do not prove the complete provisioning pipeline.
- Clean end-to-end source/profile/dependency provenance, authenticated release
  signatures or build attestations, and redistribution/license clearance remain
  open. The [current candidate](#wechat-and-bytedance-delivery) is dirty-source, locally assembled and unapproved.
- Fresh-VM/no-cache acceptance and actual supported-host Linux/Windows/macOS
  verification remain open; namespaces and cross-version Node tests do not close
  those gates. Other-host process supervision is not implemented/accepted.
- A real-model create/edit/error/fix/profile/build/preview/export gameplay loop
  remains unexecuted. The observed 403 blocks that attempt, not all future models.
- Vendor compilation, upload, devices and hardware-GPU validation remain
  unverified. Local BILIBILI/WECHAT/BYTEDANCE source preflight, host mocks and software
  browser rendering do not establish those results. Physical disk-full/power-loss
  durability and the full cross-host failure matrix also remain open as listed above.

The full plan and its P0-P6 exit requirements remain in force; this ledger does
not shrink the contract or mark the complete kit finished.

Package inventories now validate SPDX file coverage, notice references and locked
archive checksums separately from package.json hashes. Host typings and the frozen
OpenCode schema are recorded components. Missing notices and engine/loader/Effect/
external licensing conflicts are still explicit blockers, not grants inferred
from metadata. Local reproducibility is not a clean-source build or authenticated
release, and the candidate generator does not implement official approval.
