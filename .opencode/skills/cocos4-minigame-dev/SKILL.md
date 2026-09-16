---
name: cocos4-minigame-dev
description: Use when building or debugging 2D/3D mini-games with this Cocos4 fork in a Creator game project, including cc components, prefabs, bundles, UI/touch, physics, audio, pooling, performance, WeChat and runtime quick-game integration. Not for engine internals, native apps, or generic upstream Cocos tutorials.
---

# Cocos4 Mini-Game Development

Build a maintainable game against the fork's public API. Treat the game project,
engine checkout, Creator installation, and vendor builder as separate systems.
Use `cocos4-engine-dev` only for an engine defect or engine/toolchain modification.

**Locate The Project**
1. Find the actual game root and read its instructions, scripts, TypeScript config,
   asset organization, scenes/prefabs and existing platform services. Do not place
   gameplay under the engine's `cocos/`, `exports/`, or `templates/` directories.
2. Resolve the selected custom engine checkout. This skill's repository-local
   engine root is three directories above its directory; all engine source paths
   in the references are relative to that root, not the game's working directory.
3. Verify Creator version, selected engine, builder extension and exact target
   container. Engine `4.0.0-alpha.34` and Creator metadata `3.8.8` are baseline
   identifiers, not a universal editor compatibility guarantee.
4. Clarify only missing decisions that block implementation: game project location,
   target container, 2D/3D and control scheme, or unavailable editor workflow.
   Reuse existing choices rather than asking for a complete specification again.

If no game project exists, use a verified compatible Creator creation workflow.
This repository supplies no `npm create cocos4` or complete game publisher.
Do not invent scene UUIDs, an editor CLI, or turn the legacy `templates/project.json`
into a modern project. Without Creator, pure TypeScript logic can still be developed;
report asset import, scene wiring and publishing as unverified.

**Scope And API Rules**
- Keep both 2D and 3D available; choose what the game actually needs. Ordinary game
  scripts use named imports from `cc`, including `_decorator`, `Component`, and `Node`.
  Do not import `cocos/...`, `pal/...`, `cc.decorator` or `internal:constants`.
- Verify optional API exports and selected features. The small engine smoke build
  omits physics, 3D and many optional systems; an API declaration is not module inclusion.
- `MINIGAME` and `RUNTIME_BASED` use distinct adapters. WeChat Mini Game and Mini
  Program are distinct containers; Huawei quick games are not native HarmonyOS apps.
- Native applications/JSB are unsupported. Do not add APK/IPA/native simulator
  workflows or restore native engine code. Original resource `native/` paths and
  mobile OS compatibility checks remain valid.
- Use engine APIs for ordinary input, assets, audio, storage and lifecycle. Put
  required vendor SDK calls behind small game-owned services with browser/test
  implementations and explicit capability/error handling. Do not scatter `wx` or
  runtime globals across gameplay or assume browser DOM APIs exist on every host.
- Preserve asset `.meta`/UUIDs, Inspector references and serialized class names.
  Use the verified editor asset workflow for moves and scene/prefab edits.

**Read On Demand**
| Work | Reference |
| --- | --- |
| Lifecycle, resources, navigation, touch, audio, pooling, physics | [Runtime Patterns](references/runtime-patterns.md) |
| Project setup, module choices, performance, platform/package acceptance | [Delivery](references/delivery.md) |
| Screen-owned asynchronous SpriteFrame with balanced references | [BundleSprite.ts](examples/BundleSprite.ts) |
| Single-pointer UI drag, local coordinates, cancellation and cleanup | [DragHandle.ts](examples/DragHandle.ts) |

Examples are components, not a complete game or drop-in framework. Read their
preconditions before adapting them. Prefer a local function/component over a new
service framework unless multiple real callers need the abstraction.

**Implementation Loop**
1. Establish one playable vertical slice: input, game rule, visible feedback,
   success/failure, and restart. Reuse the project's visual language and controls.
2. Keep deterministic rules/data separate from Components and vendor SDKs. Components
   own scene references and presentation; small explicit states gate loading,
   gameplay, pause, results and navigation. Do not build a general framework first.
3. Define ownership before adding asynchronous work: who owns the listener, request
   generation, asset reference, spawned node, pool, tween and audio source, and
   which lifecycle transition ends that ownership.
4. Implement both success and failure paths. Reject repeated navigation/actions,
   invalidate stale callbacks, expose loading/retry states, and preserve save data.
5. Verify the feature in the actual scene, then exercise disable/re-enable, scene
   exit during loading, pooling reuse, multi-touch cancellation, and app hide/show.
6. Measure the relevant release/device budget before optimizing. Change one major
   bottleneck at a time and compare repeatable cold/warm scenarios.

**Critical Contracts**
- Lifecycle callbacks are synchronous; the engine does not await `async onLoad` or
  `async start`. Use explicit readiness and error handling.
- Bind/unbind stable listener references in `onEnable`/`onDisable`. Clear gesture
  state on disable and app hide. Component disable pauses scheduled callbacks; it
  does not erase them. Reset timers and tweens before pooled reuse.
- High-level asset loaders do not expose a general abort handle. Generation checks
  reject stale results; they do not cancel downloads or parsing. Check errors,
  strict `isValid(owner, true)`, and the relevant active state before committing.
- Own dynamic assets with balanced `addRef`/`decRef`. Never decrement a reference
  you did not acquire or force-release shared assets as routine screen teardown.
- UI events can consume touches before global `input`. Track one touch ID when
  appropriate; screen, UI-world and parent-local coordinates are not interchangeable.
- Separate 2D/3D physics APIs. Builtin collision is not full dynamics; do not assume
  a Unity-style `fixedUpdate` exists or run a second physics loop accidentally.

**Verification And Handoff**
Run the game's existing type/lint/test commands, not guessed npm scripts. Type-check
against its selected engine declarations. The bundled example checker is separate:

```sh
node .opencode/skills/cocos4-minigame-dev/scripts/check-examples.cjs
```

Run that command from the engine checkout after generating declarations; it does
not validate the game project or execute a scene. For copied skills, supply the
engine root as the first argument to the checker.

Report game files changed, scene/Inspector wiring, enabled engine features, tests
actually run, tested container/devices, and remaining acceptance work. Distinguish
logic tests, browser preview, vendor tools, real-device release runs and final upload.
`npm run build:minigame -- WECHAT` creates only an engine bundle: never describe it
as a playable game package, successful vendor publishing, or a device test.
