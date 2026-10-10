// Test-only syscall-boundary fault injection. Never imported by the launcher.
// Also loaded into disposable debug-agent tool wrappers to exercise real Bun IO.
import fs from 'node:fs';
import path from 'node:path';

export function installFileRace(spec) {
    const originals = { openSync: fs.openSync, readSync: fs.readSync, renameSync: fs.renameSync, linkSync: fs.linkSync };
    let fired = false, blocked = false, originalFile;
    const descriptors = new Map();
    function filename(value) {
        if (typeof value === 'number') return process.platform === 'win32' ? descriptors.get(value) ?? '' : fs.readlinkSync(`/proc/self/fd/${value}`);
        if (typeof value !== 'string') return '';
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(value);
        return match ? fs.readlinkSync(`/proc/self/fd/${match[1]}`) + (match[2] ?? '') : path.resolve(value);
    }
    function inject() {
        fired = true;
        if (spec.marker) fs.writeFileSync(spec.marker, 'syscall-boundary-injection\n', { flag: 'wx', mode: 0o600 });
        if (spec.action === 'error') throw Object.assign(new Error('Injected IO failure'), { code: 'ENOSPC' });
        if (spec.action === 'parent') {
            try { originals.renameSync(spec.parent, spec.saved); }
            catch (error) {
                if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) blocked = true;
                throw error;
            }
            fs.symlinkSync(spec.outside, spec.parent, process.platform === 'win32' ? 'junction' : 'dir');
        } else if (spec.action === 'extra-link') {
            originals.linkSync(spec.target, spec.alias);
        } else {
            if (spec.remove !== false) {
                if (process.platform === 'win32' && spec.method === 'renameSync') {
                    // Node 18 uses delete-pending semantics for an open file.
                    // Retain the actor's withdrawn input so alias creation can
                    // actually reach the publication boundary on both runtimes.
                    originalFile = `${spec.saved}-file`;
                    originals.renameSync(spec.target, originalFile);
                } else fs.unlinkSync(spec.target);
            }
            if (spec.action === 'symlink') fs.symlinkSync(spec.outside, spec.target);
            else if (spec.action === 'hardlink') originals.linkSync(spec.outside, spec.target);
            else throw new Error(`Unknown injection: ${spec.action}`);
        }
    }
    const method = spec.method;
    if (!Object.hasOwn(originals, method)) throw new Error(`Unsupported injection method: ${method}`);
    if (process.platform === 'win32' && method !== 'openSync') {
        fs.openSync = function (...args) {
            const fd = originals.openSync.apply(fs, args);
            descriptors.set(fd, filename(args[0])); return fd;
        };
    }
    fs[method] = function (...args) {
        const candidate = method === 'linkSync' ? args[1] : args[0];
        const match = !fired && filename(candidate) === spec.match
            && (method !== 'linkSync' || String(args[0]).endsWith('.new'))
            && (method !== 'renameSync' || String(args[1]).endsWith('.old'));
        if (match && !spec.after) inject();
        const result = originals[method].apply(fs, args);
        if (process.platform === 'win32' && method === 'openSync') descriptors.set(result, filename(args[0]));
        if (match && spec.after) inject();
        return result;
    };
    return { get fired() { return fired; }, get blocked() { return blocked; }, get originalFile() { return originalFile; },
        restore() { Object.assign(fs, originals); } };
}
