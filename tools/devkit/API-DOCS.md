# Offline API And Example Documents

Fresh `scripts/prepare-game-sdk.mjs` packs contain an optional
`manifest.apiIndex` descriptor for `docs/api-index.json`. It records the file
size, SHA-256, schema version, API symbol/member count and example count. The
original `manifest.docs` guide inventory is unchanged. Concrete saved readonly
and game packs without this descriptor continue to load, but advertise only
`availableKinds: ["guide"]`. No index means no API or example capability.

## Provenance And Validation

`src/api-index.ts` uses the SDK-contained TypeScript 4.9.5 parser. Its executable
bytes have a reviewed SHA-256 pin, in addition to the compiler closure checks;
rehashing an SDK cannot substitute arbitrary parser code. AST binding uses an
in-memory compiler host, no default libraries, filesystem resolution, project
configuration, plugins, language service or source execution. This is declaration
extraction, not a replacement for the compiler's full type check.

The index derives exports of the actual `declare module "cc"` from full
`cc.d.ts`. It resolves aliases, groups overloads/accessors, retains exact source
signature and JSDoc slices, and indexes declared class/interface/enum/namespace
members and explicit object-type members. Private/protected modifiers and
`@internal`, `@private`, `@protected` annotations are excluded, as is tfig's
synthetic `__private` namespace. Other underscore names are not hidden by a name
heuristic. Inherited members are documented at their declaring base; no duplicate
inherited surface or inferred type expansion is advertised. Class headers retain
their actual extends/implements clauses. Namespace/class headers are source
slices, not synthesized complete compilable declarations.

`api-<sha256>` IDs derive from qualified name and member role, not process-local
TypeScript IDs, absolute paths, SDK identity or source offsets. Overloads share a
document; static and instance members have distinct IDs. Examples use
`example-<sha256>` IDs derived from template identity and relative source path.
Examples are the complete delivered template `.ts`/`.js` source files, not
invented demos or a promise that individual files run independently. JSDoc
examples remain verbatim JSDoc, without runnable certification.

Every load recomputes the entire index and compares it to the parsed payload.
It binds all declaration bytes, all selected template sources, parser bytes and
each profile's runtime/export inventory. Export names are statically extracted
again from the actual System.register engine, never executed. Missing, duplicate,
fabricated or altered entries, positions, paths, hashes and metadata fail closed,
including when outer hashes are recomputed. The existing SDK inventory, path,
symlink, duplicate-JSON-key and compiler/runtime checks still apply.

These are consistency checks, not signatures or proof of source authenticity.
A complete replacement of sources and all associated provenance still requires
an independently trusted SDK distribution. Browser reports do not prove vendor
publishing or real-device compatibility. Every distinct full declaration byte
set is parsed separately. Identical document text and API metadata can share a
document with one actual source anchor and combined runtime availability. In a
mixed-declaration pack, `api.declarationHashes` records the full declaration sets
that supplied that exact document. Different signatures retain separate IDs and
their own source anchors; generated private names are never normalized. Secondary
variant IDs include a hash of their exact content and API metadata. Existing
single-declaration-set index values and IDs remain unchanged.

## Query Contracts

`cocos4_docs_search` accepts a case-sensitive literal `query`, `kind` of `api`,
`guide`, `example` or `all`, an optional delivered `profile`, and cursor/limit.
Search matches source text or the derived document title. It does not perform
regex, fuzzy matching, ranking by invented feature requirements, or link fetching.
It returns one first source match per document; title-only matches have no source
match. `matches.line/column` retain document-relative semantics. Indexed matches
also contain `matches.source`, with the exact source range and full-file hash.
No match is fabricated across the joins between declaration/JSDoc slices.

API result metadata:

- `api.qualifiedName`, `symbolKind`, `memberOf`: declaration-derived identity.
- `api.typeOnly`: no runtime value is declared, including aliases to interfaces.
- `api.exportName`: the top-level `cc` export to check, or null for type-only APIs.
- `api.linkage`: `export`, `owner-export`, or `type-only`.
- `runtimeAvailability[]`: profile/target/variant, `exportsSha256`, `engineSha256`
  and `status` of `export-present`, `export-absent`, or `type-only`.
