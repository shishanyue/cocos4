const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { sha256 } = require('./files.cjs');

const compilerRoots = ['typescript', '@babel/core', '@cocos/babel-preset-cc', '@babel/plugin-transform-modules-systemjs'];

// Record the installed, lock-checked transitive/peer closure, including nested npm resolutions.
// This is packaging input for the SDK owner, not a claim that the compiler is already portable.
async function compilerDependencies(engine) {
    const lockBytes = await fs.readFile(path.join(engine, 'package-lock.json'));
    const lock = JSON.parse(lockBytes);
    const packages = new Map();
    async function visit(name, from) {
        const resolver = createRequire(from);
        let manifest;
        for (const directory of resolver.resolve.paths(name)) {
            const candidate = path.join(directory, name, 'package.json');
            try { await fs.access(candidate); manifest = candidate; break; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        assert.ok(manifest, `Missing compiler dependency: ${name}`);
        const relative = path.relative(engine, path.dirname(manifest)).replaceAll('\\', '/');
        assert.ok(relative.startsWith('node_modules/'), `Compiler dependency outside engine: ${manifest}`);
        if (packages.has(relative)) return relative;
        const bytes = await fs.readFile(manifest);
        const pkg = JSON.parse(bytes);
        const pinned = lock.packages[relative];
        assert.equal(pkg.name, name);
        assert.equal(pkg.version, pinned?.version, `Compiler lock mismatch: ${relative}`);
        assert.ok(pinned.integrity, `Missing compiler integrity: ${relative}`);
        const item = { path: relative, name, version: pkg.version, integrity: pinned.integrity,
            resolved: pinned.resolved, license: pkg.license, packageSha256: sha256(bytes), dependencies: {} };
        packages.set(relative, item);
        for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).sort()) {
            if (pkg.peerDependenciesMeta?.[dependency]?.optional && !pkg.dependencies?.[dependency]) continue;
            item.dependencies[dependency] = await visit(dependency, manifest);
        }
        return relative;
    }
    const roots = {};
    for (const name of compilerRoots) roots[name] = await visit(name, path.join(engine, 'package.json'));
    return { schemaVersion: 1, rootLockSha256: sha256(lockBytes), roots,
        packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}

module.exports = { compilerDependencies, compilerRoots };
