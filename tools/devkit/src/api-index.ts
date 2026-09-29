import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { Script } from 'node:vm';
import { TextDecoder } from 'node:util';
import type * as TypeScript from 'typescript';
import { z } from 'zod';

export const MAX_API_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_API_SOURCE_BYTES = 16 * 1024 * 1024;
export const documentIdSchema = z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePath = z.string().min(1).max(512).regex(/^[A-Za-z0-9_@.+=,/-]+$/)
    .refine(value => value.split('/').every(part => part && part !== '.' && part !== '..'));
const fileSchema = z.object({ path: sourcePath, bytes: z.number().int().nonnegative().max(128 * 1024 * 1024), sha256: digest }).strict();
const positionSchema = z.object({ offsetBytes: z.number().int().nonnegative(), line: z.number().int().positive(),
    column: z.number().int().positive() }).strict();
export const sourceRangeSchema = z.object({ path: sourcePath, sha256: digest, start: positionSchema, end: positionSchema }).strict();
export const apiIndexDescriptorSchema = fileSchema.extend({ path: z.literal('docs/api-index.json'), schemaVersion: z.literal(1),
    bytes: z.number().int().positive().max(MAX_API_INDEX_BYTES),
    symbols: z.number().int().positive().max(100000), examples: z.number().int().positive().max(1024) }).strict();
const profileKeySchema = z.object({ profile: documentIdSchema, target: documentIdSchema, variant: documentIdSchema }).strict();
export const runtimeAvailabilitySchema = profileKeySchema.extend({ status: z.enum(['export-present', 'export-absent', 'type-only']),
    exportsSha256: digest, engineSha256: digest }).strict();
export const apiMetadataSchema = z.object({ qualifiedName: z.string().min(1).max(1024), symbolKind: z.string().min(1).max(64),
    memberOf: z.string().max(1024).nullable(), typeOnly: z.boolean(), exportName: z.string().max(256).nullable(),
    linkage: z.enum(['export', 'owner-export', 'type-only']), featureRequirements: z.literal('unknown'),
    declarationHashes: z.array(digest).min(1).max(16).optional() }).strict();
export const exampleMetadataSchema = profileKeySchema.extend({ templateId: documentIdSchema, sourcePath,
    sourceSha256: digest, usage: z.literal('template-source'), featureRequirements: z.literal('unknown') }).strict();
const partSchema = z.object({ role: z.enum(['jsdoc', 'signature', 'source']), source: sourceRangeSchema }).strict();
export const apiEntrySchema = z.object({ id: documentIdSchema, kind: z.enum(['api', 'example']), title: z.string().min(1).max(1024),
    api: apiMetadataSchema.nullable(), example: exampleMetadataSchema.nullable(),
    parts: z.array(partSchema).min(1).max(256), sha256: digest, bytes: z.number().int().positive().max(MAX_API_SOURCE_BYTES) }).strict();
export const apiIndexSchema = z.object({ schemaVersion: z.literal(1), generator: z.literal('cc-declaration-ast-v1'),
    parser: fileSchema.extend({ version: z.literal('4.9.5') }).strict(),
    profiles: z.array(profileKeySchema.extend({ declaration: fileSchema, exports: fileSchema, engine: fileSchema }).strict()).min(1).max(16),
    entries: z.array(apiEntrySchema).min(1).max(100000) }).strict();
