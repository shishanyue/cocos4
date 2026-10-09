import { createRequire } from 'node:module';
import path from 'node:path';
import { AppError, authorize, parseWorkerRequest, permissionsSchema, reportSchema, type ExecuteLogic, type Report, type WorkerRequest } from './contracts.js';
import { runGameOperation } from './game.js';
import { loadSdk, type Sdk } from './sdk.js';
import { inspectProject, readSdkValidator, validateRelativePath, withPackageSnapshot } from './workspace.js';

const require = createRequire(import.meta.url);
const text = (value: string, length = 512): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length);

type PackageResult = { target?: string; packages: { name: string; root: string; bytes: number }[]; totalBytes: number; warnings: string[] };

function validatorPath(target: 'BILIBILI' | 'WECHAT' | 'BYTEDANCE'): string {
    return target === 'BILIBILI' ? 'app/validate-bilibili.cjs' : 'app/validate-minigame.cjs';
}

// The caller loads/verifies the SDK. These diagnostics need no workspace, job or writable state.
export async function diagnoseSdk(sdk: Sdk): Promise<Report> {
    for (const filename of new Set(sdk.manifest.capabilities.packageValidation.map(validatorPath))) {
        const validator = sdk.manifest.files.find(file => file.path === filename);
        if (!validator) throw new AppError('SDK_INCOMPLETE', 'The SDK manifest does not contain a required packaged validator.');
        await readSdkValidator(sdk.root, validator.sha256, path.basename(filename));
    }
    return reportSchema.parse({
        summary: sdk.toolchainRoot
            ? 'SDK integrity and host read checks passed. Delivered game profiles are present; release, browser and vendor acceptance are separate.'
            : 'Read-only SDK catalog integrity and host read checks passed. This is not a portable game-development release.',
        items: [
            { name: 'SDK manifest', status: 'passed', message: `Schema and payload SHA-256 integrity verified for ${sdk.sdkId}. Hashes are not provenance authentication.` },
            { name: 'SDK scope', status: 'info', message: sdk.toolchainRoot
                ? 'Verified game profiles and compiler; startup permissions govern project development and loopback preview.'
                : 'Readonly source catalog, selected source guides and the advertised mini-game package preflight only.' },
            { name: 'Engine catalog', status: 'info', message: `${sdk.manifest.catalog.platforms.length} source targets and ${sdk.manifest.catalog.features.length} source features; catalog entries alone are not delivered engine binaries.` },
            sdk.toolchainRoot
                ? { name: 'Game development', status: 'info', message: `${sdk.manifest.catalog.profiles.length} delivered profiles and ${sdk.manifest.catalog.templates.length} templates verified. They support template creation, strict type checks and game builds. Preview is HTML5-only; mini-game source preflight requires platform configuration. Vendor publishing is not validated.` }
                : { name: 'Game development', status: 'warning', code: 'PROFILE_NOT_AVAILABLE', message: 'No prebuilt profiles, runnable templates, game build, preview, export or vendor publishing capability is established.' },
            { name: 'Host filesystem', status: 'passed', message: 'Linux pinned-descriptor, no-follow reads verified for the packaged validator.' },
            { name: 'Host runtime', status: 'info', message: `Running Node ${process.version} on ${process.platform}/${process.arch}. Read checks do not establish publisher/supervisor kernel support, browser availability or supported-host acceptance.` },
        ],
        validationLevels: ['manifest-schema', 'payload-sha256', 'linux-pinned-reads'],
    });
}

