import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Maintainer build only; the application never discovers or runs a compiler.
// CLI: node scripts/build-supervisor-win32.mjs [--output ABSENT_ABSOLUTE_EXE]
//      --compiler ABSOLUTE_ZIG_OR_CL [--fixture-output ABSENT_ABSOLUTE_EXE]
// Both artifacts receive a <output>.json provenance/PE evidence sidecar.
const root = fileURLToPath(new URL('../', import.meta.url));
const flags = Object.freeze([
    'cc', '-target', 'x86_64-windows-gnu', '-municode', '-std=c11', '-O2',
    '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2',
    '-Wl,--dynamicbase,--nxcompat,--high-entropy-va',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reads actual PE32+ directories/sections/import thunks, not compiler promises.
export function inspectPeWin32(bytes, { maximumBytes = 32 * 1024 * 1024, allowDelayImports = false } = {}) {
    assert(Number.isSafeInteger(maximumBytes) && maximumBytes >= 256 && maximumBytes <= 128 * 1024 * 1024, 'PE size limit');
    assert.equal(typeof allowDelayImports, 'boolean');
    assert(Buffer.isBuffer(bytes) && bytes.length >= 256 && bytes.length <= maximumBytes, 'PE size');
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
    const imageBase = bytes.readBigUInt64LE(range(optional + 24, 8));
    const vaToRva = value => {
        const rva = BigInt(value) - imageBase;
        assert(rva >= 0n && rva <= 0xffffffffn, 'PE delay import VA');
        return Number(rva);
    };
    const importSymbols = (thunk, virtualAddresses = false) => {
        assert(thunk, 'PE import name table');
        const symbols = [];
        for (let i = 0; ; i++) {
            assert(i < 16384, 'Bounded PE import thunks');
            const value = bytes.readBigUInt64LE(atRva(thunk + i * 8, 8));
            if (!value) return symbols.sort();
            if (value & (1n << 63n)) symbols.push(`#${value & 0xffffn}`);
            else {
                const nameRva = virtualAddresses ? vaToRva(value) : Number(value);
                assert(nameRva <= 0xffffffff, 'PE import RVA');
                symbols.push(stringAtRva(nameRva + 2));
            }
        }
    };
    const imports = [];
    const importDirectory = directory(1);
    assert(importDirectory.rva && importDirectory.bytes >= 20, 'PE imports required');
    let terminated = false;
    for (let offset = 0; offset + 20 <= importDirectory.bytes; offset += 20) {
        const entry = atRva(importDirectory.rva + offset, 20);
        if (bytes.subarray(entry, entry + 20).every(value => value === 0)) { terminated = true; break; }
        const name = stringAtRva(u32(entry + 12));
        const thunk = u32(entry) || u32(entry + 16);
        imports.push({ library: name, symbols: importSymbols(thunk) });
    }
    assert(terminated, 'PE import terminator');
    const delayDirectory = directory(13);
    if (!allowDelayImports) {
        assert.equal(delayDirectory.rva, 0, 'Review delay imports before enabling them');
        assert.equal(delayDirectory.bytes, 0, 'Review delay imports before enabling them');
    } else if (delayDirectory.rva || delayDirectory.bytes) {
        assert(delayDirectory.rva && delayDirectory.bytes >= 32, 'PE delay import directory');
        let delayTerminated = false;
        for (let offset = 0; offset + 32 <= delayDirectory.bytes; offset += 32) {
            const entry = atRva(delayDirectory.rva + offset, 32);
            if (bytes.subarray(entry, entry + 32).every(value => value === 0)) { delayTerminated = true; break; }
            const attributes = u32(entry);
            assert(attributes === 0 || attributes === 1, 'PE delay import attributes');
            const address = field => {
                const value = u32(entry + field);
                return value && attributes === 0 ? vaToRva(value) : value;
            };
            const name = address(4), iat = address(12), names = address(16);
            assert(name && iat && names, 'PE delay import names and tables');
            atRva(iat, 8);
            for (const field of [8, 20, 24]) { const rva = address(field); if (rva) atRva(rva, 8); }
            imports.push({ library: stringAtRva(name), symbols: importSymbols(names, attributes === 0), kind: 'delay' });
        }
        assert(delayTerminated, 'PE delay import terminator');
    }
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

function execute(compiler, args, timeout = 240000, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(compiler, args, { cwd: options.cwd, env: options.env,
            shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
        for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { text = (text + bytes.toString('utf8')).slice(-32768); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if ((options.acceptedCodes ?? [0]).includes(code) && !timedOut) resolve(text.trim());
            else reject(new Error(`Compiler failed (${timedOut ? 'timeout' : code ?? signal}): ${text}`));
        });
    });
}
function environmentValue(name) {
    return process.env[Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase())];
}
function compilerEnvironment() {
    const environment = { LANG: 'C', LC_ALL: 'C', SOURCE_DATE_EPOCH: '0', VSLANG: '1033' };
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'XDG_CACHE_HOME']) {
        const value = environmentValue(name);
        if (value) environment[name] = value;
    }
    return environment;
}
async function regular(file) {
    try { const stat = await fs.stat(file); return stat.isFile(); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

// Only packaging entry points opt into discovery. The explicit crossbuilders
// below deliberately keep their no-implicit-compiler contract.
export async function detectWindowsCompiler() {
    assert.equal(process.platform, 'win32', 'Automatic MSVC discovery requires Windows');
    assert.equal(process.arch, 'x64', 'Windows host helpers require an x64 host');
    const configured = process.env.COCOS4_WINDOWS_COMPILER;
    if (configured) {
        assert(path.isAbsolute(configured), 'COCOS4_WINDOWS_COMPILER must be an absolute executable path');
        return fs.realpath(configured);
    }
    const programFiles = environmentValue('ProgramFiles(x86)');
    assert(programFiles && path.isAbsolute(programFiles), 'Windows ProgramFiles(x86) is required to locate Visual Studio');
    const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    assert(await regular(vswhere), 'Install Visual Studio Build Tools with the x64 C++ toolchain, or set COCOS4_WINDOWS_COMPILER');
    const installations = JSON.parse(await execute(vswhere, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-format', 'json', '-utf8'], 10000, { env: compilerEnvironment() }));
    assert(Array.isArray(installations), 'Invalid Visual Studio discovery result');
    for (const installation of installations) {
        if (typeof installation.installationPath !== 'string' || !path.isAbsolute(installation.installationPath)) continue;
        const toolsets = path.join(installation.installationPath, 'VC', 'Tools', 'MSVC');
        let versions;
        try { versions = await fs.readdir(toolsets); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const version of versions.filter(value => /^\d+(?:\.\d+)+$/.test(value)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
            const compiler = path.join(toolsets, version, 'bin', 'Hostx64', 'x64', 'cl.exe');
            if (await regular(compiler)) return fs.realpath(compiler);
        }
    }
    throw new Error('No x64 MSVC compiler found. Install Visual Studio Build Tools with the C++ workload.');
}

async function msvcToolchain(compiler) {
    assert.equal(process.platform, 'win32', 'MSVC requires a Windows host');
    assert.equal(process.arch, 'x64', 'MSVC host helpers require an x64 host');
    const directory = path.dirname(compiler);
    assert.equal(path.basename(directory).toLowerCase(), 'x64', 'Use the x64 MSVC compiler');
    assert.equal(path.basename(path.dirname(directory)).toLowerCase(), 'hostx64', 'Use the x64-hosted MSVC compiler');
    const toolset = path.resolve(directory, '../../..');
    assert(await regular(path.join(toolset, 'include', 'vcruntime.h')), 'Missing MSVC C headers');
    const sdkRoot = environmentValue('WindowsSdkDir')
        ?? path.join(environmentValue('ProgramFiles(x86)') ?? '', 'Windows Kits', '10');
    assert(path.isAbsolute(sdkRoot), 'Windows SDK must have an absolute installation path');
    const versions = (await fs.readdir(path.join(sdkRoot, 'Include'))).filter(value => /^10\.\d+\.\d+\.\d+$/.test(value))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const version of versions) {
        const include = path.join(sdkRoot, 'Include', version), libraries = path.join(sdkRoot, 'Lib', version);
        const required = [path.join(include, 'um', 'windows.h'), path.join(include, 'ucrt', 'stdio.h'),
            path.join(libraries, 'um', 'x64', 'kernel32.lib'), path.join(libraries, 'ucrt', 'x64', 'libucrt.lib')];
        if (!(await Promise.all(required.map(regular))).every(Boolean)) continue;
        return { directory, toolset, sdkRoot, sdkVersion: version,
            includes: [path.join(toolset, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map(name => path.join(include, name))],
            libraries: [path.join(toolset, 'lib', 'x64'), path.join(libraries, 'ucrt', 'x64'), path.join(libraries, 'um', 'x64')] };
    }
    throw new Error('Install a complete Windows 10 or 11 SDK with x64 UCRT and Windows import libraries.');
}

export async function compileWindowsSource({ compiler, source, output, reproducible = true }) {
    assert(typeof compiler === 'string' && path.isAbsolute(compiler), 'Compiler must be an explicit absolute Zig executable or MSVC cl.exe');
    assert(path.isAbsolute(source) && path.isAbsolute(output), 'Compiler input and output must be absolute paths');
    await absent(output);
    const launcherPath = await fs.realpath(compiler), launcherHash = sha256(await fs.readFile(launcherPath));
    const sourceBytes = await fs.readFile(source), environment = compilerEnvironment();
    let compilerPath = launcherPath, compilerHash = launcherHash, version, selectedFlags, toolchain;
    const kind = path.basename(launcherPath).toLowerCase() === 'cl.exe' ? 'msvc' : 'zig';
    if (kind === 'msvc') {
        toolchain = await msvcToolchain(compilerPath);
        environment.PATH = [toolchain.directory, path.join(environment.SystemRoot ?? environment.WINDIR, 'System32')].join(path.delimiter);
        const banner = await execute(compilerPath, ['/Bv'], 10000, { env: environment, acceptedCodes: [0, 2] });
        const found = banner.match(/Compiler Version (\d+(?:\.\d+)+) for x64/);
        assert(found, 'Expected the MSVC x64 compiler version banner');
        version = found[1];
        selectedFlags = ['/nologo', '/std:c11', '/O2', '/W4', '/WX', '/MT', '/GS', '/guard:cf', '/utf-8', '/D_CRT_SECURE_NO_WARNINGS',
            ...(reproducible ? ['/Brepro'] : []), ...toolchain.includes.flatMap(directory => ['/I', directory])];
    } else {
        // The explicit launcher may be a pip/uv shim with an env-based shebang.
        // Resolve its real Zig binary before compiling in the filtered environment.
        const launcherEnvironment = { ...environment, ...(process.env.PATH ? { PATH: process.env.PATH } : {}) };
        version = await execute(compiler, ['version'], 10000, { env: launcherEnvironment });
        assert.equal(version, '0.16.0', 'Review a different Zig version before changing the qualification baseline');
        const zigEnvironment = await execute(compiler, ['env'], 10000, { env: launcherEnvironment });
        const executableField = zigEnvironment.match(/^\s*\.zig_exe\s*=\s*("(?:[^"\\]|\\.)*"),\s*$/m);
        assert(executableField, 'Expected Zig 0.16 env ZON zig_exe field');
        compilerPath = await fs.realpath(JSON.parse(executableField[1]));
        compilerHash = sha256(await fs.readFile(compilerPath));
        assert.equal(await execute(compilerPath, ['version'], 10000, { env: environment }), version);
        selectedFlags = [...flags, ...(reproducible ? ['-Wl,--no-insert-timestamp'] : [])];
    }
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(path.dirname(output), '.windows-compile-'));
    try {
        await fs.writeFile(path.join(temporary, 'input.c'), sourceBytes, { flag: 'wx' });
        const argumentsUsed = kind === 'msvc'
            ? [...selectedFlags, '/Fo:component.obj', '/Fe:component.exe', 'input.c', '/link', '/INCREMENTAL:NO',
                '/DYNAMICBASE', '/HIGHENTROPYVA', '/NXCOMPAT', '/GUARD:CF', ...(reproducible ? ['/Brepro'] : []),
                ...toolchain.libraries.map(directory => `/LIBPATH:${directory}`), 'advapi32.lib', 'shell32.lib', 'userenv.lib']
            : [...selectedFlags, 'input.c', '-o', 'component.exe'];
        const diagnostics = await execute(compilerPath, argumentsUsed, 240000, { cwd: temporary, env: environment });
        assert.deepEqual(await fs.readFile(source), sourceBytes, 'Source changed during compilation');
        assert.equal(sha256(await fs.readFile(launcherPath)), launcherHash, 'Compiler launcher changed during compilation');
        assert.equal(sha256(await fs.readFile(compilerPath)), compilerHash, 'Compiler changed during compilation');
        const binary = await fs.readFile(path.join(temporary, 'component.exe'));
        const pe = inspectPeWin32(binary);
        if (kind === 'msvc') assert(pe.hardening.controlFlowGuard && pe.hardening.loadConfigBytes > 0, 'MSVC Control Flow Guard is required');
        await fs.link(path.join(temporary, 'component.exe'), output);
        return { compiler: { kind, path: compilerPath, version, sha256: compilerHash,
            launcher: { requestedPath: compiler, realPath: launcherPath, sha256: launcherHash },
            ...(toolchain ? { toolset: toolchain.toolset, sdkRoot: toolchain.sdkRoot, sdkVersion: toolchain.sdkVersion } : {}) },
            flags: selectedFlags, arguments: argumentsUsed, environment, diagnostics, pe };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function absent(file) {
    try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error(`Refusing to overwrite ${file}`);
}
async function build({ output, compiler }, relativeSource, component) {
    assert(path.isAbsolute(output), 'Output must be an absent absolute path');
    assert(typeof compiler === 'string' && path.isAbsolute(compiler), 'Compiler must be an explicit absolute Zig executable or MSVC cl.exe');
    const evidencePath = `${output}.json`;
    await absent(output);
    await absent(evidencePath);
    const source = path.join(root, relativeSource);
    const sourceBytes = await fs.readFile(source);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(path.dirname(output), '.windows-supervisor-'));
    let publishedOutput = false, publishedEvidence = false;
    try {
        const staged = path.join(temporary, 'component.exe');
        const compiled = await compileWindowsSource({ compiler, source, output: staged });
        assert.equal(sha256(await fs.readFile(source)), sha256(sourceBytes), 'Source changed during compilation');
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
            compiler: { ...compiled.compiler, flags: compiled.flags, arguments: compiled.arguments },
            environment: compiled.environment, pe, diagnostics: compiled.diagnostics,
            limitations: ['Crossbuild and PE inspection do not establish real Windows execution or application support.',
                'Windows 10 is the API floor, not a claim that the PE header blocks older Windows; JOB_LIST failure is fatal.',
                'Unsigned component; PE flags are not evidence of hostile-code isolation or CET.',
                'Compiler hash covers the compiler executable, not its complete resource/cache/toolchain closure.'] };
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