export type ApiIndex = z.infer<typeof apiIndexSchema>;
export type ApiEntry = z.infer<typeof apiEntrySchema>;
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export type RuntimeAvailability = z.infer<typeof runtimeAvailabilitySchema>;
export interface ApiProfileInput { id: string; target: string; variant: string; directory: string; exports: string; engineEntry: string }
export interface ApiTemplateInput { id: string; profile: string; target: string; variant: string; directory: string }
export interface ApiIndexInput {
    profiles: readonly ApiProfileInput[];
    templates: readonly ApiTemplateInput[];
    files: readonly z.infer<typeof fileSchema>[];
    read: (path: string, maximum: number) => Promise<Buffer>;
}
export interface IndexedDocument { entry: ApiEntry; text: string; anchors: { documentOffsetBytes: number; lengthBytes: number;
    role: 'jsdoc' | 'signature' | 'source'; source: SourceRange }[]; availability: RuntimeAvailability[] }

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function fail(): never { throw new Error('Invalid declaration API index or source binding'); }
// This is the executable parser, not an API allowlist. A rehashed SDK cannot replace
// it with arbitrary code. Update this pin only when reviewing a compiler upgrade.
const parserPath = 'toolchain/node_modules/typescript/lib/typescript.js';
const parserHash = '2e78d8d8d3b631646830e478dbee1ca109474840fe5ed7ca6c5b418f2e20b1a2';
let parser: typeof TypeScript | undefined;
function lockedParser(bytes: Buffer): typeof TypeScript {
    if (hash(bytes) !== parserHash) fail();
    if (!parser) {
        const module = { exports: {} };
        const require = createRequire(import.meta.url);
        const builtin = (name: string): unknown => { if (!isBuiltin(name)) fail(); return require(name); };
        new Script(`(function(exports, require, module, __filename, __dirname) {${decode(bytes)}\n})`, { filename: parserPath })
            .runInThisContext()(module.exports, builtin, module, parserPath, 'toolchain/node_modules/typescript/lib');
        parser = module.exports as typeof TypeScript;
        if (parser.version !== '4.9.5') fail();
    }
    return parser;
}

/** Pure static inspection; neither the System.register callback nor game sources execute. */
export function extractRuntimeExports(ts: typeof TypeScript, text: string, expectedGlobals?: Readonly<Record<string, boolean>>): string[] {
    const ast = ts.createSourceFile('cc.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if ((ast as TypeScript.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length) fail();
    const program = ts.createProgram(['cc.js'], { allowJs: true, noLib: true, noResolve: true, types: [] }, {
        getSourceFile: name => name === 'cc.js' ? ast : undefined, getDefaultLibFileName: () => '',
        writeFile: fail, getCurrentDirectory: () => '', getDirectories: () => [],
        fileExists: name => name === 'cc.js', readFile: name => name === 'cc.js' ? text : undefined,
        getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    });
    const checker = program.getTypeChecker();
    const unwrap = (node: TypeScript.Expression | undefined): TypeScript.Expression | undefined => {
        while (node && ts.isParenthesizedExpression(node)) node = node.expression;
        return node;
    };
    const registers: TypeScript.CallExpression[] = [];
    const registrations = (node: TypeScript.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 'System.register') registers.push(node);
        ts.forEachChild(node, registrations);
    };
    registrations(ast);
    if (registers.length !== 1) fail();
    const factory = unwrap(registers[0].arguments[1]);
    if (!factory || !(ts.isFunctionExpression(factory) || ts.isArrowFunction(factory))) fail();
    const parameter = factory.parameters[0]?.name;
    if (!parameter || !ts.isIdentifier(parameter)) fail();
    const exported = checker.getSymbolAtLocation(parameter);
    if (!exported) fail();
    const names = new Set<string>();
    const globals = new Map<string, boolean>();
    const visit = (node: TypeScript.Node): void => {
        // Minifiers rename the callback, and nested code can shadow it. Compare
        // lexical symbols, not a magic identifier or declarations-only API list.
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression) === exported) {
            const argument = node.arguments[0];
            if (argument && ts.isStringLiteral(argument)) names.add(argument.text);
            else {
                if (!argument || !ts.isObjectLiteralExpression(argument)) fail();
                for (const property of argument.properties) {
                    if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
                        || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) fail();
                    names.add(property.name.text);
                }
            }
        }
        if (expectedGlobals && ts.isCallExpression(node)) {
            const name = node.arguments[0];
            if (name && ts.isStringLiteral(name) && Object.hasOwn(expectedGlobals, name.text)) {
                const value = unwrap(node.arguments[1]);
                const actual = value?.kind === ts.SyntaxKind.TrueKeyword ? true : value?.kind === ts.SyntaxKind.FalseKeyword ? false
                    : value && ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken
                        && ts.isNumericLiteral(value.operand) ? !Number(value.operand.text) : undefined;
                if (globals.has(name.text) || actual !== expectedGlobals[name.text]) fail();
                globals.set(name.text, actual);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!names.size || (expectedGlobals && globals.size !== Object.keys(expectedGlobals).length)) fail();
    return [...names].sort();
}

