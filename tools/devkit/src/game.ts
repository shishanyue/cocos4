import * as fs from 'node:fs/promises';
import path from 'node:path';
import Module, { builtinModules, createRequire } from 'node:module';
import type * as TypeScript from 'typescript';
import { z } from 'zod';
import { AppError, artifactInventorySchema, artifactSchema, authorize, matchesArtifactProvenance, MAX_ARTIFACT_BYTES,
    operationRequestSchema, permissionsSchema, reportSchema } from './contracts.js';
import type { Artifact, ErrorCode, ExecuteLogic, OperationRequest, Report, WorkerRequest } from './contracts.js';
import { canonical, hash, parseJson } from './sdk.js';
import type { Sdk } from './sdk.js';
import { publishGameOutput, readGameOutput, validateProjectDestination, validateRelativePath, withGameSnapshot } from './workspace.js';
import { validateBilibiliPackage } from './bilibili.js';
import { checkLogic } from './logic.js';

const sharedRuntimeNames = ['loader.js', 'internal-prerequisites.js', 'import-map.json', 'settings.json', 'builtin-report.json', 'ENGINE-LICENSE'];
const runtimeNames = {
    HTML5: new Set([...sharedRuntimeNames, 'index.html', 'boot.js']),
    BILIBILI: new Set([...sharedRuntimeNames, 'game.js', 'game.json', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js']),
};
const runtimeFile = (name: string, target: Artifact['target']): boolean => runtimeNames[target].has(name)
    || name.startsWith(target === 'HTML5' ? 'engine/' : 'cocos-js/') || name.startsWith('assets/internal/');
const standardAsset = (name: string): boolean => /\.(?:png|jpe?g|webp|gif|wav|mp3|ogg|json|txt)$/i.test(name);
const linkageSource = '__cocos4_bootstrap__.ts';
const linkageOutput = '__cocos4_bootstrap__.js';
const diagnostic = z.object({ code: z.union([z.string(), z.number()]), severity: z.enum(['error', 'warning', 'info']),
    message: z.string(), file: z.string().nullable().optional(), line: z.number().int().positive().nullable().optional(),
    column: z.number().int().positive().nullable().optional() });
const metadataSchema = z.object({ requiredCCExports: z.array(z.string()).max(4096), typeChecked: z.literal(true),
    profileChecked: z.literal(true), checkOnly: z.boolean(), emitted: z.boolean(), diagnostics: z.array(diagnostic),
    outputFiles: z.array(z.string()).max(10000),
    typeChecking: z.object({ strict: z.literal(true), skipLibCheck: z.literal(false), skipDefaultLibCheck: z.literal(false) }).passthrough(),
}).passthrough();

function diagnosticsReport(values: unknown, summary: string): Report {
    const items: Report['items'] = [];
    const list = Array.isArray(values) ? values : [];
    for (const value of list.slice(0, 16)) {
        const parsed = diagnostic.safeParse(value);
        if (!parsed.success) continue;
        const item = parsed.data;
        // Diagnostics are project-controlled text, not a license to return paths,
        // source dumps or an unbounded TypeScript error chain to MCP clients.
        const file = item.file && !path.isAbsolute(item.file) && !item.file.split('/').includes('..')
            ? item.file.slice(0, 512) : undefined;
        items.push({ name: file ?? 'Game compiler', code: `${typeof item.code === 'number' ? 'TS' : ''}${item.code}`.slice(0, 128),
            status: item.severity === 'error' ? 'failed' : item.severity === 'warning' ? 'warning' : 'info',
            message: item.message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 768),
            ...(file ? { file } : {}), ...(item.line ? { line: item.line } : {}), ...(item.column ? { column: item.column } : {}) });
    }
    while (Buffer.byteLength(JSON.stringify(items)) > 24 * 1024) items.pop();
    if (list.length > items.length) items.push({ name: 'Diagnostics', status: 'warning', code: 'DIAGNOSTICS_TRUNCATED',
        message: 'Additional compiler diagnostics were omitted to keep the failed report bounded.' });
    return reportSchema.parse({ summary, items, validationLevels: [] });
}

async function write(root: string, name: string, bytes: Buffer | string, editable = false): Promise<void> {
    validateRelativePath(name);
    if (name === '.') throw new AppError('ARTIFACT_INVALID', 'Expected a file path.');
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, name), bytes, { flag: 'wx', mode: editable ? 0o600 : 0o400 });
}

