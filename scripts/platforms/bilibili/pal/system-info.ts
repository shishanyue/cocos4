import { systemInfo } from '../system-info/minigame/system-info';
import { Feature } from '../system-info/enum-type';
import { host } from './host';

const hasFeature = systemInfo.hasFeature.bind(systemInfo);
systemInfo.hasFeature = (feature: Feature): boolean => {
    if (feature === Feature.WASM) {
        return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
    }
    if (feature === Feature.SAFE_AREA) return true;
    if (feature === Feature.EVENT_ACCELEROMETER) {
        return !!(host.onAccelerometerChange && host.offAccelerometerChange && host.startAccelerometer && host.stopAccelerometer);
    }
    return hasFeature(feature);
};

export { systemInfo };
