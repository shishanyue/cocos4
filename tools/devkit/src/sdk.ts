import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { AppError } from './contracts.js';

const KiB = 1024;
const MAX_MANIFEST = 256 * KiB;
const MAX_TOTAL = 2 * 1024 * KiB;
const MAX_GAME_MANIFEST = 8 * 1024 * KiB;
const MAX_GAME_TOTAL = 512 * 1024 * KiB;
const MAX_DOCUMENT = 16 * KiB;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sdkIdSchema = z.string().regex(/^sha256-[a-f0-9]{64}$/);
const version = z.string().min(1).max(128);
const cursorSchema = z.string().min(1).max(1024);
const sectionSchema = z.enum(['sdk', 'platforms', 'features', 'profiles', 'templates']);
const kindSchema = z.enum(['api', 'guide', 'example', 'all']);
const sourcePathSchema = z.enum([
    'package.json', 'cc.config.json', 'scripts/validate-bilibili.cjs', 'LICENSE',
    'README.md', 'AGENTS.md', 'docs/bilibili_minigame/README.md', 'docs/plans/cocos4-mcp-devkit.md',
]);
const filePathSchema = z.string().max(160).regex(/^(?:LICENSE|app\/validate-bilibili\.cjs|docs\/[a-z0-9-]+\.md)$/);
const fileSchema = z.object({ path: filePathSchema, bytes: z.number().int().positive().max(32 * KiB), sha256: digest }).strict();
export const sdkPathSchema = z.string().min(1).max(512).refine(value => value.split('/').every(part =>
    /^[A-Za-z0-9_@.+=,-]+$/.test(part) && part !== '.' && part !== '..' && !part.endsWith('.')
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)));
export const inventoryFileSchema = z.object({ path: sdkPathSchema,
    bytes: z.number().int().nonnegative().max(128 * 1024 * KiB), sha256: digest }).strict();
const sourceFileSchema = z.object({ path: sourcePathSchema, bytes: z.number().int().positive().max(1024 * KiB), sha256: digest }).strict();
const capabilitiesSchema = z.object({
    catalog: z.literal(true), docs: z.literal(true), packageValidation: z.tuple([z.literal('BILIBILI')]),
    gameDevelopment: z.boolean(), gameBuild: z.boolean(), preview: z.boolean(), export: z.boolean(),
}).strict();
const platformSchema = z.object({
    id, engineTargetAllowed: z.literal(true), prebuiltAvailable: z.boolean(), exportAvailable: z.boolean(),
    validationLevels: z.array(id).max(16),
}).strict();
const featureSchema = z.object({
    id, modules: z.array(id).max(128), dependentModules: z.array(id).max(128),
    dependentAssets: z.array(id).max(128), prebuiltAvailable: z.boolean(),
}).strict();

const validationLevels = ['engineTypecheck', 'engineBuild', 'builtinIntegrity', 'gameTypecheck', 'loaderTypecheck',
    'browserFirstFrame', 'browserInteraction'] as const;
const profileSchema = z.object({
    id, target: z.literal('HTML5'), variant: z.literal('debug'), directory: sdkPathSchema,
    descriptor: sdkPathSchema, browserReport: sdkPathSchema, exports: sdkPathSchema,
    features: z.array(id).min(1).max(128), delivery: z.literal('PREBUILT'), validationLevels: z.array(id).max(16),
}).strict();
const templateSchema = z.object({ id, directory: sdkPathSchema, profile: id, target: z.literal('HTML5'), variant: z.literal('debug') }).strict();
const developmentSchema = z.object({
    baseSdkId: sdkIdSchema, baseManifest: z.literal('provenance/readonly-manifest.json'),
    directory: z.literal('toolchain'), compiler: z.literal('toolchain/compiler/compile-game.cjs'),
    dependencies: z.literal('toolchain/compiler-dependencies.json'), inventory: z.literal('toolchain/inventory.json'),
    sourceLock: z.literal('toolchain/source-lock.json'),
    sourceFiles: z.array(inventoryFileSchema.extend({ sourcePath: sdkPathSchema }).strict()).length(2),
    licenseReview: z.literal('required'), missingLicenseFiles: z.array(sdkPathSchema).max(256),
    node: z.object({ bundled: z.literal(false), minimum: z.literal('18.20.8') }).strict(),
}).strict();
const docEntrySchema = z.object({
    id: z.string().regex(/^guide-[a-z0-9-]{1,100}$/), kind: z.literal('guide'), title: z.string().min(1).max(256),
    path: filePathSchema, sourcePath: sourcePathSchema, sourceOffset: z.number().int().nonnegative().max(1024 * KiB),
}).strict();

// files covers every payload file; sdkId hashes the canonical manifest without sdkId,
// avoiding a self-referential manifest hash. These are integrity checks, not signatures.
export const manifestSchema = z.object({
    schemaVersion: z.literal(1), sdkId: sdkIdSchema, kind: z.enum(['readonly-development', 'portable-development']), engineVersion: version,
    description: z.string().min(1).max(1024), capabilities: capabilitiesSchema,
    source: z.object({ sha256: digest, files: z.array(sourceFileSchema).length(8), attribution: z.string().min(1).max(1024) }).strict(),
    license: z.object({ path: z.literal('LICENSE'), spdx: z.literal('MIT') }).strict(),
    files: z.array(inventoryFileSchema).min(3).max(20000),
    catalog: z.object({
        platforms: z.array(platformSchema).min(1).max(128), features: z.array(featureSchema).min(1).max(256),
        profiles: z.array(profileSchema).max(16), templates: z.array(templateSchema).max(16),
    }).strict(),
    docs: z.array(docEntrySchema).min(4).max(96),
    development: developmentSchema.optional(),
}).strict().superRefine((manifest, context) => {
    const game = manifest.kind === 'portable-development';
    if (['gameDevelopment', 'gameBuild', 'preview', 'export'].some(key => manifest.capabilities[key as 'gameBuild'] !== game)
        || game !== !!manifest.development || (!game && (manifest.files.length > 128
            || manifest.files.some(file => !fileSchema.safeParse(file).success)
            || manifest.catalog.profiles.length || manifest.catalog.templates.length
            || manifest.catalog.platforms.some(item => item.prebuiltAvailable || item.exportAvailable || item.validationLevels.length)
            || manifest.catalog.features.some(item => item.prebuiltAvailable)))
        || (game && (!['2d-basic', '3d-basic'].every(id => manifest.catalog.profiles.some(item => item.id === id))
            || !manifest.catalog.templates.length))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Capabilities require complete delivered profiles, templates and toolchain.' });
    }
});

