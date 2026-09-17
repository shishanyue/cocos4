# No-Creator HTML5 Runtime

Maintainer pipeline for two fresh ccbuild `HTML5` / `BUILD` / SystemJS profiles.
This is not a complete game SDK, Creator replacement, or vendor publisher.
Only an existing, verified builtin artifact is accepted; shaders are not
recompiled here. Outputs are published atomically and existing paths are refused.

## API

```js
const { buildRuntime } = require('../scripts/build-runtime.cjs');
const result = await buildRuntime({
    profile: '2d-basic', // or '3d-basic'
    builtinDirectory: '/absolute/path/to/verified-effect-artifact',
    outDirectory: '/absolute/path/to/absent-output',
});
// { output, descriptor, profile, sha256, validationLevels }
```

The output parent must already exist and be canonical (no symlink ancestors).
Source builds require the prepared engine, external Web/WASM inputs, root npm
dependencies, and `tools/devkit` loader dependencies. Declarations are generated
from a private source snapshot; root `bin/` and declarations are not overwritten.

The reusable `runtime.json` descriptor has `delivery: "PREBUILT"`, profiles,
feature flags, engine/loader/compiler versions, builtin provenance, and a SHA-256
inventory of every file other than the descriptor itself. The returned `sha256`
binds the descriptor. Its compile-time validation levels intentionally do not
claim browser success. Browser evidence is a separate hash-bound report.

Important output paths:

- `index.html`, `boot.js`, `loader.js`, `import-map.json`, `settings.json`
- `engine/cc.js` and any ccbuild dependency chunks/assets
- `assets/internal/` with verified effects/materials and its real bundle config
- `internal-prerequisites.js`, the SystemJS prerequisite for a script-free internal bundle
- `game/main.js`, `game/world.js`, `game-compiler.json`, `assets/game/`
- `template/` with editable decorated TypeScript, JSON, PNG and PCM WAV
- `types/cc.d.ts`, `types/cc.editor.d.ts`, `types/webGPU.d.ts`
- `builtin-report.json`, `engine-build.json`, `compiler-dependencies.json`

Map TypeScript `cc` to `types/cc.d.ts`; it references both companions. These are
the full engine declarations, not a falsely narrowed profile API. The generated
template has the correct relative mapping and can be checked directly with root
TypeScript 4.9.5. It follows the repository's `strict: true, noImplicitAny: false`
declaration-consumer baseline with **no skipped library checking**.

## Portable Compiler

Package the two CommonJS files and the locked dependency graph in this layout:

```text
SDK/toolchain/package.json
SDK/toolchain/compiler/compile-game.cjs
SDK/toolchain/compiler/files.cjs
SDK/toolchain/node_modules/...
SDK/<profile>/types/cc.d.ts
SDK/<profile>/types/cc.editor.d.ts
SDK/<profile>/types/webGPU.d.ts
```

The compiler has no source-checkout dependency when `toolchainDirectory` is
supplied. A regular `package.json` and the complete installed dependency/peer
closure must be present there. Before loading toolchain code, the compiler checks
the closure for symlinks/non-regular files and escaping package entry paths;
missing dependencies reject rather than falling back to ancestor packages.
The four compiler root versions below are fixed, including in check-only mode.
Its exact exported API is:

```ts
compileGame(options: {
    projectDirectory: string;
    typesDirectory: string;
    outDirectory?: string;       // Required unless checkOnly is true.
    toolchainDirectory?: string; // SDK/toolchain; omission retains maintainer root resolution.
    checkOnly?: boolean;         // Default false. Does not emit or create directories.
    availableCCExports?: string[]; // Caller-validated actual runtime exports, not declarations.
}): Promise<{
    requiredCCExports: string[];
    typeChecked: true;
    profileChecked: boolean;
    checkOnly: boolean;
    emitted: boolean;
    diagnostics: Diagnostic[];
    outputFiles: string[];       // Relative .js paths; empty for checkOnly.
    typescript: string;
    babel: string;
    preset: string;
    decorators: 'legacy';
    useDefineForClassFields: false;
    typeChecking: {
        strict: true;
        noImplicitAny: boolean;
        skipLibCheck: false;
        skipDefaultLibCheck: false;
        allowJs: true;
        checkJs: true;
    };
}>;

type Diagnostic = {
    code: number | 'UNSUPPORTED_PROJECT' | 'FEATURE_NOT_IN_PROFILE';
    severity: 'error' | 'warning' | 'info';
    message: string;
    file: string | null;
    line: number | null;
    column: number | null;
};
```