export async function runOperation(request: WorkerRequest, log: (text: string) => void = () => {}, executeLogic?: ExecuteLogic): Promise<Report> {
    const args = parseWorkerRequest(request);
    authorize(args, permissionsSchema.parse(args.permissions ?? {}));
    const relative = 'project' in args.input ? args.input.project : 'directory' in args.input ? args.input.directory : undefined;
    if (relative !== undefined) validateRelativePath(relative);
    log('Verifying the read-only SDK manifest and packaged payload hashes.');
    const sdk = await loadSdk(args.sdkRoot);
    if (args.expectedSdkId !== undefined && args.expectedSdkId !== sdk.sdkId) throw new AppError('SDK_INCOMPLETE', 'SDK changed after job admission.');
    if (args.operation !== 'doctor' && args.operation !== 'package_validate') return runGameOperation(args, sdk, log, executeLogic);
    if (args.operation === 'doctor') {
        const report = await diagnoseSdk(sdk);
        report.items.push({ name: 'Test execution', status: 'info', message: args.permissions?.executeTests
            ? 'Startup explicitly trusts pure logic tests. The fixed Linux supervisor manages process lifetime, not a sandbox: child code can access host files, spawn processes and use the network.'
            : 'Project code execution is disabled. Enable --execute-tests true with develop only for trusted projects; MCP arguments cannot grant it.' });
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

    const target = args.input.target;
    if (!sdk.manifest.capabilities.packageValidation.some(value => value === target)) {
        throw new AppError('PROFILE_NOT_AVAILABLE', 'This SDK does not provide the requested source-package validator.');
    }
    const validator = sdk.manifest.files.find((file) => file.path === validatorPath(target));
    if (!validator) throw new AppError('SDK_INCOMPLETE', `The SDK manifest does not contain ${validatorPath(target)}.`);
    const validatorBytes = await readSdkValidator(sdk.root, validator.sha256, path.basename(validator.path));
    const stageRelative = path.relative(sdk.root, path.resolve(args.staging));
    if (!stageRelative || (!stageRelative.startsWith(`..${path.sep}`) && stageRelative !== '..' && !path.isAbsolute(stageRelative))) {
        throw new AppError('PERMISSION_DENIED', 'Job staging must not write into the read-only SDK.');
    }
    log('Snapshotting regular package files into private tool state before validation.');
    return withPackageSnapshot(args.workspace, args.input.directory, args.staging, validatorBytes, (snapshot, script) => {
        // Requiring the verified private copy avoids a hash-then-require race on
        // the mutable SDK pathname. The project is never a module resolution root.
        const loaded: unknown = require(script);
        const exportName = target === 'BILIBILI' ? 'validateBilibili' : 'validateMiniGame';
        const module = loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : undefined;
        if (!module || typeof module[exportName] !== 'function') {
            throw new AppError('SDK_INCOMPLETE', `The packaged validator does not export ${exportName}.`);
        }
        let validation: PackageResult;
        try {
            validation = (target === 'BILIBILI' ? module[exportName](snapshot) : module[exportName](snapshot, target)) as PackageResult;
        }
        catch (error) {
            throw new AppError('ARTIFACT_INVALID', error instanceof Error ? text(error.message, 1024) : `${target} package validation failed.`,
                ['Correct the package data and retry validation. No project scripts were executed.']);
        } finally { delete require.cache[script]; }
        const report: Report = {
            summary: `${target} source-package preflight passed on a bounded private snapshot. Vendor compilation, publishing and runtime behavior remain unverified.`,
            items: [{ name: `${target} package`, status: 'passed', bytes: validation.totalBytes,
                message: 'The canonical packaged validator accepted the snapshot structure, configuration and source sizes.' }],
            validationLevels: ['manifest-sha256', 'bounded-private-snapshot', `${target.toLowerCase()}-source-preflight`, 'input-change-detection'],
        };
        for (const item of validation.packages.slice(0, 32)) report.items.push({ name: text(item.name, 256), status: 'info', bytes: item.bytes,
            message: 'Source bytes only, not vendor-compiled package size.' });
        for (const warning of validation.warnings.slice(0, 32)) report.items.push({ name: 'Package size warning', status: 'warning', message: text(warning) });
        if (validation.packages.length > 32 || validation.warnings.length > 32) report.items.push({ name: 'Report bound', status: 'warning', code: 'LIMIT_EXCEEDED',
            message: 'All files were validated; the report includes only the first 32 packages and 32 size warnings.' });
        log('Canonical preflight completed; checking the snapshot and original inputs again before returning success.');
        return reportSchema.parse(report);
    }, path.basename(validator.path));
}