const sdkSummarySchema = z.object({
    sdkId: sdkIdSchema, schemaVersion: z.literal(1), kind: z.enum(['readonly-development', 'portable-development']), engineVersion: version,
    description: z.string().max(1024), capabilities: capabilitiesSchema, sourceSha256: digest,
    attribution: z.string().max(1024), fileCount: z.number().int().positive(), documentCount: z.number().int().positive(),
}).strict();
export const catalogSchema = z.object({
    section: sectionSchema, target: id.nullable(), available: z.boolean(), reason: z.string().max(1024).nullable(),
    items: z.array(z.union([sdkSummarySchema, platformSchema, featureSchema, profileSchema, templateSchema])).max(100), nextCursor: cursorSchema.nullable(),
}).strict();
export const searchSchema = z.object({
    query: z.string().min(1).max(256), kind: kindSchema, profile: id.nullable(), availableKinds: z.tuple([z.literal('guide')]),
    items: z.array(z.object({
        documentId: id, kind: z.literal('guide'), title: z.string().max(256), engineVersion: version,
        summary: z.string().max(512), matches: z.array(z.object({
            line: z.number().int().positive(), column: z.number().int().positive(),
        }).strict()).max(1), requiredFeatures: z.array(id).max(0),
    }).strict()).max(100), nextCursor: cursorSchema.nullable(),
}).strict();
export const documentSchema = z.object({
    documentId: id, kind: z.literal('guide'), title: z.string().max(256), engineVersion: version,
    content: z.string().max(MAX_DOCUMENT), offsetBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive().max(MAX_DOCUMENT), sha256: digest, nextCursor: cursorSchema.nullable(),
}).strict();

type DeepReadonly<T> = T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
export type Manifest = DeepReadonly<z.infer<typeof manifestSchema>>;
export type SdkProfile = DeepReadonly<z.infer<typeof runtimeDescriptorSchema>> & {
    readonly directory: string;
    readonly descriptor: DeepReadonly<z.infer<typeof runtimeDescriptorSchema>>;
    readonly ccExports: readonly string[];
    readonly typesDirectory: string;
};
export type SdkTemplate = DeepReadonly<z.infer<typeof templateSchema>>;
export interface Sdk {
    readonly sdkId: string;
    readonly root: string;
    readonly manifest: Manifest;
    readonly toolchainRoot: string | null;
    profile(target: string, profile: string, variant: string): SdkProfile;
    template(id: string): SdkTemplate;
    catalog(input: { section: 'sdk' | 'platforms' | 'features' | 'profiles' | 'templates'; target?: string; cursor?: string; limit?: number }): z.infer<typeof catalogSchema>;
    search(input: { query: string; kind: 'api' | 'guide' | 'example' | 'all'; profile?: string; cursor?: string; limit?: number }): z.infer<typeof searchSchema>;
    read(input: { documentId: string; cursor?: string; maxBytes?: number }): z.infer<typeof documentSchema>;
    resources(): { uri: string; name: string; mimeType: string; description?: string }[];
    resource(uri: string): string;
}

export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function freeze<T>(value: T): DeepReadonly<T> {
    if (value !== null && typeof value === 'object') {
        for (const entry of Object.values(value)) freeze(entry);
        Object.freeze(value);
    }
    return value as DeepReadonly<T>;
}
function invalidPack(detail = ''): never {
    throw new AppError('SDK_INCOMPLETE', `The SDK pack is invalid, incomplete, changed, or exceeds its bounds.${detail ? ` ${detail}` : ''}`,
        ['Prepare a new pack from trusted sources and verify its separately distributed provenance.']);
}
export function parseJson(text: string): unknown {
    const value: unknown = JSON.parse(text);
    const stack: (Set<string> | null)[] = [];
    // JSON.parse discards duplicate keys. Scan validated JSON tokens as well so even
    // differently escaped spellings of the same property are rejected.
    for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
        const word = token[0];
        if (word === '{' || word === '[') {
            stack.push(word === '{' ? new Set() : null);
            if (stack.length > 32) invalidPack();
        } else if (word === '}' || word === ']') stack.pop();
        else {
            let end = token.index! + word.length;
            while (/\s/.test(text[end] ?? '') && end < text.length) ++end;
            if (text[end] === ':') {
                const keys = stack[stack.length - 1];
                const key = JSON.parse(word) as string;
                if (!keys || keys.has(key)) invalidPack();
                keys.add(key);
            }
        }
    }
    return value;
}
function fits(value: unknown): boolean {
    // Reserve 16 KiB for the server envelope/diagnostics. Include the doubly
    // serialized text copy, which is larger than twice the document's byte size.
    return Buffer.byteLength(JSON.stringify({ structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }] })) <= 48 * KiB;
}
function bytePrefix(text: string, maxBytes: number): string {
    const bytes = Buffer.from(text);
    let end = Math.min(maxBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) --end;
    return bytes.subarray(0, end).toString('utf8');
}
function input<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AppError('INVALID_ARGUMENTS', 'Invalid readonly SDK query arguments.');
    return parsed.data;
}