Diagnostic source locations are one-based. `file` is a slash-separated project
relative path such as `src/main.ts`, or a logical SDK path `types/cc.d.ts` or
`toolchain/node_modules/typescript/lib/lib.dom.d.ts`; it is never an absolute
host path. Missing locations are `null`. TypeScript diagnostic codes are numbers.

Failures **reject**, including in check-only mode. Errors carry `.code` and a
nonempty `.diagnostics` array, including invalid options and filesystem errors;
the stable error codes are `UNSUPPORTED_PROJECT` (unsupported
layout/config/imports/toolchain or filesystem failure), `FEATURE_NOT_IN_PROFILE`
(named runtime imports/reexports unavailable), and `TYPECHECK_FAILED` (syntax or
semantic errors). MCP may map the last code to `PROCESS_FAILED` while retaining
the structured diagnostics. A wrong decorated number property produces:

```json
{
  "code": "TYPECHECK_FAILED",
  "diagnostics": [{
    "code": 2322,
    "severity": "error",
    "message": "Type 'string' is not assignable to type 'number'.",
    "file": "src/main.ts",
    "line": 3,
    "column": 63
  }]
}
```

```js
const { compileGame } = require('/path/to/SDK/toolchain/compiler/compile-game.cjs');
const metadata = await compileGame({
    projectDirectory: '/path/to/project',
    typesDirectory: '/path/to/SDK/2d-basic/types',
    toolchainDirectory: '/path/to/SDK/toolchain',
    checkOnly: true,
    availableCCExports: validatedRuntimeExports,
});
```

Emission requires an absent output directory with an existing canonical parent,
outside source, declarations and toolchain inputs. Validation and all transforms
finish before output creation. An output conflict rejects without replacement;
the caller should use a private staging directory for publication and clean it
if filesystem writes fail. Check-only ignores `outDirectory`, loads no Babel
transform code, and performs no filesystem writes.

The compiler always checks all ordinary `.ts`/`.js` files under `src/`, with
`src/main.ts` or `src/main.js` as the entry. `tsconfig.json` is optional; defaults
are ES2017/DOM, ESNext modules, node resolution, legacy decorators, strict checking
with the repository's `noImplicitAny: false` declaration baseline, and checked JS.
Both library-check skips remain false. `noImplicitAny` can be made stricter.

TypeScript uses an in-memory compiler host with **no `ts.sys` filesystem
delegation**. Inputs are snapshots of canonical, non-symlink source files, the
actual `cc.d.ts` reference closure, and bundled TypeScript `lib*.d.ts`. It cannot
discover project/ancestor `node_modules`, ambient types, or package.json files.
SDK declarations may reference other `.d.ts` files only within that types root.
Reads use realpath checks, no-follow file opens, and change checks.

Supported configuration is deliberately narrow: `compilerOptions`, source-only
`include` patterns and an inert `$schema`. `extends`, `references`, `files`,
`exclude`, `typeRoots`, `rootDirs`, plugins, arbitrary paths/types and options
that disable checking are rejected. Empty `types` and `baseUrl: "."` are allowed.
`paths` may contain only `cc`, mapped to the supplied declaration file or the
existing template hints `types/cc.d.ts`, `./types/cc.d.ts`, `../types/cc.d.ts`.
Those hints are not dereferenced: `typesDirectory` exclusively owns resolution.

Runtime imports must be named `cc` imports/reexports or closed relative `.js`
module specifiers. When `availableCCExports` is supplied, all named value imports
and reexports must be present; explicit type-only imports do not require runtime
exports. This checks static module linkage, not arbitrary runtime property access.
Runtime namespace/default imports, `export * from 'cc'`, and the untyped
`cclegacy` escape remain rejected even with an export list because their profile
linkage is not validated. Type-only namespace imports are allowed.
Dynamic imports, `require`, import-equals, namespaces/ambient modules, source
`.d.ts`, JSX, `import.meta`, project triple-slash references, `@ts-nocheck`,
`@ts-ignore` and `@ts-expect-error` are unsupported.
Import types, including JS JSDoc, use the same closed resolver.

