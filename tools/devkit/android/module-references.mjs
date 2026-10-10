// Read literal module specifiers without evaluating the input or requiring npm packages.
// Token boundaries keep documentation in comments, strings and regexes out of the asset closure.
export function moduleReferences(source) {
    const tokens = [];
    let offset = 0;
    let regexAllowed = true;
    const parens = [];
    const operands = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'instanceof', 'await', 'yield', 'else', 'do']);
    const controls = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
    function token(type, value) {
        const previous = tokens.at(-1);
        tokens.push({ type, value });
        if (type === 'identifier') regexAllowed = operands.has(value);
        else if (type === 'string' || type === 'literal') regexAllowed = false;
        else if (value === '(') { parens.push(previous?.type === 'identifier' && controls.has(previous.value)); regexAllowed = true; }
        else if (value === ')') regexAllowed = parens.pop() === true;
        else regexAllowed = ![']', '.', '++', '--'].includes(value);
    }
    function quoted(quote) {
        offset++;
        let value = '';
        while (offset < source.length) {
            const character = source[offset++];
            if (character === quote) break;
            if (character !== '\\') { value += character; continue; }
            const escaped = source[offset++];
            if (escaped === '\n') continue;
            if (escaped === '\r') { if (source[offset] === '\n') offset++; continue; }
            const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
            if (Object.hasOwn(simple, escaped)) { value += simple[escaped]; continue; }
            if (escaped === 'x' || escaped === 'u') {
                const braced = escaped === 'u' && source[offset] === '{';
                const end = braced ? source.indexOf('}', offset + 1) : offset + (escaped === 'x' ? 2 : 4);
                const digits = source.slice(offset + (braced ? 1 : 0), end);
                if (/^[\da-f]+$/i.test(digits) && Number.parseInt(digits, 16) <= 0x10ffff) {
                    value += String.fromCodePoint(Number.parseInt(digits, 16));
                    offset = end + (braced ? 1 : 0);
                    continue;
                }
            }
            value += escaped ?? '';
        }
        token('string', value);
    }
    function regexp() {
        offset++;
        let bracket = false;
        while (offset < source.length) {
            const character = source[offset++];
            if (character === '\\') { offset++; continue; }
            if (character === '[') bracket = true;
            else if (character === ']') bracket = false;
            else if (character === '/' && !bracket) break;
        }
        while (/[a-z]/i.test(source[offset] ?? '')) offset++;
        token('literal', '');
    }
    function template() {
        offset++;
        while (offset < source.length) {
            const character = source[offset++];
            if (character === '\\') { offset++; continue; }
            if (character === '`') break;
            if (character === '$' && source[offset] === '{') {
                offset++;
                token('punct', ';');
                code(true);
                token('punct', ';');
            }
        }
        token('literal', '');
    }
    function code(untilBrace = false) {
        let braces = 0;
        while (offset < source.length) {
            const character = source[offset];
            if (/\s/.test(character)) { offset++; continue; }
            if (character === '/' && source[offset + 1] === '/') {
                const end = source.indexOf('\n', offset + 2);
                offset = end < 0 ? source.length : end;
                continue;
            }
            if (character === '/' && source[offset + 1] === '*') {
                const end = source.indexOf('*/', offset + 2);
                offset = end < 0 ? source.length : end + 2;
                continue;
            }
            if (character === '"' || character === "'") { quoted(character); continue; }
            if (character === '`') { template(); continue; }
            if (character === '/' && regexAllowed) { regexp(); continue; }
            if (/[a-z_$]/i.test(character)) {
                const start = offset++;
                while (/[\w$]/.test(source[offset] ?? '')) offset++;
                token('identifier', source.slice(start, offset));
                continue;
            }
            if (/\d/.test(character)) {
                offset++;
                while (/[\w.]/.test(source[offset] ?? '')) offset++;
                token('literal', '');
                continue;
            }
            offset++;
            if (character === '}' && untilBrace && braces === 0) return;
            if (character === '{') braces++;
            if (character === '}') braces--;
            const doubled = (character === '+' || character === '-') && source[offset] === character;
            if (doubled) offset++;
            token('punct', doubled ? character + character : character);
        }
    }
    code();
    const references = [];
    for (let index = 0; index < tokens.length; index++) {
        const current = tokens[index];
        if (current.type !== 'identifier' || !['import', 'export'].includes(current.value) || tokens[index - 1]?.value === '.') continue;
        const next = tokens[index + 1];
        if (current.value === 'import' && next?.type === 'string') { references.push(next.value); continue; }
        if (current.value === 'import' && next?.value === '(') {
            if (tokens[index + 2]?.type === 'string' && [')', ','].includes(tokens[index + 3]?.value)) references.push(tokens[index + 2].value);
            continue;
        }
        if (next?.value === '.') continue;
        for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ';'; cursor++) {
            if (tokens[cursor].type === 'identifier' && tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'string') {
                references.push(tokens[cursor + 1].value);
                break;
            }
        }
    }
    return references;
}