- `api.featureRequirements: "unknown"`: minimal required features are not known.
  The retained `requiredFeatures: []` field is **not** proof that no features are
  required. Profile inventories establish membership, not minimal dependencies.

For members, `owner-export` verifies only the owner's top-level export, **not**
the existence of each runtime member, instance state, behavior or device support.
With a profile filter, APIs with absent owner exports are omitted; type-only APIs
remain visible. Without a filter, unavailable declarations remain discoverable
and report the absence. Template examples filter by their actual associated
profile, not by guessed portability. Guides are profile-independent.

`cocos4_docs_read` accepts a bounded ID string followed by SDK lookup, not an enum
of thousands of IDs. It returns UTF-8 pages, content SHA-256, total size, byte
offset and a session/query-bound cursor. API/example metadata accompanies each
page. `anchors[]` gives the intersecting source parts, their role, offsets in the
whole document, full-file SHA-256 and source start/end positions. Guide pages
also anchor to the original complete guide source. An anchor may cover more than
the current page; page offsets locate the requested portion within it. Byte
offsets are zero-based; lines and Unicode-code-point columns are one-based; ends
are exclusive. The content hash covers the entire document, not just the page.

The public schemas and types are exported by `src/api-index.ts` and re-exported
by `src/sdk.ts`: `apiIndexDescriptorSchema`, `apiIndexSchema`, `apiMetadataSchema`,
`exampleMetadataSchema`, `runtimeAvailabilitySchema`, `sourceRangeSchema`,
`documentIdSchema`, `ApiIndex`, `ApiEntry`, `ApiIndexInput`, `ApiProfileInput`,
`ApiTemplateInput`, `SourceRange`, and `RuntimeAvailability`.
`generateApiIndex(input)` additionally returns the verified renderable documents;
profile/template inputs use generic target strings, not an HTML5-only schema.
`ApiProfileInput.engineEntry` is required and comes from the validated runtime
descriptor, rather than an assumed engine directory.
`extractRuntimeExports(ts, text)` is a static helper, not an engine loader.

## Bounds And Trust

The index allows up to 100,000 entries and 64 MiB of index JSON and rendered
document text, 16 MiB per declaration/source document, and at most 16 profiles.
Search pages allow 1-100 results; read pages request 4-16,384 bytes. Both clamp
output to account for duplicated structured/text MCP responses and JSON escaping,
leaving the complete response below 64 KiB. Large documents are paginated rather
than silently truncated. Resources remain the bounded manifest summary and
selected guides. API/example IDs are available only through docs tools; arbitrary
SDK paths and unlisted resource URIs are rejected.

All document text, code, metadata and links are data, not tool permissions. No
documentation query executes templates, follows links, changes startup authority,
writes the SDK or requires an engine checkout or ambient TypeScript installation.

## Focused Verification

```sh
npm run build
node --test test/sdk.test.mjs test/game-sdk.test.mjs test/api-docs.test.mjs test/mcp.test.mjs
```

`API_DOCS_SDK_ROOT` can select an existing freshly indexed pack for the API suite.
Without it, the suite prepares a new pack from the genuine runtime inputs.
`GAME_SDK_RUNTIME_ROOT` selects the 2D/3D acceptance directory and
`GAME_SDK_INTEGRATION=1` makes missing runtime inputs an error.
`API_DOCS_LEGACY_SDK_ROOT` selects a concrete saved game pack without an index for
the compatibility test. The suite includes relocation with only copied tool
modules, zod, and the read-only SDK; Node's PATH and project resolution are absent.

## Mixed Runtime Packs

`runtimeDescriptorSchema`, `profileSchema` and `templateSchema` are discriminated
by `target`. `SdkProfile` preserves the correlation between target, entry,
engineEntry and its nested descriptor:

| Target | Runtime Schema | Entry | Engine Entry | Evidence |
| --- | --- | --- | --- | --- |
| `HTML5` | `html5RuntimeDescriptorSchema` | `index.html` | `./engine/cc.js` | Mandatory `browserReport` and screenshots |
| `BILIBILI` | `bilibiliRuntimeDescriptorSchema` | `game.js` | `./cocos-js/cc.js` | Mandatory `localReport`, no browser claims |
| `WECHAT` | `wechatRuntimeDescriptorSchema` | `game.js` | `./cocos-js/cc.js` | Mandatory target-specific `localReport`, no browser claims |
| `BYTEDANCE` | `bytedanceRuntimeDescriptorSchema` | `game.js` | `./cocos-js/cc.js` | Mandatory target-specific `localReport`, no browser claims |

