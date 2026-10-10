import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { AppError } from './contracts.js';
import { hostRealpath as realpath } from './windows-fs.js';
import { apiIndexDescriptorSchema, apiIndexSchema, apiMetadataSchema, documentIdSchema, exampleMetadataSchema,
    generateApiIndex, MAX_API_INDEX_BYTES, MAX_API_SOURCE_BYTES, runtimeAvailabilitySchema, sourceRangeSchema,
    type IndexedDocument } from './api-index.js';
export { apiIndexDescriptorSchema, apiIndexSchema, apiMetadataSchema, documentIdSchema, exampleMetadataSchema,
    runtimeAvailabilitySchema, sourceRangeSchema } from './api-index.js';
export type { ApiIndex, ApiEntry, ApiIndexInput, ApiProfileInput, ApiTemplateInput, SourceRange, RuntimeAvailability } from './api-index.js';

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
const runtimeTargets = ['HTML5', 'BILIBILI', 'WECHAT', 'BYTEDANCE'] as const;
// module-system 0.0.21 dist/build.js selects commonjs-like for non-browser platforms.
const loaderPlatforms = { HTML5: 'web-desktop', BILIBILI: 'bilibili', WECHAT: 'wechatgame', BYTEDANCE: 'bytedance-mini-game' } as const;
const sourcePathSchema = z.enum([
    'package.json', 'cc.config.json', 'scripts/validate-bilibili.cjs', 'scripts/validate-minigame.cjs', 'LICENSE',
    'README.md', 'AGENTS.md', 'docs/bilibili_minigame/README.md', 'docs/plans/cocos4-mcp-devkit.md',
]);
const filePathSchema = z.string().max(160).regex(/^(?:LICENSE|app\/validate-(?:bilibili|minigame)\.cjs|docs\/[a-z0-9-]+\.md)$/);
const fileSchema = z.object({ path: filePathSchema, bytes: z.number().int().positive().max(32 * KiB), sha256: digest }).strict();
export const sdkPathSchema = z.string().min(1).max(512).refine(value => value.split('/').every(part =>
    /^[A-Za-z0-9_@.+=,-]+$/.test(part) && part !== '.' && part !== '..' && !part.endsWith('.')
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)));
export const inventoryFileSchema = z.object({ path: sdkPathSchema,
    bytes: z.number().int().nonnegative().max(128 * 1024 * KiB), sha256: digest }).strict();
