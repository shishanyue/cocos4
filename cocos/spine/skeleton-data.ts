/*
 Copyright (c) 2020-2023 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights to
 use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 of the Software, and to permit persons to whom the Software is furnished to do so,
 subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/

import { EDITOR_NOT_IN_PREVIEW } from 'internal:constants';
import { CCString, Enum, error, js, murmurhash2_32_gc } from '../core';
import SkeletonCache from './skeleton-cache';
import { Skeleton } from './skeleton';
import spine from './lib/spine-core';
import { ccclass, serializable, type } from '../core/data/decorators';
import { legacyCC } from '../core/global-exports';
import { Texture2D, Asset } from '../asset/assets';
import { Node } from '../scene-graph';

/**
 * Runtime-created skeleton data cannot use a content hash as its cache identity: the merged hash only
 * covers the atlas text and texture ids, so two different binaries that share them would collide. Mint a
 * unique, memoized id per instance instead; bundle/editor assets keep their uuid.
 */
const runtimeIdGenerator = new js.IDGenerator('SkeletonData');

// Wasm registry entries are shared: several SkeletonData instances can resolve to the same registered
// runtime data (loaded assets that reuse a uuid, or a re-created runtime data). The entry is freed only when
// the last claiming instance is destroyed.
const registrationRefCounts = new Map<string, number>();

/**
 * @en The skeleton data of spine.
 * @zh Spine 的骨骼数据。
 * @class SkeletonData
 * @extends Asset
 */
@ccclass('sp.SkeletonData')
export class SkeletonData extends Asset {
    /**
     * @en See http://en.esotericsoftware.com/spine-json-format
     * @zh 可查看 Spine 官方文档 http://zh.esotericsoftware.com/spine-json-format
     * @deprecated since v3.5.0, this is an engine private interface that will be removed in the future.
     */
    @serializable
    public _skeletonJson: spine.SkeletonJson | null = null;

    /**
     * @en A string parsed from the _skeletonJson.
     * @zh 从 _skeletonJson 中解析出的字符串。
     */
    get skeletonJsonStr (): string {
        if (this._skeletonJson) {
            return JSON.stringify(this._skeletonJson);
        }
        return '';
    }

    /**
     * @en See http://en.esotericsoftware.com/spine-json-format
     * @zh 可查看 Spine 官方文档 http://zh.esotericsoftware.com/spine-json-format
     */
    get skeletonJson (): spine.SkeletonJson {
        return this._skeletonJson!;
    }
    set skeletonJson (value: spine.SkeletonJson) {
        this.reset();
        if (typeof (value) === 'string') {
            this._skeletonJson = JSON.parse(value);
        } else {
            this._skeletonJson = value;
        }
        // If create by manual, uuid is empty.
        if (!this._uuid && (value as any).skeleton) {
            this._uuid = (value as any).skeleton.hash;
        }
    }

    /**
     * @en An atlas text description.
     * @zh Atlas 文本描述。
     */
    get atlasText (): string {
        return this._atlasText;
    }
    set atlasText (value) {
        this._atlasText = value;
        this.reset();
    }

    /**
     * @en Texture array.
     * @zh 纹理数组。
     */
    @serializable
    @type([Texture2D])
    public textures: Texture2D[] = [];

    /**
     * @en Texture name array.
     * @zh 纹理名称数组。
     * @private
     */
    @serializable
    @type([CCString])
    public textureNames: string[] = [];

