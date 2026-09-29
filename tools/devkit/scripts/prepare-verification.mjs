// Explicit, network-using maintainer CI. Never builds in the invoking checkout.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, renameSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRegular } from './verify-portable.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const pins = Object.freeze({
    nodes: ['18.20.8', '24.21.0'], effectsNode: '24.21.0',
    external: '11dde1bdc5af95b0227cbe8cc29340f4b757aea9',
    glslang: '168d452a4f460d24b588fed08477a81c44ee27a1',
    googletest: 'f8d7d77c06936315286eb55f8de22cd23c188571',
    legacy: '3d8a7121381437e1f932ca2bcb8048967228891a',
});
const legacyFiles = {
    'scripts/prepare-game-sdk.mjs': '1d0fe5dbfcadd8750ada7aa2f113299e3c67dea3b521eaf426e7b314e269b808',
    'scripts/prepare-sdk.mjs': 'd4c38f8da6e36218245f622f4a9c8ae2db05b882a55e97eff92b48a79a2e72d5',
    'runtime/compile-game.cjs': '545cfc322c824ac026a0ce072a489783f661d9b9e722438ab7b9576544e568ec',
    'runtime/files.cjs': '8f02174effcdaf553a3f2df0595e4ef5fadcdb5290128fbdb32017cdc205797f',
};

function absolute(value) {
    assert(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value
        && !/[\0\r\n:]/.test(value), `Expected a canonical absolute Linux path: ${value}`);
    return value;
}

export function requireNodeLock(lock) {
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.version, pins.effectsNode, 'Review the portable Node version with both CI lanes');
    assert.equal(lock.target, 'linux-x64');
    assert.equal(lock.archiveRoot, `node-v${lock.version}-${lock.target}`);
    assert.equal(lock.url, `https://nodejs.org/dist/v${lock.version}/${lock.archiveRoot}.tar.xz`);
    assert.equal(lock.checksumsUrl, `https://nodejs.org/dist/v${lock.version}/SHASUMS256.txt`);
    assert.match(lock.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(lock.files, ['bin/node', 'LICENSE', 'README.md']);
    return lock;
}

export async function requireNodeArchive(archive, lock) {
    absolute(archive);
    requireNodeLock(lock);
    const bytes = await readRegular(path.dirname(archive), path.basename(archive));
    assert.equal(hash(bytes), lock.sha256, 'Node archive does not match the reviewed official pin');
    return { archive, url: lock.url, sha256: lock.sha256, bytes: bytes.length };
}

export function verificationLayout(engine) {
    absolute(engine);
    const devkit = path.join(engine, 'tools/devkit');
    const build = path.join(devkit, 'build');
    const runtime = path.join(devkit, 'runtime/build');
    // Existing tests still use these historical basenames. They are fresh outputs
    // INSIDE this run's unique clone, not copies/aliases of saved local evidence.
    const debugHtml = path.join(runtime, 'acceptance-Js6TDR');
    const release = path.join(runtime, 'verification-release');
    const runtimes = ['debug', 'release'].flatMap(variant => ['HTML5', 'BILIBILI'].flatMap(target =>
        ['2d-basic', '3d-basic'].map(profile => {
            const directory = variant === 'release' ? path.join(release, target, profile)
                : target === 'HTML5' ? path.join(debugHtml, profile)
                    : path.join(runtime, `bilibili-final-${profile.slice(0, 2)}-20260918`);
            const kind = target === 'HTML5' ? 'browser' : 'local';
            return { target, profile, variant, directory, report: `${directory}-${kind}/${kind}-report.json` };
        })));
    return { engine, devkit, build, runtime, debugHtml, release, runtimes,
        candidate: path.join(path.dirname(engine), 'portable-candidate'),
        base: path.join(build, 'readonly-sdk'), debugSdk: path.join(build, 'game-sdk-isolated'),
        sdk: path.join(build, 'verification-sdk'), legacySdk: path.join(build, 'legacy-game-sdk') };
}

