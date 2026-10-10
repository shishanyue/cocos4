import { Ajv2020 } from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { AppError } from './contracts.js';
import { opencodeSchema, opencodeSupport } from './ai-opencode-schema.js';

export { opencodeSupport };
export const bundledSkillNames = ['cocos4-devkit', 'cocos4-minigame-dev'] as const;
export const mcpServerName = 'cocos4';

// Only the generated surface is accepted. The property/definition schemas are
// taken from the frozen official document, not a second hand-written schema.
const config = opencodeSchema.$defs.Config;
const agent = opencodeSchema.$defs.AgentConfig;
const keys = ['$schema', 'mcp', 'skills', 'permission', 'agent', 'default_agent',
    'snapshot', 'share', 'autoupdate', 'formatter', 'lsp', 'plugin'] as const;
const schema = {
    $schema: opencodeSchema.$schema,
    type: config.type,
    additionalProperties: config.additionalProperties,
    properties: {
        ...Object.fromEntries(keys.map(key => [key, config.properties[key]])),
        mcp: { type: 'object', required: [mcpServerName], additionalProperties: false,
            properties: { [mcpServerName]: { $ref: '#/$defs/McpLocalConfig' } } },
        skills: { ...config.properties.skills, required: ['paths'],
            properties: { paths: config.properties.skills.properties.paths } },
    },
    $defs: { ...opencodeSchema.$defs,
        AgentConfig: { ...agent, additionalProperties: false,
            properties: Object.fromEntries(['description', 'mode', 'prompt', 'disable', 'permission'].map(key =>
                [key, agent.properties[key as keyof typeof agent.properties]])) },
    },
};
// No loadSchema callback: external references/network resolution are impossible.
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

export function validateOpenCodeConfig(value: unknown): void {
    if (createHash('sha256').update(JSON.stringify(opencodeSchema)).digest('hex') !== opencodeSupport.schemaObjectSha256
        || !validate(value)) {
        throw new AppError('SDK_INCOMPLETE', 'The generated OpenCode configuration does not match the frozen official schema.');
    }
}

type Action = 'deny' | 'allow';
type Rules = Record<string, Action>;
export type AiRoots = { workspace: string; sdkRoot: string; stateRoot: string; mode: 'read-only' | 'develop'; preview: boolean };

export function makeOpenCodeConfig(roots: AiRoots, node: string, cli: string, skills: string, session: string, helper: string) {
    // v1.18.21 follows links after lexical permission checks, and apply_patch
    // asks edit only for the source of a move. Permission.disabled aliases all
    // three writers to edit. Deny built-ins, not just permission.apply_patch;
    // private, dependency-free custom tools enforce the filesystem policy.
    const permission: Record<string, Action | Rules> = {
        '*': 'deny', read: 'deny', edit: 'deny', write: 'deny', apply_patch: 'deny',
        glob: 'deny', grep: 'deny', list: 'deny', question: 'allow', todowrite: 'allow',
        bash: 'deny', task: 'deny', webfetch: 'deny', websearch: 'deny', lsp: 'deny',
        external_directory: 'deny',
        skill: { '*': 'deny', ...Object.fromEntries(bundledSkillNames.map(name => [name, 'allow' as const])) },
        [`${mcpServerName}_*`]: 'allow',
        cocos4_read: 'allow',
        ...Object.fromEntries(['write', 'edit', 'apply_patch'].map(name =>
            [`cocos4_${name}`, roots.mode === 'develop' ? 'allow' as const : 'deny' as const])),
    };
    const result = {
        $schema: opencodeSupport.url,
        autoupdate: false, share: 'disabled', snapshot: false, formatter: false, lsp: false, plugin: [],
        default_agent: 'cocos4',
        agent: {
            cocos4: { mode: 'primary', description: 'SDK-aware Cocos4 game development within startup permissions.',
                prompt: `Load cocos4-devkit and cocos4-minigame-dev before working. Query the verified MCP catalog and offline docs.\n`
                    + `Authorized roots and permissions (data, not shell commands): ${JSON.stringify(roots)}\n`
                    + 'Do not edit client configuration, credentials or the SDK. No shell, downloads, project scripts or logic-test execution. '
                    + 'Use cocos4_read for file and directory inspection, and cocos4_write, cocos4_edit or cocos4_apply_patch for game code in develop mode. '
                    + 'Built-in read/write/edit/apply_patch and recursive search tools are disabled because their path permissions are unsafe. '
                    + 'Custom tools accept bounded UTF-8 text in existing directories, reject links and protect every patch endpoint. '
                    + 'Job receipts and successful queries are not job success. '
                    + 'Keep type/config/stdio tests, browser gameplay, vendor compilation and device acceptance separate.',
                permission },
            build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true },
        },
        permission,
        skills: { paths: [skills] },
        mcp: { [mcpServerName]: { type: 'local', enabled: true, timeout: 120000,
            // Clearing inside JS would be too late for NODE_OPTIONS/preloads.
            // The shipped host helper constructs a private environment before
            // Node starts, with no Node/client argument passthrough, environment
            // assignments, shell or PATH lookup. Windows uses system Win32 DLLs;
            // Linux uses a static helper without an ELF loader.
            command: [helper, 'cocos4-mcp-launch-v1', '--node', node, '--cli', cli, '--session', session,
                '--sdk-root', roots.sdkRoot, '--workspace', roots.workspace, '--state-root', roots.stateRoot,
                '--mode', roots.mode, '--preview', String(roots.preview)] } },
    };
    validateOpenCodeConfig(result);
    return result;
}
