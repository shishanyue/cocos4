/// <reference path="../../bin/.declarations/cc.d.ts" />
/// <reference path="../../bin/.declarations/cc.editor.d.ts" />

import { Node, TiledLayer, dragonBones } from 'cc';
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
