const fs = require('node:fs');
const path = require('node:path');

try {
    if (process.argv.length > 3) throw new Error('Usage: check-examples.cjs [engine-root]');
    const engineRoot = path.resolve(process.argv[2] || path.join(__dirname, '../../../..'));
    const declarationRoot = path.join(engineRoot, 'bin/.declarations');
    const declarations = ['cc.d.ts', 'cc.editor.d.ts', 'webGPU.d.ts']
        .map((name) => path.join(declarationRoot, name));
    if (!declarations.every((file) => fs.existsSync(file))) {
        throw new Error(`Missing generated declarations in ${declarationRoot}; run npm run build:declaration in the engine root.`);
    }
    const ts = require(require.resolve('typescript', { paths: [engineRoot] }));
    const configPath = path.join(engineRoot, 'scripts/test-declarations/tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const host = {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => engineRoot,
        getNewLine: () => '\n',
    };
    if (config.error) throw new Error(ts.formatDiagnosticsWithColorAndContext([config.error], host));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    if (parsed.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, host));
    const exampleRoot = path.join(__dirname, '../examples');
    const examples = fs.readdirSync(exampleRoot).filter((name) => name.endsWith('.ts')).sort()
        .map((name) => path.join(exampleRoot, name));
    if (examples.length === 0) throw new Error('No TypeScript examples found.');
    const program = ts.createProgram([...declarations, ...examples], {
        ...parsed.options,
        experimentalDecorators: true,
        noEmit: true,
        skipLibCheck: false,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
    console.log(`Type-checked ${examples.length} skill examples against ${declarationRoot}; no scene or device execution performed.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