const ccExport = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).max(256);
export const runtimeDescriptorSchema = z.object({
    schemaVersion: z.literal(1), kind: z.literal('cocos4-html5-runtime'), profile: id,
    target: z.literal('HTML5'), mode: z.literal('BUILD'), variant: z.literal('debug'),
    moduleFormat: z.literal('system'), sourceMap: z.literal(false), compressed: z.literal(false),
    features: z.array(id).min(1).max(128), constants: z.record(z.union([z.boolean(), z.number()])),
    engineVersion: version, rootLockSha256: digest, delivery: z.literal('PREBUILT'),
    entry: z.literal('index.html'), engineEntry: z.literal('./engine/cc.js'),
    types: z.literal('types/cc.d.ts'), typeFiles: z.array(sdkPathSchema).length(3), template: z.literal('template'),
    tools: z.object({ typeChecked: z.literal(true), requiredCCExports: z.array(ccExport).min(1).max(4096),
        typescript: z.literal('4.9.5'), babel: z.literal('7.19.6'), preset: z.literal('@cocos/babel-preset-cc@2.2.0'),
        typeChecking: z.object({ strict: z.literal(true), skipLibCheck: z.literal(false), skipDefaultLibCheck: z.literal(false) }).passthrough(),
    }).passthrough(),
    builtins: z.object({ report: z.literal('builtin-report.json'), reportSha256: digest,
        effects: z.array(z.unknown()).min(1), materials: z.array(z.unknown()).min(1) }).passthrough(),
    gameCompiler: z.object({ dependencies: z.literal('compiler-dependencies.json'), dependencyCount: z.number().int().positive().max(256),
        entry: z.literal('tools/devkit/runtime/compile-game.cjs'), export: z.literal('compileGame'),
        sourceFiles: z.array(sdkPathSchema).length(2), requiresEngineCheckout: z.boolean() }).passthrough(),
    validationLevels: z.record(z.boolean()), files: z.array(inventoryFileSchema).min(20).max(10000),
}).passthrough();
export const browserReportSchema = z.object({
    schemaVersion: z.literal(1), profile: id, runtimeSha256: digest, success: z.literal(true),
    browser: version, graphics: z.object({ version: version, renderer: z.string().min(1).max(1024) }).passthrough(),
    pageErrors: z.array(z.never()).max(0),
    validation: z.object({ firstFrame: z.literal(true), mouse: z.literal(true), touch: z.literal(true),
        restarts: z.number().int().min(10), webAudio: z.literal(true), missingAsset: z.literal(true),
        mobileLayout: z.literal(true), mobileTouch: z.literal(true) }).passthrough(),
    screenshots: z.array(z.object({ path: sdkPathSchema, sha256: digest,
        width: z.number().int().positive(), height: z.number().int().positive() }).passthrough()).min(4).max(16),
    initial: z.object({ ready: z.literal(true), classRegistered: z.literal(true), imageLoaded: z.literal(true),
        jsonLoaded: z.literal(true), audioLoaded: z.literal(true), world3d: z.boolean(), error: z.literal('') }).passthrough(),
}).passthrough();
const exportInventorySchema = z.object({ engineSha256: digest, names: z.array(ccExport).min(1).max(4096) }).strict();
const packageName = z.string().regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/).max(214);
const packagePath = sdkPathSchema.refine(value => /^(?:node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/.test(value));
export const compilerClosureSchema = z.object({ schemaVersion: z.literal(1), rootLockSha256: digest,
    roots: z.record(packageName, packagePath), packages: z.array(z.object({ path: packagePath, name: packageName,
        version, integrity: z.string().regex(/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/), resolved: z.string().url(),
        license: z.string().min(1).max(256), packageSha256: digest, dependencies: z.record(packageName, packagePath),
    }).strict()).min(4).max(256),
}).strict();
const packageJsonSchema = z.object({ name: packageName, version, main: z.string().optional(),
    dependencies: z.record(packageName, z.string()).optional(), peerDependencies: z.record(packageName, z.string()).optional(),
    peerDependenciesMeta: z.record(z.object({ optional: z.boolean().optional() }).passthrough()).optional(),
}).passthrough();
const compilerRoots = { typescript: '4.9.5', '@babel/core': '7.19.6', '@cocos/babel-preset-cc': '2.2.0',
    '@babel/plugin-transform-modules-systemjs': '7.22.5' };

export function validateCompilerClosure(value: unknown, lockBytes: Buffer, packageBytes: Map<string, Buffer>, inventory: readonly z.infer<typeof inventoryFileSchema>[]): void {
    const closure = compilerClosureSchema.parse(value);
    const lock = z.object({ packages: z.record(z.object({ version: z.string().optional(), integrity: z.string().optional(),
        resolved: z.string().optional() }).passthrough()) }).passthrough().parse(parseJson(lockBytes.toString('utf8')));
    if (hash(lockBytes) !== closure.rootLockSha256 || canonical(Object.keys(closure.roots).sort()) !== canonical(Object.keys(compilerRoots).sort())) invalidPack();
    const packages = new Map(closure.packages.map(pkg => [pkg.path, pkg]));
    const files = new Set(inventory.map(file => file.path));
    if (packages.size !== closure.packages.length || files.size !== inventory.length) invalidPack();
    const reached = new Set<string>();
    const visit = (name: string): void => {
        if (reached.has(name)) return;
        reached.add(name);
        const pkg = packages.get(name);
        if (!pkg) invalidPack();
        for (const dependency of Object.values(pkg.dependencies)) visit(dependency);
    };
    for (const [name, version] of Object.entries(compilerRoots)) {
        if (closure.roots[name] !== `node_modules/${name}` || packages.get(closure.roots[name])?.version !== version
            || packages.get(closure.roots[name])?.name !== name) invalidPack();
        visit(closure.roots[name]);
    }
    if (reached.size !== packages.size) invalidPack();
    for (const pkg of closure.packages) {
        const bytes = packageBytes.get(pkg.path);
        if (!bytes || hash(bytes) !== pkg.packageSha256) invalidPack();
        const data = packageJsonSchema.parse(parseJson(bytes.toString('utf8')));
        const pinned = lock.packages[pkg.path];
        if (data.name !== pkg.name || data.version !== pkg.version || pinned?.version !== pkg.version
            || pinned.integrity !== pkg.integrity || pinned.resolved !== pkg.resolved || data.license !== pkg.license) invalidPack();
        const dependencies = Object.keys({ ...data.dependencies, ...data.peerDependencies }).filter(name =>
            !data.peerDependenciesMeta?.[name]?.optional || data.dependencies?.[name]).sort();
        if (canonical(dependencies) !== canonical(Object.keys(pkg.dependencies).sort())) invalidPack();
        for (const name of dependencies) {
            let directory = pkg.path;
            let resolved: string | undefined;
            for (;;) {
                const candidate = `${directory ? `${directory}/` : ''}node_modules/${name}`;
                if (packages.has(candidate)) { resolved = candidate; break; }
                if (!directory) break;
                directory = path.posix.dirname(directory);
                if (directory === '.') directory = '';
            }
            if (pkg.dependencies[name] !== resolved || packages.get(resolved!)?.name !== name) invalidPack();
        }
        const entries: string[] = [];
        const exportTargets = (value: unknown): void => {
            if (typeof value === 'string') entries.push(value);
            else if (value && typeof value === 'object') {
                // Check Node runtime targets, not upstream's optional Babel-authoring types.
                for (const [condition, entry] of Object.entries(value)) if (condition !== 'types') exportTargets(entry);
            }
        };
        exportTargets(data.exports);
        if (data.main) entries.push(data.main);
        // node-releases is a data-only package consumed by browserslist via subpaths.
        if (!entries.length) entries.push(...(pkg.name === 'node-releases'
            ? ['data/processed/envs.json', 'data/release-schedule/release-schedule.json'] : ['index.js']));
        for (const main of entries) {
            const entry = `${pkg.path}/${main.replace(/^\.\//, '')}`;
            if (!sdkPathSchema.safeParse(entry).success
                || ![entry, `${entry}.js`, `${entry}.json`, `${entry}/index.js`].some(file => files.has(file))) invalidPack(`Missing compiler package entry: ${entry.slice(0, 512)}`);
        }
    }
    for (const file of inventory) {
        if (!closure.packages.some(pkg => file.path.startsWith(`${pkg.path}/`)
            && !file.path.slice(pkg.path.length + 1).includes('node_modules/'))) invalidPack();
    }
    for (const name of ['typescript.js', 'tsc.js', 'lib.d.ts', 'lib.es2020.full.d.ts', 'lib.dom.d.ts']) {
        if (!files.has(`node_modules/typescript/lib/${name}`)) invalidPack();
    }
}

export function runtimeFileAllowed(file: string): boolean {
    return sdkPathSchema.safeParse(file).success && (/^(?:engine\/|assets\/(?:internal|game)\/|template\/(?:src|assets|tests)\/)/.test(file)
        || ['index.html', 'boot.js', 'loader.js', 'internal-prerequisites.js', 'import-map.json', 'settings.json',
            'builtin-report.json', 'engine-build.json', 'compiler-dependencies.json', 'ENGINE-LICENSE', 'game-compiler.json',
            'game/main.js', 'game/world.js', 'template/package.json', 'template/tsconfig.json',
            'types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts'].includes(file))
        && !file.split('/').some(part => part === 'node_modules' || part.startsWith('.')) && !file.endsWith('.map');
}

export function validateRuntime(descriptor: z.infer<typeof runtimeDescriptorSchema>, report: z.infer<typeof browserReportSchema>, descriptorSha256: string): void {
    const files = new Map(descriptor.files.map(file => [file.path, file]));
    if (new Set(descriptor.files.map(file => file.path.toLowerCase())).size !== files.size
        || files.size !== descriptor.files.length || descriptor.files.some(file => !runtimeFileAllowed(file.path) || !file.bytes)
        || descriptor.files.reduce((sum, file) => sum + file.bytes, 0) > MAX_GAME_TOTAL
        || report.profile !== descriptor.profile || report.runtimeSha256 !== descriptorSha256
        || !['2d-basic', '3d-basic'].includes(descriptor.profile) || report.initial.world3d !== (descriptor.profile === '3d-basic')
        || !['HTML5', 'BUILD', 'DEBUG'].every(key => descriptor.constants[key] === true)
        || !['NATIVE', 'JSB', 'EDITOR', 'PREVIEW', 'TEST', 'NODEJS'].every(key => descriptor.constants[key] === false)
        || descriptor.constants.USE_3D !== (descriptor.profile === '3d-basic')
        || !validationLevels.slice(0, 5).every(key => descriptor.validationLevels[key] === true)
        || ['vendorBuild', 'device', 'portableSDK'].some(key => descriptor.validationLevels[key] !== false)
        || canonical(descriptor.gameCompiler.sourceFiles) !== canonical(['tools/devkit/runtime/compile-game.cjs', 'tools/devkit/runtime/files.cjs'])
        || descriptor.builtins.reportSha256 !== files.get('builtin-report.json')?.sha256
        || canonical([...descriptor.typeFiles].sort()) !== canonical(['types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts'].sort())) invalidPack();
    for (const file of ['engine/cc.js', 'ENGINE-LICENSE', 'index.html', 'boot.js', 'loader.js', 'settings.json', 'import-map.json',
        'internal-prerequisites.js', 'assets/internal/config.json', 'assets/internal/index.js', 'game/main.js', 'game/world.js',
        'game-compiler.json', 'engine-build.json', 'compiler-dependencies.json', 'template/src/main.ts', 'template/src/world.ts',
        'template/tsconfig.json', 'template/package.json', 'template/assets/tile.png', 'template/assets/click.wav', 'template/assets/rules.json',
        ...descriptor.typeFiles]) if (!files.has(file)) invalidPack();
    if (files.get('types/cc.d.ts')!.bytes < 1024 * KiB || files.get('engine/cc.js')!.bytes < 1024 * KiB) invalidPack();
    const features = ['base', '2d', 'ui', 'audio', 'tween', 'gfx-webgl', 'gfx-webgl2', 'legacy-pipeline',
        ...(descriptor.profile === '3d-basic' ? ['3d', 'animation', 'skeletal-animation', 'primitive'] : [])];
    if (canonical([...descriptor.features].sort()) !== canonical(features.sort())) invalidPack();
}

export async function loadSdk(root: string): Promise<Sdk> {
    try {
        if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) invalidPack();
        root = path.resolve(root);
        for (let current = root;; current = path.dirname(current)) {
            if (!(await lstat(current)).isDirectory()) invalidPack();
            if (current === path.dirname(current)) break;
        }
        if (await realpath(root) !== root) invalidPack();
        const observed = new Map<string, Awaited<ReturnType<typeof lstat>>>();
        observed.set(root, await lstat(root));
        const readFile = async (relative: string, maxBytes: number, retain = true): Promise<Buffer> => {
            if (!sdkPathSchema.safeParse(relative).success) invalidPack();
            const absolute = path.join(root, relative);
            const before = await lstat(absolute);
            if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || await realpath(absolute) !== absolute) invalidPack();
            const previous = observed.get(absolute);
            if (previous && (previous.dev !== before.dev || previous.ino !== before.ino || previous.size !== before.size
                || previous.mtimeMs !== before.mtimeMs || previous.ctimeMs !== before.ctimeMs)) invalidPack();
            const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const opened = await handle.stat();
                if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) invalidPack();
                const buffer = Buffer.alloc(retain ? before.size + 1 : 64 * KiB);
                const checksum = createHash('sha256');
                let length = 0;
                while (length <= before.size) {
                    const start = retain ? length : 0;
                    const { bytesRead } = await handle.read(buffer, start, Math.min(buffer.length - start, before.size + 1 - length), null);
                    if (!bytesRead) break;
                    if (!retain) checksum.update(buffer.subarray(0, bytesRead));
                    length += bytesRead;
                }
                const after = await handle.stat();
                if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalidPack();
                observed.set(absolute, before);
                return retain ? buffer.subarray(0, length) : checksum.digest();
            } finally { await handle.close(); }
        };
        const decode = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const manifestBytes = await readFile('manifest.json', MAX_GAME_MANIFEST);
        const manifest = manifestSchema.parse(parseJson(decode(manifestBytes)));
        const game = manifest.kind === 'portable-development';
        if (!game && manifestBytes.length > MAX_MANIFEST) invalidPack();
        if (manifest.files.reduce((total, file) => total + file.bytes, manifestBytes.length) > (game ? MAX_GAME_TOTAL : MAX_TOTAL)
            || manifest.files.some(file => filePathSchema.safeParse(file.path).success && !fileSchema.safeParse(file).success)) invalidPack();
        const { sdkId, ...payload } = manifest;
        if (sdkId !== `sha256-${hash(canonical(payload))}` || manifest.source.sha256 !== hash(canonical(manifest.source.files))) invalidPack();
        const unique = (values: readonly string[]): void => {
            if (new Set(values.map(value => value.toLowerCase())).size !== values.length) invalidPack();
        };
        unique(manifest.files.map(file => file.path));
        unique(manifest.source.files.map(file => file.path));
        unique(manifest.docs.map(doc => doc.id));
        unique(manifest.docs.map(doc => doc.path));
        unique(manifest.catalog.platforms.map(platform => platform.id));
        unique(manifest.catalog.features.map(feature => feature.id));
        unique(manifest.catalog.profiles.map(profile => `${profile.target}/${profile.id}/${profile.variant}`));
        unique(manifest.catalog.templates.map(template => template.id));
        if (!manifest.catalog.platforms.some(platform => platform.id === 'BILIBILI')) invalidPack();
        const files = new Map(manifest.files.map(file => [file.path, file]));
        const expected = new Set(['manifest.json', ...files.keys()]);
        const directories = new Set<string>();
        for (const file of files.keys()) {
            for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
        }
        unique([...files.keys(), ...directories]);
        let entries = 0;
        const walk = async (relative: string): Promise<void> => {
            const absolute = path.join(root, relative);
            const stat = await lstat(absolute);
            if (!stat.isDirectory() || await realpath(absolute) !== absolute) invalidPack();
            observed.set(absolute, stat);
            const directory = await opendir(absolute);
            for await (const entry of directory) {
                if (++entries > (game ? 40000 : 132)) invalidPack();
                const name = relative ? `${relative}/${entry.name}` : entry.name;
                if (entry.isDirectory() && directories.has(name)) await walk(name);
                else if (!entry.isFile() || !expected.delete(name)) invalidPack();
            }
        };
        await walk('');
        if (expected.size) invalidPack();
        let total = manifestBytes.length;
        const content = new Map<string, string>();
        for (const file of manifest.files) {
            total += file.bytes;
            if (total > (game ? MAX_GAME_TOTAL : MAX_TOTAL)) invalidPack();
            const text = filePathSchema.safeParse(file.path).success;
            const bytes = await readFile(file.path, file.bytes, text);
            if (observed.get(path.join(root, file.path))!.size !== file.bytes
                || (text ? bytes.length !== file.bytes || hash(bytes) !== file.sha256 : bytes.toString('hex') !== file.sha256)) invalidPack();
            if (text) {
                const decoded = decode(bytes);
                if (file.path.startsWith('docs/')) content.set(file.path, decoded);
            }
        }
        const sourceFiles = new Map(manifest.source.files.map(file => [file.path, file]));
        for (const [destination, source] of [['LICENSE', 'LICENSE'], ['app/validate-bilibili.cjs', 'scripts/validate-bilibili.cjs']] as const) {
            const file = files.get(destination);
            const original = sourceFiles.get(source);
            if (!file || file.sha256 !== original?.sha256 || file.bytes !== original.bytes) invalidPack();
        }
        const referenced = new Set(['LICENSE', 'app/validate-bilibili.cjs']);
        for (const doc of manifest.docs) {
            const text = content.get(doc.path);
            if (!doc.path.startsWith('docs/') || text === undefined || Buffer.byteLength(text) > MAX_DOCUMENT || !fits(text)) invalidPack();
            if (!['README.md', 'AGENTS.md', 'docs/bilibili_minigame/README.md', 'docs/plans/cocos4-mcp-devkit.md'].includes(doc.sourcePath)) invalidPack();
            referenced.add(doc.path);
        }
        for (const source of ['README.md', 'AGENTS.md', 'docs/bilibili_minigame/README.md', 'docs/plans/cocos4-mcp-devkit.md'] as const) {
            let offset = 0;
            const chunks = manifest.docs.filter(doc => doc.sourcePath === source).sort((a, b) => a.sourceOffset - b.sourceOffset);
            const text = chunks.map(doc => {
                if (doc.sourceOffset !== offset) invalidPack();
                offset += files.get(doc.path)!.bytes;
                return content.get(doc.path)!;
            }).join('');
            if (offset !== sourceFiles.get(source)?.bytes || hash(text) !== sourceFiles.get(source)?.sha256) invalidPack();
        }
        const profiles = new Map<string, SdkProfile>();
        if (game) {
            const development = manifest.development!;
            const json = async (file: string, max = 2 * 1024 * KiB): Promise<unknown> => {
                if (!files.has(file)) invalidPack();
                referenced.add(file);
                return parseJson(decode(await readFile(file, max)));
            };
            const bind = (prefix: string, inventory: readonly z.infer<typeof inventoryFileSchema>[]): void => {
                unique(inventory.map(file => file.path));
                for (const file of inventory) {
                    const destination = `${prefix}/${file.path}`;
                    const delivered = files.get(destination);
                    if (!delivered || delivered.bytes !== file.bytes || delivered.sha256 !== file.sha256) invalidPack();
                    referenced.add(destination);
                }
            };
            const base = manifestSchema.parse(await json(development.baseManifest, MAX_MANIFEST));
            const { sdkId: baseId, ...basePayload } = base;
            if (base.kind !== 'readonly-development' || baseId !== development.baseSdkId || baseId !== `sha256-${hash(canonical(basePayload))}`
                || base.engineVersion !== manifest.engineVersion || canonical(base.source) !== canonical(manifest.source)
                || canonical(base.docs) !== canonical(manifest.docs) || canonical(base.license) !== canonical(manifest.license)
                || canonical(base.catalog.platforms) !== canonical(manifest.catalog.platforms.map(platform => ({ ...platform,
                    prebuiltAvailable: false, exportAvailable: false, validationLevels: [] })))
                || canonical(base.catalog.features) !== canonical(manifest.catalog.features.map(feature => ({ ...feature, prebuiltAvailable: false })))) invalidPack();
            for (const file of base.files) {
                if (canonical(file) !== canonical(files.get(file.path))) invalidPack();
            }
            const closure = compilerClosureSchema.parse(await json(development.dependencies));
            const inventory = z.array(inventoryFileSchema).min(1).max(20000).parse(await json(development.inventory, MAX_GAME_MANIFEST));
            bind('toolchain', inventory);
            const packages = new Map<string, Buffer>();
            for (const pkg of closure.packages) packages.set(pkg.path, await readFile(`toolchain/${pkg.path}/package.json`, 1024 * KiB));
            const lockBytes = await readFile(development.sourceLock, MAX_GAME_MANIFEST);
            referenced.add(development.sourceLock);
            validateCompilerClosure(closure, lockBytes, packages, inventory);
            const missingLicenses = closure.packages.filter(pkg => !inventory.some(file => file.path.startsWith(`${pkg.path}/`)
                && !file.path.slice(pkg.path.length + 1).includes('node_modules/') && /(?:license|copying|notice)/i.test(path.posix.basename(file.path)))).map(pkg => pkg.path);
            if (canonical(missingLicenses) !== canonical(development.missingLicenseFiles)) invalidPack();
            const toolchain = z.object({ type: z.literal('commonjs'), private: z.literal(true),
                dependencies: z.record(packageName, version) }).strict().parse(await json('toolchain/package.json'));
            if (canonical(toolchain.dependencies) !== canonical(compilerRoots)) invalidPack();
            const sourcePaths = new Map([
                ['toolchain/compiler/compile-game.cjs', 'tools/devkit/runtime/compile-game.cjs'],
                ['toolchain/compiler/files.cjs', 'tools/devkit/runtime/files.cjs'],
            ]);
            unique(development.sourceFiles.map(file => file.path));
            for (const file of development.sourceFiles) {
                if (sourcePaths.get(file.path) !== file.sourcePath || files.get(file.path)?.sha256 !== file.sha256
                    || files.get(file.path)?.bytes !== file.bytes || !file.bytes) invalidPack();
                referenced.add(file.path);
            }
            for (const profile of manifest.catalog.profiles) {
                const directory = `engine/profiles/${profile.target}/${profile.id}/${profile.variant}`;
                if (profile.directory !== directory || profile.descriptor !== `${directory}/runtime.json`
                    || profile.exports !== `${directory}/cc-exports.json` || profile.browserReport !== `${directory}/evidence/browser-report.json`
                    || canonical(profile.validationLevels) !== canonical(validationLevels)) invalidPack();
                const descriptor = runtimeDescriptorSchema.parse(await json(profile.descriptor));
                const report = browserReportSchema.parse(await json(profile.browserReport));
                validateRuntime(descriptor, report, files.get(profile.descriptor)!.sha256);
                if (descriptor.engineVersion !== manifest.engineVersion || descriptor.profile !== profile.id
                    || canonical(descriptor.features) !== canonical(profile.features) || descriptor.rootLockSha256 !== closure.rootLockSha256
                    || descriptor.gameCompiler.dependencyCount !== closure.packages.length) invalidPack();
                bind(directory, descriptor.files);
                if (files.get(`${directory}/compiler-dependencies.json`)?.sha256 !== files.get(development.dependencies)?.sha256) invalidPack();
                unique(report.screenshots.map(file => file.path));
                for (const screenshot of report.screenshots) {
                    const name = `${directory}/evidence/${screenshot.path}`;
                    if (!screenshot.path.endsWith('.png') || files.get(name)?.sha256 !== screenshot.sha256) invalidPack();
                    const image = await readFile(name, 16 * 1024 * KiB);
                    if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                        || image.readUInt32BE(16) !== screenshot.width || image.readUInt32BE(20) !== screenshot.height) invalidPack();
                    referenced.add(name);
                }
                const exports = exportInventorySchema.parse(await json(profile.exports));
                if (new Set(exports.names).size !== exports.names.length) invalidPack();
                if (exports.engineSha256 !== files.get(`${directory}/engine/cc.js`)?.sha256
                    || descriptor.tools.requiredCCExports.some(name => !exports.names.includes(name))) invalidPack();
                profiles.set(`${profile.target}/${profile.id}/${profile.variant}`, freeze({ ...descriptor,
                    directory: path.join(root, directory), descriptor, ccExports: exports.names, typesDirectory: path.join(root, directory, 'types') }));
                if (!manifest.catalog.templates.some(template => template.profile === profile.id && template.target === profile.target
                    && template.variant === profile.variant && template.directory === `${directory}/template`)) invalidPack();
            }
            for (const template of manifest.catalog.templates) {
                const profile = manifest.catalog.profiles.find(profile => profile.id === template.profile && profile.target === template.target && profile.variant === template.variant);
                if (!profile || template.directory !== `${profile.directory}/template`) invalidPack();
            }
            for (const platform of manifest.catalog.platforms) {
                const available = manifest.catalog.profiles.some(profile => profile.target === platform.id);
                if (platform.prebuiltAvailable !== available || platform.exportAvailable !== available
                    || canonical(platform.validationLevels) !== canonical(available ? validationLevels : [])) invalidPack();
            }
            for (const feature of manifest.catalog.features) {
                if (feature.prebuiltAvailable !== manifest.catalog.profiles.some(profile => profile.features.includes(feature.id))) invalidPack();
            }
            if (manifest.catalog.profiles.some(profile => !manifest.catalog.platforms.some(platform => platform.id === profile.target)
                || profile.features.some(id => !manifest.catalog.features.some(feature => feature.id === id)))) invalidPack();
        }
        if (referenced.size !== files.size) invalidPack();
        for (const [absolute, before] of observed) {
            const after = await lstat(absolute);
            if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
                || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || await realpath(absolute) !== absolute) invalidPack();
        }
        return makeSdk(root, manifest, content, profiles);
    } catch (error) {
        if (error instanceof AppError) throw error;
        invalidPack();
    }
}

