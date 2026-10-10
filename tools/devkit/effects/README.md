# Builtin Effect Probe

Maintainer-only P0 experiment. Both the **2D and full configured 3D builtin asset
roots compile** from actual engine sources, with strict parser and real host GL
checks. This does not establish browser rendering, complete game export or
redistribution clearance. See the [devkit plan](../../../docs/plans/cocos4-mcp-devkit.md).

## Preparation

Use **Node 24.21.0** for this separate package, including rebuilding its `gl`
addon and running probes. The engine's Node >=18 and TypeScript 4.9.5 baseline,
and the separate MCP probe package, have not been upgraded. This package does
not contain or select an end-user devkit runtime.

The engine must already be prepared with its locked dependencies and real
external artifacts. The GL dependency may require a C++ compiler, make, Python,
Node headers, X11/EGL/GLES libraries and a functioning display/graphics driver.
The patched parser also requires **Khronos glslangValidator 16.4.0** as a real
GLSL preprocessor. Its version banner must start `Glslang Version: 11:16.4.0`.
The default path is `/usr/bin/glslangValidator`; `COCOS_EFFECT_GLSLANG` can select
another absolute executable path, subject to the same version check. No fallback,
automatic download, fake context or diagnostic suppression is used. These are
maintainer host requirements, not a restored native engine backend.

From the engine repository root:

```sh
# On this checkout, select the already-installed Node 24 binary for node/npm:
export PATH="$PWD/tools/devkit/build/node24/package/bin:$PATH"
node --version
glslangValidator --version
npm ci --prefix tools/devkit/effects --ignore-scripts --engine-strict --no-audit --no-fund
npm rebuild --prefix tools/devkit/effects gl --foreground-scripts
mkdir -p tools/devkit/build
git clone --filter=blob:none --no-checkout https://github.com/cocos/cocos-cli.git tools/devkit/build/effect-upstream
git -C tools/devkit/build/effect-upstream checkout --detach 8595d1b2f1dff34fb1111d3c5de88fc5f08da9f9
npm run prepare:source --prefix tools/devkit/effects -- ../build/effect-upstream
npm run probe --prefix tools/devkit/effects -- 2d-basic
npm run probe --prefix tools/devkit/effects -- 3d-basic
npm test --prefix tools/devkit/effects
```

Use an existing checkout instead of cloning again. `prepare:source` takes a path
relative to this package's working directory or an absolute path. It makes no
network requests and checks the exact source/license bytes against
`source-lock.json` before copying only the allowlisted files. Repeating it is
idempotent; modified or partial prepared sources are errors, not overwritten.
`build/compiler/` deliberately remains a pristine, byte-verified source cache.
`prepareCompiler()` in `prepare-source.cjs` verifies that cache again, applies the
audited patch, and atomically prepares a private compiler inside each probe's
staging directory. Neither the checkout nor installed `node_modules` is patched.

Dependency installation and GL rebuild are explicit, network-using maintainer
steps. npm 12's `allowScripts` field authorizes **only `gl`** in this package.
On the tested host no Node 24.21 prebuild existed, so node-gyp compiled the addon
against downloaded, checksum-checked Node headers. Upstream C++ and deprecated
prebuild-install warnings remain visible. Never disable TLS verification or
replace the GL validator with a fake context.

## What Runs

`npm run build:offline-mappings` at the engine root is also available separately.
It builds the real `cc/editor/offline-mappings` export into CommonJS using the
existing ccbuild/Rollup/TypeScript toolchain, with type errors and unresolved
imports fatal. Build constants come from `StatsQuery`, using NODEJS/BUILD, with
NATIVE and JSB false. It does not prepare/download dependencies automatically.

The mappings entry now imports concrete owners rather than core/GFX barrels.
Three rendering enums moved into a shared leaf module; their old exports,
reverse mappings, values and `cclegacy.RenderPassStage` identity are preserved.
The resulting module needs neither `cc`, `nodeEnv`, PAL, Creator nor injected
test globals. Root Jest is scoped to the engine `tests/` directory so an ignored
upstream checkout cannot silently add a different project's tests.

`probe.cjs` performs the following steps:

1. Validate the pinned compiler source and create a fresh staging directory.
2. Compile the actual mappings and provide a private, local `cc` package bridge.
3. Prepare and verify the patched compiler. Launch a bounded worker with the
   current absolute Node executable and a small host-graphics environment
   allowlist, without NODE_OPTIONS or NODE_PATH.
4. Derive the chosen feature list's `dependentAssets` from `cc.config.json`,
   resolve original UUIDs through metadata, follow material Effect references,
   and register the checked-in shader chunks.
5. Compile every selected Effect with language preprocessing, parser checks and
   host WebGL1 compile/link checks enabled. Both errors and warnings are fatal.
   Run eight compiler regressions, including active-invalid branch and real
   driver failures. The driver receives the original conditional GLSL, not the
   preprocessor output used by the AST parser.
6. Emit an unpacked candidate `assets/internal/` bundle, named materials,
   settings fragment and an input/output SHA-256 report. Recheck source hashes,
   patched compiler bytes and the preprocessor executable digest
   before promoting a new artifact directory. Failure removes only its staging
   directory and preserves prior successful artifacts.

The original compiler's `throwOnError` flag alone is insufficient: its common
error path checks `throwOnWarning`. Both are enabled. `skipParserTest` remains
false. The upstream `build.js` wrapper, which disables that parser, is not used.