    /**
     * @en
     * A scale can be specified on the JSON or binary loader which will scale the bone positions,
     * image sizes, and animation translations.
     * This can be useful when using different sized images than were used when design ing the skeleton
     * in Spine. For example, if using images that are half the size than were used in Spine,
     * a scale of 0.5 can be used. This is commonly used for games that can run with either low or high
     * resolution texture atlases.
     * see http://en.esotericsoftware.com/spine-using-runtimes#Scaling
     * @zh 在 JSON 或二进制加载器上可以指定一个缩放比例，该缩放比例将缩放骨头位置、图像大小和动画平移。
     * 这在使用与 Spine 中设计骨架不同大小的图像时非常有用。例如，如果使用的图像大小是 Spine 中使用的
     * 图像大小的一半，可以使用 0.5 的缩放比例。这在游戏中经常使用，因为游戏可以使用低分辨率或高分辨率
     * 的纹理图集。可查看 Spine 官方文档：
     * http://zh.esotericsoftware.com/spine-using-runtimes#Scaling
     */
    @serializable
    public scale = 1;

    /**
     * @deprecated since v3.5.0, this is an engine private interface that will be removed in the future.
     */
    get _nativeAsset (): ArrayBuffer {
        return this._buffer!;
    }
    set _nativeAsset (bin: ArrayBuffer) {
        this._buffer = bin;
        this.reset();
    }
    /**
     * @en A string describing atlas.
     * @zh 描述图集信息的字符串。
     */
    @serializable
    protected _atlasText = '';

    private _buffer?: ArrayBuffer;

    private _skeletonCache: spine.SkeletonData | null = null;

    // Cache identity of runtime-created data. Empty until getId() mints it; invalidated by reset().
    private _runtimeId = '';

    // Identities retired by reset() before the instance was destroyed; cleaned exactly once by destroy().
    private _retiredIds: string[] = [];

    // Wasm data registrations owned by this instance, grouped by the cache identity they were created for.
    // Each identity releases only its own registrations, so retiring one identity can never free the
    // registrations another identity still needs.
    private _registrationsByIdentity: Map<string, string[]> = new Map<string, string[]>();

    private _skinsEnum: { [key: string]: number } | null = null;
    private _animsEnum: { [key: string]: number } | null = null;

    constructor () {
        super();
        this.reset();
    }

    /**
     * @internal
     * @deprecated Since v3.7.2, this is an engine private interface that will be removed in the future.
     */
    public createNode (callback: (err: Error|null, node: Node) => void): void {
        const node = new Node(this.name);
        const skeleton = node.addComponent('cc.Skeleton') as Skeleton;
        skeleton.skeletonData = this;

        return callback(null, node);
    }
    /**
     * @en Resets skeleton data state.
     * @zh 重置数据。
     */
    public reset (): void {
        this._skeletonCache = null;
        // Runtime data gets a fresh identity on the next getId(). Retire the previous identity so destroy()
        // can release its bucket and pooled animation caches exactly once; components that are still alive
        // keep their bucket until they release it themselves.
        if (this._runtimeId) {
            this._retiredIds.push(this._runtimeId);
            this._runtimeId = '';
        }
        if (EDITOR_NOT_IN_PREVIEW) {
            this._skinsEnum = null;
            this._animsEnum = null;
        }
    }
    /**
     * @internal Since v3.7.2, this is an engine private function, only works in editor.
     * @en Reset skeleton skin and animation enumeration.
     * @zh 重置皮肤和动画枚举。
     */
    public resetEnums (): void {
        if (EDITOR_NOT_IN_PREVIEW) {
            this._skinsEnum = null;
            this._animsEnum = null;
        }
    }

    /**
     * @en
     * The stable identity of this data for the skeleton cache and the wasm data registry. Bundle and editor
     * assets return their uuid; data created at runtime gets a memoized per-instance id, because its content
     * hash cannot tell two binaries that share an atlas and textures apart.
     * @zh
     * 该数据在骨骼缓存与 wasm 数据注册中的稳定标识。资源包与编辑器资源返回其 uuid；运行时创建的数据
     * 返回记忆化的实例唯一 id，因为内容哈希无法区分共用图集与贴图的两份不同二进制。
     */
    public getId (): string {
        if (this._uuid) return this._uuid;
        if (!this._runtimeId) {
            this._runtimeId = runtimeIdGenerator.getNewId();
        }
        return this._runtimeId;
    }

