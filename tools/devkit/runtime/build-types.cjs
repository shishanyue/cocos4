const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

async function buildTypes({ engine, outDirectory, workDirectory }) {
    const rootRequire = createRequire(path.join(engine, 'package.json'));
    // ccbuild hard-codes a mutable __dts_before_bundle directory under its engine input.
    // Give it a private source snapshot rather than sharing that directory with other maintainers.
    const source = await fs.mkdtemp(path.join(workDirectory, 'declaration-source-'));
    try {
        for (const name of ['cocos', 'exports', 'editor/exports', 'editor/src', 'extensions', '@types', 'pal', 'vendor']) {
            await fs.cp(path.join(engine, name), path.join(source, name), { recursive: true });
        }
        for (const name of ['package.json', 'cc.config.json', 'DebugInfos.json', 'DebugInfos.d.ts']) {
            await fs.copyFile(path.join(engine, name), path.join(source, name));
        }
        for (const name of ['node_modules', 'external']) {
            await fs.symlink(path.join(engine, name), path.join(source, name), process.platform === 'win32' ? 'junction' : 'dir');
        }
        const ts = rootRequire('typescript');
        const config = ts.readConfigFile(path.join(engine, 'tsconfig.json'), ts.sys.readFile);
        assert.ok(!config.error);
        config.config.compilerOptions.preserveSymlinks = true;
        await fs.writeFile(path.join(source, 'tsconfig.json'), JSON.stringify(config.config, null, 2));
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, source, {
            noEmit: false, declaration: true, emitDeclarationOnly: true,
        });
        const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))];
        assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
            getCurrentDirectory: () => source, getCanonicalFileName: file => file, getNewLine: () => '\n',
        }));
        assert.equal(await rootRequire('@cocos/ccbuild').dtsBundler.build({ engine: source, outDir: outDirectory }), true);
        await fs.copyFile(path.join(engine, '@types/webGPU.d.ts'), path.join(outDirectory, 'webGPU.d.ts'));
        const ccDts = path.join(outDirectory, 'cc.d.ts');
        const companions = (await fs.readdir(outDirectory)).filter(name => name.endsWith('.d.ts') && name !== 'cc.d.ts').sort();
        await fs.writeFile(ccDts, companions.map(name => `/// <reference path="./${name}" />\n`).join('') + await fs.readFile(ccDts, 'utf8'));
    } finally {
        await fs.rm(source, { recursive: true, force: true });
    }
}

module.exports = { buildTypes };
