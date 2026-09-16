import type { IMiniGame, SystemInfo } from 'pal/minigame';

// Only the host contracts consumed by this adapter, not a claim of full API coverage.
export interface BilibiliSystemInfo extends Partial<SystemInfo> {
    screenWidth: number;
    screenHeight: number;
    platform: string;
    devicePixelRatio?: number;
}

export interface BilibiliHost extends Pick<IMiniGame,
    'onShow' | 'offShow' | 'onHide' | 'offHide' | 'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel'
    | 'createInnerAudioContext' | 'onAudioInterruptionBegin' | 'offAudioInterruptionBegin'
    | 'onAudioInterruptionEnd' | 'offAudioInterruptionEnd' | 'loadFont' | 'getFileSystemManager'> {
    getSystemInfoSync(): BilibiliSystemInfo;
    getDeviceOrientationSync?(): string;
    onWindowResize?: IMiniGame['onWindowResize'];
    getBatteryInfoSync?: IMiniGame['getBatteryInfoSync'];
    setPreferredFramesPerSecond?: IMiniGame['setPreferredFramesPerSecond'];
    onAccelerometerChange?: IMiniGame['onAccelerometerChange'];
    offAccelerometerChange?: IMiniGame['offAccelerometerChange'];
    startAccelerometer?: IMiniGame['startAccelerometer'];
    stopAccelerometer?: IMiniGame['stopAccelerometer'];
    exitMiniProgram?: IMiniGame['exitMiniProgram'];
    triggerGC?: IMiniGame['triggerGC'];
    loadSubpackage?: IMiniGame['loadSubpackage'];
}

declare const bl: BilibiliHost;

if (typeof bl !== 'object' || typeof bl.getSystemInfoSync !== 'function') {
    throw new Error('BILIBILI requires the bl mini-game host; load web-adapter before the engine.');
}

export const host = bl;