// This guard is local to the fixed worker's compile interval. Node must not fall
// back to engine/root/global node_modules, including optional dependency probes.
async function compile(toolchain: string, options: Record<string, unknown>, projectFiles: ReadonlyMap<string, Buffer>): Promise<{
    metadata: z.infer<typeof metadataSchema>; files: Map<string, Buffer>;
}> {
    type Resolver = (request: string, parent: { filename?: string } | undefined, ...args: unknown[]) => string;
    const commonjs = Module as unknown as { _resolveFilename: Resolver };
    const original = commonjs._resolveFilename;
    const require = createRequire(path.join(toolchain, 'package.json'));
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
    commonjs._resolveFilename = function (request, parent, ...args): string {
        const resolved = original.call(this, request, parent, ...args);
        if (parent?.filename?.startsWith(`${toolchain}/`) && !builtins.has(resolved) && !resolved.startsWith(`${toolchain}/`)) {
            throw new AppError('SDK_INCOMPLETE', 'The SDK compiler attempted to resolve outside its private verified closure.');
        }
        return resolved;
    };
    try {
        const compiler = require(path.join(toolchain, 'compiler/compile-game.cjs')) as {
            compileGame(input: Record<string, unknown>): Promise<unknown>;
        };
        const result = metadataSchema.parse(await compiler.compileGame({ ...options, toolchainDirectory: toolchain }));
        if (result.diagnostics.some(item => item.severity === 'error')) {
            throw { code: 'TYPECHECK_FAILED', diagnostics: result.diagnostics };
        }
        if (result.checkOnly !== options.checkOnly || result.emitted === options.checkOnly) {
            throw new AppError('SDK_INCOMPLETE', 'The compiler did not provide the requested check/emit evidence.');
        }
        if (options.variant === 'release' && !z.object({ variant: z.literal('release'), sourceMaps: z.literal(false),
            minified: z.literal(true), compact: z.literal(true), comments: z.literal('license-only') }).strict().safeParse(result.emission).success) {
            throw new AppError('SDK_INCOMPLETE', 'The compiler did not provide release emission evidence. Debug output cannot stand in for a release build.');
        }
        const files = options.checkOnly ? new Map<string, Buffer>() : await readGameOutput(options.outDirectory as string);
        if (!options.checkOnly) {
            for (const name of result.outputFiles) {
                validateRelativePath(name);
                if (!name.endsWith('.js') || !files.has(name)) throw new AppError('ARTIFACT_INVALID', 'Unexpected or missing compiler output path.');
            }
            if (new Set(result.outputFiles).size !== result.outputFiles.length || files.size !== result.outputFiles.length) {
                throw new AppError('ARTIFACT_INVALID', 'Compiler output does not match its file inventory.');
            }
            // Saved SDK compilers do not know the bootstrap contract. Inspect their
            // emitted bytes with the already-private parser, never by running the game.
            const ts = require(path.join(toolchain, 'node_modules/typescript/lib/typescript.js')) as typeof TypeScript;
            if (ts.version !== '4.9.5') throw new AppError('SDK_INCOMPLETE', 'Expected the private SDK TypeScript 4.9.5 parser.');
            const entryFile = projectFiles.has('src/main.ts') ? 'src/main.ts' : 'src/main.js';
            const fail = (message: string, file: string, node?: TypeScript.Node, code = 'UNSUPPORTED_PROJECT'): never => {
                const position = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
                throw { code, diagnostics: [{ code, severity: 'error', message,
                    file: file === 'main.js' ? entryFile : `game/${file}`,
                    line: position ? position.line + 1 : 1, column: position ? position.character + 1 : 1 }] };
            };
            let scriptBytes = 0;
            let visited = 0;
            const deadline = performance.now() + 60000;
            // Binding inspection only: the SDK already performed the full strict check,
            // including the bootstrap signature and real libs. These programs see no disk.
            const programFor = (sources: Map<string, TypeScript.SourceFile>): TypeScript.Program => ts.createProgram([...sources.keys()],
                { allowJs: true, noResolve: true, noLib: true, types: [], typeRoots: [] }, {
                    getSourceFile: name => sources.get(name), getDefaultLibFileName: () => '',
                    writeFile() {}, getCurrentDirectory: () => '/', getDirectories: () => [],
                    fileExists: name => sources.has(name), readFile: name => sources.get(name)?.text,
                    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
                    resolveModuleNames: (names, importer) => names.map(name => {
                        if (performance.now() > deadline) fail('Source binding inspection exceeded its budget.', 'main.js');
                        // Match the compiler's relative .js -> .ts resolution; cc is not
                        // a project implementation and needs no ambient stand-in here.
                        if (!/^(\.\/|\.\.\/)/.test(name) || !name.endsWith('.js') || /[\\:\0?#]/.test(name)) return undefined;
                        const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(importer), name));
                        const resolvedFileName = sources.has(candidate) ? candidate : candidate.replace(/\.js$/, '.ts');
                        return resolvedFileName.startsWith('/src/') && sources.has(resolvedFileName)
                            ? { resolvedFileName, extension: resolvedFileName.endsWith('.ts') ? ts.Extension.Ts : ts.Extension.Js } : undefined;
                    }),
                });
            const sources = new Map<string, TypeScript.SourceFile>();
            for (const [file, bytes] of projectFiles) {
                if (!file.startsWith('src/') || !/\.(ts|js)$/.test(file) || file.endsWith('.d.ts')) continue;
                if (bytes.length > 16 * 1024 * 1024 || (scriptBytes += bytes.length) > 32 * 1024 * 1024
                    || sources.size >= 10000 || performance.now() > deadline) fail('Source binding inspection exceeded its budget.', 'main.js');
                sources.set(`/${file}`, ts.createSourceFile(`/${file}`, new TextDecoder('utf-8', { fatal: true }).decode(bytes), ts.ScriptTarget.Latest, true));
            }
            const sourceChecker = programFor(sources).getTypeChecker();
            const entry = sources.get(`/${entryFile}`);
            const module = entry && sourceChecker.getSymbolAtLocation(entry);
            const resolveAlias = (symbol: TypeScript.Symbol): TypeScript.Symbol => symbol.flags & ts.SymbolFlags.Alias
                ? sourceChecker.getAliasedSymbol(symbol) : symbol;
            const start = module && sourceChecker.getExportsOfModule(module).find(symbol => symbol.name === 'start');
            const value = start && resolveAlias(start);
            const implementation = value?.declarations?.find(node => !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient)
                && ((ts.isFunctionDeclaration(node) && node.body) || (ts.isVariableDeclaration(node) && node.initializer)
                    || (ts.isExportAssignment(node) && !node.isExportEquals)));
            if (!implementation) return fail('Entry start must resolve to an implemented function or initialized runtime value in src/. Ambient/declare-only and uninitialized exports cannot start a game.',
                'main.js', undefined, 'TYPECHECK_FAILED');
            const implementationSource = implementation.getSourceFile();
            const implementationFile = implementationSource.fileName.slice('/src/'.length).replace(/\.ts$/, '.js');
            const implementationModule = sourceChecker.getSymbolAtLocation(implementationSource);
            const implementationExports = new Set(implementationModule ? sourceChecker.getExportsOfModule(implementationModule)
                .filter(symbol => resolveAlias(symbol) === value).map(symbol => symbol.name) : []);
            let hasImplementation = false;
            scriptBytes = 0;
            for (const [file, bytes] of files) {
                if (bytes.length > 16 * 1024 * 1024 || (scriptBytes += bytes.length) > 32 * 1024 * 1024) {
                    fail('Compiled JavaScript exceeds the static inspection byte budget.', file);
                }
                const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                const virtual = `/${file}`;
                const ast = ts.createSourceFile(virtual, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
                // Lexical identity prevents shadowed exporter calls from faking evidence.
                const program = programFor(new Map([[virtual, ast]]));
                if (program.getSyntacticDiagnostics(ast).length) fail('The SDK emitted invalid JavaScript. Upgrade or regenerate the SDK compiler.', file);
                const registrations = ast.statements.filter(ts.isExpressionStatement).map(statement => statement.expression)
                    .filter(ts.isCallExpression).filter(call => ts.isPropertyAccessExpression(call.expression)
                        && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'System'
                        && call.expression.name.text === 'register');
                const declaration = registrations.length === 1 ? registrations[0].arguments[1] : undefined;
                const exported = declaration && ts.isFunctionExpression(declaration) ? declaration.parameters[0]?.name : undefined;
                const checker = program.getTypeChecker();
                const exportSymbol = exported && ts.isIdentifier(exported) ? checker.getSymbolAtLocation(exported) : undefined;
                const visit = (node: TypeScript.Node): void => {
                    if (++visited > 2000000 || performance.now() > deadline) fail('Compiled JavaScript exceeds the static inspection budget.', file);
                    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)
                        || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) {
                        fail('The SDK emitted residual ES module syntax instead of SystemJS. Upgrade or regenerate the SDK compiler; do not strip module statements.', file, node);
                    }
                    if (file === implementationFile && exportSymbol && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                        && checker.getSymbolAtLocation(node.expression) === exportSymbol) {
                        const first = node.arguments[0];
                        if (first && ts.isStringLiteral(first) && implementationExports.has(first.text) && node.arguments.length === 2) hasImplementation = true;
                        if (first && ts.isObjectLiteralExpression(first)) for (const property of first.properties) {
                            if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
                                && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && implementationExports.has(property.name.text)) hasImplementation = true;
                        }
                    }
                    ts.forEachChild(node, visit);
                };
                visit(ast);
                if (!exportSymbol) fail('Expected a compiled System.register declaration with an export callback. Upgrade or regenerate the SDK compiler.', file);
            }
            if (!hasImplementation) fail('The implementation of entry start has no verified runtime export in the emitted module. Implement and export start(): Promise<void> and regenerate the SDK if needed.',
                'main.js', undefined, 'TYPECHECK_FAILED');
        }
        return { metadata: result, files };
    } catch (error) {
        if (error instanceof AppError) throw error;
        const failure = error as { code?: string; diagnostics?: unknown } | null;
        const code: ErrorCode = failure?.code === 'TYPECHECK_FAILED' || failure?.code === 'FEATURE_NOT_IN_PROFILE'
            || failure?.code === 'UNSUPPORTED_PROJECT' ? failure.code : 'PROCESS_FAILED';
        const report = diagnosticsReport(failure?.diagnostics, 'Game compilation failed. No project scripts, plugins or tests were executed.');
        if (!report.items.some(item => item.status === 'failed')) report.items.unshift({ name: 'Game compiler', status: 'failed',
            code, message: 'The SDK compiler did not complete successfully.' });
        throw new AppError(code, report.summary, ['Fix the reported source/configuration errors and retry.'], false, report);
    } finally {
        commonjs._resolveFilename = original;
        for (const name of Object.keys(require.cache)) if (name.startsWith(`${toolchain}/`)) delete require.cache[name];
    }
}

