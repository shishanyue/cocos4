/// <reference path="../../bin/.declarations/cc.d.ts" />
/// <reference path="../../bin/.declarations/cc.editor.d.ts" />

import { Node, TiledLayer, dragonBones, sp, sys } from 'cc';
import { poseGraphOp } from 'cc/editor/new-gen-anim';
import { codec } from 'cc/editor/particle-system-2d-utils';

declare const armature: dragonBones.ArmatureDisplay;
const sockets: Map<string, Node> = armature.socketNodes;
sockets.set('root', new Node());
// @ts-expect-error DragonBones' dictionary type must not shadow the ES Map.
armature.socketNodes.set('root', 1);

declare const layer: TiledLayer;
// @ts-expect-error SafeArray must preserve possibly absent rows.
const row: object = layer.vertices[0];

declare const poseNode: poseGraphOp.Node;
const keys: readonly poseGraphOp.InputKey[] = poseGraphOp.getInputKeys(poseNode);
// @ts-expect-error Editor input paths must not become any.
const invalidKey: number = keys[0];
const unpacked: string = codec.unzipBase64('');

declare const context: GPUCanvasContext;
const texture: GPUTexture = context.getCurrentTexture();

const bilibiliPlatform: typeof sys.platform = sys.Platform.BILIBILI_MINI_GAME;
// @ts-expect-error Platform identities must not widen to arbitrary strings.
const invalidPlatform: typeof sys.platform = 'NOT_A_PLATFORM';

// Exact comparisons reject implicit or explicit any under the repository's declaration-check baseline.
type Equal<Actual, Expected> = (<T>() => T extends Actual ? 1 : 2) extends
    (<T>() => T extends Expected ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type DragonBonesArmatureDeclarations = [
    Assert<Equal<dragonBones.Armature['_bones'], dragonBones.Bone[]>>,
    Assert<Equal<dragonBones.Armature['_animation'], dragonBones.Animation | null>>,
];

type SpineDeclarations = [
    Assert<Equal<ReturnType<sp.spine.SPVectorFloat['resize']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SPVectorFloat['set']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SPVectorFloat['delete']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SPVectorPhysicsConstraintPtr['delete']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SPVectorPhysicsConstraintDataPtr['delete']>, void>>,
    Assert<Equal<sp.spine.SwirlEffect['worldX'], number>>,
    Assert<Equal<sp.spine.SwirlEffect['worldY'], number>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['destroy']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['initSkeleton']>, sp.spine.Skeleton>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['getAnimationState']>, sp.spine.AnimationState | null>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setSkin']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setPremultipliedAlpha']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setColor']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setMix']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['updateAnimation']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setUseTint']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['clearEffect']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setJitterEffect']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setSwirlEffect']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['updateRenderData']>, sp.spine.SpineModel>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setListener']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setDebugMode']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['getDebugShapes']>, sp.spine.SPVectorDebugShape>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['resizeSlotRegion']>, void>>,
    Assert<Equal<ReturnType<sp.spine.SkeletonInstance['setSlotTexture']>, void>>,
    Assert<Equal<ReturnType<typeof sp.spine.wasmUtil.registerSpineSkeletonDataWithUUID>, void>>,
    Assert<Equal<ReturnType<typeof sp.spine.wasmUtil.destroySpineSkeletonDataWithUUID>, void>>,
];

type SpineWasmPayloadDeclarations = [
    Assert<Equal<sp.spine.SpineModel['vCount' | 'iCount' | 'vPtr' | 'iPtr'], number>>,
    Assert<Equal<ReturnType<sp.spine.SpineModel['getData']>, sp.spine.SPVectorUint>>,
    Assert<Equal<ReturnType<sp.spine.SpineModel['getTextures']>, sp.spine.SPVectorSPString>>,
    Assert<Equal<ReturnType<sp.spine.SPVectorUint['get']>, number>>,
    Assert<Equal<ReturnType<sp.spine.SPVectorSPString['get']>, string>>,
    Assert<Equal<ReturnType<sp.spine.SPVectorDebugShape['get']>, sp.spine.SpineDebugShape>>,
    Assert<Equal<sp.spine.SpineDebugShape['type' | 'vOffset' | 'vCount' | 'iOffset' | 'iCount'], number>>,
];
