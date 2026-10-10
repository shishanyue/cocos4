/*
 Focused coverage for the spine runtime cache identity (SkeletonData.getId) and the public track-time API
 (Skeleton.getTrackTime / setTrackTime).

 The Jest harness cannot instantiate the real Spine WASM, so `lib/spine-core` is replaced by the controlled
 implementation in `./fake-spine`. Everything under test is the real engine TypeScript: SkeletonData asset
 identity, SkeletonCache refcounting/pooling, and Skeleton cached/realtime seek behaviour.
*/
jest.mock('../../cocos/spine/lib/spine-core', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fakeSpine } = require('./fake-spine') as typeof import('./fake-spine');
    return { __esModule: true, default: fakeSpine };
});

import { Texture2D } from '../../cocos/asset/assets';
import { Node } from '../../cocos/scene-graph/node';
import SkeletonCache from '../../cocos/spine/skeleton-cache';
import { SkeletonData } from '../../cocos/spine/skeleton-data';
import { Skeleton, SpineAnimationCacheMode } from '../../cocos/spine/skeleton';
import { TrackEntryListeners } from '../../cocos/spine/track-entry-listeners';
import spine from '../../cocos/spine/lib/spine-core';
import { animationSpecs, FakeSkeletonInstance, FakeTrackEntry, fakeSpine, fakeWasmUtil } from './fake-spine';

const ATLAS = [
    'attachment.png',
    'size: 16, 16',
    'format: RGBA8888',
    'filter: Linear,Linear',
    'repeat: none',
    'attachment',
    'rotate: false',
    'xy: 0, 0',
    'size: 10, 10',
    'orig: 10, 10',
    'offset: 0, 0',
    'index: -1',
    '',
].join('\n');

const FRAME_TIME = 1 / 60;

const listeners = TrackEntryListeners as unknown as {
    emitListener: (id: number, entry: unknown, event: unknown, eventType: number) => void;
    emitTrackEntryListener: (id: number, entry: unknown, event: unknown, eventType: number) => void;
    _trackSet: Map<number, unknown>;
};

let nodes: Node[] = [];
let assets: SkeletonData[] = [];

beforeAll(() => {
    // The seek/cache contracts do not involve the GPU; replace the spine assembler manager so render-data
    // creation does not require a device in this harness.
    (Skeleton as unknown as { Assembler: unknown }).Assembler = {
        getAssembler: (): { createData: () => null } => ({ createData: (): null => null }),
    };
});

afterEach(() => {
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].isValid) nodes[i]._destroyImmediate();
    }
    nodes = [];
    for (let i = 0; i < assets.length; i++) {
        if (assets[i].isValid) assets[i].destroy();
    }
    assets = [];
    SkeletonCache.sharedCache = new SkeletonCache();
    fakeWasmUtil.reset();
});

function makeTexture (uuid: string): Texture2D {
    const texture = new Texture2D();
    texture._uuid = uuid;
    return texture;
}

function makeRuntimeAsset (tag: string, options: { uuid?: string; texture?: Texture2D } = {}): SkeletonData {
    const data = new SkeletonData();
    data.name = `asset-${tag}`;
    data.atlasText = ATLAS;
    data._nativeAsset = new Uint8Array([tag.charCodeAt(0)]).buffer;
    data.textures = [options.texture ?? makeTexture(`texture-${tag}`)];
    if (options.uuid) data._uuid = options.uuid;
    assets.push(data);
    return data;
}

function makeComponent (asset: SkeletonData, mode: SpineAnimationCacheMode = SpineAnimationCacheMode.REALTIME): Skeleton {
    const node = new Node(`spine-${nodes.length}`);
    const component = node.addComponent(Skeleton) as Skeleton;
    component.setAnimationCacheMode(mode);
    component.skeletonData = asset;
    nodes.push(node);
    return component;
}

function destroyComponent (component: Skeleton): void {
    // The harness has no active scene, so the activator would deliberately skip onDestroy for a component
    // that was never onLoad-called. Invoke it the way a real destruction does, then remove the component.
    (component as unknown as { onDestroy: () => void }).onDestroy();
    component.node._destroyImmediate();
}

function poolKeys (): string[] {
    const cache = SkeletonCache.sharedCache as unknown as { _animationPool: Record<string, unknown> };
    return Object.keys(cache._animationPool);
}

