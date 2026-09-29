import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TypeScript from 'typescript';
import { z } from 'zod';
import { AppError, reportSchema, type ExecuteLogic, type Report } from './contracts.js';
import { canonical, hash, parseJson } from './sdk.js';
import { readGameOutput } from './workspace.js';

export const logicPlanSchema = z.object({
    version: z.literal(1), files: z.array(z.string().min(1).max(1024)).min(1).max(256),
}).strict();

const conventionalTest = /(?:^|\/)(?:[^/]+\.(?:test|spec)|test(?:-[^/]+)?)\.(?:ts|[cm]?js)$/;
const sourceFile = /\.(?:ts|[cm]?js)$/;
const nodeModules = new Set([...builtinModules.filter(name => !name.startsWith('_')),
    ...builtinModules.map(name => `node:${name}`), 'node:test', 'node:assert/strict']);
const typesInventorySchema = z.object({
    version: z.literal(1), node: z.literal('18.19.130'), undici: z.literal('5.26.5'),
    files: z.array(z.object({ path: z.string().min(1).max(256), bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(512),
}).strict();

// These are real, unmodified DefinitelyTyped declarations delivered with the
// host tool, not project/global @types discovery or a substitute cc declaration.
async function hostTypes(): Promise<Map<string, Buffer>> {
    const root = fileURLToPath(new URL('../host/logic-types', import.meta.url));
    try {
        const files = await readGameOutput(root);
        const inventory = typesInventorySchema.parse(parseJson(files.get('inventory.json')!.toString('utf8')));
        if (files.size !== inventory.files.length + 1) throw new Error('Unlisted host type files.');
        for (const item of inventory.files) {
            const bytes = files.get(item.path);
            if (!/^(?:node|undici-types)\/[\w./-]+$/.test(item.path) || item.path.split('/').includes('..')
                || !bytes || bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('Host type integrity.');
        }
        if (JSON.parse(files.get('node/package.json')!.toString()).version !== inventory.node
            || JSON.parse(files.get('undici-types/package.json')!.toString()).version !== inventory.undici
            || !files.has('node/ts5.6/index.d.ts')) throw new Error('Host type version.');
        return files;
    } catch (error) {
        const detail = error instanceof AppError ? ` ${error.message}` : error instanceof z.ZodError ? ' Invalid host type inventory schema.' : '';
        throw new AppError('SDK_INCOMPLETE', `Missing or invalid packaged Node 18.19.130 / undici 5.26.5 declarations for TypeScript 4.9.5.${detail}`,
            ['Use a host tool distribution containing host/logic-types. Runtime never installs dependencies.']);
    }
}

export async function checkLogic(context: { project: string; toolchain: string; types: string; staging: string;
    projectFiles: ReadonlyMap<string, Buffer> }, execute: ExecuteLogic, log: (text: string) => void): Promise<Report> {
    const { projectFiles } = context;
    const tests = [...projectFiles.keys()].filter(name => name.startsWith('tests/') && conventionalTest.test(name)).sort();
    const report: Report = { summary: 'Pure logic check; no engine, headless game, browser or game build is executed.',
        inputSnapshotSha256: hash(canonical([...projectFiles].sort(([a], [b]) => a.localeCompare(b, 'en'))
            .map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: hash(bytes) })))),
        items: [], validationLevels: ['bounded-private-snapshot'] };
    const reject = (message: string, file?: string, node?: TypeScript.Node): never => {
        const position = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
        throw new AppError('UNSUPPORTED_PROJECT', message, ['Use conventional pure TS/JS tests under tests/ with static project or Node builtin imports.'], false,
            { ...report, items: [{ name: file ?? 'Logic test contract', status: 'failed', code: 'UNSUPPORTED_PROJECT', message,
                ...(file ? { file } : {}), ...(position ? { line: position.line + 1, column: position.character + 1 } : {}) }] });
    };
    if (!tests.length || tests.length > 256) reject('Expected 1..256 tests/**/*.test.*, *.spec.* or test-* files (ts/js/mjs/cjs). Helpers are imported, not auto-executed.');
    const require = createRequire(import.meta.url);
    const compiler = path.join(context.toolchain, 'node_modules/typescript/lib/typescript.js');
    const ts = require(compiler) as typeof TypeScript;
    if (ts.version !== '4.9.5') throw new AppError('SDK_INCOMPLETE', 'Logic requires the manifest-verified SDK TypeScript 4.9.5 compiler.');

    // Configuration is data only. Fixed logic options cannot delegate discovery to
    // extends, plugins, ambient packages, compiler paths, or a project's emitter.
    // Match the delivered game compiler's default for the unchanged cc declarations.
    let noImplicitAny = false;
    if (projectFiles.has('tsconfig.json')) {
        const parsed = ts.parseConfigFileTextToJson('tsconfig.json', projectFiles.get('tsconfig.json')!.toString('utf8'));
        const config = parsed.config as Record<string, unknown> | undefined;
        if (parsed.error || !config || typeof config !== 'object' || Array.isArray(config)
            || Object.keys(config).some(key => !['compilerOptions', 'include', '$schema'].includes(key))) return reject('Unsupported tsconfig field or invalid JSON.', 'tsconfig.json');
        if (config.include !== undefined && (!Array.isArray(config.include) || config.include.some(value => typeof value !== 'string'
            || !/^(?:src|tests)(?:\/\*\*(?:\/\*|\/\*\.(?:ts|js))?)?$/.test(value)))) reject('Only src/ and tests/ include patterns are supported.', 'tsconfig.json');
        const configured = config.compilerOptions ?? {};
        const allowed = new Set(['target', 'module', 'moduleResolution', 'lib', 'strict', 'noImplicitAny', 'noEmit',
            'experimentalDecorators', 'useDefineForClassFields', 'types', 'baseUrl', 'paths', 'allowJs', 'checkJs',
            'skipLibCheck', 'skipDefaultLibCheck', 'forceConsistentCasingInFileNames', 'noUnusedLocals', 'noUnusedParameters',
            'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']);
        if (!configured || typeof configured !== 'object' || Array.isArray(configured)
            || Object.keys(configured).some(key => !allowed.has(key))) reject('Unsupported compilerOptions field.', 'tsconfig.json');
        const options = configured as Record<string, unknown>;
        for (const [key, expected] of Object.entries({ strict: true, noEmit: true, allowJs: true, checkJs: true,
            skipLibCheck: false, skipDefaultLibCheck: false })) {
            if (key in options && options[key] !== expected) reject(`Unsupported compilerOptions.${key}.`, 'tsconfig.json');
        }
        if (options.types !== undefined && (!Array.isArray(options.types) || options.types.length)) reject('Automatic ambient type discovery is not supported.', 'tsconfig.json');
        if (options.baseUrl !== undefined && options.baseUrl !== '.') reject('Only baseUrl "." is supported.', 'tsconfig.json');
        if (options.paths !== undefined && !z.object({ cc: z.tuple([z.enum(['types/cc.d.ts', './types/cc.d.ts', '../types/cc.d.ts'])]) }).strict().safeParse(options.paths).success) {
            reject('Only the SDK-owned cc declaration mapping is supported.', 'tsconfig.json');
        }
        if (options.lib !== undefined && (!Array.isArray(options.lib) || options.lib.some(value => typeof value !== 'string' || !/^(?:es\d{4}(?:\.[a-z0-9.]+)?|dom(?:\.iterable)?)$/i.test(value)))) {
            reject('Unsupported compilerOptions.lib.', 'tsconfig.json');
        }
        const converted = ts.convertCompilerOptionsFromJson(options, '/project');
        if (converted.errors.length) reject('Invalid compiler options.', 'tsconfig.json');
        noImplicitAny = converted.options.noImplicitAny ?? noImplicitAny;
    }

    const sources = new Map<string, string>();
    const project = new Map<string, TypeScript.SourceFile>();
    const runtime = new Set<string>(tests);
    const queue = [...tests];
    const outputName = (name: string): string => name.replace(/\.(?:ts|[cm]?js)$/, '.cjs');
    const resolveProject = (specifier: string, importer: string): string | undefined => {
        if (specifier === 'cc' || nodeModules.has(specifier)) return undefined;
        if (!/^(?:\.\/|\.\.\/)/.test(specifier) || /[\\:\0?#]/.test(specifier)) reject('Dependencies must be static project-relative files or Node builtins; no ancestor packages are resolved.', importer);
        const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
        if (!/^(?:src|tests|assets)\//.test(candidate)) reject('Import is outside the project logic closure.', importer);
        const candidates = /\.(?:[cm]?js|json)$/.test(candidate)
            ? [candidate, ...(candidate.endsWith('.js') ? [candidate.slice(0, -3) + '.ts'] : [])]
            : [candidate + '.ts', candidate + '.js', candidate + '.cjs', candidate + '.mjs', candidate + '/index.ts', candidate + '/index.js'];
        const resolved = candidates.find(name => projectFiles.has(name));
        if (!resolved || (!sourceFile.test(resolved) && !resolved.endsWith('.json')) || resolved.endsWith('.d.ts')
            || (resolved.startsWith('assets/') && !resolved.endsWith('.json'))) reject('Missing ordinary TS/JS/JSON module in the snapshotted project.', importer);
        return resolved;
    };
    let nodes = 0;
    const deadline = performance.now() + 60000;
    for (let index = 0; index < queue.length; index++) {
        const file = queue[index];
        if (project.has(file)) continue;
        if (queue.length > 10000 || performance.now() > deadline) reject('Logic source discovery exceeded its fixed budget.');
        const bytes = projectFiles.get(file)!;
        if (bytes.length > 8 * 1024 * 1024) reject('A logic source exceeds 8 MiB.', file);
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const ast = ts.createSourceFile(`/project/${file}`, source, ts.ScriptTarget.ES2020, true,
            file.endsWith('.json') ? ts.ScriptKind.JSON : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
        project.set(file, ast);
        sources.set(ast.fileName, source);
        if (file.endsWith('.json')) continue;
        const directives = ast as TypeScript.SourceFile & { commentDirectives?: unknown[]; checkJsDirective?: { enabled: boolean } };
        if (ast.referencedFiles.length || ast.typeReferenceDirectives.length || ast.libReferenceDirectives.length || ast.hasNoDefaultLib
            || directives.checkJsDirective?.enabled === false || directives.commentDirectives?.length) reject('Project triple-slash references and TypeScript suppression directives are not supported.', file);
        const dependency = (specifier: string, typeOnly: boolean, node: TypeScript.Node): void => {
            if (specifier === 'cc' && !typeOnly) reject('Logic cannot load the cc engine. Use import type and pure rules/world modules; rendering needs a browser.', file, node);
            const target = resolveProject(specifier, file);
            if (target) {
                if (!queue.includes(target)) queue.push(target);
                if (!typeOnly && runtime.has(file)) runtime.add(target);
            }
        };
        const visit = (node: TypeScript.Node): void => {
            if (++nodes > 2000000 || performance.now() > deadline) reject('Logic source analysis exceeded its fixed budget.');
            if (ts.isModuleDeclaration(node) || ts.isImportEqualsDeclaration(node)) reject('Project namespaces, ambient modules and import-equals are not supported.', file, node);
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
                if (!ts.isStringLiteral(node.moduleSpecifier)) return reject('Expected a literal module specifier.', file, node);
                const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
                const bindings = clause?.namedBindings;
                const onlyTypes = ts.isImportDeclaration(node)
                    ? !!clause && (clause.isTypeOnly || (!clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly)))
                    : node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
                dependency(node.moduleSpecifier.text, onlyTypes, node);
            }
            if (ts.isImportTypeNode(node)) {
                if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) return reject('Expected a literal import type.', file, node);
                dependency(node.argument.literal.text, true, node);
            }
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) return reject('Computed imports/require are not supported by the logic module contract.', file, node);
                dependency(node.arguments[0].text, false, node);
            }
            if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) reject('Logic uses a fixed CommonJS runner; import.meta is not supported.', file, node);
            ts.forEachChild(node, visit);
            // JSDoc import types do not belong to forEachChild's ordinary tree.
            for (const doc of (node as TypeScript.Node & { jsDoc?: TypeScript.JSDoc[] }).jsDoc ?? []) ts.forEachChild(doc, visit);
        };
        visit(ast);
    }
    if (new Set([...project.keys()].map(outputName)).size !== project.size) reject('Colliding TS/JS logic output paths.');

    for (const [name, bytes] of await readGameOutput(context.types)) if (name.endsWith('.d.ts')) sources.set(`/sdk/types/${name}`, bytes.toString('utf8'));
    if (!sources.has('/sdk/types/cc.d.ts')) throw new AppError('SDK_INCOMPLETE', 'The chosen SDK has no cc declarations.');
    const libRoot = path.join(context.toolchain, 'node_modules/typescript/lib');
    for (const name of await fs.readdir(libRoot)) if (/^lib(?:\.[\w.]+)?\.d\.ts$/.test(name)) {
        sources.set(`/sdk/typescript/${name}`, await fs.readFile(path.join(libRoot, name), 'utf8'));
    }
    for (const [name, bytes] of await hostTypes()) if (name.endsWith('.d.ts')) sources.set(`/sdk/host-types/${name}`, bytes.toString('utf8'));
    const nodeIndex = '/sdk/host-types/node/ts5.6/index.d.ts';
    const options: TypeScript.CompilerOptions = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs, strict: true, noImplicitAny, allowJs: true, checkJs: true,
        skipLibCheck: false, skipDefaultLibCheck: false, noEmitOnError: true, types: [], typeRoots: [],
        lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'], esModuleInterop: true, resolveJsonModule: true,
        experimentalDecorators: true, useDefineForClassFields: false, forceConsistentCasingInFileNames: true,
        rootDir: '/project', outDir: '/run', removeComments: false };
    const resolve = (name: string, importer: string): TypeScript.ResolvedModuleFull | undefined => {
        let resolved: string | undefined;
        if (importer.startsWith('/project/')) {
            if (name === 'cc') resolved = '/sdk/types/cc.d.ts';
            else {
                const local = resolveProject(name, importer.slice('/project/'.length));
                if (local) {
                    resolved = `/project/${local}`;
                    if (!sources.has(resolved)) reject('An undiscovered dependency is not part of the admitted logic closure.', importer.slice('/project/'.length));
                }
            }
        } else if (name === 'undici-types') resolved = '/sdk/host-types/undici-types/index.d.ts';
        else if (/^(?:\.\/|\.\.\/)/.test(name)) {
            const base = path.posix.resolve(path.posix.dirname(importer), name);
            resolved = [base, base + '.d.ts', base + '/index.d.ts'].find(file => sources.has(file));
            if (!resolved?.startsWith('/sdk/')) reject('A delivered declaration imports outside the SDK type closure.');
        } else if (name !== 'cc' && !nodeModules.has(name)) {
            // cc.d.ts contains its own ambient internal modules; only these can
            // remain unresolved. The host never delegates to ts.sys or Node.
            const ambient = [...sources.values()].some(source => source.includes(`declare module "${name}"`) || source.includes(`declare module '${name}'`));
            if (!ambient) reject('A delivered declaration imports outside the SDK type closure.');
        }
        return resolved ? { resolvedFileName: resolved, extension: resolved.endsWith('.d.ts') ? ts.Extension.Dts
            : resolved.endsWith('.json') ? ts.Extension.Json : resolved.endsWith('.ts') ? ts.Extension.Ts : ts.Extension.Js } : undefined;
    };
    const host: TypeScript.CompilerHost = {
        getSourceFile: (name, version) => sources.has(name) ? project.get(name.slice('/project/'.length))
            ?? ts.createSourceFile(name, sources.get(name)!, version, true) : undefined,
        getDefaultLibFileName: opts => `/sdk/typescript/${ts.getDefaultLibFileName(opts)}`,
        getDefaultLibLocation: () => '/sdk/typescript', getCurrentDirectory: () => '/project',
        getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
        fileExists: name => sources.has(name), readFile: name => sources.get(name),
        getDirectories: () => [], directoryExists: name => [...sources.keys()].some(file => file.startsWith(name + '/')),
        realpath: name => name, writeFile: () => { throw new Error('Unexpected logic emit.'); },
        resolveModuleNames: (names, importer) => names.map(name => resolve(name, importer)),
        resolveTypeReferenceDirectives: (names, importer) => names.map(value => {
            const name = typeof value === 'string' ? value : value.fileName;
            if (name !== 'node' || !importer?.startsWith('/sdk/host-types/')) reject('External type reference discovery is forbidden.');
            return { resolvedFileName: nodeIndex, primary: true };
        }),
    };
    const program = ts.createProgram([...project.keys()].map(name => `/project/${name}`).concat('/sdk/types/cc.d.ts', nodeIndex), options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const errors = diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error);
    if (errors.length) {
        report.items = errors.slice(0, 16).map(item => {
            const position = item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start) : undefined;
            const file = item.file?.fileName.replace(/^\/(?:project|sdk)\//, '');
            return { name: file ?? 'Logic TypeScript', file, code: `TS${item.code}`, status: 'failed',
                message: ts.flattenDiagnosticMessageText(item.messageText, '\n').slice(0, 768),
                ...(position ? { line: position.line + 1, column: position.character + 1 } : {}) };
        });
        if (errors.length > 16) report.items.push({ name: 'Diagnostics', status: 'warning', code: 'DIAGNOSTICS_TRUNCATED', message: 'Additional diagnostics omitted.' });
        throw new AppError('TYPECHECK_FAILED', 'Logic typechecking failed; no test code was executed.', ['Fix the reported logic types and retry with a new requestKey.'], false, report);
    }
    const files = new Map<string, string>();
    const emitted = program.emit(undefined, (name, text) => {
        if (!name.startsWith('/run/') || (!sourceFile.test(name) && !name.endsWith('.json'))) reject('Unexpected logic compiler output.');
        files.set(outputName(name.slice('/run/'.length)), text);
    }, undefined, false, { before: [transformation => source => {
        if (!source.fileName.startsWith('/project/')) return source;
        const importer = source.fileName.slice('/project/'.length);
        const specifier = (literal: TypeScript.StringLiteral): TypeScript.StringLiteral => {
            const local = resolveProject(literal.text, importer);
            if (!local) return literal;
            let relative = path.posix.relative(path.posix.dirname(outputName(importer)), outputName(local));
            if (!relative.startsWith('.')) relative = './' + relative;
            return ts.factory.createStringLiteral(relative);
        };
        const visit: TypeScript.Visitor = node => {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return ts.factory.updateImportDeclaration(node,
                node.modifiers, node.importClause, specifier(node.moduleSpecifier), node.assertClause);
            if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return ts.factory.updateExportDeclaration(node,
                node.modifiers, node.isTypeOnly, node.exportClause, specifier(node.moduleSpecifier), node.assertClause);
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && ts.isStringLiteral(node.arguments[0])) {
                return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [specifier(node.arguments[0])]);
            }
            return ts.visitEachChild(node, visit, transformation);
        };
        return ts.visitNode(source, visit) as TypeScript.SourceFile;
    }] });
    if (emitted.emitSkipped || emitted.diagnostics.length || tests.some(file => !files.has(outputName(file)))) reject('The logic compiler did not emit every selected test.');
    const directory = path.join(context.staging, 'logic');
    await fs.mkdir(directory, { mode: 0o700 });
    for (const [name, text] of files) {
        await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(directory, name), text, { flag: 'wx', mode: 0o400 });
    }
    await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(logicPlanSchema.parse({ version: 1, files: tests.map(outputName) })), { flag: 'wx', mode: 0o400 });
    report.validationLevels.push('logicTypecheck');
    report.items.push({ name: 'Logic compiler', status: 'passed', message: `SDK TypeScript 4.9.5; strict/checkJs=true, noImplicitAny=${noImplicitAny}, skipLibCheck/skipDefaultLibCheck=false. Real packaged Node types; no executable configs, scripts, ancestor dependencies or cc runtime were loaded.` });
    log('Executing trusted pure logic snapshot with node:test. NOT a sandbox: child code can access host files/processes/network. No game build or engine runner.');
    const result = await execute();
    if (result.result) {
        report.logic = result.result.summary;
        report.items.push(...result.result.items);
    }
    if (result.error) throw new AppError(result.error.code, result.error.message, result.error.nextSteps, result.error.retryable, report);
    if (result.exitCode !== 0 || result.signal || !result.result || result.result.summary.failed) {
        throw new AppError('TEST_FAILED', 'The logic runner or a test failed.', ['Inspect the test report and bounded logs, then use a new requestKey.'], false, report);
    }
    report.validationLevels.push('logicExecution');
    report.summary = 'Pure logic tests passed on the recorded snapshot. This is not engine/headless, browser/rendering, or device validation.';
    return reportSchema.parse(report);
}
