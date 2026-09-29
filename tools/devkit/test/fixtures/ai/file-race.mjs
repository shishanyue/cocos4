// Test-only syscall-boundary fault injection. Never imported by the launcher.
// Also loaded into disposable debug-agent tool wrappers to exercise real Bun IO.
import fs from 'node:fs';
import path from 'node:path';

export function installFileRace(spec) {
    const originals = { openSync: fs.openSync, readSync: fs.readSync, renameSync: fs.renameSync, linkSync: fs.linkSync };
    let fired = false;
    function filename(value) {
        if (typeof value === 'number') return fs.readlinkSync(`/proc/self/fd/${value}`);
        if (typeof value !== 'string') return '';
        const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(value);
        return match ? fs.readlinkSync(`/proc/self/fd/${match[1]}`) + (match[2] ?? '') : path.resolve(value);
    }
    function inject() {
        fired = true;
        if (spec.marker) fs.writeFileSync(spec.marker, 'syscall-boundary-injection\n', { flag: 'wx', mode: 0o600 });
        if (spec.action === 'error') throw Object.assign(new Error('Injected IO failure'), { code: 'ENOSPC' });
        if (spec.action === 'parent') {
            originals.renameSync(spec.parent, spec.saved);
            fs.symlinkSync(spec.outside, spec.parent);
        } else if (spec.action === 'extra-link') {
            originals.linkSync(spec.target, spec.alias);
        } else {
            if (spec.remove !== false) fs.unlinkSync(spec.target);
            if (spec.action === 'symlink') fs.symlinkSync(spec.outside, spec.target);
            else if (spec.action === 'hardlink') originals.linkSync(spec.outside, spec.target);
            else throw new Error(`Unknown injection: ${spec.action}`);
        }
    }
    const method = spec.method;
    if (!Object.hasOwn(originals, method)) throw new Error(`Unsupported injection method: ${method}`);
    fs[method] = function (...args) {
        const candidate = method === 'linkSync' ? args[1] : args[0];
        const match = !fired && filename(candidate) === spec.match
            && (method !== 'linkSync' || String(args[0]).endsWith('.new'))
            && (method !== 'renameSync' || String(args[1]).endsWith('.old'));
        if (match && !spec.after) inject();
        const result = originals[method].apply(fs, args);
        if (match && spec.after) inject();
        return result;
    };
    return { get fired() { return fired; }, restore() { Object.assign(fs, originals); } };
}
