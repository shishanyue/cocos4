import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const devkit = fileURLToPath(new URL('../', import.meta.url));
const build = path.resolve(process.env.AI_TEST_BUILD_ROOT ?? path.join(devkit, 'build'));
const kit = path.dirname(build);
const skills = path.join(kit, 'skills');
const sdkRoot = path.resolve(process.env.AI_TEST_SDK_ROOT ?? path.join(devkit, 'build/game-sdk-isolated'));
const checker = path.join(skills, 'cocos4-minigame-dev/scripts/check-examples.mjs');

async function check(script, target, profile, ...options) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, '--sdk-root', sdkRoot, '--target', target, '--profile', profile, ...options], {
            shell: false, env: { PATH: '', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.stdout.on('data', bytes => { stdout += bytes; });
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.once('error', reject);
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
}

test('all packaged Markdown links resolve within the skills payload and names are unique', async () => {
    const names = [];
    let links = 0;
    async function walk(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            assert.equal(entry.isSymbolicLink(), false);
            if (entry.isDirectory()) { await walk(filename); continue; }
            if (!filename.endsWith('.md')) continue;
            const text = await fs.readFile(filename, 'utf8');
            if (entry.name === 'SKILL.md') {
                const name = /^name: (.+)$/m.exec(text)?.[1];
                assert.equal(name, path.basename(directory));
                assert.match(text, /^description: .{40,}$/m);
                names.push(name);
            }
            for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
                const target = match[1].split('#')[0];
                assert.equal(/^[a-z]+:/i.test(target), false, 'Package references must not rely on online documentation.');
                const resolved = path.resolve(directory, target);
                assert.ok(resolved.startsWith(`${skills}/`));
                assert.ok((await fs.stat(resolved)).isFile(), resolved);
                links++;
            }
            assert.doesNotMatch(text, /bin\/\.declarations|npm ci|setup:external|build:declaration|three directories above/);
        }
    }
    await walk(skills);
    assert.deepEqual(names.sort(), ['cocos4-devkit', 'cocos4-minigame-dev']);
    assert.ok(links >= 9);
});

test('packaged example checks all eight target/profile/variant combinations once with real SDK declarations/compiler', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.catalog.profiles.length, 8);
    const reports = [];
    for (const profile of manifest.catalog.profiles) {
        const result = await check(checker, profile.target, profile.id, '--variant', profile.variant);
        assert.equal(result.code, 0, result.stderr || result.stdout);
        assert.equal(result.signal, null);
        assert.equal(result.stderr, '');
        const report = JSON.parse(result.stdout);
        assert.equal(report.sdkId, manifest.sdkId);
        assert.deepEqual([report.target, report.profile, report.variant], [profile.target, profile.id, profile.variant]);
        assert.equal(report.typescript, '4.9.5');
        assert.equal(report.noEmit, true);
        assert.equal(report.strict, true);
        assert.equal(report.noImplicitAny, false);
        assert.equal(report.skipLibCheck, false);
        assert.equal(report.runtimeExecuted, false);
        assert.deepEqual(report.diagnostics, []);
        reports.push(report);
    }
    assert.deepEqual(reports.map(report => `${report.target}/${report.profile}/${report.variant}`).sort(),
        ['BILIBILI', 'HTML5'].flatMap(target => ['2d-basic', '3d-basic'].flatMap(profile =>
            ['debug', 'release'].map(variant => `${target}/${profile}/${variant}`))));
    if (process.env.AI_TEST_EVIDENCE_ROOT) await fs.writeFile(path.join(process.env.AI_TEST_EVIDENCE_ROOT, 'skills-types-evidence.json'),
        `${JSON.stringify(reports, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
});

test('packaged checker rejects missing, malformed and duplicate variant values', async () => {
    for (const [options, error] of [
        [['--variant'], /Invalid checker option/],
        [['--variant', ''], /Invalid checker option/],
        [['--variant', 'Release'], /--variant must be debug or release/],
        [['--variant', 'production'], /--variant must be debug or release/],
        [['--variant', 'debug', '--variant', 'release'], /Invalid checker option/],
    ]) {
        const result = await check(checker, 'HTML5', '2d-basic', ...options);
        assert.equal(result.code, 1, result.stderr || result.stdout);
        assert.equal(result.signal, null);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, error);
    }
});

test('packaged checker rejects an undelivered target/profile/variant through the real SDK verifier', async () => {
    const result = await check(checker, 'WECHAT', '2d-basic', '--variant', 'release');
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /PROFILE_NOT_AVAILABLE/);
    assert.match(result.stderr, /The requested target\/profile\/variant is not delivered in this SDK/);
});

test('packaged checker detects a real introduced type error without stubs or disabled checking', async t => {
    const root = await fs.mkdtemp(path.join(process.env.AI_TEST_EVIDENCE_ROOT ?? path.join(devkit, 'build'), 'ai-negative-skill-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'app'));
    await fs.cp(path.join(build, 'src'), path.join(root, 'app/src'), { recursive: true, force: false, errorOnExist: true });
    await fs.cp(skills, path.join(root, 'skills'), { recursive: true, force: false, errorOnExist: true });
    const filename = path.join(root, 'skills/cocos4-minigame-dev/examples/TapCounter.ts');
    const text = await fs.readFile(filename, 'utf8');
    assert.ok(text.includes('pointsPerTap = 1;'));
    await fs.writeFile(filename, text.replace('pointsPerTap = 1;', 'pointsPerTap: number = "wrong";'));
    const result = await check(path.join(root, 'skills/cocos4-minigame-dev/scripts/check-examples.mjs'), 'HTML5', '2d-basic');
    assert.equal(result.code, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual([report.target, report.profile, report.variant], ['HTML5', '2d-basic', 'debug']);
    assert.ok(report.diagnostics.some(item => item.code === 2322));
});
