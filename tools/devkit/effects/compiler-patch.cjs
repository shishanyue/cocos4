const assert = require('node:assert/strict');

// This is preparation input, never a runtime monkey-patch or an edit of the checkout.
function applyCompilerPatch(source) {
    const replace = (before, after) => {
        assert.equal(source.split(before).length, 2, `Compiler patch anchor changed: ${before}`);
        source = source.replace(before, () => after);
    };
    const defineStart = source.indexOf('    const getDefineString = (defines) =>');
    const defineEnd = source.indexOf('    const compile = (source, type) =>', defineStart);
    assert.ok(defineStart > 0 && defineEnd > defineStart, 'Missing validation define policy');
    const defineString = source.slice(defineStart, defineEnd);
    replace(defineString, '');
    replace('const miscChecks = (() => {', `${defineString.trimStart()}
const preprocessForValidation = (() => {
    const { spawnSync } = require('node:child_process');
    const { isAbsolute } = require('node:path');
    const executable = process.env.COCOS_EFFECT_GLSLANG || '/usr/bin/glslangValidator';
    if (!isAbsolute(executable)) throw new Error('GLSL preprocessor path must be absolute');
    const run = (args, input) => {
        const result = spawnSync(executable, args, {
            input, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
        });
        if (result.error || result.status !== 0 || result.stderr) {
            throw new Error('GLSL preprocessing failed: ' + (result.error || result.stderr || result.stdout));
        }
        return result.stdout;
    };
    const version = run(['--version']);
    if (version.split('\\n')[0] !== 'Glslang Version: 11:16.4.0') {
        throw new Error('Unreviewed GLSL preprocessor version: ' + version);
    }
    return (code, defines, stage) => run(['--stdin', '-E', '-S', stage],
        '#version 100\\n' + getDefineString(defines) + code);
})();

const miscChecks = (() => {`);
    replace('    return (code) => {\n        // precision declaration check', `    return (code, defines, stage) => {
        // Parse an actual language-preprocessed variant, not concatenated #if/#else bodies.
        // Driver validation below still receives the original conditional source.
        try {
            code = preprocessForValidation(code, defines, stage);
        } catch (e) {
            error(\`EFX2404: glsl1 preprocessing failed: \${e}\`);
        }
        // precision declaration check`);
    replace('miscChecks(out.glsl1); // TODO : add higher version checks',
        'miscChecks(out.glsl1, outDefines, stage); // TODO : add higher version checks');
    return source;
}

module.exports = { applyCompilerPatch };
