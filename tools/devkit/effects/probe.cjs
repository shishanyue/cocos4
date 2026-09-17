const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { verifySource, prepareCompiler, verifyCompiler } = require('./prepare-source.cjs');
const { profiles } = require('./builtin-inputs.cjs');
const { buildOfflineMappings } = require('../../../scripts/build-offline-mappings.cjs');

async function probe(profile) {
    if (!Object.hasOwn(profiles, profile)) throw new Error(`Unknown profile: ${profile}`);
    const engine = path.resolve(__dirname, '../../..');
    const build = path.join(__dirname, 'build');
    const compiler = path.join(build, 'compiler');
    await verifySource(compiler);
    const staging = await fs.mkdtemp(path.join(build, 'artifact-staging-'));
    try {
        // Each attempt owns its cc bridge, including during concurrent maintainer probes.
        const cc = path.join(staging, 'node_modules/cc');
        const mappingFile = path.join(cc, 'editor/offline-mappings.cjs');
        const mappings = await buildOfflineMappings(mappingFile);
        await fs.writeFile(path.join(cc, 'package.json'), JSON.stringify({
            name: 'cc', private: true, exports: { './editor/offline-mappings': './editor/offline-mappings.cjs' },
        }));
        const compilerCopy = path.join(staging, 'compiler');
        const compilerFiles = await prepareCompiler(compiler, compilerCopy);
        await verifyCompiler(compilerCopy, compilerFiles);
        const env = {};
        for (const key of ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'HOME', 'SYSTEMROOT', 'TEMP', 'TMP', 'LIBGL_ALWAYS_SOFTWARE', 'COCOS_EFFECT_GLSLANG']) {
            if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [
            path.join(__dirname, 'probe-worker.cjs'), engine, profile, staging, compilerCopy,
        ], { cwd: __dirname, env, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        const report = JSON.parse(await fs.readFile(path.join(staging, 'result.json'), 'utf8'));
        await verifyCompiler(compilerCopy, compilerFiles);
        await verifySource(compiler);
        report.compiler = { ...require('./source-lock.json'), patch: require('./patch-lock.json') };
        report.node = process.version;
        report.mappings = { ...mappings, sha256: createHash('sha256').update(await fs.readFile(mappingFile)).digest('hex') };
        report.lockSha256 = createHash('sha256').update(await fs.readFile(path.join(__dirname, 'package-lock.json'))).digest('hex');
        // Source/tool bridges are build inputs, not game runtime resources.
        await fs.rm(path.join(staging, 'node_modules'), { recursive: true });
        await fs.rm(compilerCopy, { recursive: true });
        await fs.writeFile(path.join(staging, 'result.json'), JSON.stringify(report, null, 2));
        const output = staging.replace('artifact-staging-', 'artifact-');
        await fs.rename(staging, output);
        return { output, effects: report.effects.length, materials: report.materials.length, graphics: report.graphics };
    } catch (error) {
        await fs.rm(staging, { recursive: true, force: true });
        const log = path.join(build, `failure-${randomUUID()}.log`);
        const detail = error.stderr || error.stack || String(error);
        await fs.writeFile(log, `${error.stdout || ''}${detail}`, { flag: 'wx' });
        const summary = detail.match(/^.*EFX\d+.*$/m)?.[0] || error.message.split('\n')[0];
        throw new Error(`Effect probe failed (${profile}): ${summary}\nDetails: ${log}`);
    }
}

module.exports = { probe };
if (require.main === module) {
    if (process.argv.length > 3) {
        console.error('Usage: node probe.cjs [2d-basic|3d-basic]');
        process.exitCode = 1;
    } else {
        probe(process.argv[2] || '2d-basic').then(result => console.log(JSON.stringify(result, null, 2)))
            .catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
