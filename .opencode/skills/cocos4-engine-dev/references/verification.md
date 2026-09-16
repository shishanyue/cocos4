# Engine Verification

All commands run from the verified engine root. Inspect existing artifacts before
running commands that replace them; do not erase another task's outputs casually.

**Preparation**
Use the committed lockfile and a supported Node version (`.nvmrc` is the local
version hint). On a fresh checkout:

```sh
npm ci
npm run setup:external
```

`npm ci` invokes `postinstall`/`prepare:engine` and replaces installed dependencies.
Do not reinstall needlessly while debugging a prepared worktree. Preparation applies
version-checked patches, copies filtered PAL/adapters, and generates debug info and
constant declarations. It does not download the external WASM assets.

For an existing offline source, use its root containing `emscripten/`, not the
`emscripten/` subdirectory itself:

```sh
npm run setup:external -- --source /absolute/path/to/cocos-engine-external
```

Read `external-config.json` for the required revision. Baseline is
`cocos/cocos-engine-external@v4.0.0-9`. Use complete real artifacts and applicable
license notices. The installer checks required nonempty files and symlink safety;
this does not certify a partial cache's provenance, licenses, or binary behavior.
Do not create fake declarations/binaries outside isolated filesystem test fixtures.

**Commands And Evidence**
| Command | What it verifies or produces |
| --- | --- |
| `npm run prepare:engine` | Version/content guarded dependency preparation and generated inputs |
| `npm run test:platforms` | Node tooling tests: allowlist/constants, preparation, patches, declaration bundler fixtures, external setup and CLI rejection |
| `npx tsc --noEmit --pretty false` | Source type check using the installed compiler/config |
| `npm run build:declaration` | Constants, source types, declaration bundling, then public API consumer checking |
| `npm run test:dts` | Consumer check of existing declarations only; stale output stays stale |
| `npm test -- --runInBand` | Source type check followed by Jest |
| `npm run build:minigame -- WECHAT` | Source check and engine bundle in `bin/minigame/wechat/` |
| `npm run build:minigame -- OPPO` | Equivalent runtime-route bundle in `bin/minigame/oppo/` |
| `npm run build:dev` | HTML5 SystemJS engine modules in `bin/dev/cc/`, not a preview server |
| `npm run build:cli-min` | NODEJS-targeted SystemJS engine modules in `bin/dev/cc-cli-min/`, not a standalone Node game |

`build:declaration` replaces `bin/.declarations/`, including `cc.d.ts`,
`cc.editor.d.ts`, and referenced `webGPU.d.ts`. Source types alone do not prove
that bundled API names, private aliases, tuples, accessors or templates survived.
Add consumer assertions to `scripts/test-declarations/test.ts`, including focused
`@ts-expect-error` checks when needed to detect accidental widening.

Mini-game CLI accepts only a platform and a comma-separated feature list.
Default platform is `WECHAT`; default features are
`base,2d,ui,audio,tween,gfx-webgl,gfx-webgl2`. Explicit features replace defaults;
avoid spaces inside the list. Output is BUILD-mode, uncompressed SystemJS with
source maps. Successive feature builds share an output directory and may leave
stale files. Preserve build provenance; do not measure it as a final release package.

HTML5/Node wrappers select all features when none are specified. They replace
their own output directories; the omitted-features/split-output message is expected.
Do not assume every wrapper performs the same explicit type-check gate.

**Focused Tests**
```sh
npm test -- --runInBand --runTestsByPath tests/ui/ui-transform.test.ts
npx eslint cocos/2d/framework/ui-transform.ts
node --inspect-brk node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/ui/ui-transform.test.ts
```

Direct Jest debugging bypasses the npm script's preceding `tsc`; run it separately.
Do not add a nonexistent root `lint` script to instructions. Select actual changed
files for ESLint and avoid formatting unrelated source.

- Jest discovers `*.test.ts` and `*.spec.ts`; legacy `test-*.js` files are not the
  current suite pattern. Inspect `jest.config.js`, `babel.config.js`, `tests/init.ts`.
- Setup initializes a headless game, web PAL mocks, builtin resources and WASM
  imports. Some physics tests still instantiate real external binaries.
- `cc` maps to `exports/base` in engine Jest tests, not every optional feature.
  Follow nearby tests for optional-module imports.
- Per-suite constants use adjacent `filename.test.ts.config.json` files with
  `constantOverrides`; never enable native/JSB to exercise removed paths.
- Lifecycle tests should create/tear down their scene and unregister global systems.
  See `tests/tween/tween.test.ts`; physics suites await backend initialization.
- Use `tests/utils/log-capture.ts` for expected engine diagnostics; unconsumed
  captured warnings/errors fail teardown. Do not blanket-silence console output.
- Serialization tests use checked fixtures in addition to ordinary Jest snapshots.
  Inspect their harness before updating snapshots; `-u` is not a universal generator.

Choose assertions on observable behavior: expected events, transforms, resource
counts, lifecycle order, platform rejection and emitted API types. A reproduction
should fail without the fix; output-file existence alone is not sufficient.

**Failure Triage**
| Symptom | Investigate before changing engine behavior |
| --- | --- |
| Missing PAL, constants or debug metadata | Skipped lifecycle scripts; run `prepare:engine` |
| Missing PhysX/Box2D/Spine/WebGPU types in a small 2D build | Root type config includes all external declaration families; install complete externals |
| Patch version/content mismatch | Review upstream ccbuild/tfig/PAL changes; never loosen guards to force installation |
| Source compiles but declaration consumers fail | Feature exports, tfig alias/private import/template/accessor patches, compression mirroring and WebGPU ambient types |
| Unsupported platform or native flag | Expected allowlist enforcement; template/OS names are not build IDs |
| Browser works, mini-game/runtime fails | Selected PAL/adapter, host capability, lifecycle, URL/subpackage rules; reproduce in that container |
| Creator preview uses old external paths | Actual editor build dependency, `/engine_external/` route and `query-engine-info.typescript.path` |
| Files emitted despite type diagnostics | Preserve explicit `tsc` gates; ccbuild can downgrade diagnostics to warnings |
| Network or integrity errors | Registry/Git access, pinned revision, offline source; never disable TLS/integrity |

Do not casually run `npm run clear`: `scripts/clear-cache.js` removes paths from
`.gitignore`, including dependencies, PAL, build output and potentially IDE state.
Use a narrowly scoped, explicitly justified clean only after checking ownership.

**External Acceptance**
Actual Creator must use the patched build dependency and serve this fork's
`external/` at `/engine_external/`. The editor/preview server and complete vendor
builders are not in this repository. Consult `.github/WEB_CI.md` for external CI
profiles, plugins, projects and device dependencies; local scripts are not proof
those external jobs avoid native publishing.

Only for Spine source changes, use the documented EMSDK/CMake/Ninja workflow in
`vendor/wasm/spine-wasm/README.md`. The release helper temporarily patches SDK
embind source and restores it on exit; do not share that SDK with concurrent builds.
Do not require Emscripten or native application SDKs for ordinary TypeScript work.
