declare const __bilibiliRequire: (path: string) => unknown;
declare const canvas: HTMLCanvasElement;

export function findCanvas (): { frame: HTMLDivElement; container: HTMLDivElement; canvas: HTMLCanvasElement } {
    const container = document.createElement('div');
    return { frame: container, container, canvas };
}

export async function loadJsFile (path: string): Promise<void> {
    if (/^[a-z]+:/i.test(path) || path.split('/').includes('..')) throw new Error(`Invalid packaged script path: ${path}`);
    __bilibiliRequire(`./${path.replace(/^\.\//, '')}`);
}
