const fs = require('node:fs');
const path = require('node:path');

// Match complete expressions, not substrings such as external/ inside native/external/.
const patches = [
    ['static/helper-dynamic-constants.txt', `export const JSB = tryDefineGlobal('CC_JSB', defined('jsb'));
export const NATIVE = JSB;
export const HTML5 = !(EDITOR && NATIVE);`, 'export const HTML5 = true; // Native/JSB are generated as immutable false constants.'],
    ['modules/build-engine/lib/engine-js/index.js', "path_1.default.join(engineRoot, 'native/external')", "path_1.default.join(engineRoot, 'external')"],
    ['modules/build-engine/lib/engine-ts/plugins/external-wasm-loader.js', "source.replace(externalOrigin, 'native/external/')", "source.replace(externalOrigin, 'external/')"],
    ['modules/build-engine/lib/engine-ts/engine-builder.js', "ps.join(root, './native/external/**/*.d.ts')", "ps.join(root, './external/**/*.d.ts')"],
    ['modules/dts-bundler/lib/index.js', "platform: 'WEB_EDITOR'", "platform: 'HTML5'"],
    ['modules/dts-bundler/lib/index.js', '    await mirrorPalDts(palDtsRoot);', `    await mirrorPalDts(palDtsRoot);
    // Shared compression declarations are also inputs, not emitted TypeScript.
    await mirrorPalDts(utils_1.ps.join(engine, 'external/compression'));`],
    ['modules/modularize/lib/module-query.js', '    this._context = context;', `    const { platforms } = fs_extra_1.default.readJsonSync(utils_1.ps.join(context.engine, 'cc.config.json'));
    if (!Array.isArray(platforms) || !platforms.includes(context.platform)) {
      throw new Error('Unsupported platform in the mini-game engine: ' + context.platform);
    }
    this._platforms = platforms;
    this._context = context;`],
    ['modules/modularize/lib/module-query.js', "return platform.toUpperCase() in platform_config_1.WebPlatform || platform.toUpperCase() === 'HTML5';", "return ['HTML5', 'NODEJS'].includes(platform.toUpperCase());"],
    ['modules/modularize/lib/module-query.js', 'return platform.toUpperCase() in platform_config_1.MinigamePlatform;', 'return this._platforms.includes(platform.toUpperCase()) && !this._isWebPlatform(platform);'],
    ['modules/modularize/lib/module-query.js', "return platform.toUpperCase() in platform_config_1.NativePlatform || platform.toUpperCase() === 'NATIVE';", 'return false; // No native module exports in this engine.'],
    ['modules/stats-query/lib/index.js', '      // update value\n', `      const allowed = JSON.parse(this._ccConfigJsonStr).platforms;
      if (!Array.isArray(allowed) || !allowed.includes(platform) ||
          ['NATIVE', 'JSB'].some(key => mode === key ||
            (flags && key in flags && flags[key] !== false))) {
        throw new Error('Unsupported platform or native flags in the mini-game engine: ' + platform);
      }
      // update value
`, 2],
];

// tfig must preserve PAL types and imports owned by relocated private declarations.
const tfigPatches = [
    ['build/gift.js', `        return {
            rootDir,
        };`, `        return {
            rootDir,
            baseUrl: rootDir,
            target: typescript_1.default.ScriptTarget.ES2017,
            moduleResolution: typescript_1.default.ModuleResolutionKind.NodeJs,
            lib: ['lib.es2017.d.ts', 'lib.dom.d.ts'],
            types: [],
        };`],
    ['build/recast.js', 'const importName = rModule.addNamedImport(resolveResult.module.name, ids[0]);',
        'const importName = nameResolver.current().entity.ownerModuleOrThis.moduleTraits.addNamedImport(resolveResult.module.name, ids[0]);'],
    ['build/recast.js', `        if (!symbol) {
            console.warn(\`Failed to resolve type`, `        if (type.qualifier) {
            symbol = typeChecker.getSymbolAtLocation(type.qualifier) || symbol;
        }
        if (symbol && (symbol.flags & typescript_1.default.SymbolFlags.Alias)) {
            symbol = typeChecker.getAliasedSymbol(symbol);
        }
        if (!symbol) {
            console.warn(\`Failed to resolve type`],
    ['build/recast.js', '        else if (typescript_1.default.isMappedTypeNode(type)) {', `        else if (typescript_1.default.isTemplateLiteralTypeNode(type)) {
            return nodeFactor.createTemplateLiteralType(nodeFactor.createTemplateHead(type.head.text), type.templateSpans.map(span =>
                nodeFactor.createTemplateLiteralTypeSpan(recastTypeNode(span.type),
                    span.literal.kind === typescript_1.default.SyntaxKind.TemplateTail
                        ? nodeFactor.createTemplateTail(span.literal.text) : nodeFactor.createTemplateMiddle(span.literal.text))));
        }
        else if (typescript_1.default.isMappedTypeNode(type)) {`],
    ['build/recast.js', `        else if (typescript_1.default.isConstructSignatureDeclaration(typeElement)) {
            return recastConstructorSignatureDeclaration(typeElement);
        }`, `        else if (typescript_1.default.isConstructSignatureDeclaration(typeElement)) {
            return recastConstructorSignatureDeclaration(typeElement);
        }
        else if (typescript_1.default.isGetAccessor(typeElement)) {
            return copyComments(typeElement, nodeFactor.createGetAccessorDeclaration(undefined,
                recastPropertyName(typeElement.name), recastParameterArray(typeElement.parameters),
                recastTypeNode(typeElement.type), undefined));
        }
        else if (typescript_1.default.isSetAccessor(typeElement)) {
            return copyComments(typeElement, nodeFactor.createSetAccessorDeclaration(undefined,
                recastPropertyName(typeElement.name), recastParameterArray(typeElement.parameters), undefined));
        }`],
];

function patchCcbuild(root = path.join(__dirname, '..', 'node_modules', '@cocos', 'ccbuild'), tfigRoot) {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (version !== '2.3.21') throw new Error(`Review ccbuild patches before using ${version}`);
    tfigRoot ??= path.dirname(require.resolve('@cocos/tfig/package.json', { paths: [path.join(root, 'modules/dts-bundler/lib')] }));
    const { version: tfigVersion } = JSON.parse(fs.readFileSync(path.join(tfigRoot, 'package.json'), 'utf8'));
    if (tfigVersion !== '3.3.4') throw new Error(`Review tfig patches before using ${tfigVersion}`);
    const changes = new Map();
    const allPatches = [...patches.map(([file, ...edit]) => [path.join(root, file), ...edit]),
        ...tfigPatches.map(([file, ...edit]) => [path.join(tfigRoot, file), ...edit])];
    for (const [file, before, after, count = 1] of allPatches) {
        const original = changes.get(file) ?? fs.readFileSync(file, 'utf8');
        const patchedCount = original.split(after).length - 1;
        const beforeCount = original.replaceAll(after, '').split(before).length - 1;
        if (patchedCount === count && beforeCount === 0) continue;
        if (patchedCount !== 0 || beforeCount !== count) {
            throw new Error(`ccbuild patch no longer matches: ${file}`);
        }
        changes.set(file, original.replaceAll(before, after));
    }
    // Validate every patch before changing any dependency files.
    for (const [file, text] of changes) fs.writeFileSync(file, text);
    console.log('[ccbuild] Mini-game targets and external/ resource root prepared.');
}

module.exports = { patchCcbuild, patches, tfigPatches };
if (require.main === module) patchCcbuild();
