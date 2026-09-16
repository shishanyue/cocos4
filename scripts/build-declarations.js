const { join } = require('path');
const { emptyDir, copyFile, readFile, writeFile } = require('fs-extra');
const { execFileSync } = require('node:child_process');
const { dtsBundler } = require('@cocos/ccbuild');
const { magenta } = require('chalk');

const prefix = ''.padStart(20, '=');
console.log(magenta(`${prefix} Build declarations ${prefix}`));

(async function exec () {
    const PATHS = {
        engine: join(__dirname, '..'),
        out: join(__dirname, '..', 'bin', '.declarations'),
    };
    await emptyDir(PATHS.out);

    const success = await dtsBundler.build({
        engine: PATHS.engine,
        outDir: PATHS.out,
        withIndex: true,
        withExports: false,
        withEditorExports: true,
    });
    if (!success) throw new Error('Declaration bundling failed');
    // Public WebGPU APIs require the real ambient browser declarations alongside the bundle.
    await copyFile(join(PATHS.engine, '@types', 'webGPU.d.ts'), join(PATHS.out, 'webGPU.d.ts'));
    const ccDts = join(PATHS.out, 'cc.d.ts');
    await writeFile(ccDts, `/// <reference path="./webGPU.d.ts" />\n${await readFile(ccDts, 'utf8')}`);
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project',
        join(__dirname, 'test-declarations', 'tsconfig.json')], { stdio: 'inherit' });
}()).catch((error) => { console.error(error); process.exitCode = 1; });