    /**
     * @internal Identity currently in use, without minting a new one. destroy() must not change identity.
     */
    private currentId (): string {
        return this._uuid || this._runtimeId;
    }

    /**
     * @internal Claim one reference to the wasm registration for the given identity. This is only called on a
     * successful registration path (a fresh factory registration or a confirmed query hit), so the entry is
     * guaranteed to exist. Embind raw pointers can alias different JS wrappers for the same native object, so
     * this intentionally never compares wrapper identity with ===.
     */
    private trackRegisteredUUID (identity: string, uuid: string): void {
        if (!uuid) return;
        registrationRefCounts.set(uuid, (registrationRefCounts.get(uuid) ?? 0) + 1);
        const registrations = this._registrationsByIdentity.get(identity);
        if (registrations) {
            registrations.push(uuid);
        } else {
            this._registrationsByIdentity.set(identity, [uuid]);
        }
    }

    /**
     * @internal Release one reference to a wasm registration; the last owner frees the native entry.
     */
    private releaseRegisteredUUID (uuid: string): void {
        const remaining = (registrationRefCounts.get(uuid) ?? 1) - 1;
        if (remaining > 0) {
            registrationRefCounts.set(uuid, remaining);
            return;
        }
        registrationRefCounts.delete(uuid);
        spine.wasmUtil.destroySpineSkeletonDataWithUUID(uuid);
    }

    /**
     * @en Gets the included SkeletonData used in spine runtime.<br>
     * Returns a sp.spine.SkeletonData object.
     * @zh 获取 Spine Runtime 使用的 SkeletonData。<br>
     * 返回一个 p.spine.SkeletonData 对象。
     * @param quiet @en If vaulue is false, feedback information will be printed when an error occurs.
     *              @zh 值为 false 时，当发生错误时将打印出反馈信息。
     */
    public getRuntimeData (quiet?: boolean): spine.SkeletonData | null {
        if (this._skeletonCache) {
            return this._skeletonCache;
        }

        if (!(this.textures && this.textures.length > 0) && this.textureNames && this.textureNames.length > 0) {
            if (!quiet) {
                error(`${this.name} no textures found!`);
            }
            return null;
        }

        const identity = this.getId();
        const uuid = this.mergedUUID();
        const spData = spine.wasmUtil.querySpineSkeletonDataByUUID(uuid);
        if (spData) {
            this._skeletonCache = spData;
            // A query hit shares the registration with its creator; claim a reference so the creator cannot
            // free it while this instance is still using it.
            this.trackRegisteredUUID(identity, uuid);
        } else {
            const size = this.textures.length;
            const textureUUIDs: string[] = [];
            for (let i = 0; i < size; ++i) {
                const tex = this.textures[i];
                textureUUIDs.push(tex.uuid || tex.getId());
            }
            if (this._skeletonJson) {
                this._skeletonCache = spine.wasmUtil.createSpineSkeletonDataWithJson(this.skeletonJsonStr, this._atlasText, this.textureNames, textureUUIDs);
                spine.wasmUtil.registerSpineSkeletonDataWithUUID(this._skeletonCache, uuid);
                this.trackRegisteredUUID(identity, uuid);
            } else {
                const rawData = new Uint8Array(this._nativeAsset);
                const byteSize = rawData.length;
                const ptr = spine.wasmUtil.createStoreMemory(byteSize);
                const wasmMem = spine.wasmUtil.wasm.HEAPU8.subarray(ptr, ptr + byteSize);
                wasmMem.set(rawData);
                this._skeletonCache = spine.wasmUtil.createSpineSkeletonDataWithBinary(byteSize, this._atlasText, this.textureNames, textureUUIDs);
                spine.wasmUtil.registerSpineSkeletonDataWithUUID(this._skeletonCache, uuid);
                this.trackRegisteredUUID(identity, uuid);
                spine.wasmUtil.freeStoreMemory();
            }
        }
        return this._skeletonCache;
    }

