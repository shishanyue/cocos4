const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { inventory, safePath, sha256 } = require('./files.cjs');

// Snapshot only manifest-verified runtime bytes. No filesystem/source fallback.
async function serveArtifact(directory) {
    const root = await fs.realpath(directory);
    const reportBytes = await fs.readFile(path.join(root, '../build-report.json'));
    const report = JSON.parse(reportBytes);
    assert.equal(report.kind, 'cocos4-browser-bootstrap');
    assert.deepEqual(await inventory(root), report.files, 'Runtime artifact changed since build');
    const payloads = new Map();
    for (const record of report.files) {
        const name = safePath(record.path);
        assert.doesNotMatch(name, /\.(?:ts|map|effect|chunk|mtl)$/);
        const bytes = await fs.readFile(path.join(root, name));
        assert.equal(sha256(bytes), record.sha256, `Changed during snapshot: ${name}`);
        payloads.set(`/${name}`, bytes);
    }
    const requests = [];
    const server = http.createServer((request, response) => {
        let name;
        try { name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
        catch { response.writeHead(400).end(); return; }
        if (name === '/') name = '/index.html';
        const bytes = payloads.get(name);
        const status = request.method === 'GET' && bytes ? 200 : 404;
        requests.push({ path: name, status });
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
        response.writeHead(status, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(status === 200 ? bytes : 'Not found');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}/`, report, reportSha256: sha256(reportBytes), requests,
        close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

module.exports = { serveArtifact };