Every game pack still requires HTML5 `2d-basic` and `3d-basic`. It may additionally
contain complete BILIBILI, WECHAT or BYTEDANCE pairs for each delivered variant,
never partial or cross-target substitutes. Mini-game packs require the verified API index. Saved HTML5 packs with or without
an index remain readable. HTML5 evidence checks are unchanged.

`validateBilibiliRuntime(descriptor, report, descriptorSha256, descriptorBytes)`
validates the strict `bilibiliReportSchema`, target constants, fixed basic-profile
payload closure, builtin identities, bootstrap source pins, preflight byte counts
and positive/negative mocked lifecycle evidence. Loading additionally binds the
builtin report, assets, settings, engine-build and compiler output inventories.
`bilibiliBootstrapHashes` pins the reviewed launcher, generated loader, adapters,
Application and bootstrap configuration bytes; upgrades require explicit review.
`validateMiniGameRuntime` additionally validates the WeChat and ByteDance local
contracts with their distinct loaded-module, adapter and startup-failure evidence.
`minigameBootstrapHashes` binds the reviewed target/variant bootstrap bytes.
`runtimeFileAllowed(file, target = 'HTML5')` is target-aware. Only the delivered
unsplit basic mini-game layouts are supported, not arbitrary extra chunks/files.

`runtimeValidationLevels` contains the per-target catalog gates. BILIBILI adds
`moduleClosure`, `canonicalPreflight`, `loaderBootstrapSharedGlobal`,
`loaderBootstrapDistinctGlobal`, `entryLifecycle` and `startupFailure` after the
shared engine/compiler integrity gates. These are local contract-mock evidence,
not browser, vendor-build or device proof. The report's explicit mock limitations
are retained verbatim. `RuntimeDescriptor`, `BilibiliRuntimeDescriptor` and
`BilibiliReport` types are also exported from `sdk.ts`.

`capabilities.export` and platform `exportAvailable` mean source-game-package
assembly capability, not vendor compilation, upload, final package size approval
or device certification. This interpretation also applies to persisted HTML5
packs whose export flags were already true.

`prepareGameSdk({base, runtimes, out, engineRoot?})` accepts runtime entries with
`runtime` and optional `browserReport` or `localReport`, according to the actual
descriptor target. Reports default to sibling `<runtime>-browser/browser-report.json`
or `<runtime>-local/local-report.json`. CLI `--browser-report` values are ordered
among HTML5 inputs, and `--local-report` values among all BILIBILI, WECHAT and
BYTEDANCE inputs in runtime order. If supplied, each list must cover its full
input group. The programmatic `browserReports`
and `localReports` arrays expose the same ordered form and cannot be mixed with
per-runtime overrides of the same kind. Compiler checks use target/profile/variant
directories to avoid collisions. HTML5 template IDs remain `<profile>-starter`;
Mini-game IDs use `bilibili-`, `wechat-` or `bytedance-` before `<profile>-starter`;
release templates insert `-release` before `-starter`.

`test/bilibili-sdk.test.mjs` covers the genuine mixed inputs, rehashed corruption,
cross-target evidence, distinct declaration variants, relocation and explicit CLI
reports. Set `COMBINED_SDK_ROOT` to test an existing combined pack. Reproducibility
checks must use the same readonly base; `BILIBILI_SDK_BASE_ROOT` selects that base
when it differs from `build/readonly-sdk`. Runtime inputs
default to the local final BILIBILI artifacts; `BILIBILI_SDK_2D_RUNTIME` and
`BILIBILI_SDK_3D_RUNTIME` can override them.

### Loader Memory

Full inventory validation and AST/index recomputation are intentionally retained.
On Node 18.20.8, the genuine four-profile pack aborted with a V8 heap-limit error
at `--max-old-space-size=128`; loading completed at `512`. Worker integrations must
provide a measured bounded heap and concurrency budget. A V8 old-space limit is
not a process RSS limit. Do not skip recomputation, ignore diagnostics or trim the
declaration surface to accommodate the old 128 MiB worker limit.
