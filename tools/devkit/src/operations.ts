import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { AppError, reportSchema, type Report, type WorkerRequest } from './contracts.js';
import { loadSdk } from './sdk.js';
import { inspectProject, readSdkValidator, validateRelativePath, withPackageSnapshot } from './workspace.js';

const roots = { workspace: z.string().min(1).max(4096), sdkRoot: z.string().min(1).max(4096), staging: z.string().min(1).max(4096) };
const requestSchema = z.discriminatedUnion('operation', [
    z.object({ ...roots, operation: z.literal('doctor'), input: z.object({
        project: z.string().min(1).max(1024).optional(), depth: z.enum(['quick', 'full']).default('quick'),
    }).strict() }).strict(),
    z.object({ ...roots, operation: z.literal('package_validate'), input: z.object({
        directory: z.string().min(1).max(1024), target: z.literal('BILIBILI').default('BILIBILI'),
    }).strict() }).strict(),
]);
const require = createRequire(import.meta.url);
const text = (value: string, length = 512): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length);

type BilibiliResult = { packages: { name: string; root: string; bytes: number }[]; totalBytes: number; warnings: string[] };

export async function runOperation(request: WorkerRequest, log: (text: string) => void = () => {}): Promise<Report> {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) throw new AppError('INVALID_ARGUMENTS', 'Invalid read-only worker operation arguments.');
    const args = parsed.data;
    const relative = args.operation === 'doctor' ? args.input.project : args.input.directory;
    if (relative !== undefined) validateRelativePath(relative);
    log('Verifying the read-only SDK manifest and packaged payload hashes.');
    const sdk = await loadSdk(args.sdkRoot);
    const validator = sdk.manifest.files.find((file) => file.path === 'app/validate-bilibili.cjs');
    if (!validator) throw new AppError('SDK_INCOMPLETE', 'The SDK manifest does not contain the packaged Bilibili validator.');
    const validatorBytes = await readSdkValidator(sdk.root, validator.sha256);

    if (args.operation === 'doctor') {
        const report: Report = {
            summary: 'Read-only SDK catalog verified. This is not a portable game-development release.',
            items: [
                { name: 'SDK manifest', status: 'passed', message: `Schema and payload SHA-256 integrity verified for ${sdk.sdkId}. Hashes are not provenance authentication.` },
                { name: 'SDK scope', status: 'info', message: 'Readonly source catalog, selected source guides and Bilibili package preflight only.' },
                { name: 'Engine catalog', status: 'info', message: `${sdk.manifest.catalog.platforms.length} source targets and ${sdk.manifest.catalog.features.length} source features; catalog entries are not delivered engine binaries.` },
                { name: 'Game development', status: 'warning', code: 'PROFILE_NOT_AVAILABLE', message: 'No prebuilt profiles, runnable templates, game build, preview, export or vendor publishing capability is established.' },
                { name: 'Host filesystem', status: 'passed', message: 'Linux pinned-descriptor, no-follow reads verified for the packaged validator.' },
            ],
            validationLevels: ['manifest-schema', 'payload-sha256', 'linux-pinned-reads'],
        };
        if (args.input.project !== undefined) {
            log('Inspecting bounded project data without resolving dependencies or running scripts.');
            const inspection = await inspectProject(args.workspace, args.input.project);
            report.items.push({ name: 'Project inspection', status: inspection.complete ? 'info' : 'warning', bytes: inspection.bytes,
                message: `${inspection.files} regular files inspected; kind ${inspection.kind}. Both doctor depths retain the 1000-entry, 8 MiB, 5-second project inspection bound.` });
            for (const diagnostic of inspection.diagnostics) report.items.push({
                name: diagnostic.file ?? diagnostic.code, code: diagnostic.code,
                status: diagnostic.severity === 'error' ? 'failed' : diagnostic.severity === 'warning' ? 'warning' : 'info',
                message: diagnostic.message,
            });
            report.validationLevels.push(inspection.complete ? 'bounded-project-data' : 'partial-project-data');
        }
        return reportSchema.parse(report);
    }

    const stageRelative = path.relative(sdk.root, path.resolve(args.staging));
    if (!stageRelative || (!stageRelative.startsWith(`..${path.sep}`) && stageRelative !== '..' && !path.isAbsolute(stageRelative))) {
        throw new AppError('PERMISSION_DENIED', 'Job staging must not write into the read-only SDK.');
    }
    log('Snapshotting regular package files into private tool state before validation.');
    return withPackageSnapshot(args.workspace, args.input.directory, args.staging, validatorBytes, (snapshot, script) => {
        // Requiring the verified private copy avoids a hash-then-require race on
        // the mutable SDK pathname. The project is never a module resolution root.
        const module: unknown = require(script);
        if (!module || typeof module !== 'object' || !('validateBilibili' in module) || typeof module.validateBilibili !== 'function') {
            throw new AppError('SDK_INCOMPLETE', 'The packaged validator does not export validateBilibili.');
        }
        let validation: BilibiliResult;
        try { validation = module.validateBilibili(snapshot) as BilibiliResult; }
        catch (error) {
            throw new AppError('ARTIFACT_INVALID', error instanceof Error ? text(error.message, 1024) : 'Bilibili package validation failed.',
                ['Correct the package data and retry validation. No project scripts were executed.']);
        } finally { delete require.cache[script]; }
        const report: Report = {
            summary: 'Bilibili source-package preflight passed on a bounded private snapshot. Vendor compilation, publishing and runtime behavior remain unverified.',
            items: [{ name: 'BILIBILI package', status: 'passed', bytes: validation.totalBytes,
                message: 'The canonical packaged validator accepted the snapshot structure, configuration and source sizes.' }],
            validationLevels: ['manifest-sha256', 'bounded-private-snapshot', 'bilibili-source-preflight', 'input-change-detection'],
        };
        for (const item of validation.packages.slice(0, 32)) report.items.push({ name: text(item.name, 256), status: 'info', bytes: item.bytes,
            message: 'Source bytes only, not vendor-compiled package size.' });
        for (const warning of validation.warnings.slice(0, 32)) report.items.push({ name: 'Package size warning', status: 'warning', message: text(warning) });
        if (validation.packages.length > 32 || validation.warnings.length > 32) report.items.push({ name: 'Report bound', status: 'warning', code: 'LIMIT_EXCEEDED',
            message: 'All files were validated; the report includes only the first 32 packages and 32 size warnings.' });
        log('Canonical preflight completed; checking the snapshot and original inputs again before returning success.');
        return reportSchema.parse(report);
    });
}
