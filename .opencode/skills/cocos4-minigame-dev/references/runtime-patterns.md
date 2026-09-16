# Runtime Patterns

Engine paths in this reference are relative to the selected engine checkout.
Verify implementation and public exports before applying a recipe to a newer version.

**Lifecycle And State**
| Hook | Typical ownership |
| --- | --- |
| `onLoad` | Cache components and validate serialized references on first activation |
| `onEnable` | Subscribe to input/global events; enter the active actor/screen scope |
| `start` | One-time work before first update, after initial activation setup |
| `update(dt)` / `lateUpdate(dt)` | Active work; `dt` is seconds, not milliseconds |
| `onDisable` | Unsubscribe, invalidate screen-bound work, clear gestures, stop/reset reusable work |
| `onDestroy` | Release remaining lifetime-owned references and services |

Lifecycle hooks are not awaited. Start async work explicitly and gate gameplay on
readiness. Register the same callback/target pair for `on` and `off`; a new
`.bind(this)` during teardown does not remove the previous callback.

`destroy()` is deferred. For async commits, use strict `isValid(object, true)` and
check relevant nodes, request generation and active state. `onDestroy` only runs
when `onLoad` completed: do not acquire external resources on never-activated
prefabs and rely solely on that hook. Scheduled callbacks pause on disable and
resume on enable; explicitly unschedule those that must not survive reuse.

Keep persistent services small. `director.addPersistRootNode` expects a root-level
scene child or an unattached node, not an arbitrary descendant. Do not persist a
whole level to keep one audio/save service alive.

Evidence: `cocos/scene-graph/component.ts`, `node-activator.ts` and
`component-scheduler.ts` in that directory; `cocos/core/data/object.ts`;
`cocos/game/director.ts`.

**Assets And Async Ownership**
Prefer Inspector references for fixed dependencies. Use a bounded `resources`
area for small shared loads and Creator-configured bundles for content groups.
Paths in `resources.load`/`bundle.load` are root-relative and extensionless; specify
the asset type. SpriteFrame subassets may require a path such as
`icons/coin/spriteFrame`; verify the imported asset, do not guess from a PNG filename.

Public calls are callback-based: `assetManager.loadBundle(nameOrUrl, callback)`,
`bundle.load(path, Prefab, callback)`, and `instantiate(prefab)`. The public bundle
type is `AssetManager.Bundle`, not a top-level `Bundle` import. Check `err` before
using callback data even where declarations show a non-null data type.

Use one explicit policy for each dynamic owner:

1. Begin a request and capture its generation. Increment the generation on
   replacement/exit. Do not assume a Promise or callback loader can be aborted.
2. Check errors first, then acquire a request-owned reference with `addRef` in the
   successful callback, before transferring through a Promise or committing it.
3. If the owner is stale/invalid, balance that request's reference with `decRef`.
   Otherwise transfer the lease to the active consumer. Never decrement a reference
   you did not acquire, or simply abandon cold-loaded assets in an unbounded cache.
4. Hold the lease while any owned sprite, instantiated object or pool depends on it.
   A loaded prefab's textures/audio are shared by its instances, not deep-cloned.
5. Detach/destroy consumers as appropriate, then balance only the references acquired
   by this owner with `decRef`. Keep teardown idempotent and account for deferred destruction.

Loading does not automatically create a permanent caller lease. Assigning a
SpriteFrame to a Sprite is not a dynamic lease either. Inspector-owned dependencies
and scene dependencies have separate tracked ownership; do not decrement them as
if your component acquired them. Scene auto-release is not a collector for arbitrary
game caches or detached pooled objects.

`assetManager.releaseAsset`, `bundle.release` and `bundle.releaseAll` force release
their targets; positive refcounts do not protect a force-released target. Avoid
these for routine screen cleanup with shared consumers. `removeBundle` removes
bundle metadata, not its loaded assets.

`loadRemote` image results are `ImageAsset`, not ready-made `SpriteFrame` objects.
Manage any runtime-created Texture2D/SpriteFrame wrappers explicitly. URLs without
extensions may need `{ ext: '.png' }`. Recalling `loadBundle` with a new version
does not hot-replace a cached bundle; basename collisions and cache/update behavior
need a deliberate content-version strategy.