function internals (component: Skeleton): {
    _animCache: { frames: unknown[]; isInvalid: () => boolean };
    _curFrame: unknown;
    _skeletonInfo: { assetUUID: string } | null;
} {
    return component as unknown as {
        _animCache: { frames: unknown[]; isInvalid: () => boolean };
        _curFrame: unknown;
        _skeletonInfo: { assetUUID: string } | null;
    };
}

function fakeEntry (component: Skeleton): FakeTrackEntry {
    return component.getCurrent(0) as unknown as FakeTrackEntry;
}

function fakeInstance (component: Skeleton): FakeSkeletonInstance {
    return (component as unknown as { _instance: FakeSkeletonInstance })._instance;
}

/** Wire the native event vector so queued callbacks are delivered by each updateAnimation dispatch. */
function instantiatePendingDispatch (instance: FakeSkeletonInstance): void {
    instance.onUpdate = (): void => {
        const batch = instance.pendingEvents;
        instance.pendingEvents = [];
        for (let i = 0; i < batch.length; i++) {
            listeners.emitListener(batch[i].id, batch[i].entry, undefined, batch[i].eventType);
        }
    };
}

function countTag (tag: string): number {
    return FakeSkeletonInstance.destroyedTags.filter((value): boolean => value === tag).length;
}