function inventoryArtifact(files: Map<string, Buffer>, artifact: Artifact): void {
    const raw = files.get('artifact-inventory.json');
    if (!raw || raw.length > 4 * 1024 * 1024 || hash(raw) !== artifact.sha256) {
        throw new AppError('ARTIFACT_INVALID', 'Artifact inventory bytes do not match the recorded digest.');
    }
    let value: unknown;
    try { value = parseJson(raw.toString('utf8')); }
    catch { throw new AppError('ARTIFACT_INVALID', 'Artifact inventory is not unambiguous JSON.'); }
    const parsed = artifactInventorySchema.safeParse(value);
    if (!parsed.success) throw new AppError('ARTIFACT_INVALID', 'Invalid artifact inventory.');
    const { files: records, schemaVersion: _, ...identity } = parsed.data;
    const { files: count, bytes, sha256: __, ...expected } = artifact;
    if (canonical(identity) !== canonical(expected) || count !== records.length || files.size !== count + 1
        || bytes !== records.reduce((sum, file) => sum + file.bytes, 0) || bytes > MAX_ARTIFACT_BYTES) {
        throw new AppError('ARTIFACT_INVALID', 'Artifact identity, file count or byte totals do not match.');
    }
    const names = new Set<string>();
    for (const file of records) {
        validateRelativePath(file.path);
        const content = files.get(file.path);
        if (file.path === '.' || file.path === 'artifact-inventory.json' || names.has(file.path.toLowerCase())
            || file.path.split('/').some(part => !/^[A-Za-z0-9._@+-]+$/.test(part) || part.startsWith('.') || ['node_modules', 'toolchain'].includes(part.toLowerCase()))
            || !(runtimeFile(file.path, artifact.target) || file.path === 'game-compiler.json' || (file.path.startsWith('game/') && file.path.endsWith('.js'))
                || (file.path.startsWith('assets/game/') && standardAsset(file.path)))
            || !content || content.length !== file.bytes || hash(content) !== file.sha256) {
            throw new AppError('ARTIFACT_INVALID', 'Artifact payload is missing, duplicated or changed.');
        }
        names.add(file.path.toLowerCase());
    }
    for (const name of [...runtimeNames[artifact.target], artifact.target === 'HTML5' ? 'engine/cc.js' : 'cocos-js/cc.js',
        'assets/internal/config.json', 'assets/internal/index.js', 'game/main.js', 'game-compiler.json']) {
        if (!files.has(name)) throw new AppError('ARTIFACT_INVALID', `The ${artifact.target} runtime bootstrap is incomplete.`);
    }
}

