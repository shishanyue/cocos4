import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const usage = 'Usage: KIT/runtime/node play.mjs --kit KIT --run RUN [--ttl SECONDS]\n'
    + 'Serve the successful run\'s HTML5 artifact without rebuilding. Paths may be relative.\n'
    + 'Open the printed job.preview.url; Ctrl-C or the TTL (default 1800 seconds) stops it.\n';

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') { process.stdout.write(usage); return; }
    const flags = new Map();
    for (let i = 0; i < args.length; i += 2) {
        const [name, value] = args.slice(i, i + 2);
        assert(['--kit', '--run', '--ttl'].includes(name) && !flags.has(name) && value, usage);
        flags.set(name, value);
    }
    assert(flags.has('--kit') && flags.has('--run'), usage);
    const ttl = flags.get('--ttl') ?? '1800';
    assert(/^\d+$/.test(ttl) && Number(ttl) >= 1 && Number(ttl) <= 7200, 'TTL must be 1..7200 seconds');
    const kit = await fs.realpath(path.resolve(flags.get('--kit')));
    const run = await fs.realpath(path.resolve(flags.get('--run')));
    assert.equal(await fs.realpath(process.execPath), path.join(kit, 'runtime/node'), 'Use the selected kit\'s bundled Node');
    const release = JSON.parse(await fs.readFile(path.join(kit, 'release.json'), 'utf8'));
    const result = JSON.parse(await fs.readFile(path.join(run, 'evidence/result.json'), 'utf8'));
    assert.equal(process.versions.node, release.runtime.node.version);
    assert.equal(result.success, true, 'Choose a successful example run');
    assert.equal(result.releaseId, release.releaseId, 'The run belongs to a different kit');
    assert.equal(result.sdkId, release.sdk.sdkId, 'The run belongs to a different SDK');
    const workspace = path.join(run, 'workspace'), state = path.join(run, 'state');
    assert.equal(result.project, path.join(workspace, 'game-2048'), 'Rerun the example after relocating its workspace');
    assert.equal(result.state, state, 'The recorded private state must remain in place');
    const artifact = result.exports.find(item => item.target === 'HTML5' && item.entry === 'index.html');
    assert(artifact && artifact.provenance?.releaseId === release.releaseId && artifact.sdkId === release.sdk.sdkId,
        'No matching HTML5 artifact in the run');
    const child = spawn(path.join(kit, 'cocos4'), [
        'call', 'cocos4_preview_start', '--workspace', workspace, '--state-root', state,
        '--mode', 'develop', '--preview', 'true', '--input', JSON.stringify({
            artifactId: artifact.artifactId, ttlSeconds: Number(ttl), requestKey: `2048-play-${randomUUID()}`,
        }),
    ], { cwd: workspace, env: { PATH: '', LANG: 'C.UTF-8' }, stdio: 'inherit', detached: true });
    // A separate group receives each terminal signal once, through this foreground owner.
    let stopping = false;
    const stop = signal => { if (!stopping) { stopping = true; child.kill(signal); } };
    const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => resolve(code));
        });
        process.exitCode = code ?? 1;
    } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
    }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
