import {
    assetManager, Camera, Canvas, Color, director, Director, ImageAsset, Layers,
    Node, Scene, Sprite, SpriteFrame, Texture2D, UITransform,
} from 'cc';

export const state = { ready: false, imageLoaded: false, clicks: 0, frames: 0, x: 0 };

// This single-scene bootstrap owns the image resources for its application lifetime.
export async function start(): Promise<void> {
    const image = await new Promise<ImageAsset>((resolve, reject) => {
        assetManager.loadRemote<ImageAsset>('assets/probe/tile.png', { maxRetryCount: 0 },
            (error, asset) => error ? reject(error) : resolve(asset));
    });
    if (image.width !== 32 || image.height !== 32) throw new Error('Unexpected probe image');
    state.imageLoaded = true;
    const texture = new Texture2D();
    texture.image = image;
    const frame = new SpriteFrame();
    frame.texture = texture;
    frame.addRef();

    const scene = new Scene('BrowserBootstrap2D');
    const cameraNode = new Node('OrthographicCamera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, 0, 1000);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = 240;
    camera.near = 1;
    camera.far = 2000;
    camera.visibility = Layers.Enum.UI_2D;
    camera.clearColor = new Color(16, 24, 40, 255);

    const canvasNode = new Node('Canvas');
    canvasNode.layer = Layers.Enum.UI_2D;
    scene.addChild(canvasNode);
    canvasNode.addComponent(UITransform).setContentSize(640, 480);
    const canvas = canvasNode.addComponent(Canvas);
    canvas.cameraComponent = camera;
    canvas.alignCanvasWithScreen = false;

    const tile = new Node('ImageSprite');
    tile.layer = Layers.Enum.UI_2D;
    canvasNode.addChild(tile);
    tile.addComponent(UITransform).setContentSize(128, 128);
    const sprite = tile.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.spriteFrame = frame;
    sprite.color = new Color(240, 80, 64, 255);
    tile.on(Node.EventType.TOUCH_END, () => {
        state.clicks++;
        state.x = state.clicks % 2 ? 144 : 0;
        tile.setPosition(state.x, 0, 0);
        sprite.color = state.clicks % 2 ? new Color(48, 176, 240, 255) : new Color(240, 80, 64, 255);
    });
    director.on(Director.EVENT_AFTER_DRAW, () => { state.frames++; });
    director.runSceneImmediate(scene);
    state.ready = true;
}