export async function runGameOperation(request: WorkerRequest, sdk: Sdk, log: (text: string) => void = () => {}, executeLogic?: ExecuteLogic): Promise<Report> {
    const parsed = operationRequestSchema.safeParse({ operation: request.operation, input: request.input });
    if (!parsed.success) throw new AppError('INVALID_ARGUMENTS', 'Invalid game operation arguments.');
    const operation = parsed.data;
    const permissions = permissionsSchema.safeParse(request.permissions ?? {});
    if (!permissions.success) throw new AppError('PERMISSION_DENIED', 'Invalid worker startup permissions.');
    authorize(operation, permissions.data);
    if (operation.operation !== 'project_create' && operation.operation !== 'project_check' && operation.operation !== 'game_build') {
        throw new AppError('INVALID_ARGUMENTS', 'Expected a game operation.');
    }
    if (request.sdkRoot !== sdk.root || (request.expectedSdkId !== undefined && request.expectedSdkId !== sdk.sdkId)) {
        throw new AppError('SDK_INCOMPLETE', 'The worker SDK does not match the admitted SDK.');
    }
    if (operation.operation === 'project_check' && operation.input.checks.includes('logic') && !executeLogic) {
        throw new AppError('UNSUPPORTED_PROJECT', 'Logic execution requires the supervised job manager. A standalone compiler worker cannot execute project tests.');
    }
    if (!sdk.toolchainRoot || !sdk.manifest.capabilities.gameDevelopment) throw new AppError('SDK_INCOMPLETE', 'This SDK has no game compiler or templates.');
    const template = operation.operation === 'project_create' ? sdk.template(operation.input.templateId) : undefined;
    const profile = template ? sdk.profile(template.target, template.profile, template.variant)
        : operation.operation !== 'project_create' ? sdk.profile(operation.input.target, operation.input.profile,
            operation.operation === 'game_build' ? operation.input.variant : 'debug') : undefined;
    if (!profile) throw new AppError('PROFILE_NOT_AVAILABLE', 'The requested template profile is unavailable.');
    const prefix = path.relative(sdk.root, profile.directory).split(path.sep).join('/');
    const descriptor = sdk.manifest.files.find(file => file.path === `${prefix}/runtime.json`);
    if (!descriptor) throw new AppError('SDK_INCOMPLETE', 'The selected profile has no verified runtime descriptor.');
    const profileIdentity = { sdkId: sdk.sdkId, target: profile.target, id: profile.profile,
        variant: profile.variant, descriptorSha256: descriptor.sha256 };
    const templatePrefix = template ? path.relative(sdk.root, template.directory).split(path.sep).join('/') : '';
    const selected = sdk.manifest.files.filter(file => file.path.startsWith(`${prefix}/types/`)
        || (template ? file.path.startsWith(`${templatePrefix}/`) : file.path.startsWith('toolchain/'))
        || (operation.operation === 'game_build' && file.path.startsWith(`${prefix}/`) && runtimeFile(file.path.slice(prefix.length + 1), profile.target))
        || (profile.target === 'BILIBILI' && (operation.operation === 'project_create' ? file.path === `${prefix}/game.json`
            : operation.operation === 'game_build' && file.path === 'app/validate-bilibili.cjs')));
    if (operation.operation === 'project_create') validateProjectDestination(operation.input.directory);
    if (operation.operation === 'game_build' && !z.string().uuid().safeParse(request.artifactId).success) {
        throw new AppError('INVALID_ARGUMENTS', 'Builds require the job manager artifact UUID.');
    }
    log('Preparing pinned project data and manifest-verified private SDK files.');
    return withGameSnapshot(request.workspace, operation.operation === 'project_create' ? undefined : operation.input.project,
        request.staging, { root: sdk.root, files: selected }, async paths => {
            const localProfile = path.join(paths.sdk, prefix);
            if (operation.operation === 'project_create') {
                const templateFiles = await readGameOutput(path.join(paths.sdk, templatePrefix));
                const pkg = JSON.parse(templateFiles.get('package.json')!.toString('utf8')) as Record<string, unknown>;
                pkg.name = operation.input.projectName;
                templateFiles.set('package.json', Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`));
                const config = JSON.parse(templateFiles.get('tsconfig.json')!.toString('utf8'));
                config.compilerOptions.paths = { cc: ['./types/cc.d.ts'] };
                templateFiles.set('tsconfig.json', Buffer.from(`${JSON.stringify(config, null, 2)}\n`));
                if (profile.target === 'BILIBILI') {
                    const config = parseJson(await fs.readFile(path.join(localProfile, 'game.json'), 'utf8')) as Record<string, unknown>;
                    // The SDK's validation-only appId must never become a user's appId.
                    config.appId = '';
                    config.version = pkg.version;
                    templateFiles.set('game.json', Buffer.from(`${JSON.stringify(config, null, 2)}\n`));
                }
                for (const [name, bytes] of templateFiles) await write(paths.output, name, bytes, true);
                for (const [name, bytes] of await readGameOutput(path.join(localProfile, 'types'))) await write(paths.output, `types/${name}`, bytes, true);
                const createdFiles = await readGameOutput(paths.output);
                return reportSchema.parse({ project: operation.input.directory, profile: profileIdentity,
                    summary: 'Editable SDK starter prepared for parent-only, non-overwriting publication. No project scripts were executed.',
                    validationLevels: ['sdk-template-integrity'], items: [{ name: operation.input.directory, status: 'passed',
                        message: 'Verified starter sources, standard assets and local SDK declarations; package name and cc type mapping configured.' },
                    ...(profile.target === 'BILIBILI' ? [{ name: 'game.json', status: 'warning', code: 'BILIBILI_CONFIG_REQUIRED',
                        message: 'Set your appId and review version/platform settings in game.json before building. No vendor identity or device compatibility has been verified.' }] : []),
                    ...[...createdFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, bytes]) => ({ name: file, file,
                        code: 'PROJECT_FILE', status: 'passed', bytes: bytes.length, sha256: hash(bytes), message: 'Prepared starter file; publication is confirmed only by a succeeded job.' }))] });
            }
            const checkOnly = operation.operation === 'project_check';
            const projectFiles = await readGameOutput(paths.project!);
            const logic = async (base?: Report): Promise<Report> => {
                try {
                    const result = await checkLogic({ project: paths.project!, toolchain: path.join(paths.sdk, 'toolchain'),
                        types: path.join(localProfile, 'types'), staging: request.staging, projectFiles }, executeLogic!, log);
                    return reportSchema.parse({ ...result, project: operation.input.project, profile: profileIdentity,
                        items: [...base?.items ?? [], ...result.items], validationLevels: [...base?.validationLevels ?? [], ...result.validationLevels] });
                } catch (error) {
                    if (error instanceof AppError && error.report) throw new AppError(error.code, error.message, error.nextSteps, error.retryable,
                        { ...error.report, project: operation.input.project, profile: profileIdentity,
                            items: [...base?.items ?? [], ...error.report.items],
                            validationLevels: [...base?.validationLevels ?? [], ...error.report.validationLevels] });
                    throw error;
                }
            };
            if (operation.operation === 'project_check' && !operation.input.checks.includes('types')) return logic();
            let gameConfig: Buffer | undefined;
            if (!checkOnly && profile.target === 'BILIBILI') {
                gameConfig = projectFiles.get('game.json');
                if (!gameConfig) throw new AppError('UNSUPPORTED_PROJECT', 'BILIBILI builds require a project game.json; the SDK validation-only configuration is not a fallback.',
                    ['Add game.json with your appId, version and platform settings, then build again.']);
                let config: Record<string, unknown>;
                try { config = z.record(z.unknown()).parse(parseJson(new TextDecoder('utf-8', { fatal: true }).decode(gameConfig))); }
                catch { throw new AppError('ARTIFACT_INVALID', 'Project game.json must be an unambiguous UTF-8 JSON object.', [], false,
                    diagnosticsReport([{ code: 'ARTIFACT_INVALID', severity: 'error', file: 'game.json',
                        message: 'Expected an unambiguous UTF-8 JSON object.' }], 'Invalid BILIBILI project configuration.')); }
                if (Array.isArray(config.subpackages) && config.subpackages.length) {
                    throw new AppError('UNSUPPORTED_PROJECT', 'These BILIBILI profiles produce unsplit source packages; subpackage assembly is not implemented.');
                }
            }
            let compilerProject = paths.project!;
            if (!checkOnly) {
                compilerProject = path.join(request.staging, 'compiler-project');
                await fs.mkdir(compilerProject, { mode: 0o700 });
                for (const [name, bytes] of projectFiles) {
                    if (name === `src/${linkageSource}` || name === `src/${linkageOutput}`) {
                        throw new AppError('UNSUPPORTED_PROJECT', 'The compiler bootstrap-check filename is reserved.');
                    }
                    if (name.startsWith('src/') || name === 'tsconfig.json') await write(compilerProject, name, bytes);
                    if (name.startsWith('assets/') && !standardAsset(name)) throw new AppError('UNSUPPORTED_PROJECT', 'Only standard image/audio/JSON/text game assets are supported; no Creator import pipeline is run.');
                }
                // Typecheck the bootstrap contract together with the actual game.
                // This module is never executed and is not part of the payload.
                await write(compilerProject, `src/${linkageSource}`,
                    "import { start } from './main.js';\nconst startGame: () => Promise<void> = start;\nexport { startGame };\n");
            }
            log('Running the SDK-contained strict game compiler; project code and lifecycle scripts are not executed.');
            const emitted = path.join(request.staging, 'compiled');
            let compilation: Awaited<ReturnType<typeof compile>>;
            try {
                compilation = await compile(path.join(paths.sdk, 'toolchain'), { projectDirectory: compilerProject,
                    typesDirectory: path.join(localProfile, 'types'), outDirectory: emitted, checkOnly, variant: profile.variant,
                    availableCCExports: [...profile.ccExports] }, projectFiles);
            } catch (error) {
                if (error instanceof AppError && error.report) throw new AppError(error.code, error.message, error.nextSteps,
                    error.retryable, { ...error.report, project: operation.input.project, profile: profileIdentity });
                throw error;
            }
            const { metadata, files: compiledFiles } = compilation;
            const report = diagnosticsReport(metadata.diagnostics, checkOnly ? 'Game types and runtime-profile exports checked successfully. Logic and browser execution were not performed.'
                : `${profile.target} game compiled and inventoried for parent-only publication. Browser, Creator, vendor and device validation were not performed.`);
            report.validationLevels = ['gameTypecheck', 'profileLinkage'];
            report.project = operation.input.project;
            report.profile = profileIdentity;
            report.items.unshift({ name: 'Game compiler', status: 'passed', message: 'SDK-contained TypeScript: strict=true, skipLibCheck=false, skipDefaultLibCheck=false. No project scripts or plugins were loaded.' });
            if (checkOnly) return operation.input.checks.includes('logic') ? logic(report) : reportSchema.parse(report);
            metadata.outputFiles = metadata.outputFiles.filter(name => name !== linkageOutput);
            const expectedRuntimeFiles = [];
            for (const file of selected) {
                const name = file.path.slice(prefix.length + 1);
                if (file.path.startsWith(`${prefix}/`) && runtimeFile(name, profile.target) && name !== 'game.json') {
                    await write(paths.output, name, await fs.readFile(path.join(paths.sdk, file.path)));
                    expectedRuntimeFiles.push({ path: name, bytes: file.bytes, sha256: file.sha256 });
                }
            }
            for (const name of metadata.outputFiles) {
                await write(paths.output, `game/${name}`, compiledFiles.get(name)!);
            }
            for (const [name, bytes] of projectFiles) if (name.startsWith('assets/')) await write(paths.output, `assets/game/${name.slice(7)}`, bytes);
            await write(paths.output, 'game-compiler.json', `${JSON.stringify(metadata, null, 2)}\n`);
            report.validationLevels.push('gameBuild', 'artifactIntegrity');
            if (profile.target === 'BILIBILI') {
                await write(paths.output, 'game.json', gameConfig!);
                log('Checking the BILIBILI static module/resource closure and canonical source-package preflight without executing game code.');
                const validation = await validateBilibiliPackage({ directory: paths.output,
                    toolchainDirectory: path.join(paths.sdk, 'toolchain'), validatorFile: path.join(paths.sdk, 'app/validate-bilibili.cjs'),
                    expectedRuntimeFiles, requiredCCExports: metadata.requiredCCExports, ccExports: [...profile.ccExports] });
                report.items.push(...validation.items);
                report.validationLevels.push(...validation.validationLevels);
            }
            const files = await readGameOutput(paths.output);
            const identity = { artifactId: request.artifactId!, sdkId: sdk.sdkId, target: profile.target,
                profile: profile.profile, variant: profile.variant, entry: profile.entry, validationLevels: [...report.validationLevels],
                provenance: { releaseId: request.releaseId ?? null, profileSha256: descriptor.sha256 } };
            const inventory = artifactInventorySchema.parse({ ...identity, schemaVersion: 1,
                files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })) });
            const raw = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
            const artifact = artifactSchema.parse({ ...identity, bytes: inventory.files.reduce((sum, file) => sum + file.bytes, 0),
                files: inventory.files.length, sha256: hash(raw) });
            files.set('artifact-inventory.json', raw);
            inventoryArtifact(files, artifact);
            await write(paths.output, 'artifact-inventory.json', raw);
            report.artifacts = [artifact];
            log('Compilation and artifact inventory complete. The worker has not published any output.');
            return reportSchema.parse(report);
        });
}

export async function commitGameOutput(context: { workspace: string; staging: string; artifactsRoot: string; releaseId?: string | null },
    request: OperationRequest, report: Report): Promise<void> {
    if (request.operation !== 'project_create' && request.operation !== 'game_build') return;
    report = reportSchema.parse(report);
    if (report.items.some(item => item.status === 'failed')) throw new AppError('ARTIFACT_INVALID', 'Failed reports cannot be published.');
    if (request.operation === 'project_create') {
        if (report.project !== request.input.directory || report.artifacts?.length) throw new AppError('ARTIFACT_INVALID', 'Project publication does not match its request.');
        await publishGameOutput(context, { project: request.input.directory }, files => {
            for (const name of ['package.json', 'tsconfig.json', 'src/main.ts', 'types/cc.d.ts']) {
                if (!files.has(name)) throw new AppError('ARTIFACT_INVALID', 'The prepared project is incomplete.');
            }
            if (JSON.parse(files.get('package.json')!.toString('utf8')).name !== request.input.projectName) {
                throw new AppError('ARTIFACT_INVALID', 'The prepared package name does not match.');
            }
            const inventory = report.items.filter(item => item.code === 'PROJECT_FILE');
            if (inventory.length !== files.size || new Set(inventory.map(item => item.file)).size !== files.size
                || inventory.some(item => !item.file || !files.has(item.file) || item.bytes !== files.get(item.file)!.length
                    || item.sha256 !== hash(files.get(item.file)!))) {
                throw new AppError('ARTIFACT_INVALID', 'The created-file report does not match the prepared starter.');
            }
        });
    } else {
        if (report.artifacts?.length !== 1) throw new AppError('ARTIFACT_INVALID', 'Expected exactly one build artifact.');
        const artifact = artifactSchema.parse(report.artifacts[0]);
        if (!matchesArtifactProvenance(artifact, report.profile, context.releaseId ?? null)) {
            throw new AppError('ARTIFACT_INVALID', 'Build artifact provenance does not match its admitted release and profile.');
        }
        if (artifact.target !== request.input.target || artifact.profile !== request.input.profile || artifact.variant !== request.input.variant) {
            throw new AppError('ARTIFACT_INVALID', 'Build artifact does not match its request.');
        }
        await publishGameOutput(context, { artifact: `artifact-${artifact.artifactId}` }, files => inventoryArtifact(files, artifact));
    }
}
