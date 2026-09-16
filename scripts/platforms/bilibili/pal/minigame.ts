import { Orientation } from '../screen-adapter/enum-type/orientation';
import { host } from './host';

function getSystemInfoSync (): ReturnType<typeof host.getSystemInfoSync> & {
    pixelRatio: number; windowWidth: number; windowHeight: number; language: string; system: string;
} {
    const info = host.getSystemInfoSync();
    return {
        ...info,
        pixelRatio: info.pixelRatio || info.devicePixelRatio || 1,
        windowWidth: info.windowWidth ?? info.screenWidth,
        windowHeight: info.windowHeight ?? info.screenHeight,
        language: info.language || 'en',
        system: info.system || info.platform,
    };
}

const accelerometerCallbacks = new Map<AccelerometerChangeCallback, AccelerometerChangeCallback>();

export const minigame = {
    getSystemInfoSync,
    get isDevTool (): boolean { return getSystemInfoSync().platform.toLowerCase() === 'devtools'; },
    get isLandscape (): boolean {
        const info = getSystemInfoSync();
        return info.windowWidth > info.windowHeight;
    },
    get orientation (): Orientation {
        if (!this.isLandscape) return Orientation.PORTRAIT;
        return host.getDeviceOrientationSync?.() === 'landscapeReverse' ? Orientation.LANDSCAPE_LEFT : Orientation.LANDSCAPE_RIGHT;
    },
    getSafeArea (): SafeArea {
        const info = getSystemInfoSync();
        return info.safeArea ?? { top: 0, left: 0, right: info.windowWidth, bottom: info.windowHeight, width: info.windowWidth, height: info.windowHeight };
    },
    onShow: host.onShow.bind(host),
    offShow: host.offShow.bind(host),
    onHide: host.onHide.bind(host),
    offHide: host.offHide.bind(host),
    onWindowResize: host.onWindowResize?.bind(host),
    onTouchStart: host.onTouchStart.bind(host),
    onTouchMove: host.onTouchMove.bind(host),
    onTouchEnd: host.onTouchEnd.bind(host),
    onTouchCancel: host.onTouchCancel.bind(host),
    createInnerAudioContext: host.createInnerAudioContext.bind(host),
    onAudioInterruptionBegin: host.onAudioInterruptionBegin.bind(host),
    offAudioInterruptionBegin: host.offAudioInterruptionBegin.bind(host),
    onAudioInterruptionEnd: host.onAudioInterruptionEnd.bind(host),
    offAudioInterruptionEnd: host.offAudioInterruptionEnd.bind(host),
    loadFont: host.loadFont.bind(host),
    getFileSystemManager: host.getFileSystemManager.bind(host),
    loadSubpackage: host.loadSubpackage?.bind(host),
    exitMiniProgram: host.exitMiniProgram?.bind(host),
    triggerGC: host.triggerGC?.bind(host),
    getBatteryInfoSync (): BatteryInfo {
        return host.getBatteryInfoSync?.() ?? { level: 100, isCharging: false };
    },
    setPreferredFramesPerSecond (fps: number): void { host.setPreferredFramesPerSecond?.(fps); },
    onAccelerometerChange (callback: AccelerometerChangeCallback): void {
        this.offAccelerometerChange(callback);
        const wrapped: AccelerometerChangeCallback = (data) => {
            if (!this.isLandscape) { callback(data); return; }
            const sign = this.orientation === Orientation.LANDSCAPE_LEFT ? -1 : 1;
            callback({ x: -data.y * sign, y: data.x * sign, z: data.z });
        };
        accelerometerCallbacks.set(callback, wrapped);
        host.onAccelerometerChange?.(wrapped);
    },
    offAccelerometerChange (callback?: AccelerometerChangeCallback): void {
        for (const [original, wrapped] of accelerometerCallbacks) {
            if (!callback || callback === original) {
                host.offAccelerometerChange?.(wrapped);
                accelerometerCallbacks.delete(original);
            }
        }
    },
    startAccelerometer: host.startAccelerometer?.bind(host),
    stopAccelerometer: host.stopAccelerometer?.bind(host),
};
