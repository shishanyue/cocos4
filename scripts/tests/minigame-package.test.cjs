const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { validateMiniGame } = require('../validate-minigame.cjs');

const MiB = 1024 * 1024;
const mainWarning = 'main: source files exceed 4 MiB; check the vendor-compiled package size.';
const totalWarning = 'Source files exceed 30 MiB total; check the vendor-compiled package size.';
const targets = ['WECHAT', 'BYTEDANCE'];
const commonFiles = ['game.js', 'game.json', 'project.config.json', 'application.js', 'web-adapter.js',
    'engine-adapter.js', 'fs-utils.js', 'loader.js', 'import-map.json', 'settings.json', 'cocos-js/cc.js', 'ENGINE-LICENSE'];
const notices = {
    WECHAT: ['WECHAT-ADAPTER-LICENSE'],
    BYTEDANCE: ['licenses/bytedance/package.json', 'licenses/bytedance/README.md',
        'licenses/bytedance/ENGINE-LICENSE', 'licenses/bytedance/NOTICE.txt'],
};

function fixture(t, target = 'WECHAT') {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos4-minigame-package-'));
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
    const root = path.join(sandbox, 'game');
    const files = new Map();
    const put = (name, data) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), bytes);
        files.set(name, bytes);
    };
    for (const name of [...commonFiles, ...notices[target]]) {
        put(name, name.endsWith('.json') ? '{}\n' : name.endsWith('.js')
            ? "throw new Error('Fixture code must never execute');\n" : 'Test fixture notice; not a redistribution license.\n');
    }
    const template = target === 'WECHAT' ? 'wechatgame' : 'bytedance-mini-game';
    const readTemplate = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../../templates', template, name), 'utf8'));
    const game = readTemplate('game.json');
    const project = { ...readTemplate('project.config.json'), appid: `${target === 'WECHAT' ? 'wx' : 'tt'}0000000000000000` };
    const json = (name, value) => put(name, JSON.stringify(value, null, 2) + '\n');
    json('game.json', game);
    json('project.config.json', project);
    json('import-map.json', { imports: { cc: './cocos-js/cc.js' } });
    json('settings.json', { assets: { projectBundles: ['internal', 'game'] } });
    return { sandbox, root, files, put, json, game, project, validate: () => validateMiniGame(root, target) };
}