Output goes to ignored `build/artifact-*/`. Compiler sources, private Node module
bridges and build tools are removed from these candidate resource directories.
Failures retain diagnostics in `build/failure-*.log`; these P0 logs do not yet
implement production job retention. `result.json` records inputs, files,
compiler revision/original hashes, patch version/script/output digests and
provenance, preprocessor path/version/executable digest, mapping digest,
dependency-lock digest, regression names, strict options and verification levels.
No package directory is overwritten or treated as a successful game.

## Results

Verified on Linux x64 with Node 24.21.0, `gl@9.0.0-rc.10`, reported renderer
`ANGLE`, context version `WebGL 1.0 stack-gl 9.0.0-rc.10`, and glslangValidator
16.4.0. These counts refer only to the configured builtin asset closure.

| Check | Result |
| --- | --- |
| Pinned source preparation, repeated preparation and tamper rejection | Passed |
| Deterministic patch; revision, script/output digest and output-tamper guards | Passed |
| Actual 2D builtin roots | 5 Effects, 6 shader programs, 10 materials |
| Full configured 3D builtin roots | 8 Effects, 9 shader programs, 10 materials |
| Repeated 2D and 3D compilation | Identical resource, input and mapping SHA-256 digests |
| Conditional expression and disabled GLSL3 branch | Accepted after real preprocessing; emitted branches retained |
| Active invalid branch | Parser rejects with EFX2404 |
| Active `uint` branch / undeclared identifier | Real WebGL1 driver rejects with EFX2406 |
| Preprocessor error/warning and compiler warning | Fatal, not suppressed |
| Missing preprocessor after successful 2D compilation | Prior artifacts unchanged; staging removed |
| Effect package tests | 6 passed; 8 compiler regressions per successful probe; no skips |

The 2D Effects are `builtin-graphics`, `builtin-sprite`, `builtin-clear-stencil`,
`splash-screen` and `builtin-unlit`. The latter has two shader programs. This is
the configured **builtin asset** closure, not all profile runtime dependencies.
It does not compile `dependentScripts`, user assets or user game code.
The 3D profile adds `skybox`, `deferred-lighting` and `planar-shadow`; no configured
root or material Effect reference is dropped.

All GLSL1/3/4 sources are generated, but the compiler's driver validation uses
WebGL1 and its representative macro configuration, not all runtime permutations.
WebGL2 driver compilation, loading/deserializing this bundle through the real
asset manager, decorated game code, pixels, input, audio and scene restart
remain unverified. The report explicitly marks these boundaries.

## Compiler Patch

The unpatched fixed revision reproducibly failed before driver validation:

```text
deferred-lighting.effect - lighting-fs - 0:
Error EFX2404: glsl1 parser failed: Error: did not use all tokens
```

The compiler's `miscChecks` in upstream `shdc-lib.js:1205` removes preprocessor
directive tokens, but not the code in disabled conditional branches, before invoking its
GLSL1 AST parser. `deferred-lighting.effect` includes clustered-lighting buffer
and unsigned-integer code behind `CC_ENABLE_CLUSTERED_LIGHT_CULLING`; that code
reaches the parser even when not enabled. Stripping directives also concatenates
mutually exclusive expression branches into invalid syntax.

Patch **`glsl1-conditional-validation`, version 2** is maintained only in
`compiler-patch.cjs`, with its SHA-256 and resulting `shdc-lib.js` SHA-256 locked
in `patch-lock.json`. `source-lock.json` retains every original upstream hash.
Version 2 accepts the reviewed glslang banner with either LF or Windows CRLF;
it still rejects different versions, extra banner text, warnings and errors.
All source bytes are verified before loading/applying the patch, each replacement
anchor must occur exactly once, and the complete patched output must match its
locked digest. Repeated preparation is idempotent; tampered destinations fail
without replacement. The prepared manifest and artifact report retain provenance.

The patch hoists the existing `getDefineString` implementation unchanged so both
the AST preprocessor and driver use the upstream representative define policy.
Before lexical/AST checks, `glslangValidator --stdin -E -S vert|frag` evaluates
GLSL100 conditionals and macros. Its process is bounded; nonzero exit, any stderr,
missing executable or an unreviewed version fails closed. The ordinary parser
still runs, and WebGL1 independently compiles/links the unpreprocessed source.
No shader output, reflection metadata, Effect roots or compiler strict flags
are rewritten to obtain a passing result.

This validates representative macro configurations, not every runtime permutation.
The parser processes each stage's extracted defines; the final driver uses the
merged program defines. glslang and the host driver can advertise different
extension macros, so their preprocessing environments are not claimed identical.
Driver validation of the original conditional source remains necessary. An
upgraded preprocessor/compiler needs a new audit and lock update, not a relaxed
version guard. Browser/WebGL2 and vendor-device validation remain separate work.

## Reusable Artifacts

Successful, retained candidate directories on the tested checkout:

```text
2d-basic: /home/shishanyue/GitHub/cocos4/tools/devkit/effects/build/artifact-hJGwrf
3d-basic: /home/shishanyue/GitHub/cocos4/tools/devkit/effects/build/artifact-5flSlp
```

Each contains `assets/internal/config.json`, `assets/internal/index.js`, original
UUID-based Effect/material JSON under `assets/internal/import/`,
`settings.fragment.json`, and the auditable `result.json`. These are real compiled
resources for a runtime agent to load and validate, not proof of runtime loading
or rendering. The 2D directory has 18 hashed resource files; 3D has 21. Test-created
artifacts are removed by their own test cleanup; these separately generated
directories are retained. Failed probes cannot replace them.

## Licenses

The prepared compiler retains the original LICENSE and package metadata, which
disagree (MIT versus ISC). Engine license/header questions from the parent P0
report remain unresolved. The host GL addon includes ANGLE and other third-party
components with separate notices. No compiler, native host addon, font or
candidate resource bundle is approved for redistribution by these tests.
