# Runtime Contracts

## Async And Assets

Engine lifecycle callbacks are not promise orchestration. Start loading explicitly,
gate gameplay on readiness, and catch every failure. Use a monotonically increasing
generation to reject results after disable, navigation, retry or destruction. Also
check strict `isValid(owner, true)` and the owner's active state before committing.
Generation checks do not abort download, parsing or GPU work. The high-level asset
load APIs do not supply a general abort handle.

Acquire dynamic shared assets with `addRef` and balance only those acquisitions
with `decRef`. Detach renderer/audio references before releasing screen-owned data.
Do not force-release shared assets during routine screen teardown or decrement a
reference you never acquired. Runtime-created `Texture2D`/`SpriteFrame` objects
also need explicit ownership; a callback that becomes stale must not leak them.
Never destroy scene/prefab-referenced shared assets to imitate cancellation.

Delivered code starters use actual local image/JSON/audio files through the public
asset manager. SDK `assets/` files become `assets/game/` in emitted artifacts.
Follow the starter's URL and type handling. Runtime URLs, source filesystem paths,
bundle-relative paths and Creator UUIDs are different contracts. `resources.load`
or `assetManager.loadBundle` needs a genuinely imported resources/bundle pipeline;
copying a PNG or prefab into a directory does not create such a bundle.

## UI And Input

Use `Node.EventType` touch events for interactive UI. UI listeners can consume
touches before global `input`; do not register duplicate UI/global actions for the
same interaction. Track a single touch ID when appropriate and ignore other fingers.
Handle touch cancel, component disable, node destruction and `Game.EVENT_HIDE`.
Keep stable listener identities for unsubscription. Pair global/game listeners as
carefully as node listeners.

Screen coordinates, UI-world coordinates and parent-local coordinates differ.
For a standard screen-aligned Canvas, convert `event.getUILocation()` through the
parent `UITransform.convertToNodeSpaceAR` before updating a node's local position.
World-space/camera-transformed UI needs that camera's actual conversion contract.
Do not compete with a `Widget` or `Layout` controlling the same position. Check
multiple aspect ratios, safe areas and touch devices rather than only mouse input.

## Audio And Lifetime

Use `AudioSource`/`AudioClip` and a user gesture to unlock browser audio. Loading a
clip or calling play is not proof of audible output. Expose muted/failed states,
avoid duplicate playback from repeated listeners, and test hide/show interruptions.
Do not require a DOM audio node in a mini-game.

For pooled objects, stop owned tweens, clear scheduled actions, reset gestures,
velocity, score flags, async generations and listeners on release/reuse. Component
disable pauses scheduled callbacks; stale actions can resume on re-enable. Destroy
or trim pools according to measured retained memory, not a fixed folklore limit.

## 2D, 3D And Performance

Use only the prebuilt profile's features. Keep 2D/3D physics APIs distinct. Builtin
collision is not a full dynamics engine, and there is no Unity-style `fixedUpdate`
contract to assume. Do not run a second simulation loop by accident. Use a delivered
3D starter for camera, mesh and material setup instead of assuming optional physics,
skeletal animation, custom shaders or third-party runtimes are present.

Measure draw calls, allocations, texture/audio memory, cold loads and frame time
on a named release/container/device. First keep one correct vertical slice, then
change one measured bottleneck. Software-WebGL preview evidence is not a mobile GPU
or vendor runtime benchmark. Repeat restart and scene-exit-during-load cases before
claiming resource/listener stability.