Use [BundleSprite.ts](../examples/BundleSprite.ts) for an active-screen-owned lease
without force release. It transfers an accepted request lease or balances a stale
one, allowing unreferenced assets to be reclaimed instead of silently retained.

Evidence: `cocos/asset/asset-manager/asset-manager.ts`, `bundle.ts`, `utilities.ts`,
`release-manager.ts`, `factory.ts`; `cocos/asset/assets/asset.ts`;
`cocos/serialization/instantiate.ts`; `tests/asset-manager/asset-manager.test.ts`.

**Navigation**
- Load a scene's containing bundle first. `director.loadScene(name, onLaunched)`
  returns `false` when busy or not found; do not wait indefinitely for a callback
  after synchronous rejection. Guard repeated navigation and ambiguous scene names.
- A token check inside `onLaunched` cannot cancel the transition: the scene has
  already launched. For supersedable navigation, use `bundle.loadScene`, validate
  the current navigation generation, then commit with `director.runSceneImmediate`.
- `preload`/`preloadScene` warm data; they do not instantiate or launch it. Still
  perform the load/launch step and handle its errors.

Evidence: `cocos/game/director.ts`, `cocos/asset/asset-manager/bundle.ts`.

**Input And Coordinates**
Use node `TOUCH_*` events for UI hit testing and `input`/`Input` for unclaimed
global input. UI dispatch runs before global input and may consume the touch.
Do not promise that global input sees every UI touch, including with `preventSwallow`.
A node needs a `UITransform` and a camera seeing its layer for UI hit testing;
a generic 3D model is not pickable by merely attaching `TOUCH_START`.

| Operation | Correct coordinate path |
| --- | --- |
| Standard screen-aligned Canvas drag | `event.getUILocation(out)` to parent `UITransform.convertToNodeSpaceAR`, then child `setPosition` |
| 3D picking | `event.getLocation(out)` to `camera.screenPointToRay`, then a supported ray query |
| World-space UI/custom camera/viewport | Explicit camera and plane conversion; do not assume standard Canvas mapping |

Track the initiating touch ID, including valid ID `0`. Handle `TOUCH_END` and
`TOUCH_CANCEL`, exit outside bounds and app hide. Preserve a drag offset rather
than snapping the anchor to the finger. Copy values before deferring work; dispatch
reuses mutable touch events. Do not iterate all changed touches inside every
callback: dispatch already iterates them. `getAllTouches()` excludes ended fingers.

`BlockInputEvents` blocks pointer propagation within its UI area, not all keyboard
input or gameplay simulation. A modal also needs an explicit gameplay state gate.
For 3D queries, consume/copy results before the next query overwrites shared results.
`screenToWorld` input Z is normalized clip-depth interpolation, not world Z.

Use [DragHandle.ts](../examples/DragHandle.ts) for the standard Canvas case.

Evidence: `cocos/input/input.ts`, `cocos/input/types/event/event-touch.ts`,
`cocos/2d/event/pointer-event-dispatcher.ts`, `cocos/scene-graph/node-event-processor.ts`,
`cocos/2d/framework/ui-transform.ts`, `cocos/misc/camera-component.ts`.

**UI Adaptation**
Choose `ResolutionPolicy` from gameplay constraints, not a universal mobile preset:
`FIXED_WIDTH` varies visible height, `FIXED_HEIGHT` varies width, `SHOW_ALL` may
letterbox, `NO_BORDER` may crop, and `EXACT_FIT` may distort.

Separate full-bleed backgrounds from a safe-area interaction root. `SafeArea`
requires Widget/UITransform setup and accurate host safe-area data. Keep buttons
within the safe root. Align/layout a parent and animate its child; Widget ALWAYS
alignment can overwrite animation transforms. Use `widget.updateAlignment()` or
`layout.updateLayout()` before immediate measurements when required.

Evidence: `cocos/ui/view.ts`, `safe-area.ts`, `widget.ts`, `layout.ts`;
`cocos/core/platform/sys.ts`.

