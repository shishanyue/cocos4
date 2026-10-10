/*
 Focused test double for `cocos/spine/lib/spine-core`.
 The Jest harness cannot instantiate the real Spine WASM (tests/init.ts mocks the external emscripten module and
 `pal/wasm` only provides a fetch shim), so the TS-side spine cache/seek contracts are driven against a
 controlled implementation of the documented native surface. Native behaviour itself stays covered by the
 browser acceptance phase.
*/

export interface FakeFreedRegistration {
    uuid: string;
    tag: string;
}

const registry = new Map<string, FakeSkeletonData>();
const freed: FakeFreedRegistration[] = [];
const destroyedSkeletons: string[] = [];
let storeOffset = 64;

export class FakeBoneData {
    constructor (public name: string, public index: number) {}
}

export class FakeBone {
    public parent: FakeBone | null = null;
    public a = 1;
    public b = 0;
    public c = 0;
    public d = 1;
    public worldX = 0;
    public worldY = 0;
    constructor (public data: FakeBoneData) {}
}

export class FakeAnimation {
    constructor (public name: string, public duration: number) {}
}

export type FakeAnimationSpec = string | { name: string; duration: number };

/** Per-binary animation specs; tests can use clips with different durations. */
export const animationSpecs = new Map<string, FakeAnimationSpec[]>();

export class FakeSkeletonData {
    public bones: FakeBone[] = [new FakeBone(new FakeBoneData('root', 0))];
    public skins: { name: string }[] = [{ name: 'default' }];
    public animations: FakeAnimation[];
    public destroyed = false;
    constructor (public tag: string, specs: FakeAnimationSpec[]) {
        this.animations = specs.map((spec): FakeAnimation => (typeof spec === 'string'
            ? new FakeAnimation(spec, 1)
            : new FakeAnimation(spec.name, spec.duration)));
    }
    public findAnimation (name: string): FakeAnimation | null {
        for (let i = 0; i < this.animations.length; i++) {
            if (this.animations[i].name === name) return this.animations[i];
        }
        return null;
    }
}

export class FakeSkeleton {
    public bones: FakeBone[];
    public drawOrder: unknown[] = [];
    constructor (public data: FakeSkeletonData) {
        this.bones = data.bones;
    }
    public setSkinByName (): void { /* test double */ }
    public setToSetupPose (): void { /* test double */ }
    public setBonesToSetupPose (): void { /* test double */ }
    public setSlotsToSetupPose (): void { /* test double */ }
    public update (): void { /* test double */ }
    public updateWorldTransform (): void { /* test double */ }
}

export class FakeTrackEntry {
    public animation: FakeAnimation;
    public trackIndex: number;
    public loop: boolean;
    public trackTime = 0;
    public animationStart = 0;
    public animationEnd: number;
    public animationLast = -1;
    public trackEnd = 0;
    public timeScale = 1;
    public alpha = 1;
    public delay = 0;
    public next: FakeTrackEntry | null = null;
    public mixingFrom: FakeTrackEntry | null = null;
    public listener: unknown = null;
    constructor (animation: FakeAnimation, trackIndex: number, loop: boolean) {
        this.animation = animation;
        this.trackIndex = trackIndex;
        this.loop = loop;
        this.animationEnd = animation.duration;
    }
    public getAnimationTime (): number {
        return this.loop ? this.trackTime % this.animation.duration : Math.min(this.trackTime, this.animationEnd);
    }
    public isComplete (): boolean {
        return this.trackTime >= this.animationEnd - this.animationStart;
    }
}

export class FakeAnimationState {
    public tracks: (FakeTrackEntry | undefined)[] = [];
    public data: unknown = null;
    public timeScale = 1;
    public getCurrent (trackIndex: number): FakeTrackEntry | null {
        return this.tracks[trackIndex] ?? null;
    }
    public getTracks (): (FakeTrackEntry | undefined)[] {
        return this.tracks;
    }
    public setAnimation (trackIndex: number, name: string, loop: boolean): FakeTrackEntry | null {
        // Name-based native entry point: resolves the name, then delegates to the object-based one.
        const owner = (this as unknown as { _owner: FakeSkeletonInstance })._owner;
        if (!owner || !owner.skeletonData) return null;
        const animation = owner.skeletonData.findAnimation(name);
        if (!animation) return null;
        return this.setAnimationWith(trackIndex, animation, loop);
    }
    public setAnimationWith (trackIndex: number, animation: FakeAnimation, loop: boolean): FakeTrackEntry | null {
        if (!animation) return null;
        const owner = (this as unknown as { _owner: FakeSkeletonInstance })._owner;
        const entry = new FakeTrackEntry(animation, trackIndex, loop);
        this.tracks[trackIndex] = entry;
        // Native animationCallback() queues the START into the instance event vector; it is delivered to JS
        // only by the next updateAnimation dispatch.
        owner.pendingEvents.push({
            id: owner.listenerID,
            entry,
            eventType: fakeSpine.EventType.start,
        });
        return entry;
    }
    public addAnimationWith (): FakeTrackEntry | null {
        return null;
    }
    public clearTracks (): void {
        this.tracks.length = 0;
    }
    public clearTrack (trackIndex: number): void {
        this.tracks[trackIndex] = undefined;
    }
    public setMix (): void { /* test double */ }
}

export class FakeSpineModel {
    public vCount = 1;
    public iCount = 0;
    public vPtr = 0;
    public iPtr = 0;
    public getData (): { size: () => number; get: (index: number) => number } {
        return { size: (): number => 0, get: (): number => 0 };
    }
    public getTextures (): { size: () => number; get: (index: number) => string } {
        return { size: (): number => 0, get: (): string => '' };
    }
}