const sourceFileSchema = z.object({ path: sourcePathSchema, bytes: z.number().int().positive().max(1024 * KiB), sha256: digest }).strict();
const capabilitiesSchema = z.object({
    catalog: z.literal(true), docs: z.literal(true), packageValidation: z.union([
        z.tuple([z.literal('BILIBILI')]),
        z.tuple([z.literal('BILIBILI'), z.literal('WECHAT'), z.literal('BYTEDANCE')]),
    ]),
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

const validationLevels = Object.freeze(['engineTypecheck', 'engineBuild', 'builtinIntegrity', 'gameTypecheck', 'loaderTypecheck',
    'browserFirstFrame', 'browserInteraction'] as const);
const minigameValidationLevels = Object.freeze(['engineTypecheck', 'engineBuild', 'builtinIntegrity', 'gameTypecheck', 'loaderTypecheck',
    'moduleClosure', 'canonicalPreflight', 'loaderBootstrapSharedGlobal', 'loaderBootstrapDistinctGlobal', 'entryLifecycle', 'startupFailure'] as const);
export const runtimeValidationLevels = Object.freeze({ HTML5: validationLevels,
    BILIBILI: minigameValidationLevels, WECHAT: minigameValidationLevels, BYTEDANCE: minigameValidationLevels });
const profileFields = {
    id, variant: z.enum(['debug', 'release']), directory: sdkPathSchema,
    descriptor: sdkPathSchema, exports: sdkPathSchema,
    features: z.array(id).min(1).max(128), delivery: z.literal('PREBUILT'), validationLevels: z.array(id).max(16),
};
export const profileSchema = z.discriminatedUnion('target', [
    z.object({ ...profileFields, target: z.literal('HTML5'), browserReport: sdkPathSchema }).strict(),
    z.object({ ...profileFields, target: z.enum(['BILIBILI', 'WECHAT', 'BYTEDANCE']), localReport: sdkPathSchema }).strict(),
]);
export const templateSchema = z.object({ id, directory: sdkPathSchema, profile: id,
    variant: z.enum(['debug', 'release']), target: z.enum(runtimeTargets) }).strict();
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
    source: z.object({ sha256: digest, files: z.array(sourceFileSchema).min(8).max(9), attribution: z.string().min(1).max(1024) }).strict(),
    license: z.object({ path: z.literal('LICENSE'), spdx: z.literal('MIT') }).strict(),
    files: z.array(inventoryFileSchema).min(3).max(20000),
    catalog: z.object({
        platforms: z.array(platformSchema).min(1).max(128), features: z.array(featureSchema).min(1).max(256),
        profiles: z.array(profileSchema).max(16), templates: z.array(templateSchema).max(16),
    }).strict(),
    docs: z.array(docEntrySchema).min(4).max(96),
    apiIndex: apiIndexDescriptorSchema.optional(),
    development: developmentSchema.optional(),
}).strict().superRefine((manifest, context) => {
    const game = manifest.kind === 'portable-development';
    // Shipped packs have eight sources and only the Bilibili validator. Do not
    // reinterpret their capabilities or require new profiles when loading them.
    const minigame = manifest.source.files.some(file => file.path === 'scripts/validate-minigame.cjs');
    if (canonical(manifest.source.files.map(file => file.path).sort()) !== canonical(sourcePathSchema.options
        .filter(file => minigame || file !== 'scripts/validate-minigame.cjs').sort())
        || canonical(manifest.capabilities.packageValidation) !== canonical(minigame ? ['BILIBILI', 'WECHAT', 'BYTEDANCE'] : ['BILIBILI'])
        || manifest.files.filter(file => file.path === 'app/validate-minigame.cjs').length !== Number(minigame)
        || (!minigame && manifest.catalog.profiles.some(profile => profile.target === 'WECHAT' || profile.target === 'BYTEDANCE'))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Package validation capabilities require the matching source-bound validator.' });
    }
    if (['gameDevelopment', 'gameBuild', 'preview', 'export'].some(key => manifest.capabilities[key as 'gameBuild'] !== game)
        || game !== !!manifest.development || (!game && (manifest.apiIndex || manifest.files.length > 128
            || manifest.files.some(file => !fileSchema.safeParse(file).success)
            || manifest.catalog.profiles.length || manifest.catalog.templates.length
            || manifest.catalog.platforms.some(item => item.prebuiltAvailable || item.exportAvailable || item.validationLevels.length)
            || manifest.catalog.features.some(item => item.prebuiltAvailable)))
        || (game && (!['2d-basic', '3d-basic'].every(id => manifest.catalog.profiles.some(item => item.id === id && item.target === 'HTML5'))
            || (manifest.catalog.profiles.some(item => item.target !== 'HTML5') && !manifest.apiIndex)
            || !manifest.catalog.templates.length))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Capabilities require complete delivered profiles, templates and toolchain.' });
    }
    if (game && manifest.catalog.profiles.some(profile => (profile.variant === 'release' && !manifest.apiIndex)
        || !['2d-basic', '3d-basic'].every(id => manifest.catalog.profiles.some(item => item.id === id
            && item.target === profile.target && item.variant === profile.variant)))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Each target/variant requires both profiles; release requires a source-bound API index.' });
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
const indexedMetadata = { api: apiMetadataSchema.optional(), example: exampleMetadataSchema.optional(),
    runtimeAvailability: z.array(runtimeAvailabilitySchema).max(16).optional() };
export const searchSchema = z.object({
    query: z.string().min(1).max(256), kind: kindSchema, profile: id.nullable(), availableKinds: z.array(z.enum(['guide', 'api', 'example'])).min(1).max(3),
    items: z.array(z.object({
        documentId: documentIdSchema, kind: z.enum(['guide', 'api', 'example']), title: z.string().max(1024), engineVersion: version,
        summary: z.string().max(512), matches: z.array(z.object({
            line: z.number().int().positive(), column: z.number().int().positive(),
            source: sourceRangeSchema.optional(),
        }).strict()).max(1), requiredFeatures: z.array(id).max(0),
        ...indexedMetadata,
    }).strict()).max(100), nextCursor: cursorSchema.nullable(),
}).strict();
export const documentSchema = z.object({
    documentId: documentIdSchema, kind: z.enum(['guide', 'api', 'example']), title: z.string().max(1024), engineVersion: version,
    content: z.string().max(MAX_DOCUMENT), offsetBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive().max(MAX_API_SOURCE_BYTES), sha256: digest, nextCursor: cursorSchema.nullable(),
    ...indexedMetadata,
    anchors: z.array(z.object({ documentOffsetBytes: z.number().int().nonnegative(), lengthBytes: z.number().int().positive(),
        role: z.enum(['jsdoc', 'signature', 'source']), source: sourceRangeSchema }).strict()).max(256).optional(),
}).strict();

type DeepReadonly<T> = T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
export type Manifest = DeepReadonly<z.infer<typeof manifestSchema>>;
type LoadedProfile<D> = D extends unknown ? DeepReadonly<D> & {
    readonly directory: string;
    readonly descriptor: DeepReadonly<D>;
    readonly ccExports: readonly string[];
    readonly typesDirectory: string;
} : never;
export type RuntimeDescriptor = z.infer<typeof runtimeDescriptorSchema>;
export type SdkProfile = LoadedProfile<RuntimeDescriptor>;
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
const emissionSchema = z.object({ variant: z.enum(['debug', 'release']), sourceMaps: z.literal(false), minified: z.boolean(),
    compact: z.boolean(), comments: z.enum(['preserve', 'license-only']) }).strict();
const buildOptionsSchema = z.object({
    engine: z.object({ platform: z.enum(runtimeTargets), mode: z.literal('BUILD'), moduleFormat: z.literal('system'),
        features: z.array(id).min(1).max(128), flags: z.record(z.union([z.boolean(), z.number()])), compress: z.boolean(),
        sourceMap: z.literal(false), split: z.literal(false), targets: z.object({ chrome: z.literal('100') }).strict() }).strict(),
    loader: z.object({ platform: z.enum(['web-desktop', 'bilibili', 'wechatgame', 'bytedance-mini-game']), sourceMap: z.literal(false), minify: z.boolean(),
        hmr: z.literal(false), editor: z.literal(false), minifierWorkers: z.literal(1) }).strict(),
    game: emissionSchema,
    bootstrap: z.object({ minified: z.boolean(), sourceMaps: z.literal(false), comments: z.enum(['preserve', 'license-only']) }).strict(),
}).strict();
const buildEvidenceSchema = z.object({ target: z.enum(runtimeTargets), variant: z.enum(['debug', 'release']),
    optionsSha256: digest, engineSha256: digest }).strict();
export const html5RuntimeDescriptorSchema = z.object({
    schemaVersion: z.literal(1), kind: z.literal('cocos4-html5-runtime'), profile: id,
    target: z.literal('HTML5'), mode: z.literal('BUILD'), variant: z.enum(['debug', 'release']),
    moduleFormat: z.literal('system'), sourceMap: z.literal(false), compressed: z.boolean(),
    buildOptions: buildOptionsSchema.optional(),
    features: z.array(id).min(1).max(128), constants: z.record(z.union([z.boolean(), z.number()])),
    engineVersion: version, rootLockSha256: digest, delivery: z.literal('PREBUILT'),
    entry: z.literal('index.html'), engineEntry: z.literal('./engine/cc.js'),
    types: z.literal('types/cc.d.ts'), typeFiles: z.array(sdkPathSchema).length(3), template: z.literal('template'),
    tools: z.object({ typeChecked: z.literal(true), requiredCCExports: z.array(ccExport).min(1).max(4096),
        typescript: z.literal('4.9.5'), babel: z.literal('7.19.6'), preset: z.literal('@cocos/babel-preset-cc@2.2.0'),
        typeChecking: z.object({ strict: z.literal(true), skipLibCheck: z.literal(false), skipDefaultLibCheck: z.literal(false) }).passthrough(),
        emission: emissionSchema.optional(),
    }).passthrough(),
    builtins: z.object({ report: z.literal('builtin-report.json'), reportSha256: digest,
        effects: z.array(z.unknown()).min(1), materials: z.array(z.unknown()).min(1) }).passthrough(),
    gameCompiler: z.object({ dependencies: z.literal('compiler-dependencies.json'), dependencyCount: z.number().int().positive().max(256),
        entry: z.literal('tools/devkit/runtime/compile-game.cjs'), export: z.literal('compileGame'),
        sourceFiles: z.array(sdkPathSchema).length(2), requiresEngineCheckout: z.boolean() }).passthrough(),
    validationLevels: z.record(z.boolean()), files: z.array(inventoryFileSchema).min(20).max(10000),
}).passthrough();
export const bilibiliRuntimeDescriptorSchema = html5RuntimeDescriptorSchema.extend({
    kind: z.literal('cocos4-bilibili-runtime'), target: z.literal('BILIBILI'),
    entry: z.literal('game.js'), engineEntry: z.literal('./cocos-js/cc.js'),
    tools: html5RuntimeDescriptorSchema.shape.tools.extend({ loaderPlatform: z.literal('bilibili'),
        moduleSystem: z.literal('0.0.21'), ccbuild: z.literal('2.3.21') }),
    builtins: html5RuntimeDescriptorSchema.shape.builtins.extend({
        effects: z.array(z.object({ uuid: z.string().uuid(), name: version }).passthrough()).min(1).max(128),
        materials: z.array(z.object({ uuid: z.string().uuid(), name: version }).passthrough()).min(1).max(128),
    }),
});
export const wechatRuntimeDescriptorSchema = bilibiliRuntimeDescriptorSchema.extend({
    kind: z.literal('cocos4-wechat-runtime'), target: z.literal('WECHAT'), buildOptions: buildOptionsSchema,
    tools: bilibiliRuntimeDescriptorSchema.shape.tools.extend({ loaderPlatform: z.literal('wechatgame'), emission: emissionSchema }),
});
export const bytedanceRuntimeDescriptorSchema = bilibiliRuntimeDescriptorSchema.extend({
    kind: z.literal('cocos4-bytedance-runtime'), target: z.literal('BYTEDANCE'), buildOptions: buildOptionsSchema,
    tools: bilibiliRuntimeDescriptorSchema.shape.tools.extend({ loaderPlatform: z.literal('bytedance-mini-game'), emission: emissionSchema }),
});
export const runtimeDescriptorSchema = z.discriminatedUnion('target', [html5RuntimeDescriptorSchema, bilibiliRuntimeDescriptorSchema,
    wechatRuntimeDescriptorSchema, bytedanceRuntimeDescriptorSchema]);
export const browserReportSchema = z.object({
    schemaVersion: z.literal(1), profile: id, runtimeSha256: digest, success: z.literal(true),
    build: buildEvidenceSchema.optional(),
    runtimeConstants: z.record(z.boolean()).optional(),
    tools: z.object({ executableSha256: digest, verifierSha256: digest, playwright: version, node: version }).strict().optional(),
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
// New payloads contain a validation summary, not a sanitized execution report.
// Raw reports/PNGs are checked at preparation and retained in a hash-bound sibling
// receipt. Legacy payloads below still validate their delivered reports and PNGs.
export const browserSummarySchema = browserReportSchema.pick({ schemaVersion: true, profile: true, runtimeSha256: true,
    success: true, build: true, runtimeConstants: true, browser: true, tools: true, pageErrors: true }).extend({
    kind: z.literal('cocos4-browser-validation-summary'),
    evidence: z.literal('separate-execution-receipt'),
    headless: z.boolean(), launchArgs: z.array(z.string().min(1).max(256)).max(32),
    validation: browserReportSchema.shape.validation.strict(),
    initial: browserReportSchema.shape.initial.strict(),
    screenshots: z.tuple([
        z.object({ path: z.literal('first-frame.png'), width: z.literal(640), height: z.literal(480) }).strict(),
        z.object({ path: z.literal('after-click.png'), width: z.literal(640), height: z.literal(480) }).strict(),
        z.object({ path: z.literal('after-touch.png'), width: z.literal(640), height: z.literal(480) }).strict(),
        z.object({ path: z.literal('mobile.png'), width: z.literal(390), height: z.literal(844) }).strict(),
    ]),
}).strict();

export async function summarizeBrowserReport(value: unknown, read: (file: string, max: number) => Promise<Buffer>): Promise<z.infer<typeof browserSummarySchema>> {
    const report = browserReportSchema.parse(value);
    if (new Set(report.screenshots.map(file => file.path.toLowerCase())).size !== report.screenshots.length) invalidPack();
    for (const screenshot of report.screenshots) {
        const image = await read(screenshot.path, 16 * 1024 * KiB);
        if (!screenshot.path.endsWith('.png') || hash(image) !== screenshot.sha256 || image.length < 24
            || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            || image.readUInt32BE(16) !== screenshot.width || image.readUInt32BE(20) !== screenshot.height) invalidPack('Invalid browser screenshot evidence.');
    }
    const initial = browserReportSchema.shape.initial.strip().parse(report.initial);
    const validation = browserReportSchema.shape.validation.strip().parse(report.validation);
    return browserSummarySchema.parse({ schemaVersion: report.schemaVersion, kind: 'cocos4-browser-validation-summary',
        evidence: 'separate-execution-receipt', profile: report.profile, runtimeSha256: report.runtimeSha256,
        success: report.success, build: report.build, runtimeConstants: report.runtimeConstants,
        browser: report.browser, tools: report.tools, headless: report.headless, launchArgs: report.launchArgs,
        pageErrors: report.pageErrors, validation, initial,
        screenshots: report.screenshots.map(({ path, width, height }) => ({ path, width, height })) });
}
const localProbeSchema = z.object({ ready: z.literal(true), score: z.literal(0), restarts: z.literal(1), starts: z.literal(2),
    clicks: z.literal(0), decoratedDefault: z.literal(7), classRegistered: z.literal(true), imageLoaded: z.literal(true),
    jsonLoaded: z.literal(true), audioLoaded: z.literal(true), audioStarted: z.literal(1), audioEnded: z.literal(1),
    missingRejected: z.literal(true), world3d: z.boolean(), error: z.literal('') }).strict();
const localLifecycleSchema = z.object({ distinct: z.boolean(), loaded: z.array(sdkPathSchema).min(1).max(32),
    launchSuccessCount: z.literal(1), errors: z.array(z.never()).max(0), probe: localProbeSchema,
    negativeGates: z.tuple([z.literal('unknown-module'), z.literal('missing-module'), z.literal('missing-asset')]) }).strict();
const localFaults = ['missing-settings', 'missing-export', 'missing-builtin', 'invalid-material', 'init', 'run',
    'start-sync', 'start-async', 'missing-asset'] as const;
export const bilibiliReportSchema = z.object({
    schemaVersion: z.literal(1), kind: z.literal('cocos4-bilibili-local-report'), profile: id,
    runtimeSha256: digest, success: z.literal(true),
    build: buildEvidenceSchema.optional(),
    checks: z.object({ moduleClosure: z.literal(true), canonicalPreflight: z.literal(true), loaderBootstrapSharedGlobal: z.literal(true),
        loaderBootstrapDistinctGlobal: z.literal(true), entryLifecycle: z.literal(true), startupFailure: z.literal(true) }).strict(),
    validationLevels: z.object({ vendorBuild: z.literal(false), device: z.literal(false) }).strict(),
    notes: z.tuple([
        z.literal('Maintainer-only trusted artifact verifier, not a sandbox for untrusted game code'),
        z.literal('Real generated loader, launcher, adapters, Application and game modules; engine exports/resources inspected statically'),
        z.literal('cc game, scene/component lifecycle, builtin instances, asset wrappers and bl host services are explicit contract mocks'),
        z.literal('No engine execution, GL, rendering, media decoding/playback, vendor build or real-device validation'),
    ]),
    evidence: z.object({
        closure: z.object({ parsedScripts: z.number().int().positive().max(128), systemModules: z.number().int().positive().max(128),
            moduleEdges: z.array(z.object({ from: sdkPathSchema, to: sdkPathSchema }).strict()).min(1).max(256),
            resourceCount: z.number().int().positive().max(1024), engineExportCount: z.number().int().positive().max(4096),
            requiredCCExportCount: z.number().int().positive().max(4096), builtinEffects: z.number().int().positive().max(128),
            builtinMaterials: z.number().int().positive().max(128) }).strict(),
        preflight: z.object({ appId: version, version,
            packages: z.tuple([z.object({ name: z.literal('main'), root: z.literal(''), bytes: z.number().int().positive().max(MAX_GAME_TOTAL) }).strict()]),
            totalBytes: z.number().int().positive().max(MAX_GAME_TOTAL), warnings: z.array(z.string().max(256)).max(2) }).strict(),
        shared: localLifecycleSchema.extend({ distinct: z.literal(false) }),
        distinct: localLifecycleSchema.extend({ distinct: z.literal(true) }),
        failures: z.array(z.object({ fault: z.enum(localFaults), errors: z.array(z.string().min(1).max(2048)).min(1).max(8) }).strict()).length(localFaults.length),
    }).strict(),
}).strict();
const minigamePreflightSchema = bilibiliReportSchema.shape.evidence.shape.preflight.omit({ version: true }).extend({ target: z.enum(['WECHAT', 'BYTEDANCE']) });
const localWarnings = z.array(z.string().min(1).max(2048)).max(8);
const wechatFaults = ['missing-host', 'missing-fs', ...localFaults] as const;
const bytedanceFaults = ['missing-game-config', 'invalid-game-config', 'web-adapter', 'loader', 'engine-adapter',
    'missing-settings', 'missing-export', 'missing-builtin', 'invalid-material', 'init-sync', 'init', 'run', 'start-sync', 'start-async', 'missing-main', 'missing-asset'] as const;
const wechatLifecycleSchema = localLifecycleSchema.omit({ launchSuccessCount: true }).extend({
    separateSelf: z.boolean(), platform: z.literal('android'),
    reads: z.array(z.union([sdkPathSchema, z.literal('wxfile://mock-user/gamecaches/cacheList.json')])).min(1).max(1024),
    warnings: z.array(z.never()).max(0), initCalls: z.literal(1), runCalls: z.literal(1), phase: z.literal('running'), adapterTouchEvents: z.literal(1),
});
const bytedanceLifecycleSchema = localLifecycleSchema.omit({ launchSuccessCount: true }).extend({
    devtools: z.literal(false),
    fileReads: z.array(z.union([sdkPathSchema, z.literal('ttfile://mock-user/gamecaches/cacheList.json')])).min(1).max(1024),
    warnings: z.array(z.never()).max(0), initCount: z.literal(1), runCount: z.literal(1),
});
const localFailureFields = { errors: z.array(z.string().min(1).max(2048)).length(1), warnings: localWarnings };
const localNotes = bilibiliReportSchema.shape.notes.items;
export const wechatReportSchema = bilibiliReportSchema.extend({
    kind: z.literal('cocos4-wechat-local-report'), build: buildEvidenceSchema,
    notes: z.tuple([localNotes[0],
        z.literal('Real generated loader, launcher, pinned adapters, Application and game modules; engine flags/exports/resources inspected statically'),
        z.literal('cc lifecycle, builtin instances, asset/media wrappers and wx host services are explicit contract mocks'), localNotes[3],
        z.literal('@cocos/engine-platforms 1.0.6 declares UNLICENSED; redistribution authorization remains a separate requirement')]),
    evidence: bilibiliReportSchema.shape.evidence.extend({
        preflight: minigamePreflightSchema.extend({ target: z.literal('WECHAT') }),
        closure: bilibiliReportSchema.shape.evidence.shape.closure.extend({
            adapterModules: z.object({ 'web-adapter.js': z.literal(35), 'engine-adapter.js': z.literal(7) }).strict(),
            compiledGlobals: z.object({ CC_DEBUG: z.boolean(), CC_BUILD: z.literal(true), CC_JSB: z.literal(false), CC_EDITOR: z.literal(false),
                CC_PREVIEW: z.literal(false), CC_WECHAT: z.literal(true), CC_BILIBILI: z.literal(false), CC_BYTEDANCE: z.literal(false), CC_MINIGAME: z.literal(true) }).strict(),
        }),
        shared: wechatLifecycleSchema.extend({ distinct: z.literal(false), separateSelf: z.literal(false) }),
        distinct: wechatLifecycleSchema.extend({ distinct: z.literal(true), separateSelf: z.literal(true) }),
        failures: z.array(z.object({ ...localFailureFields, fault: z.enum(wechatFaults), loaded: z.array(sdkPathSchema).min(1).max(32),
            initCalls: z.number().int().min(0).max(1), runCalls: z.number().int().min(0).max(1), phase: z.literal('failed') }).strict()).length(wechatFaults.length),
    }),
});
export const bytedanceReportSchema = bilibiliReportSchema.extend({
    kind: z.literal('cocos4-bytedance-local-report'), build: buildEvidenceSchema,
    notes: z.tuple([localNotes[0],
        z.literal('Real generated loader, launcher, prepared ByteDance adapters, Application and game modules; engine inspected statically only'),
        z.literal('cc, legacy window.cc, scene/component lifecycle, builtin instances, media wrappers and tt host services are explicit contract mocks'),
        z.literal('ByteDance fs-utils is embedded in the published engine adapter; fs-utils.js exposes the same instance'),
        z.literal('Static module/resource closure plus exercised local bundle loading; remote services, plugins and subpackage delivery remain unverified'), localNotes[3],
        z.literal('@cocos/engine-platforms declares UNLICENSED; preserved metadata/engine license do not establish redistribution rights')]),
    evidence: bilibiliReportSchema.shape.evidence.extend({
        preflight: minigamePreflightSchema.extend({ target: z.literal('BYTEDANCE') }),
        closure: bilibiliReportSchema.shape.evidence.shape.closure.extend({ adapters: z.object({
            'web-adapter.js': z.object({ modules: z.literal(34), dependencies: z.literal(54), entries: z.tuple([z.literal(27)]) }).strict(),
            'engine-adapter.js': z.object({ modules: z.literal(8), dependencies: z.literal(7), entries: z.tuple([z.literal(7)]), fsUtilsModule: z.literal(8) }).strict(),
        }).strict() }),
        shared: bytedanceLifecycleSchema.extend({ distinct: z.literal(false) }),
        distinct: bytedanceLifecycleSchema.extend({ distinct: z.literal(true) }),
        failures: z.array(z.object({ ...localFailureFields, fault: z.enum(bytedanceFaults),
            initCount: z.number().int().min(0).max(1), runCount: z.number().int().min(0).max(1) }).strict()).length(bytedanceFaults.length),
    }),
});
export const minigameReportSchema = z.discriminatedUnion('kind', [bilibiliReportSchema, wechatReportSchema, bytedanceReportSchema]);
export type BilibiliRuntimeDescriptor = z.infer<typeof bilibiliRuntimeDescriptorSchema>;
export type BilibiliReport = z.infer<typeof bilibiliReportSchema>;
export type MiniGameRuntimeDescriptor = Exclude<RuntimeDescriptor, { target: 'HTML5' }>;
export type MiniGameReport = z.infer<typeof minigameReportSchema>;
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

const bilibiliFixedFiles = [
    'game.js', 'game.json', 'application.js', 'web-adapter.js', 'engine-adapter.js', 'fs-utils.js', 'loader.js',
    'cocos-js/cc.js', 'internal-prerequisites.js', 'import-map.json', 'settings.json', 'builtin-report.json',
    'engine-build.json', 'compiler-dependencies.json', 'ENGINE-LICENSE', 'game-compiler.json', 'game/main.js', 'game/world.js',
    'assets/internal/config.json', 'assets/internal/index.js', 'assets/game/tile.png', 'assets/game/click.wav', 'assets/game/rules.json',
    'template/package.json', 'template/tsconfig.json', 'template/src/main.ts', 'template/src/world.ts', 'template/tests/contract.mjs',
    'template/assets/tile.png', 'template/assets/click.wav', 'template/assets/rules.json', 'types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts',
] as const;
const minigameExtraFiles = {
    BILIBILI: [],
    WECHAT: ['project.config.json', 'WECHAT-ADAPTER-LICENSE'],
    BYTEDANCE: ['project.config.json', 'licenses/bytedance/package.json', 'licenses/bytedance/README.md',
        'licenses/bytedance/ENGINE-LICENSE', 'licenses/bytedance/NOTICE.txt'],
} as const;
// Reviewed bootstrap emitted by templates/bilibili/game.ejs, the checked adapter
// preparation, bilibili-application.js, and @cocos/module-system 0.0.21. These are
// source pins, not vendor certification. Revisit them when those inputs change.
export const bilibiliBootstrapHashes = Object.freeze({
    'game.js': 'f2de52f215ea45e2fb222ecf9eea0ec16adc25e67aacdd5b52e951d40fb8ca7e',
    'game.json': '280cd47a56ebde787d089ea3acf25bd12b453ef66090f0ae66db53c5a4575ae5',
    'application.js': 'b0fa1f9761865d5b4bff2d6283d0743d5e497060ef26bae8b739ea5dbeacbfb1',
    'web-adapter.js': '362e8bc82cf375414a7dd8ef6d4fe0f75a363a2ddb48807a3ee62bd6fb06e18c',
    'engine-adapter.js': 'bf77e5e5aff024a5e16465c9a527a83f10f43558b7c9e30d446c0accb919221d',
    'fs-utils.js': 'b62ea232b6e4dd600c6aa773a9ce8ffa4dc399e84dc6b0cd8cb51db840033ffb',
    'loader.js': 'f1bf370e6df5bf58763175b5135fc999c0b09e9a1b75f42e19eb37678c84c157',
    'import-map.json': '5fc732c3148d610b9628477e4d11c169b01e13722ab1917aaae82b6e55cf12db',
    'internal-prerequisites.js': '8ec473abaac5f9fcc603052adcfa1b5ebcbcddeddfc7934b5a016afa48b072f4',
});

// Release uses separately minified loader/bootstrap bytes. Debug pins remain valid
// for the persisted SDKs, not as interchangeable aliases for a release runtime.
export const bilibiliReleaseBootstrapHashes = Object.freeze({
    ...bilibiliBootstrapHashes,
    'game.js': 'a024a8635cc534180aba7b159dbadbd8dfba0ac8d0bcbf348936c6fc5de3ce5f',
    'application.js': 'cf4383f8020809f8f70322e8aef8d6f029c3c4a4234c509d705598be8ed04ae1',
    'web-adapter.js': 'aadc6c3e57e979409a6f3e7e64e69439fa17a22b2b12f5070e2a966c3e4dee12',
    'engine-adapter.js': 'f9a1f4fe26e8bdc4fe38c7cdea0711723943e678b874163a2dd8aaaea42bc261',
    'fs-utils.js': 'cf6b8761fa498fd1c0f507a088d88bf6b903aca1fb6cb0de1cc72556db9fe5c2',
    'loader.js': '4cb96ea27aec89e9082927a56fd55c4429f326f69e94a79a9582da048972c2a9',
    'internal-prerequisites.js': 'e3d5b4de7e45bc60a74f50e9a3bbf145446abbfca4d282f06f1dbdc67e22f968',
});

// Reviewed platform helpers, unmodified engine-platforms 1.0.6 adapters, and the
// same Babel bootstrap emission options as build-runtime.cjs. Configs stay mutable.
export const minigameBootstrapHashes = freeze({
    WECHAT: {
        debug: {
            'game.js': '0a98f24da039f7936a98199ec7946edc1fd4f33b87db6cff1deee6e311937728',
            'application.js': '1cf9dc072272714abf53c1236de9848ad3e36dee3f5016f9a94b2d0760fe6c0f',
            'web-adapter.js': 'c0c19caf7480d07268580f9492d6376b88359eae74c5c865f01cd4cd47bbbdad',
            'engine-adapter.js': '4f3d6a3148449b899ae1b61e6b1387f8dcde8bbf4ce7422d2a8de0fff129942e',
            'fs-utils.js': 'b98bfd6333a20655516e2f609d690616f9c1371b7d72cca28fd737cdf77b4370',
        },
        release: {
            'game.js': 'f70beb864bd9eb7361f9486165f1ac7906f09ede7639e5c06a79724381517c55',
            'application.js': '48ccc31315fdccde1211c021fe7e276190c8cf2f0d86d84a28e4025d3a47a5d2',
            'web-adapter.js': '77578e55a0cc02a82854ed2c64d437ff60747f2b255656b6776b8494f6f7f672',
            'engine-adapter.js': 'd0a14e7a4c8c282cbfebbdf21ab6ce1282e116c91677083c731fad09fbb9eae3',
            'fs-utils.js': 'da25811d7e08535bb4597bd856e02b218e1c894309c7e933cb3afe7057427f3c',
        },
    },
    BYTEDANCE: {
        debug: {
            'game.js': '3a907daa6f676e98036aaa2303dd4fb473f2db2b2f7071e74c2207d1637d86ed',
            'application.js': 'f5a47ea8c37bc9db38cd421542718d1013ba6cca99f739d365470da9d4500bc4',
            'web-adapter.js': '6956a6256ae4a15a1b0c6dd41883acd1cba655e049681e0490f9a301f96443e3',
            'engine-adapter.js': '634012352eb5c560b26337c055ef836cd3726aba67e88e39b9afcb165ff2c56c',
            'fs-utils.js': 'ed59c1c6ceca603b433457a606572f64c371c222ba6c898bfe4a0d5ab7c52cb4',
        },
        release: {
            'game.js': 'c6747b3be971b611380c9e3fa228ce7993d4b4ccd1c496efe74b4bbf47ecd94c',
            'application.js': '6e39c8fb658151a925585f59dd041b082c97ceaf5d53d3573f3b4af69cc7b15a',
            'web-adapter.js': 'c3b640462e708c030cb466c0c185071c09c4b67d7a1881fe04cf19b3a801b2ee',
            'engine-adapter.js': 'b26471141fa2e44f7a43106b535ac8a47dc1d1730f84e644cf58f7b1b4ee43fb',
            'fs-utils.js': 'f891446f44965419a87d560a1886f08a5ff43f3d361306195376a1c8ee70a423',
        },
    },
});

function validateRuntimeVariant(descriptor: RuntimeDescriptor, evidence: z.infer<typeof buildEvidenceSchema> | undefined): void {
    const release = descriptor.variant === 'release';
    if (!['debug', 'release'].includes(descriptor.variant) || descriptor.compressed !== release
        || descriptor.sourceMap !== false || descriptor.constants.DEBUG !== !release) invalidPack('Runtime variant flags disagree.');
    // Real saved debug descriptors predate buildOptions and emission metadata.
    if (!descriptor.buildOptions) {
        if (release || evidence) invalidPack('Missing variant build options.');
        return;
    }
    const comments = release ? 'license-only' : 'preserve';
    const expected = {
        engine: { platform: descriptor.target, mode: 'BUILD', moduleFormat: 'system', features: descriptor.features,
            flags: { ...(descriptor.profile === '3d-basic' ? { USE_3D: true } : {}),
                DEBUG: !release, NATIVE: false, JSB: false, EDITOR: false, PREVIEW: false },
            compress: release, sourceMap: false, split: false, targets: { chrome: '100' } },
        loader: { platform: loaderPlatforms[descriptor.target], sourceMap: false, minify: release, hmr: false, editor: false, minifierWorkers: 1 },
        game: { variant: descriptor.variant, sourceMaps: false, minified: release, compact: release, comments },
        bootstrap: { minified: release, sourceMaps: false, comments },
    };
    if (canonical(descriptor.buildOptions) !== canonical(expected) || canonical(descriptor.tools.emission) !== canonical(expected.game)
        || canonical(evidence) !== canonical({ target: descriptor.target, variant: descriptor.variant,
            optionsSha256: hash(JSON.stringify(descriptor.buildOptions)),
            engineSha256: descriptor.files.find(file => file.path === descriptor.engineEntry.slice(2))?.sha256 })) {
        invalidPack('Runtime variant build/evidence binding mismatch.');
    }
}

export async function validateRuntimeScripts(descriptor: RuntimeDescriptor, read: (file: string, max: number) => Promise<Buffer>): Promise<void> {
    if (descriptor.variant !== 'release') return;
    for (const file of descriptor.files) {
        if (file.path.endsWith('.map') || (file.path.endsWith('.ts') && !file.path.startsWith('types/') && !file.path.startsWith('template/'))) {
            invalidPack('Release runtime contains source/debug artifacts.');
        }
        if (!file.path.endsWith('.js') || file.path.startsWith('template/')) continue;
        const bytes = await read(file.path, file.bytes);
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256
            || /sourceMappingURL\s*=|["']sourcesContent["']\s*:/.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) {
            invalidPack('Release JavaScript contains source maps or differs from its inventory.');
        }
    }
}

export function runtimeFileAllowed(file: string, target: RuntimeDescriptor['target'] = 'HTML5'): boolean {
    if (target === 'BILIBILI' || target === 'WECHAT' || target === 'BYTEDANCE') return sdkPathSchema.safeParse(file).success
        && ((bilibiliFixedFiles as readonly string[]).includes(file) || (minigameExtraFiles[target] as readonly string[]).includes(file)
        || /^assets\/internal\/import\/[a-f0-9]{2}\/[a-f0-9-]{36}\.json$/.test(file));
    if (target !== 'HTML5') return false;
    return sdkPathSchema.safeParse(file).success && (/^(?:engine\/|assets\/(?:internal|game)\/|template\/(?:src|assets|tests)\/)/.test(file)
        || ['index.html', 'boot.js', 'loader.js', 'internal-prerequisites.js', 'import-map.json', 'settings.json',
            'builtin-report.json', 'engine-build.json', 'compiler-dependencies.json', 'ENGINE-LICENSE', 'game-compiler.json',
            'game/main.js', 'game/world.js', 'template/package.json', 'template/tsconfig.json',
            'types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts'].includes(file))
        && !file.split('/').some(part => part === 'node_modules' || part.startsWith('.')) && !file.endsWith('.map');
}

export function validateMiniGameConfigs(target: 'WECHAT' | 'BYTEDANCE', game: unknown, project: unknown, appId: string): void {
    if (target !== 'WECHAT' && target !== 'BYTEDANCE') invalidPack();
    const config = z.object({ appid: version.refine(value => value.trim() === value && !!value.trim()),
        compileType: z.literal('game').optional(), miniprogramRoot: z.enum(['', '.', './']).optional(),
        gameRoot: z.enum(['', '.', './']).optional() }).passthrough().parse(project);
    z.object({ deviceOrientation: z.enum(['portrait', 'landscape']).optional(),
        openDataContext: z.literal('').optional(), plugins: z.record(z.never()).optional(),
        subpackages: z.array(z.never()).max(0).optional(), subPackages: z.array(z.never()).max(0).optional(),
    }).passthrough().parse(game);
    if (config.appid !== appId) invalidPack('Project configuration and local preflight identity disagree.');
}

export function validateRuntime(descriptor: z.infer<typeof html5RuntimeDescriptorSchema>,
    report: z.infer<typeof browserReportSchema> | z.infer<typeof browserSummarySchema>, descriptorSha256: string): void {
    validateRuntimeVariant(descriptor, report.build);
    const files = new Map(descriptor.files.map(file => [file.path, file]));
    if (new Set(descriptor.files.map(file => file.path.toLowerCase())).size !== files.size
        || files.size !== descriptor.files.length || descriptor.files.some(file => !runtimeFileAllowed(file.path) || !file.bytes)
        || descriptor.files.reduce((sum, file) => sum + file.bytes, 0) > MAX_GAME_TOTAL
        || report.profile !== descriptor.profile || report.runtimeSha256 !== descriptorSha256
        || !['2d-basic', '3d-basic'].includes(descriptor.profile) || report.initial.world3d !== (descriptor.profile === '3d-basic')
        || !['HTML5', 'BUILD'].every(key => descriptor.constants[key] === true)
        || !['NATIVE', 'JSB', 'EDITOR', 'PREVIEW', 'TEST', 'NODEJS', 'BILIBILI', 'MINIGAME', 'WECHAT'].every(key => descriptor.constants[key] === false)
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
    if ((descriptor.variant === 'release' || report.runtimeConstants) && canonical(report.runtimeConstants) !== canonical({
        CC_DEBUG: descriptor.variant === 'debug', CC_BUILD: true, CC_JSB: false, CC_EDITOR: false, CC_PREVIEW: false, CC_BILIBILI: false, CC_MINIGAME: false,
    })) invalidPack('Browser evidence does not establish the actual runtime constants.');
}

export function validateBilibiliRuntime(descriptor: BilibiliRuntimeDescriptor, report: BilibiliReport,
    descriptorSha256: string, descriptorBytes: number): void {
    bilibiliRuntimeDescriptorSchema.parse(descriptor);
    bilibiliReportSchema.parse(report);
    validateMiniGameRuntime(descriptor, report, descriptorSha256, descriptorBytes);
}

export function validateMiniGameRuntime(descriptor: MiniGameRuntimeDescriptor, report: MiniGameReport,
    descriptorSha256: string, descriptorBytes: number): void {
    runtimeDescriptorSchema.parse(descriptor);
    minigameReportSchema.parse(report);
    const { target } = descriptor;
    if (!['BILIBILI', 'WECHAT', 'BYTEDANCE'].includes(target) || report.kind !== `cocos4-${target.toLowerCase()}-local-report`) invalidPack();
    validateRuntimeVariant(descriptor, report.build);
    const files = new Map(descriptor.files.map(file => [file.path, file]));
    const assets = [...descriptor.builtins.effects, ...descriptor.builtins.materials];
    const required = [...bilibiliFixedFiles, ...minigameExtraFiles[target],
        ...assets.map(asset => `assets/internal/import/${asset.uuid.slice(0, 2)}/${asset.uuid}.json`)];
    const world3d = descriptor.profile === '3d-basic';
    const expectedLevels = Object.fromEntries([...validationLevels.slice(0, 5).map(name => [name, true]),
        ...['browserFirstFrame', 'browserInteraction', 'vendorBuild', 'device', 'portableSDK'].map(name => [name, false])]);
    if (!['2d-basic', '3d-basic'].includes(descriptor.profile) || report.profile !== descriptor.profile
        || report.runtimeSha256 !== descriptorSha256 || !Number.isSafeInteger(descriptorBytes) || descriptorBytes <= 0
        || new Set(required).size !== required.length || new Set(descriptor.files.map(file => file.path.toLowerCase())).size !== files.size
        || files.size !== descriptor.files.length || canonical([...files.keys()].sort()) !== canonical(required.sort())
        || descriptor.files.some(file => !file.bytes || !runtimeFileAllowed(file.path, target))
        || ![target, 'MINIGAME', 'BUILD'].every(key => descriptor.constants[key] === true)
        || !['HTML5', 'BILIBILI', 'WECHAT', 'WECHAT_MINI_PROGRAM', 'NATIVE', 'JSB', 'EDITOR', 'EDITOR_NOT_IN_PREVIEW', 'PREVIEW', 'TEST', 'NODEJS',
            'XIAOMI', 'ALIPAY', 'TAOBAO', 'TAOBAO_MINIGAME', 'BYTEDANCE', 'OPPO', 'VIVO', 'HUAWEI', 'MIGU', 'HONOR',
            'COCOS_RUNTIME', 'SUD', 'SUDV2', 'RUNTIME_BASED', 'SUPPORT_JIT', 'SERVER_MODE', 'DEV'].filter(key => key !== target).every(key => descriptor.constants[key] === false)
        || descriptor.constants.USE_3D !== world3d || canonical(descriptor.validationLevels) !== canonical(expectedLevels)
        || canonical(descriptor.gameCompiler.sourceFiles) !== canonical(['tools/devkit/runtime/compile-game.cjs', 'tools/devkit/runtime/files.cjs'])
        || canonical([...descriptor.typeFiles].sort()) !== canonical(['types/cc.d.ts', 'types/cc.editor.d.ts', 'types/webGPU.d.ts'].sort())
        || descriptor.builtins.reportSha256 !== files.get('builtin-report.json')?.sha256
        || files.get('types/cc.d.ts')!.bytes < 1024 * KiB || files.get('cocos-js/cc.js')!.bytes < 1024 * KiB) invalidPack();
    const features = ['base', '2d', 'ui', 'audio', 'tween', 'gfx-webgl', 'gfx-webgl2', 'legacy-pipeline',
        ...(world3d ? ['3d', 'animation', 'skeletal-animation', 'primitive'] : [])];
    if (canonical([...descriptor.features].sort()) !== canonical(features.sort())) invalidPack();
    const sharedHashes = descriptor.variant === 'release' ? bilibiliReleaseBootstrapHashes : bilibiliBootstrapHashes;
    const bootstrapHashes = target === 'BILIBILI' ? sharedHashes : { ...minigameBootstrapHashes[target][descriptor.variant],
        'loader.js': sharedHashes['loader.js'], 'import-map.json': sharedHashes['import-map.json'], 'internal-prerequisites.js': sharedHashes['internal-prerequisites.js'] };
    for (const [file, sha256] of Object.entries(bootstrapHashes)) {
        if (files.get(file)?.sha256 !== sha256) invalidPack(`${target} bootstrap source pin mismatch.`);
    }
    for (const name of ['tile.png', 'click.wav', 'rules.json']) {
        if (files.get(`template/assets/${name}`)?.sha256 !== files.get(`assets/game/${name}`)?.sha256) invalidPack();
    }
    const total = descriptor.files.reduce((sum, file) => sum + file.bytes, descriptorBytes);
    const preflight = report.evidence.preflight;
    const warnings = [...(total > 4 * 1024 * KiB ? ['main: source files exceed 4 MiB; check the vendor-compiled package size.'] : []),
        ...(total > 30 * 1024 * KiB ? ['Source files exceed 30 MiB total; check the vendor-compiled package size.'] : [])];
    if (total > MAX_GAME_TOTAL || preflight.totalBytes !== total || preflight.packages[0].bytes !== total
        || (report.kind === 'cocos4-bilibili-local-report' && (report.evidence.preflight.appId !== 'cocos4-local-validation-only'
            || report.evidence.preflight.version !== '0.0.0-local-validation'))
        || (report.kind !== 'cocos4-bilibili-local-report' && report.evidence.preflight.target !== target)
        || canonical(preflight.warnings) !== canonical(warnings)) invalidPack();
    const loaded = ['game.js', 'web-adapter.js', 'fs-utils.js', 'loader.js', 'application.js', 'cocos-js/cc.js', 'engine-adapter.js', 'game/main.js', 'game/world.js'];
    const minigameLoaded = [...loaded, ...(target === 'BYTEDANCE'
        ? ['assets/internal/index.js', 'internal-prerequisites.js']
        : ['game.json', 'import-map.json', 'game-compiler.json', 'builtin-report.json', 'assets/internal/index.js'])].sort();
    for (const evidence of [report.evidence.shared, report.evidence.distinct]) {
        if (evidence.probe.world3d !== world3d || evidence.loaded[0] !== 'game.js'
            || (target === 'BILIBILI' ? canonical(evidence.loaded) !== canonical(loaded)
                : canonical([...evidence.loaded].sort()) !== canonical(minigameLoaded))) invalidPack();
        if ('reads' in evidence || 'fileReads' in evidence) {
            const reads = 'reads' in evidence ? evidence.reads : evidence.fileReads;
            const cache = `${target === 'WECHAT' ? 'wx' : 'tt'}file://mock-user/gamecaches/cacheList.json`;
            const requiredReads = ['settings.json', 'assets/internal/config.json', 'assets/game/rules.json',
                ...(target === 'WECHAT' ? assets.map(asset => `assets/internal/import/${asset.uuid.slice(0, 2)}/${asset.uuid}.json`) : [])];
            if (!requiredReads.every(file => reads.includes(file))
                || reads.some(file => file !== cache && file !== 'assets/game/intentionally-missing.png' && !files.has(file))) invalidPack();
        }
    }
    const edges = [ ...(target === 'BILIBILI' ? [['application.js', 'game/main.js'], ['engine-adapter.js', 'fs-utils.js']]
        : [['application.js', 'game-compiler.json'], ['application.js', 'builtin-report.json'], ['application.js', 'game/main.js'],
            ['fs-utils.js', target === 'WECHAT' ? 'web-adapter.js' : 'engine-adapter.js']]), ['game/main.js', 'cocos-js/cc.js'],
        ['game/main.js', 'game/world.js'], ...(world3d ? [['game/world.js', 'cocos-js/cc.js']] : []),
        ...['game.json', 'web-adapter.js', ...(target === 'WECHAT' ? ['fs-utils.js'] : []), 'loader.js', 'import-map.json',
            'application.js', 'cocos-js/cc.js', 'engine-adapter.js', ...(target === 'BYTEDANCE' ? ['fs-utils.js'] : [])].map(to => ['game.js', to]),
        ...(target === 'BILIBILI' ? [['web-adapter.js', 'fs-utils.js']] : []) ].map(([from, to]) => ({ from, to }));
    const closure = report.evidence.closure;
    if (canonical(closure.moduleEdges) !== canonical(edges) || closure.parsedScripts !== 11 || closure.systemModules !== 5
        || closure.resourceCount !== assets.length + 5 || closure.requiredCCExportCount !== descriptor.tools.requiredCCExports.length
        || new Set(descriptor.tools.requiredCCExports).size !== descriptor.tools.requiredCCExports.length
        || closure.builtinEffects !== descriptor.builtins.effects.length || closure.builtinMaterials !== descriptor.builtins.materials.length
        || canonical(report.evidence.failures.map(item => item.fault)) !== canonical(target === 'WECHAT' ? wechatFaults : target === 'BYTEDANCE' ? bytedanceFaults : localFaults)
        || report.evidence.failures.some(item => item.errors.some(error => !error.startsWith(`[${target}] Game startup failed: `)))) invalidPack();
    if (report.kind === 'cocos4-wechat-local-report' && (report.evidence.closure.compiledGlobals.CC_DEBUG !== (descriptor.variant === 'debug')
        || report.evidence.failures.some(item => item.loaded.some(file => !files.has(file))))) invalidPack();
    for (const failure of report.evidence.failures) {
        if ('initCalls' in failure || 'initCount' in failure) {
            const beforeInit = ['missing-host', 'missing-fs', 'missing-export', 'missing-game-config', 'invalid-game-config', 'web-adapter', 'loader', 'engine-adapter'].includes(failure.fault);
            const ran = ['run', 'start-sync', 'start-async', 'missing-asset'].includes(failure.fault);
            if (('initCalls' in failure ? failure.initCalls : failure.initCount) !== Number(!beforeInit)
                || ('runCalls' in failure ? failure.runCalls : failure.runCount) !== Number(ran)) invalidPack();
        }
    }
}

export async function loadSdk(root: string): Promise<Sdk> {
    try {
        if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) invalidPack();
        root = path.resolve(root);
        for (let current = root;; current = path.dirname(current)) {
            if (!(await lstat(current)).isDirectory()) invalidPack();
            if (current === path.dirname(current)) break;
        }
        const resolvedRoot = await realpath(root);
        if (process.platform !== 'win32' && resolvedRoot !== root) invalidPack();
        root = resolvedRoot;
        // NTFS file indexes can exceed Number.MAX_SAFE_INTEGER. Preserve every
        // identity bit when checking a file before/after reads and during walks.
        const observed = new Map<string, BigIntStats>();
        observed.set(root, await lstat(root, { bigint: true }));
        const readFile = async (relative: string, maxBytes: number, retain = true): Promise<Buffer> => {
            if (!sdkPathSchema.safeParse(relative).success) invalidPack();
            const absolute = path.join(root, relative);
            const before = await lstat(absolute, { bigint: true });
            if (!before.isFile() || before.nlink !== 1n || before.size > maxBytes || await realpath(absolute) !== absolute) invalidPack();
            const previous = observed.get(absolute);
            if (previous && (previous.dev !== before.dev || previous.ino !== before.ino || previous.size !== before.size
                || previous.mtimeNs !== before.mtimeNs || previous.ctimeNs !== before.ctimeNs)) invalidPack();
            const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const opened = await handle.stat({ bigint: true });
                if (!opened.isFile() || opened.nlink !== 1n || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) invalidPack();
                const size = Number(before.size);
                const buffer = Buffer.alloc(retain ? size + 1 : 64 * KiB);
                const checksum = createHash('sha256');
                let length = 0;
                while (length <= size) {
                    const start = retain ? length : 0;
                    const { bytesRead } = await handle.read(buffer, start, Math.min(buffer.length - start, size + 1 - length), null);
                    if (!bytesRead) break;
                    if (!retain) checksum.update(buffer.subarray(0, bytesRead));
                    length += bytesRead;
                }
                const after = await handle.stat({ bigint: true });
                if (length !== size || after.nlink !== 1n || after.size !== before.size
                    || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) invalidPack();
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
            const stat = await lstat(absolute, { bigint: true });
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
            if (observed.get(path.join(root, file.path))!.size !== BigInt(file.bytes)
                || (text ? bytes.length !== file.bytes || hash(bytes) !== file.sha256 : bytes.toString('hex') !== file.sha256)) invalidPack();
            if (text) {
                const decoded = decode(bytes);
                if (file.path.startsWith('docs/')) content.set(file.path, decoded);
            }
        }
        const sourceFiles = new Map(manifest.source.files.map(file => [file.path, file]));
        const validatorFiles = [['LICENSE', 'LICENSE'], ['app/validate-bilibili.cjs', 'scripts/validate-bilibili.cjs'],
            ...(sourceFiles.has('scripts/validate-minigame.cjs') ? [['app/validate-minigame.cjs', 'scripts/validate-minigame.cjs']] : [])];
        for (const [destination, source] of validatorFiles) {
            const file = files.get(destination);
            const original = sourceFiles.get(source as z.infer<typeof sourcePathSchema>);
            if (!file || file.sha256 !== original?.sha256 || file.bytes !== original.bytes) invalidPack();
        }
        const referenced = new Set(validatorFiles.map(([destination]) => destination));
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
        let indexedDocuments: IndexedDocument[] = [];
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
                || canonical(base.capabilities.packageValidation) !== canonical(manifest.capabilities.packageValidation)
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
                const reportPath = profile.target === 'HTML5' ? profile.browserReport : profile.localReport;
                if (profile.directory !== directory || profile.descriptor !== `${directory}/runtime.json`
                    || profile.exports !== `${directory}/cc-exports.json`
                    || reportPath !== `${directory}/evidence/${profile.target === 'HTML5' ? 'browser' : 'local'}-report.json`
                    || canonical(profile.validationLevels) !== canonical(runtimeValidationLevels[profile.target])) invalidPack();
                const descriptor = runtimeDescriptorSchema.parse(await json(profile.descriptor));
                let localReport: MiniGameReport | undefined;
                if (profile.target === 'HTML5') {
                    if (descriptor.target !== 'HTML5') invalidPack();
                    const value = await json(profile.browserReport);
                    const summary = (value as { kind?: unknown })?.kind === 'cocos4-browser-validation-summary';
                    const report = summary ? browserSummarySchema.parse(value) : browserReportSchema.parse(value);
                    validateRuntime(descriptor, report, files.get(profile.descriptor)!.sha256);
                    unique(report.screenshots.map(file => file.path));
                    for (const screenshot of summary ? [] : browserReportSchema.parse(value).screenshots) {
                        const name = `${directory}/evidence/${screenshot.path}`;
                        if (!screenshot.path.endsWith('.png') || files.get(name)?.sha256 !== screenshot.sha256) invalidPack();
                        const image = await readFile(name, 16 * 1024 * KiB);
                        if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                            || image.readUInt32BE(16) !== screenshot.width || image.readUInt32BE(20) !== screenshot.height) invalidPack();
                        referenced.add(name);
                    }
                } else {
                    if (descriptor.target !== profile.target) invalidPack();
                    localReport = minigameReportSchema.parse(await json(profile.localReport));
                    validateMiniGameRuntime(descriptor, localReport, files.get(profile.descriptor)!.sha256, files.get(profile.descriptor)!.bytes);
                }
                if (descriptor.engineVersion !== manifest.engineVersion || descriptor.profile !== profile.id || descriptor.variant !== profile.variant
                    || canonical(descriptor.features) !== canonical(profile.features) || descriptor.rootLockSha256 !== closure.rootLockSha256
                    || descriptor.gameCompiler.dependencyCount !== closure.packages.length) invalidPack();
                bind(directory, descriptor.files);
                await validateRuntimeScripts(descriptor, (file, max) => readFile(`${directory}/${file}`, max));
                if (files.get(`${directory}/compiler-dependencies.json`)?.sha256 !== files.get(development.dependencies)?.sha256) invalidPack();
                if (descriptor.target !== 'HTML5') {
                    const builtin = z.object({ profile: id, features: z.array(id), effects: z.array(z.unknown()), materials: z.array(z.unknown()),
                        files: z.array(inventoryFileSchema).max(1024) }).passthrough().parse(await json(`${directory}/builtin-report.json`));
                    const assetFiles = builtin.files.filter(file => file.path.startsWith('assets/'));
                    bind(directory, assetFiles);
                    const uuids = [...descriptor.builtins.effects, ...descriptor.builtins.materials].map(asset => asset.uuid).sort();
                    const settings = z.object({ engine: z.object({ builtinAssets: z.array(z.string().uuid()) }).passthrough(),
                        assets: z.object({ projectBundles: z.array(id) }).passthrough() }).passthrough().parse(await json(`${directory}/settings.json`));
                    const config = z.object({ uuids: z.array(z.string().uuid()), importBase: z.literal('import'),
                        isZip: z.literal(false).optional() }).passthrough().parse(await json(`${directory}/assets/internal/config.json`));
                    if (builtin.profile !== descriptor.profile || canonical(builtin.features) !== canonical(descriptor.features)
                        || canonical(builtin.effects) !== canonical(descriptor.builtins.effects) || canonical(builtin.materials) !== canonical(descriptor.builtins.materials)
                        || canonical(assetFiles.map(file => file.path).sort()) !== canonical(descriptor.files.filter(file => file.path.startsWith('assets/internal/')).map(file => file.path).sort())
                        || canonical([...settings.engine.builtinAssets].sort()) !== canonical(uuids) || canonical([...config.uuids].sort()) !== canonical(uuids)
                        || canonical(settings.assets.projectBundles) !== canonical(['internal'])) invalidPack();
                    const build = await json(`${directory}/engine-build.json`);
                    if (canonical(build) !== canonical({ chunkAliases: {}, exports: { cc: 'cc.js' }, chunkDepGraph: { 'cc.js': [] },
                        assetDepGraph: { 'cc.js': [] }, hasCriticalWarns: false, dependencyGraph: { 'cc.js': [] } })) invalidPack();
                    const { ccbuild: _ccbuild, moduleSystem: _moduleSystem, loaderPlatform: _loaderPlatform, ...gameTools } = descriptor.tools;
                    if (canonical(await json(`${directory}/game-compiler.json`)) !== canonical(gameTools)) invalidPack();
                    if (descriptor.target !== 'BILIBILI') {
                        // These root configs belong to the profile inventory, but
                        // project builds replace them with mutable game metadata.
                        if (!localReport || localReport.kind === 'cocos4-bilibili-local-report') invalidPack();
                        validateMiniGameConfigs(descriptor.target, await json(`${directory}/game.json`, 32 * KiB),
                            await json(`${directory}/project.config.json`, 32 * KiB), localReport.evidence.preflight.appId);
                        if (descriptor.target === 'BYTEDANCE') {
                            z.object({ name: z.literal('@cocos/engine-platforms'), version: z.literal('1.0.6'), license: z.literal('UNLICENSED') })
                                .passthrough().parse(await json(`${directory}/licenses/bytedance/package.json`, 32 * KiB));
                            if (files.get(`${directory}/licenses/bytedance/ENGINE-LICENSE`)?.sha256 !== files.get(`${directory}/ENGINE-LICENSE`)?.sha256) invalidPack();
                        }
                    }
                }
                const exports = exportInventorySchema.parse(await json(profile.exports));
                if (new Set(exports.names).size !== exports.names.length) invalidPack();
                const requiredExports = [...descriptor.tools.requiredCCExports,
                    ...(['WECHAT', 'BYTEDANCE'].includes(descriptor.target) ? ['game', 'assetManager', 'Material', 'isValid'] : []),
                    ...(descriptor.target === 'WECHAT' ? ['cclegacy'] : [])];
                if (exports.engineSha256 !== files.get(`${directory}/${descriptor.engineEntry.slice(2)}`)?.sha256
                    || (localReport && localReport.evidence.closure.engineExportCount !== exports.names.length)
                    || requiredExports.some(name => !exports.names.includes(name))) invalidPack();
                profiles.set(`${profile.target}/${profile.id}/${profile.variant}`, freeze({ ...descriptor,
                    directory: path.join(root, directory), descriptor, ccExports: exports.names, typesDirectory: path.join(root, directory, 'types') }) as SdkProfile);
                if (!manifest.catalog.templates.some(template => template.profile === profile.id && template.target === profile.target
                    && template.variant === profile.variant && template.directory === `${directory}/template`)) invalidPack();
            }
            for (const template of manifest.catalog.templates) {
                const profile = manifest.catalog.profiles.find(profile => profile.id === template.profile && profile.target === template.target && profile.variant === template.variant);
                if (!profile || template.directory !== `${profile.directory}/template`
                    || template.id !== `${template.target === 'HTML5' ? '' : `${template.target.toLowerCase()}-`}${template.profile}${template.variant === 'release' ? '-release' : ''}-starter`) invalidPack();
            }
            for (const platform of manifest.catalog.platforms) {
                const available = manifest.catalog.profiles.some(profile => profile.target === platform.id);
                if (platform.prebuiltAvailable !== available || platform.exportAvailable !== available
                    || canonical(platform.validationLevels) !== canonical(available ? runtimeValidationLevels[platform.id as RuntimeDescriptor['target']] : [])) invalidPack();
            }
            for (const feature of manifest.catalog.features) {
                if (feature.prebuiltAvailable !== manifest.catalog.profiles.some(profile => profile.features.includes(feature.id))) invalidPack();
            }
            if (manifest.catalog.profiles.some(profile => !manifest.catalog.platforms.some(platform => platform.id === profile.target)
                || profile.features.some(id => !manifest.catalog.features.some(feature => feature.id === id)))) invalidPack();
        }
        if (manifest.apiIndex) {
            const descriptor = manifest.apiIndex;
            const file = files.get(descriptor.path);
            if (!file || file.bytes !== descriptor.bytes || file.sha256 !== descriptor.sha256) invalidPack();
            const index = apiIndexSchema.parse(parseJson(decode(await readFile(descriptor.path, MAX_API_INDEX_BYTES))));
            const generated = await generateApiIndex({ profiles: manifest.catalog.profiles.map(profile => ({ ...profile,
                engineEntry: profiles.get(`${profile.target}/${profile.id}/${profile.variant}`)!.engineEntry })), templates: manifest.catalog.templates,
                files: manifest.files, read: readFile });
            if (hash(JSON.stringify(index)) !== hash(JSON.stringify(generated.index))
                || descriptor.symbols !== index.entries.filter(entry => entry.kind === 'api').length
                || descriptor.examples !== index.entries.filter(entry => entry.kind === 'example').length) invalidPack();
            unique([...manifest.docs.map(doc => doc.id), ...index.entries.map(entry => entry.id)]);
            indexedDocuments = generated.documents;
            referenced.add(descriptor.path);
        }
        if (referenced.size !== files.size) invalidPack();
        for (const [absolute, before] of observed) {
            const after = await lstat(absolute, { bigint: true });
            if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
                || after.nlink !== before.nlink || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
                || await realpath(absolute) !== absolute) invalidPack();
        }
        return makeSdk(root, manifest, content, profiles, indexedDocuments);
    } catch (error) {
        if (error instanceof AppError) throw error;
        invalidPack();
    }
}

function makeSdk(root: string, manifest: z.infer<typeof manifestSchema>, content: Map<string, string>, profiles: Map<string, SdkProfile>, indexedDocuments: IndexedDocument[]): Sdk {
    const { sdkId } = manifest;
    freeze(manifest);
    const secret = randomBytes(32);
    const summary = sdkSummarySchema.parse({
        sdkId, schemaVersion: 1, kind: manifest.kind, engineVersion: manifest.engineVersion,
        description: manifest.description, capabilities: manifest.capabilities, sourceSha256: manifest.source.sha256,
        attribution: manifest.source.attribution, fileCount: manifest.files.length, documentCount: manifest.docs.length + indexedDocuments.length,
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
    const guideAnchors = new Map<string, z.infer<typeof sourceRangeSchema>>();
    for (const source of manifest.source.files) {
        const chunks = manifest.docs.filter(doc => doc.sourcePath === source.path).sort((a, b) => a.sourceOffset - b.sourceOffset);
        let line = 1;
        let column = 1;
        for (const doc of chunks) {
            const start = { offsetBytes: doc.sourceOffset, line, column };
            const text = content.get(doc.path)!;
            const lines = text.split('\n');
            line += lines.length - 1;
            column = [...lines.at(-1)!].length + (lines.length === 1 ? column : 1);
            guideAnchors.set(doc.id, { path: source.path, sha256: source.sha256, start,
                end: { offsetBytes: doc.sourceOffset + Buffer.byteLength(text), line, column } });
        }
    }
    const indexed = new Map(indexedDocuments.map(doc => [doc.entry.id, doc]));
    const metadata = (doc: IndexedDocument, profile?: string) => ({ ...(doc.entry.api ? { api: doc.entry.api,
        runtimeAvailability: doc.availability.filter(item => !profile || item.profile === profile) } : {}),
    ...(doc.entry.example ? { example: doc.entry.example } : {}) });
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
                reason: available ? manifest.development ? 'Only delivered target/profile/variant combinations are available. exportAvailable means source-game-package assembly, not vendor compilation or device certification.'
                    : 'Source catalog only; target-specific feature combinations and game capabilities are not delivered.'
                    : manifest.development ? 'No prebuilt profiles or runnable templates are delivered for the requested target.'
                        : 'No prebuilt profiles or runnable templates are delivered. This pack has no game development capability.',
                items: [], nextCursor: null,
            }));
        },
        search(args) {
            const query = input(z.object({ query: z.string().min(1).max(256).refine(value => value.trim().length > 0
                && Buffer.from(value).toString('utf8') === value),
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
            for (const doc of indexedDocuments) {
                if (query.kind !== 'all' && query.kind !== doc.entry.kind) continue;
                if (!doc.text.includes(query.query) && !doc.entry.title.includes(query.query)) continue;
                if (query.profile && (doc.entry.example ? doc.entry.example.profile !== query.profile
                    : !doc.availability.some(item => item.profile === query.profile && item.status !== 'export-absent'))) continue;
                // Match within actual source slices, never across synthetic joins.
                let found = -1;
                let source: z.infer<typeof sourceRangeSchema> | undefined;
                for (const anchor of doc.anchors) {
                    const slice = Buffer.from(doc.text).subarray(anchor.documentOffsetBytes, anchor.documentOffsetBytes + anchor.lengthBytes).toString('utf8');
                    const at = slice.indexOf(query.query);
                    if (at < 0) continue;
                    const locate = (end: number) => {
                        const before = slice.slice(0, end);
                        const lines = before.split('\n');
                        return { offsetBytes: anchor.source.start.offsetBytes + Buffer.byteLength(before),
                            line: anchor.source.start.line + lines.length - 1,
                            column: [...lines.at(-1)!].length + (lines.length === 1 ? anchor.source.start.column : 1) };
                    };
                    source = { path: anchor.source.path, sha256: anchor.source.sha256, start: locate(at), end: locate(at + query.query.length) };
                    found = Buffer.from(doc.text).subarray(0, anchor.documentOffsetBytes).toString('utf8').length + at;
                    break;
                }
                if (found < 0 && !doc.entry.title.includes(query.query)) continue;
                const before = doc.text.slice(0, Math.max(0, found));
                items.push({ documentId: doc.entry.id, kind: doc.entry.kind, title: doc.entry.title, engineVersion: manifest.engineVersion,
                    summary: bytePrefix(doc.text.slice(Math.max(0, found)), 512), requiredFeatures: [], ...metadata(doc, query.profile),
                    matches: found < 0 ? [] : [{ line: before.split('\n').length,
                        column: [...before.slice(before.lastIndexOf('\n') + 1)].length + 1, source }] });
            }
            return searchSchema.parse(paginate(items, offset(query.cursor, condition, items.length), query.limit, condition, {
                query: query.query, kind: query.kind, profile: query.profile ?? null,
                availableKinds: indexedDocuments.length ? ['guide', 'api', 'example'] : ['guide'], items: [], nextCursor: null,
            }));
        },
        read(args) {
            const query = input(z.object({ documentId: documentIdSchema, cursor: cursorSchema.optional(),
                maxBytes: z.number().int().min(4).max(MAX_DOCUMENT).default(8 * KiB) }).strict(), args);
            const doc = documents.get(query.documentId);
            const apiDoc = indexed.get(query.documentId);
            if (!doc && !apiDoc) throw new AppError('INVALID_ARGUMENTS', 'The document ID is not in this SDK.');
            const text = apiDoc ? apiDoc.text : content.get(doc!.path)!;
            const bytes = Buffer.from(text);
            const condition = binding({ operation: 'read', documentId: query.documentId, maxBytes: query.maxBytes });
            const start = offset(query.cursor, condition, bytes.length);
            if ((bytes[start] & 0xc0) === 0x80) throw new AppError('CURSOR_INVALID', 'The cursor is not a UTF-8 boundary.');
            let budget = query.maxBytes;
            for (;;) {
                const chunk = bytePrefix(bytes.subarray(start).toString('utf8'), budget);
                const end = start + Buffer.byteLength(chunk);
                const result = { documentId: query.documentId, kind: apiDoc?.entry.kind ?? 'guide', title: apiDoc?.entry.title ?? doc!.title, engineVersion: manifest.engineVersion,
                    content: chunk, offsetBytes: start, totalBytes: bytes.length, sha256: hash(text),
                    ...(apiDoc ? { ...metadata(apiDoc), anchors: apiDoc.anchors.filter(anchor => anchor.documentOffsetBytes < end
                        && anchor.documentOffsetBytes + anchor.lengthBytes > start) }
                        : { anchors: [{ documentOffsetBytes: 0, lengthBytes: bytes.length, role: 'source' as const, source: guideAnchors.get(doc!.id)! }] }),
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