export function verificationEnvironment(layout, builtins, chrome) {
    const { base, sdk, debugSdk, legacySdk, debugHtml, release, runtimes, candidate } = layout;
    const bilibili = runtimes.filter(item => item.target === 'BILIBILI' && item.variant === 'debug');
    for (const value of [base, sdk, debugSdk, legacySdk, debugHtml, release, candidate, chrome,
        ...Object.values(builtins), ...bilibili.map(item => item.directory)]) absolute(value);
    assert(builtins['2d-basic'] && builtins['3d-basic'], 'Both real builtin artifacts are required');
    return {
        GAME_SDK_INTEGRATION: '1', RUNTIME_INTEGRATION: '1', RELEASE_GAME_INTEGRATION: '1',
        GAME_OPERATION_SDK_ROOT: debugSdk, COMBINED_SDK_ROOT: debugSdk, API_DOCS_SDK_ROOT: debugSdk,
        AI_TEST_SDK_ROOT: sdk, LOGIC_TEST_SDK_ROOT: debugSdk, BILIBILI_PACKAGE_SDK: debugSdk,
        LEGACY_HTML5_SDK_ROOT: legacySdk, API_DOCS_LEGACY_SDK_ROOT: legacySdk,
        // Reproducibility reuses these real inputs plus RUNTIME_BUILTINS_2D and
        // COMBINED_SDK_ROOT on both lanes; no separate opt-in or browser rerun.
        BILIBILI_SDK_BASE_ROOT: base, GAME_SDK_RUNTIME_ROOT: debugHtml,
        BILIBILI_RUNTIME_DIRECTORIES: bilibili.map(item => item.directory).join(path.delimiter),
        BILIBILI_SDK_2D_RUNTIME: bilibili[0].directory, BILIBILI_SDK_3D_RUNTIME: bilibili[1].directory,
        RUNTIME_COMPILER_FIXTURES: debugHtml, RUNTIME_TOOLCHAIN: path.join(debugSdk, 'toolchain'),
        RUNTIME_BUILTINS_2D: builtins['2d-basic'], RUNTIME_BUILTINS_3D: builtins['3d-basic'],
        RUNTIME_CHROME: chrome, GAME_CHROME_EXECUTABLE: chrome,
        RELEASE_RUNTIME_ROOT: release, RELEASE_LOCAL_REPORT_ROOT: path.join(release, 'BILIBILI'),
        RELEASE_GAME_SDK_ROOT: sdk,
        PORTABLE_STARTUP_RELEASE: candidate, PORTABLE_STARTUP_NODE: path.join(candidate, 'runtime/node'),
        AI_TEST_EVIDENCE_ROOT: path.join(layout.build, 'ai-evidence'),
    };
}

export function requireCompleteTap(output) {
    const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(field => {
        const matches = [...output.matchAll(new RegExp(`^# ${field} (\\d+)\\r?$`, 'gm'))];
        assert.equal(matches.length, 1, `Missing/ambiguous terminal TAP total: ${field}`);
        return [field, Number(matches[0][1])];
    }));
    assert(totals.tests > 0 && totals.pass === totals.tests && totals.fail === 0
        && totals.cancelled === 0 && totals.skipped === 0 && totals.todo === 0,
    `Integration requires all tests, with no failures, cancellations, skips or TODOs: ${JSON.stringify(totals)}`);
    return totals;
}

// Public CI evidence is a field allowlist, not a copy/redaction of local logs,
// command environments, error stacks or arbitrary third-party reports.
export function verificationReceipt(input) {
    return {
        schemaVersion: 1, scope: 'Integration receipt only; not release/distribution approval',
        node: input.node, revision: input.revision, pins,
        startedAt: input.startedAt, finishedAt: input.finishedAt,
        status: input.interrupted ? 'interrupted' : input.success === true ? 'passed'
            : input.success === false ? 'failed' : 'running',
        cleanClone: input.cleanClone === true, nodeArchiveSha256: input.nodeArchive?.sha256,
        candidate: input.candidate && { releaseId: input.candidate.releaseId, sdkId: input.candidate.sdkId,
            distributionApproved: input.candidate.distributionApproved },
        totals: input.totals && Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
            .map(key => [key, input.totals[key]])),
        records: (input.records ?? []).map(record => ({ name: record.name, code: record.code, signal: record.signal,
            interrupted: record.interrupted, startedAt: record.startedAt, finishedAt: record.finishedAt,
            logSha256: record.logSha256 })),
    };
}