for (const target of targets) {
    test(`${target}: templates, source byte accounting and notices remain unchanged`, t => {
        const f = fixture(t, target);
        f.put('assets/game/binary.dat', Buffer.from([0, 255, 254, 1]));
        f.put('assets/game/empty.dat', '');
        f.put('assets/game/text.txt', '\u6e38\u620f\n');
        f.json('assets/game/rules.json', [{ text: 'escaped "key": {[]} \\ and 1e999', same: 1 }, { same: 2 }]);
        const totalBytes = [...f.files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
        assert.deepEqual(f.validate(), { target, appId: f.project.appid,
            packages: [{ name: 'main', root: '', bytes: totalBytes }], totalBytes, warnings: [] });
        for (const [file, bytes] of f.files) assert.deepEqual(fs.readFileSync(path.join(f.root, file)), bytes, file);
    });

    test(`${target}: full maintainer folders are not production payload allowlists`, t => {
        const f = fixture(t, target);
        for (const name of ['runtime.json', 'engine-build.json', 'compiler-dependencies.json', 'game-compiler.json',
            'builtin-report.json', 'template/package.json', 'template/tsconfig.json', 'template/assets/rules.json']) f.json(name, {});
        for (const name of ['template/src/main.ts', 'template/tests/game.test.ts', 'types/cc.d.ts', 'internal-prerequisites.js', 'extra notice.txt']) {
            f.put(name, '// Maintainer fixture, deliberately not production payload.\n');
        }
        const totalBytes = [...f.files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
        assert.equal(f.validate().totalBytes, totalBytes);
        for (const [file, bytes] of f.files) assert.deepEqual(fs.readFileSync(path.join(f.root, file)), bytes, file);
    });

    test(`${target}: every required file and notice must be nonempty and regular`, t => {
        const f = fixture(t, target);
        for (const name of [...commonFiles, ...notices[target]]) {
            const file = path.join(f.root, name);
            const bytes = f.files.get(name);
            fs.unlinkSync(file);
            assert.throws(f.validate, /Missing or empty required file/, `missing ${name}`);
            fs.writeFileSync(file, '');
            assert.throws(f.validate, /Missing or empty required file/, `empty ${name}`);
            fs.unlinkSync(file);
            fs.mkdirSync(file);
            assert.throws(f.validate, /Missing or empty required file/, `directory ${name}`);
            fs.rmdirSync(file);
            fs.writeFileSync(file, bytes);
        }
        assert.ok(f.validate());
    });

    test(`${target}: optional root metadata and explicitly empty workflows are accepted verbatim`, t => {
        const f = fixture(t, target);
        const { compileType, ...withoutCompileType } = f.project;
        for (const root of ['', '.', './']) {
            f.json('project.config.json', { ...withoutCompileType, gameRoot: root, miniprogramRoot: root,
                projectname: 'User-owned name', description: '\u7528\u6237\u914d\u7f6e', cloudfunctionRoot: '' });
            f.json('game.json', { deviceOrientation: 'landscape', networkTimeout: { request: 0.5 },
                plugins: {}, subpackages: [], subPackages: [], openDataContext: '', workers: '', cloud: false, cloudConfig: {} });
            const before = fs.readFileSync(path.join(f.root, 'project.config.json'));
            assert.equal(f.validate().appId, f.project.appid);
            assert.deepEqual(fs.readFileSync(path.join(f.root, 'project.config.json')), before);
        }
        f.put('game.json', '{\r\n\t"custom": {"enabled":true}, "deviceOrientation" : "portrait"\r\n}\r\n');
        f.put('project.config.json', ` { "appid" : "${f.project.appid}", "compileType":"game", "description":"\\u0041" }\n`);
        const before = [fs.readFileSync(path.join(f.root, 'game.json')), fs.readFileSync(path.join(f.root, 'project.config.json'))];
        assert.ok(f.validate());
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'game.json')), before[0]);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'project.config.json')), before[1]);
        f.json('game.json', {});
        assert.ok(f.validate());
    });

    test(`${target}: appid, compileType and redirected roots are rejected without repair`, t => {
        const f = fixture(t, target);
        for (const appid of [undefined, null, '', ' ', 123, {}, [], 'testappId', 'wx', 'tt',
            'wxwith space', 'ttwith/slash', ` ${f.project.appid}`, `${f.project.appid}\n`,
            `${target === 'WECHAT' ? 'tt' : 'wx'}0000000000000000`, `${f.project.appid}${'a'.repeat(128)}`]) {
            f.json('project.config.json', { ...f.project, appid });
            assert.throws(f.validate, /appid/);
        }
        for (const compileType of [null, '', 'miniprogram', 'plugin', true, {}]) {
            f.json('project.config.json', { ...f.project, compileType });
            assert.throws(f.validate, /compileType/);
        }
        for (const key of ['gameRoot', 'miniprogramRoot']) {
            for (const value of [null, false, [], {}, 'nested', '../', '/tmp', 'C:\\game', './nested', '././', '.\\', ' ']) {
                f.json('project.config.json', { ...f.project, [key]: value });
                assert.throws(f.validate, new RegExp(key));
            }
        }
        f.json('project.config.json', f.project);
        assert.ok(f.validate());
    });

    test(`${target}: orientation and all provided network timeout values are validated`, t => {
        const f = fixture(t, target);
        for (const deviceOrientation of [null, '', 'diagonal', 'Landscape', 1, [], {}]) {
            f.json('game.json', { ...f.game, deviceOrientation });
            assert.throws(f.validate, /deviceOrientation/);
        }
        for (const networkTimeout of [null, [], '', 1, true]) {
            f.json('game.json', { ...f.game, networkTimeout });
            assert.throws(f.validate, /networkTimeout/);
        }
        for (const field of ['request', 'connectSocket', 'uploadFile', 'downloadFile', 'customTimeout']) {
            for (const value of [null, false, '5000', 0, -1, [], {}]) {
                f.json('game.json', { ...f.game, networkTimeout: { [field]: value } });
                assert.throws(f.validate, /networkTimeout/);
            }
            f.put('game.json', `{"networkTimeout":{"${field}":1e999}}`);
            assert.throws(f.validate, /Non-finite JSON number/);
        }
    });

    test(`${target}: unimplemented workflows cannot be enabled in either config`, t => {
        const f = fixture(t, target);
        const invalid = {
            plugins: [null, [], '', false, { engine: {} }],
            subpackages: [null, {}, '', false, [{ name: 'sub', root: '../outside' }]],
            subPackages: [null, {}, '', false, [{ root: 'sub' }]],
            openDataContext: [null, false, {}, [], 'open-data'],
            workers: [null, false, {}, [], 'workers', { path: 'workers', isSubpackage: true }],
            cloud: [true, 'cloud', { env: 'production' }],
            cloudfunctionRoot: ['cloud/', '../cloud'],
            cloudfunctionTemplateRoot: ['templates/'],
            cloudbaseRoot: ['cloudbase/'],
            cloudFunctions: [['function']],
        };
        for (const [file, config] of [['game.json', f.game], ['project.config.json', f.project]]) {
            for (const [key, values] of Object.entries(invalid)) {
                for (const value of values) {
                    f.json(file, { ...config, [key]: value });
                    assert.throws(f.validate, new RegExp(key), `${file}: ${key}`);
                }
                f.json(file, config);
            }
        }
    });

    test(`${target}: JSON must be strict UTF-8, unambiguous and bounded throughout the tree`, t => {
        const f = fixture(t, target);
        const invalid = ['', ' ', '{', '{"a":1,}', '{/* comment */}', '{}{}', '{"a":1,"a":2}',
            '{"a":1,"\\u0061":2}', '{"nested":[{"x":1,"x":2}]}', '{"x":"\\q"}', '{"x":1e999}',
            Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
            Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]),
            Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')])];
        for (const name of ['game.json', 'project.config.json', 'import-map.json', 'settings.json',
            'runtime.json', 'assets/game/rules.json', ...(target === 'BYTEDANCE' ? ['licenses/bytedance/package.json'] : [])]) {
            const original = f.files.get(name) ?? Buffer.from('{}');
            for (const value of invalid) {
                f.put(name, value);
                assert.throws(f.validate, /JSON|Missing or empty required file/, name);
            }
            f.put(name, '['.repeat(33) + '0' + ']'.repeat(33));
            assert.throws(f.validate, /JSON nesting depth/, name);
            f.put(name, original);
        }
        for (const name of ['game.json', 'project.config.json', 'import-map.json', 'settings.json']) {
            const original = f.files.get(name);
            for (const value of [null, [], 'text', 123, false]) {
                f.json(name, value);
                assert.throws(f.validate, /must be an object/, name);
            }
            f.put(name, original);
        }
        f.put('assets/game/rules.json', '['.repeat(32) + '0' + ']'.repeat(32));
        assert.ok(f.validate());
    });

    test(`${target}: warning thresholds use exact source bytes, not allocated or compiled sizes`, t => {
        const f = fixture(t, target);
        const baseBytes = f.validate().totalBytes;
        const file = path.join(f.root, 'padding.bin');
        fs.writeFileSync(file, '');
        // Sparse files exercise boundaries without allocating hundreds of MiB.
        for (const [totalBytes, warnings] of [[4 * MiB, []], [4 * MiB + 1, [mainWarning]],
            [30 * MiB, [mainWarning]], [30 * MiB + 1, [mainWarning, totalWarning]], [512 * MiB, [mainWarning, totalWarning]]]) {
            fs.truncateSync(file, totalBytes - baseBytes);
            assert.deepEqual(f.validate(), { target, appId: f.project.appid,
                packages: [{ name: 'main', root: '', bytes: totalBytes }], totalBytes, warnings });
        }
        fs.truncateSync(file, 512 * MiB + 1 - baseBytes);
        assert.throws(f.validate, /512 MiB validation limit/);
    });
}