/** Derive the complete index again at load time, not just its outer checksum. */
export async function generateApiIndex(input: ApiIndexInput): Promise<{ index: ApiIndex; documents: IndexedDocument[] }> {
    const inventory = new Map(input.files.map(file => [file.path, file]));
    if (inventory.size !== input.files.length || !input.profiles.length) fail();
    const sources = new Map<string, Buffer>();
    const read = async (name: string, max = MAX_API_SOURCE_BYTES): Promise<Buffer> => {
        const file = inventory.get(name);
        if (!file || file.bytes > max) fail();
        const bytes = sources.get(name) ?? await input.read(name, max);
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail();
        sources.set(name, bytes);
        return bytes;
    };
    const ts = lockedParser(await read(parserPath));
    const bindings: ApiIndex['profiles'] = [];
    const exportNames = new Map<string, Set<string>>();
    const sortedProfiles = [...input.profiles].sort((a, b) => `${a.target}/${a.id}/${a.variant}`.localeCompare(`${b.target}/${b.id}/${b.variant}`, 'en'));
    for (const profile of sortedProfiles) {
        const declaration = `${profile.directory}/types/cc.d.ts`;
        if (!profile.engineEntry.startsWith('./') || !sourcePath.safeParse(profile.engineEntry.slice(2)).success) fail();
        const engine = `${profile.directory}/${profile.engineEntry.slice(2)}`;
        await read(declaration);
        const engineBytes = await read(engine, 128 * 1024 * 1024);
        const names = extractRuntimeExports(ts, decode(engineBytes), { CC_DEBUG: profile.variant === 'debug', CC_BUILD: true,
            CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false, CC_BILIBILI: profile.target === 'BILIBILI', CC_MINIGAME: profile.target === 'BILIBILI' });
        const exports = JSON.parse(decode(await read(profile.exports))) as { engineSha256?: string; names?: string[] };
        if (exports.engineSha256 !== hash(engineBytes) || JSON.stringify(exports.names) !== JSON.stringify(names)) fail();
        exportNames.set(profile.exports, new Set(names));
        bindings.push({ profile: profile.id, target: profile.target, variant: profile.variant,
            declaration: inventory.get(declaration)!, exports: inventory.get(profile.exports)!, engine: inventory.get(engine)! });
        sources.delete(engine);
        sources.delete(profile.exports);
    }
    const declarationSources = [...new Map(bindings.map(binding => [binding.declaration.sha256,
        bindings.find(first => first.declaration.sha256 === binding.declaration.sha256)!.declaration])).values()];
    const entries: ApiEntry[] = [];
    const documents: IndexedDocument[] = [];
    const variants = new Map<string, IndexedDocument>();
    const ids = new Set<string>();
    let documentBytes = 0;
    for (const declaration of declarationSources) {
        const applicableBindings = bindings.filter(binding => binding.declaration.sha256 === declaration.sha256);
        const text = decode(sources.get(declaration.path)!);
        const ast = ts.createSourceFile('cc.d.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const host: TypeScript.CompilerHost = {
            getSourceFile: name => name === 'cc.d.ts' ? ast : undefined,
            getDefaultLibFileName: () => '', writeFile: () => fail(), getCurrentDirectory: () => '', getDirectories: () => [],
            fileExists: name => name === 'cc.d.ts', readFile: name => name === 'cc.d.ts' ? text : undefined,
            getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n'
        };
        const program = ts.createProgram(['cc.d.ts'], { noLib: true, noResolve: true }, host);
        if (program.getSyntacticDiagnostics(ast).length) fail();
        const checker = program.getTypeChecker();
        const module = ast.statements.find(node => ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text === 'cc');
        if (!module || !ts.isModuleDeclaration(module)) fail();
        const root = checker.getSymbolAtLocation(module.name);
        if (!root) fail();
        // UTF-8 offsets are calculated once rather than repeatedly encoding megabytes
        // before every member. Columns count Unicode code points, not UTF-16 units.
        const byteOffsets = new Uint32Array(text.length + 1);
        let byteOffset = 0;
        for (let i = 0; i < text.length;) {
            const point = text.codePointAt(i)!;
            byteOffsets[i] = byteOffset;
            const length = point > 0xffff ? 2 : 1;
            if (length === 2) byteOffsets[i + 1] = byteOffset;
            byteOffset += Buffer.byteLength(String.fromCodePoint(point));
            i += length;
            byteOffsets[i] = byteOffset;
        }
        const position = (offset: number): z.infer<typeof positionSchema> => {
            const { line } = ast.getLineAndCharacterOfPosition(offset);
            return {
                offsetBytes: byteOffsets[offset], line: line + 1,
                column: [...text.slice(ast.getPositionOfLineAndCharacter(line, 0), offset)].length + 1
            };
        };
        const range = (start: number, end: number): SourceRange => ({
            path: declaration.path, sha256: declaration.sha256,
            start: position(start), end: position(end)
        });
        const add = (entry: Omit<ApiEntry, 'sha256' | 'bytes'>): void => {
            let content = '';
            const anchors: IndexedDocument['anchors'] = [];
            for (const part of entry.parts) {
                const bytes = sources.get(part.source.path)!;
                const slice = bytes.subarray(part.source.start.offsetBytes, part.source.end.offsetBytes);
                if (content) content += '\n';
                anchors.push({ documentOffsetBytes: Buffer.byteLength(content), lengthBytes: slice.length, ...part });
                content += decode(slice);
            }
            const availability = entry.api ? applicableBindings.map(binding => ({
                profile: binding.profile, target: binding.target, variant: binding.variant,
                status: entry.api!.typeOnly ? 'type-only' as const : exportNames.get(binding.exports.path)!.has(entry.api!.exportName!)
                    ? 'export-present' as const : 'export-absent' as const,
                exportsSha256: binding.exports.sha256, engineSha256: binding.engine.sha256
            })) : [];
            const key = `${entry.id}:${hash(content)}:${hash(JSON.stringify({ ...entry.api, declarationHashes: undefined }))}`;
            const existing = variants.get(key);
            if (existing) {
                existing.entry.api!.declarationHashes!.push(declaration.sha256);
                existing.availability.push(...availability);
                return;
            }
            // Different declarations can share a public name without sharing a source
            // signature. Never normalize generated private names or fabricate positions.
            if (ids.has(entry.id)) entry = { ...entry, id: `api-${hash(key)}` };
            const full = { ...entry, sha256: hash(content), bytes: Buffer.byteLength(content) };
            documentBytes += full.bytes;
            if (documentBytes > MAX_API_INDEX_BYTES) fail();
            const document = { entry: full, text: content, anchors, availability };
            entries.push(full);
            documents.push(document);
            variants.set(key, document);
            ids.add(full.id);
            if (entries.length > 100000) fail();
        };
        const visible = (node: TypeScript.Declaration): boolean => {
            const flags = ts.getCombinedModifierFlags(node);
            return !(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected))
                && !ts.getJSDocTags(node).some(tag => ['internal', 'private', 'protected'].includes(tag.tagName.text))
                && !('name' in node && node.name && ts.isPrivateIdentifier(node.name as TypeScript.Node));
        };
        const nameOf = (symbol: TypeScript.Symbol): string => {
            const name = (symbol.declarations?.[0] as TypeScript.NamedDeclaration | undefined)?.name;
            // TypeScript's internal computed-symbol names contain process-local IDs.
            return name && ts.isComputedPropertyName(name) ? name.getText(ast)
                : symbol.getName() === '__constructor' ? 'constructor' : symbol.getName();
        };
        const visit = (symbol: TypeScript.Symbol, qualifiedName: string, exportName: string, memberOf: string | null,
            role: string, parentTypeOnly: boolean, ancestors: Set<TypeScript.Symbol>): void => {
            const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
            if (ancestors.has(resolved)) return;
            const declarations = [...new Set([...(symbol.declarations ?? []), ...(resolved.declarations ?? [])])]
                .filter(node => node.getSourceFile() === ast && visible(node));
            if (!declarations.length) return;
            const typeOnly = parentTypeOnly || !(resolved.flags & ts.SymbolFlags.Value)
                || declarations.some(node => ts.isTypeOnlyImportOrExportDeclaration(node))
                || declarations.some(node => ts.isEnumDeclaration(node) && !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Const));
            const parts: ApiEntry['parts'] = [];
            for (const node of declarations) {
                const owner = ts.isVariableDeclaration(node) ? node.parent.parent : node;
                const docs = (owner as TypeScript.Node & { jsDoc?: TypeScript.JSDoc[] }).jsDoc ?? [];
                for (const doc of docs) parts.push({ role: 'jsdoc', source: range(doc.getStart(ast), doc.end) });
                let end = node.end;
                if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) end = node.members.pos;
                else if (ts.isModuleDeclaration(node) && node.body) end = node.body.getStart(ast);
                parts.push({ role: 'signature', source: range(node.getStart(ast), end) });
            }
            const kind = declarations.find(node => !ts.isImportEqualsDeclaration(node) && !ts.isExportSpecifier(node)) ?? declarations[0];
            add({
                id: `api-${hash(`${qualifiedName}:${role}`)}`, kind: 'api', title: qualifiedName,
                api: {
                    qualifiedName, symbolKind: ts.SyntaxKind[kind.kind], memberOf, typeOnly, exportName: typeOnly ? null : exportName,
                    linkage: typeOnly ? 'type-only' : memberOf ? 'owner-export' : 'export', featureRequirements: 'unknown',
                    ...(declarationSources.length > 1 ? { declarationHashes: [declaration.sha256] } : {})
                }, example: null, parts
            });
            const next = new Set(ancestors).add(resolved);
            if (resolved.flags & ts.SymbolFlags.Module) {
                for (const child of checker.getExportsOfModule(resolved)) {
                    visit(child, `${qualifiedName}.${nameOf(child)}`, exportName, qualifiedName, 'namespace', typeOnly, next);
                }
            }
            // Declared members only. Inherited members remain discoverable on their
            // declaring base; signatures retain the real extends/implements clauses.
            const members = new Map<string, TypeScript.Symbol>();
            for (const node of resolved.declarations ?? []) {
                let children: readonly TypeScript.Node[] = [];
                if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) children = node.members;
                else if ((ts.isTypeAliasDeclaration(node) || ts.isVariableDeclaration(node)) && node.type && ts.isTypeLiteralNode(node.type)) children = node.type.members;
                for (const child of children) {
                    const name = (child as TypeScript.NamedDeclaration).name;
                    const childSymbol = name ? checker.getSymbolAtLocation(name) : (child as TypeScript.Node & { symbol?: TypeScript.Symbol }).symbol;
                    if (childSymbol) members.set(`${ts.getCombinedModifierFlags(child as TypeScript.Declaration) & ts.ModifierFlags.Static ? 'static' : 'instance'}:${childSymbol.getName()}`, childSymbol);
                }
            }
            for (const [key, child] of members) visit(child, `${qualifiedName}.${nameOf(child)}`, exportName, qualifiedName, key.split(':')[0], typeOnly, next);
        };
        for (const symbol of checker.getExportsOfModule(root)) {
            // tfig's synthetic implementation namespace is not a public API surface.
            if (symbol.getName() !== '__private') visit(symbol, `cc.${symbol.getName()}`, symbol.getName(), null, 'export', false, new Set());
        }
    }
    for (const template of [...input.templates].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
        for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
            if (!file.path.startsWith(`${template.directory}/`) || !/\.(?:ts|js)$/.test(file.path) || file.path.endsWith('.d.ts')) continue;
            const bytes = await read(file.path);
            if (!bytes.length) continue;
            const source = decode(bytes);
            const lines = source.split('\n');
            const entry: ApiEntry = { id: `example-${hash(`${template.id}:${file.path.slice(template.directory.length + 1)}`)}`, kind: 'example',
                title: `${template.id}/${file.path.slice(template.directory.length + 1)}`, api: null,
                example: { templateId: template.id, profile: template.profile, target: template.target, variant: template.variant,
                    sourcePath: file.path, sourceSha256: file.sha256, usage: 'template-source', featureRequirements: 'unknown' },
                parts: [{ role: 'source', source: { path: file.path, sha256: file.sha256,
                    start: { offsetBytes: 0, line: 1, column: 1 }, end: { offsetBytes: bytes.length, line: lines.length, column: [...lines.at(-1)!].length + 1 } } }],
                sha256: file.sha256, bytes: file.bytes };
            entries.push(entry);
            documents.push({ entry, text: source, availability: [], anchors: [{ ...entry.parts[0], documentOffsetBytes: 0, lengthBytes: file.bytes }] });
            documentBytes += file.bytes;
            if (documentBytes > MAX_API_INDEX_BYTES) fail();
        }
    }
    entries.sort((a, b) => a.id < b.id ? -1 : 1);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length || !entries.some(entry => entry.kind === 'example')) fail();
    const index = apiIndexSchema.parse({ schemaVersion: 1, generator: 'cc-declaration-ast-v1', parser: { ...inventory.get(parserPath)!, version: ts.version },
        profiles: bindings, entries });
    if (Buffer.byteLength(JSON.stringify(index)) > MAX_API_INDEX_BYTES) fail();
    return { index, documents: documents.sort((a, b) => a.entry.id < b.entry.id ? -1 : 1) };
}
