import {
    _decorator, Camera, Canvas, Color, Component, director, Director, EventKeyboard, EventTouch,
    game, Game, input, Input, isValid, KeyCode, Label, Layers, Node,
    ResolutionPolicy, Scene, Sprite, SpriteFrame, sys, Texture2D, UITransform, view,
} from 'cc';
import { createGame, hasWon, isGameOver, parseGame, playMove } from './logic.js';
import type { Direction, GameState } from './logic.js';

const SAVE_KEY = 'cocos4.2048.v1';
const LAYOUT = {
    width: 480, height: 760,
    board: { x: 0, y: -22, width: 432, height: 432 },
    restart: { x: 152, y: 242, width: 128, height: 48 },
};

export const probe = {
    ready: false, board: Array<number>(16).fill(0), score: 0, best: 0, moves: 0,
    inputCount: 0, restarts: 0, won: false, over: false,
    layout: { ...LAYOUT, board: { ...LAYOUT.board }, restart: { ...LAYOUT.restart } },
};

const PAPER = new Color(246, 241, 231);
const INK = new Color(38, 57, 70);
const MUTED = new Color(104, 116, 117);
const CARD = new Color(232, 228, 217);
const RUST = new Color(158, 82, 63);
const SAGE = new Color(53, 109, 94);
const TILE_COLORS = [
    new Color(59, 78, 90), new Color(239, 233, 221), new Color(220, 221, 200),
    new Color(182, 208, 194), new Color(135, 181, 163), new Color(104, 157, 150),
    new Color(56, 100, 110), new Color(218, 170, 119), new Color(209, 155, 126),
    new Color(174, 98, 78), new Color(141, 100, 122), new Color(221, 188, 105),
    new Color(112, 89, 123),
];

function uiNode(parent: Node, name: string, x: number, y: number, width: number, height: number): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    node.setPosition(x, y, 0);
    node.addComponent(UITransform).setContentSize(width, height);
    parent.addChild(node);
    return node;
}

function text(parent: Node, name: string, value: string, x: number, y: number, width: number,
    height: number, size: number, color = INK, bold = false): Label {
    const label = uiNode(parent, name, x, y, width, height).addComponent(Label);
    label.string = value;
    label.useSystemFont = true;
    label.fontFamily = 'sans-serif';
    label.fontSize = size;
    label.lineHeight = size * 1.25;
    label.color = color;
    label.isBold = bold;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.enableWrapText = false;
    label.overflow = Label.Overflow.SHRINK;
    return label;
}

@_decorator.ccclass('Sample2048')
class Sample2048 extends Component {
    private state!: GameState;
    private boardNode!: Node;
    private restartNode!: Node;
    private buttonFace!: Sprite;
    private scoreLabel!: Label;
    private bestLabel!: Label;
    private statusLabel!: Label;
    private detailLabel!: Label;
    private ready = false;
    private inputCount = 0;
    private restarts = 0;
    private gesture: { id: number; target: 'board' | 'restart'; x: number; y: number } | null = null;
    private readonly tiles: { sprite: Sprite; label: Label; pop: number }[] = [];
    private readonly panels: Sprite[] = [];
    private readonly panelFrames = new Map<number, { texture: Texture2D; frame: SpriteFrame }>();