test('only exact supported targets and safe directory arguments are accepted', t => {
    const f = fixture(t);
    for (const target of [undefined, null, {}, 'BILIBILI', 'HTML5', 'WECHAT_MINI_PROGRAM', 'wechat', 'bytedance', 'WECHAT ']) {
        assert.throws(() => validateMiniGame(f.root, target), /exactly WECHAT and BYTEDANCE/);
    }
    for (const directory of [undefined, null, {}, '', '\0', `${f.root}/../game`, 'x'.repeat(4097)]) {
        assert.throws(() => validateMiniGame(directory, 'WECHAT'), /Unsafe mini-game directory path/);
    }
    assert.throws(() => validateMiniGame(path.join(f.root, 'game.js'), 'WECHAT'), /Expected a mini-game directory/);
    assert.throws(() => validateMiniGame(path.join(f.root, 'missing'), 'WECHAT'), /ENOENT/);
    assert.deepEqual(validateMiniGame(`${f.root}/./`, 'WECHAT'), f.validate());
});

test('root, ancestor, internal and external symlinks are rejected', t => {
    const f = fixture(t);
    const rootLink = path.join(f.sandbox, 'root-link');
    fs.symlinkSync(f.root, rootLink, 'dir');
    assert.throws(() => validateMiniGame(rootLink, 'WECHAT'), /[Ss]ymlink/);
    const parentLink = path.join(f.sandbox, 'parent-link');
    const parent = path.join(f.sandbox, 'parent');
    fs.mkdirSync(parent);
    fs.mkdirSync(path.join(parent, 'child'));
    fs.symlinkSync(parent, parentLink, 'dir');
    assert.throws(() => validateMiniGame(path.join(parentLink, 'child'), 'WECHAT'), /[Ss]ymlink/);
    for (const [destination, type] of [[path.join(f.root, 'game.js'), 'file'], [f.root, 'dir'],
        [parent, 'dir'], [path.join(f.sandbox, 'missing'), 'file']]) {
        const link = path.join(f.root, 'linked');
        fs.symlinkSync(destination, link, type);
        assert.throws(f.validate, /[Ss]ymlink/);
        fs.unlinkSync(link);
    }
});