    /**
     * @internal Since v3.7.2, this is an engine private function, it only works in editor.
     */
    public getSkinsEnum (): {
        [key: string]: number;
    } | null {
        if (this._skinsEnum /* && Object.keys(this._skinsEnum).length > 0 */) {
            return this._skinsEnum;
        }
        const sd = this.getRuntimeData(true);
        if (sd) {
            const skins = sd.skins;
            const enumDef: {[key: string]: number} = {};
            for (let i = 0; i < skins.length; i++) {
                const name = skins[i].name;
                enumDef[name] = i;
            }
            return this._skinsEnum = Enum(enumDef);
        }
        return null;
    }
    /**
     * @internal Since v3.7.2, this is an engine private function, it only works in editor.
     */
    public getAnimsEnum (): {
        [key: string]: number;
    } | null {
        if (this._animsEnum && Object.keys(this._animsEnum).length > 1) {
            return this._animsEnum;
        }
        const sd = this.getRuntimeData(true);
        if (sd) {
            const enumDef: {[key: string]: number} = { '<None>': 0 };
            const anims = sd.animations;
            for (let i = 0; i < anims.length; i++) {
                const name = anims[i].name;
                enumDef[name] = i + 1;
            }
            return this._animsEnum = Enum(enumDef);
        }
        return null;
    }

    private mergedUUID (): string {
        // merge texture's id and atlas content
        const hashContent = [
            this._atlasText,
            ...this.textures.map((texture) => texture.getId()),
        ].join('');

        // Merge the stable identity and hashContent. The identity is the asset uuid for bundle/editor assets
        // and a unique per-instance id for runtime-created data, so distinct binaries that share an atlas and
        // textures can no longer register over each other in the wasm data map.
        return `${this.getId()}${murmurhash2_32_gc(hashContent, 668)}`;
    }

    /**
     * @en Destroy skeleton data.
     * @zh 销毁 skeleton data。
     */
    public destroy (): boolean {
        // Release every identity this instance used. destroyCachedAnimations() keeps buckets that still have
        // live owners, so this can never strand or prematurely dispose another component's skeleton.
        const sharedCache = SkeletonCache.sharedCache;
        const identities: string[] = [];
        const cacheId = this.currentId();
        if (cacheId) identities.push(cacheId);
        for (let i = 0; i < this._retiredIds.length; i++) {
            identities.push(this._retiredIds[i]);
        }
        // Registrations whose identity is not current/retired can only come from a direct identity mutation;
        // include them so they are never leaked.
        this._registrationsByIdentity.forEach((_registrations, identity): void => {
            if (identities.indexOf(identity) < 0) identities.push(identity);
        });
        for (let i = 0; i < identities.length; i++) {
            sharedCache.destroyCachedAnimations(identities[i]);
        }
        // Release each identity independently: freeing one identity's registrations must never free another
        // identity that still has live owners. Each identity's release runs once, when its own owners left.
        for (let i = 0; i < identities.length; i++) {
            const identity = identities[i];
            const release = (): void => {
                const registrations = this._registrationsByIdentity.get(identity);
                if (!registrations) return;
                this._registrationsByIdentity.delete(identity);
                for (let j = 0; j < registrations.length; j++) {
                    this.releaseRegisteredUUID(registrations[j]);
                }
            };
            if (SkeletonCache.hasLiveOwners(identity)) {
                sharedCache.deferRelease(identity, release);
            } else {
                release();
            }
        }
        this._retiredIds.length = 0;
        return super.destroy();
    }

    /**
     * @engineInternal
     * @mangle
     */
    public isEmpty (): boolean {
        return this._atlasText.length === 0 && !this._skeletonJson && !this._nativeAsset;
    }
}

legacyCC.internal.SpineSkeletonData = SkeletonData;
