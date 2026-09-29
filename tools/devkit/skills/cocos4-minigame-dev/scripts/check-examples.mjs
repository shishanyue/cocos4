import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const flags = new Map();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--sdk-root', '--target', '--profile', '--variant'].includes(args[i]) && args[i + 1] && !flags.has(args[i]), 'Invalid checker option.');
    flags.set(args[i], args[i + 1]);
}
assert.ok(['--sdk-root', '--target', '--profile'].every(name => flags.has(name)), 'Explicit --sdk-root, --target and --profile are required.');
const variant = flags.get('--variant') ?? 'debug';
assert.ok(['debug', 'release'].includes(variant), '--variant must be debug or release.');
assert.ok(path.isAbsolute(flags.get('--sdk-root')));
const kit = fileURLToPath(new URL('../../../', import.meta.url));
// The first layout is the release/isolated-test layout. The second is the
// maintainer's compiled devkit layout, never an engine-source dependency.
const candidates = ['app/src/sdk.js', 'build/src/sdk.js'].map(name => path.join(kit, name));
let sdkModule;
for (const filename of candidates) {
    try { if ((await fs.lstat(filename)).isFile()) { sdkModule = filename; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}
assert.ok(sdkModule, 'The kit application is missing; no dependencies will be installed.');
const { loadSdk } = await import(pathToFileURL(sdkModule).href);
const sdk = await loadSdk(flags.get('--sdk-root'));
const profile = sdk.profile(flags.get('--target'), flags.get('--profile'), variant);
assert.ok(sdk.toolchainRoot, 'A verified development SDK is required.');
const require = createRequire(path.join(sdk.toolchainRoot, 'package.json'));
const ts = require('typescript');
assert.equal(ts.version, '4.9.5');
const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const files = (await fs.readdir(examples)).filter(name => name.endsWith('.ts')).map(name => path.join(examples, name));
assert.ok(files.length);
const rootNames = [...files, ...profile.descriptor.typeFiles.map(name => path.join(profile.directory, name))];
const program = ts.createProgram({ rootNames, options: {
    target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs,
    lib: ['lib.es2017.d.ts', 'lib.dom.d.ts'],
    // Match the shipped game compiler's existing declaration-consumer contract.
    strict: true, noImplicitAny: false, skipLibCheck: false, skipDefaultLibCheck: false, noEmit: true, types: [],
    experimentalDecorators: true, useDefineForClassFields: false, forceConsistentCasingInFileNames: true,
} });
const diagnostics = ts.getPreEmitDiagnostics(program);
for (const filename of files) {
    const source = program.getSourceFile(filename);
    assert.ok(source);
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        assert.equal(statement.moduleSpecifier.text, 'cc', 'Examples may only import the public cc module.');
        const clause = statement.importClause;
        assert.ok(clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings));
        for (const entry of clause.namedBindings.elements) {
            if (clause.isTypeOnly || entry.isTypeOnly) continue;
            const name = (entry.propertyName ?? entry.name).text;
            assert.ok(profile.ccExports.includes(name), `FEATURE_NOT_IN_PROFILE: ${name}`);
        }
    }
}
const report = { sdkId: sdk.sdkId, typescript: ts.version, target: profile.descriptor.target,
    profile: profile.descriptor.profile, variant: profile.descriptor.variant, examples: files.map(name => path.basename(name)),
    noEmit: true, strict: true, noImplicitAny: false, skipLibCheck: false, runtimeExecuted: false,
    diagnostics: diagnostics.map(item => ({ code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
        file: item.file ? path.basename(item.file.fileName) : null,
        line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null })) };
console.log(JSON.stringify(report, null, 2));
process.exitCode = diagnostics.length ? 1 : 0;
