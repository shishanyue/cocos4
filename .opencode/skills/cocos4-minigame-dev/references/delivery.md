# Game Delivery

Use the game's actual Creator/builder workflow. Engine-relative paths below are
evidence, not files to copy wholesale into a new game.

**Bootstrap And Modules**
1. Identify the game project, compatible editor installation, engine revision and
   vendor builder. Inspect existing configuration before changing any of them.
2. Confirm the editor selects this fork and its patched build dependency. Browser
   preview must serve this engine's `external/` through `/engine_external/`; editor
   PAL uses `query-engine-info.typescript.path`. The complete server is not here.
3. If the engine is unprepared, follow its README for `npm ci`, `setup:external`
   and `build:declaration` from the engine root. Do not run these in the game root.
4. Use the real project's generated TypeScript configuration and declarations;
   preserve its Creator path mappings/decorator setup. Do not patch generated
   project caches or add a fake ambient `cc` module to silence errors.
5. Create/import assets through the verified editor workflow, preserve `.meta`
   identities, wire serialized properties, and inspect missing scripts/materials.

A small project can separate pure rules/data, scene Components, and platform/save
services inside its existing script layout. Separate boot/menu/game/results scenes
only when their loading/lifetime needs justify it; do not mandate a large scaffold.
Shared assets should not be duplicated across level bundles unintentionally.

Read current feature IDs and dependencies from `cc.config.json`, feature export
files under `exports/`, and `editor/engine-features/render-config.json`.

| Need | Selection guidance |
| --- | --- |
| Typical 2D UI game | Base, 2D, UI, chosen graphics backend; audio/tween when used |
| 3D gameplay | 3D/rendering plus animation/skeletal animation as needed; UI remains an independent choice |
| Physics | The right 2D or 3D backend, not just a framework export or both families by default |
| Spine/DragonBones/particles | Include the actual optional module and its runtime assets only when used |
| WebGPU | An optional retained backend, not a portable default for every mini-game host |

Engine smoke commands such as `npm run build:minigame -- WECHAT` validate selected
engine modules only. They do not import game assets, generate the full launch
application, set vendor app IDs, sign or upload a project. The default output is
uncompressed SystemJS, unsuitable as a proxy for final package-size acceptance.

Evidence: `README.md`, `scripts/build-minigame.cjs`, `cc.config.json`,
`templates/launcher/application.ejs`, `templates/wechatgame/game.ejs`.

**Platform Integration**
Use `cc.config.json.platforms` as the current engine allowlist. Current routes:

| Route | Targets |
| --- | --- |
| Mini-game | WECHAT, WECHAT_MINI_PROGRAM, BYTEDANCE, ALIPAY, TAOBAO, TAOBAO_MINIGAME, XIAOMI |
| Runtime quick-game | OPPO, VIVO, HUAWEI, HONOR, MIGU, COCOS_RUNTIME, SUD, SUDV2 |
| Preview/tooling | HTML5, NODEJS |

Each target still needs its actual builder/container acceptance. Do not infer
support from retained Baidu templates or upstream native platform documentation.
WeChat Mini Program forwards page/canvas events differently from Mini Game.
Runtime quick games require their own smoke run, not a renamed WeChat build.

For login, ads, share, purchase, leaderboard or cloud capabilities, verify current
vendor documentation and the installed SDK version. Keep secrets out of client
source and logs. Define success, cancellation, timeout and unavailable-capability
behavior. Do not grant rewards on an ad-open callback; use the appropriate verified
completion contract and prevent duplicate grants. Purchases and valuable state
need server-side authority appropriate to the project.

Do not invent current vendor size limits, permission names or upload commands.
Record their source/version. Never sign, upload or publish just to test a local
implementation without explicit authorization.

**Performance Workflow**
Establish budgets with the game's target devices and current vendor constraints.
Measure cold start, first interactive frame, warm start, main/subpackage sizes,
frame-time distribution and memory after repeated level entry/exit.

| Symptom | First measurements and likely levers |
| --- | --- |
| Slow first interaction | Boot dependency graph, remote/subpackage latency, shader/WASM initialization; postpone nonessential content |
| UI draw-call growth | Material/texture changes, masks, labels, atlas/batching breaks; preserve correctness before combining |
| Frame spikes | Per-frame allocations, repeated lookup/load/instantiate, large updates; cache stable references and reuse math outputs |
| High GPU time | Overdraw, transparent layers, shader complexity, resolution and 3D visibility; verify on the target GPU |
| Memory never stabilizes | Dynamic leases, persistent nodes, cached/checked-out pool instances, textures/audio and stale callbacks |
| Excess package size | Unused features, duplicated bundle dependencies, texture/audio formats and debug artifacts |

Pool only frequently recycled expensive objects and cap retention. Do not replace
profiling with "pool everything" or assume browser FPS predicts a low-end phone.
Compare the same scenario and build mode before/after each optimization.

**Acceptance Matrix**
| Layer | Required evidence for a claim of passing |
| --- | --- |
| Logic/types | Actual project type/lint/tests; deterministic rules, invalid input and state transitions |
| Creator integration | Custom engine selection, imported assets, scene/prefab wiring, declared features, preview external URLs |
| Browser interaction | Playable slice, restart, modal input, layout/safe-area simulation and first-gesture audio |
| Vendor tool build | A complete project package from the real builder, correct app/container configuration and resource paths |
| Real devices | Release-mode play on named devices/host SDKs, backgrounding, audio, touch, network and performance |
| Publishing | Authorized vendor validation/upload results; not inferred from any preceding layer |

Exercise the failure cases relevant to the change:

- Repeated enable/disable and level restart; no duplicate listeners or rewards.
- Exit/destroy before load completion, rapid close/reopen, navigation supersession;
  no stale commit or decrement of somebody else's resource reference.
- Multi-touch, cancel/end outside bounds, hide during drag, scaled/rotated parents,
  camera masks, modal interception and layout-controlled transforms.
- Tall/wide screens, orientation, high DPI and real safe-area insets.
- Cold/warm assets, offline/slow/failing requests, retries, subpackage dependencies,
  remote version updates and actual cache behavior after a published content change.
- Missing/corrupt/old-version saves, storage denial/quota and interruption while saving.
- First-gesture audio, mute, effect bursts, phone interruptions, hide/show and pause menu.
- The selected physics backend, masks/contacts, fast bodies, low FPS and pool reuse.
- Repeated long sessions; measure retained assets, live actors, pool capacity and memory.
- Release-mode minification, WASM URLs/loading, allowed domains, privacy/permissions,
  source-map handling and rollback metadata according to current vendor requirements.

For every unrun layer, state the missing tool, project, asset or device explicitly.
Keep test evidence tied to engine/editor/builder versions and exact feature sets.
Engine Jest fixtures and adapters in `bin/adapter/` are not a substitute for this
game's acceptance matrix. External CI prerequisites are documented in `.github/WEB_CI.md`.
