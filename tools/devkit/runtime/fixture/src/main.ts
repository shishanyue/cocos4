import {
    _decorator, Asset, assetManager, AudioClip, AudioSource, Camera, Canvas, Color, Component,
    director, ImageAsset, input, Input, EventKeyboard, KeyCode, JsonAsset, js, Label, Layers,
    Node, Scene, Sprite, SpriteFrame, Texture2D, UITransform,
} from 'cc';
import { createWorld } from './world.js';

const { ccclass, property } = _decorator;

export const probe = {
    ready: false, score: 0, restarts: 0, starts: 0, clicks: 0, decoratedDefault: 0,
    classRegistered: false, imageLoaded: false, jsonLoaded: false, audioLoaded: false,
    audioStarted: 0, audioEnded: 0, missingRejected: false, world3d: false, error: '',
};

let tile: SpriteFrame;
let clip: AudioClip;
let rules: { title: string; restart: string };

function load<T extends Asset>(url: string): Promise<T> {
    return new Promise((resolve, reject) => assetManager.loadRemote<T>(url, { maxRetryCount: 0 },
        (error, asset) => error ? reject(error) : resolve(asset)));
}

@ccclass('RuntimeClickPlayer')
export class RuntimeClickPlayer extends Component {
    @property
    pointsPerClick = 7;

    private tileNode: Node | null = null;
    private label: Label | null = null;
    private audio: AudioSource | null = null;

    start(): void {
        probe.starts++;
        probe.decoratedDefault = this.pointsPerClick;
        probe.classRegistered = js.getClassByName('RuntimeClickPlayer') === RuntimeClickPlayer;
        this.tileNode = new Node('ClickTile');
        this.tileNode.layer = Layers.Enum.UI_2D;
        this.node.addChild(this.tileNode);
        const transform = this.tileNode.addComponent(UITransform);
        transform.setContentSize(160, 160);
        const sprite = this.tileNode.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = tile;
        this.tileNode.on(Node.EventType.TOUCH_END, this.clickTile, this);
        const text = new Node('Instructions');
        text.layer = Layers.Enum.UI_2D;
        this.node.addChild(text);
        text.setPosition(0, 150);
        text.addComponent(UITransform).setContentSize(600, 100);
        this.label = text.addComponent(Label);
        this.label.fontSize = 24;
        this.label.lineHeight = 32;
        this.audio = this.node.addComponent(AudioSource);
        this.audio.clip = clip;
        this.audio.playOnAwake = false;
        this.node.on(AudioSource.EventType.STARTED, () => probe.audioStarted++, this);
        this.node.on(AudioSource.EventType.ENDED, () => probe.audioEnded++, this);
        input.on(Input.EventType.KEY_UP, this.keyUp, this);
        this.refresh();
        probe.ready = true;
    }

    private clickTile(): void {
        probe.clicks++;
        probe.score += this.pointsPerClick;
        this.tileNode!.setPosition(probe.clicks % 2 ? 150 : 0, 0);
        this.tileNode!.getComponent(Sprite)!.color = probe.clicks % 2 ? new Color(255, 100, 80) : Color.WHITE;
        this.audio!.play();
        this.refresh();
    }

    private refresh(): void {
        this.label!.string = `${rules.title}  ${probe.score}\n${rules.restart}`;
    }

    private keyUp(event: EventKeyboard): void {
        if (event.keyCode !== KeyCode.KEY_R) return;
        probe.restarts++;
        probe.score = 0;
        probe.clicks = 0;
        probe.ready = false;
        createScene();
    }

    onDestroy(): void {
        input.off(Input.EventType.KEY_UP, this.keyUp, this);
    }
}

export function createScene(): Scene {
    const scene = new Scene('RuntimeCodeScene');
    probe.world3d = createWorld(scene);
    const cameraNode = new Node('UICamera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, 0, 1000);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = 240;
    camera.near = 1;
    camera.far = 2000;
    camera.visibility = Layers.Enum.UI_2D;
    camera.clearColor = new Color(16, 24, 40, 255);
    if (probe.world3d) camera.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
    camera.priority = 1;
    const canvasNode = new Node('Canvas');
    canvasNode.layer = Layers.Enum.UI_2D;
    scene.addChild(canvasNode);
    canvasNode.addComponent(UITransform).setContentSize(640, 480);
    const canvas = canvasNode.addComponent(Canvas);
    canvas.cameraComponent = camera;
    canvas.alignCanvasWithScreen = false;
    canvasNode.addComponent(RuntimeClickPlayer);
    director.runSceneImmediate(scene);
    return scene;
}

export async function start(): Promise<void> {
    const json = await load<JsonAsset>('assets/game/rules.json');
    rules = json.json as typeof rules;
    probe.jsonLoaded = rules.title === 'CLICK THE TILE';
    const image = await load<ImageAsset>('assets/game/tile.png');
    probe.imageLoaded = image.width === 32 && image.height === 32;
    const texture = new Texture2D();
    texture.image = image;
    tile = new SpriteFrame();
    tile.texture = texture;
    // Shared for the application lifetime, across independently destroyed code scenes.
    tile.addRef();
    clip = await load<AudioClip>('assets/game/click.wav');
    clip.addRef();
    probe.audioLoaded = clip.getDuration() > 0;
    createScene();
}

export async function checkMissingAsset(): Promise<void> {
    try { await load<ImageAsset>('assets/game/intentionally-missing.png'); }
    catch { probe.missingRejected = true; return; }
    throw new Error('Missing image unexpectedly loaded');
}
