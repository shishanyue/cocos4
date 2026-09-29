import { _decorator, Component, EventTouch, game, Game, Label, Node, UITransform } from 'cc';

const { ccclass, requireComponent } = _decorator;

// Attach to a visible UI node; assign a scene-owned Label after addComponent.
@ccclass('Cocos4SkillTapCounter')
@requireComponent(UITransform)
export class TapCounter extends Component {
    label: Label | null = null;
    pointsPerTap = 1;
    private score = 0;
    private touchId: number | null = null;

    protected onEnable(): void {
        this.node.on(Node.EventType.TOUCH_START, this.begin, this);
        this.node.on(Node.EventType.TOUCH_END, this.finish, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.cancel, this);
        game.on(Game.EVENT_HIDE, this.clearGesture, this);
        this.refresh();
    }

    protected onDisable(): void {
        this.node.off(Node.EventType.TOUCH_START, this.begin, this);
        this.node.off(Node.EventType.TOUCH_END, this.finish, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.cancel, this);
        game.off(Game.EVENT_HIDE, this.clearGesture, this);
        this.clearGesture();
    }

    reset(): void {
        this.clearGesture();
        this.score = 0;
        this.refresh();
    }

    private begin(event: EventTouch): void {
        if (this.touchId === null) this.touchId = event.getID();
    }

    private finish(event: EventTouch): void {
        if (this.touchId === null || event.getID() !== this.touchId) return;
        this.clearGesture();
        this.score += this.pointsPerTap;
        this.refresh();
    }

    private cancel(event: EventTouch): void {
        if (event.getID() === this.touchId) this.clearGesture();
    }

    private clearGesture(): void { this.touchId = null; }
    private refresh(): void { if (this.label) this.label.string = `Score: ${this.score}`; }
}
