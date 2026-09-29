const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const path = require('node:path');

// Use a real entry file: minifier child_process.fork inherits --eval and would
// recursively execute an eval-based build launcher instead of its worker file.
async function main() {
    assert.equal(process.argv.length, 4);
    const options = JSON.parse(process.argv[3]);
    switch (process.argv[2]) {
    case 'engine': {
        const { report, ...buildOptions } = options;
        const rootRequire = createRequire(path.join(buildOptions.engine, 'package.json'));
        const result = await rootRequire('@cocos/ccbuild').buildEngine(buildOptions);
        await fs.writeFile(report, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
        break;
    }
    case 'types':
        await require('./build-types.cjs').buildTypes(options);
        break;
    case 'loader':
        await require(options.loader).build(options.buildOptions);
        break;
    default:
        throw new Error('Unknown runtime build stage');
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
