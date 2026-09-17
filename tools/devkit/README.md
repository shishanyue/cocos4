# Devkit Tools And Probes

Development tools and feasibility tests for the [portable devkit plan](../../docs/plans/cocos4-mcp-devkit.md).
A working [readonly MCP/CLI](MCP.md) now exposes ten real tools with bounded
workspace reads and worker-backed jobs. This is **not** a released portable SDK,
game compiler or preview server, and does not complete the full MCP/game goal.
P0 remains open until real, source-independent 2D/3D games work in a browser.
The separate [builtin Effect probe](effects/README.md) now compiles the actual
2D builtin assets; its strict 3D attempt exposes an unresolved compiler defect.

## Run

From the engine repository root:

```sh
npm ci --prefix tools/devkit --ignore-scripts --engine-strict --no-audit --no-fund
npm run check --prefix tools/devkit
npm test --prefix tools/devkit
```

Installation is an explicit, network-using maintainer step. Tests do not download
anything, invoke Creator, prepare the engine, or execute game code. They prepare
real source catalogs, inspect temporary project fixtures and build loader fixtures.
Linux and `/usr/bin/python3` with libc `renameat2` are required for atomic pack
preparation tests. TypeScript emits application and probe JS into ignored
`build/src/` and `build/probes/`. No MCP/client configuration,
global skills, ports, background service, or release artifacts are installed.

The package has its own lockfile and TypeScript configuration. Engine TypeScript
4.9.5, root dependencies, and the engine's Node >=18 baseline are unchanged.
This private probe package requires Node >=18.20.8, the oldest tested runtime;
that does not establish support for every earlier Node 18 patch. Node 18 is only
a compatibility test target, not a runtime recommendation for a new release.

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
supported range; no package source or engine requirement is patched. HTTP/OAuth
are not exercised or exposed. Reassess this override on SDK upgrades.
Tarball locations and integrity hashes, including all transitive packages, are
recorded in `package-lock.json`. This is not a release SBOM or license clearance.

## Executed Evidence

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
The CI workflow repeats clean installation/checking/tests for Node 18.20.8 and
24.21.0 with this tool package installed and selected engine config/doc inputs
read from the checkout; no engine dependency installation. A checked-in workflow is not
evidence of a completed CI run or a clean offline release-machine acceptance.

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

## Remaining Graphics Work

The portable profiles must explicitly include `legacy-pipeline`. The smoke
default does not register a renderer; see `exports/legacy-pipeline.ts` and
`cocos/root.ts:setRenderPipeline`. Do not change the existing smoke CLI defaults
merely to make them appear to be production profiles. The first experiment
should use HTML5 BUILD, `rendering.customPipeline: false`, no serialized launch
scene and a disabled splash, then create scenes through public APIs after
`game.init()`. A resolved init or an AFTER_DRAW event alone is not pixel evidence.

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

The 2D builtin roots compile to a candidate internal bundle with reproducible
file digests. Strict 3D compilation fails at deferred-lighting's parser check;
the parser and configured dependencies remain intact. Fix that compiler defect
and validate resource loading first. Then compile decorated game TS, build the
actual profiles, and demonstrate interactive 2D/3D pixels, resources, audio and
restart in a real browser with source paths unavailable. Custom pipeline graph
production, game assembly, BILIBILI bootstrap and host process-tree supervision
remain separate work. None is completed by the original eight probe tests or the
new readonly MCP/job tests.

## Redistribution Gate

Do not publish a bundle based solely on package `license` fields:

- Root `LICENSE` says MIT, while `exports/base.ts:6-15` contains restrictive
  Creator game-development/tool-distribution wording. Both notices remain
  unchanged; their applicability needs clarification before devkit distribution.
- The compiler candidate has a MIT root license but ISC package metadata.
- `@cocos/module-system` declares ISC; its tarball includes the embedded SystemJS
  MIT notice but no top-level ISC notice. Preserve and resolve attribution.
- Effects/chunks carry original copyright notices. Fonts and selected external
  WASM require their own provenance/notice inventory. Do not infer clearance
  from an existing developer cache or silently include unneeded fonts.
- The loader build dependencies include deprecated `rollup-plugin-terser` and
  `sourcemap-codec`. This private experiment is not an audited shipping toolchain.

These are observed notice/dependency gaps, not legal conclusions. Resolving them
is a release gate; removing headers is not a fix.
