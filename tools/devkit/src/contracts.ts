import { z } from 'zod';

export const errorCodes = [
    'INVALID_ARGUMENTS', 'PERMISSION_DENIED', 'PATH_OUTSIDE_WORKSPACE', 'SDK_INCOMPLETE',
    'PROFILE_NOT_AVAILABLE', 'FEATURE_NOT_IN_PROFILE', 'UNSUPPORTED_PROJECT', 'OUTPUT_CONFLICT',
    'INPUT_CHANGED', 'TIMEOUT', 'CANCELLED', 'PROCESS_FAILED', 'ARTIFACT_INVALID',
    'LIMIT_EXCEEDED', 'CURSOR_INVALID', 'JOB_NOT_FOUND', 'WORKSPACE_BUSY', 'REQUEST_CONFLICT', 'TYPECHECK_FAILED', 'TEST_FAILED',
] as const;
export type ErrorCode = typeof errorCodes[number];

export class AppError extends Error {
    constructor(public readonly code: ErrorCode, message: string,
        public readonly nextSteps: string[] = [], public readonly retryable = false, public readonly report?: Report) {
        super(message);
    }
}

export const errorSchema = z.object({
    code: z.enum(errorCodes), message: z.string().max(2048), retryable: z.boolean(),
    nextSteps: z.array(z.string().max(512)).max(8),
}).strict();
export type OperationError = z.infer<typeof errorSchema>;

export function operationError(error: unknown): OperationError {
    if (error instanceof AppError) return errorSchema.parse({
        code: error.code, message: error.message, retryable: error.retryable, nextSteps: error.nextSteps,
    });
    return { code: 'PROCESS_FAILED', message: 'The operation failed. Inspect its execution stage and diagnostics.',
        retryable: false, nextSteps: ['Inspect the job diagnostics or maintainer stderr.'] };
}

export const diagnosticSchema = z.object({
    code: z.string().max(128), severity: z.enum(['info', 'warning', 'error']),
    message: z.string().max(2048), source: z.string().max(128),
    file: z.string().max(1024).optional(), line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(), nextSteps: z.array(z.string().max(512)).max(8),
}).strict();

