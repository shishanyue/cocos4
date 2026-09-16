import { _decorator, assetManager, Component, isValid, Sprite, SpriteFrame, warn } from 'cc';

const { ccclass, property, requireComponent } = _decorator;

// Attach to a Sprite node. This component exclusively owns its dynamic spriteFrame.
// Configure a real bundle and imported SpriteFrame path in the Inspector.
@ccclass('SkillBundleSprite')
@requireComponent(Sprite)
export class BundleSprite extends Component {
    @property
    bundleName = '';

    @property
    framePath = '';

    private generation = 0;
    private frame: SpriteFrame | null = null;
    private target: Sprite | null = null;

    protected onEnable (): void {
        const generation = ++this.generation;
        const target = this.getComponent(Sprite);
        if (!target || !this.bundleName || !this.framePath) {
            warn('SkillBundleSprite requires a Sprite, bundle name and SpriteFrame path.');
            return;
        }
        const framePath = this.framePath;
        assetManager.loadBundle(this.bundleName, (bundleError, bundle) => {
            if (!this.isCurrent(generation, target)) return;
            if (bundleError) {
                warn('Failed to load sprite bundle', bundleError);
                return;
            }
            bundle.load(framePath, SpriteFrame, (frameError, frame) => {
                if (frameError) {
                    if (this.isCurrent(generation, target)) warn('Failed to load sprite frame', frameError);
                    return;
                }
                // Own the result even when stale, then transfer or balance that lease.
                frame.addRef();
                if (!this.isCurrent(generation, target)) {
                    frame.decRef();
                    return;
                }
                this.frame = frame;
                this.target = target;
                target.spriteFrame = frame;
            });
        });
    }

    protected onDisable (): void {
        ++this.generation;
        const frame = this.frame;
        const target = this.target;
        this.frame = null;
        this.target = null;
        if (frame) {
            if (target && isValid(target, true) && target.spriteFrame === frame) {
                target.spriteFrame = null;
            }
            frame.decRef();
        }
    }

    private isCurrent (generation: number, target: Sprite): boolean {
        return generation === this.generation
            && isValid(this, true)
            && isValid(this.node, true)
            && this.enabledInHierarchy
            && isValid(target, true)
            && isValid(target.node, true);
    }
}
