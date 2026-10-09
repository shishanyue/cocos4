# Tool Workflow

## Capabilities And Docs

Start with these data queries, using the tool names advertised by the client
(OpenCode may prefix them with the `cocos4` server name):

```json
{"section":"sdk"}
```

```json
{"section":"profiles","limit":20}
```

```json
{"section":"templates","limit":20}
```

Use `cocos4_docs_search` for literal, case-sensitive API/example queries, then
`cocos4_docs_read` with the returned `documentId`. Never invent IDs or use a file
path as a document ID. Paginate with the same query and the returned `nextCursor`.
Read pages are at most 16 KiB. Cursors bind a query and session; do not persist
them as stable document addresses. Resources are optional; docs tools are the
fallback when the client does not expose resources.

```json
{"query":"Component","kind":"api","profile":"2d-basic","limit":10}
```

Only use that profile if the catalog delivered it. Packs without an API index
report `availableKinds: ["guide"]`; do not pretend the API lookup succeeded.
`runtimeAvailability` checks top-level exports, not individual member behavior.
`type-only` is not a runtime value. `featureRequirements: "unknown"` and empty
`requiredFeatures` do not mean an API works in every engine feature selection.

## Jobs

Inspect first, then use the exact delivered identifiers in these examples:

```json
{"project":"my-game"}
```

```json
{"directory":"my-game","templateId":"2d-basic-starter","projectName":"my-game","requestKey":"create-my-game-1"}
```

```json
{"project":"my-game","target":"HTML5","profile":"2d-basic","checks":["types"],"requestKey":"check-my-game-2"}
```

```json
{"project":"my-game","target":"HTML5","profile":"2d-basic","variant":"debug","requestKey":"build-my-game-2"}
```

The last three operations require develop permission. A receipt supplies a
`jobId`, initial state and `pollAfterMs`. Query `cocos4_job_get` until the job is
`succeeded`, `failed`, `cancelled`, `timed_out` or `interrupted`. Success requires
`job.state === "succeeded"`, no `job.error`, and no failed report items.
Consume report pages and `cocos4_job_logs` as needed. A successful outer envelope
does not imply successful inner work. Failed type checks need code changes, not
suppressed diagnostics or fake declarations.

`cocos4_jobs_list` finds owned jobs in this SDK/workspace. `cocos4_job_cancel`
accepts a job ID, never a PID. Cancellation cannot promote a job to success.
Changing source or target/profile needs a fresh request key. New source does not
invalidate the fact that an old job succeeded on its old snapshot.

## Preview And Export

Call `cocos4_preview_start` with the successful HTML5 `artifactId`, optionally
`ttlSeconds` and a fresh request key. The preview remains running while ready;
do not wait for terminal success before showing `job.preview.url`. It binds only
loopback and serves inventoried artifacts, not source, secrets or the SDK.
`cocos4_preview_stop` or job cancellation closes it. TTL and MCP disconnect also
stop it. Never describe merely serving a URL as a rendering or gameplay test.

Current source exporters are HTML5, BILIBILI, WECHAT and BYTEDANCE, available only
for delivered profiles. Legacy eight-profile HTML5/BILIBILI SDKs remain valid;
the expected new four-target kit has 16 2D/3D debug/release combinations, but source
support does not establish that a final kit or demo has been assembled or passed.

Use the chosen target's catalog starter and game-owned metadata:

| Target | Project metadata | User-supplied ID |
| --- | --- | --- |
| BILIBILI | Root `game.json`, retained for shipped projects | `appId` |
| WECHAT | `platforms/wechat/{game.json,project.config.json}` | `appid` in `project.config.json`, real `wx`-prefixed ID |
| BYTEDANCE | `platforms/bytedance/{game.json,project.config.json}` | `appid` in `project.config.json`, real `tt`-prefixed ID |

`project_create` leaves the app ID blank. Set the user's actual ID and review
platform settings before building. Do not fabricate credentials or treat SDK
local-validation IDs as publishable. Build copies config bytes verbatim to the
export root. WECHAT/BYTEDANCE use genuine `wx`/`tt` adapters, matching loaders and
engine flags, not renamed BILIBILI bundles.

All mini-game outputs are unsplit source packages with `game.js` entry and
preserved licenses/notices, never browser previews. Nonempty subpackages or
plugins are unsupported; WECHAT/BYTEDANCE also reject open-data contexts, workers
and cloud export. `@cocos/engine-platforms@1.0.6` declares `UNLICENSED`; retaining
its metadata and the engine license is not redistribution approval.

`cocos4_game_build` performs static module/resource closure and local source
preflight. `cocos4_package_validate` accepts BILIBILI/WECHAT/BYTEDANCE (default
BILIBILI) only when the SDK advertises the matching validator. It checks an existing
authorized workspace directory without executing scripts, not the build's full
static closure analysis. Neither operation runs vendor tooling,
signs a package, uploads, verifies compiled vendor size, or proves device behavior.
Report artifact IDs and missing delivery steps instead of guessing a shell copy
or upload command. Logic checks need separate startup authorization; release
variants require delivered profiles. Arbitrary Creator imports remain unsupported.