Emission runs only the trusted `@cocos/babel-preset-cc` and SystemJS transform.
Babel project configs are disabled. No project plugins, package scripts, JS
configuration or game modules execute. The caller still owns SDK authenticity,
resource/time limits, immutable workspace staging and asset copying. This is not
an OS sandbox against concurrent same-user filesystem mutation or malicious
toolchain code. Asset format/import policy belongs to the workspace wrapper.

Compiler packaging inputs are the two files above and the dependency graph in
`compiler-dependencies.json` (84 locked packages at verification time). Roots:
TypeScript 4.9.5, Babel core 7.19.6, Cocos Babel preset 2.2.0, SystemJS transform
7.22.5. Preserve nested npm paths, TypeScript's `lib/` declarations, and licenses.
This backend does not itself publish or validate the main SDK distribution.

## Verification

Run from the engine root. All runtime build/evidence paths below are ignored.

```sh
node --test tools/devkit/test/runtime.test.mjs
RUNTIME_COMPILER_FIXTURES=tools/devkit/runtime/build/acceptance-Js6TDR \
node --test tools/devkit/test/runtime.test.mjs
RUNTIME_INTEGRATION=1 \
RUNTIME_CHROME=/absolute/path/to/current/chrome \
RUNTIME_BUILTINS_2D=/absolute/path/to/verified-2d-artifact \
RUNTIME_BUILTINS_3D=/absolute/path/to/verified-3d-artifact \
node --test tools/devkit/test/runtime.test.mjs
```

Integration tests build both profiles from source, typecheck both decorated
templates (including rejection of an invalid decorated property), and retain
artifacts in `build/acceptance-*/`. Isolated unit runs explicitly skip this
expensive test, never report it as browser evidence.

`RUNTIME_COMPILER_FIXTURES` selects an existing pair of browser-verified profile
artifacts. The compiler test copies the two compiler files, real declarations,
templates and 84 locked packages outside the checkout, blocks checkout module
loads and default TypeScript filesystem calls, and verifies check-only writes,
escape rejection, structured TS/JS diagnostics and byte-identical fixture output.
It extracts actual export names from each existing `engine/cc.js` and checks the
2D rejection / 3D acceptance of `MeshRenderer`; it also injects a companion
declaration error to verify that library checking remains enabled. Toolchain
tests cover missing dependencies, version mismatch, malicious entry paths and
symlinked manifests/transitive code, without loading checkout or ancestor code.
Set `RUNTIME_TOOLCHAIN` to reuse an SDK owner's packaged `node_modules` in this
isolated test instead of copying the existing lock graph. With the fixture
variable set, Node 18.20.8 and 24.21.0 each pass 7 tests with 1 expensive browser
integration test explicitly skipped. Both profiles emit byte-identical game
modules, and check-only performs zero writes. These checks do not rebuild or
modify the browser artifacts and are not new browser/device evidence.

```sh
node tools/devkit/scripts/build-runtime.cjs 2d-basic /builtin/artifact tools/devkit/runtime/build/my-2d
node tools/devkit/runtime/verify-browser.cjs tools/devkit/runtime/build/my-2d /absolute/chrome tools/devkit/runtime/build/my-evidence
```

`verifyBrowser({ runtimeDirectory, executablePath, outDirectory, headless })`
requires an explicit host Chrome binary and verifies the entire artifact before
serving its allowlisted files on loopback. Real Chrome/ANGLE SwiftShader WebGL2
renders screenshots, PNG sprite pixels and 3D mesh pixels. Tests exercise mouse,
touch, keyboard, ten full scene restarts, portrait resize/touch, JSON/image/audio
loading, real native WebAudio PCM/start/end, and a deliberate missing-image 404.
The report retains console output, requests, screenshots and hashes on failure.

## Boundaries

- ccbuild explicitly targets Chrome 100 syntax; only the reported current host
  version is browser-tested. The untargeted legacy Babel path was observed to
  emit an undefined `_i` in `insertBuiltinBindings`. No generated bundle or
  engine source is patched to hide it.
- Shared sprite/audio/mesh/material assets are intentionally retained for the
  application lifetime; scenes and event subscriptions are recreated on restart.
- Software WebGL is real rendering, not physical GPU or vendor-device evidence.
  Native WebAudio playback/PCM evidence is not physical speaker verification.
- Portrait resize currently logs PAL's `Unexpected screen orientation: 13` on
  this desktop Chrome host; layout and touch are independently checked.
- Engine, loader and compiler license/redistribution review, the main SDK
  distribution, arbitrary asset import, vendor publishing and real devices remain
  outside this pipeline's completed validation.
