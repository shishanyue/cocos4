# Engine Source Map

Paths are relative to the engine root. Follow actual call sites and exports;
filenames alone do not establish runtime reachability.

**Ownership Map**
| Concern | Inspect/edit | Important connection |
| --- | --- | --- |
| Feature selection and platforms | `cc.config.json`, `cc.config.schema.json`, `exports/` | Feature IDs select modules and override PAL imports; a template is not an allowlist entry |
| Startup and frame order | `cocos/game/game.ts`, `cocos/game/director.ts`, `cocos/root.ts` | PAL startup, component/system ticks, deferred destruction and rendering |
| Scene/lifecycle | `cocos/scene-graph/node.ts`, `component.ts`, `node-activator.ts`, `component-scheduler.ts` in the same directory | Activation, parent changes, events, transforms, scheduling |
| Math/core/serialization | `cocos/core/`, `cocos/serialization/` | Caller-owned outputs, decorators, stable serialized data |
| Assets | `cocos/asset/asset-manager/`, `cocos/asset/assets/` | Loading pipeline, dependency references, release manager and original resource data |
| 2D/UI | `cocos/2d/`, `cocos/ui/` | `UITransform`, `Batcher2D`, dirty state, canvas/camera coordinates |
| GFX and rendering | `cocos/gfx/`, `cocos/render-scene/`, `cocos/rendering/` | Device/backend abstraction, render scene, pipeline and effects |
| 3D/animation | `cocos/3d/`, `cocos/animation/`, `cocos/particle/` | Feature registration, skeletal animation and runtime/editor consumers |
| Physics | `cocos/physics-2d/`, `cocos/physics/` | Distinct frameworks and backends; builtin collision is not full dynamics |
| Input/audio | `cocos/input/`, `cocos/audio/`, `@types/pal/` | Platform contracts and lifecycle, not direct vendor globals in shared algorithms |
| Editor API | `editor/exports/`, `editor/engine-features/`, `editor/assets/` | Public editor modules, feature metadata, serialization and Inspector integration |
| Tests | `tests/`, `scripts/tests/minigame.test.cjs`, `scripts/test-declarations/test.ts` | Runtime behavior, tooling boundaries, consumed public types |

The base entry `exports/base.ts` also establishes registration/import order.
Before moving imports or removing `legacyCC` assignments, trace startup and
editor consumers. Tree-shaking is not proof that a registration side effect is dead.

**Generated Boundaries**
| Generated location | Source of truth / action |
| --- | --- |
| `pal/` | `scripts/spread-pal.cjs` and pinned `@cocos/engine-pal`; copied JS/declarations are required by relative imports and Creator |
| `bin/adapter/` | `scripts/spread-adapter.cjs` and pinned `@cocos/engine-platforms`; only minigame/runtime/nodejs groups |
| Patched files under `node_modules/` | `scripts/patch-ccbuild.cjs`; reapply with `prepare:engine` |
| `@types/consts.d.ts` | `cc.config.json`; run `npm run build:const` |
| `DebugInfos.json` | `EngineErrorMap.md`; run `npm run build:debug-infos` |
| `external/emscripten/`, `external/licenses/`, `external/.version` | `external-config.json`, `scripts/setup-external.cjs`; install real artifacts with notices |
| `bin/.declarations/`, `bin/minigame/`, `bin/dev/` | Checked build scripts; never repair output by hand |
| Generated portion of `cocos/gfx/base/define.ts` | `scripts/gfx-define-generator/GFXDef-common.h` and `generate.js` |
| `editor/engine-features/schema.json` | `editor/engine-features/types.ts`, `generate-schema.js` |

Some files under `cocos/rendering/custom/` contain generated-section warnings.
Inspect the warning and locate its actual generator before editing; do not invent
a native build dependency when a generator is unavailable.

`external/compression/` and `external/deserialize/` are retained source, not
disposable downloads. `vendor/wasm/spine/` and `vendor/wasm/spine-wasm/` retain
third-party source/licenses. A C++ file here does not imply native application support.

**Platform Routes**
| Route | Current platform IDs |
| --- | --- |
| Development | `HTML5`, `NODEJS` |
| `MINIGAME` | `WECHAT`, `WECHAT_MINI_PROGRAM`, `BYTEDANCE`, `ALIPAY`, `TAOBAO`, `TAOBAO_MINIGAME`, `XIAOMI` |
| `RUNTIME_BASED` | `OPPO`, `VIVO`, `HUAWEI`, `HONOR`, `MIGU`, `COCOS_RUNTIME`, `SUD`, `SUDV2` |

Verify this table against `cc.config.json` on each platform change. Xiaomi's name
does not put it in the runtime route. WeChat Mini Program is a distinct container.
Huawei quick games do not imply OpenHarmony native publishing. Baidu's retained
template is not allowlisted; Facebook Instant Games is a retained HTML5 template.

For PAL defects, reproduce the selected route and inspect `cc.config.json`
overrides, ambient contracts in `@types/pal/`, and the preparation-script owner.
Do not trust the upstream adapter package's native support claims for this fork.

**Change Review**
- Public API: export reachability, feature inclusion, runtime/editor declarations,
  optionality, overloads and no unintended `any` widening.
- Lifecycle: initial activation, repeated enable/disable, hierarchy changes,
  deferred destruction, asynchronous completion and global listener teardown.
- UI/rendering: dirty flags, batching, camera masks, bounds, pointer coordinates,
  backend parity and actual GPU reproduction where needed.
- Assets: serialized dependency ownership, dynamic references, shared consumers,
  force-release behavior and persistent/pooled objects.
- Platform/tooling: both mini-game/runtime routes, HTML5/Node consumers when
  affected, immutable native constants and dependency patch guards.
- Compatibility: preserve actual shipped/serialized contracts; do not add speculative
  fallback layers. Ask about migration requirements when the contract is unclear.
