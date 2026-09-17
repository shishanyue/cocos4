const assert = require('node:assert/strict');

const effectSource = (vertex, precision = 'precision highp float;') => `CCEffect %{
    techniques:
    - passes:
      - vert: regression-vs:vert
        frag: regression-fs:frag
}%
CCProgram regression-vs %{
    ${precision}
    ${vertex}
}%
CCProgram regression-fs %{
    precision highp float;
    vec4 frag () { return vec4(1.0); }
}%`;

function compilerRegressions(compiler) {
    assert.equal(compiler.options.skipParserTest, false);
    assert.equal(compiler.options.throwOnError, true);
    assert.equal(compiler.options.throwOnWarning, true);
    const passed = [];
    const check = (name, run) => { run(); passed.push(name); };
    check('conditional-expression', () => {
        const effect = compiler.buildEffect('conditional-expression', effectSource(`
            #pragma define-meta P0_BRANCH default(false)
            vec4 vert () {
                return vec4(
                #if P0_BRANCH
                    0.0
                #else
                    1.0
                #endif
                );
            }`));
        assert.match(effect.shaders[0].glsl1.vert, /#if P0_BRANCH/);
    });
    const branch = `
        #pragma define-meta P0_BRANCH default(false)
        vec4 vert () {
        #if P0_BRANCH
            uint glsl3Value = 1u;
            return vec4(float(glsl3Value));
        #else
            return vec4(1.0);
        #endif
        }`;
    check('disabled-glsl3-branch', () => {
        const effect = compiler.buildEffect('disabled-glsl3-branch', effectSource(branch));
        // The output retains the branch. Only real preprocessing excludes it from validation.
        for (const version of ['glsl1', 'glsl3', 'glsl4']) {
            assert.match(effect.shaders[0][version].vert, /uint glsl3Value/);
            assert.match(effect.shaders[0][version].vert, /#if P0_BRANCH/);
        }
    });
    check('active-glsl3-rejected-in-glsl1', () => {
        assert.throws(() => compiler.buildEffect('active-glsl3', effectSource(branch.replace('default(false)', 'default(true)'))),
            error => /EFX2406: compilation failed/.test(error) && /'uint' : undeclared identifier/.test(error));
    });
    check('active-invalid-branch', () => {
        assert.throws(() => compiler.buildEffect('active-invalid', effectSource(branch
            .replace('default(false)', 'default(true)')
            .replace('uint glsl3Value = 1u;', 'float glsl3Value = (1.0 + );'))), /EFX2404: glsl1 parser failed/);
    });
    check('preprocessor-error', () => {
        assert.throws(() => compiler.buildEffect('preprocessor-error', effectSource(`
            #error P0_ACTIVE_ERROR
            vec4 vert () { return vec4(1.0); }`)), /EFX2404: glsl1 preprocessing failed:.*[\s\S]*P0_ACTIVE_ERROR/);
    });
    check('preprocessor-warning', () => {
        assert.throws(() => compiler.buildEffect('preprocessor-warning', effectSource(`
            #extension GL_P0_unsupported_extension : enable
            vec4 vert () { return vec4(1.0); }`, '')), /EFX2404: glsl1 preprocessing failed:.*WARNING:/);
    });
    check('compiler-warning', () => {
        assert.throws(() => compiler.buildEffect('compiler-warning', effectSource('vec4 vert () { return vec4(1.0); }', '')),
            /EFX2401: precision declaration not found/);
    });
    check('malformed-shader-driver-failure', () => {
        assert.throws(() => compiler.buildEffect('malformed-shader', effectSource('vec4 vert () { return notDeclaredAnywhere; }')),
            error => /EFX2406: compilation failed/.test(error) && /notDeclaredAnywhere.*undeclared identifier/.test(error));
    });
    return passed;
}

module.exports = { compilerRegressions };
