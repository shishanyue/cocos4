import { Sampler, SamplerInfo, Filter, Address, ComparisonFunc } from "../../../cocos/gfx"
import * as rendering from '../../../cocos/rendering/define';
import * as enums from '../../../cocos/rendering/rendering-enums';
import { legacyCC } from '../../../cocos/core/global-exports';

test('rendering enum extraction preserves runtime export identity', () => {
    expect(rendering.RenderPassStage).toBe(enums.RenderPassStage);
    expect(rendering.RenderPriority).toBe(enums.RenderPriority);
    expect(rendering.SetIndex).toBe(enums.SetIndex);
    expect(legacyCC.RenderPassStage).toBe(enums.RenderPassStage);
});

function testSamplerInfo(info: SamplerInfo): boolean {
    const packed = Sampler.computeHash(info);
    const unpacked = Sampler.unpackFromHash(packed);
    return unpacked.minFilter === info.minFilter &&
        unpacked.magFilter === info.magFilter &&
        unpacked.mipFilter === info.mipFilter &&
        unpacked.addressU === info.addressU &&
        unpacked.addressV === info.addressV &&
        unpacked.addressW === info.addressW &&
        unpacked.maxAnisotropy === info.maxAnisotropy &&
        unpacked.cmpFunc === info.cmpFunc;
}

test('packSamplerInfo', () => {
    expect(testSamplerInfo(new SamplerInfo(
        Filter.NONE,
        Filter.NONE,
        Filter.NONE,
        Address.WRAP,
        Address.WRAP,
        Address.WRAP,
        0,
        ComparisonFunc.NEVER))).toBe(true);

    expect(testSamplerInfo(new SamplerInfo(
        Filter.ANISOTROPIC,
        Filter.ANISOTROPIC,
        Filter.ANISOTROPIC,
        Address.BORDER,
        Address.BORDER,
        Address.BORDER,
        16,
        ComparisonFunc.ALWAYS))).toBe(true);

    expect(testSamplerInfo(new SamplerInfo(
        Filter.ANISOTROPIC,
        Filter.LINEAR,
        Filter.POINT,
        Address.BORDER,
        Address.CLAMP,
        Address.MIRROR,
        15,
        ComparisonFunc.GREATER_EQUAL))).toBe(true);
})