**Pooling And Tweens**
- `NodePool.put` detaches then invokes `unuse`; it does not destroy the node.
  `get` returns `null` when empty; `clear` destroys cached nodes, not checked-out ones.
- In this implementation, the handler receives `reuse(arguments)`, a single
  arguments object, not spread arguments. `reuse` runs before caller reparenting.
  New fallback instances do not automatically receive it. A shared explicit spawn
  method is often clearer than relying on callback ordering or prior `onLoad`.
- Reset health, owner/team, transform, body velocity, contact state, visuals,
  listeners, timers and tweens. Track live actors separately, cap retained instances,
  and retain prefab/assets for both cached and checked-out consumers.
- Node-target tween lifecycle binding defaults to true: deactivation pauses it,
  reactivation resumes it, and destruction removes it. This does not bind a tween
  to the owning Component's enabled state or cover plain-object targets.
- Retain owned tween handles and stop/reset them for teardown and pool reuse.
  `Tween.stopAllByTarget` only affects that exact target; avoid global `stopAll`
  for a local screen. Do not tween a dynamic rigid body's transform concurrently.

Evidence: `extensions/ccpool/node-pool.ts`, `cocos/tween/tween.ts`,
`cocos/tween/actions/action-manager.ts`, `tests/tween/tween.test.ts`.

**Audio And Persistence**
Use `AudioSource`/`AudioClip`, with deliberate ownership for persistent music and
controllable effects. `playOneShot` returns no cancellation handle; `stop()` stops
the normal player, not every independent one-shot it launched. Use a dedicated
source when a sound must stop on close/reuse. Rate-limit repetitive effects and
test channel pressure, initial user-gesture unlock, interruptions and mute state.

AudioSource disable normally pauses it, except under a persistent root. Platform
audio hide/show behavior differs; in-game pause is not the same test as backgrounding.
Listen to `game`'s `Game.EVENT_HIDE`/`EVENT_SHOW` for game-owned state: clear held
input, save best-effort progress and reconcile time without overriding intentional pause.

Use `sys.localStorage` with namespaced versioned JSON, validated values, defaults,
and guarded parse/read/write. Storage access may fail or use warning-only fallback
methods. Save on meaningful progress and hide, not only destruction. Local saves
are not authoritative purchases, rewarded-ad proofs, leaderboards or currency.

Evidence: `cocos/audio/audio-source.ts`, `audio-manager.ts` in that directory;
`cocos/core/platform/sys.ts`, `cocos/game/game.ts`.

**Physics**
| Concern | 2D | 3D |
| --- | --- | --- |
| System/body | `PhysicsSystem2D`, `RigidBody2D` | `PhysicsSystem`, `RigidBody` |
| Non-response overlap | `Collider2D.sensor` | `Collider.isTrigger` |
| Events | `Contact2DType.BEGIN_CONTACT` and related types | `onTriggerEnter`, `onCollisionEnter` and related events |
| Velocity | Assign `linearVelocity` using `Vec2` | `setLinearVelocity(Vec3)` |

For Box2D contact delivery, configure `RigidBody2D.enabledContactListener = true`
on the collider's node before fixture creation. The spelling is **enabled**, not
`enableContactListener`; toggling it after creation need not register existing
fixtures. Builtin 2D callbacks can lack the Box2D contact object. Use `collider.apply()`
where required after changing fixture properties.

Builtin 2D is collision detection and its raycast returns no hits; builtin 3D is
also not a full dynamics simulator. Select an appropriate full backend for forces,
rigid-body motion or required queries, then validate it on the target device.
Visual 2D UI over a 3D game does not require both physics families.

Let the engine own fixed-step simulation unless manual stepping is intentional.
There is no automatically scheduled Component `fixedUpdate`. Treat collision
masks as bitmasks distinct from rendering layers. Queue structural changes out of
contact processing where possible and copy backend-owned query/contact values
needed later. Test tunneling, low frame rates and pooled body reuse explicitly.

Evidence: `cocos/physics-2d/framework/`, `cocos/physics-2d/box2d/`,
`cocos/physics-2d/box2d-wasm/`, `cocos/physics-2d/builtin/builtin-world.ts`,
`cocos/physics/framework/`, `cocos/physics/cocos/builtin-world.ts`.
