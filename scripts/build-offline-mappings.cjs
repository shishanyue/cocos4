const path = require('node:path');
const fs = require('node:fs/promises');
const { StatsQuery, Bundler } = require('@cocos/ccbuild');

async function buildOfflineMappings(outFile) {
    const engine = path.resolve(__dirname, '..');
    const query = await StatsQuery.create(engine);
    const constants = query.constantManager.exportStaticConstants({ platform: 'NODEJS', mode: 'BUILD', flags: {} });
    const { core, plugins } = Bundler.rollup;
    const bundle = await core.rollup({
        input: query.getEditorPublicModuleFile('cc/editor/offline-mappings'),
        plugins: [
            plugins.virtual({ 'internal:constants': constants }),
            plugins.nodeResolve({ extensions: ['.js', '.ts', '.json'] }),
            plugins.typescript({
                tsconfig: query.tsConfigPath,
                compilerOptions: {
                    module: 'ESNext', moduleResolution: 'Node', noEmit: false,
                    noEmitOnError: true, sourceMap: false, outDir: undefined,
                },
            }),
        ],
        onwarn(warning) { throw new Error(warning.message); },
    });
    try {
        const { output } = await bundle.generate({ format: 'cjs', exports: 'named' });
        const chunk = output[0];
        if (output.length !== 1 || chunk.type !== 'chunk' || chunk.imports.length || chunk.dynamicImports.length) {
            throw new Error('Offline mappings must be a single self-contained CommonJS module.');
        }
        const modules = Object.keys(chunk.modules).map(id => path.relative(engine, id).replaceAll('\\', '/')).sort();
        if (modules.some(id => /(^|\/)pal\//.test(id)
            || /cocos\/(?:core\/index|gfx\/index|rendering\/define)\.ts$/.test(id))) {
            throw new Error('Offline mappings pulled in engine initialization.');
        }
        await fs.mkdir(path.dirname(outFile), { recursive: true });
        await fs.writeFile(outFile, chunk.code);
        return { modules };
    } finally {
        await bundle.close();
    }
}

module.exports = { buildOfflineMappings };
if (require.main === module) {
    const outFile = path.resolve(process.argv[2] || path.join(__dirname, '../bin/devkit/offline-mappings.cjs'));
    if (process.argv.length > 3 || path.extname(outFile) !== '.cjs') {
        console.error('Usage: node scripts/build-offline-mappings.cjs [output.cjs]');
        process.exitCode = 1;
    } else {
        buildOfflineMappings(outFile).then(() => console.log(`[offline-mappings] ${outFile}`))
            .catch(error => { console.error(error); process.exitCode = 1; });
    }
}
