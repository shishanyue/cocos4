# Development MCP And CLI

This is a **Linux and Windows development implementation**, not the complete portable game
SDK in the [plan](../../docs/plans/cocos4-mcp-devkit.md). The official MCP SDK serves
10 tools by default in read-only mode, 13 with `--mode develop`, and 15 with
`--mode develop --preview true`. Permissions are startup settings, not tool inputs.

A verified development pack enumerates its delivered HTML5/BILIBILI/WECHAT/BYTEDANCE,
2D/3D and debug/release profiles, editable starters and a self-contained game compiler. Develop mode
enables project creation, strict type checks and compilation of current game
sources; separate preview permission enables loopback serving of retained build
artifacts. Project scripts and plugins are never implicitly executed. Pure logic
tests require an additional startup grant, `--execute-tests true`, in develop mode.
This runs trusted project code, not a sandbox, and is separate from rendering tests.
The server does not prepare the engine, import arbitrary Creator assets, perform
vendor compilation, upload packages, or change AI configuration. Mini-game builds
assemble source packages and perform static closure/canonical preflight, not device
execution. Indexed packs also provide [API and template-source documents](API-DOCS.md).
Opening a preview in a browser runs the emitted game in that browser; merely
building or serving it is not browser, interaction or device acceptance.
All four source exporters are implemented, but a target is available only when
the selected SDK delivers its profile. Legacy eight-profile HTML5/BILIBILI SDKs
remain valid. A four-target 16-profile SDK and Windows run7 candidate have been
assembled. Run7's local package workflow passed sixteen edited game exports in
two independent workspaces and four actual HTML5 browser cases. Exact identity,
download, D-drive checks and remaining gates are in
[Windows Local Delivery](ACCEPTANCE.md#windows-local-delivery-october-10).
The current Codex Signal Switch loop passed through the packaged CLI; it did not
install or discover a Codex MCP connector or accept the OpenCode/provider route.

## Prepare And Start

Maintainer preparation, from the repository root:

```sh
npm ci --prefix tools/devkit --ignore-scripts --engine-strict --no-audit --no-fund
npm run build --prefix tools/devkit
npm run prepare:sdk --prefix tools/devkit -- --out "$PWD/tools/devkit/build/readonly-sdk"
```

The output directory must not exist, even if empty. Readonly-pack preparation
uses only selected source/configuration files and the pinned JSON5 parser. No engine
dependencies, engine build or external assets are needed. Installation is the
explicit network-using step; preparation and runtime do not download anything.

Maintainer SDK preparation uses Linux `/usr/bin/python3` and
libc/kernel support for `renameat2(RENAME_NOREPLACE)`, or the verified Windows
publisher helper on Windows. Installed game/project
publication instead uses the fixed compiled `cocos4-publish` host helper, built
by `npm run build:host` and included in portable candidates. It receives pinned
descriptor chains, an empty environment and a five-second timeout. It has no
shell, caller-selected executable, check-then-rename or copy fallback.
Staging and destination must be on the same filesystem; the destination's parent
must already exist and be canonical. Python is not an installed game-workflow dependency.
The prepared pack contains a manifest, source-derived catalog, selected guide
excerpts, the canonical BILIBILI validator, shared WECHAT/BYTEDANCE source validator
and license material. Hashes establish integrity, not source authenticity or
redistribution clearance.

To prepare the development pack, first produce verified 2D/3D runtime artifacts
and their hash-bound browser reports using the separate
[runtime pipeline](runtime/README.md). Then, with the locked compiler dependencies
available on the trusted maintainer checkout:

```sh
node tools/devkit/scripts/prepare-game-sdk.mjs \
  --base /absolute/path/to/readonly-sdk \
  --runtime /absolute/path/to/acceptance/2d-basic \
  --runtime /absolute/path/to/acceptance/3d-basic \
  --out /absolute/path/to/game-sdk
```

By default each browser report is the sibling
`<runtime>-browser/browser-report.json`; `--browser-report` can specify both
explicitly, in runtime order. Preparation verifies existing runtime evidence and
packages the two compiler sources plus their lock-checked dependency closure
(84 packages in the current pack). It does not generate new browser evidence.
This inner SDK does not bundle Node. The separate candidate generator below wraps
it with Node and the application without changing its SDK identity; neither is
automatically cleared for redistribution.

Maintainer-only Linux x64 candidate assembly and retained namespace verification:

```sh
npm run prepare:release --prefix tools/devkit -- \
  --sdk-root /absolute/path/to/verified-game-sdk \
  --node-archive /absolute/path/to/node-v24.21.0-linux-x64.tar.xz \
  --out /absolute/path/to/new-candidate
npm run verify:portable --prefix tools/devkit -- \
  --release /absolute/path/to/new-candidate \
  --browser /absolute/path/to/chromium
```

The Node archive must match `packaging/node-lock.json`; nothing is downloaded or
installed by assembly. Read [candidate instructions](packaging/README.md) and the
[acceptance checklist](ACCEPTANCE.md). Namespace verification requires maintainer
`bwrap`/`tar` and explicit browser test drivers; these are not installed kit
dependencies. Its running receipt is not a pass, and namespaces are not a new VM.

On a Windows x64 maintainer host, use the reviewed Windows archive instead:

```powershell
npm run prepare:release --prefix tools/devkit -- --target win32-x64 --sdk-root 'D:\cocos4-work\verified-game-sdk' --node-archive 'D:\cocos4-work\node-v24.21.0-win-x64.zip' --out 'D:\cocos4-work\new-candidate'
npm run verify:portable --prefix tools/devkit -- --release 'D:\cocos4-work\new-candidate' --browser 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

Windows assembly uses `packaging/node-win32-lock.json`, an installed MSVC/Windows
SDK (or an explicitly selected supported compiler), and private local output
directories. Installed kits need none of those build tools. Windows verification
extracts and relocates the ZIP and uses the bundled runtime with empty PATH; it
does not provide Linux namespaces, a fresh VM, or network isolation. Its report
records those limits and the actual browser/workflow results.

Use the selected protected private task subtree for SDK, workspace, explicit
state, configured TEMP and browser profiles. Fixed-volume roots have a separate
ancestor ACL rule; ordinary shared writable ancestors, hostile ACLs and linked
paths remain rejected. Do not create task fixtures at a drive root or in the
user home. The run7 D-drive checks passed on Node 18.20.8 and 24.21.0. Its sixteen
game exports and four browser cases were then verified independently from the
interrupted source matrix and partial run6 builds. The package evidence uses
two target-group workspaces, with `freshFullSingleRun: false`.
OpenCode remains an optional reference adapter;
its Windows read-only-DACL loader workflow is still unaccepted.

To include BILIBILI, WECHAT or BYTEDANCE, add genuine runtime directories with
further `--runtime` arguments, both 2D/3D for each included target/variant. They
require sibling `<runtime>-local/local-report.json` reports, or `--local-report`
arguments ordered across all mini-game runtimes. These explicitly use a mock
host/engine boundary, not browser/device evidence. HTML5 still requires its browser
reports. WECHAT/BYTEDANCE need a newly prepared readonly base containing
`app/validate-minigame.cjs`; do not patch an old SDK in place. Candidate assembly
accepts legacy eight-profile kits and requires a complete 2D/3D debug/release set
for every added target. Keep sources in this project and retained packs and
evidence under ignored `tools/devkit/build/`, not only in system temporary storage.

### Portable Commands

From the extracted candidate, not the source checkout:

```sh
./cocos4 doctor
./cocos4 doctor --workspace /absolute/path/to/games --state-root /absolute/path/to/private-cocos4-state
./cocos4 ai --client opencode --executable /absolute/path/to/opencode \
  --workspace /absolute/path/to/games --mode develop --preview true
./cocos4 mcp --workspace /absolute/path/to/games --mode read-only
```

Without `--workspace`, portable `doctor` verifies the release inventory, SDK and
host read capabilities only. It needs no workspace, `HOME`, `XDG_STATE_HOME` or
private state, does not inspect the current directory as a project, and emits one
JSON object with `scope: "sdk-only"`, `releaseId`, `sdkId` and a report. It does not
check or launch an AI client, run project code, or establish browser/device support.
It rejects `--state-root` and execution grants unless a workspace is explicit.
With `--workspace`, doctor retains the shared worker/job flow and private state.
Other portable commands need an external workspace; default state is
`$XDG_STATE_HOME/cocos4` or `$HOME/.local/state/cocos4` on Linux;
Windows uses `%LOCALAPPDATA%\cocos4` or `%USERPROFILE%\AppData\Local\cocos4`.
Both are overridable with `--state-root`. Use `cocos4.exe` on Windows.
The portable launcher fixes the SDK to its release and rejects `--sdk-root`.
Portable `ai` requires `--executable` for an already installed supported OpenCode;
it neither searches PATH nor installs a client.

OpenCode is an optional reference adapter, not a dependency of the CLI or stdio
MCP server. Compatible clients can connect directly to `cocos4.exe mcp` on
Windows. Current OpenCode 1.18.21 / Bun 1.3.14 Windows checks establish MCP
connection and skill discovery, but its code loader rejects the read-only
guarded tool module. That AI workflow remains unaccepted; its file ACL protection
is retained. See the acceptance ledger for the exact client evidence.

The AI-spawned MCP uses the shipped Linux x64 `cocos4-mcp-launch` helper with
`static-no-libc` linkage, no ELF interpreter and no shared libraries. It constructs
the fixed MCP invocation and clean environment before Node starts, eliminating
the runtime `/usr/bin/env` dependency and any host-env fallback. This does not
make Node or the other helpers libc-free. The separate OpenCode/provider
authentication environment is preserved as before; provider credentials are not
forwarded to MCP. Existing client config, plugins and stored credentials are not
imported. No global client configuration is changed.

Windows ships `cocos4-mcp-launch.exe` for the same fixed invocation and clean
environment contract, with PE validation and protected file handles. The host
process supervisor uses Windows Job Objects and process creation times.

### Source Commands

Start source-mode stdio with an MCP client, using **absolute paths** for all roots
and the chosen Node executable. The workspace must already exist. The private
state directory may be absent and will be created with restricted permissions.

```sh
/absolute/path/to/node /absolute/path/to/tools/devkit/build/src/cli.js mcp \
  --sdk-root /absolute/path/to/readonly-sdk \
  --workspace /absolute/path/to/games \
  --state-root /absolute/path/to/private-cocos4-state \
  --mode read-only
```

For game operations, select the development pack and `--mode develop`. Add
`--preview true` only when loopback serving is intended. Preview permission without
develop mode is rejected. Registration follows these permissions; requests still
fail if the selected SDK does not deliver the requested template/profile/variant.

Workspace, SDK and state must be disjoint, not ancestors of one another. Do not
authorize the engine repository as the workspace if it contains your prepared
SDK. SDK and state paths must not contain symlinks; the explicitly selected
workspace root is canonicalized, but descendant symlinks are rejected.

For clients other than OpenCode, use the same executable and argument array in
their stdio configuration. Do not launch through `npm start`: npm banners can
pollute protocol stdout. No client or global configuration is written by these
commands. Actual OpenCode tool checks are distinct from model acceptance. The
retained OpenCode 1.18.21 `opencode/big-pickle` attempt received HTTP 403
`FreeTierError`, with no model text or tool calls; it is neither a successful
gameplay session nor evidence that every model is unavailable. See [acceptance](ACCEPTANCE.md).

The source CLI shares exactly the same schemas and application operations,
including the workspace-bound doctor job (not the portable SDK-only shortcut):

```sh
node tools/devkit/build/src/cli.js doctor \
  --sdk-root /absolute/path/to/readonly-sdk \
  --workspace /absolute/path/to/games \
  --state-root /absolute/path/to/private-cocos4-state

node tools/devkit/build/src/cli.js call cocos4_package_validate \
  --input '{"target":"BILIBILI","directory":"my-game-output"}' \
  --sdk-root /absolute/path/to/readonly-sdk \
  --workspace /absolute/path/to/games \
  --state-root /absolute/path/to/private-cocos4-state
```

`tools` prints the actual mode-dependent input/output schemas. For example:

```sh
node tools/devkit/build/src/cli.js call cocos4_project_create \
   --input '{"directory":"my-game","templateId":"2d-basic-starter","projectName":"my-game","requestKey":"create-my-game-1"}' \
  --sdk-root /absolute/path/to/game-sdk \
  --workspace /absolute/path/to/games \
  --state-root /absolute/path/to/private-cocos4-state \
  --mode develop
```

`call` waits for job completion and emits all pages as **NDJSON**, one envelope
per line. Session-bound cursors are
consumed before the CLI exits; they cannot be reused in another invocation.
Failed operations or failed doctor checks produce a nonzero CLI exit status.
For `cocos4_preview_start`, the CLI first emits the ready job with its tokenized
URL and stays alive until TTL or shutdown. Exiting the process closes the preview.
The MCP transport remains stdio; the preview HTTP listener is not an MCP endpoint.

## Available Tools

| Tool | Actual behavior |
| --- | --- |
| `cocos4_catalog` | Manifest-derived SDK/platform/features; readonly packs have no profiles/templates, development packs enumerate delivered combinations |
| `cocos4_docs_search` | Literal guide/API/template-source search; API/examples require a verified declaration-driven index, with profile linkage |
| `cocos4_docs_read` | Versioned document text and source anchors, UTF-8-safe pagination; no arbitrary file paths |
| `cocos4_project_inspect` | Bounded data-only inspection of configuration, entry and unsupported inputs |
| `cocos4_doctor` | Worker job rechecking pack integrity and optional bounded project data; no repair |
| `cocos4_package_validate` | Worker job applying the SDK's canonical BILIBILI/WECHAT/BYTEDANCE source validator to a private snapshot; requires its advertised `packageValidation` capability, not a game profile |
| `cocos4_jobs_list` | SDK/workspace-scoped retained job summaries |
| `cocos4_job_get` | Job state and paginated report |
| `cocos4_job_logs` | Bounded, redacted, paginated logs |
| `cocos4_job_cancel` | Cancellation by owned job ID; terminal cancellation is idempotent |

Develop mode adds these three tools. All listed inputs without `?` are required;
paths are relative to the authorized workspace.

| Tool | Input | Actual behavior |
| --- | --- | --- |
| `cocos4_project_create` | `directory`, `templateId`, `projectName`, `requestKey` | Prepare an editable verified starter, local SDK declarations and package name; parent atomically creates only an absent destination |
| `cocos4_project_check` | `project`, `target`, `profile`, `checks`, `requestKey`, `timeoutMs?` | Strict type/linkage checks and, when separately authorized, supervised pure logic tests; checks is a nonempty unique array of `types` and/or `logic` |
| `cocos4_game_build` | `project`, `target`, `profile`, `variant`, `requestKey`, `timeoutMs?` | Compile the current private source snapshot, assemble necessary runtime files and standard assets, and register an inventoried private artifact |

`directory`/`project` are 1..1024 characters. Template/target/profile identifiers
are 1..128 ASCII letters, digits, dots, underscores or hyphens. `projectName` is
1..128 characters matching `^[a-z][a-z0-9-]*$`. Required `requestKey` is 1..128
ASCII letters, digits, dots, underscores or hyphens. The build schema accepts
`variant: "debug" | "release"`; unavailable
combinations fail with `PROFILE_NOT_AVAILABLE`. Check uses the debug profile.
Use catalog results for template IDs rather than assuming every pack is identical.
Checks and builds accept `timeoutMs` from 1000 to 3600000, default 600000, including
queue/preparation time and bound into request-key deduplication. Logic uses fixed
`node:test` discovery under `tests/` for TS/JS/MJS/CJS test/spec files, a private
snapshot, the delivered TS 4.9.5 compiler and unmodified Node declarations. It does
not run npm scripts or resolve ancestor dependencies. Without `--execute-tests true`
logic is denied; the grant cannot be supplied through MCP or the AI launcher.
Authorized tests can access host files, processes and network: trust the code or
run it under independent OS isolation.

### BILIBILI Source Packages

Select `bilibili-2d-basic-starter` or `bilibili-3d-basic-starter` when delivered.
Creation adds root `game.json` with an empty `appId` and the project's package
version. Fill in your appId and review platform settings before building with
`target: "BILIBILI"`. No SDK validation-only config is used as a fallback.
Missing config is `UNSUPPORTED_PROJECT`; malformed/ambiguous JSON or canonical
preflight failure is `ARTIFACT_INVALID`. Config bytes are preserved, not rewritten.
Only unsplit packages are assembled; nonempty `subpackages` are unsupported and
`plugins` must be absent or an empty object.

The package contains `game.js`, `cocos-js/cc.js`, genuine BILIBILI adapters,
loader/Application and the current game's compiled modules/assets, not HTML5
bootstrap or SDK development files. Reports separate `staticModuleClosure`,
`bilibiliSourcePreflight` and `copiedResourceInventory`. Warnings
`RESOURCE_LOADING_UNVERIFIED` and `RUNTIME_UNVERIFIED` mean dynamic game asset
requests, runtime behavior and vendor package sizes have not been proven.
The same source project can separately build HTML5 for browser preview.

### WECHAT And BYTEDANCE Source Packages

Select the catalog's `wechat-<profile>-starter` or `bytedance-<profile>-starter`
(`-release-starter` for a release template) only when delivered. Creation adds:

| Target | Game-owned metadata | App ID field |
| --- | --- | --- |
| WECHAT | `platforms/wechat/game.json`, `platforms/wechat/project.config.json` | `project.config.json` field `appid`, real `wx`-prefixed ID |
| BYTEDANCE | `platforms/bytedance/game.json`, `platforms/bytedance/project.config.json` | `project.config.json` field `appid`, real `tt`-prefixed ID |

`project_create` blanks `appid` and sets `projectname`. Supply your own ID and
review platform settings before building; local validation IDs are not vendor
credentials. Both config files are copied byte-for-byte to the export root as
`game.json` and `project.config.json`, never replaced by SDK fixtures. BILIBILI
continues using root `game.json` and its case-sensitive `appId` field.
Missing config is `UNSUPPORTED_PROJECT`; invalid config/preflight fails rather
than silently rewriting it. Only unsplit source packages are supported: nonempty
`subpackages`/`subPackages`, plugins, `openDataContext`, workers and cloud export
are rejected. No platform-specific directories from other targets are exported.

These use genuine `wx`/`tt` adapters, `wechatgame`/`bytedance-mini-game` loader
platforms and target-specific engine constants/PAL, not renamed BILIBILI bundles.
Each output has `game.js`, engine/loader/Application, current game modules/assets
and preserved license/notice files. Reports include `staticModuleClosure`,
`wechatSourcePreflight` or `bytedanceSourcePreflight`, and `copiedResourceInventory`.
The same resource/runtime warnings and vendor/device limits as BILIBILI apply.
`@cocos/engine-platforms@1.0.6` declares `UNLICENSED`; preserving its metadata and
the engine license is not redistribution approval.

`cocos4_package_validate` accepts `target: "BILIBILI" | "WECHAT" | "BYTEDANCE"`
(default BILIBILI) and an authorized workspace-relative `directory`. It runs
canonical source preflight, not the build's full static module-closure analysis,
and never executes package scripts or invokes vendor tools.

### 2048 Target Selection

The source example runner now accepts an optional `--targets` CSV (default
`HTML5,BILIBILI`) and optional `--bilibili-app-id`, `--wechat-app-id` and
`--bytedance-app-id` flags. With a separately assembled kit delivering the selected
profiles, run from the repository root to select only the new mini-game exports:

```sh
/absolute/path/to/kit/runtime/node tools/devkit/examples/2048/run.mjs \
  --kit /absolute/path/to/kit --out /absolute/path/to/absent-run \
  --targets WECHAT,BYTEDANCE
```

Omitted app-ID flags use explicit local-test identities, not publishable IDs;
provide real IDs for your vendor project. The runner still needs the kit's HTML5
2D debug starter, even when exporting only mini-games. Without HTML5 in `--targets`
it neither enables preview nor runs a browser; `--drivers`, `--pngjs` and
`--chromium` are required only when HTML5 is selected. This is an implemented
workflow, not a claim that the new final kit/demo has passed.

### HTML5 Preview

Develop mode with separate preview permission adds two more tools:

| Tool | Input | Actual behavior |
| --- | --- | --- |
| `cocos4_preview_start` | `artifactId` (UUID), `ttlSeconds?` (integer 1..7200, default 1800), `requestKey` | Serve only an owned successful HTML5 build; all mini-game targets are rejected before job/listener creation; readiness is `job.phase === "ready"` with `job.preview.url` |
| `cocos4_preview_stop` | `jobId` (UUID of a preview job) | Stop sockets/worker; returns `{ jobId, state, accepted }`, and repeated terminal stops have no effect |

Preview uses a random port on `127.0.0.1` and a random 256-bit path token. It
validates inventory/payload hashes, pins private paths, serves bounded `GET`/`HEAD`
responses, and rejects foreign Host/Origin, traversal and unlisted/private paths.
Neither the SDK/toolchain nor a mutable project directory is an HTTP root.

All tool arguments reject unknown properties. MCP `_meta` remains extensible as
required by the protocol; it does not authorize anything. Unknown tools/methods
and malformed protocol parameters are JSON-RPC errors. Invalid business arguments
and operation failures use the same output schema as success, with `isError: true`,
`ok: false`, a stable error code and `data: null`. Text content is the exact JSON
serialization of `structuredContent`. Complete wire responses are at most 64 KiB.

Capabilities are fixed to `tools: {}` and `resources: {}`. No listChanged,
subscriptions, Tasks, sampling or elicitation is advertised. Resource URIs are
`cocos4://sdk/<sdk-id>/manifest` (bounded summary) and manifest-listed
`cocos4://sdk/<sdk-id>/docs/<document-id>` entries, never arbitrary file paths.
Protocol negotiation to `2025-11-25` is exercised by the official SDK client.

Job receipts acknowledge admission only. A successful `job_get` envelope means
the query succeeded; callers must inspect `job.state`, `job.error` and report
items. Warnings can accompany success; failed report checks must not become a
successful job. Mini-game source preflight does not establish rendering, vendor
compilation, final compiled size, upload, or real-device acceptance.

Compiler errors fail the job with `TYPECHECK_FAILED`, `FEATURE_NOT_IN_PROFILE` or
`UNSUPPORTED_PROJECT` as appropriate. Structured, bounded diagnostics retain
logical file paths and one-based locations in the failed report; they are not
converted into successful build receipts. Successful creation returns
`report.project`. A successful build returns one `report.artifacts` entry whose
`artifactId` equals the build `jobId`, with SDK/profile/variant identity. Its SHA-256
hash binds the raw `artifact-inventory.json` bytes; byte/file totals cover listed
payload only, excluding that inventory. `game-compiler.json` records this game
compilation, not the old SDK fixture's compiled game.
New jobs record the executing application's verified outer `releaseId`; unpackaged
source tools use `null`. New artifact receipts and inventories carry
`provenance: { releaseId, profileSha256 }`, where `profileSha256` is the selected
profile descriptor's actual manifest SHA-256 and matches `report.profile.descriptorSha256`.
Publication rejects disagreement with the producing job/profile. Release identity
comes from the executing application's verified release, not an MCP argument or
environment override. These integrity bindings do not authenticate a publisher.
Target/entry pairs are strictly `HTML5`/`index.html` and
`BILIBILI`/`WECHAT`/`BYTEDANCE` with `game.js`,
including persisted receipts and inventories.

## Isolation And Limits

- Read-only is the default. Develop, preview and execute-tests permissions are separately opted
  into at startup; there is no maintainer/arbitrary-command tool mode.
- Workspace reads use pinned Linux directory descriptors, or Windows handles
  with ACL/reparse validation, identity checks and before/after snapshot verification. Hardlinks,
  symlinks, special files, traversal, encoded separators and Windows-special names
  are rejected. Unrelated ancestor/sibling directory churn is not an input change.
- Inspection is capped at 1,000 entries, 8 MiB, depth 32, 1 MiB per JSON and five
  seconds. Both doctor depths retain these project limits. No extends, plugins,
  dependencies or package scripts are executed or followed.
- Project/package input snapshots are capped at 10,000 entries, 64 MiB, depth 32
  and 1 MiB per JSON. The verified validator is copied privately before loading; mutable
  project JS is not required/imported by data inspection or package validation.
  Inputs are rechecked before success. Explicit logic execution is a separate operation.
- Game compilation copies only selected manifest-listed SDK bytes into private
  staging, rehashing the complete executable closure before loading it. SDK paths
  are not required after a hash check, and engine/ancestor/global dependency
  fallback is blocked. TypeScript retains `strict: true`, `skipLibCheck: false`
  and `skipDefaultLibCheck: false`; the declaration baseline has
  `noImplicitAny: false`, which projects can tighten. Unsupported configs/plugins
  are not executed. Builds check the loader's `start(): Promise<void>` contract,
  its source implementation and emitted export binding, including named/star
  reexports. Declaration-only or uninitialized entries fail. This is not proof
  of arbitrary game behavior. Cocos/type erasure completes before SystemJS so
  type-only modules remain valid scripts. Old invalid compiler output is rejected;
  regenerate the SDK instead of stripping residual native module statements.
- Output contains the selected engine/loader/internal bundle, freshly compiled
  game modules and supported PNG/JPEG/WebP/GIF, WAV/MP3/OGG, JSON/text assets from
  the project. Payload paths use ASCII letters, digits, dots, underscores, `@`,
  plus or hyphen; hidden/private names are rejected. No Creator import/conversion
  pipeline runs; unsupported assets fail.
  SDK templates, declarations, compiler dependencies and old fixture game assets
  are not copied into build output.
- One preview may run alongside one heavy worker, with at most eight queued jobs
  for the current SDK. Fixed tool-owned worker threads have an empty environment
  and no inherited Node execution flags. They never publish output. Authorized
  logic uses a fixed Node runner under Linux subreaper/guardian supervision with
  pidfds, or Windows Job Objects with process creation-time identities. EOF, cancellation, deadlines, worker
  crashes and server SIGKILL have real process-tree regressions; this is not a
  security sandbox or proof of macOS supervision. Parent-only publication
  uses the fixed compiled helper described above.
  Non-preview workers have a 512 MiB V8 old-space limit to revalidate the complete
  indexed SDK; preview stays at 128 MiB and does not parse it. These are heap, not
  process RSS limits. Checks are never skipped to accommodate the old heap limit.
- Preview HTTP resource bursts use at most eight active file verifications and
  24 waiting requests, with a 128 MiB aggregate response-buffer budget. Waiting
  requests open no payload files; their five-second deadline includes queue time.
  Disconnect, expiry and server close remove them before dispatch. The listener
  retains its 32-connection limit; overload and expired requests can be rejected.
- All instances must use the same private `--state-root`. A conservative
  server-lifetime workspace lock excludes another server, including other SDK
  versions. Job IDs/history remain SDK-scoped. Do not change state roots to run
  concurrent servers against the same workspace.
- Deadlines include queue time; readonly jobs default to 60 seconds, game
  operations use ten minutes, and preview's job allowance is TTL plus 60 seconds.
  Only the bounded check/build timeout is caller-selectable. No arbitrary command,
  environment, executable or PID is exposed. Project destinations are authorized relative paths; callers cannot
  select an arbitrary artifact output root.
- Private state retains at most 64 records for seven days, 8 MiB logs per job and
  256 MiB logs per workspace, with generation-bound expired cursors. It allows
  48 KiB reports, 128 KiB records and an 8 MiB atomic metadata snapshot. Capacity
  exhaustion rejects work instead of evicting retained request keys. Staging is
  removed after completion/cancellation and recovery; user data is never cleaned.
- Registered private artifact payload is capped at 128 MiB per build, 512 MiB and
  64 outputs across the workspace/SDKs, separately from staging and metadata. Artifacts
  live at `artifact-<build-job-id>` under the private workspace state directory.
  That directory is `<state-root>/<sha256(canonical-workspace-path)>/`. For vendor
  tools, use a separately retained copy of the mini-game source package; do not edit
  a registered immutable artifact. The SDK-scoped artifact registry outlives the
  seven-day job metadata, logs and request keys: expired jobs still have usable
  artifact IDs and their outputs still count toward the quota. Opening the same
  SDK with another release does not relabel retained outputs: their original
  producer/provenance remains intact, and ownership stays SDK-scoped rather than
  being reassigned to the current release. A preview does not extend a job's
  retention period. Unregistered directories, including uncertain crash outcomes,
  are preserved but never automatically served or adopted; they block new artifact
  publication because their quota cannot be established safely. To free space,
  stop the server and move unneeded artifact directories outside private state.
  The next build reconciles absent entries without resurrecting ownership from
  old job reports. No delivered output or user project is auto-deleted.
- Request-key deduplication is persisted for the development tools; readonly scan
  tools do not accept request keys. New packaged requests bind SDK ID, verified
  release ID, normalized arguments and timeout. They never reuse a job from another
  release or an unknown legacy producer, even when the SDK and textual key match.
  The same verified release can relocate without losing deduplication in the same
  workspace/state. Source tools have `releaseId: null` and retain SDK-root-bound
  input identity, not a fabricated release ID. Keys do not bind current source
  contents: use a new key after editing a project. Accepted cancellation cannot
  later become success; interrupted work is never automatically replayed.
- Publication runs in the serialized parent after successful worker exit and a
  cancellation/deadline decision, with `phase: "committing"` persisted first.
  Deadline and shutdown are rechecked after that persistence, before publication.
  The bounded publication step itself is non-interruptible once started.
  Late cancellation waits for that decision and returns `accepted: false` if the
  job is already terminal. Project creation rejects `.`, existing empty directories,
  files, symlinks, reserved/private names and missing destination ancestors; it
  never merges into or overwrites an existing directory.
- **Project publication has crash uncertainty.** A process loss during committing
  can leave an already-created project with an interrupted job. Inspect the
  destination before retrying; no rollback, automatic replay or complete recovery
  journal is provided. Rename and job metadata are not one durable transaction.
  Helper timeout/failure can also leave an unconfirmed outcome. A fixed helper
  can outlive abrupt parent process death; this is not process-tree supervision.
- Log pipes continue draining after truncation. Common credential patterns are
  redacted and recognized private files are skipped/rejected. Filename/regex
  checks cannot discover every secret or sandbox hostile code.
- Metadata v5 atomically records jobs, independent SDK artifact ownership and
  release/profile provenance. Valid v2/v3 successful receipts migrate into the
  registry before job expiry; v4 imports preserve its independent registry.
  Migration does not invent missing producer IDs, profile hashes, provenance or
  execution observations, and never adopts directories. A legacy job's default
  `releaseId: null` is not proof that source tools produced it; absent legacy
  artifact provenance remains absent. Logs remain separate. Older binaries that
  cannot read v5 require an offline pre-upgrade state backup for rollback.
  Unsupported/corrupt formats are rejected unchanged. Stale lock recovery never
  kills a PID; ambiguous live owners block recovery. After 128 retained stale-lock
  tombstones, offline maintenance is required instead of unsafe automatic removal.

The SDK and private state must be trusted and stable. This is not isolation from
malicious processes running as the same OS user. Filesystem power-loss durability,
network filesystems, real disk exhaustion and macOS are not accepted.
Kernel I/O can outlive a bounded inspection response; its reader retains and
closes the pending descriptors. See the acceptance ledger for exact Windows test
coverage; implementing its host helpers does not establish every package gate.

## Verification And Remaining Work

The retained [run7 summary](build/windows-delivery-20261010-run7/acceptance-summary.json)
records local package success: standard Windows extraction/relocation, SDK-only
doctor without HOME/state, actual official-client MCP discovery/docs/resources,
sixteen edits/checks/builds across two independent target groups, unchanged
package/ZIP hashes and four HTML5 browser reports. Desktop/mobile pixels,
mouse/touch, native WebAudio PCM, missing assets and ten restarts passed on
Edge/SwiftShader. Browser and driver are explicit external dependencies.

[Signal Switch](build/windows-delivery-20261010-run7/signal-switch/acceptance-summary.json)
separately passed the current Codex packaged-CLI create/TS2322/strict repair/build
route and actual victory/failure/timer, keyboard/mouse/touch, thirteen restarts
and native WebAudio PCM; preview TTL exited 0. Installed Codex MCP discovery and
the independent reference-client/provider route remain unaccepted.
The source full matrix remains interrupted with null totals and `success: false`.
The local package result does not establish VM, non-admin, offline/source-hidden,
read-only mount, hardware/device, vendor publishing or redistribution approval.

```sh
npm run check --prefix tools/devkit
npm test --prefix tools/devkit
```

Tests include real official-client stdio and CLI calls, canonical Bilibili
success/failure, strict error schemas, resource allowlisting, pagination, scan
budgets, descriptor-replacement races, cross-SDK/workspace ownership, cancellation,
timeouts, output flooding, server SIGKILL recovery, persistence failure and EOF
under stdout backpressure. Fixture workers are used only to force job failures;
real application workers are separately tested through MCP.

Focused game-operation tests use a real prepared SDK, not a stub compiler:

```sh
GAME_OPERATION_SDK_ROOT=/absolute/path/to/game-sdk GAME_SDK_INTEGRATION=1 \
  node --test tools/devkit/test/game.test.mjs tools/devkit/test/workspace.test.mjs
```

The default local SDK test path is `tools/devkit/build/game-sdk`. Without a real
pack the optional game integration cases explicitly skip; with the variables
above missing/invalid inputs fail. Tests cover 2D/3D create/check/build, diagnostics,
profile overflow, editable creation, unchanged read-only inputs, private compiler
closure races, payload/inventory checks, conflicts and bootstrap consistency.
These checks do not execute newly emitted games in a real browser. Preview HTTP
tests are likewise not pixel/input/audio evidence. New build-to-preview browser
claims require separate, retained end-to-end evidence for those exact artifacts.

The official-client development regression creates and edits both profiles,
checks compiler diagnostics, builds and previews registered artifacts, and tests
CLI/stdio shutdown and restart. Set the browser explicitly for real rendered
pixels, audio, edited gameplay, mouse/touch and restart assertions:

```sh
GAME_OPERATION_SDK_ROOT=/absolute/path/to/game-sdk GAME_SDK_INTEGRATION=1 \
  GAME_CHROME_EXECUTABLE=/absolute/path/to/chrome \
  node --test tools/devkit/test/development.test.mjs
```

Without `GAME_CHROME_EXECUTABLE`, this test reports that browser assertions were
not requested. Its diagnostics bind browser version, software renderer, screenshot
digest and interaction results to the exact artifact digest. This does not prove
physical GPU or vendor-device behavior. Successful browser checks retain the
first-frame PNG, artifact inventory and JSON report under ignored
`tools/devkit/build/development-browser-*` directories printed in the test output.

The mixed-SDK regression covers real BILIBILI create/edit/check/build, type-only
modules, declaration-only entries, malformed config, preflight jobs, hashes,
HTML5-only preview, CLI and restart persistence:

```sh
COMBINED_SDK_ROOT="$PWD/tools/devkit/build/game-sdk" \
  LEGACY_HTML5_SDK_ROOT="$PWD/tools/devkit/build/legacy-game-sdk" \
  node --test tools/devkit/test/bilibili-development.test.mjs
```

Reports and successful packages remain in ignored `build/bilibili-development-*`.
No BILIBILI renderer, vendor compiler or device executes. Explicitly selected SDKs
must exist; missing inputs cannot produce successful integration evidence.

The CI workflow now defines provisioned Linux Node 18.20.8 and 24.21.0 lanes,
including host/GL prerequisites, engine/tool dependencies, real runtime evidence,
the reviewed official Node archive, offline candidate assembly and unfiltered
integration tests. Earlier `verification-inputs` contract runs passed six tests
per pinned runtime in parent-reported direct runs. This verifies prerequisite and
orchestration rules, not a clean-checkout or hosted CI rehearsal; neither has been
performed.

The former strict 3D EFX2404 blocker was resolved in earlier maintainer work;
[Effect evidence](effects/README.md) records the pinned conditional-preprocessing
fix without disabling parser/driver checks. The separate
[runtime evidence](runtime/README.md) covers prior 2D/3D templates in real Chrome,
including software WebGL, input, assets, audio and restart. That prior evidence is
not a fresh test of this MCP session or every game emitted by the new build tool.

`build/minigame-exporters-20260930/summary.json` records eight successful new
WECHAT/BYTEDANCE runtime/local-report combinations, not a final SDK or packaged
game run. The local checks mock host/`cc` boundaries and do not execute the engine
or render. That checkpoint did not include SDK/candidate/demo verification;
current run7 scope is recorded in [Windows Local Delivery](ACCEPTANCE.md#windows-local-delivery-october-10).

See the [packaged checkpoint](ACCEPTANCE.md#packaged-2048-check) for the
earlier HTML5/BILIBILI candidate's focused 2048 result, and the
[September 24-25 checkpoint](ACCEPTANCE.md#september-24-25-checkpoint) for historical
SDK/candidate identities, completed skill checks and interrupted Node 18 run.
The earlier logic/lifecycle, release-game, OpenCode and v5-a evidence remains historical. Retained
`build/matrix-node24-93jqOD/result.json` records 34 startup/archive tests passed,
zero failures/skips/cancellations and unchanged inputs, not full acceptance.
`build/portable-host-bAPi9z/result.json` and its workflow report record eight builds,
four browser reports and passing release/profile identity assertions in Linux
namespaces, not a fresh VM or model/vendor/device run, and do not transfer to the newer candidate.
No current full Node 18/24 pass is established. Verification-script fixes have
[historical source/harness results](ACCEPTANCE.md#september-26-focused-verification);
no further full matrix was run at that checkpoint. Fresh candidate assembly supersedes "not rebuilt",
not earlier matrix passes.
Still open for a complete release: full merged acceptance,
installed-client discovery and independent reference-provider inference,
fresh-VM/multi-host acceptance, clean-source release provenance,
publisher authentication and redistribution review. Arbitrary Creator imports
and vendor compilation/upload automation remain outside the initial local beta.
Vendor/device acceptance is a separate unverified gate. Neither the manifest kind
nor these tool counts claim a complete portable SDK or vendor publishing service.
