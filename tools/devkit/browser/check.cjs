const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const engine = path.resolve(__dirname, '../../..');
const rootRequire = createRequire(path.join(engine, 'package.json'));

function checkGame(outDir) {
    const ts = rootRequire('typescript');
    assert.equal(ts.version, '4.9.5');
    const configPath = path.join(__dirname, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, __dirname, {
        noEmit: !outDir, ...(outDir ? { outDir, rootDir: __dirname } : {}),
    });
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const strictProgram = ts.createProgram(parsed.fileNames, { ...parsed.options, noImplicitAny: true, noEmit: true });
    const gameSource = strictProgram.getSourceFile(path.join(__dirname, 'game.ts'));
    assert.ok(gameSource);
    const strictGameDiagnostics = strictProgram.getSemanticDiagnostics(gameSource);
    const diagnostics = [...(config.error ? [config.error] : []), ...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...strictGameDiagnostics];
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: () => __dirname, getCanonicalFileName: file => file, getNewLine: () => '\n',
    }));
    if (outDir) assert.equal(program.emit().emitSkipped, false);
    const strictDeclarationDiagnostics = ts.getPreEmitDiagnostics(strictProgram).map(diagnostic => ({
        code: diagnostic.code, file: diagnostic.file?.fileName,
        line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
    console.log(`Root-baseline public declarations and fully strict game passed; skipLibCheck=false. Full-strict declarations: ${strictDeclarationDiagnostics.length} diagnostics.`);
    return { publicDeclarations: 'repository baseline: strict=true, noImplicitAny=false', gameStrict: true,
        skipLibCheck: false, skipDefaultLibCheck: false, fullStrictDeclarations: strictDeclarationDiagnostics.length === 0, strictDeclarationDiagnostics };
}

function checkRoot() {
    execFileSync(process.execPath, [rootRequire.resolve('typescript/bin/tsc'), '--noEmit', '--pretty', 'false',
        '--project', path.join(engine, 'tsconfig.json')], { cwd: engine, stdio: 'inherit', timeout: 180000 });
}

module.exports = { checkGame, checkRoot, engine, rootRequire };
if (require.main === module) {
    try {
        assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--repository-baseline'));
        checkRoot();
        const result = checkGame();
        if (process.argv.length === 2) assert.ok(result.fullStrictDeclarations,
            `Full-strict declaration gate is blocked:\n${JSON.stringify(result.strictDeclarationDiagnostics, null, 2)}`);
    }
    catch (error) { console.error(error); process.exitCode = 1; }
}