test('hardlinks, including links to files outside the package, are rejected', t => {
    const f = fixture(t);
    const alias = path.join(f.root, 'alias.js');
    fs.linkSync(path.join(f.root, 'game.js'), alias);
    assert.throws(f.validate, /Hardlinks/);
    fs.unlinkSync(alias);
    const external = path.join(f.sandbox, 'external.js');
    fs.writeFileSync(external, '// external\n');
    fs.linkSync(external, alias);
    assert.throws(f.validate, /Hardlinks/);
});

test('special files are rejected before attempting to read them', async t => {
    const f = fixture(t);
    const filename = path.join(f.root, 'game.json');
    if (process.platform === 'win32') {
        // Windows named pipes are not directory entries. Exercise the same
        // traversal boundary with a non-file stat and forbid opening its data.
        const lstat = fs.lstatSync;
        const open = fs.openSync;
        t.mock.method(fs, 'lstatSync', function (file, ...args) {
            const stat = lstat.call(this, file, ...args);
            if (file === filename) stat.isFile = () => false;
            return stat;
        });
        t.mock.method(fs, 'openSync', function (file, ...args) {
            assert.notEqual(file, filename, 'Special files must never be opened');
            return open.call(this, file, ...args);
        });
        assert.throws(f.validate, /Expected a regular file/);
        return;
    }
    fs.unlinkSync(filename);
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, resolve); });
    try { assert.throws(f.validate, /Expected a regular file/); }
    finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('cross-platform traversal spellings and ambiguous output names are rejected', t => {
    const f = fixture(t);
    let injectedName;
    if (process.platform === 'win32') {
        // Windows normalizes these names or forbids creating them. Supply an
        // exact directory entry so the validator, rather than the OS, rejects
        // each spelling. POSIX also verifies real entries below.
        const opendir = fs.opendirSync;
        t.mock.method(fs, 'opendirSync', function (directory, ...args) {
            const handle = opendir.call(this, directory, ...args);
            if (directory !== f.root) return handle;
            let pending = true;
            return {
                readSync() {
                    const entry = handle.readSync();
                    if (entry || !pending) return entry;
                    pending = false;
                    return { name: injectedName };
                },
                closeSync() { handle.closeSync(); },
            };
        });
    }
    for (const name of ['..\\escape.js', 'C:escape.js', '%2e%2e%2fescape.js', 'trailing.', 'trailing ', 'NUL.txt', 'control\n.txt', 'Game.js', 'COCOS-JS']) {
        injectedName = name;
        if (process.platform !== 'win32') {
            if (name === 'COCOS-JS') fs.mkdirSync(path.join(f.root, name));
            else f.put(name, '// not a safe name\n');
        }
        assert.throws(f.validate, /Unsafe output path|Ambiguous output path/, name);
        if (process.platform !== 'win32') {
            if (name === 'COCOS-JS') fs.rmdirSync(path.join(f.root, name));
            else fs.unlinkSync(path.join(f.root, name));
        }
    }
});

test('directory depth is bounded even for empty trees', t => {
    const f = fixture(t);
    let directory = f.root;
    for (let depth = 1; depth <= 32; ++depth) { directory = path.join(directory, 'd'); fs.mkdirSync(directory); }
    assert.ok(f.validate());
    fs.mkdirSync(path.join(directory, 'd'));
    assert.throws(f.validate, /directory depth exceeds 32/);
});

test('entry count is bounded even when extra files have zero bytes', t => {
    const f = fixture(t);
    const directory = path.join(f.root, 'empty-files');
    fs.mkdirSync(directory);
    for (let i = 0; i < 10000; ++i) fs.writeFileSync(path.join(directory, `${i}.dat`), '');
    assert.throws(f.validate, /entry count exceeds 10000/);
});

test('JSON allocation is bounded before parsing, with tighter root config limits', t => {
    const f = fixture(t);
    for (const name of ['game.json', 'project.config.json', 'assets.json']) {
        const original = f.files.get(name) ?? Buffer.from('{}');
        f.put(name, '{}');
        fs.truncateSync(path.join(f.root, name), (name === 'assets.json' ? 16 * MiB : 32 * 1024) + 1);
        assert.throws(f.validate, /JSON byte limit exceeded/);
        f.put(name, original);
    }
});

test('validation uses only builtins and never executes project code or package hooks', t => {
    const f = fixture(t);
    const marker = path.join(f.sandbox, 'executed');
    f.put('game.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('executed');`);
    f.json('package.json', { main: 'game.js', type: 'module', scripts: { postinstall: 'exit 99' } });
    assert.ok(f.validate());
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(require.cache[require.resolve('../validate-minigame.cjs')].children, []);
});
