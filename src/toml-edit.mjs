// Locate configuration keys without interpreting or rewriting their values.
// Offsets and newlines stay identical, including inside multiline strings.
export function tomlMask(text) {
  const mask = text.split('');
  let quote = '', triple = false, value = false, depth = 0, comment = false;
  const hide = at => { if (text[at] !== '\r' && text[at] !== '\n') mask[at] = ' '; };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (comment) {
      hide(at);
      if (char === '\n') { comment = false; if (!depth) value = false; }
      continue;
    }
    if (quote) {
      if (value) hide(at);
      if (quote === '"' && char === '\\') { if (at + 1 < text.length) { at++; if (value) hide(at); } continue; }
      if (char === quote) {
        if (!triple) quote = '';
        else if (text.slice(at, at + 3) === quote.repeat(3)) {
          let end = at + 3;
          while (end < at + 5 && text[end] === quote) end++;
          if (value) for (let i = at + 1; i < end; i++) hide(i);
          at = end - 1; quote = ''; triple = false;
        }
      }
      continue;
    }
    if (char === '\n') { if (!depth) value = false; continue; }
    if (char === '#') { comment = true; hide(at); continue; }
    if (char === '"' || char === "'") {
      quote = char; triple = text.slice(at, at + 3) === char.repeat(3);
      const count = triple ? 3 : 1;
      if (value) for (let i = at; i < at + count; i++) hide(i);
      at += count - 1; continue;
    }
    if (value) {
      if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
      hide(at);
    } else if (char === '=') value = true;
  }
  return mask.join('');
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyPattern = key => new RegExp('^[ \\t]*(?:' + escape(key) + '|"' + escape(key) + '"|\'' + escape(key) + '\')[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)', 'm');
export const rootHead = text => {
  const at = tomlMask(text).search(/^[ \t]*\[/m);
  return at < 0 ? text : text.slice(0, at);
};
export function getRoot(text, key) {
  const match = tomlMask(rootHead(text)).match(keyPattern(key));
  return match ? text.slice(match.index, match.index + match[0].length) : '';
}
export function setRoot(text, key, line) {
  const match = tomlMask(rootHead(text)).match(keyPattern(key));
  return match ? text.slice(0, match.index) + line + text.slice(match.index + match[0].length) : line + text;
}
function tableRange(text, name) {
  const mask = tomlMask(text);
  const match = mask.match(new RegExp('^[ \\t]*\\[' + escape(name) + '\\][^\\r\\n]*(?:\\r?\\n|$)', 'm'));
  if (!match) return null;
  const start = match.index, after = start + match[0].length;
  const next = mask.slice(after).search(/^[ \t]*\[/m);
  return [start, next < 0 ? text.length : after + next];
}
export function getTable(text, name) { const range = tableRange(text, name); return range ? text.slice(...range) : ''; }
export function setTable(text, name, value) {
  const range = tableRange(text, name);
  return range ? text.slice(0, range[0]) + (value || '') + text.slice(range[1]) : value ? text.trimEnd() + '\n\n' + value : text;
}
