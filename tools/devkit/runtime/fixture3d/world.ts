import { _decorator, Camera, Color, Component, Layers, Material, MeshRenderer, Node, primitives, Scene, utils } from 'cc';
import type { Mesh } from 'cc';

const { ccclass, property } = _decorator;
let mesh: Mesh;
let material: Material;

@ccclass('RuntimeCube')
export class RuntimeCube extends Component {
    @property
    tilt = 25;

    start(): void {
        this.node.setRotationFromEuler(this.tilt, 35, 0);
    }
}

export function createWorld(scene: Scene): boolean {
    const cameraNode = new Node('WorldCamera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, 0, 8);
    const camera = cameraNode.addComponent(Camera);
    camera.visibility = Layers.Enum.DEFAULT;
    camera.clearColor = new Color(16, 24, 40, 255);
    const cube = new Node('MeshCube');
    scene.addChild(cube);
    cube.setPosition(0, -2.1, 0);
    const renderer = cube.addComponent(MeshRenderer);
    // One shared mesh/material pair for the application lifetime, not new assets on each restart.
    if (!mesh) {
        mesh = utils.createMesh(primitives.box({ width: 0.9, height: 0.9, length: 0.9 }));
        mesh.addRef();
        material = new Material();
        material.initialize({ effectName: 'builtin-unlit' });
        material.setProperty('mainColor', new Color(240, 180, 45, 255));
        material.addRef();
    }
    renderer.mesh = mesh;
    renderer.setMaterial(material, 0);
    cube.addComponent(RuntimeCube);
    return true;
}