function makeSdk(root: string, manifest: z.infer<typeof manifestSchema>, content: Map<string, string>, profiles: Map<string, SdkProfile>): Sdk {
    const { sdkId } = manifest;
    freeze(manifest);
    const secret = randomBytes(32);
    const summary = sdkSummarySchema.parse({
        sdkId, schemaVersion: 1, kind: manifest.kind, engineVersion: manifest.engineVersion,
        description: manifest.description, capabilities: manifest.capabilities, sourceSha256: manifest.source.sha256,
        attribution: manifest.source.attribution, fileCount: manifest.files.length, documentCount: manifest.docs.length,
    });
    const binding = (value: unknown): string => hash(canonical({ sdkId, query: value }));
    const sign = (body: string): Buffer => createHmac('sha256', secret).update(body).digest();
    const cursor = (condition: string, offset: number): string => {
        const body = Buffer.from(JSON.stringify({ condition, offset })).toString('base64url');
        return `${body}.${sign(body).toString('base64url')}`;
    };
    const offset = (value: string | undefined, condition: string, count: number): number => {
        if (!value) return 0;
        try {
            const parts = value.split('.');
            if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
            const [body, signature] = parts;
            const actual = Buffer.from(signature, 'base64url');
            if (actual.toString('base64url') !== signature || actual.length !== 32 || !timingSafeEqual(actual, sign(body))) throw new Error();
            const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { condition: string; offset: number };
            if (parsed.condition !== condition || !Number.isSafeInteger(parsed.offset) || parsed.offset <= 0 || parsed.offset >= count) throw new Error();
            return parsed.offset;
        } catch { throw new AppError('CURSOR_INVALID', 'The cursor is invalid for this SDK instance and query.'); }
    };
    const paginate = <T, R extends { items: T[]; nextCursor: string | null }>(
        all: T[], start: number, limit: number, condition: string, response: R,
    ): R => {
        for (let index = start; index < all.length && response.items.length < limit; ++index) {
            response.items.push(all[index]);
            response.nextCursor = index + 1 < all.length ? cursor(condition, index + 1) : null;
            if (!fits(response)) {
                response.items.pop();
                if (!response.items.length) throw new AppError('LIMIT_EXCEEDED', 'A catalog entry exceeds the response budget.');
                response.nextCursor = cursor(condition, index);
                break;
            }
        }
        return response;
    };
    const documents = new Map(manifest.docs.map(doc => [doc.id, doc]));
    const baseUri = `cocos4://sdk/${sdkId}/`;
    const resources = [{ uri: `${baseUri}manifest`, name: 'SDK manifest summary', mimeType: 'application/json',
        description: 'Bounded integrity/source summary, not provenance authentication or release certification.' },
    ...manifest.docs.map(doc => ({ uri: `${baseUri}docs/${doc.id}`, name: doc.title, mimeType: 'text/markdown',
        description: `Source excerpt: ${doc.sourcePath}, UTF-8 byte offset ${doc.sourceOffset}. Source-tree links are not bundled capabilities.` }))];
    if (!fits(resources) || Buffer.byteLength(JSON.stringify(summary)) > MAX_DOCUMENT) invalidPack();
    const resourceContent = new Map<string, string>([[resources[0].uri, JSON.stringify(summary)],
        ...manifest.docs.map(doc => [`${baseUri}docs/${doc.id}`, content.get(doc.path)!] as [string, string])]);
    return Object.freeze({
        sdkId, root, manifest, toolchainRoot: manifest.development ? path.join(root, manifest.development.directory) : null,
        profile(target, profile, variant) {
            if (![target, profile, variant].every(value => id.safeParse(value).success)) {
                throw new AppError('PROFILE_NOT_AVAILABLE', 'The requested target/profile/variant is not delivered in this SDK.');
            }
            const result = profiles.get(`${target}/${profile}/${variant}`);
            if (!result) throw new AppError('PROFILE_NOT_AVAILABLE', 'The requested target/profile/variant is not delivered in this SDK.');
            return result;
        },
        template(id) {
            const result = manifest.catalog.templates.find(template => template.id === id);
            if (!result) throw new AppError('PROFILE_NOT_AVAILABLE', 'The requested template is not delivered in this SDK.');
            return freeze({ ...result, directory: path.join(root, result.directory) });
        },
        catalog(args) {
            const query = input(z.object({ section: sectionSchema, target: id.optional(), cursor: cursorSchema.optional(),
                limit: z.number().int().min(1).max(100).default(20) }).strict(), args);
            if (query.target && !manifest.catalog.platforms.some(platform => platform.id === query.target)) {
                throw new AppError('INVALID_ARGUMENTS', 'The target is not in this SDK engine allowlist.');
            }
            const condition = binding({ operation: 'catalog', section: query.section, target: query.target ?? null, limit: query.limit });
            const items: z.infer<typeof catalogSchema>['items'] = query.section === 'sdk' ? [summary]
                : query.section === 'platforms' ? manifest.catalog.platforms.filter(platform => !query.target || platform.id === query.target)
                    : query.section === 'features' ? manifest.catalog.features.map(feature => query.target ? { ...feature,
                        prebuiltAvailable: manifest.catalog.profiles.some(profile => profile.target === query.target && profile.features.includes(feature.id)) } : feature)
                        : manifest.catalog[query.section].filter(item => !query.target || item.target === query.target);
            const available = !['profiles', 'templates'].includes(query.section) || items.length > 0;
            return catalogSchema.parse(paginate(items, offset(query.cursor, condition, items.length), query.limit, condition, {
                section: query.section, target: query.target ?? null, available,
                reason: available ? manifest.development ? 'Only the delivered HTML5 debug combinations are available; no vendor or portable release certification.'
                    : 'Source catalog only; target-specific feature combinations and game capabilities are not delivered.'
                    : manifest.development ? 'No prebuilt profiles or runnable templates are delivered for the requested target.'
                        : 'No prebuilt profiles or runnable templates are delivered. This pack has no game development capability.',
                items: [], nextCursor: null,
            }));
        },
        search(args) {
            const query = input(z.object({ query: z.string().min(1).max(256).refine(value => value.trim().length > 0),
                kind: kindSchema, profile: id.optional(), cursor: cursorSchema.optional(),
                limit: z.number().int().min(1).max(100).default(20) }).strict(), args);
            if (query.profile && !manifest.catalog.profiles.some(profile => profile.id === query.profile)) {
                throw new AppError('PROFILE_NOT_AVAILABLE', 'The profile is not delivered in this SDK.');
            }
            const condition = binding({ operation: 'search', query: query.query, kind: query.kind, profile: query.profile ?? null, limit: query.limit });
            const items: z.infer<typeof searchSchema>['items'] = [];
            if (query.kind === 'guide' || query.kind === 'all') {
                for (const doc of manifest.docs) {
                    const text = content.get(doc.path)!;
                    // Literal, case-sensitive matching preserves exact source positions, including Unicode.
                    const found = text.indexOf(query.query);
                    if (found < 0 && !doc.title.includes(query.query)) continue;
                    const before = text.slice(0, Math.max(0, found));
                    items.push({ documentId: doc.id, kind: 'guide', title: doc.title, engineVersion: manifest.engineVersion,
                        summary: bytePrefix(text.slice(Math.max(0, found)), 512), requiredFeatures: [],
                        matches: found < 0 ? [] : [{ line: before.split('\n').length,
                            column: [...before.slice(before.lastIndexOf('\n') + 1)].length + 1 }] });
                }
            }
            return searchSchema.parse(paginate(items, offset(query.cursor, condition, items.length), query.limit, condition, {
                query: query.query, kind: query.kind, profile: query.profile ?? null, availableKinds: ['guide'], items: [], nextCursor: null,
            }));
        },
        read(args) {
            const query = input(z.object({ documentId: id, cursor: cursorSchema.optional(),
                maxBytes: z.number().int().min(4).max(MAX_DOCUMENT).default(8 * KiB) }).strict(), args);
            const doc = documents.get(query.documentId);
            if (!doc) throw new AppError('INVALID_ARGUMENTS', 'The document ID is not in this SDK.');
            const text = content.get(doc.path)!;
            const bytes = Buffer.from(text);
            const condition = binding({ operation: 'read', documentId: doc.id, maxBytes: query.maxBytes });
            const start = offset(query.cursor, condition, bytes.length);
            if ((bytes[start] & 0xc0) === 0x80) throw new AppError('CURSOR_INVALID', 'The cursor is not a UTF-8 boundary.');
            let budget = query.maxBytes;
            for (;;) {
                const chunk = bytePrefix(bytes.subarray(start).toString('utf8'), budget);
                const end = start + Buffer.byteLength(chunk);
                const result = { documentId: doc.id, kind: 'guide' as const, title: doc.title, engineVersion: manifest.engineVersion,
                    content: chunk, offsetBytes: start, totalBytes: bytes.length, sha256: hash(text),
                    nextCursor: end < bytes.length ? cursor(condition, end) : null };
                if (fits(result)) return documentSchema.parse(result);
                budget = Math.floor(budget / 2);
                if (budget < 4) throw new AppError('LIMIT_EXCEEDED', 'The document metadata exceeds the response budget.');
            }
        },
        resources() { return resources.map(resource => ({ ...resource })); },
        resource(uri) {
            const value = resourceContent.get(uri);
            if (value === undefined) throw new AppError('INVALID_ARGUMENTS', 'The resource URI is not in this SDK.');
            return value;
        },
    } satisfies Sdk);
}