export const reportItemSchema = z.object({
    name: z.string().max(1024), status: z.enum(['passed', 'warning', 'failed', 'info']),
    message: z.string().max(2048), code: z.string().max(128).optional(),
    bytes: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    file: z.string().max(1024).optional(), line: z.number().int().positive().optional(), column: z.number().int().positive().optional(),
}).strict();
export const releaseIdSchema = z.string().regex(/^sha256-[a-f0-9]{64}$/);
const artifactProvenance = z.object({
    releaseId: releaseIdSchema.nullable(), profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const artifactIdentity = z.object({
    artifactId: z.string().uuid(), sdkId: z.string().max(256), profile: z.string().max(128),
    variant: z.enum(['debug', 'release']), validationLevels: z.array(z.string().max(128)).max(16),
    // Absent on persisted legacy outputs; null releaseId means unpackaged tools.
    provenance: artifactProvenance.optional(),
}).strict();
const html5ArtifactIdentity = artifactIdentity.extend({ target: z.literal('HTML5'), entry: z.literal('index.html') });
const minigameArtifactIdentity = artifactIdentity.extend({ target: z.enum(['BILIBILI', 'WECHAT', 'BYTEDANCE']), entry: z.literal('game.js') });
const artifactTotals = {
    bytes: z.number().int().nonnegative(), files: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
};
export const artifactSchema = z.discriminatedUnion('target', [
    html5ArtifactIdentity.extend(artifactTotals), minigameArtifactIdentity.extend(artifactTotals),
]);
export type Artifact = z.infer<typeof artifactSchema>;
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const artifactInventory = {
    schemaVersion: z.literal(1),
    files: z.array(z.object({ path: z.string().min(1).max(1024), bytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(10000),
};
export const artifactInventorySchema = z.discriminatedUnion('target', [
    html5ArtifactIdentity.extend(artifactInventory), minigameArtifactIdentity.extend(artifactInventory),
]);
export const logicSummarySchema = z.object({
    runner: z.literal('node:test'), files: z.number().int().positive().max(256),
    passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(), todo: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(), omitted: z.number().int().nonnegative(),
}).strict();
export const logicResultSchema = z.object({
    summary: logicSummarySchema, items: z.array(reportItemSchema).max(32),
}).strict();
export type LogicResult = z.infer<typeof logicResultSchema>;
export const logicExecutionSchema = z.object({
    exitCode: z.number().int().nullable(), signal: z.string().max(64).nullable(),
    result: logicResultSchema.nullable(), error: errorSchema.nullable(),
}).strict();
export type LogicExecution = z.infer<typeof logicExecutionSchema>;
export type ExecuteLogic = () => Promise<LogicExecution>;
export const reportSchema = z.object({
    summary: z.string().max(2048), items: z.array(reportItemSchema).max(10000),
    validationLevels: z.array(z.string().max(128)).max(16),
    artifacts: z.array(artifactSchema).max(16).optional(),
    project: z.string().max(1024).optional(),
    inputSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    logic: logicSummarySchema.optional(),
    profile: z.object({ sdkId: z.string().max(256), target: z.string().max(128), id: z.string().max(128),
        variant: z.enum(['debug', 'release']), descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type Report = z.infer<typeof reportSchema>;

export function matchesArtifactProvenance(artifact: Artifact, profile: Report['profile'], releaseId: string | null): boolean {
    return !!profile && !!artifact.provenance && artifact.provenance.releaseId === releaseId
        && artifact.provenance.profileSha256 === profile.descriptorSha256 && artifact.sdkId === profile.sdkId
        && artifact.target === profile.target && artifact.profile === profile.id && artifact.variant === profile.variant;
}

export const jobStates = ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const;
export const receiptSchema = z.object({
    jobId: z.string().uuid(), state: z.enum(jobStates), pollAfterMs: z.number().int().positive(),
}).strict();
export type JobReceipt = z.infer<typeof receiptSchema>;
export const gameTimeoutSchema = z.number().int().min(1000).max(3600000).default(600000);
const relative = z.string().min(1).max(1024);
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
export const operationRequestSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('doctor'), input: z.object({
        project: relative.optional(), depth: z.enum(['quick', 'full']).default('quick'),
    }).strict() }).strict(),
    z.object({ operation: z.literal('package_validate'), input: z.object({
        directory: relative, target: z.enum(['BILIBILI', 'WECHAT', 'BYTEDANCE']).default('BILIBILI'),
    }).strict() }).strict(),
    z.object({ operation: z.literal('project_create'), input: z.object({
        directory: relative, templateId: identifier, projectName: z.string().min(1).max(128).regex(/^[a-z][a-z0-9-]*$/),
    }).strict() }).strict(),
    z.object({ operation: z.literal('project_check'), input: z.object({
        project: relative, target: identifier, profile: identifier,
        checks: z.array(z.enum(['types', 'logic'])).min(1).max(2).refine(items => new Set(items).size === items.length),
    }).strict() }).strict(),
    z.object({ operation: z.literal('game_build'), input: z.object({
        project: relative, target: identifier, profile: identifier, variant: z.enum(['debug', 'release']),
    }).strict() }).strict(),
    z.object({ operation: z.literal('preview_start'), input: z.object({
        artifactId: z.string().uuid(), ttlSeconds: z.number().int().min(1).max(7200).default(1800),
    }).strict() }).strict(),
]);
export type OperationRequest = z.infer<typeof operationRequestSchema>;
export type Operation = OperationRequest['operation'];
export type OperationInput = OperationRequest['input'];
export const permissionsSchema = z.object({
    mode: z.enum(['read-only', 'develop']).default('read-only'),
    preview: z.boolean().default(false), executeTests: z.boolean().default(false),
}).strict();
export type Permissions = z.infer<typeof permissionsSchema>;
export function authorize(request: OperationRequest, permissions: Permissions): void {
    if (permissions.mode !== 'develop' && (permissions.preview || permissions.executeTests)) {
        throw new AppError('PERMISSION_DENIED', 'Preview and test execution require explicit develop startup permission.');
    }
    if (['doctor', 'package_validate'].includes(request.operation)) return;
    if (permissions.mode !== 'develop' || (request.operation === 'preview_start' && !permissions.preview)
        || (request.operation === 'project_check' && request.input.checks.includes('logic') && !permissions.executeTests)) {
        throw new AppError('PERMISSION_DENIED', 'This operation requires an explicit startup permission. Tool arguments cannot grant permissions.');
    }
}
export type WorkerRequest = OperationRequest & {
    workspace: string; sdkRoot: string; staging: string; permissions?: Permissions; expectedSdkId?: string;
    artifactsRoot?: string; artifactId?: string; artifact?: Artifact;
    releaseId?: string | null;
};
export function parseWorkerRequest(value: unknown): WorkerRequest {
    try {
        const { operation, input, ...context } = z.object({
            operation: z.string(), input: z.unknown(), workspace: z.string().min(1).max(4096),
            sdkRoot: z.string().min(1).max(4096), staging: z.string().min(1).max(4096),
            permissions: permissionsSchema.optional(), expectedSdkId: z.string().max(256).optional(),
            artifactsRoot: z.string().min(1).max(4096).optional(), artifactId: z.string().uuid().optional(),
            artifact: artifactSchema.optional(),
            releaseId: releaseIdSchema.nullable().optional(),
        }).strict().parse(value);
        return { ...operationRequestSchema.parse({ operation, input }), ...context };
    } catch { throw new AppError('INVALID_ARGUMENTS', 'Invalid worker operation arguments.'); }
}
export const previewSchema = z.object({
    artifactId: z.string().uuid(), url: z.string().url().max(512), port: z.number().int().min(1).max(65535),
    expiresAt: z.number().int().positive(),
}).strict();
export type Preview = z.infer<typeof previewSchema>;

export const jobSchema = z.object({
    jobId: z.string().uuid(), operation: z.enum(['doctor', 'package_validate', 'project_create', 'project_check', 'game_build', 'preview_start']),
    releaseId: releaseIdSchema.nullable().default(null),
    project: z.string().max(1024).nullable(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(jobStates), phase: z.string().max(128),
    createdAt: z.number().int(), startedAt: z.number().int().nullable(), finishedAt: z.number().int().nullable(),
    deadline: z.number().int(), error: errorSchema.nullable(), report: reportSchema.nullable(),
    // For logic checks these are the OS runner observations, never the worker's exit.
    // Older persisted records predate these observations; null means unknown.
    exitCode: z.number().int().nullable().default(null), signal: z.string().max(64).nullable().default(null),
    workerExitCode: z.number().int().nullable().default(null),
    discardedLogBytes: z.number().int().nonnegative().nullable().default(null),
    preview: previewSchema.optional(),
}).strict();
export type Job = z.infer<typeof jobSchema>;
