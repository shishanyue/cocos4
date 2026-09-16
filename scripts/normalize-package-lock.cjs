const fs = require('node:fs');
const path = require('node:path');

function normalizePackageLock(lock) {
    for (const [location, entry] of Object.entries(lock.packages)) {
        if (!entry.resolved) continue;
        const url = new URL(entry.resolved);
        if (!/^(registry\.npmjs\.org|registry\.npm\.taobao\.org|(?:registry|r\d)\.npmmirror\.com)$/.test(url.hostname)) continue;
        const name = entry.name || location.split('node_modules/').pop();
        entry.resolved = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${entry.version}.tgz`;
    }
    return lock;
}

module.exports = { normalizePackageLock };
if (require.main === module) {
    const file = path.join(__dirname, '..', 'package-lock.json');
    const lock = normalizePackageLock(JSON.parse(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
}
