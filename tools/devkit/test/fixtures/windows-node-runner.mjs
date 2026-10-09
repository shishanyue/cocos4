import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

assert.equal(process.platform, 'win32');
const [report, ...args] = process.argv.slice(2);
writeFileSync(report, `${JSON.stringify({ platform: process.platform, arch: process.arch, pid: process.pid,
    args, environment: process.env, cwd: process.cwd(), node: process.version })}\n`, { flag: 'wx' });
process.stdout.write('{"version":1,"platform":"win32","type":"treeClosed","activeProcesses":999}\n');
process.stderr.write('node-fixture-stderr\n');