export async function publishVerificationResult(out, input, isInterrupted) {
    let result;
    do {
        const interrupted = isInterrupted();
        result = { ...input, finishedAt: new Date().toISOString(), success: input.success === true && !interrupted, interrupted };
        await fs.writeFile(path.join(out, 'result.json.tmp'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
        await fs.writeFile(path.join(out, 'ci-receipt.json.tmp'),
            `${JSON.stringify(verificationReceipt(result), null, 2)}\n`, { mode: 0o600 });
        await new Promise(resolve => setImmediate(resolve));
    } while (result.interrupted !== isInterrupted());
    // No async gap between the cancellation check and final promotion. Only this run's fresh output is replaced.
    renameSync(path.join(out, 'result.json.tmp'), path.join(out, 'result.json'));
    renameSync(path.join(out, 'ci-receipt.json.tmp'), path.join(out, 'ci-receipt.json'));
    return result;
}

export async function requireFreshOutput(source, out) {
    absolute(source); absolute(out);
    assert(out !== source && !out.startsWith(`${source}/`) && !source.startsWith(`${out}/`),
        'Verification output must be outside the source checkout');
    assert.equal(await fs.realpath(source), source, 'Source checkout must be canonical');
    assert.equal(await fs.realpath(path.dirname(out)), path.dirname(out), 'Output parent must exist and be canonical');
    try { await fs.lstat(out); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error(`OUTPUT_CONFLICT: ${out}; use a new absent output directory`);
}

async function main() {
    const usage = 'Usage: pinned-node tools/devkit/scripts/prepare-verification.mjs --out <absolute absent directory outside checkout> --effect-node <absolute Node 24.21.0 executable>. Requires Linux x64, npm beside each Node, Git, CMake/Ninja, C/C++, Python, readelf, bwrap with working user/PID/network/mount namespaces, writable /tmp/opencode, curl, tar/xz, X11/EGL/GLES, Xvfb/display, preinstalled Chromium OS dependencies (see .github/workflows/devkit-probes.yml) and network. Downloads the reviewed Node archive with SHA-256 verification; installs/builds only under the fresh run directory (engine work in its unique clone), installs browser files only in its run-local cache, never OS packages; assembles an offline local candidate and runs all tests in the foreground. Only ci-receipt.json is cleared for CI upload; no release/payload upload.';
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        assert(['--out', '--effect-node'].includes(key) && !options[key] && process.argv[index + 1], usage);
        options[key] = absolute(process.argv[index + 1]);
    }
    assert(options['--out'] && options['--effect-node'], usage);
    assert(process.platform === 'linux' && process.arch === 'x64' && pins.nodes.includes(process.versions.node), usage);
    const source = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    const out = options['--out'];
    await requireFreshOutput(source, out);
    await fs.mkdir(out, { mode: 0o700 });
    const json = async (name, value) => fs.writeFile(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    const records = [];
    const inputs = { schemaVersion: 1, node: process.version, pins, source, out, startedAt: new Date().toISOString(),
        scope: 'Clean-source Linux integration, not portable-host, model, vendor/device or redistribution acceptance' };
    const receipt = async (result = {}) => {
        // Preserve the last complete checkpoint if the runner is terminated mid-write.
        await fs.writeFile(path.join(out, 'ci-receipt.json.tmp'),
            `${JSON.stringify(verificationReceipt({ ...inputs, ...result, records }), null, 2)}\n`, { mode: 0o600 });
        await fs.rename(path.join(out, 'ci-receipt.json.tmp'), path.join(out, 'ci-receipt.json'));
    };
    await receipt();
    let active;
    let interrupted = false;
    let escalation;
    const stop = () => {
        interrupted = true;
        if (!active?.pid) return;
        const pid = active.pid;
        const kill = signal => { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
        kill('SIGTERM');
        // Do not cancel escalation just because the group leader exits first.
        escalation ??= new Promise(resolve => setTimeout(() => { kill('SIGKILL'); resolve(); }, 5000));
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const env = Object.fromEntries(['PATH', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'LIBGL_ALWAYS_SOFTWARE']
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: path.join(out, 'home'), TMPDIR: path.join(out, 'tmp'),
        npm_config_cache: path.join(out, 'npm-cache'), PLAYWRIGHT_BROWSERS_PATH: path.join(out, 'browsers') });
    const run = async (name, command, args, cwd, extra = {}, timeoutMs = 900000) => {
        assert(!interrupted, 'Verification interrupted');
        const record = { name, command, args, cwd, environment: { ...env, ...extra }, timeoutMs,
            startedAt: new Date().toISOString(), log: `${String(records.length).padStart(3, '0')}-${name}.log` };
        records.push(record);
        await receipt();
        await json(`${record.log}.command.json`, record);
        process.stdout.write(`\n[verification] ${name}: ${JSON.stringify([command, ...args])}\n`);
        const log = await fs.open(path.join(out, record.log), 'wx');
        let timer;
        try {
            assert(!interrupted, 'Verification interrupted');
            const status = await new Promise((resolve, reject) => {
                active = spawn(command, args, { cwd, env: record.environment, shell: false, detached: true,
                    stdio: ['ignore', log.fd, log.fd] });
                timer = setTimeout(stop, timeoutMs);
                active.once('error', reject);
                active.once('close', (code, signal) => resolve({ code, signal }));
            });
            Object.assign(record, status);
        } finally {
            clearTimeout(timer);
            await escalation;
            active = undefined;
            await log.close();
            record.interrupted = interrupted;
            record.finishedAt = new Date().toISOString();
            const bytes = await fs.readFile(path.join(out, record.log));
            record.logSha256 = hash(bytes);
            process.stdout.write(bytes);
            await json(`${record.log}.result.json`, record);
            await receipt();
        }
        assert(record.code === 0 && !record.signal && !interrupted, `${name} failed; see ${path.join(out, record.log)}`);
        return fs.readFile(path.join(out, record.log), 'utf8');
    };
    try {
        await fs.mkdir(env.HOME);
        await fs.mkdir(env.TMPDIR);
        const git = async args => (await execute('git', args, { cwd: source, env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
        inputs.revision = await git(['rev-parse', 'HEAD']);
        assert.equal(await git(['status', '--porcelain', '--untracked-files=all']), '',
            'SOURCE_DIRTY: verification requires a clean checkout; local changes and caches are never clean CI inputs');
        try {
            assert.equal(await git(['rev-parse', `${pins.legacy}^{commit}`]), pins.legacy);
            for (const [relative, expected] of Object.entries(legacyFiles)) {
                const { stdout } = await execute('git', ['show', `${pins.legacy}:tools/devkit/${relative}`],
                    { cwd: source, env, encoding: 'buffer', timeout: 120000, maxBuffer: 1024 * 1024 });
                assert.equal(hash(stdout), expected, relative);
            }
        } catch (error) {
            throw new Error(`MISSING_LEGACY_SOURCE: need unmodified producer/compiler blobs from ${pins.legacy}; fetch full repository history. No synthetic legacy SDK fallback.`, { cause: error });
        }
        const node = await fs.realpath(process.execPath);
        const effectNode = await fs.realpath(options['--effect-node']);
        assert.equal((await execute(effectNode, ['-p', 'process.versions.node'], { env })).stdout.trim(), pins.effectsNode,
            'Effects require exactly Node 24.21.0 and its own rebuilt GL addon');
        const npm = await fs.realpath(path.join(path.dirname(node), 'npm'));
        const effectNpm = await fs.realpath(path.join(path.dirname(effectNode), 'npm'));
        inputs.executables = { node, effectNode, npm, effectNpm };
        assert.equal(await fs.realpath('/tmp/opencode'), '/tmp/opencode', 'AI tests require a canonical /tmp/opencode');
        await fs.access('/tmp/opencode', constants.W_OK | constants.X_OK);
        await run('host-readelf', '/usr/bin/readelf', ['--version'], out);
        await run('host-mcp-namespaces', '/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent',
            '--ro-bind', '/', '/', '--proc', '/proc', '--tmpfs', '/usr/bin', '--ro-bind', node, node, '--', node, '-e',
            'require("node:assert/strict").throws(()=>require("node:fs").lstatSync("/usr/bin/env"),{code:"ENOENT"});console.log("MCP namespaces usable with hidden /usr/bin")'],
        out, { PATH: '' }, 30000);
        const layout = verificationLayout(path.join(out, 'engine'));
        const { engine, devkit, build, runtimes } = layout;
        await run('clone-source', 'git', ['clone', '--no-local', '--no-hardlinks', '--no-checkout', source, engine], out);
        await run('checkout-source', 'git', ['checkout', '--detach', inputs.revision], engine);
        assert.equal((await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: engine, env })).stdout, '');
        inputs.cleanClone = true;
        inputs.locks = {};
        for (const relative of ['package-lock.json', 'external-config.json', 'tools/devkit/package-lock.json',
            'tools/devkit/runtime/package-lock.json', 'tools/devkit/effects/package-lock.json',
            'tools/devkit/effects/source-lock.json', 'tools/devkit/effects/patch-lock.json', 'tools/devkit/packaging/node-lock.json']) {
            inputs.locks[relative] = hash(await fs.readFile(path.join(engine, relative)));
        }
        const { stdout: legacyLock } = await execute('git', ['show', `${pins.legacy}:package-lock.json`],
            { cwd: engine, env, encoding: 'buffer', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(hash(legacyLock), inputs.locks['package-lock.json'],
            'Historical compiler dependency lock changed; a separately provisioned legacy toolchain is required');
        await json('prerequisites.json', inputs);
        const nodeLock = requireNodeLock(JSON.parse(await fs.readFile(path.join(devkit, 'packaging/node-lock.json'))));
        const nodeArchive = path.join(out, `${nodeLock.archiveRoot}.tar.xz`);
        // The maintainer provisioner downloads; the assembler only receives a verified local archive.
        await run('download-reviewed-node', '/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error',
            '--proto', '=https', '--tlsv1.2', '--max-time', '300', '--max-filesize', '268435456',
            '--output', nodeArchive, '--url', nodeLock.url], out);
        inputs.nodeArchive = await requireNodeArchive(nodeArchive, nodeLock);
        await json('node-archive.json', inputs.nodeArchive);
        const npmRun = (name, cwd, args, effects = false, timeout) => run(name, effects ? effectNode : node,
            [effects ? effectNpm : npm, ...args], cwd,
            { PATH: `${path.dirname(effects ? effectNode : node)}:${env.PATH ?? '/usr/bin:/bin'}` }, timeout);
        for (const [name, cwd, effects] of [['engine', engine, false], ['devkit', devkit, false],
            ['browser', path.join(devkit, 'runtime'), false], ['effects', path.join(devkit, 'effects'), true]]) {
            await npmRun(`install-${name}`, cwd, ['ci', '--ignore-scripts', '--engine-strict', '--no-audit', '--no-fund'], effects);
        }
        await npmRun('prepare-engine', engine, ['run', 'prepare:engine']);
        const fetch = async (name, url, revision, directory, sparse = []) => {
            await fs.mkdir(directory, { recursive: true });
            await run(`${name}-init`, 'git', ['init', directory], out);
            await run(`${name}-remote`, 'git', ['remote', 'add', 'origin', url], directory);
            await run(`${name}-fetch`, 'git', ['fetch', '--depth=1', '--filter=blob:none', 'origin', revision], directory);
            if (sparse.length) await run(`${name}-sparse`, 'git', ['sparse-checkout', 'set', '--cone', ...sparse], directory);
            await run(`${name}-checkout`, 'git', ['checkout', '--detach', 'FETCH_HEAD'], directory);
            assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: directory, env })).stdout.trim(), revision);
        };
        const external = JSON.parse(await fs.readFile(path.join(engine, 'external-config.json')));
        assert.deepEqual(external.from, { type: 'github', owner: 'cocos', name: 'cocos-engine-external', checkout: 'v4.0.0-9' },
            'Review the external commit pin when external-config.json changes');
        const externalSource = path.join(out, 'external-source');
        await fetch('external', 'https://github.com/cocos/cocos-engine-external.git', pins.external, externalSource, ['emscripten', 'licenses']);
        await npmRun('setup-external', engine, ['run', 'setup:external', '--', '--source', externalSource]);
        const effectLock = JSON.parse(await fs.readFile(path.join(devkit, 'effects/source-lock.json')));
        const effectSource = path.join(out, 'effect-source');
        await fetch('effect-source', effectLock.repository, effectLock.revision, effectSource);
        await npmRun('prepare-effect-source', path.join(devkit, 'effects'), ['run', 'prepare:source', '--', effectSource], true);
        await npmRun('rebuild-real-gl', path.join(devkit, 'effects'), ['rebuild', 'gl', '--foreground-scripts'], true, 1800000);

        const glslang = path.join(out, 'glslang-source');
        await fetch('glslang', 'https://github.com/KhronosGroup/glslang.git', pins.glslang, glslang);
        const good = JSON.parse(await fs.readFile(path.join(glslang, 'known_good.json')));
        for (const dependency of good.commits) {
            assert.equal(dependency.site, 'github');
            if (dependency.name === 'googletest') assert.equal(dependency.commit, 'v1.14.0', 'Review the googletest commit pin');
            const revision = dependency.name === 'googletest' ? pins.googletest : dependency.commit;
            assert(/^[a-f0-9]{40}$/.test(revision));
            assert(!dependency.subdir.split('/').includes('..') && !path.isAbsolute(dependency.subdir));
            await fetch(`glslang-${dependency.name.replaceAll('/', '-')}`, `https://github.com/${dependency.subrepo}.git`,
                revision, path.join(glslang, dependency.subdir));
        }
        const glslangBuild = path.join(out, 'glslang-build');
        await run('configure-glslang', 'cmake', ['-S', glslang, '-B', glslangBuild, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'], out);
        await run('build-glslang', 'cmake', ['--build', glslangBuild, '--parallel', '2'], out, {}, 2400000);
        await run('test-glslang', 'ctest', ['--test-dir', glslangBuild, '--output-on-failure', '--no-tests=error'], out);
        env.COCOS_EFFECT_GLSLANG = path.join(glslangBuild, 'StandAlone/glslang');
        assert.match(await run('glslang-version', env.COCOS_EFFECT_GLSLANG, ['--version'], out), /^Glslang Version: 11:16\.4\.0\n/);

        await npmRun('platform-tests', engine, ['run', 'test:platforms']);
        await npmRun('real-declarations', engine, ['run', 'build:declaration']);
        await npmRun('engine-tests', engine, ['test', '--', '--runInBand']);
        for (const target of ['WECHAT', 'OPPO']) await npmRun(`engine-${target}`, engine, ['run', 'build:minigame', '--', target]);
        await npmRun('devkit-check', devkit, ['run', 'check']);
        await npmRun('devkit-build', devkit, ['run', 'build']);
        await fs.mkdir(layout.runtime, { recursive: true });
        const builtins = {};
        for (const profile of ['2d-basic', '3d-basic']) {
            const result = path.join(out, `builtin-${profile}.json`);
            await run(`effects-${profile}`, effectNode, ['-e',
                'require(process.argv[1]).probe(process.argv[2]).then(r=>require("node:fs").writeFileSync(process.argv[3],JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})',
                path.join(devkit, 'effects/probe.cjs'), profile, result], devkit);
            builtins[profile] = JSON.parse(await fs.readFile(result)).output;
        }
        requireCompleteTap(await run('effect-tests', effectNode,
            ['--test', '--test-reporter=tap', '--test-concurrency=1', 'test/pipeline.test.cjs'], path.join(devkit, 'effects')));
        await run('install-browser', effectNode, [path.join(devkit, 'runtime/node_modules/playwright-core/cli.js'),
            'install', 'chromium'], devkit);
        const browserRecord = path.join(out, 'browser.json');
        await run('locate-browser', node, ['-e',
            'const p=require(process.argv[1]);require("node:fs").writeFileSync(process.argv[2],JSON.stringify({executable:p.chromium.executablePath(),browsers:require(process.argv[3])}))',
            path.join(devkit, 'runtime/node_modules/playwright-core'), browserRecord,
            path.join(devkit, 'runtime/node_modules/playwright-core/browsers.json')], devkit);
        const chrome = await fs.realpath(JSON.parse(await fs.readFile(browserRecord)).executable);
        assert(chrome.startsWith(`${env.PLAYWRIGHT_BROWSERS_PATH}/`), 'Chromium must stay in the run-local browser cache');
        await run('browser-version', chrome, ['--version'], devkit);
        for (const input of runtimes) {
            await fs.mkdir(path.dirname(input.directory), { recursive: true });
            const key = `${input.target}-${input.profile}-${input.variant}`;
            await run(`runtime-${key}`, node, [path.join(devkit, 'scripts/build-runtime.cjs'), input.profile,
                builtins[input.profile], input.directory, input.target, input.variant], engine, {}, 1800000);
            await run(`verify-${key}`, node, [path.join(devkit, `runtime/verify-${input.target === 'HTML5' ? 'browser' : 'bilibili'}.cjs`),
                input.directory, ...(input.target === 'HTML5' ? [chrome] : []), path.dirname(input.report)], engine);
        }
        await run('readonly-sdk', node, [path.join(devkit, 'scripts/prepare-sdk.mjs'), '--out', layout.base], devkit);
        for (const [name, selected, destination] of [['debug-sdk', runtimes.filter(item => item.variant === 'debug'), layout.debugSdk],
            ['eight-profile-sdk', runtimes, layout.sdk]]) {
            await run(name, node, [path.join(devkit, 'scripts/prepare-game-sdk.mjs'), '--base', layout.base,
                ...selected.flatMap(item => ['--runtime', item.directory]), '--out', destination], devkit);
        }

        // Rebuild a genuine pre-index fixture with unmodified historical producers.
        // Current validator modules are identified separately, never called historical.
        const legacy = path.join(out, 'legacy-producer');
        const legacyDevkit = path.join(legacy, 'tools/devkit');
        const provenance = { revision: pins.legacy, files: legacyFiles, validationModules: {},
            runtimeInputs: runtimes.filter(item => item.target === 'HTML5' && item.variant === 'debug'),
            note: 'Historical producer on fresh real inputs, not recovery of a saved SDK or its original SDK ID' };
        for (const [relative, expected] of Object.entries(legacyFiles)) {
            const { stdout: bytes } = await execute('git', ['show', `${pins.legacy}:tools/devkit/${relative}`],
                { cwd: engine, env, encoding: 'buffer', maxBuffer: 1024 * 1024 });
            assert.equal(hash(bytes), expected, `Historical source changed: ${relative}`);
            await fs.mkdir(path.dirname(path.join(legacyDevkit, relative)), { recursive: true });
            await fs.writeFile(path.join(legacyDevkit, relative), bytes, { flag: 'wx' });
        }
        await fs.mkdir(path.join(legacyDevkit, 'build/src'), { recursive: true });
        for (const name of ['sdk.js', 'api-index.js', 'contracts.js']) {
            const bytes = await fs.readFile(path.join(build, 'src', name));
            provenance.validationModules[name] = hash(bytes);
            await fs.writeFile(path.join(legacyDevkit, 'build/src', name), bytes, { flag: 'wx' });
        }
        await fs.copyFile(path.join(devkit, 'package.json'), path.join(legacyDevkit, 'package.json'));
        await fs.symlink(path.join(devkit, 'node_modules'), path.join(legacyDevkit, 'node_modules'));
        await fs.copyFile(path.join(engine, 'package-lock.json'), path.join(legacy, 'package-lock.json'));
        await fs.cp(path.join(layout.debugSdk, 'toolchain/node_modules'), path.join(legacy, 'node_modules'), { recursive: true });
        await json('legacy-producer.json', provenance);
        await run('legacy-sdk', node, [path.join(legacyDevkit, 'scripts/prepare-game-sdk.mjs'), '--base', layout.base,
            ...provenance.runtimeInputs.flatMap(item => ['--runtime', item.directory]), '--out', layout.legacySdk, '--engine-root', legacy], devkit);

        const { loadSdk } = await import(pathToFileURL(path.join(build, 'src/sdk.js')));
        const identities = [];
        const engineHashes = new Set();
        for (const [name, directory, count] of [['debug', layout.debugSdk, 4], ['combined', layout.sdk, 8], ['legacy', layout.legacySdk, 2]]) {
            const sdk = await loadSdk(directory);
            assert.equal(sdk.manifest.catalog.profiles.length, count);
            if (name === 'legacy') assert.equal(sdk.manifest.apiIndex, undefined, 'Not a genuine pre-index producer');
            if (name === 'combined') for (const input of runtimes) {
                const profile = sdk.profile(input.target, input.profile, input.variant);
                const entry = profile.descriptor.files.find(file => file.path === profile.engineEntry.slice(2));
                engineHashes.add(entry.sha256);
            }
            identities.push({ name, directory, sdkId: sdk.sdkId, manifestSha256: hash(await fs.readFile(path.join(directory, 'manifest.json'))) });
        }
        assert.equal(engineHashes.size, 8, 'All eight engine bundles must be independently built, not relabeled');
        assert.equal((await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: engine, env })).stdout, '',
            'SOURCE_DIRTY: provisioned clone must still be clean before candidate assembly');
        // No network or writable source outside this run. Compiler helpers clear
        // TMPDIR, so /tmp is private; rebind run inputs after masking host /tmp.
        // The assembler compiles current code itself, never a saved candidate.
        await run('offline-candidate', '/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent',
            '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', out, out, '--ro-bind', node, node,
            '--proc', '/proc', '--chdir', devkit, '--', node,
            path.join(devkit, 'scripts/prepare-release.mjs'), '--sdk-root', layout.sdk, '--node-archive', nodeArchive,
            '--out', layout.candidate], out, {}, 1800000);
        const { verifyInventory } = await import(pathToFileURL(path.join(devkit, 'scripts/verify-portable.mjs')));
        const candidate = await verifyInventory(layout.candidate);
        const combined = identities.find(item => item.name === 'combined');
        assert.equal(candidate.sdk.sdkId, combined.sdkId);
        assert.equal(candidate.sdk.manifestSha256, combined.manifestSha256);
        assert.equal(candidate.source.revision, inputs.revision);
        assert.equal(candidate.source.dirty, false, 'Candidate must come from clean source');
        assert.equal(candidate.runtime.node.archiveSha256, inputs.nodeArchive.sha256);
        inputs.candidate = { directory: layout.candidate, releaseId: candidate.releaseId, sdkId: candidate.sdk.sdkId,
            source: candidate.source, node: candidate.runtime.node, distributionApproved: candidate.distributionApproved };
        const integrationEnv = verificationEnvironment(layout, builtins, chrome);
        await fs.mkdir(integrationEnv.AI_TEST_EVIDENCE_ROOT);
        assert.equal((await run('portable-node-version', integrationEnv.PORTABLE_STARTUP_NODE, ['--version'], out, { PATH: '' }, 10000)).trim(),
            `v${nodeLock.version}`);
        await json('verification-inputs.json', { identities, runtimes, builtins, candidate: inputs.candidate, environment: integrationEnv,
            browserSha256: hash(await fs.readFile(chrome)), glslangSha256: hash(await fs.readFile(env.COCOS_EFFECT_GLSLANG)) });
        const files = (await fs.readdir(path.join(devkit, 'test'))).filter(file => file.endsWith('.test.mjs')).sort();
        // No detached verify-tests launcher: the exit status, terminal totals and
        // deadline all belong to the actual foreground test process.
        const totals = requireCompleteTap(await run('full-integration', node, ['--test', '--test-reporter=tap', '--test-concurrency=1',
            'build/probes/mcp-client.js', ...files.map(file => `test/${file}`)], devkit, integrationEnv, 7200000));
        assert(!interrupted, 'Verification interrupted');
        for (const [relative, digest] of Object.entries(inputs.locks)) assert.equal(hash(await fs.readFile(path.join(engine, relative))), digest);
        for (const identity of identities) assert.equal(hash(await fs.readFile(path.join(identity.directory, 'manifest.json'))), identity.manifestSha256,
            `SDK input changed during verification: ${identity.name}`);
        await requireNodeArchive(nodeArchive, nodeLock);
        assert.equal((await verifyInventory(layout.candidate)).releaseId, candidate.releaseId, 'Candidate changed during verification');
        assert(!interrupted, 'Verification interrupted');
        const result = await publishVerificationResult(out, { ...inputs, success: true, totals, records }, () => interrupted);
        assert(result.success, 'Verification interrupted');
        process.stdout.write(`[verification] Complete: ${path.join(out, 'result.json')}\n`);
    } catch (error) {
        await publishVerificationResult(out, { ...inputs, success: false,
            error: String(error.stack ?? error), records }, () => interrupted);
        throw error;
    } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
