const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { assertAbsent, canonicalDirectory, readRegular } = require('./files.cjs');

function failure(code, message, diagnostics = []) {
    return Object.assign(new Error(`${code}: ${message}`), { code, diagnostics: diagnostics.length ? diagnostics
        : [{ code, severity: 'error', message, file: null, line: null, column: null }] });
}

// Only trusted, explicitly selected toolchain code executes. Project inputs are data snapshots.
async function compileGame(input = {}) {
    const reject = (message, file = null, node) => {
        const location = node ? node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()) : null;
        throw failure('UNSUPPORTED_PROJECT', message, [{ code: 'UNSUPPORTED_PROJECT', severity: 'error', message,
            file, line: location ? location.line + 1 : null, column: location ? location.character + 1 : null }]);
    };
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) reject('Invalid compileGame options');
        const { projectDirectory, typesDirectory, outDirectory, toolchainDirectory,
            checkOnly = false, availableCCExports, variant = 'debug' } = input;
        if (typeof projectDirectory !== 'string' || typeof typesDirectory !== 'string' || typeof checkOnly !== 'boolean'
            || (!checkOnly && typeof outDirectory !== 'string') || (outDirectory !== undefined && typeof outDirectory !== 'string')
            || (toolchainDirectory !== undefined && typeof toolchainDirectory !== 'string')
            || !['debug', 'release'].includes(variant)) reject('Invalid compileGame options');
        const release = variant === 'release';
        if (availableCCExports !== undefined && (!Array.isArray(availableCCExports)
            || availableCCExports.some(name => typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name)))) {
            reject('availableCCExports must be a validated runtime export-name array');
        }
        const project = await canonicalDirectory(projectDirectory);
        const sourceRoot = await canonicalDirectory(path.join(project, 'src'));
        const typesRoot = path.resolve(typesDirectory);
        const toolchain = await canonicalDirectory(toolchainDirectory ?? path.resolve(__dirname, '../../..'));
        const relativeTo = (root, file) => {
            const relative = path.relative(root, path.resolve(file));
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
                ? relative.replaceAll('\\', '/') : null;
        };
        const manifest = JSON.parse((await readRegular(toolchain, 'package.json')).toString('utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) reject('Invalid toolchain package.json');
        const toolRequire = createRequire(path.join(toolchain, 'package.json'));
        const packages = new Map();
        const validatePackage = async (name, from = toolchain) => {
            if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) || name === '.' || name === '..') reject('Invalid toolchain dependency name');
            let directory;
            let pkg;
            // Bound Node's ancestor search before invoking its resolver, including transitive/peer dependencies.
            for (let parent = from; relativeTo(toolchain, parent) !== null; parent = path.dirname(parent)) {
                if (path.basename(parent) === 'node_modules') continue;
                const candidate = path.join(parent, 'node_modules', name);
                if (packages.has(candidate)) return packages.get(candidate);
                try {
                    pkg = JSON.parse((await readRegular(toolchain, `${relativeTo(toolchain, candidate)}/package.json`)).toString('utf8'));
                    directory = candidate;
                    break;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (parent === toolchain) break;
            }
            if (!directory) reject(`Missing toolchain dependency within node_modules: ${name}`);
            if (pkg.name !== name) reject(`Toolchain package name mismatch: ${name}`);
            if (pkg.main !== undefined && (typeof pkg.main !== 'string' || /[\\:\0]/.test(pkg.main)
                || !relativeTo(directory, path.resolve(directory, pkg.main)))) reject(`Unsafe toolchain entry: ${name}`);
            const validateFiles = async folder => {
                await canonicalDirectory(folder);
                for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
                    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) reject(`Non-regular toolchain input: ${name}/${entry.name}`);
                    if (entry.isDirectory() && entry.name !== 'node_modules') await validateFiles(path.join(folder, entry.name));
                }
            };
            await validateFiles(directory);
            const result = { directory, manifest: pkg };
            packages.set(directory, result);
            for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).sort()) {
                if (pkg.peerDependenciesMeta?.[dependency]?.optional && !pkg.dependencies?.[dependency]) continue;
                await validatePackage(dependency, directory);
            }
            return result;
        };
        const tools = new Map();
        for (const [name, version] of Object.entries({ typescript: '4.9.5', '@babel/core': '7.19.6',
            '@cocos/babel-preset-cc': '2.2.0', '@babel/plugin-transform-modules-systemjs': '7.22.5' })) {
            const pkg = await validatePackage(name);
            if (pkg.manifest.version !== version) reject(`Expected bundled ${name} ${version}`);
            const entry = path.resolve(pkg.directory, pkg.manifest.main || 'index.js');
            await readRegular(toolchain, relativeTo(toolchain, entry));
            tools.set(name, entry);
        }
        const tsEntry = tools.get('typescript');
        const ts = toolRequire(tsEntry);
        if (ts.version !== '4.9.5') reject('Expected bundled TypeScript 4.9.5');
        const libRoot = path.dirname(tsEntry);
        const fileLabel = file => {
            const projectFile = relativeTo(project, file);
            if (projectFile !== null) return projectFile;
            const typesFile = relativeTo(typesRoot, file);
            if (typesFile !== null) return `types/${typesFile}`;
            const toolFile = relativeTo(toolchain, file);
            return toolFile !== null ? `toolchain/${toolFile}` : null;
        };
        const diagnosticObjects = diagnostics => diagnostics.map(diagnostic => {
            const location = diagnostic.file && diagnostic.start !== undefined
                ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
            return { code: diagnostic.code,
                severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error'
                    : diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info',
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
                file: diagnostic.file ? fileLabel(diagnostic.file.fileName) : null,
                line: location ? location.line + 1 : null, column: location ? location.character + 1 : null };
        });
        let config = {};
        try {
            const configPath = path.join(project, 'tsconfig.json');
            const parsed = ts.parseConfigFileTextToJson(configPath, (await readRegular(project, 'tsconfig.json')).toString('utf8'));
            if (parsed.error) throw failure('UNSUPPORTED_PROJECT', 'Invalid tsconfig.json', diagnosticObjects([parsed.error]));
            config = parsed.config;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!config || Array.isArray(config) || typeof config !== 'object'
            || Object.keys(config).some(key => !['compilerOptions', 'include', '$schema'].includes(key))) reject('Unsupported tsconfig field', 'tsconfig.json');
        if (config.include !== undefined && (!Array.isArray(config.include)
            || config.include.some(pattern => !['src', 'src/**', 'src/**/*', 'src/**/*.ts', 'src/**/*.js'].includes(pattern)))) {
            reject('Only src/ include patterns are supported', 'tsconfig.json');
        }
        const configured = config.compilerOptions === undefined ? {} : config.compilerOptions;
        const allowedOptions = new Set(['target', 'module', 'moduleResolution', 'lib', 'strict', 'noImplicitAny',
            'noEmit', 'experimentalDecorators', 'useDefineForClassFields', 'types', 'baseUrl', 'paths',
            'allowJs', 'checkJs', 'skipLibCheck', 'skipDefaultLibCheck', 'forceConsistentCasingInFileNames',
            'noUnusedLocals', 'noUnusedParameters', 'noImplicitReturns', 'noFallthroughCasesInSwitch',
            'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']);
        if (!configured || typeof configured !== 'object' || Array.isArray(configured)
            || Object.keys(configured).some(key => !allowedOptions.has(key))) reject('Unsupported compilerOptions field', 'tsconfig.json');
        for (const [key, expected] of Object.entries({ strict: true, noEmit: true, experimentalDecorators: true,
            useDefineForClassFields: false, allowJs: true, checkJs: true, skipLibCheck: false, skipDefaultLibCheck: false })) {
            if (key in configured && configured[key] !== expected) reject(`Unsupported compilerOptions.${key}`, 'tsconfig.json');
        }
        if (configured.types !== undefined && (!Array.isArray(configured.types) || configured.types.length)) reject('Project ambient types are not supported', 'tsconfig.json');
        if (configured.baseUrl !== undefined && configured.baseUrl !== '.') reject('Only baseUrl "." is supported', 'tsconfig.json');
        if (configured.paths !== undefined) {
            const cc = configured.paths?.cc;
            if (!configured.paths || Object.keys(configured.paths).length !== 1 || !Array.isArray(cc) || cc.length !== 1
                || typeof cc[0] !== 'string' || (!['types/cc.d.ts', './types/cc.d.ts', '../types/cc.d.ts'].includes(cc[0])
                    && path.resolve(project, cc[0]) !== path.join(typesRoot, 'cc.d.ts'))) {
                reject('Only the compiler-owned cc declaration mapping is supported', 'tsconfig.json');
            }
        }
        const converted = ts.convertCompilerOptionsFromJson({ target: 'ES2017', module: 'ESNext', moduleResolution: 'node',
            lib: ['ES2017', 'DOM'], noImplicitAny: false, ...configured }, project);
        if (converted.errors.length) throw failure('UNSUPPORTED_PROJECT', 'Invalid compiler options', diagnosticObjects(converted.errors));
        if (converted.options.module !== ts.ModuleKind.ESNext || converted.options.moduleResolution !== ts.ModuleResolutionKind.NodeJs) {
            reject('Expected ESNext modules and node module resolution', 'tsconfig.json');
        }
        const options = { ...converted.options, strict: true, noEmit: true, skipLibCheck: false, skipDefaultLibCheck: false,
            allowJs: true, checkJs: true, types: [], typeRoots: [], baseUrl: undefined, paths: undefined,
            experimentalDecorators: true, useDefineForClassFields: false, forceConsistentCasingInFileNames: true };
        const snapshots = new Map();
        const sources = new Map();
        const requiredCCExports = new Set();
        const valueUses = [];
        const walk = async (directory, prefix = '') => {
            await canonicalDirectory(directory);
            for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
                const relative = prefix + entry.name;
                if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
                else {
                    if (!/\.(ts|js)$/.test(relative) || relative.endsWith('.d.ts')) reject('Only ordinary TS/JS source files are supported', `src/${relative}`);
                    sources.set(relative, (await readRegular(sourceRoot, relative)).toString('utf8'));
                }
            }
        };
        await walk(sourceRoot);
        if (!sources.has('main.ts') && !sources.has('main.js')) reject('Expected src/main.ts or src/main.js');
        if (new Set([...sources.keys()].map(file => file.replace(/\.ts$/, '.js'))).size !== sources.size) reject('Colliding TS/JS output paths');
        const resolveSourceImport = (specifier, file, node) => {
            if (specifier === 'cc') return path.join(typesRoot, 'cc.d.ts');
            if (typeof specifier !== 'string' || !/^(\.\/|\.\.\/)/.test(specifier)
                || /[\\:\0?#]/.test(specifier)) reject(`Unsupported import: ${specifier}`, file, node);
            if (!specifier.endsWith('.js')) reject(`Relative module imports must use .js: ${specifier}`, file, node);
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.slice(4)), specifier));
            const target = sources.has(resolved) ? resolved : resolved.replace(/\.js$/, '.ts');
            if (!sources.has(target)) reject(`Import outside source closure: ${specifier}`, file, node);
            return path.join(sourceRoot, target);
        };
        for (const [file, source] of sources) {
            const absolute = path.join(sourceRoot, file);
            const label = `src/${file}`;
            const ast = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
            if (ast.parseDiagnostics.length) {
                const diagnostics = diagnosticObjects(ast.parseDiagnostics);
                throw failure('TYPECHECK_FAILED', diagnostics.map(diagnostic => `TS${diagnostic.code}: ${diagnostic.message}`).join('\n'), diagnostics);
            }
            if (ast.referencedFiles.length || ast.typeReferenceDirectives.length || ast.libReferenceDirectives.length || ast.hasNoDefaultLib) {
                reject('Project triple-slash references are not supported', label);
            }
            if (ast.checkJsDirective?.enabled === false) reject('@ts-nocheck is not supported', label);
            if (ast.commentDirectives?.length) reject('@ts-ignore and @ts-expect-error are not supported', label);
            const use = (name, node) => {
                if (name === 'cclegacy') reject('cclegacy bypasses named runtime profile linkage', label, node);
                requiredCCExports.add(name); valueUses.push({ name, node, file: label });
            };
            const visit = node => {
                if (ts.isImportEqualsDeclaration(node) || ts.isModuleDeclaration(node)
                    || (ts.isExportAssignment(node) && node.isExportEquals)) reject('Import equals, namespaces and ambient modules are not supported', label, node);
                if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
                    if (!ts.isStringLiteral(node.moduleSpecifier)) reject('Expected a literal module specifier', label, node);
                    const specifier = node.moduleSpecifier.text;
                    resolveSourceImport(specifier, label, node);
                    if (specifier === 'cc' && !node.importClause?.isTypeOnly && !node.isTypeOnly) {
                        if (node.importClause?.name) reject('Use named cc imports, not a default import', label, node);
                        const bindings = node.importClause?.namedBindings;
                        if (bindings && !ts.isNamedImports(bindings)) reject('Use named cc imports; namespace profile linkage cannot be validated', label, node);
                        if (bindings) for (const binding of bindings.elements) if (!binding.isTypeOnly) use(binding.propertyName?.text || binding.name.text, binding);
                        if (ts.isExportDeclaration(node)) {
                            if (!node.exportClause || !ts.isNamedExports(node.exportClause)) reject('Use named cc exports', label, node);
                            for (const binding of node.exportClause.elements) if (!binding.isTypeOnly) use(binding.propertyName?.text || binding.name.text, binding);
                        }
                    }
                }
                if (ts.isImportTypeNode(node)) {
                    if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) reject('Expected literal import type', label, node);
                    resolveSourceImport(node.argument.literal.text, label, node);
                }
                if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                    || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) reject('Dynamic imports/require are not supported', label, node);
                if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) reject('import.meta is not supported', label, node);
                ts.forEachChild(node, visit);
            };
            visit(ast);
            snapshots.set(absolute, source);
        }
        if (availableCCExports !== undefined) {
            const available = new Set(availableCCExports);
            const missing = valueUses.filter(use => !available.has(use.name));
            if (missing.length) throw failure('FEATURE_NOT_IN_PROFILE', `Unavailable cc exports: ${[...new Set(missing.map(use => use.name))].join(', ')}`,
                missing.map(({ name, node, file }) => {
                    const location = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
                    return { code: 'FEATURE_NOT_IN_PROFILE', severity: 'error', message: `cc.${name} is not in the selected runtime profile`,
                        file, line: location.line + 1, column: location.character + 1 };
                }));
        }
        await canonicalDirectory(typesRoot);
        const ambientModules = new Set();
        const typeQueue = ['cc.d.ts'];
        for (const file of typeQueue) {
            const absolute = path.join(typesRoot, file);
            if (snapshots.has(absolute)) continue;
            const source = (await readRegular(typesRoot, file)).toString('utf8');
            const ast = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
            if (ast.typeReferenceDirectives.length || ast.hasNoDefaultLib) reject('SDK ambient type directives are not supported', `types/${file}`);
            for (const reference of ast.referencedFiles) {
                if (!/^(\.\/)?[\w./-]+\.d\.ts$/.test(reference.fileName) || reference.fileName.split('/').includes('..')) {
                    reject('SDK declaration reference escapes its closure', `types/${file}`);
                }
                typeQueue.push(path.posix.join(path.posix.dirname(file), reference.fileName));
            }
            const visit = node => {
                if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) ambientModules.add(node.name.text);
                ts.forEachChild(node, visit);
            };
            visit(ast);
            snapshots.set(absolute, source);
        }
        await canonicalDirectory(libRoot);
        for (const name of await fs.readdir(libRoot)) {
            if (/^lib(?:\.[\w.]+)?\.d\.ts$/.test(name)) snapshots.set(path.join(libRoot, name), (await readRegular(libRoot, name)).toString('utf8'));
        }
        const directories = new Set();
        for (const file of snapshots.keys()) {
            for (let directory = path.dirname(file); !directories.has(directory); directory = path.dirname(directory)) {
                directories.add(directory);
                if (path.dirname(directory) === directory) break;
            }
        }
        // No ts.sys delegation: even package.json probes and ambient resolution see only this snapshot.
        const host = {
            getSourceFile: (file, languageVersion) => snapshots.has(path.resolve(file))
                ? ts.createSourceFile(path.resolve(file), snapshots.get(path.resolve(file)), languageVersion, true) : undefined,
            getDefaultLibFileName: opts => path.join(libRoot, ts.getDefaultLibFileName(opts)),
            getDefaultLibLocation: () => libRoot,
            writeFile: () => reject('Unexpected TypeScript emit'),
            getCurrentDirectory: () => project,
            getDirectories: () => [],
            readDirectory: () => [],
            fileExists: file => snapshots.has(path.resolve(file)),
            directoryExists: directory => directories.has(path.resolve(directory)),
            readFile: file => snapshots.get(path.resolve(file)),
            realpath: file => path.resolve(file),
            getCanonicalFileName: file => file,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            resolveModuleNames: (names, importer) => names.map(name => {
                if (relativeTo(sourceRoot, importer) !== null) {
                    const resolvedFileName = resolveSourceImport(name, fileLabel(importer));
                    return { resolvedFileName, extension: resolvedFileName.endsWith('.d.ts') ? ts.Extension.Dts
                        : resolvedFileName.endsWith('.ts') ? ts.Extension.Ts : ts.Extension.Js };
                }
                if (!ambientModules.has(name)) reject(`SDK import outside declaration closure: ${name}`, fileLabel(importer));
                return undefined;
            }),
            resolveTypeReferenceDirectives: names => {
                if (names.length) reject('External type reference resolution is not supported');
                return [];
            },
        };
        const program = ts.createProgram([path.join(typesRoot, 'cc.d.ts'), ...[...sources.keys()].map(file => path.join(sourceRoot, file))], options, host);
        const diagnostics = diagnosticObjects(ts.getPreEmitDiagnostics(program));
        if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
            throw failure('TYPECHECK_FAILED', diagnostics.map(diagnostic => `TS${diagnostic.code}: ${diagnostic.message}`).join('\n'), diagnostics);
        }
        const babelManifest = packages.get(path.join(toolchain, 'node_modules/@babel/core')).manifest;
        const presetManifest = packages.get(path.join(toolchain, 'node_modules/@cocos/babel-preset-cc')).manifest;
        const metadata = { requiredCCExports: [...requiredCCExports].sort(), typeChecked: true,
            profileChecked: availableCCExports !== undefined, checkOnly, emitted: false,
            diagnostics, outputFiles: [], typescript: ts.version, babel: babelManifest.version,
            preset: `@cocos/babel-preset-cc@${presetManifest.version}`, decorators: 'legacy', useDefineForClassFields: false,
            typeChecking: { strict: true, noImplicitAny: options.noImplicitAny, skipLibCheck: false, skipDefaultLibCheck: false, allowJs: true, checkJs: true },
            emission: { variant, sourceMaps: false, minified: release, compact: release, comments: release ? 'license-only' : 'preserve' } };
        if (checkOnly) return metadata;
        const babel = toolRequire(tools.get('@babel/core'));
        const preset = tools.get('@cocos/babel-preset-cc');
        const systemjs = tools.get('@babel/plugin-transform-modules-systemjs');
        const transformed = new Map();
        for (const [file, source] of sources) {
            const transformOptions = {
                filename: path.join(sourceRoot, file), sourceType: 'module', babelrc: false, configFile: false, sourceMaps: false,
                // configFile does not disable Browserslist's separate ancestor discovery.
                browserslistConfigFile: false,
            };
            // Type erasure can append `export {}` on Program exit. Finish the Cocos/TS
            // pass before SystemJS visits the module, including type-only files.
            const intermediate = await babel.transformAsync(source, {
                ...transformOptions, ast: true, code: false,
                presets: [[preset, { allowDeclareFields: true, onlyRemoveTypeImports: true, useDefineForClassFields: false }]],
            });
            if (!intermediate?.ast) reject('Missing transformed game module', `src/${file}`);
            const result = await babel.transformFromAstAsync(intermediate.ast, source, { ...transformOptions, plugins: [systemjs],
                ...(release ? { minified: true, compact: true, comments: false,
                    shouldPrintComment: comment => /@license|@preserve|copyright|permission is hereby granted/i.test(comment) } : {}) });
            if (!result?.code?.includes('System.register(')) reject('Missing SystemJS game module', `src/${file}`);
            transformed.set(file.replace(/\.ts$/, '.js'), result.code);
        }
        const output = path.resolve(outDirectory);
        await canonicalDirectory(path.dirname(output));
        const protectedRoots = [sourceRoot, typesRoot, path.join(toolchain, 'node_modules')];
        if (toolchainDirectory !== undefined) protectedRoots.push(toolchain);
        if (protectedRoots.some(root => relativeTo(root, output) !== null)) reject('Output overlaps compiler inputs');
        await assertAbsent(output);
        await fs.mkdir(output);
        for (const [file, code] of transformed) {
            await fs.mkdir(path.dirname(path.join(output, file)), { recursive: true });
            await fs.writeFile(path.join(output, file), code, { flag: 'wx' });
        }
        return { ...metadata, emitted: true, outputFiles: [...transformed.keys()] };
    } catch (error) {
        if (['UNSUPPORTED_PROJECT', 'FEATURE_NOT_IN_PROFILE', 'TYPECHECK_FAILED'].includes(error.code) && error.diagnostics?.length) throw error;
        throw failure('UNSUPPORTED_PROJECT', error.message);
    }
}

module.exports = { compileGame };