export class FakeSkeletonInstance {
    public static created: FakeSkeletonInstance[] = [];
    public static destroyedTags: string[] = [];
    public static reset (): void {
        FakeSkeletonInstance.created.length = 0;
        FakeSkeletonInstance.destroyedTags.length = 0;
    }

    public dtRate = 1;
    public isCache = false;
    public isDelete = false;
    public enable = true;
    public listenerID = 0;
    public destroyed = false;
    public skeletonData: FakeSkeletonData | null = null;
    public skeleton: FakeSkeleton | null = null;
    public state: FakeAnimationState;
    public trackIds = new Map<FakeTrackEntry, number>();
    /** Native event vector: callbacks queued by earlier calls, delivered by the next updateAnimation. */
    public pendingEvents: { id: number; entry: FakeTrackEntry; eventType: number }[] = [];
    /** Count of the immediate native pose applies performed by setAnimation. */
    public immediateApplyCount = 0;
    /** Test hook standing in for the native event dispatch that runs inside updateAnimation. */
    public onUpdate: (() => void) | null = null;

    constructor () {
        FakeSkeletonInstance.created.push(this);
        this.state = new FakeAnimationState();
        (this.state as unknown as { _owner: FakeSkeletonInstance })._owner = this;
    }
    public initSkeleton (data: FakeSkeletonData): FakeSkeleton {
        this.skeletonData = data;
        this.skeleton = new FakeSkeleton(data);
        return this.skeleton;
    }
    public getAnimationState (): FakeAnimationState {
        return this.state;
    }
    public setAnimation (trackIndex: number, name: string, loop: boolean): FakeTrackEntry | null {
        // Stands in for SpineSkeletonInstance::setAnimation, which applies the pose immediately.
        this.immediateApplyCount++;
        return this.state.setAnimation(trackIndex, name, loop);
    }
    public setSkin (): void { /* test double */ }
    public setPremultipliedAlpha (): void { /* test double */ }
    public setColor (): void { /* test double */ }
    public setUseTint (): void { /* test double */ }
    public clearEffect (): void { /* test double */ }
    public setJitterEffect (): void { /* test double */ }
    public setSwirlEffect (): void { /* test double */ }
    public setDebugMode (): void { /* test double */ }
    public setMix (): void { /* test double */ }
    public resizeSlotRegion (): void { /* test double */ }
    public setSlotTexture (): void { /* test double */ }
    public getDebugShapes (): { size: () => number; get: () => null; delete: () => void } {
        return { size: (): number => 0, get: (): null => null, delete: (): void => { /* nothing */ } };
    }
    public setListener (id: number): void {
        this.listenerID = id;
    }
    public setTrackEntryListener (id: number, entry: FakeTrackEntry): void {
        this.trackIds.set(entry, id);
    }
    public updateAnimation (dt: number): void {
        const entry = this.state.getCurrent(0);
        if (entry) entry.trackTime += dt * this.dtRate;
        if (this.onUpdate) this.onUpdate();
    }
    public updateRenderData (): FakeSpineModel {
        return new FakeSpineModel();
    }
    public destroy (): void {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.skeletonData) FakeSkeletonInstance.destroyedTags.push(this.skeletonData.tag);
    }
}

export const fakeWasmUtil = {
    registry,
    freed,
    destroyedSkeletons,
    wasm: { HEAPU8: new Uint8Array(1 << 16) },
    reset (): void {
        registry.clear();
        freed.length = 0;
        destroyedSkeletons.length = 0;
        animationSpecs.clear();
        storeOffset = 64;
        FakeSkeletonInstance.reset();
    },
    createStoreMemory (size: number): number {
        storeOffset += 256 + size;
        return storeOffset;
    },
    freeStoreMemory (): void { /* test double */ },
    querySpineSkeletonDataByUUID (uuid: string): FakeSkeletonData | null {
        return registry.get(uuid) ?? null;
    },
    createSpineSkeletonDataWithJson (jsonStr: string): FakeSkeletonData {
        const tag = (JSON.parse(jsonStr) as { __tag: string }).__tag;
        return new FakeSkeletonData(tag, [`anim_${tag}`]);
    },
    createSpineSkeletonDataWithBinary (byteSize: number): FakeSkeletonData {
        const bytes = fakeWasmUtil.wasm.HEAPU8.subarray(storeOffset, storeOffset + byteSize);
        let tag = '';
        for (let i = 0; i < bytes.length; i++) tag += String.fromCharCode(bytes[i]);
        return new FakeSkeletonData(tag, animationSpecs.get(tag) ?? [`anim_${tag}`]);
    },
    registerSpineSkeletonDataWithUUID (data: FakeSkeletonData, uuid: string): void {
        if (!registry.has(uuid)) registry.set(uuid, data);
    },
    destroySpineSkeletonDataWithUUID (uuid: string): void {
        const data = registry.get(uuid);
        if (!data) return;
        registry.delete(uuid);
        freed.push({ uuid, tag: data.tag });
    },
    destroySpineSkeleton (skeleton: FakeSkeleton): void {
        if (skeleton.data.destroyed) return;
        skeleton.data.destroyed = true;
        destroyedSkeletons.push(skeleton.data.tag);
    },
};

export const fakeSpine = {
    EventType: { start: 0, interrupt: 1, end: 2, complete: 3, dispose: 4, event: 5 },
    MixBlend: { setup: 0, first: 1, replace: 2, add: 3 },
    MixDirection: { mixIn: 0, mixOut: 1 },
    SkeletonData: FakeSkeletonData,
    Skeleton: FakeSkeleton,
    SkeletonInstance: FakeSkeletonInstance,
    AnimationState: FakeAnimationState,
    TrackEntry: FakeTrackEntry,
    wasmUtil: fakeWasmUtil,
};