describe('SkeletonData runtime cache identity', () => {
    test('runtime data gets a memoized unique id while loaded assets keep their uuid', () => {
        const runtime = makeRuntimeAsset('A');
        const first = runtime.getId();
        expect(first).not.toBe('');
        expect(runtime.getId()).toBe(first);

        const loaded = makeRuntimeAsset('A', { uuid: 'loaded-uuid' });
        expect(loaded.getId()).toBe('loaded-uuid');
        expect(loaded.getId()).toBe('loaded-uuid');
    });

    test('same atlas and textures with different binaries get distinct identities, buckets and clips', () => {
        const sharedTexture = makeTexture('shared-texture');
        const assetA = makeRuntimeAsset('A', { texture: sharedTexture });
        const assetB = makeRuntimeAsset('B', { texture: sharedTexture });
        expect(assetA.getId()).not.toBe(assetB.getId());

        const compA = makeComponent(assetA, SpineAnimationCacheMode.SHARED_CACHE);
        const compB = makeComponent(assetB, SpineAnimationCacheMode.SHARED_CACHE);
        compA.setAnimation(0, 'anim_A', true);
        compB.setAnimation(0, 'anim_B', true);

        const cache = SkeletonCache.sharedCache;
        const infoA = cache.getSkeletonInfo(assetA);
        const infoB = cache.getSkeletonInfo(assetB);
        expect(infoA).toBeTruthy();
        expect(infoB).toBeTruthy();
        expect(infoA).not.toBe(infoB);
        expect(cache.getAnimationCache(assetA.getId(), 'anim_A')).toBeTruthy();
        expect(cache.getAnimationCache(assetA.getId(), 'anim_B')).toBeFalsy();
        expect(cache.getAnimationCache(assetB.getId(), 'anim_B')).toBeTruthy();
        expect(fakeWasmUtil.registry.size).toBe(2);
    });

    test('shared refcount keeps one bucket alive until the last owner leaves', () => {
        const asset = makeRuntimeAsset('A');
        const compA = makeComponent(asset, SpineAnimationCacheMode.SHARED_CACHE);
        const compB = makeComponent(asset, SpineAnimationCacheMode.SHARED_CACHE);
        compA.setAnimation(0, 'anim_A', true);
        compB.setAnimation(0, 'anim_A', true);

        const cache = SkeletonCache.sharedCache;
        const info = cache.getSkeletonInfo(asset);
        expect(info).toBeTruthy();
        expect(internals(compA)._skeletonInfo).toBe(info);
        expect(internals(compB)._skeletonInfo).toBe(info);

        destroyComponent(compA);
        expect(fakeWasmUtil.destroyedSkeletons.length).toBe(0);
        expect(cache.getSkeletonInfo(asset)).toBe(info);
        compB.updateAnimation(FRAME_TIME);
        expect(compB.getTrackTime()).toBeGreaterThan(0);

        destroyComponent(compB);
        expect(fakeWasmUtil.destroyedSkeletons.length).toBe(1);
        expect(cache.getSkeletonInfo(asset)).toBeUndefined();
    });

    test('destroying the asset identity while owners are live keeps the bucket and releases exactly once', () => {
        const asset = makeRuntimeAsset('A');
        const component = makeComponent(asset, SpineAnimationCacheMode.SHARED_CACHE);
        component.setAnimation(0, 'anim_A', true);
        const cache = SkeletonCache.sharedCache;
        const info = cache.getSkeletonInfo(asset);
        const identity = asset.getId();

        // Prior behaviour would have destroyed the live bucket from the asset side.
        cache.destroyCachedAnimations(identity);
        expect(cache.getSkeletonInfo(asset)).toBe(info);
        expect(fakeWasmUtil.destroyedSkeletons.length).toBe(0);
        component.updateAnimation(FRAME_TIME);

        // The asset is destroyed first while the component still renders from it: the wasm registration and
        // the pooled frames must survive until the last owner leaves.
        asset.destroy();
        expect(fakeWasmUtil.freed.length).toBe(0);
        expect(poolKeys().some((key): boolean => key.startsWith(identity + '#'))).toBe(false);
        component.updateAnimation(FRAME_TIME);

        destroyComponent(component);
        expect(cache.getSkeletonInfo(asset)).toBeUndefined();
        expect(fakeWasmUtil.destroyedSkeletons.length).toBe(1);
        expect(fakeWasmUtil.freed.length).toBe(1);
        expect(poolKeys().some((key): boolean => key.startsWith(identity + '#'))).toBe(false);
    });

    test('reset() retires the old identity and destroy() frees every owned registration once', () => {
        const asset = makeRuntimeAsset('A');
        const oldId = asset.getId();
        const compOld = makeComponent(asset, SpineAnimationCacheMode.SHARED_CACHE);
        compOld.setAnimation(0, 'anim_A', true);

        asset.reset();
        const newId = asset.getId();
        expect(newId).not.toBe(oldId);
        const compNew = makeComponent(asset, SpineAnimationCacheMode.SHARED_CACHE);
        compNew.setAnimation(0, 'anim_A', true);

        const cache = SkeletonCache.sharedCache;
        expect(internals(compOld)._skeletonInfo!.assetUUID).toBe(oldId);
        expect(internals(compNew)._skeletonInfo!.assetUUID).toBe(newId);

        destroyComponent(compOld);
        expect(fakeWasmUtil.destroyedSkeletons.length).toBe(1);
        expect(cache.getSkeletonInfo(asset)).toBe(internals(compNew)._skeletonInfo);

        destroyComponent(compNew);
        expect(fakeWasmUtil.destroyedSkeletons.length).toBe(2);

        asset.destroy();
        expect(fakeWasmUtil.freed.length).toBe(2);
        expect(new Set(fakeWasmUtil.freed.map((entry): string => entry.uuid)).size).toBe(2);
    });

    test('reset() with BOTH identities live releases each registration only when its own owners leave', () => {
        const asset = makeRuntimeAsset('A');
        const oldId = asset.getId();
        const compOld = makeComponent(asset, SpineAnimationCacheMode.SHARED_CACHE);
        compOld.setAnimation(0, 'anim_A', true);

        asset.reset();
        const newId = asset.getId();
        expect(newId).not.toBe(oldId);
        const compNew = makeComponent(asset, SpineAnimationCacheMode.SHARED_CACHE);
        compNew.setAnimation(0, 'anim_A', true);

        const uuids = Array.from(fakeWasmUtil.registry.keys());
        expect(uuids.length).toBe(2);
        const oldUUID = uuids.find((uuid): boolean => uuid.startsWith(oldId))!;
        const newUUID = uuids.find((uuid): boolean => uuid.startsWith(newId))!;
        expect(oldUUID).toBeTruthy();
        expect(newUUID).toBeTruthy();

        // Both identities still have a live component owner.
        asset.destroy();
        expect(fakeWasmUtil.freed.length).toBe(0);
        expect(fakeWasmUtil.registry.has(newUUID)).toBe(true);

        destroyComponent(compOld);
        // Only the old identity may be released; the new registration and pose must stay alive.
        expect(fakeWasmUtil.registry.has(oldUUID)).toBe(false);
        expect(fakeWasmUtil.registry.has(newUUID)).toBe(true);
        expect(fakeWasmUtil.freed.length).toBe(1);
        expect(fakeWasmUtil.freed[0].uuid).toBe(oldUUID);
        compNew.updateAnimation(FRAME_TIME);
        expect(compNew.getTrackTime()).toBeGreaterThan(0);

        destroyComponent(compNew);
        expect(fakeWasmUtil.registry.size).toBe(0);
        expect(fakeWasmUtil.freed.length).toBe(2);
        expect(new Set(fakeWasmUtil.freed.map((entry): string => entry.uuid)).size).toBe(2);
    });

    test('a private-cache owner keeps the registration alive and frees it exactly once', () => {
        const asset = makeRuntimeAsset('A');
        const component = makeComponent(asset, SpineAnimationCacheMode.PRIVATE_CACHE);
        component.setAnimation(0, 'anim_A', true);
        const uuid = Array.from(fakeWasmUtil.registry.keys())[0];
        expect(uuid).toBeTruthy();

        // Asset destroyed while the private-cache component is live.
        asset.destroy();
        expect(fakeWasmUtil.registry.has(uuid)).toBe(true);
        expect(fakeWasmUtil.freed.length).toBe(0);
        expect(countTag('A')).toBe(0);

        component.updateAnimation(FRAME_TIME);
        expect(component.getTrackTime()).toBeGreaterThan(0);

        destroyComponent(component);
        // The last private owner release must free both the private animation instance and the wasm
        // registration the asset deferred onto the shared cache.
        expect(fakeWasmUtil.registry.size).toBe(0);
        expect(fakeWasmUtil.freed.length).toBe(1);
        expect(fakeWasmUtil.freed[0].uuid).toBe(uuid);
        expect(countTag('A')).toBe(1);
        expect(fakeWasmUtil.destroyedSkeletons.length).toBe(1);
    });

    test('destroying a runtime asset while a realtime component is live keeps its registration', () => {
        const asset = makeRuntimeAsset('A');
        const component = makeComponent(asset, SpineAnimationCacheMode.REALTIME);
        component.setAnimation(0, 'anim_A', true);
        const uuid = Array.from(fakeWasmUtil.registry.keys())[0];
        expect(uuid).toBeTruthy();

        // The asset is destroyed first; the live realtime skeleton must keep the native data registration.
        asset.destroy();
        expect(fakeWasmUtil.registry.has(uuid)).toBe(true);
        expect(fakeWasmUtil.freed.length).toBe(0);

        component.updateAnimation(FRAME_TIME);
        expect(component.getTrackTime()).toBeGreaterThan(0);

        destroyComponent(component);
        expect(fakeWasmUtil.registry.size).toBe(0);
        expect(fakeWasmUtil.freed.length).toBe(1);
        expect(fakeWasmUtil.freed[0].uuid).toBe(uuid);
    });

    test('a query user protects a shared registration until its own release', () => {
        const sharedTexture = makeTexture('shared-registration-texture');
        const first = makeRuntimeAsset('A', { uuid: 'shared-loaded-uuid', texture: sharedTexture });
        const second = makeRuntimeAsset('A', { uuid: 'shared-loaded-uuid', texture: sharedTexture });

        const runtimeData = first.getRuntimeData();
        expect(runtimeData).toBeTruthy();
        expect(second.getRuntimeData()).toBe(runtimeData);
        expect(fakeWasmUtil.registry.size).toBe(1);

        // Destroying the creator first must not free the registration the second instance still uses.
        first.destroy();
        expect(fakeWasmUtil.freed.length).toBe(0);
        expect(fakeWasmUtil.registry.size).toBe(1);
        expect(second.getRuntimeData()).toBe(runtimeData);

        second.destroy();
        expect(fakeWasmUtil.freed.length).toBe(1);
        expect(fakeWasmUtil.registry.size).toBe(0);
    });

    test('cached animation pool eviction matches the exact identity, not an id prefix', () => {
        const sharedTexture = makeTexture('pool-texture');
        const shortIdAsset = makeRuntimeAsset('A', { uuid: 'AssetId1', texture: sharedTexture });
        const longIdAsset = makeRuntimeAsset('B', { uuid: 'AssetId11', texture: sharedTexture });
        const shortComp = makeComponent(shortIdAsset, SpineAnimationCacheMode.SHARED_CACHE);
        shortComp.setAnimation(0, 'anim_A', true);
        const longComp = makeComponent(longIdAsset, SpineAnimationCacheMode.SHARED_CACHE);
        longComp.setAnimation(0, 'anim_B', true);

        destroyComponent(shortComp);
        destroyComponent(longComp);
        const shortBefore = countTag('A');
        const longBefore = countTag('B');

        shortIdAsset.destroy();
        // Only the pooled animation of AssetId1 may be evicted; AssetId11 must keep its pooled instance.
        expect(countTag('A')).toBe(shortBefore + 1);
        expect(countTag('B')).toBe(longBefore);
        expect(fakeWasmUtil.registry.size).toBe(1);

        longIdAsset.destroy();
        expect(countTag('B')).toBe(longBefore + 1);
    });
});

