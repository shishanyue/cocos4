import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicit maintainer crossbuild only; never imported by the application build.
// CLI: node scripts/build-supervisor-win32.mjs [--output ABSENT_ABSOLUTE_EXE]
//      --compiler ABSOLUTE_ZIG [--fixture-output ABSENT_ABSOLUTE_EXE]
// Both artifacts receive a <output>.json provenance/PE evidence sidecar.
const root = fileURLToPath(new URL('../', import.meta.url));
const flags = Object.freeze([
    'cc', '-target', 'x86_64-windows-gnu', '-municode', '-std=c11', '-O2',
    '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2',
    '-Wl,--dynamicbase,--nxcompat,--high-entropy-va',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reads actual PE32+ directories/sections/import thunks, not compiler promises.
export function inspectPeWin32(bytes) {
    assert(Buffer.isBuffer(bytes) && bytes.length >= 256 && bytes.length <= 32 * 1024 * 1024, 'PE size');
    const range = (offset, size) => {
        assert(Number.isSafeInteger(offset) && offset >= 0 && size >= 0 && offset + size <= bytes.length, 'PE bounds');
        return offset;
    };
    const u16 = offset => bytes.readUInt16LE(range(offset, 2));
    const u32 = offset => bytes.readUInt32LE(range(offset, 4));
    assert.equal(u16(0), 0x5a4d, 'DOS signature');
    const pe = u32(0x3c);
    assert.equal(u32(pe), 0x4550, 'PE signature');
    const coff = pe + 4, optional = coff + 20;
    assert.equal(u16(coff), 0x8664, 'PE must be AMD64');
    assert.equal(u16(optional), 0x20b, 'PE must be PE32+');
    const optionalSize = u16(coff + 16);
    assert(optionalSize >= 240, 'PE data directories');
    range(optional, optionalSize);
    assert(u32(optional + 108) >= 16, 'PE directory count');
    const count = u16(coff + 2);
    assert(count > 0 && count <= 96, 'PE section count');
    const sections = [];
    for (let i = 0; i < count; i++) {
        const entry = range(optional + optionalSize + i * 40, 40);
        const characteristics = u32(entry + 36);
        sections.push({ name: bytes.subarray(entry, entry + 8).toString('ascii').replace(/\0.*$/s, ''),
            virtualSize: u32(entry + 8), rva: u32(entry + 12), rawSize: u32(entry + 16), rawOffset: u32(entry + 20),
            executable: Boolean(characteristics & 0x20000000), writable: Boolean(characteristics & 0x80000000) });
        if (sections.at(-1).rawSize) range(sections.at(-1).rawOffset, sections.at(-1).rawSize);
    }
    const atRva = (rva, size = 1) => {
        if (rva < u32(optional + 60)) return range(rva, size);
        const section = sections.find(s => rva >= s.rva && rva + size <= s.rva + s.rawSize);
        assert(section, `Unmapped PE RVA ${rva}`);
        return range(section.rawOffset + rva - section.rva, size);
    };
    const stringAtRva = rva => {
        const start = atRva(rva), end = bytes.indexOf(0, start);
        assert(end >= start && end - start <= 4096, 'Bounded PE string');
        atRva(rva, end - start + 1);
        return bytes.subarray(start, end).toString('ascii');
    };
    const directory = index => ({ rva: u32(optional + 112 + index * 8), bytes: u32(optional + 116 + index * 8) });
    const imports = [];
    const importDirectory = directory(1);
    assert(importDirectory.rva && importDirectory.bytes >= 20, 'PE imports required');
    let terminated = false;
    for (let offset = 0; offset + 20 <= importDirectory.bytes; offset += 20) {
        const entry = atRva(importDirectory.rva + offset, 20);
        if (bytes.subarray(entry, entry + 20).every(value => value === 0)) { terminated = true; break; }
        const name = stringAtRva(u32(entry + 12));
        const thunk = u32(entry) || u32(entry + 16);
        const symbols = [];
        for (let i = 0; ; i++) {
            assert(i < 16384, 'Bounded PE import thunks');
            const value = bytes.readBigUInt64LE(atRva(thunk + i * 8, 8));
            if (!value) break;
            if (value & (1n << 63n)) symbols.push(`#${value & 0xffffn}`);
            else { assert(value <= 0xffffffffn, 'PE import RVA'); symbols.push(stringAtRva(Number(value) + 2)); }
        }
        imports.push({ library: name, symbols: symbols.sort() });
    }
    assert(terminated, 'PE import terminator');
    assert.equal(directory(13).rva, 0, 'Review delay imports before enabling them');
    const dll = u16(optional + 70), relocations = directory(5), loadConfig = directory(10);
    const hardening = {
        dynamicBase: Boolean(dll & 0x40), highEntropyVA: Boolean(dll & 0x20), nxCompatible: Boolean(dll & 0x100),
        relocationsPresent: relocations.rva !== 0 && relocations.bytes > 0 && !(u16(coff + 18) & 1),
        writableExecutableSections: sections.filter(s => s.writable && s.executable).map(s => s.name),
        controlFlowGuard: Boolean(dll & 0x4000),
        loadConfigBytes: loadConfig.bytes,
        authenticodePresent: directory(4).bytes > 0,
    };
    if (relocations.rva) atRva(relocations.rva, relocations.bytes);
    assert(hardening.dynamicBase && hardening.highEntropyVA && hardening.nxCompatible && hardening.relocationsPresent, 'Required PE hardening');
    assert.equal(hardening.writableExecutableSections.length, 0, 'No writable executable sections');
    const osVersion = [u16(optional + 40), u16(optional + 42)];
    const subsystemVersion = [u16(optional + 48), u16(optional + 50)];
    assert.equal(u16(optional + 68), 3, 'Console subsystem');
    return { parser: 'bounded-pe32plus-v1', machine: 'AMD64', machineValue: u16(coff), format: 'PE32+',
        osVersion, subsystemVersion, subsystem: 'WINDOWS_CUI', coffTimestamp: u32(coff + 4),
        imports: imports.sort((a, b) => a.library.localeCompare(b.library, 'en')), hardening, sections };
}

function execute(compiler, args, timeout = 240000) {
    return new Promise((resolve, reject) => {
        const child = spawn(compiler, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
        for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { text = (text + bytes.toString('utf8')).slice(-32768); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0 && !timedOut) resolve(text.trim());
            else reject(new Error(`Compiler failed (${timedOut ? 'timeout' : code ?? signal}): ${text}`));
        });
    });
}
async function absent(file) {
    try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error(`Refusing to overwrite ${file}`);
}
async function build({ output, compiler }, relativeSource, component) {
    assert(path.isAbsolute(output), 'Output must be an absent absolute path');
    assert(typeof compiler === 'string' && path.isAbsolute(compiler), 'Compiler must be an explicit absolute Zig executable');
    const evidencePath = `${output}.json`;
    await absent(output);
    await absent(evidencePath);
    const launcherPath = await fs.realpath(compiler);
    const launcherHash = sha256(await fs.readFile(launcherPath));
    const version = await execute(compiler, ['version'], 10000);
    assert.equal(version, '0.16.0', 'Review a different Zig version before changing the qualification baseline');
    // pip/uv installations can expose a Python shim, not the actual compiler.
    const zigEnvironment = await execute(compiler, ['env'], 10000);
    const executableField = zigEnvironment.match(/^\s*\.zig_exe\s*=\s*("(?:[^"\\]|\\.)*"),\s*$/m);
    assert(executableField, 'Expected Zig 0.16 env ZON zig_exe field');
    const compilerPath = await fs.realpath(JSON.parse(executableField[1]));
    assert(path.isAbsolute(compilerPath));
    const compilerHash = sha256(await fs.readFile(compilerPath));
    assert.equal(await execute(compilerPath, ['version'], 10000), version);
    const source = path.join(root, relativeSource);
    const sourceBytes = await fs.readFile(source);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(path.dirname(output), '.windows-supervisor-'));
    let publishedOutput = false, publishedEvidence = false;
    try {
        const staged = path.join(temporary, 'component.exe');
        const argumentsUsed = [...flags, source, '-o', staged];
        const diagnostics = await execute(compiler, argumentsUsed);
        assert.equal(sha256(await fs.readFile(source)), sha256(sourceBytes), 'Source changed during compilation');
        assert.equal(sha256(await fs.readFile(launcherPath)), launcherHash, 'Compiler launcher changed during compilation');
        assert.equal(sha256(await fs.readFile(compilerPath)), compilerHash, 'Compiler changed during compilation');
        const binary = await fs.readFile(staged);
        const pe = inspectPeWin32(binary);
        if (component === 'supervisor') {
            const symbols = new Set(pe.imports.flatMap(value => value.symbols));
            for (const name of ['CreateJobObjectW', 'SetInformationJobObject', 'QueryInformationJobObject', 'TerminateJobObject',
                'InitializeProcThreadAttributeList', 'UpdateProcThreadAttribute', 'CreateProcessW', 'GetProcessTimes', 'ResumeThread']) {
                assert(symbols.has(name), `Required actual import: ${name}`);
            }
            assert(!symbols.has('AssignProcessToJobObject'), 'Post-creation association is forbidden');
        }
        const evidence = { version: 1, component, qualification: 'BLOCKED_REAL_WINDOWS_ACCEPTANCE',
            platform: 'win32', arch: 'x64', windowsFloor: 'Windows 10', protocolVersion: component === 'supervisor' ? 1 : null,
            file: path.basename(output), bytes: binary.length, sha256: sha256(binary),
            source: relativeSource, sourceSha256: sha256(sourceBytes),
            compiler: { path: compilerPath, version, sha256: compilerHash,
                launcher: { requestedPath: compiler, realPath: launcherPath, sha256: launcherHash },
                flags: [...flags], arguments: argumentsUsed },
            pe, diagnostics,
            limitations: ['Crossbuild and PE inspection do not establish real Windows execution or application support.',
                'Windows 10 is the API floor, not a claim that the PE header blocks older Windows; JOB_LIST failure is fatal.',
                'Unsigned component; no assertion of CFG/CET or hostile-code isolation.',
                'Compiler hash covers the Zig executable, not its complete resource/cache/toolchain closure.'] };
        await fs.writeFile(path.join(temporary, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
        // Hard-link publication is atomic and no-replace; staging is on the same volume.
        await fs.link(staged, output); publishedOutput = true;
        await fs.link(path.join(temporary, 'evidence.json'), evidencePath); publishedEvidence = true;
        return { output, evidencePath, ...evidence };
    } catch (error) {
        if (publishedEvidence) await fs.unlink(evidencePath);
        if (publishedOutput) await fs.unlink(output);
        throw error;
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export function buildSupervisorWin32({ output = path.join(root, 'build/windows-host/cocos4-supervise.exe'), compiler } = {}) {
    return build({ output, compiler }, 'runtime/supervise-win32.c', 'supervisor');
}
export function buildWindowsSupervisorFixture({ output, compiler }) {
    return build({ output, compiler }, 'test/fixtures/windows-supervisor-fixture.c', 'acceptance-fixture');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
        const name = process.argv[i];
        assert(['--output', '--compiler', '--fixture-output'].includes(name) && process.argv[i + 1], 'See the build script CLI comment');
        assert(!(name in options), `Duplicate ${name}`);
        options[name] = process.argv[i + 1];
    }
    const result = await buildSupervisorWin32({ output: options['--output'], compiler: options['--compiler'] });
    process.stdout.write(`${JSON.stringify({ output: result.output, evidencePath: result.evidencePath, sha256: result.sha256 })}\n`);
    if (options['--fixture-output']) {
        const fixture = await buildWindowsSupervisorFixture({ output: options['--fixture-output'], compiler: options['--compiler'] });
        process.stdout.write(`${JSON.stringify({ output: fixture.output, evidencePath: fixture.evidencePath, sha256: fixture.sha256 })}\n`);
    }
}
