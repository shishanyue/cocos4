import { Sprite } from '../../cocos/2d/components';
import '../../cocos/2d/assembler/graphics';
import { Graphics } from '../../cocos/2d/components/graphics';
import { MeshRenderData, RenderData } from '../../cocos/2d/renderer/render-data';
import { Node } from '../../cocos/scene-graph/node';

describe('Graphics render-data lifecycle', () => {
    test('clear erases geometry and redraws in the same mesh buffers, released once on destruction', () => {
        const node = new Node('Redrawn Graphics');
        const graphics = node.addComponent(Graphics);
        const remove = jest.spyOn(MeshRenderData, 'remove');
        try {
            graphics.rect(0, 0, 10, 10);
            graphics.fill();
            const first = graphics.impl!.getRenderDataList()[0];
            const vertices = first.vData;
            const indices = first.iData;
            expect(first.vertexStart).toBeGreaterThan(0);
            graphics.clear();
            expect(first.vertexStart).toBe(0);
            expect(first.indexStart).toBe(0);
            expect(remove).not.toHaveBeenCalled();
            graphics.rect(20, 30, 5, 6);
            graphics.fill();
            const next = graphics.impl!.getRenderDataList()[0];
            expect(next).toBe(first);
            expect(next.vData).toBe(vertices);
            expect(next.iData).toBe(indices);
            expect(next.vertexStart).toBeGreaterThan(0);
            expect(next.vData[0]).toBe(20);
            expect(next.vData[1]).toBe(30);
            graphics.onDestroy();
            node._destroyImmediate();
            expect(remove.mock.calls.filter(([data]) => data === first)).toHaveLength(1);
        } finally {
            if (graphics.impl) graphics.onDestroy();
            if (node.isValid) node._destroyImmediate();
            remove.mockRestore();
        }
    });

    test('clear resets spare batches and destruction releases every retained batch', () => {
        const node = new Node('Multiple Graphics batches');
        const graphics = node.addComponent(Graphics);
        const impl = graphics.impl!;
        const first = impl.requestRenderData();
        const spare = impl.requestRenderData();
        first.vertexStart = 4;
        spare.vertexStart = 8;
        const remove = jest.spyOn(MeshRenderData, 'remove');
        try {
            graphics.clear();
            expect(impl.getRenderDataList()).toEqual([first, spare]);
            expect(first.vertexStart).toBe(0);
            expect(spare.vertexStart).toBe(0);
            graphics.onDestroy();
            node._destroyImmediate();
            expect(remove.mock.calls.filter(([data]) => data === first)).toHaveLength(1);
            expect(remove.mock.calls.filter(([data]) => data === spare)).toHaveLength(1);
        } finally {
            if (graphics.impl) graphics.onDestroy();
            if (node.isValid) node._destroyImmediate();
            remove.mockRestore();
        }
    });

    test('retains generated geometry while disabled', () => {
        const node = new Node('Graphics');
        const graphics = node.addComponent(Graphics);
        const renderData = MeshRenderData.add();
        renderData.vertexStart = 4;
        // Graphics binds MeshRenderData to UIRenderer only on JSB. Reproduce that
        // ownership boundary explicitly in the platform-independent unit test.
        graphics.setRenderData(renderData as unknown as RenderData);

        graphics.onDisable();

        expect(graphics.renderData).toBe(renderData);
        expect(renderData.vertexStart).toBe(4);

        graphics.setRenderData(null);
        MeshRenderData.remove(renderData);
        node._destroyImmediate();
    });

    test('ordinary UI renderers still release render data while disabled', () => {
        const node = new Node('Sprite');
        const sprite = node.addComponent(Sprite);
        const destroyRenderData = jest.spyOn(sprite, 'destroyRenderData');

        sprite.onDisable();

        expect(destroyRenderData).toHaveBeenCalledTimes(1);
        destroyRenderData.mockRestore();
        node._destroyImmediate();
    });
});
