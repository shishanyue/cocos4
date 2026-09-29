---
name: cocos4-minigame-dev
description: Use when implementing Cocos4 SDK or existing Creator game code with cc components, code-created scenes, UI/touch, assets, audio, pooling, 2D/3D and mini-game platform services. Not for engine internals or native applications.
---

# Cocos4 Game Development

## Identify The Workflow

1. Locate the actual game root and read its instructions and existing code before
   editing. Keep gameplay in the game, not in SDK runtime files or engine sources.
2. In the SDK workflow, use [cocos4-devkit](../cocos4-devkit/SKILL.md) and its MCP
   catalog to identify the verified manifest, delivered template/profile, actual
   declarations and available operations. Never infer an engine root from this
   skill's filesystem location. Portable code starters do not require Creator.
3. For an existing Creator project, preserve `.meta`/UUIDs, serialized class names,
   scenes/prefabs and Inspector references. Check the selected editor version,
   custom engine and actual import/build workflow. The SDK's ordinary-code builder
   is not an importer for arbitrary Creator projects; use their verified editor
   workflow instead of synthesizing scene files or UUIDs.
4. Reuse existing target, dimensionality and controls. Ask only for a missing choice
   that blocks implementation. An engine version or an allowed target is not proof
   of profile inclusion, editor compatibility, vendor publishing or device support.

## Public API And Delivery

- Use named imports from `cc`, including `_decorator`, `Component` and `Node`.
  Do not import engine internals, `pal`, `cc.decorator` or `internal:constants`.
- Query offline API/example documents and check runtime export availability for
  the chosen profile. A full declaration describes more than a small engine bundle.
  Type-only declarations have no runtime export; owner-export metadata does not
  prove every member's runtime behavior or a minimal required feature set.
- Start from a delivered code-created `Scene`/`Node` template. Reuse its bootstrap
  and real assets. Changing code does not rebuild the engine or add physics/WASM
  features absent from the delivered profile.
- Native apps, JSB, APK/IPA and native simulators are unsupported. Resource fields
  such as `nativeAsset`/`nativeUrl`, resource `native/` folders, mobile OS checks and
  WASM/ASM.js remain legitimate web/mini-game concepts.
- Keep vendor SDK calls behind a small game-owned service with a browser/test
  implementation and explicit capability/errors. Do not assume DOM APIs, `wx`,
  `bl` or runtime globals work in every container. WeChat Mini Game is not a Mini
  Program; runtime quick games are not native OS apps.

## Implementation Loop

Build one playable slice: input, rule, visible feedback, success/failure and
restart. Keep deterministic rules separate from Components. Define ownership of
listeners, async requests, assets, nodes, timers and tweens before writing them.
Handle loading, retry, stale callbacks, repeated actions and hide/show transitions.
Do not introduce a framework when one component and a few functions suffice.

Lifecycle callbacks are synchronous: the engine does not await `async onLoad` or
`async start`. Use explicit readiness and failure handling. Bind/unbind stable
listeners in `onEnable`/`onDisable`. Disabling pauses scheduled callbacks, not
deletes them. Invalidate asynchronous generations, release only owned asset
references, and reset timers/tweens before pooled reuse.

## References

| Work | Reference |
| --- | --- |
| Resources, UI/input, lifecycle, audio, pooling and 2D/3D | [Runtime Contracts](references/runtime.md) |
| Asset formats, strict checks, profiles and acceptance levels | [SDK Delivery](references/delivery.md) |
| Single-touch, cancellation and listener cleanup without extra assets | [TapCounter.ts](examples/TapCounter.ts) |
| Real SDK declaration/export consumer check, no source checkout | [check-examples.mjs](scripts/check-examples.mjs) |

The component example is not a complete game. Attach it to an existing visible
UI node with a `UITransform`, assign a scene-owned `Label`, and call `reset` from
the game's restart action. It uses no external assets or editor serialization.
The checker type-checks it against real delivered declarations and named runtime
exports; it does not create a scene, execute the example or prove input/rendering.

Report files changed, scene/reference wiring, selected SDK/profile and checks
actually run. Keep type/logic results, browser play, vendor compilation and real
devices separate. Missing acceptance is a gap, not a reason to fabricate success.
