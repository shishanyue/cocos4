import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Script } from 'node:vm';
import type * as TypeScript from 'typescript';
import { z } from 'zod';
import { extractRuntimeExports } from './api-index.js';
import { AppError, MAX_ARTIFACT_BYTES } from './contracts.js';
import type { ErrorCode, Report } from './contracts.js';
import { readGameOutput, validateRelativePath } from './workspace.js';

const runtimeRoots = new Set(['game.js', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js',
    'loader.js', 'settings.json', 'import-map.json', 'internal-prerequisites.js', 'builtin-report.json', 'ENGINE-LICENSE']);
const mandatory = [...runtimeRoots, 'cocos-js/cc.js', 'assets/internal/config.json', 'assets/internal/index.js'];
const notices = {
    BILIBILI: [],
    WECHAT: ['WECHAT-ADAPTER-LICENSE'],
    BYTEDANCE: ['licenses/bytedance/package.json', 'licenses/bytedance/README.md',
        'licenses/bytedance/ENGINE-LICENSE', 'licenses/bytedance/NOTICE.txt'],
} as const;
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const uuid = z.string().uuid();
const strings = z.array(z.string().min(1).max(1024)).max(10000);
const fileRecord = z.object({ path: z.string().min(1).max(1024), bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const preflightSchema = z.object({ totalBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
    packages: z.array(z.object({ name: z.string(), root: z.string(), bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES) })).max(20000),
    warnings: z.array(z.string()).max(20000) });

export type MiniGamePackageOptions = {
    target: 'BILIBILI' | 'WECHAT' | 'BYTEDANCE';
    directory: string;
    toolchainDirectory: string;
    validatorFile: string;
    expectedRuntimeFiles: readonly { path: string; bytes: number; sha256: string }[];
    requiredCCExports: readonly string[];
    ccExports: readonly string[];
};

/** Caller supplies target-pin/manifest-verified, private SDK copies and fresh compiler output. */
export async function validateMiniGamePackage(options: MiniGamePackageOptions): Promise<{ items: Report['items']; validationLevels: string[] }> {
    const target = options?.target;
    const label = target === 'BILIBILI' ? 'Bilibili' : target === 'WECHAT' ? 'WeChat' : target === 'BYTEDANCE' ? 'ByteDance' : 'Mini-game';
    function fail(message: string, file?: string, code: ErrorCode = 'ARTIFACT_INVALID', location?: { line: number; column: number }): never {
        throw new AppError(code, message, [], false, { summary: `${label} source-package validation failed. No project code was executed.`,
            validationLevels: [], items: [{ name: file ?? `${label === 'Mini-game' ? 'Mini-game' : target} package`, status: 'failed', code, message,
                ...(file ? { file } : {}), ...location }] });
    }
    try {
        if (!options || typeof options !== 'object') fail('Invalid package validation options.', undefined, 'INVALID_ARGUMENTS');
        if (target !== 'BILIBILI' && target !== 'WECHAT' && target !== 'BYTEDANCE') fail('An explicit supported mini-game target is required.', undefined, 'INVALID_ARGUMENTS');
        const targetNotices: readonly string[] = notices[target];
        const runtimeFile = (name: string): boolean => runtimeRoots.has(name) || targetNotices.includes(name)
            || name.startsWith('cocos-js/') || name.startsWith('assets/internal/');
        const mutable = ['game.json', 'game-compiler.json', ...(target === 'BILIBILI' ? [] : ['project.config.json'])];
        const hostRequires = target === 'BILIBILI' ? ['__bilibiliRequire'] : target === 'WECHAT' ? ['__wechatRequire', '__wxRequire'] : ['__bytedanceRequire'];
        const { directory, toolchainDirectory, validatorFile } = options;
        for (const value of [directory, toolchainDirectory, validatorFile]) {
            if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value.length > 4096) {
                fail('Validation requires normalized absolute private paths.', undefined, 'INVALID_ARGUMENTS');
            }
        }
        const within = (root: string, file: string): boolean => file === root || file.startsWith(`${root}${path.sep}`);
        if (within(directory, toolchainDirectory) || within(toolchainDirectory, directory) || within(directory, validatorFile)
            || path.basename(validatorFile) !== (target === 'BILIBILI' ? 'validate-bilibili.cjs' : 'validate-minigame.cjs')) fail('SDK tools must be private and separate from game output.', undefined, 'SDK_INCOMPLETE');
        const records = z.array(fileRecord).min(1).max(10000).parse(options.expectedRuntimeFiles);
        const namesSchema = z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/).max(256)).max(4096);
        const required = namesSchema.parse(options.requiredCCExports);
        const available = namesSchema.parse(options.ccExports);
        const files = await readGameOutput(directory);
        const totalBytes = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
        if (totalBytes > MAX_ARTIFACT_BYTES) fail('Game output exceeds the artifact byte limit.', undefined, 'LIMIT_EXCEEDED');
        const expected = new Map<string, z.infer<typeof fileRecord>>();
        const folded = new Set<string>();
        for (const record of records) {
            validateRelativePath(record.path);
            if (!runtimeFile(record.path) || folded.has(record.path.toLowerCase())) fail('Invalid immutable runtime inventory.', undefined, 'SDK_INCOMPLETE');
            folded.add(record.path.toLowerCase());
            expected.set(record.path, record);
            const bytes = files.get(record.path);
            if (!bytes || !bytes.length || bytes.length !== record.bytes || digest(bytes) !== record.sha256) {
                fail('A required SDK runtime file is missing or changed.', record.path);
            }
        }
        for (const file of [...mandatory, ...targetNotices]) if (!expected.has(file)) fail('The SDK runtime inventory omits a mandatory bootstrap file.', file, 'SDK_INCOMPLETE');
        folded.clear();
        for (const file of files.keys()) {
            if (folded.has(file.toLowerCase()) || file.split('/').some(part => part.startsWith('.') || ['node_modules', 'toolchain'].includes(part.toLowerCase()))
                || !(expected.has(file) || mutable.includes(file)
                    || (file.startsWith('game/') && file.endsWith('.js')) || file.startsWith('assets/game/'))) {
                fail('Unexpected, ambiguous or development-only file in the production package.');
            }
            folded.add(file.toLowerCase());
        }
        const read = (file: string): Buffer => {
            validateRelativePath(file);
            const bytes = files.get(file);
            if (!bytes?.length) fail('A module or required resource is missing or empty.', file);
            return bytes;
        };
        const decode = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const json = (file: string): unknown => {
            try { return JSON.parse(decode(read(file))) as unknown; }
            catch (error) { if (error instanceof AppError) throw error; fail('Invalid UTF-8 or JSON data.', file); }
        };
        read('game.js'); read('game/main.js'); read('game.json'); read('game-compiler.json');
        if (target !== 'BILIBILI') read('project.config.json');

        // Only these private SDK bytes execute. The pinned TS monolith and canonical validator
        // have builtin-only runtime dependencies: no Node ancestor/global/project resolution.
        let ts: typeof TypeScript;
        let validate: (directory: string, target: MiniGamePackageOptions['target']) => unknown;
        try {
            const compilerFiles = await readGameOutput(path.join(toolchainDirectory, 'node_modules/typescript'));
            const parser = compilerFiles.get('lib/typescript.js');
            if (!parser || digest(parser) !== '2e78d8d8d3b631646830e478dbee1ca109474840fe5ed7ca6c5b418f2e20b1a2') {
                fail('The SDK TypeScript 4.9.5 parser does not match its reviewed pin.', undefined, 'SDK_INCOMPLETE');
            }
            const validator = (await readGameOutput(path.dirname(validatorFile))).get(path.basename(validatorFile));
            if (!validator?.length) fail('The private canonical validator is missing.', undefined, 'SDK_INCOMPLETE');
            const require = createRequire(path.join(toolchainDirectory, 'package.json'));
            const sdkRequire = (name: string): unknown => {
                if (!isBuiltin(name)) fail('SDK validation tools attempted a dependency outside their reviewed closure.', undefined, 'SDK_INCOMPLETE');
                return require(name) as unknown;
            };
            const load = (source: Buffer, filename: string): unknown => {
                const module = { exports: {} };
                new Script(`(function(exports, require, module, __filename, __dirname) {${decode(source)}\n})`, { filename })
                    .runInThisContext()(module.exports, sdkRequire, module, filename, path.dirname(filename));
                return module.exports;
            };
            ts = load(parser, path.join(toolchainDirectory, 'node_modules/typescript/lib/typescript.js')) as typeof TypeScript;
            const canonical = load(validator, validatorFile) as { validateBilibili?: unknown; validateMiniGame?: unknown } | null;
            const entry = target === 'BILIBILI' ? canonical?.validateBilibili : canonical?.validateMiniGame;
            if (ts.version !== '4.9.5' || typeof entry !== 'function') fail('Invalid private SDK validation tools.', undefined, 'SDK_INCOMPLETE');
            validate = entry as typeof validate;
        } catch { fail('The private SDK parser or canonical validator could not be loaded.', undefined, 'SDK_INCOMPLETE'); }

        const map = z.object({ imports: z.record(z.string().min(1).max(1024), z.string().min(1).max(1024)) }).strict().parse(json('import-map.json'));
        if (map.imports.cc !== './cocos-js/cc.js') fail(`The cc import map entry does not reference the ${label} engine.`, 'import-map.json');
        const resolve = (specifier: string, parent: string, commonjs: boolean): string => {
            let target = specifier;
            if (!commonjs && Object.hasOwn(map.imports, target)) { target = map.imports[target]; parent = 'game.js'; }
            if (!/^(?:\.\/|\.\.\/)/.test(target) || /[\\:%?#\x00-\x1f\x7f]/.test(target)) fail('Unsafe or unmapped static module request.', parent);
            const relative = path.posix.normalize(path.posix.join(path.posix.dirname(parent), target));
            validateRelativePath(relative);
            const candidates = commonjs && !path.posix.extname(relative) ? [relative, `${relative}.js`, `${relative}.json`, `${relative}/index.js`] : [relative];
            const file = candidates.find(name => files.has(name));
            if (!file || !/\.(?:js|json)$/.test(file)) fail('A static module request does not resolve to a packaged JS/JSON file.', parent);
            read(file);
            return file;
        };
        for (const name of Object.keys(map.imports)) resolve(name, 'game.js', false);
        const edges = new Set<string>();
        const engineExports = new Set<string>();
        const modules: string[] = [];
        let scriptBytes = 0;
        let visited = 0;
        let dynamicRuntimeRequests = 0;
        let bundledModules = 0;
        let bundledEdges = 0;
        const deadline = performance.now() + 60000;
        for (const [file, bytes] of files) {
            if (!file.endsWith('.js')) continue;
            if (bytes.length > 16 * 1024 * 1024 || (scriptBytes += bytes.length) > 32 * 1024 * 1024) {
                fail('Static JavaScript inspection exceeded its byte budget.', undefined, 'LIMIT_EXCEEDED');
            }
            const source = decode(bytes);
            const virtual = `/${file}`;
            const ast = ts.createSourceFile(virtual, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
            // Syntactic diagnostics also reject TS-only syntax in a .js file. No compiler
            // host operation delegates to ts.sys or discovers project/engine inputs.
            const program = ts.createProgram([virtual], { allowJs: true, noResolve: true, noLib: true, types: [], typeRoots: [] }, {
                getSourceFile: name => name === virtual ? ast : undefined, getDefaultLibFileName: () => '',
                writeFile() {}, getCurrentDirectory: () => '/', getDirectories: () => [],
                fileExists: name => name === virtual, readFile: name => name === virtual ? source : undefined,
                getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
            });
            const diagnostics = program.getSyntacticDiagnostics(ast);
            if (diagnostics.length) {
                const position = ast.getLineAndCharacterOfPosition(diagnostics[0].start ?? 0);
                fail('JavaScript parser rejected the packaged source.', file, 'ARTIFACT_INVALID', { line: position.line + 1, column: position.character + 1 });
            }
            modules.push(file);
            const contexts = new Set<string>();
            let registrations = 0;
            const unwrap = (node: TypeScript.Expression): TypeScript.Expression => {
                while (ts.isParenthesizedExpression(node)) node = node.expression;
                return node;
            };
            const literal = (node: TypeScript.Node | undefined): string | undefined => {
                while (node && ts.isParenthesizedExpression(node)) node = node.expression;
                return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
            };
            const reference = (node: TypeScript.Expression): string => {
                node = unwrap(node);
                if (ts.isIdentifier(node)) return node.text;
                if (ts.isPropertyAccessExpression(node)) return `${reference(node.expression)}.${node.name.text}`;
                if (ts.isElementAccessExpression(node)) return `${reference(node.expression)}.${literal(node.argumentExpression) ?? ''}`;
                return '';
            };
            const member = (node: TypeScript.Expression): { object: string; property: string | undefined } | undefined => {
                node = unwrap(node);
                if (ts.isPropertyAccessExpression(node)) return { object: reference(node.expression), property: node.name.text };
                if (ts.isElementAccessExpression(node)) return { object: reference(node.expression), property: literal(node.argumentExpression) };
                return undefined;
            };
            // These adapters are already target-pinned by the SDK caller. Browserify's
            // factory-local require resolves through its table, not the package filesystem.
            const bundled = new Map<TypeScript.Symbol, Map<string, string>>();
            const moduleIds = new Set<string>();
            const checker = target !== 'BILIBILI' && ['web-adapter.js', 'engine-adapter.js'].includes(file) ? program.getTypeChecker() : undefined;
            const moduleId = (node: TypeScript.Node | undefined): string | undefined => node && ts.isNumericLiteral(node) ? node.text : literal(node);
            if (checker) {
                const statement = ast.statements[0];
                const bundle = statement && ts.isExpressionStatement(statement) ? unwrap(statement.expression) : undefined;
                if (!bundle || !ts.isCallExpression(bundle) || bundle.arguments.length !== 3) fail('Invalid pinned Browserify adapter.', file);
                const [table, cache, entries] = bundle.arguments;
                if (!ts.isObjectLiteralExpression(table) || !table.properties.length || !ts.isObjectLiteralExpression(cache) || cache.properties.length
                    || !ts.isArrayLiteralExpression(entries) || !entries.elements.length) fail('Invalid pinned Browserify module table.', file);
                for (const item of table.properties) {
                    if (!ts.isPropertyAssignment(item)) fail('Invalid bundled module declaration.', file);
                    const id = moduleId(item.name);
                    const pair = unwrap(item.initializer);
                    if (id === undefined || moduleIds.has(id) || !ts.isArrayLiteralExpression(pair) || pair.elements.length !== 2) fail('Invalid or duplicate bundled module.', file);
                    moduleIds.add(id);
                    const factory = unwrap(pair.elements[0]);
                    const dependencies = unwrap(pair.elements[1]);
                    if (!ts.isFunctionExpression(factory) || !ts.isObjectLiteralExpression(dependencies)) fail('Invalid bundled module factory.', file);
                    const parameter = factory.parameters[0]?.name;
                    const symbol = parameter && ts.isIdentifier(parameter) ? checker.getSymbolAtLocation(parameter) : undefined;
                    if (!symbol) fail('Missing bundled require binding.', file);
                    const mapping = new Map<string, string>();
                    for (const dependency of dependencies.properties) {
                        if (!ts.isPropertyAssignment(dependency)) fail('Invalid bundled dependency mapping.', file);
                        const name = ts.isIdentifier(dependency.name) ? dependency.name.text : literal(dependency.name);
                        const destination = moduleId(dependency.initializer);
                        if (name === undefined || destination === undefined || mapping.has(name)) fail('Invalid or duplicate bundled dependency mapping.', file);
                        mapping.set(name, destination);
                    }
                    bundled.set(symbol, mapping);
                }
                for (const dependencies of bundled.values()) for (const destination of dependencies.values()) {
                    if (!moduleIds.has(destination)) fail('A bundled dependency is absent from the adapter module table.', file);
                    ++bundledEdges;
                }
                for (const entry of entries.elements) {
                    const id = moduleId(entry);
                    if (id === undefined || !moduleIds.has(id)) fail('A Browserify entry is absent from the adapter module table.', file);
                }
                bundledModules += moduleIds.size;
            }
            const request = (node: TypeScript.CallExpression, commonjs: boolean, parent: string): void => {
                const value = literal(node.arguments[0]);
                if (value === undefined) {
                    if (!expected.has(file)) fail('Computed project module requests cannot establish static closure.', file);
                    ++dynamicRuntimeRequests;
                } else edges.add(`${file}\0${resolve(value, parent, commonjs)}`);
            };
            const visit = (node: TypeScript.Node): void => {
                if (++visited > 2000000 || performance.now() > deadline) fail('Static module inspection exceeded its budget.', undefined, 'LIMIT_EXCEEDED');
                if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)
                    || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) {
                    fail('Native ES module statements are not valid in this SystemJS/CommonJS package.', file);
                }
                if (ts.isCallExpression(node)) {
                    const callee = unwrap(node.expression);
                    const property = member(callee);
                    const system = property && ['System', 'globalThis.System', 'self.System', 'window.System', 'GameGlobal.System'].includes(property.object);
                    const symbol = checker && ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee) : undefined;
                    const local = symbol && bundled.get(symbol);
                    if (local) {
                        const name = moduleId(node.arguments[0]);
                        if (name !== undefined && !local.has(name)) fail('A Browserify require is not present in its bundled dependency mapping.', file);
                    } else if (system && property.property === 'register') {
                        ++registrations;
                        const named = literal(node.arguments[0]);
                        const dependencies = node.arguments[named === undefined ? 0 : 1];
                        let declaration = node.arguments[named === undefined ? 1 : 2];
                        while (declaration && ts.isParenthesizedExpression(declaration)) declaration = declaration.expression;
                        if (named !== undefined && resolve(named, file, false) !== file) fail('Named System registration does not match its import map.', file);
                        if (!dependencies || !ts.isArrayLiteralExpression(dependencies) || !declaration
                            || !(ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration))) fail('Invalid System.register declaration.', file);
                        for (const dependency of dependencies.elements) {
                            const name = literal(dependency);
                            if (name === undefined) fail('System.register requires literal dependencies.', file);
                            edges.add(`${file}\0${resolve(name, file, false)}`);
                        }
                        const context = declaration.parameters[1]?.name;
                        if (context && ts.isIdentifier(context)) contexts.add(context.text);
                    } else if (ts.isIdentifier(callee) && callee.text === 'require') {
                        if (checker) fail('A Browserify require escaped its pinned factory closure.', file);
                        request(node, true, file);
                    }
                    else if ((property && ['globalThis', ...(target === 'BILIBILI' ? [] : ['GameGlobal', 'window', 'self'])].includes(property.object)
                        && property.property !== undefined && hostRequires.includes(property.property))
                        || (ts.isIdentifier(callee) && hostRequires.includes(callee.text))) request(node, true, 'game.js');
                    else if (property?.property === 'import' && (system || contexts.has(property.object))) {
                        if (node.arguments.length !== 1) fail('Explicit System import parent overrides are unsupported.', file);
                        request(node, false, system ? 'game.js' : file);
                    } else if (callee.kind === ts.SyntaxKind.ImportKeyword) request(node, false, file);
                }
                const value = literal(node);
                if (file.startsWith('cocos-js/') && value && /^(?:\.\/)?external\/.*\.(?:wasm|mem|bin|asm\.js)(?:\.br)?$/.test(value)) {
                    const binary = `cocos-js/${value.replace(/^\.\//, '')}`;
                    if (!expected.has(binary)) fail('A fixed engine binary is outside the immutable runtime inventory.', file);
                    read(binary);
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
            if ((file.startsWith('game/') || ['application.js', 'cocos-js/cc.js', 'internal-prerequisites.js'].includes(file)) && registrations !== 1) {
                fail('Expected one compiled System.register module.', file);
            }
            if (file === 'cocos-js/cc.js') {
                try { for (const name of extractRuntimeExports(ts, source)) engineExports.add(name); }
                catch { fail('Unrecognized SDK engine export declaration.', file, 'SDK_INCOMPLETE'); }
            }
        }
        if (new Set(available).size !== available.length || engineExports.size !== available.length || available.some(name => !engineExports.has(name))) {
            fail('SDK export metadata does not match the copied engine.', undefined, 'SDK_INCOMPLETE');
        }
        if (required.some(name => !engineExports.has(name))) fail('A required cc export is absent from this SDK profile.', undefined, 'FEATURE_NOT_IN_PROFILE');
        const metadata = z.object({ requiredCCExports: namesSchema, outputFiles: strings, typeChecked: z.literal(true),
            profileChecked: z.literal(true), emitted: z.literal(true), checkOnly: z.literal(false) }).parse(json('game-compiler.json'));
        if (new Set(metadata.requiredCCExports).size !== metadata.requiredCCExports.length
            || [...metadata.requiredCCExports].sort().join('\0') !== [...required].sort().join('\0')) fail('Fresh compiler export requirements do not match the build request.', 'game-compiler.json');
        const gameFiles = [...files.keys()].filter(file => file.startsWith('game/')).sort();
        const emitted = metadata.outputFiles.map(file => { validateRelativePath(file); return `game/${file}`; }).sort();
        if (gameFiles.join('\0') !== emitted.join('\0')) fail('Game modules do not match the fresh compiler inventory.', 'game-compiler.json');

        const builtins = z.object({ effects: z.array(z.object({ uuid })).max(10000), materials: z.array(z.object({ uuid })).max(10000),
            files: z.array(fileRecord).max(10000) }).parse(json('builtin-report.json'));
        const ids = [...builtins.effects, ...builtins.materials].map(item => item.uuid).sort();
        const config = z.object({ name: z.literal('internal'), importBase: z.string(), nativeBase: z.string(), uuids: z.array(uuid).max(10000), deps: strings }).parse(json('assets/internal/config.json'));
        validateRelativePath(config.importBase); validateRelativePath(config.nativeBase);
        const settings = z.object({ engine: z.object({ builtinAssets: z.array(uuid).max(10000) }),
            assets: z.object({ projectBundles: strings, preloadBundles: strings, preloadAssets: z.array(uuid).max(10000) }),
            scripting: z.object({ scriptPackages: strings }) }).parse(json('settings.json'));
        if (new Set(ids).size !== ids.length || ids.join('\0') !== [...config.uuids].sort().join('\0')
            || ids.join('\0') !== [...settings.engine.builtinAssets].sort().join('\0')) fail('Internal bundle, settings and builtin inventory disagree.');
        for (const record of builtins.files.filter(item => item.path.startsWith('assets/'))) {
            const expectedFile = expected.get(record.path);
            if (!expectedFile || expectedFile.bytes !== record.bytes || expectedFile.sha256 !== record.sha256) fail('Builtin resources do not match the immutable inventory.');
            read(record.path);
        }
        const known = new Set(ids);
        for (const id of ids) {
            const file = `assets/internal/${config.importBase}/${id.slice(0, 2)}/${id}.json`;
            const resource = json(file);
            const references = (value: unknown): void => {
                if (!value || typeof value !== 'object') return;
                if (Array.isArray(value)) { for (const item of value) references(item); return; }
                const object = value as Record<string, unknown>;
                if ('__uuid__' in object && (typeof object.__uuid__ !== 'string' || !known.has(object.__uuid__))) fail('An internal builtin references an absent asset.', file);
                if (typeof object._native === 'string' && object._native) {
                    const native = object._native.startsWith('.') ? `${id}${object._native}` : object._native;
                    read(`assets/internal/${config.nativeBase}/${id.slice(0, 2)}/${native}`);
                }
                for (const child of Object.values(object)) references(child);
            };
            references(resource);
        }
        for (const name of [...config.deps, ...settings.assets.projectBundles, ...settings.assets.preloadBundles]) {
            validateRelativePath(name); read(`assets/${name}/config.json`); read(`assets/${name}/index.js`);
        }
        for (const id of settings.assets.preloadAssets) if (!known.has(id)) fail('Settings preload an asset outside the packaged builtin closure.', 'settings.json');
        for (const name of settings.scripting.scriptPackages) resolve(name, 'game.js', false);

        let preflight: z.infer<typeof preflightSchema>;
        try {
            const result = validate(directory, target);
            if (target !== 'BILIBILI') z.object({ target: z.literal(target) }).parse(result);
            preflight = preflightSchema.parse(result);
        }
        catch { fail(`Canonical ${label} preflight rejected the package configuration, layout or resources. Check ${target === 'BILIBILI' ? 'game.json' : 'game.json, project.config.json'} and packaged files.`); }
        if (preflight.totalBytes !== totalBytes || preflight.packages.reduce((sum, item) => sum + item.bytes, 0) !== totalBytes) {
            fail('Canonical source-package sizes disagree with the pinned inventory.');
        }
        const after = await readGameOutput(directory);
        if (after.size !== files.size || [...files].some(([name, bytes]) => !after.get(name)?.equals(bytes))) fail('Package files changed during validation.', undefined, 'INPUT_CHANGED');
        const inventory = (names: string[]): string => digest(names.sort().map(name => `${name}\0${digest(files.get(name)!)}\n`).join(''));
        const resources = [...files.keys()].filter(file => file.startsWith('assets/') || (file.startsWith('cocos-js/') && !file.endsWith('.js')));
        const resourceBytes = resources.reduce((sum, name) => sum + files.get(name)!.length, 0);
        const items: Report['items'] = [
            { name: `Immutable ${target} runtime`, status: 'passed', message: `${expected.size} manifest-bound SDK files match their byte sizes and SHA-256 hashes.` },
            { name: 'Static module closure', status: 'passed', bytes: scriptBytes,
                message: `${modules.length} scripts parsed by SDK TypeScript 4.9.5; ${edges.size} static module edges; ${required.length} required cc exports.${bundledModules ? ` ${bundledModules} bundled adapter modules; ${bundledEdges} internal dependency mappings.` : ''} Inventory SHA-256: ${inventory(modules)}.` },
            { name: 'Copied resource inventory', status: 'passed', bytes: resourceBytes,
                message: `${resources.length} copied resources; ${ids.length} internal builtins closed over configuration/settings. Inventory SHA-256: ${inventory(resources)}.` },
            { name: `${target} source preflight`, status: 'passed', bytes: preflight.totalBytes,
                message: 'The private canonical validator accepted configuration, package ownership and source sizes. These are not vendor-compiled sizes.' },
            { name: 'Resource loading unverified', status: 'warning', code: 'RESOURCE_LOADING_UNVERIFIED',
                message: 'Copied project assets are inventoried, not interpreted as fixture-specific data. Application resource URLs, including dynamically constructed paths, and resource-loading behavior are not statically proven.' },
            { name: 'Runtime validation unverified', status: 'warning', code: 'RUNTIME_UNVERIFIED',
                message: `${dynamicRuntimeRequests} computed requests in hash-verified SDK scripts retain their SDK host contract. No project code, renderer, browser, vendor compiler or device was executed.` },
        ];
        const text = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128);
        for (const item of preflight.packages.slice(0, 16)) items.push({ name: `Package: ${text(item.name)}`, status: 'info', bytes: item.bytes, message: 'Source bytes only; vendor package size is unverified.' });
        for (const warning of preflight.warnings.slice(0, 16)) items.push({ name: 'Source package warning', status: 'warning', message: text(warning) });
        if (preflight.packages.length > 16 || preflight.warnings.length > 16) items.push({ name: 'Preflight report bound', status: 'warning', code: 'LIMIT_EXCEEDED', message: 'All packages were checked; only the first 16 packages and warnings are listed.' });
        const preflightLevel = { BILIBILI: 'bilibiliSourcePreflight', WECHAT: 'wechatSourcePreflight', BYTEDANCE: 'bytedanceSourcePreflight' }[target];
        return { items, validationLevels: ['staticModuleClosure', preflightLevel, 'copiedResourceInventory'] };
    } catch (error) {
        if (error instanceof AppError) throw error;
        fail(`Invalid or unsupported ${label} package data. No project code was executed.`);
    }
}

export async function validateBilibiliPackage(options: Omit<MiniGamePackageOptions, 'target'>): Promise<{ items: Report['items']; validationLevels: string[] }> {
    return validateMiniGamePackage({ ...options, target: 'BILIBILI' });
}