    private panel(parent: Node, name: string, x: number, y: number, width: number, height: number,
        color: Color, radius = 12): Sprite {
        let resources = this.panelFrames.get(radius);
        if (!resources) {
            // Nine-slicing stretches the solid center, preserving antialiased corner radii.
            const size = radius * 2 + 2;
            const pixels = new Uint8Array(size * size * 4).fill(255);
            for (let py = 0; py < size; py++) {
                for (let px = 0; px < size; px++) {
                    const dx = Math.max(Math.abs(px + 0.5 - size / 2) - 1, 0);
                    const dy = Math.max(Math.abs(py + 0.5 - size / 2) - 1, 0);
                    const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy)));
                    pixels[(py * size + px) * 4 + 3] = Math.round(coverage * 255);
                }
            }
            const texture = new Texture2D();
            const frame = new SpriteFrame();
            resources = { texture, frame };
            this.panelFrames.set(radius, resources);
            texture.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
            texture.setMipFilter(Texture2D.Filter.NONE);
            texture.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);
            texture.reset({ width: size, height: size, format: Texture2D.PixelFormat.RGBA8888, mipmapLevel: 1 });
            texture.uploadData(pixels);
            frame.reset({ texture, borderTop: radius, borderBottom: radius, borderLeft: radius, borderRight: radius });
            frame.packable = false;
        }
        const sprite = uiNode(parent, name, x, y, width, height).addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.type = Sprite.Type.SLICED;
        sprite.spriteFrame = resources.frame;
        sprite.color = color;
        this.panels.push(sprite);
        return sprite;
    }

    protected onLoad(): void {
        let saved: GameState | null = null;
        try { saved = parseGame(sys.localStorage.getItem(SAVE_KEY)); } catch { /* Storage is optional. */ }
        this.state = saved ?? createGame();

        text(this.node, 'Eyebrow', 'MAKE A LITTLE ROOM', 0, 354, 432, 20, 11, MUTED)
            .horizontalAlign = Label.HorizontalAlign.LEFT;
        this.panel(this.node, 'Accent', 196, 354, 40, 4, RUST, 2);
        const title = text(this.node, 'Title', '2048', -108, 304, 216, 96, 78, INK, true);
        title.fontFamily = 'serif';
        title.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.panel(this.node, 'ScoreCard', 52, 309, 100, 70, CARD);
        this.panel(this.node, 'BestCard', 166, 309, 100, 70, CARD);
        text(this.node, 'ScoreHeading', 'SCORE', 52, 328, 88, 18, 11, MUTED, true);
        text(this.node, 'BestHeading', 'BEST', 166, 328, 88, 18, 11, MUTED, true);
        this.scoreLabel = text(this.node, 'Score', '0', 52, 300, 88, 36, 28, INK, true);
        this.bestLabel = text(this.node, 'Best', '0', 166, 300, 88, 36, 28, INK, true);
        text(this.node, 'Tagline', 'Join the numbers.\nMake something bigger.', -78, 242, 276, 48, 17)
            .horizontalAlign = Label.HorizontalAlign.LEFT;

        const restart = LAYOUT.restart;
        this.restartNode = uiNode(this.node, 'NewGame', restart.x, restart.y, restart.width, restart.height);
        this.buttonFace = this.panel(this.restartNode, 'ButtonFace', 0, 0, restart.width, restart.height, INK);
        text(this.buttonFace.node, 'ButtonLabel', 'New Game', 0, 0, 116, 40, 16, PAPER, true);

        const board = LAYOUT.board;
        this.panel(this.node, 'BoardShadow', board.x, board.y - 7, board.width, board.height, new Color(219, 213, 201), 20);
        this.boardNode = this.panel(this.node, 'Board', board.x, board.y, board.width, board.height, INK, 20).node;
        for (let i = 0; i < 16; i++) {
            const x = (i % 4 - 1.5) * 105;
            const y = (1.5 - Math.floor(i / 4)) * 105;
            const sprite = this.panel(this.boardNode, `Tile${i}`, x, y, 93, 93, TILE_COLORS[0]!, 10);
            const label = text(sprite.node, 'Number', '', 0, 0, 83, 83, 42, INK, true);
            this.tiles.push({ sprite, label, pop: 0 });
        }

        this.panel(this.node, 'Feedback', 0, -284, 432, 62, CARD);
        this.statusLabel = text(this.node, 'Status', '', 0, -272, 408, 26, 18, INK, true);
        this.detailLabel = text(this.node, 'Detail', '', 0, -295, 408, 22, 14, MUTED);
        text(this.node, 'Controls', 'Arrow keys / WASD   |   Swipe the board', 0, -336, 432, 26, 15);
        text(this.node, 'Footer', 'NO TIMER. JUST ONE MORE MOVE.', 0, -359, 432, 18, 10, MUTED);
        this.refresh();
        this.save();
    }

    protected onEnable(): void {
        for (const node of [this.boardNode, this.restartNode]) {
            node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
            node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
            node.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        }
        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        game.on(Game.EVENT_HIDE, this.onHide, this);
        director.once(Director.EVENT_AFTER_DRAW, this.markReady, this);
    }

    protected onDisable(): void {
        for (const node of [this.boardNode, this.restartNode]) {
            node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
            node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
            node.off(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        }
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        game.off(Game.EVENT_HIDE, this.onHide, this);
        director.off(Director.EVENT_AFTER_DRAW, this.markReady, this);
        this.ready = false;
        probe.ready = false;
        this.clearGesture();
        this.save();
    }

    protected onDestroy(): void {
        // These generated assets are exclusive to this component, not shared loaded assets.
        for (const sprite of this.panels) {
            if (isValid(sprite, true)) sprite.spriteFrame = null;
        }
        for (const { frame, texture } of this.panelFrames.values()) {
            frame.destroy();
            texture.destroy();
        }
        this.panels.length = 0;
        this.panelFrames.clear();
    }

    private markReady(): void {
        this.ready = true;
        probe.ready = true;
    }

    private onKeyDown(event: EventKeyboard): void {
        switch (event.keyCode) {
        case KeyCode.ARROW_LEFT: case KeyCode.KEY_A: this.move('left'); break;
        case KeyCode.ARROW_RIGHT: case KeyCode.KEY_D: this.move('right'); break;
        case KeyCode.ARROW_UP: case KeyCode.KEY_W: this.move('up'); break;
        case KeyCode.ARROW_DOWN: case KeyCode.KEY_S: this.move('down'); break;
        }
    }

    private onTouchStart(event: EventTouch): void {
        if (!this.ready || this.gesture !== null) return;
        const id = event.getID();
        if (id === null) return;
        const point = event.getUILocation();
        const target = event.currentTarget === this.restartNode ? 'restart' : 'board';
        this.gesture = { id, target, x: point.x, y: point.y };
        if (target === 'restart') this.buttonFace.node.setScale(0.97, 0.97, 1);
    }

    private onTouchEnd(event: EventTouch): void {
        const gesture = this.gesture;
        if (!gesture || event.getID() !== gesture.id) return;
        const point = event.getUILocation();
        this.clearGesture();
        if (!this.ready) return;
        if (gesture.target === 'restart') {
            this.restarts++;
            this.state = createGame(this.state.best);
            this.refresh();
            this.save();
            return;
        }
        const dx = point.x - gesture.x;
        const dy = point.y - gesture.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
        this.move(Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'up' : 'down'));
    }

    private onTouchCancel(event: EventTouch): void {
        const id = event.getID();
        if (id === null || id === this.gesture?.id) this.clearGesture();
    }

    private clearGesture(): void {
        this.gesture = null;
        this.buttonFace.node.setScale(1, 1, 1);
    }

    private onHide(): void {
        this.clearGesture();
        this.save();
    }

    private move(direction: Direction): void {
        if (!this.ready) return;
        this.clearGesture();
        this.inputCount++;
        const previous = this.state;
        this.state = playMove(previous, direction);
        const changed = this.state.moves !== previous.moves;
        this.refresh(previous.board, this.state.score - previous.score, !changed);
        if (changed) this.save();
    }

    private refresh(previous?: readonly number[], gained = 0, noMove = false): void {
        const { board, score, best, moves } = this.state;
        this.tiles.forEach((tile, index) => {
            const value = board[index]!;
            tile.sprite.color = TILE_COLORS[value === 0 ? 0 : Math.min(Math.log2(value), TILE_COLORS.length - 1)]!;
            tile.label.string = value === 0 ? '' : String(value);
            tile.label.fontSize = value < 100 ? 42 : value < 1000 ? 36 : value < 10000 ? 30 : 24;
            tile.label.lineHeight = tile.label.fontSize * 1.25;
            tile.label.color = value === 64 || value === 512 || value === 1024 || value > 2048 ? PAPER : INK;
            tile.pop = previous && previous[index] !== value && value > 0 ? 0.14 : 0;
            const scale = tile.pop > 0 ? 0.88 : 1;
            tile.sprite.node.setScale(scale, scale, 1);
        });
        const won = hasWon(board);
        const over = isGameOver(board);
        this.scoreLabel.string = String(score);
        this.bestLabel.string = String(best);
        this.statusLabel.color = over ? RUST : won ? SAGE : INK;
        this.statusLabel.string = over ? (won ? '2048 reached. Board complete.' : 'No moves left.')
            : won ? '2048. Beautifully done.' : noMove ? 'Try another direction.'
                : gained > 0 ? `+${gained} points. A little closer.` : 'Small steps. Big possibilities.';
        this.detailLabel.string = over ? 'Tap New Game for a fresh board.'
            : won ? 'Keep going, or start fresh with New Game.'
                : noMove ? 'Nothing moved. No tile was added.'
                    : `${moves} ${moves === 1 ? 'move' : 'moves'}  |  Join equal tiles to reach 2048.`;
        Object.assign(probe, {
            board: [...board], score, best, moves, won, over,
            inputCount: this.inputCount, restarts: this.restarts,
        });
    }

    protected update(dt: number): void {
        for (const tile of this.tiles) {
            if (tile.pop <= 0) continue;
            tile.pop = Math.max(0, tile.pop - dt);
            const scale = 1 - 0.12 * (tile.pop / 0.14) ** 2;
            tile.sprite.node.setScale(scale, scale, 1);
        }
    }

    private save(): void {
        try { sys.localStorage.setItem(SAVE_KEY, JSON.stringify(this.state)); } catch { /* Play without storage. */ }
    }
}

export async function start(): Promise<void> {
    probe.ready = false;
    view.setDesignResolutionSize(480, 760, ResolutionPolicy.SHOW_ALL);
    view.resizeWithBrowserSize(true);
    const scene = new Scene('2048');
    const cameraNode = new Node('UICamera');
    scene.addChild(cameraNode);
    cameraNode.setPosition(0, 0, 1000);
    const camera = cameraNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = 380;
    camera.near = 1;
    camera.far = 2000;
    camera.visibility = Layers.Enum.UI_2D;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = PAPER;
    const root = uiNode(scene, 'Canvas', 0, 0, LAYOUT.width, LAYOUT.height);
    const canvas = root.addComponent(Canvas);
    // Canvas fits the camera to SHOW_ALL's actual scale, including tall or wide windows.
    canvas.alignCanvasWithScreen = true;
    canvas.cameraComponent = camera;
    root.addComponent(Sample2048);
    director.runSceneImmediate(scene);
}
