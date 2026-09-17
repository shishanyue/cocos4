# Readonly MCP And CLI

This is a working **Linux development implementation**, not the complete portable
game SDK in the [plan](../../docs/plans/cocos4-mcp-devkit.md). It provides ten real
tools using the official MCP SDK. It does not create, compile or preview games,
run project code, prepare the engine, upload packages, or change AI configuration.
Unavailable game tools are omitted rather than backed by successful placeholders.

## Prepare And Start

Maintainer preparation, from the repository root:

```sh
npm ci --prefix tools/devkit --ignore-scripts --engine-strict --no-audit --no-fund
npm run build --prefix tools/devkit
npm run prepare:sdk --prefix tools/devkit -- --out "$PWD/tools/devkit/build/readonly-sdk"
```

The output directory must not exist, even if empty. Preparation uses only selected
source/configuration files and this package's pinned JSON5 parser. No engine
dependencies, engine build or external assets are needed. Installation is the
explicit network-using step; preparation and runtime do not download anything.

Atomic publication requires Linux, `/usr/bin/python3` and libc/kernel support for
`renameat2(RENAME_NOREPLACE)`. The isolated Python helper performs only this fixed
rename; it has no check-then-rename or copy fallback. Python is not used at runtime.
The prepared pack contains a manifest, source-derived catalog, selected guide
excerpts, the unchanged canonical Bilibili validator and its license. Hashes
establish integrity, not source authenticity or redistribution clearance.

Start stdio with an MCP client, using **absolute paths** for all roots and the
chosen Node executable. The workspace must already exist. The private state
directory may be absent and will be created with restricted permissions.

```sh
/absolute/path/to/node /absolute/path/to/tools/devkit/build/src/cli.js mcp \
  --sdk-root /absolute/path/to/readonly-sdk \
  --workspace /absolute/path/to/games \
  --state-root /absolute/path/to/private-cocos4-state \
  --mode read-only
```

Workspace, SDK and state must be disjoint, not ancestors of one another. Do not
authorize the engine repository as the workspace if it contains your prepared
SDK. SDK and state paths must not contain symlinks; the explicitly selected
workspace root is canonicalized, but descendant symlinks are rejected.

For clients other than OpenCode, use the same executable and argument array in
their stdio configuration. Do not launch through `npm start`: npm banners can
pollute protocol stdout. No client or global configuration is written by these
commands. An actual OpenCode/model session has not yet been accepted.

The CLI shares exactly the same schemas and application operations:

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

`tools` prints actual input/output schemas. `call` waits for job completion and
emits all pages as **NDJSON**, one envelope per line. Session-bound cursors are
consumed before the CLI exits; they cannot be reused in another invocation.
Failed operations or failed doctor checks produce a nonzero CLI exit status.

## Available Tools

| Tool | Actual behavior |
| --- | --- |
| `cocos4_catalog` | Source-derived SDK/platform/feature records; explicitly empty profiles/templates |
| `cocos4_docs_search` | Literal, case-sensitive search of selected guide excerpts; no API index or runnable examples |
| `cocos4_docs_read` | Versioned manifest-listed guide text, UTF-8-safe byte pagination |
| `cocos4_project_inspect` | Bounded data-only inspection of configuration, entry and unsupported inputs |
| `cocos4_doctor` | Worker job rechecking pack integrity and optional bounded project data; no repair |
| `cocos4_package_validate` | Worker job applying the existing BILIBILI validator to a private snapshot |
| `cocos4_jobs_list` | SDK/workspace-scoped retained job summaries |
| `cocos4_job_get` | Job state and paginated report |
| `cocos4_job_logs` | Bounded, redacted, paginated logs |
| `cocos4_job_cancel` | Cancellation by owned job ID; terminal cancellation is idempotent |

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
items. A doctor job can finish its scan successfully while reporting warnings
or failed checks. Bilibili source preflight does not establish rendering, vendor
compilation, final compiled size, upload, or real-device acceptance.

## Isolation And Limits

- Only read-only mode is supported; develop/preview/maintainer modes fail closed.
- Workspace reads use pinned Linux directory descriptors, no-follow/nonblocking
  opens, identity checks and before/after snapshot verification. Hardlinks,
  symlinks, special files, traversal, encoded separators and Windows-special names
  are rejected. Unrelated ancestor/sibling directory churn is not an input change.
- Inspection is capped at 1,000 entries, 8 MiB, depth 32, 1 MiB per JSON and five
  seconds. Both doctor depths retain these project limits. No extends, plugins,
  dependencies or package scripts are executed or followed.
- Package snapshots are capped at 10,000 entries, 64 MiB, depth 32 and 1 MiB per
  JSON. The verified validator is copied privately before loading; mutable
  project JS is never required/imported. Inputs are rechecked before success.
- One heavy worker and eight queued jobs per workspace. Fixed tool-owned worker
  threads have an empty environment and no inherited Node execution flags. They
  never spawn subprocesses. EOF/signals stop owned workers; a server SIGKILL also
  kills its threads. This is not process-tree supervision for future game code.
- All instances must use the same private `--state-root`. A conservative
  server-lifetime workspace lock excludes another server, including other SDK
  versions. Job IDs/history remain SDK-scoped. Do not change state roots to run
  concurrent servers against the same workspace.
- Deadlines include queue time; scans default to 60 seconds. The internal job
  manager supports deadlines up to ten minutes. No caller-controlled arbitrary
  command, timeout flag, environment, executable, PID or output path is exposed.
- Private state retains at most 64 records for seven days, 32 KiB logs per job,
  48 KiB reports, 128 KiB records and an 8 MiB atomic metadata snapshot. Capacity
  exhaustion rejects work instead of evicting retained request keys. Staging is
  removed after completion/cancellation and recovery; user data is never cleaned.
- Internal request-key deduplication is SDK-scoped and persisted. The currently
  exposed readonly scan tools do not accept request keys. Accepted cancellation
  cannot later become success; interrupted work is never automatically replayed.
- Log pipes continue draining after truncation. Common credential patterns are
  redacted and recognized private files are skipped/rejected. Filename/regex
  checks cannot discover every secret or sandbox hostile code.
- Metadata format v2 includes private SDK ownership. Unknown/older/corrupt formats
  are rejected unchanged. Stale lock recovery never kills a PID; ambiguous live
  owners block recovery. After 128 retained stale-lock tombstones, offline
  maintenance is required instead of unsafe automatic removal.

The SDK and private state must be trusted and stable. This is not isolation from
malicious processes running as the same OS user. Filesystem power-loss durability,
network filesystems, real disk exhaustion and non-Linux hosts are not accepted.
Kernel I/O can outlive a bounded inspection response; its reader retains and
closes the pending descriptors. Windows Job Objects and macOS support remain work.

## Verification And Remaining Work

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

The CI workflow installs only this package, reads checked-in catalog/document
inputs, and checks Node 18.20.8 and 24.21.0 on Linux. It does not prepare/install
the engine or GL Effect probe. A workflow definition is not a completed CI run.

Still required for the full goal: actual prebuilt 2D/3D profiles, builtin bundle
loading, the 3D EFX2404 compiler fix, decorated game TS compilation, runnable
templates, project create/check/game build, verified-artifact preview, Bilibili
game assembly, AI-client/skills integration, portable runtime/dependency packaging,
multi-host acceptance and licensing. None of these is claimed by the ten tools.
