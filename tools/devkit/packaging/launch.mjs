import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHost, verifyInventory } from './verify-portable.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const windows = process.platform === 'win32';
const unsafe = windows ? /[\x00-\x1f\x7f*?\[\]{}"<>|/]/ : /[\x00-\x1f\x7f*?\[\]{}\\]/;
const absolute = (value, name) => {
    assert(typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
        && value === path.resolve(value) && !unsafe.test(value), `${name} must be a canonical absolute path without controls or globs`);
    if (windows) assert(/^[A-Za-z]:\\/.test(value) && !value.slice(2).includes(':')
        && value.slice(3).split('\\').every(part => (!part && value.length === 3)
            || (part && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))),
    `${name} must use a canonical Windows drive path without aliases, device names or alternate streams`);
    return value;
};
const contains = (a, b) => {
    const relative = path.relative(windows ? a.toLowerCase() : a, windows ? b.toLowerCase() : b);
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

try {
    assert(['linux', 'win32'].includes(process.platform), 'Only Linux and Windows x64 candidates are built');
    assert.equal(process.arch, 'x64');
    assert.equal(process.version, 'v24.21.0', 'Use the bundled, pinned Node runtime');
    assert.equal(await fs.realpath(process.execPath), path.join(root, 'runtime', windows ? 'node.exe' : 'node'), 'Use the self-locating cocos4 launcher');
    const args = process.argv.slice(2);
    if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
        process.stdout.write(`Cocos4 ${windows ? 'Windows' : 'Linux'} x64 portable candidate (local only, not cleared for distribution).\n`
            + `Usage: ${windows ? 'cocos4.exe' : 'cocos4'} doctor|tools|mcp|call TOOL|ai [options]\n`
            + 'SDK is fixed to this release. doctor without --workspace checks only the SDK/host, with no state or HOME.\n'
            + 'Other commands default workspace to cwd; use a workspace outside the release.\n'
            + 'Options: --workspace ABSOLUTE --state-root ABSOLUTE --mode read-only|develop --preview true|false\n'
            + 'MCP/CLI only: --execute-tests true|false grants trusted code execution, not a sandbox.\n'
            + 'call: --input JSON. ai: --client opencode --executable ABSOLUTE. No argument passthrough.\n'
            + (windows ? 'Default private state: %LOCALAPPDATA%\\cocos4 or %USERPROFILE%\\AppData\\Local\\cocos4.\n'
                : 'Default private state: $XDG_STATE_HOME/cocos4 or $HOME/.local/state/cocos4.\n')
            + 'No Node/npm installation, downloads, postinstall, Creator or engine checkout is needed.\n');
    } else {
        const command = args.shift();
        assert(['mcp', 'tools', 'doctor', 'call', 'ai'].includes(command), 'Unknown command');
        const tool = command === 'call' ? args.shift() : undefined;
        if (command === 'call') assert(/^cocos4_[a-z0-9_]+$/.test(tool ?? ''), 'Expected a cocos4 tool name');
        const flags = new Map();
        const allowed = ['--workspace', '--state-root', '--mode', '--preview', ...(command !== 'ai' ? ['--execute-tests'] : []),
            ...(command === 'call' ? ['--input'] : []), ...(command === 'ai' ? ['--client', '--executable'] : [])];
        for (let i = 0; i < args.length; i += 2) {
            const [key, value] = [args[i], args[i + 1]];
            assert(allowed.includes(key) && !flags.has(key) && value && value.length <= 32768 && !value.startsWith('--'),
                'Unknown, duplicate, conflicting or missing option; --sdk-root is managed by the launcher');
            flags.set(key, value);
        }
        const mode = flags.get('--mode') ?? 'read-only';
        const preview = flags.get('--preview') ?? 'false';
        const executeTests = flags.get('--execute-tests') ?? 'false';
        assert(['read-only', 'develop'].includes(mode) && ['false', 'true'].includes(preview)
            && ['false', 'true'].includes(executeTests), 'Invalid startup mode, preview or test-execution permission; use literal true or false');
        assert(mode === 'develop' || (preview === 'false' && executeTests === 'false'),
            'Preview and test execution require explicit develop permission');
        if (command === 'doctor' && !flags.has('--workspace')) {
            assert(!flags.has('--state-root') && mode === 'read-only' && preview === 'false' && executeTests === 'false',
                'SDK-only doctor accepts no private state or execution grants; use --workspace for workspace diagnostics');
            const release = await verifyInventory(root);
            const host = await verifyHost(root, release);
            const { loadSdk } = await import('./src/sdk.js');
            const { diagnoseSdk } = await import('./src/operations.js');
            const sdk = await loadSdk(path.join(root, 'sdk'));
            assert.equal(sdk.sdkId, release.sdk.sdkId, 'SDK changed after release inventory verification');
            const report = await diagnoseSdk(sdk);
            report.items.unshift({ name: 'Release inventory', status: 'passed',
                message: `Read-only release inventory, payload hashes and SPDX inventory verified for ${release.releaseId}. Integrity is not publisher authentication.` });
            report.items.push({ name: 'Host ABI', status: 'passed',
                message: windows
                    ? `Bundled Node ${host.node}; Windows ${host.windowsVersion}; complete kit requires Windows ${host.minimumWindowsVersion} or newer. This is not full host acceptance.`
                    : `Bundled Node ${host.node}; host glibc ${host.glibc}; complete kit requires glibc ${host.minimumGlibc} or newer. This is not full host acceptance.` });
            report.items.push(
                { name: 'Release acceptance', status: 'warning', message: 'Local candidate, not approved for distribution. SDK/host read checks do not establish clean-machine, browser, model, vendor or device acceptance.' },
                { name: 'Workspace and permissions', status: 'info', message: 'SDK-only diagnostics: no workspace authorized or inspected, no private state created, no preview or project code execution granted. HOME and XDG state configuration are not used.' },
                { name: 'AI client', status: 'info', message: 'Not checked or launched. AI requires a separately installed supported client selected with --client opencode --executable ABSOLUTE and an external workspace.' },
            );
            report.validationLevels.push('release-inventory', 'bundled-node', 'host-abi');
            process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: 'doctor', scope: 'sdk-only',
                success: true, releaseId: release.releaseId, sdkId: sdk.sdkId, report })}\n`);
        } else {
            const workspace = absolute(flags.get('--workspace') ?? process.cwd(), 'Workspace');
            const state = absolute(flags.get('--state-root') ?? (windows
                ? (process.env.LOCALAPPDATA ? path.join(absolute(process.env.LOCALAPPDATA, 'LOCALAPPDATA'), 'cocos4')
                    : path.join(absolute(process.env.USERPROFILE, 'USERPROFILE'), 'AppData', 'Local', 'cocos4'))
                : (process.env.XDG_STATE_HOME ? path.join(absolute(process.env.XDG_STATE_HOME, 'XDG_STATE_HOME'), 'cocos4')
                    : path.join(absolute(process.env.HOME, 'HOME'), '.local', 'state', 'cocos4'))), 'Private state');
            const roots = [root, workspace, state];
            for (let i = 0; i < roots.length; ++i) for (let j = i + 1; j < roots.length; ++j) {
                assert(!contains(roots[i], roots[j]) && !contains(roots[j], roots[i]), 'Release, workspace and private state must be disjoint');
            }
            assert.equal(await fs.realpath(workspace), workspace, 'Workspace aliases and symlinks are not allowed');
            assert((await fs.lstat(workspace)).isDirectory(), 'Workspace must already exist');
            if (flags.has('--executable')) absolute(flags.get('--executable'), 'Client executable');
            await verifyHost(root, await verifyInventory(root));
            for (const key of ['--workspace', '--state-root', '--mode', '--preview']) flags.delete(key);
            process.argv = [process.execPath, path.join(root, 'app/src/cli.js'), command, ...(tool ? [tool] : []),
                ...[...flags].flat(), '--sdk-root', path.join(root, 'sdk'), '--workspace', workspace, '--state-root', state,
                '--mode', mode, '--preview', preview];
            await import('./src/cli.js');
        }
    }
} catch (error) {
    process.stderr.write(`${JSON.stringify({ code: 'PORTABLE_STARTUP_FAILED', message: error.message,
        ...(typeof error.code === 'string' ? { causeCode: error.code } : {}) })}\n`);
    process.exitCode = 1;
}