describe('Skeleton public track-time API', () => {
    test('junk arguments are ignored and the current time is preserved', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.SHARED_CACHE);
        component.setAnimation(0, 'anim_A', true);
        component.setTrackTime(0, 0.5);
        expect(component.getTrackTime(0)).toBeCloseTo(0.5, 6);

        component.setTrackTime(0, Number.NaN);
        component.setTrackTime(0, Number.POSITIVE_INFINITY);
        component.setTrackTime(0, Number.NEGATIVE_INFINITY);
        component.setTrackTime(-1, 0.2);
        component.setTrackTime(1, 0.2);
        component.setTrackTime(0.5, 0.2);
        expect(component.getTrackTime(0)).toBeCloseTo(0.5, 6);

        expect(component.getTrackTime(-1)).toBe(0);
        expect(component.getTrackTime(1)).toBe(0);
        expect(component.getTrackTime(0.5)).toBe(0);
    });

    test('cached seek selects the exact frame, keeps paused, marks dirty and emits no events', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.SHARED_CACHE);
        component.setAnimation(0, 'anim_A', true);
        const complete = jest.fn();
        const end = jest.fn();
        const start = jest.fn();
        component.setCompleteListener(complete);
        component.setEndListener(end);
        component.setStartListener(start);
        const markDirty = jest.spyOn(component as unknown as { _markForUpdateRenderData: () => void }, '_markForUpdateRenderData');

        component.setTrackTime(0, 0.5);
        const frames = internals(component)._animCache.frames;
        expect(component.getTrackTime(0)).toBeCloseTo(0.5, 6);
        expect(internals(component)._curFrame).toBe(frames[Math.floor(0.5 / FRAME_TIME)]);
        expect(complete).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(markDirty).toHaveBeenCalled();

        component.paused = true;
        component.setTrackTime(0, 0.25);
        expect(component.paused).toBe(true);
        expect(internals(component)._curFrame).toBe(frames[15]);
        component.updateAnimation(0.5);
        expect(component.getTrackTime(0)).toBeCloseTo(0.25, 6);
        expect(internals(component)._curFrame).toBe(frames[15]);

        component.invalidAnimationCache();
        expect(internals(component)._animCache.isInvalid()).toBe(true);
        component.paused = false;
        component.updateAnimation(FRAME_TIME);
        expect(internals(component)._animCache.isInvalid()).toBe(false);
        expect(internals(component)._curFrame).toBeTruthy();
    });

    test('cached one-shot seek clamps to the end frame and completes once on the next advance', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.SHARED_CACHE);
        component.setAnimation(0, 'anim_A', false);
        const complete = jest.fn();
        const end = jest.fn();
        component.setCompleteListener(complete);
        component.setEndListener(end);

        component.setTrackTime(0, 1000);
        const frames = internals(component)._animCache.frames;
        expect(component.getTrackTime(0)).toBeCloseTo(1, 6);
        expect(internals(component)._curFrame).toBe(frames[frames.length - 1]);
        expect(complete).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();

        component.updateAnimation(FRAME_TIME);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        expect(component.getTrackTime(0)).toBeCloseTo(1 + FRAME_TIME, 5);

        component.updateAnimation(FRAME_TIME);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
    });

    test('cached loop seek keeps the unwrapped clock and emits one completion per natural loop', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.SHARED_CACHE);
        component.setAnimation(0, 'anim_A', true);
        const complete = jest.fn();
        component.setCompleteListener(complete);

        component.setTrackTime(0, 1.5);
        const frames = internals(component)._animCache.frames;
        expect(component.getTrackTime(0)).toBeCloseTo(1.5, 6);
        expect(internals(component)._curFrame).toBe(frames[30]);

        component.setTrackTime(0, 59.5 * FRAME_TIME);
        expect(internals(component)._curFrame).toBe(frames[59]);
        expect(complete).not.toHaveBeenCalled();

        component.updateAnimation(FRAME_TIME);
        expect(complete).not.toHaveBeenCalled();
        component.updateAnimation(FRAME_TIME);
        expect(complete).toHaveBeenCalledTimes(1);
        // The unwrapped clock keeps the exact explicit value plus the two advanced frames.
        expect(component.getTrackTime(0)).toBeCloseTo(59.5 * FRAME_TIME + 2 * FRAME_TIME, 6);
        expect(internals(component)._curFrame).toBe(frames[0]);
    });

    test('realtime seek suppresses only its own events, keeps other instances live and restores delivery', () => {
        const sharedTexture = makeTexture('realtime-texture');
        const assetA = makeRuntimeAsset('A', { uuid: 'rt-A', texture: sharedTexture });
        const assetB = makeRuntimeAsset('B', { uuid: 'rt-B', texture: sharedTexture });
        const compA = makeComponent(assetA);
        const compB = makeComponent(assetB);
        compA.setAnimation(0, 'anim_A', false);
        compB.setAnimation(0, 'anim_B', false);

        const completeA = jest.fn();
        const startA = jest.fn();
        compA.setCompleteListener(completeA);
        compA.setTrackStartListener(fakeEntry(compA) as unknown as spine.TrackEntry, startA);
        const startB = jest.fn();
        compB.setTrackStartListener(fakeEntry(compB) as unknown as spine.TrackEntry, startB);

        const instanceA = fakeInstance(compA);
        const instanceB = fakeInstance(compB);
        const entryA = fakeEntry(compA);
        const entryB = fakeEntry(compB);
        const idA = instanceA.trackIds.get(entryA)!;
        const idB = instanceB.trackIds.get(entryB)!;

        // Model native dispatch: queued events are always delivered; complete/start generated by the pose
        // apply are only raised while the component mute is active, i.e. during the seek's muted phase.
        instanceA.onUpdate = (): void => {
            const batch = instanceA.pendingEvents;
            instanceA.pendingEvents = [];
            for (let i = 0; i < batch.length; i++) {
                listeners.emitListener(batch[i].id, batch[i].entry, undefined, batch[i].eventType);
            }
            if (instanceA.listenerID !== 0) return;
            listeners.emitListener(instanceA.listenerID, entryA, undefined, fakeSpine.EventType.complete);
            listeners.emitTrackEntryListener(idA, entryA, undefined, fakeSpine.EventType.start);
            // Simulates the native dispatch reaching a different skeleton instance in the same step.
            listeners.emitTrackEntryListener(idB, entryB, undefined, fakeSpine.EventType.start);
        };
        instanceB.onUpdate = (): void => {
            const batch = instanceB.pendingEvents;
            instanceB.pendingEvents = [];
            for (let i = 0; i < batch.length; i++) {
                listeners.emitListener(batch[i].id, batch[i].entry, undefined, batch[i].eventType);
            }
        };

        const listenerIdBefore = instanceA.listenerID;
        compA.setTrackTime(0, 0.25);
        expect(compA.getTrackTime(0)).toBeCloseTo(0.25, 6);
        expect(completeA).not.toHaveBeenCalled();
        expect(startA).not.toHaveBeenCalled();
        // The other component must keep delivering while compA seeks.
        expect(startB).toHaveBeenCalledTimes(1);
        expect(instanceA.listenerID).toBe(listenerIdBefore);

        // Restore check: the next natural frame delivers the events it queued, through the normal pipeline.
        instanceA.onUpdate = (): void => {
            const batch = instanceA.pendingEvents;
            instanceA.pendingEvents = [];
            for (let i = 0; i < batch.length; i++) {
                listeners.emitListener(batch[i].id, batch[i].entry, undefined, batch[i].eventType);
            }
            listeners.emitTrackEntryListener(idA, entryA, undefined, fakeSpine.EventType.start);
        };
        instanceA.pendingEvents.push({
            id: instanceA.listenerID,
            entry: entryA,
            eventType: fakeSpine.EventType.complete,
        });
        completeA.mockClear();
        startA.mockClear();
        compA.updateAnimation(FRAME_TIME);
        expect(completeA).toHaveBeenCalledTimes(1);
        expect(startA).toHaveBeenCalledTimes(1);

        const timeAfterUpdate = compA.getTrackTime(0);
        compA.setTrackTime(0, Number.NaN);
        expect(compA.getTrackTime(0)).toBeCloseTo(timeAfterUpdate, 6);

        // A dispose delivered while muted must still remove the registry entry without invoking the callback.
        const disposeComp = makeComponent(assetB);
        disposeComp.setAnimation(0, 'anim_B', false);
        const disposeCallback = jest.fn();
        disposeComp.setDisposeListener(disposeCallback);
        disposeComp.setTrackStartListener(fakeEntry(disposeComp) as unknown as spine.TrackEntry, jest.fn());
        const disposeInstance = fakeInstance(disposeComp);
        const disposeEntry = fakeEntry(disposeComp);
        const disposeId = disposeInstance.trackIds.get(disposeEntry)!;
        disposeInstance.onUpdate = (): void => {
            listeners.emitTrackEntryListener(disposeId, disposeEntry, undefined, fakeSpine.EventType.dispose);
        };
        disposeComp.setTrackTime(0, 0.5);
        expect(disposeCallback).not.toHaveBeenCalled();
        expect(listeners._trackSet.has(disposeId)).toBe(false);
        disposeComp.updateAnimation(FRAME_TIME);
        expect(disposeCallback).not.toHaveBeenCalled();
    });

    test('explicit setTrackTime keeps the unwrapped clock in realtime and cached modes', () => {
        const realtime = makeComponent(makeRuntimeAsset('A', { uuid: 'rt-unwrapped-A' }));
        realtime.setAnimation(0, 'anim_A', true);
        realtime.setTrackTime(0, 2.5);
        expect(realtime.getTrackTime(0)).toBeCloseTo(2.5, 6);

        const cached = makeComponent(makeRuntimeAsset('B', { uuid: 'cached-unwrapped-B' }), SpineAnimationCacheMode.SHARED_CACHE);
        cached.setAnimation(0, 'anim_B', true);
        cached.setTrackTime(0, 2.5);
        expect(cached.getTrackTime(0)).toBeCloseTo(2.5, 6);
        cached.updateAnimation(FRAME_TIME);
        expect(cached.getTrackTime(0)).toBeCloseTo(2.5 + FRAME_TIME, 6);
    });

    test('a natural event queued before a realtime seek is still delivered', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.REALTIME);
        const start = jest.fn();
        component.setStartListener(start);
        // The native setAnimation queues this START for the next update dispatch.
        component.setAnimation(0, 'anim_A', false);
        const instance = fakeInstance(component);
        expect(instance.pendingEvents.length).toBe(1);

        instance.onUpdate = (): void => {
            const batch = instance.pendingEvents;
            instance.pendingEvents = [];
            for (let i = 0; i < batch.length; i++) {
                listeners.emitListener(batch[i].id, batch[i].entry, undefined, batch[i].eventType);
            }
        };

        component.setTrackTime(0, 0.25);
        // The pending natural START must survive the seek; the seek itself must not add anything.
        expect(start).toHaveBeenCalledTimes(1);
        expect(instance.pendingEvents.length).toBe(0);
        expect(component.getTrackTime(0)).toBeCloseTo(0.25, 6);
    });

    test('deferred setAnimation reaches the same pose and events as the immediate default', () => {
        const immediate = makeComponent(makeRuntimeAsset('A', { uuid: 'apply-immediate-A' }));
        immediate.setAnimation(0, 'anim_A', false);
        const immediateInstance = fakeInstance(immediate);
        expect(immediateInstance.immediateApplyCount).toBe(1);
        instantiatePendingDispatch(immediateInstance);

        const deferred = makeComponent(makeRuntimeAsset('B', { uuid: 'apply-deferred-B' }));
        const deferredInstance = fakeInstance(deferred);
        const start = jest.fn();
        deferred.setStartListener(start);
        const entry = deferred.setAnimation(0, 'anim_B', false, false);
        expect(entry).toBeTruthy();
        expect(entry!.animation.name).toBe('anim_B');
        // Deferred: no immediate native apply; the entry is still bound on the state.
        expect(deferredInstance.immediateApplyCount).toBe(0);
        expect(fakeEntry(deferred).animation.name).toBe('anim_B');
        instantiatePendingDispatch(deferredInstance);

        deferred.updateAnimation(FRAME_TIME);
        immediate.updateAnimation(FRAME_TIME);
        // Both binds advanced by the same delta; the clip names come from the two distinct binaries.
        expect(deferred.getTrackTime(0)).toBeCloseTo(immediate.getTrackTime(0), 6);
        expect(fakeEntry(deferred).animation.name).toBe('anim_B');
        expect(fakeEntry(immediate).animation.name).toBe('anim_A');
        expect(start).toHaveBeenCalledTimes(1);
    });

    test('a paused deferred bind is posed explicitly without advancing or events', () => {
        const component = makeComponent(makeRuntimeAsset('A', { uuid: 'apply-paused-A' }));
        const deferredInstance = fakeInstance(component);
        const start = jest.fn();
        const complete = jest.fn();
        component.setStartListener(start);
        component.setCompleteListener(complete);
        component.paused = true;
        component.setAnimation(0, 'anim_A', false, false);
        instantiatePendingDispatch(deferredInstance);

        component.updateAnimation(FRAME_TIME);
        expect(component.getTrackTime(0)).toBe(0);

        component.setTrackTime(0, 0.3);
        expect(component.paused).toBe(true);
        expect(component.getTrackTime(0)).toBeCloseTo(0.3, 6);
        expect(complete).not.toHaveBeenCalled();
    });

    test('a callback that replaces the track during the seek drain normalizes against the LIVE clip', () => {
        // The captured clip is 0.5s; the callback replaces it with a 2s loop. A seek of 1.5s must be
        // normalized against the LIVE duration (loop -> 1.5), never clamped by the captured 0.5s clip.
        animationSpecs.set('R', [{ name: 'short', duration: 0.5 }, { name: 'long', duration: 2 }]);
        const component = makeComponent(makeRuntimeAsset('R'), SpineAnimationCacheMode.REALTIME);
        component.setAnimation(0, 'short', false);
        const instance = fakeInstance(component);
        const staleEntry = fakeEntry(component);
        let replaced = false;
        instance.onUpdate = (): void => {
            if (replaced) return;
            replaced = true;
            // Models a user listener calling back into the component during native event dispatch.
            component.setAnimation(0, 'long', true);
        };

        component.setTrackTime(0, 1.5);
        expect(replaced).toBe(true);
        const liveEntry = fakeEntry(component);
        expect(liveEntry).not.toBe(staleEntry);
        expect(liveEntry.animation.name).toBe('long');
        // The captured entry was replaced by the callback: it must never receive the seek time, and the raw
        // time is normalized by the live clip's duration (Embind may also hand back a different wrapper).
        expect(staleEntry.trackTime).toBe(0);
        expect(liveEntry.trackTime).toBeCloseTo(1.5, 6);
        expect(component.getTrackTime(0)).toBeCloseTo(1.5, 6);
    });

    test('a callback that clears tracks during the seek drain does not throw or write', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.REALTIME);
        component.setAnimation(0, 'anim_A', false);
        const instance = fakeInstance(component);
        const staleEntry = fakeEntry(component);
        instance.onUpdate = (): void => {
            component.clearTracks();
        };

        expect(() => component.setTrackTime(0, 0.5)).not.toThrow();
        expect(component.getCurrent(0)).toBeNull();
        expect(staleEntry.trackTime).toBe(0);
    });

    test('a callback that destroys the component during the seek drain does not throw', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.REALTIME);
        component.setAnimation(0, 'anim_A', false);
        const instance = fakeInstance(component);
        let destroyed = false;
        instance.onUpdate = (): void => {
            if (destroyed) return;
            destroyed = true;
            destroyComponent(component);
        };

        expect(() => component.setTrackTime(0, 0.3)).not.toThrow();
        expect(destroyed).toBe(true);
        expect(fakeInstance(component)).toBeNull();
    });

    test('nested seeks keep the component mute until the outermost call leaves', () => {
        const component = makeComponent(makeRuntimeAsset('A'), SpineAnimationCacheMode.REALTIME);
        component.setAnimation(0, 'anim_A', false);
        const start = jest.fn();
        component.setStartListener(start);
        const instance = fakeInstance(component);
        const entry = fakeEntry(component);
        const listenerIdBefore = instance.listenerID;
        expect(listenerIdBefore).toBeGreaterThan(0);

        let nested = false;
        let mutedDuringNested = false;
        let mutedAfterNested = false;
        instance.onUpdate = (): void => {
            // Only the seek's muted pose-apply phase nests another seek.
            if (instance.listenerID !== 0) return;
            if (!nested) {
                nested = true;
                component.setTrackTime(0, 0.1);
                mutedDuringNested = instance.listenerID === 0;
                return;
            }
            mutedAfterNested = instance.listenerID === 0;
        };

        component.setTrackTime(0, 0.2);
        expect(mutedDuringNested).toBe(true);
        expect(mutedAfterNested).toBe(true);
        expect(start).not.toHaveBeenCalled();
        expect(instance.listenerID).toBe(listenerIdBefore);

        instance.onUpdate = (): void => {
            listeners.emitListener(instance.listenerID, entry, undefined, fakeSpine.EventType.start);
        };
        component.updateAnimation(FRAME_TIME);
        expect(start).toHaveBeenCalledTimes(1);
        expect(instance.listenerID).toBe(listenerIdBefore);
    });
});
