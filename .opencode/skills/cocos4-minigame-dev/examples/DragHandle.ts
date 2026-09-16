import { _decorator, Component, EventTouch, game, Game, isValid, Node, UITransform, Vec2, Vec3 } from 'cc';

const { ccclass, requireComponent } = _decorator;

// Standard screen-aligned Canvas only; both this node and its parent need UITransform.
// Do not let Widget/Layout own this node's position while dragging.
@ccclass('SkillDragHandle')
@requireComponent(UITransform)
export class DragHandle extends Component {
    private touchId: number | null = null;
    private parentUI: UITransform | null = null;
    private readonly uiPoint = new Vec2();
    private readonly worldPoint = new Vec3();
    private readonly localPoint = new Vec3();
    private readonly offset = new Vec3();

    protected onEnable (): void {
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        game.on(Game.EVENT_HIDE, this.clearGesture, this);
    }

    protected onDisable (): void {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        game.off(Game.EVENT_HIDE, this.clearGesture, this);
        this.clearGesture();
    }

    private onTouchStart (event: EventTouch): void {
        const id = event.getID();
        if (this.touchId !== null || id === null) return;
        this.parentUI = this.node.parent?.getComponent(UITransform) ?? null;
        if (!this.readLocalPoint(event)) {
            this.clearGesture();
            return;
        }
        this.touchId = id;
        this.offset.set(this.node.position).subtract(this.localPoint);
    }

    private onTouchMove (event: EventTouch): void {
        if (this.touchId === null || event.getID() !== this.touchId) return;
        if (!this.readLocalPoint(event)) {
            this.clearGesture();
            return;
        }
        this.node.setPosition(this.localPoint.add(this.offset));
    }

    private onTouchEnd (event: EventTouch): void {
        if (event.getID() === this.touchId) this.clearGesture();
    }

    private readLocalPoint (event: EventTouch): boolean {
        const parentUI = this.parentUI;
        if (!parentUI || !isValid(parentUI, true) || this.node.parent !== parentUI.node) return false;
        event.getUILocation(this.uiPoint);
        this.worldPoint.set(this.uiPoint.x, this.uiPoint.y, 0);
        parentUI.convertToNodeSpaceAR(this.worldPoint, this.localPoint);
        return true;
    }

    private clearGesture (): void {
        this.touchId = null;
        this.parentUI = null;
    }
}
