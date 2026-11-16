// parse.js — from-scratch CommonMark 0.31.2 + GFM 0.29 renderer, byte-identical
// to marked 18.1.3 defaults (gfm: true, breaks: false, pedantic: false).
// Zero imports. export parse(markdown).

// ---------- 1. Escaping helpers ----------
const ENT_RE = /^&([A-Za-z0-9_]+|#[0-9]+|#[xX][0-9a-fA-F]+);/;
function numericEntityValue(body) {
  // body like "#35" or "#x22"; returns value or -1 if not numeric
  if (body[0] !== '#') return -1;
  if (body[1] === 'x' || body[1] === 'X') return parseInt(body.slice(2), 16);
  return parseInt(body.slice(1), 10);
}
function escText(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '&') {
      const m = ENT_RE.exec(s.slice(i));
      if (m) {
        const v = numericEntityValue(m[1]);
        if (v === -1 || (v <= 0x10FFFF && !(v >= 0xD800 && v <= 0xDFFF))) {
          out += m[0]; i += m[0].length; continue;
        }
      }
      out += '&amp;'; i++; continue;
    }
    if (c === '<') { out += '&lt;'; i++; }
    else if (c === '>') { out += '&gt;'; i++; }
    else if (c === '"') { out += '&quot;'; i++; }
    else if (c === "'") { out += '&#39;'; i++; }
    else { out += c; i++; }
  }
  return out;
}
function escCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}
const escAttr = escText;
function encodeHref(s) {
  let e = encodeURI(s).replace(/%25/g, '%');
  e = e.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\\/g, '%5C');
  return e;
}
// decode a numeric entity at s[i]=='&'; returns {text, len} or null
function matchEntity(s, i) {
  if (s[i] !== '&') return null;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : /[0-9]/.test(s[j]))) j++;
    if (j === start || s[j] !== ';') return null;
    const v = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (v > 0x10FFFF) return null;
    const cp = (v === 0 || (v >= 0xD800 && v <= 0xDFFF)) ? 0xFFFD : v;
    return { text: String.fromCodePoint(cp), len: j + 1 - i };
  }
  return null;
}

// ---------- case folding / label normalization ----------
const FOLD_MAP = { '\u00DF': 'ss', '\u1E9E': 'ss', '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };
function caseFold(s) {
  let out = '';
  for (const ch of s) out += FOLD_MAP[ch] || ch;
  return out.toLowerCase();
}
function normalizeLabel(s) {
  const t = caseFold(s.replace(/\s+/g, ' ').trim());
  return t;
}

// ---------- character classes ----------
function isPunct(ch) { return !!ch && /[\p{P}\p{S}]/u.test(ch); }
function isSpaceCh(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function isUnicodeWs(ch) { return !!ch && /\s/.test(ch); }

// ---------- 2.1 cursor ----------
function mkCur(s) { return { s, p: 0, col: 0 }; }
function curSkipWs(cur, n) {
  let need = n;
  while (need > 0) {
    if (cur.p >= cur.s.length) return false;
    const ch = cur.s[cur.p];
    if (ch === ' ') { cur.p++; cur.col++; need--; }
    else if (ch === '\t') {
      const toNext = 4 - (cur.col % 4);
      if (toNext <= need) { cur.p++; cur.col += toNext; need -= toNext; }
      else {
        const spaces = ' '.repeat(toNext);
        cur.s = cur.s.slice(0, cur.p) + spaces + cur.s.slice(cur.p + 1);
        cur.p += need; cur.col += need; need = 0;
      }
    } else return false;
  }
  return true;
}
function curSkipWsUpTo(cur, n) {
  let need = n;
  while (need > 0 && cur.p < cur.s.length) {
    const ch = cur.s[cur.p];
    if (ch === ' ') { cur.p++; cur.col++; need--; }
    else if (ch === '\t') {
      const toNext = 4 - (cur.col % 4);
      if (toNext <= need) { cur.p++; cur.col += toNext; need -= toNext; }
      else {
        const spaces = ' '.repeat(toNext);
        cur.s = cur.s.slice(0, cur.p) + spaces + cur.s.slice(cur.p + 1);
        cur.p += need; cur.col += need; need = 0;
      }
    } else break;
  }
}
function curRest(cur) { return cur.s.slice(cur.p); }
function curBlank(cur) { return cur.p >= cur.s.length; }
function rawBlank(line) { return /^[ \t]*$/.test(line); }
// columns of leading whitespace in str starting at col startCol
function leadingWsCols(str, startCol) {
  let col = startCol, i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - startCol;
}
// expand tabs in the leading whitespace run of str; col counts from
// (startCol - quoteBase), +1 if quoteTab (tab directly after '>')
function expandLeadingTabs(str, startCol, quoteBase, quoteTab) {
  let col = startCol - quoteBase + (quoteTab ? 1 : 0), i = 0, out = '';
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) {
    if (str[i] === ' ') { out += ' '; col++; i++; }
    else {
      const n = 4 - (((col % 4) + 4) % 4);
      out += ' '.repeat(n); col += n; i++;
    }
  }
  return out + str.slice(i);
}

// ---------- 2.4 block-start matchers ----------
// ATX: returns {level, text} or null. cur positioned after leading ws (<=3).
function matchATX(cur) {
  const s = cur.s;
  let p = cur.p;
  let hashes = 0;
  while (p < s.length && s[p] === '#') { hashes++; p++; }
  if (hashes === 0 || hashes > 6) return null;
  if (p < s.length && s[p] !== ' ' && s[p] !== '\t') return null;
  let text = s.slice(p);
  // strip closing sequence: trailing #s preceded by a space
  const m = /[ \t]+#+[ \t]*$/.exec(text);
  if (m) text = text.slice(0, text.length - m[0].length);
  else {
    const m2 = /^[ \t]+$/.test(text) ? text : null;
    if (m2 !== null) text = '';
  }
  text = text.replace(/^[ \t]+/, '');
  text = text.replace(/[ \t]+$/, '');
  return { level: hashes, text };
}
// Fence: returns {ch, len, info} or null
function matchFence(cur) {
  const s = cur.s;
  let p = cur.p;
  const ch = s[p];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (p < s.length && s[p] === ch) { len++; p++; }
  if (len < 3) return null;
  const info = s.slice(p);
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len, info };
}
function isHrLine(s) {
  // s = content after container stripping, up to 3 leading spaces already consumed by caller? no: check here
  const m = /^ {0,3}([-_*])(?:[ \t]*\1){2,}[ \t]*$/.exec(s);
  return !!m;
}
function matchSetext(cur) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(curRest(cur));
  if (!m) return null;
  return { level: m[1][0] === '=' ? 1 : 2, raw: m[0] };
}
// List marker: returns {bullet, ordered, start, delim, markerLen, contentIndent, empty} or null
function matchListMarker(cur) {
  const s = cur.s;
  let p = cur.p;
  if (p >= s.length) return null;
  const c = s[p];
  let bullet = false, ordered = false, start = 1, delim = '', markerLen = 0;
  if (c === '-' || c === '*' || c === '+') { bullet = true; markerLen = 1; p++; }
  else if (/[0-9]/.test(c)) {
    let q = p;
    while (q < s.length && /[0-9]/.test(s[q])) q++;
    if (q - p > 9) return null;
    if (q >= s.length || (s[q] !== '.' && s[q] !== ')')) return null;
    ordered = true; start = parseInt(s.slice(p, q), 10); delim = s[q]; markerLen = q + 1 - p; p = q + 1;
  } else return null;
  // after marker: 1+ spaces/tabs or end of line
  if (p >= s.length) {
    return { bullet, ordered, start, delim, markerLen, contentIndent: markerLen + 1, empty: true };
  }
  if (s[p] !== ' ' && s[p] !== '\t') return null;
  // count whitespace columns (tab = to next multiple of 4 from cur.col + markerLen)
  let col = cur.col + markerLen, q = p, ws = 0;
  while (q < s.length && (s[q] === ' ' || s[q] === '\t')) {
    if (s[q] === ' ') { ws++; col++; q++; }
    else { const n = 4 - (col % 4); ws += n; col += n; q++; }
  }
  let contentIndent;
  if (q >= s.length) contentIndent = markerLen + 1;
  else if (ws >= 1 && ws <= 4) contentIndent = markerLen + ws;
  else contentIndent = markerLen + 1;
  return { bullet, ordered, start, delim, markerLen, contentIndent, empty: q >= s.length, wsEnd: q };
}

// HTML block start: returns type 1-7 or 0. cur at content start.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));
function matchHtmlTagAt(s, i) {
  // match an HTML tag starting at s[i]=='<'; returns {len, name, closing, type} or null
  if (s[i] !== '<') return null;
  let j = i + 1;
  if (s.startsWith('<!--', i)) {
    // abruptly-closed comments <!--> and <!---> end right here
    if (s.startsWith('<!-->', i)) return { len: 5, name: null, closing: false, comment: true };
    if (s.startsWith('<!--->', i)) return { len: 6, name: null, closing: false, comment: true };
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return null;
    return { len: end + 3 - i, name: null, closing: false, comment: true };
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return { len: end + 2 - i, name: null, closing: false, pi: true };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end === -1) return null;
    return { len: end + 3 - i, name: null, closing: false, cdata: true };
  }
  if (s.startsWith('<!', i) && /[A-Za-z]/.test(s[i + 2] || '')) {
    const end = s.indexOf('>', i + 2);
    if (end === -1) return null;
    return { len: end + 1 - i, name: null, closing: false, decl: true };
  }
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= s.length || !/[A-Za-z]/.test(s[j])) return null;
  const nameStart = j;
  while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
  const name = s.slice(nameStart, j).toLowerCase();
  // closing tags take no attributes: only whitespace then '>'
  if (closing) {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j >= s.length || s[j] !== '>') return null;
    return { len: j + 1 - i, name, closing, selfClose: false };
  }
  // attributes
  let selfClose = false;
  let firstAttr = true, sepPending = false;
  while (true) {
    let skipped = false;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; skipped = true; }
    if (j >= s.length) return null;
    if (s[j] === '>') { j++; break; }
    if (s[j] === '/' && s[j + 1] === '>') { selfClose = true; j += 2; break; }
    if (s[j] === '/') return null;
    // attributes must be separated by whitespace (unless the previous
    // boolean attribute already consumed its trailing space)
    if (!firstAttr && !skipped && !sepPending) return null;
    firstAttr = false; sepPending = false;
    // attribute name (must not start with ':')
    if (!/[A-Za-z_]/.test(s[j]) && s[j].charCodeAt(0) < 128) {
      if (!/[^\x00-\x7F]/.test(s[j])) return null;
    }
    while (j < s.length && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    let skipped2 = false;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; skipped2 = true; }
    if (s[j] === '=') {
      j++;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j]; j++;
        while (j < s.length && s[j] !== q) j++;
        if (j >= s.length) return null;
        j++;
      } else {
        if (j >= s.length || /[ \t\n"'=<>`]/.test(s[j])) return null;
        while (j < s.length && !/[ \t\n"'=<>`]/.test(s[j])) j++;
      }
    } else {
      // boolean attribute: the space skipped above separates it from the next
      sepPending = skipped2;
    }
  }
  return { len: j - i, name, closing, selfClose };
}
function matchHtmlBlockStart(cur) {
  const s = cur.s;
  let p = cur.p;
  // up to 3 spaces already consumed by caller in most paths; check here
  let sp = 0;
  while (p < s.length && s[p] === ' ' && sp < 3) { p++; sp++; }
  if (p >= s.length || s[p] !== '<') return 0;
  if (s.startsWith('<!--', p)) return 2;
  if (s.startsWith('<?', p)) return 3;
  if (s.startsWith('<![CDATA[', p)) return 5;
  if (s.startsWith('<!', p) && /[A-Za-z]/.test(s[p + 2] || '')) return 4;
  // tag name (types 1 and 6 need only the name; the tag may span lines)
  let k = p + 1;
  let closing = false;
  if (s[k] === '/') { closing = true; k++; }
  if (k >= s.length || !/[A-Za-z]/.test(s[k])) return 0;
  const ns = k;
  while (k < s.length && /[A-Za-z0-9-]/.test(s[k])) k++;
  const nm = s.slice(ns, k).toLowerCase();
  const after = s[k];
  const boundary = after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '>' || (after === '/' && s[k + 1] === '>');
  if (boundary) {
    if (!closing && (nm === 'script' || nm === 'pre' || nm === 'style' || nm === 'textarea')) return 1;
    if (BLOCK_TAGS.has(nm)) return 6;
  }
  // type 7: a complete open/closing tag alone on the line
  const tag = matchHtmlTagAt(s, p);
  if (tag && tag.name) {
    let r = p + tag.len;
    while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
    if (r >= s.length) return 7;
  }
  return 0;
}
// HTML block end condition for types 1-5
function htmlBlockEnd(type, line) {
  if (type === 1) return /<\/(script|pre|style|textarea)[ \t>]/i.test(line) || /<\/(script|pre|style|textarea)>$/i.test(line);
  if (type === 2) return line.includes('-->');
  if (type === 3) return line.includes('?>');
  if (type === 4) return line.includes('>');
  if (type === 5) return line.includes(']]>');
  return false;
}

// ---------- bare URL / bare email ----------
// matchBareUrl(s, i, brk): returns {url, end} or null. brk = index of a ']'
// that must not be consumed (link-closing bracket). Caller computes brk.
const TRAIL = new Set(['?', '!', '.', ',', ':', '*', '_', '~', ';']);
function matchBareUrl(s, i, brk) {
  let scheme = null, start = i;
  const rest = s.slice(i);
  const m = /^(https?:\/\/|ftp:\/\/)/i.exec(rest);
  if (m) scheme = m[1].toLowerCase();
  else if (/^www\./.test(rest)) scheme = 'www.';
  else if (/^xmpp:/.test(rest)) scheme = 'xmpp:';
  else if (/^mailto:/.test(rest)) scheme = 'mailto:';
  else return null;
  // www./xmpp:/mailto: are lowercase-only; schemes http/https/ftp are case-insensitive
  if (scheme === 'www.' && rest.slice(0, 4) !== 'www.') return null;
  if (scheme === 'xmpp:' && rest.slice(0, 5) !== 'xmpp:') return null;
  if (scheme === 'mailto:' && rest.slice(0, 7) !== 'mailto:') return null;
  let j = i + scheme.length;
  if (scheme === 'www.' && j >= s.length) return null;
  if (scheme === 'xmpp:') {
    const em = matchBareEmail(s, j);
    if (!em) return null;
    let end = em.end;
    // optional ONE /resource segment
    if (s[end] === '/') {
      let k = end + 1;
      while (k < s.length && /[A-Za-z0-9.@]/.test(s[k])) k++;
      // trim trailing . / @ of the segment
      let e2 = k;
      while (e2 > end + 1 && (s[e2 - 1] === '.' || s[e2 - 1] === '@')) e2--;
      if (e2 > end + 1) end = e2;
    }
    return { url: s.slice(i, end), end };
  }
  if (scheme === 'mailto:') {
    const em = matchBareEmail(s, j);
    if (!em) return null;
    return { url: s.slice(i, em.end), end: em.end };
  }
  // consume [^\s<>]+ up to brk
  let end = j;
  const limit = brk >= 0 ? Math.min(brk, s.length) : s.length;
  while (end < limit && !/[\s<>]/.test(s[end])) end++;
  if (end === j) return null;
  let url = s.slice(i, end);
  // trim loop: entity, trailing punct, parens (interleaved)
  let noUnclosedTrunc = false;
  for (;;) {
    let changed = false;
    // trailing entity-like &word; / &#...; stripped whole
    const em = /&([A-Za-z0-9_]+|#[0-9]+|#[xX][0-9a-fA-F]+);$/.exec(url);
    if (em) { url = url.slice(0, url.length - em[0].length); changed = true; }
    // trailing punctuation
    while (url.length > 0 && TRAIL.has(url[url.length - 1])) { url = url.slice(0, -1); changed = true; }
    // paren handling
    if (url.length > 0 && url[url.length - 1] === ')') {
      // find matching '(' scanning back with clamping
      let depth = 0, open = -1;
      for (let k = url.length - 1; k >= 0; k--) {
        if (url[k] === ')') depth++;
        else if (url[k] === '(') {
          depth--;
          if (depth === 0) { open = k; break; }
        }
      }
      if (open === -1) { url = url.slice(0, -1); changed = true; }
      else {
        // group (open, len-1): nested '(' inside?
        const inner = url.slice(open + 1, url.length - 1);
        if (inner.includes('(')) {
          url = url.slice(0, -1); changed = true; noUnclosedTrunc = true;
        }
      }
    }
    if (!changed) break;
  }
  // truncate at first unclosed '(' (unless a nested trim already left one)
  if (!noUnclosedTrunc) {
    let depth = 0, cut = -1;
    for (let k = 0; k < url.length; k++) {
      if (url[k] === '(') depth++;
      else if (url[k] === ')') { if (depth > 0) depth--; }
    }
    if (depth > 0) {
      // find first '(' that never closes
      let d = 0;
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') { if (d === 0) cut = k; d++; }
        else if (url[k] === ')') { if (d > 0) d--; }
      }
      // recompute: first unclosed '(' = scan with stack
      let stack = [];
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') stack.push(k);
        else if (url[k] === ')') { if (stack.length) stack.pop(); }
      }
      if (stack.length) { url = url.slice(0, stack[0]); }
      // re-trim trailing punctuation after truncation
      while (url.length > 0 && TRAIL.has(url[url.length - 1])) url = url.slice(0, -1);
    }
  }
  if (url.length === 0) return null;
  return { url, end: i + url.length };
}
function matchBareEmail(s, i, underCloserAt) {
  // local part [A-Za-z0-9._+-]+ ; domain labels, >=2 labels, dot required
  let j = i;
  while (j < s.length && /[A-Za-z0-9._+\-]/.test(s[j])) j++;
  if (j === i || s[j] !== '@') return null;
  const local = s.slice(i, j);
  if (local.startsWith('.') || local.endsWith('.')) {
    // leading/trailing dot in local part: marked still links some; keep simple
  }
  let k = j + 1;
  // domain: labels [A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])? joined by '.'
  let labels = 0, labelStart = k, lastEnd = k;
  while (k < s.length) {
    const ch = s[k];
    if (/[A-Za-z0-9_-]/.test(ch)) { k++; continue; }
    if (ch === '.') {
      // a '.' only continues the domain if a label char follows it;
      // otherwise it terminates the address (trailing '.' is text)
      const nx = s[k + 1];
      if (!nx || !/[A-Za-z0-9]/.test(nx)) break;
      const lab = s.slice(labelStart, k);
      if (!lab || !/^[A-Za-z0-9]/.test(lab) || !/[A-Za-z0-9]$/.test(lab)) return null;
      labels++; labelStart = k + 1; k++; continue;
    }
    break;
  }
  const lab = s.slice(labelStart, k);
  if (!lab || !/^[A-Za-z0-9]/.test(lab) || !/[A-Za-z0-9]$/.test(lab)) return null;
  labels++;
  if (labels < 2) return null;
  let end = k;
  // back up over trailing -/_ in the last label
  while (end > labelStart && (s[end - 1] === '-' || s[end - 1] === '_')) end--;
  if (end === labelStart) return null;
  // trailing '.' ',' '~' are text, not part of the address
  // (they are not consumed by the loop above since '.' ends a label only if followed by label chars;
  //  a trailing '.' leaves k at the '.', which is not part of the last label - handled by label check)
  // char after domain must not be - or _
  if (s[end] === '-' || s[end] === '_') {
    // if the _ run is a plausible closing emphasis delimiter with an earlier _ opener, allow
    if (s[end] === '_' && underCloserAt && underCloserAt(end)) {
      // fall through: link ends at `end`
    } else return null;
  }
  return { url: s.slice(i, end), end };
}

// ---------- backtick-run helpers for link labels ----------
// pair backtick runs by EXACT length; count runs with no closer of own length
function unpairedBacktickRuns(t) {
  const runs = [];
  for (let i = 0; i < t.length;) {
    if (t[i] === '\\' && t[i + 1] === '`') { i += 2; continue; }
    if (t[i] === '`') {
      let j = i;
      while (j < t.length && t[j] === '`') j++;
      runs.push({ len: j - i, start: i, end: j });
      i = j;
    } else i++;
  }
  // exact-length pairing, greedy left-to-right
  const open = [];
  let unpaired = 0;
  for (const r of runs) {
    const idx = open.findIndex(o => o.len === r.len);
    if (idx >= 0) open.splice(idx, 1);
    else open.push(r);
  }
  unpaired = open.length;
  return unpaired;
}
// find code spans (paired exact-length runs) in t; returns [{start,end,contentStart,contentEnd}]
function findCodeSpans(t) {
  const spans = [];
  const runs = [];
  for (let i = 0; i < t.length;) {
    if (t[i] === '\\' && t[i + 1] === '`') { i += 2; continue; }
    if (t[i] === '`') {
      let j = i;
      while (j < t.length && t[j] === '`') j++;
      runs.push({ len: j - i, start: i, end: j });
      i = j;
    } else i++;
  }
  const used = new Array(runs.length).fill(false);
  for (let a = 0; a < runs.length; a++) {
    if (used[a]) continue;
    for (let b = a + 1; b < runs.length; b++) {
      if (!used[b] && runs[b].len === runs[a].len) {
        spans.push({ start: runs[a].start, end: runs[b].end, contentStart: runs[a].end, contentEnd: runs[b].start });
        used[a] = used[b] = true;
        break;
      }
    }
  }
  return spans;
}
function hasPoisonedCodeSpan(t) {
  for (const sp of findCodeSpans(t)) {
    if (t.slice(sp.contentStart, sp.contentEnd).includes('`')) return true;
  }
  return false;
}
// linkTextOk: exact-length pairing (unpaired !== 1) AND no poisoned span
// with anything following it
function linkTextOk(t) {
  if (unpairedBacktickRuns(t) === 1) return false;
  for (const sp of findCodeSpans(t)) {
    if (t.slice(sp.contentStart, sp.contentEnd).includes('`') && sp.end < t.length) return false;
  }
  return true;
}
// hasClosingParen: scan s from i for a closing ')' at depth 0, skipping
// <...> and quoted titles; an unclosed quote/angle is a normal char
function hasClosingParen(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<') {
      const e = s.indexOf('>', i + 1);
      if (e === -1) { i++; continue; }
      i = e + 1; continue;
    }
    if (c === '"' || c === "'") {
      const e = s.indexOf(c, i + 1);
      if (e === -1) { i++; continue; }
      i = e + 1; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return true;
      depth--;
    }
    i++;
  }
  return false;
}

// ---------- inline link destination / title ----------
// unescape backslash escapes (ASCII punctuation) in a string
function unescapeStr(s) {
  return s.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
}
// parse a link destination starting at s[i]; returns {dest, end} or null
// end = index just past the destination
function parseLinkDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (s[j] === '>') return { dest: unescapeStr(s.slice(i + 1, j)), end: j + 1 };
      if (s[j] === '\n' || s[j] === '<') return null;
      j++;
    }
    return null;
  }
  let j = i, depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return null;
  return { dest: unescapeStr(s.slice(i, j)), end: j };
}
// parse a link title starting at s[i] (after skipping ws); returns {title, end} or null
function parseLinkTitle(s, i) {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (s[j] === q) {
        const content = s.slice(i + 1, j);
        if (/\n[ \t]*\n/.test(content)) return null;
        return { title: unescapeStr(content), end: j + 1 };
      }
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1, depth = 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (s[j] === '(') depth++;
      else if (s[j] === ')') {
        depth--;
        if (depth === 0) {
          const content = s.slice(i + 1, j);
          if (/\n[ \t]*\n/.test(content)) return null;
          return { title: unescapeStr(content), end: j + 1 };
        }
      }
      j++;
    }
    return null;
  }
  return null;
}
// tryInlineLink(s, i): s[i]=='(' ; returns {href, title, end} (end past ')') or null
function tryInlineLink(s, i) {
  let j = i + 1;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j < s.length && s[j] === ')') return { href: '', title: null, end: j + 1 };
  const d = parseLinkDest(s, j);
  if (!d) return null;
  j = d.end;
  let title = null;
  // skip ws (incl newlines); if next is a quote/paren, parse title
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  if (k < s.length && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const t = parseLinkTitle(s, k);
    if (!t) return null;
    title = t.title;
    k = t.end;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  }
  if (k >= s.length || s[k] !== ')') return null;
  return { href: d.dest, title, end: k + 1 };
}

// ---------- link reference definitions ----------
// Try to parse ONE definition from text starting at offset `start` (in a
// joined paragraph string). Returns {label, href, title, consumed} where
// consumed = number of chars consumed, or null.
function parseRefDef(text, start) {
  let i = start;
  // up to 3 leading spaces
  let sp = 0;
  while (i < text.length && text[i] === ' ' && sp < 3) { i++; sp++; }
  if (text[i] !== '[') return null;
  // label: may span lines; a '[' inside fails; escaped ']' does not close
  let j = i + 1, depth = 0;
  while (j < text.length) {
    if (text[j] === '\\' && j + 1 < text.length) { j += 2; continue; }
    if (text[j] === '[') return null;
    if (text[j] === ']') break;
    j++;
  }
  if (j >= text.length || text[j] !== ']') return null;
  const rawLabel = text.slice(i + 1, j);
  const label = normalizeLabel(rawLabel);
  if (!label || label.length > 999) return null;
  j++;
  if (text[j] !== ':') return null;
  j++;
  // after ':': only spaces (not tabs) on the same line
  let k = j;
  while (k < text.length && text[k] === ' ') k++;
  if (k < text.length && text[k] === '\t') return null;
  if (k === j + 0 && text[k] === '\n') {
    // destination may be on the NEXT line; skip newline + leading ws
    k++;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  } else if (k < text.length && text[k] === '\n') {
    k++;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  }
  const d = parseLinkDest(text, k);
  if (!d) return null;
  let end = d.end;
  // optional title, separated by whitespace (spaces, tabs, newlines)
  let title = null;
  let t = end;
  while (t < text.length && (text[t] === ' ' || text[t] === '\t' || text[t] === '\n')) t++;
  const titleSameLine = !text.slice(end, t).includes('\n');
  if (t < text.length && (text[t] === '"' || text[t] === "'" || text[t] === '(')) {
    if (t === end) return null; // title must be separated from dest by whitespace
    const tt = parseLinkTitle(text, t);
    if (tt) {
      // trailing text after the title?
      let u2 = tt.end;
      while (u2 < text.length && (text[u2] === ' ' || text[u2] === '\t')) u2++;
      if (u2 < text.length && text[u2] !== '\n') {
        // trailing text after title: invalid if same line as dest,
        // else def is valid without the title (title line becomes text)
        if (titleSameLine) return null;
      } else { title = tt.title; end = tt.end; }
    } else {
      // malformed title: invalid if same line as dest, else def stands
      if (titleSameLine) return null;
    }
  }
  // after dest/title, only whitespace may follow on the line
  let u = end;
  while (u < text.length && (text[u] === ' ' || text[u] === '\t')) u++;
  if (u < text.length && text[u] !== '\n') return null;
  return { label, href: d.dest, title, consumed: end - start };
}
// extract leading defs from paragraph lines; returns {defs, restLines}
function extractDefs(lines, refs) {
  const text = lines.join('\n');
  let pos = 0;
  while (true) {
    const d = parseRefDef(text, pos);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    pos += d.consumed;
    if (text[pos] === '\n') pos++;
  }
  const restText = text.slice(pos);
  const restLines = restText === '' ? [] : restText.split('\n');
  return { restLines, consumed: 0 };
}

// ---------- tables ----------
function splitTableRow(line) {
  // split on unescaped | ; strip one leading/trailing empty cell
  const cells = [];
  let cur = '', i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += c + line[i + 1]; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  // strip one leading empty cell if line starts with |
  if (cells.length > 0 && cells[0].trim() === '' && /^\s*\|/.test(line)) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '' && /\|\s*$/.test(line)) cells.pop();
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}
function isDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    const m = /^:?-+:?$/.exec(c);
    if (!m) return null;
    if (c.startsWith(':') && c.endsWith(':') && c.length > 2) aligns.push('center');
    else if (c.startsWith(':')) aligns.push('left');
    else if (c.endsWith(':')) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}
function isTableLines(lines) {
  // lines[0] = header, lines[1] = delimiter
  if (!lines || lines.length < 2) return false;
  if (!lines[0].includes('|')) return false;
  // header must contain an unescaped |
  let hasPipe = false;
  for (let i = 0; i < lines[0].length; i++) {
    if (lines[0][i] === '\\') { i++; continue; }
    if (lines[0][i] === '|') { hasPipe = true; break; }
  }
  if (!hasPipe) return false;
  const aligns = isDelimiterRow(lines[1]);
  if (!aligns) return false;
  const headerCells = splitTableRow(lines[0]);
  if (aligns.length !== headerCells.length) return false;
  return { headerCells, aligns };
}
function buildTableNode(lines) {
  const info = isTableLines(lines.slice(0, 2));
  const header = info.headerCells;
  const aligns = info.aligns;
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
  }
  return { t: 'table', header, aligns, rows };
}

// ---------- block parser ----------
// matchQuote: returns 0 (no match), 1 (matched, literal space consumed),
// 2 (matched, tab directly after '>' — NOT consumed, quoteTab).
// Skips up to 3 spaces before '>'. Consumes '>' + at most 1 literal ' '.
function matchQuote(cur) {
  const startP = cur.p, startCol = cur.col;
  let p = cur.p;
  let sp = 0;
  while (p < cur.s.length && cur.s[p] === ' ' && sp < 3) { p++; sp++; }
  if (p >= cur.s.length || cur.s[p] !== '>') return 0;
  p++;
  let kind = 1;
  if (p < cur.s.length && cur.s[p] === ' ') { p++; }
  else if (p < cur.s.length && cur.s[p] === '\t') { kind = 2; }
  cur.col = startCol + (p - startP);
  cur.p = p;
  return kind;
}
// fence indent strip: a tab counts as exactly 1 column, removed whole
function fenceStripIndent(cur, n) {
  let need = n;
  while (need > 0 && cur.p < cur.s.length) {
    const ch = cur.s[cur.p];
    if (ch === ' ') { cur.p++; cur.col++; need--; }
    else if (ch === '\t') { cur.p++; cur.col += 4 - (cur.col % 4); need -= 1; }
    else break;
  }
}
function firstWordOfInfo(info) {
  const m = /^\s*([^\s]*)/.exec(info);
  return m ? unescapeStr(m[1]) : '';
}

function parseBlocks(lines, endsWithNL) {
  const refs = new Map();
  const root = { t: 'doc', children: [], blank: false, blankBelow: false, loose: false };
  let stack = [root];
  let leaf = null;
  let quoteBase = 0, quoteTab = false, matchedQuote = false;

  function markBlank() {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (i === stack.length - 1) f.blank = true;
      if (f.t === 'quote') break;
      f.blankBelow = true;
    }
  }
  function noteChild(frame) {
    // a child added after a blank line loosens the frame; consume blankBelow
    if (frame.blankBelow && frame.children.length > 0) frame.loose = true;
    for (let i = 0; i < stack.length; i++) {
      if (stack[i] === frame) {
        for (let j = 0; j <= i; j++) stack[j].blankBelow = false;
        break;
      }
    }
  }
  function addBlock(frame, node) {
    if (node === null || node === undefined) return;
    noteChild(frame);
    frame.children.push(node);
  }
  function popTo(idx) {
    while (stack.length > idx) {
      const fr = stack.pop();
      if (leaf && !stack.includes(leaf.parent)) closeLeaf('container');
    }
  }
  function nextLineRemainder(nextRaw) {
    const c = mkCur(nextRaw);
    for (let si = 1; si < stack.length; si++) {
      const fr = stack[si];
      if (fr.t === 'list') continue;
      if (fr.t === 'quote') { if (matchQuote(c) === 0) return null; continue; }
      if (fr.t === 'item') {
        if (rawBlank(nextRaw)) { curSkipWsUpTo(c, fr.contentIndent); continue; }
        if (!curSkipWs(c, fr.contentIndent)) return null;
        continue;
      }
    }
    return curRest(c);
  }
  function computeTrailingNL(li) {
    if (li + 1 >= lines.length) return endsWithNL;
    const rem = nextLineRemainder(lines[li + 1]);
    return rem !== null && rem !== '';
  }
  function finalizePara(plines) {
    const ex = extractDefs(plines, refs);
    const rest = ex.restLines;
    if (rest.length === 0) return [];
    if (rest.join('\n').trim() === '') return [];
    for (let k = 0; k + 1 < rest.length; k++) {
      if (isTableLines(rest.slice(k, k + 2))) {
        const out = [];
        if (k > 0) out.push({ t: 'para', text: rest.slice(0, k).join('\n') });
        out.push(buildTableNode(rest.slice(k)));
        return out;
      }
    }
    return [{ t: 'para', text: rest.join('\n') }];
  }
  function closeLeaf(how) {
    if (!leaf) return;
    const lf = leaf; leaf = null;
    const parent = lf.parent;
    const idx = parent.children.length - 1;
    if (lf.t === 'para') {
      const fins = finalizePara(lf.node.lines);
      parent.children.splice(idx, 1, ...fins);
    } else if (lf.t === 'fence') {
      if (how !== 'closed' && !lf.anchored && parent.t === 'item') lf.node.lines = [];
      const ls = lf.node.lines;
      if (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
    } else if (lf.t === 'code') {
      // pending trailing blanks are dropped
    } else if (lf.t === 'html') {
      if (how === 'eof') lf.node.trailingNL = endsWithNL;
    }
  }
  function startPara(parent, firstLine) {
    const node = { t: 'para', lines: [firstLine] };
    addBlock(parent, node);
    leaf = { t: 'para', parent, node };
  }
  function startFence(parent, ch, len, indent, lang) {
    const node = { t: 'fence', ch, len, indent, lang, lines: [] };
    addBlock(parent, node);
    leaf = { t: 'fence', parent, node, anchored: false };
  }
  function startCode(parent, firstLine) {
    const node = { t: 'code', lines: [firstLine], pending: [] };
    addBlock(parent, node);
    leaf = { t: 'code', parent, node };
  }
  function startHtml(parent, type, firstLine, li) {
    const node = { t: 'html', type, lines: [firstLine], trailingNL: false };
    addBlock(parent, node);
    // types 1-5 can end on the very first line (e.g. <style>..</style>)
    if (type >= 1 && type <= 5 && htmlBlockEnd(type, firstLine)) {
      node.trailingNL = computeTrailingNL(li);
      return;
    }
    leaf = { t: 'html', parent, node };
  }
  function listCanInterrupt(lm) {
    if (lm.empty) return false; // an empty list item cannot interrupt a paragraph
    if (!lm.ordered) return true;
    if (lm.start === 1) return true;
    if (leaf && leaf.parent && leaf.parent.t === 'item') return true;
    return false;
  }
  function interruptsPara(cur) {
    const tmp = { s: cur.s, p: cur.p, col: cur.col };
    curSkipWsUpTo(tmp, 3);
    if (matchFence(tmp)) return true;
    if (matchATX(tmp)) return true;
    if (isHrLine(curRest(cur))) return true;
    const q = { s: cur.s, p: cur.p, col: cur.col };
    if (matchQuote(q) !== 0) return true;
    const lm = matchListMarker(cur);
    if (lm && listCanInterrupt(lm)) return true;
    const ht = matchHtmlBlockStart(cur);
    if (ht >= 1 && ht <= 6) return true;
    return false;
  }
  function isBlockStart(cur) {
    const tmp = { s: cur.s, p: cur.p, col: cur.col };
    curSkipWsUpTo(tmp, 3);
    if (matchATX(tmp)) return true;
    if (isHrLine(curRest(cur))) return true;
    if (matchFence(tmp)) return true;
    const q = { s: cur.s, p: cur.p, col: cur.col };
    if (matchQuote(q) !== 0) return true;
    if (matchListMarker(tmp)) return true;
    const ht = matchHtmlBlockStart(cur);
    if (ht >= 1 && ht <= 6) return true;
    return false;
  }
  function isLazyLine(cur) {
    if (!leaf || leaf.t !== 'para') return false;
    const tmp = { s: cur.s, p: cur.p, col: cur.col };
    curSkipWsUpTo(tmp, 3);
    if (matchATX(tmp)) return false;
    if (matchFence(tmp)) return false;
    if (isHrLine(curRest(tmp))) return false;
    const ht = matchHtmlBlockStart(tmp);
    if (ht >= 1 && ht <= 6) return false;
    if (matchListMarker(tmp)) return false;
    return true;
  }

  // ---- main line loop ----
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const cur = mkCur(raw);
    const lineIsBlank = rawBlank(raw);
    // ---------- Phase 1: container matching ----------
    let failAt = -1;
    matchedQuote = false; quoteBase = 0; quoteTab = false;
    for (let si = 1; si < stack.length; si++) {
      const fr = stack[si];
      if (fr.t === 'list') continue;
      if (fr.t === 'quote') {
        const startCol = cur.col;
        const k = matchQuote(cur);
        if (k === 0) { failAt = si; break; }
        quoteBase = startCol; quoteTab = (k === 2); matchedQuote = true;
        continue;
      }
      if (fr.t === 'item') {
        if (lineIsBlank) { curSkipWsUpTo(cur, fr.contentIndent); continue; }
        const saveP = cur.p, saveCol = cur.col;
        const need = fr.contentCol - cur.col;
        if (need > 0 && !curSkipWs(cur, need)) {
          cur.p = saveP; cur.col = saveCol; // restore: keep leading ws for the block
          failAt = si; break;
        }
        continue;
      }
    }
    // ---------- failAt handling ----------
    let fenceFall = false, absorbSetext = false, fenceQuoteClose = false;
    let lazyDone = false;
    if (failAt >= 0) {
      const ff = stack[failAt];
      const curIsBlank = lineIsBlank || curBlank(cur);
      // S3.14: fence in quote in item, failing frame is the item, plain/setext line
      if (leaf && leaf.t === 'fence' && leaf.parent && leaf.parent.t === 'quote' && !curIsBlank && !isBlockStart(cur)) {
        const qf = leaf.parent;
        const qi = stack.indexOf(qf);
        if (qi > 0 && stack[qi - 1] && stack[qi - 1].t === 'item' && failAt === qi - 1) {
          popTo(failAt + 1);
        } else if (ff.t === 'quote') {
          // fence directly in a quote (no item above): a plain line ends
          // the quote, it is not fence content (cm-237)
          popTo(failAt);
        }
      } else if (leaf && leaf.t === 'fence' && ff.t === 'item') {
        // S3.1 anchor rule (fence directly in the failing item)
        const se = matchSetext(cur);
        const isSe = !!se && !isHrLine(curRest(cur));
        if (!leaf.anchored) popTo(failAt);
        else if (isBlockStart(cur)) popTo(failAt);
        else if (curIsBlank) popTo(failAt);
        else {
          fenceFall = true;
          if (isSe) absorbSetext = true;
        }
      } else if (leaf && leaf.t === 'fence' && ff.t === 'quote') {
        // fence in an item inside the failing quote: plain/setext absorbed
        // (last line of the quote); block start / blank pops normally
        const se = matchSetext(cur);
        const isSe = !!se && !isHrLine(curRest(cur));
        if (curIsBlank || isBlockStart(cur)) popTo(failAt);
        else if (leaf.parent && leaf.parent.t === 'item') {
          fenceFall = true; fenceQuoteClose = true;
          if (isSe) absorbSetext = true;
        } else popTo(failAt);
      } else if (leaf && leaf.t === 'para' && !curIsBlank && isLazyLine(cur)) {
        // lazy continuation
        let content = curRest(cur);
        // session-4 lazy tab expansion
        const qb = matchedQuote ? quoteBase : 0;
        const qt = matchedQuote ? quoteTab : false;
        const expanded = expandLeadingTabs(content, cur.col, qb, qt);
        if (expanded !== content) {
          cur.s = cur.s.slice(0, cur.p) + expanded;
          content = expanded;
        }
        if (leadingWsCols(content, cur.col) >= 4) {
          curSkipWs(cur, 4);
          content = curRest(cur);
        }
        // lazy setext: a lazy line that looks like a setext underline must be
        // indented to 4 spaces so it stays literal text, not a heading
        if (matchSetext({ s: content, p: 0, col: 0 })) {
          const m = /^([ \t]*)/.exec(content);
          const n = m ? leadingWsCols(m[1], 0) : 0;
          const target = Math.max(4, n);
          content = ' '.repeat(target) + content.slice(m ? m[1].length : 0);
        }
        leaf.node.lines.push(content);
        lazyDone = true;
      } else {
        popTo(failAt);
      }
    }
    if (lazyDone) continue;
    // ---------- Phase 2 loop ----------
    let guard = 0;
    while (true) {
      if (++guard > 60) break;
      // session-2/4 tab expansion in containers
      if (stack.length > 1) {
        const rest = curRest(cur);
        const expanded = expandLeadingTabs(rest, cur.col, quoteBase, quoteTab);
        if (expanded !== rest) cur.s = cur.s.slice(0, cur.p) + expanded;
      }
      const blank = lineIsBlank || curBlank(cur);
      const top = stack[stack.length - 1];
      // ----- fence leaf -----
      if (leaf && leaf.t === 'fence') {
        const tmp = { s: cur.s, p: cur.p, col: cur.col };
        curSkipWsUpTo(tmp, 3);
        const fm = matchFence(tmp);
        if (fm && fm.ch === leaf.node.ch && fm.len >= leaf.node.len && fm.info.trim() === '') {
          closeLeaf('closed');
          break;
        }
        let content = curRest(cur);
        if (leaf.node.ch === '`') {
          const c2 = { s: cur.s, p: cur.p, col: cur.col };
          fenceStripIndent(c2, leaf.node.indent);
          content = curRest(c2);
        }
        if (absorbSetext) {
          // setext line absorbed as fence content: leading spaces raised to max(4, n)
          const m = /^([ \t]*)/.exec(content);
          const n = m ? leadingWsCols(m[1], 0) : 0;
          const target = Math.max(4, n);
          content = ' '.repeat(target) + content.slice(m ? m[1].length : 0);
          absorbSetext = false;
        }
        leaf.node.lines.push(content);
        if (failAt < 0 && /\S/.test(content)) leaf.anchored = true;
        break;
      }
      // ----- indented-code leaf -----
      if (leaf && leaf.t === 'code') {
        if (blank) {
          const c2 = { s: cur.s, p: cur.p, col: cur.col };
          curSkipWsUpTo(c2, 4);
          leaf.node.pending.push(curRest(c2));
          break;
        }
        const c2 = { s: cur.s, p: cur.p, col: cur.col };
        if (curSkipWs(c2, 4)) {
          for (const pl of leaf.node.pending) leaf.node.lines.push(pl);
          leaf.node.pending = [];
          cur.p = c2.p; cur.col = c2.col;
          leaf.node.lines.push(curRest(cur));
          break;
        }
        closeLeaf('container');
        continue;
      }
      // ----- html leaf -----
      if (leaf && leaf.t === 'html') {
        if (blank) {
          if (leaf.node.type >= 6) { closeLeaf('blank'); break; }
          leaf.node.lines.push('');
          break;
        }
        const content = curRest(cur);
        leaf.node.lines.push(content);
        if (leaf.node.type >= 1 && leaf.node.type <= 5 && htmlBlockEnd(leaf.node.type, content)) {
          leaf.node.trailingNL = computeTrailingNL(li);
          closeLeaf('endcond');
          break;
        }
        break;
      }
      // ----- paragraph leaf -----
      if (leaf && leaf.t === 'para') {
        if (blank) { closeLeaf('blank'); markBlank(); break; }
        const se = matchSetext(cur);
        if (se) {
          const ex = extractDefs(leaf.node.lines, refs);
          const rest = ex.restLines;
          if (rest.length === 0) {
            // not a setext: close para (defs consumed), reprocess line as new block
            closeLeaf('container');
            continue;
          }
          // table interaction?
          let tableK = -1;
          for (let k = 0; k + 1 < rest.length; k++) {
            if (isTableLines(rest.slice(k, k + 2))) { tableK = k; break; }
          }
          const dashCount = se.raw.replace(/[^=-]/g, '').length;
          const isDash = se.raw.includes('-');
          if (tableK >= 0 && isDash && dashCount >= 3) {
            // '---' after a table: hr — close para (as table), reprocess line
            closeLeaf('container');
            continue;
          }
          if (tableK >= 0) {
            // '===' / '--' / '=' after a table: a table row
            leaf.node.lines.push(curRest(cur));
            break;
          }
          // convert to heading
          const hlines = rest.slice();
          hlines[0] = hlines[0].replace(/^[ \t]+/, '');
          hlines[hlines.length - 1] = hlines[hlines.length - 1].replace(/[ \t]+$/, '');
          const node = { t: 'heading', level: se.level, text: hlines.join('\n') };
          const idx = leaf.parent.children.length - 1;
          leaf.parent.children.splice(idx, 1, node);
          leaf = null;
          break;
        }
        if (interruptsPara(cur)) { closeLeaf('interrupt'); continue; }
        let content = curRest(cur);
        if (leaf.parent && leaf.parent.t === 'item' && leadingWsCols(content, cur.col) >= 4) {
          const c2 = { s: cur.s, p: cur.p, col: cur.col };
          curSkipWs(c2, 4);
          content = curRest(c2);
        }
        leaf.node.lines.push(content);
        break;
      }
      // ----- no leaf: blank line -----
      if (blank) {
        // blank after an empty item pops only the item
        if (top.t === 'item' && top.children.length === 0) {
          stack.pop();
        }
        markBlank();
        break;
      }
      // ----- no leaf: block starts -----
      // a block that is not a list item cannot live directly under a list:
      // close the list first (unless this line is itself a list marker)
      if (top.t === 'list') {
        const tmp0 = { s: cur.s, p: cur.p, col: cur.col };
        curSkipWsUpTo(tmp0, 3);
        const lm0 = matchListMarker(tmp0);
        // an hr line ends the list (even though it also parses as a marker)
        if (!lm0 || isHrLine(curRest(cur))) { stack.pop(); continue; }
      }
      // fence
      {
        const tmp = { s: cur.s, p: cur.p, col: cur.col };
        curSkipWsUpTo(tmp, 3);
        const fm = matchFence(tmp);
        if (fm) {
          const indent = tmp.col - cur.col;
          cur.p = tmp.p; cur.col = tmp.col;
          const lang = firstWordOfInfo(fm.info);
          startFence(top, fm.ch, fm.len, indent, lang);
          break;
        }
      }
      // ATX
      {
        const tmp = { s: cur.s, p: cur.p, col: cur.col };
        curSkipWsUpTo(tmp, 3);
        const atx = matchATX(tmp);
        if (atx) {
          addBlock(top, { t: 'heading', level: atx.level, text: atx.text });
          break;
        }
      }
      // hr
      if (isHrLine(curRest(cur))) { addBlock(top, { t: 'hr' }); break; }
      // blockquote
      {
        const startCol = cur.col;
        const k = matchQuote(cur);
        if (k !== 0) {
          quoteBase = startCol; quoteTab = (k === 2); matchedQuote = true;
          const qf = { t: 'quote', children: [], blank: false, blankBelow: false, loose: false };
          noteChild(top);
          top.children.push(qf);
          stack.push(qf);
          continue;
        }
      }
      // list
      {
        const tmp = { s: cur.s, p: cur.p, col: cur.col };
        curSkipWsUpTo(tmp, 3);
        const lm = matchListMarker(tmp);
        if (lm) {
          const markerCol = tmp.col;
          // continue existing list?
          let listFr = null;
          if (top.t === 'list') {
            const ch0 = cur.s[tmp.p];
            const same = lm.ordered === !top.bullet &&
              (lm.ordered ? lm.delim === top.delim : ch0 === top.marker);
            if (same) listFr = top;
            else stack.pop(); // different list type: close the old list
          }
          if (!listFr) {
            listFr = { t: 'list', bullet: !lm.ordered, marker: lm.ordered ? lm.delim : cur.s[tmp.p], delim: lm.delim, start: lm.start, children: [], blank: false, blankBelow: false, loose: false };
            noteChild(top);
            stack[stack.length - 1].children.push(listFr);
            stack.push(listFr);
          }
          // new item
          const contentCol = markerCol + lm.contentIndent;
          const itemFr = { t: 'item', contentIndent: lm.contentIndent, contentCol, task: null, children: [], blank: false, blankBelow: false, loose: false };
          noteChild(listFr);
          listFr.children.push(itemFr);
          stack.push(itemFr);
          // advance past marker + whitespace to content (curSkipWsUpTo only
          // skips whitespace, so step over the marker first)
          cur.p = tmp.p; cur.col = tmp.col;
          cur.p += lm.markerLen; cur.col += lm.markerLen;
          curSkipWsUpTo(cur, lm.contentIndent - lm.markerLen);
          // task checkbox?
          const rest0 = curRest(cur);
          const tm = /^\[( |x|X)\]([ \t]+)(?=\S)/.exec(rest0);
          if (tm) {
            itemFr.task = tm[1] === ' ' ? ' ' : 'x';
            // consume only the "[ ]" itself; the following space stays
            // as the content's leading space (rendered after the checkbox)
            cur.p += 3; cur.col += 3;
          }
          if (curBlank(cur) || /^[ \t]*$/.test(curRest(cur))) break; // empty item: line consumed
          continue;
        }
      }
      // HTML block
      {
        const ht = matchHtmlBlockStart(cur);
        if (ht > 0) {
          startHtml(top, ht, curRest(cur), li);
          break;
        }
      }
      // indented code
      if (leadingWsCols(curRest(cur), cur.col) >= 4) {
        const c2 = { s: cur.s, p: cur.p, col: cur.col };
        curSkipWs(c2, 4);
        cur.p = c2.p; cur.col = c2.col;
        startCode(top, curRest(cur));
        break;
      }
      // paragraph
      startPara(top, curRest(cur));
      break;
    }
    // post-phase-2 fenceQuoteClose hook
    if (fenceQuoteClose && leaf && leaf.t === 'fence') {
      popTo(failAt + 1);
    }
  }
  // EOF: close open leaf and frames
  if (leaf) closeLeaf('eof');
  return { root, refs };
}

// ---------- 3. inline parser ----------
// Node types: 0 text {s,raw?} 1 code {s} 2 delim {ch,len,orig,canOpen,canClose,
//   opens,closes,linkId,id,nextCh,dead?,leftoverInside?} 3 linkOpen {href,title,auto?}
// 4 linkClose 5 img {src,altNodes,title} 6 html {s} 7 hard break 8 soft break
// 9 open '[' 10 open '!['
function isLocalPartChar(c) { return !!c && /[A-Za-z0-9._+\-]/.test(c); }

function parseInline(text, refs, state) {
  const nodes = [];
  const delims = [];
  const openers = [];
  // is the scan position inside an open '[' (potential link text)?
  // bare URLs/emails must not linkify there (links cannot nest)
  function hasActiveOpener() {
    for (let k = openers.length - 1; k >= 0; k--) { if (openers[k].active) return true; }
    return false;
  }
  let i = 0;
  const n = text.length;

  function pushText(s) {
    if (!s) return;
    const last = nodes[nodes.length - 1];
    if (last && last.t === 0 && !last.raw) { last.s += s; return; }
    nodes.push({ t: 0, s });
  }
  function pushRaw(s) { nodes.push({ t: 0, s, raw: true }); }
  function pushDelim(ch, len, canOpen, canClose, nextCh) {
    const nd = { t: 2, ch, len, orig: len, canOpen, canClose, opens: [], closes: [], linkId: 0, id: delims.length, nextCh };
    nodes.push(nd); delims.push(nd);
    return nd;
  }
  function flanking(i0, len) {
    const prevCh = i0 === 0 ? '' : text[i0 - 1];
    const nextCh = i0 + len >= n ? '' : text[i0 + len];
    const prevWs = i0 === 0 || isUnicodeWs(prevCh) || prevCh === '\n';
    const nextWs = i0 + len >= n || isUnicodeWs(nextCh) || nextCh === '\n';
    const prevPu = !!prevCh && isPunct(prevCh);
    const nextPu = !!nextCh && isPunct(nextCh);
    const leftFl = !nextWs && (!nextPu || prevWs || prevPu);
    const rightFl = !prevWs && (!prevPu || nextWs || nextPu);
    return { leftFl, rightFl };
  }
  // would the ']' at position j form a link (pure mirror of the ] handler)?
  function wouldFormLink(j) {
    let op = null;
    for (let k = openers.length - 1; k >= 0; k--) { if (openers[k].active) { op = openers[k]; break; } }
    if (!op) return false;
    const labelStart = op.img ? op.src + 2 : op.src + 1;
    const rawLabel = text.slice(labelStart, j);
    let hasLink = false;
    for (let q = op.ni + 1; q < nodes.length; q++) { if (nodes[q].t === 3 && !nodes[q].auto) { hasLink = true; break; } }
    if (!op.img && hasLink) return false;
    if (!linkTextOk(rawLabel)) return false;
    const after = text[j + 1];
    if (after === '(') {
      const il = tryInlineLink(text, j + 1);
      if (il) return true;
      const lab = normalizeLabel(rawLabel);
      return !!lab && refs.has(lab);
    }
    if (after === '[') {
      let lab = null;
      if (text[j + 2] === ']') lab = normalizeLabel(rawLabel);
      else {
        let d = 1, q = j + 2;
        while (q < text.length && d > 0) {
          if (text[q] === '\\') { q += 2; continue; }
          if (text[q] === '[') d++; else if (text[q] === ']') d--;
          q++;
        }
        if (d === 0) lab = normalizeLabel(text.slice(j + 2, q - 1));
      }
      return !!lab && refs.has(lab);
    }
    const lab = normalizeLabel(rawLabel);
    return !!lab && refs.has(lab);
  }
  // find first ']' after i that would form a link (for bare-URL brk)
  function bracketBrk(i) {
    let j = i;
    while (j < text.length && !/[\s<>]/.test(text[j])) {
      if (text[j] === ']' && wouldFormLink(j)) return j;
      j++;
    }
    return -1;
  }
  function underCloserAt(pos) {
    // is there an earlier '_' opener that this '_' could close?
    for (let k = delims.length - 1; k >= 0; k--) {
      const d = delims[k];
      if (d.ch === '_' && d.canOpen) return true;
    }
    return false;
  }
  function handleCloseBracket(i) {
    let opIdx = -1;
    for (let k = openers.length - 1; k >= 0; k--) { if (openers[k].active) { opIdx = k; break; } }
    if (opIdx === -1) { pushText(']'); return i + 1; }
    const op = openers[opIdx];
    const labelStart = op.img ? op.src + 2 : op.src + 1;
    const rawLabel = text.slice(labelStart, i);
    let hasLink = false;
    for (let q = op.ni + 1; q < nodes.length; q++) { if (nodes[q].t === 3 && !nodes[q].auto) { hasLink = true; break; } }
    const blocked = !op.img && hasLink;
    const textOk = linkTextOk(rawLabel);
    const after = text[i + 1];
    let href = null, title = null, end = i + 1, formed = false;
    if (after === '(') {
      const il = tryInlineLink(text, i + 1);
      if (il && !blocked && textOk) { href = il.href; title = il.title; end = il.end; formed = true; }
      else {
        const lab = normalizeLabel(rawLabel);
        if (lab && refs.has(lab) && !blocked && textOk) { const r = refs.get(lab); href = r.href; title = r.title; end = i + 1; formed = true; }
      }
    } else if (after === '[') {
      let lab = null, e2 = i + 1;
      if (text[i + 2] === ']') { lab = normalizeLabel(rawLabel); e2 = i + 3; }
      else {
        let d = 1, q = i + 2;
        while (q < text.length && d > 0) {
          if (text[q] === '\\') { q += 2; continue; }
          if (text[q] === '[') d++; else if (text[q] === ']') d--;
          q++;
        }
        if (d === 0) { lab = normalizeLabel(text.slice(i + 2, q - 1)); e2 = q; }
      }
      if (lab && refs.has(lab) && !blocked && textOk) { const r = refs.get(lab); href = r.href; title = r.title; end = e2; formed = true; }
    } else {
      const lab = normalizeLabel(rawLabel);
      if (lab && refs.has(lab) && !blocked && textOk) { const r = refs.get(lab); href = r.href; title = r.title; end = i + 1; formed = true; }
    }
    if (formed) {
      if (op.img) {
        const altNodes = nodes.slice(op.ni + 1);
        // resolve emphasis inside altNodes (for alt text computation)
        resolveEmphasis(altNodes, altNodes.filter(x => x.t === 2));
        // drop extracted delims from main delims
        const altDelims = new Set(altNodes.filter(x => x.t === 2));
        for (let q = delims.length - 1; q >= 0; q--) { if (altDelims.has(delims[q])) delims.splice(q, 1); }
        nodes.length = op.ni;
        nodes.push({ t: 5, src: href, altNodes, title });
      } else {
        nodes[op.ni] = { t: 3, href, title, auto: false };
        nodes.push({ t: 4 });
      }
      for (let q = opIdx; q < openers.length; q++) openers[q].active = false;
      return end;
    }
    op.active = false;
    if (!op.img && !hasLink && after === '(' && hasClosingParen(text, i + 1) && (textOk || hasPoisonedCodeSpan(rawLabel))) {
      for (let q = op.ni + 1; q < nodes.length; q++) { if (nodes[q].t === 2) nodes[q].dead = true; }
    }
    pushText(']');
    return i + 1;
  }
  function scanCodeSpan(i, L) {
    let j = i + L;
    while (j < n) {
      if (text[j] === ']' && wouldFormLink(j)) return null;
      if (text[j] === '`') {
        let k = j;
        while (k < n && text[k] === '`') k++;
        if (k - j === L) {
          let content = text.slice(i + L, j).replace(/\n/g, ' ');
          if (content.length > 0 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^[ ]+$/.test(content)) {
            content = content.slice(1, -1);
          }
          return { content, end: k };
        }
        j = k;
      } else j++;
    }
    return null;
  }
  function consumeTextRun(i) {
    let j = i;
    while (j < n) {
      const c = text[j];
      if (c === '\n' || c === '\\' || c === '`' || c === '[' || c === ']' || c === '*' || c === '_' || c === '~' || c === '<' || c === '&' || c === '!') break;
      if (j > i) {
        if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'x' || c === 'm' || c === 'M') {
          if (matchBareUrl(text, j, -1)) break;
        }
        if (isLocalPartChar(c) && !isLocalPartChar(text[j - 1])) {
          if (matchBareEmail(text, j, underCloserAt)) break;
        }
      }
      j++;
    }
    return j;
  }
  function tryBareUrlAt(i) {
    const brk = bracketBrk(i);
    const u = matchBareUrl(text, i, brk);
    if (!u) return null;
    return u;
  }

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      if (last && last.t === 0 && !last.raw && / {2,}$/.test(last.s)) {
        last.s = last.s.replace(/ {2,}$/, '');
        nodes.push({ t: 7 });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      } else {
        nodes.push({ t: 8 });
        i++;
      }
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && text[i + 1] === '\n') {
        nodes.push({ t: 7 });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && /[!-/:-@\[-`{-~]/.test(text[i + 1])) {
        const ch = text[i + 1];
        if (ch === '&') pushRaw('&amp;');
        else pushText(ch);
        i += 2;
        continue;
      }
      pushText('\\');
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const L = j - i;
      const sp = scanCodeSpan(i, L);
      if (sp) { nodes.push({ t: 1, s: sp.content }); i = sp.end; continue; }
      pushText(text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      nodes.push({ t: 10 });
      openers.push({ ni: nodes.length - 1, img: true, active: true, src: i });
      i += 2;
      continue;
    }
    if (c === '[') {
      nodes.push({ t: 9 });
      openers.push({ ni: nodes.length - 1, img: false, active: true, src: i });
      i++;
      continue;
    }
    if (c === ']') { i = handleCloseBracket(i); continue; }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const len = j - i;
      const { leftFl, rightFl } = flanking(i, len);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFl && (!rightFl || isPunct(text[i - 1] || ''));
        canClose = rightFl && (!leftFl || isPunct(text[j] || ''));
      } else {
        canOpen = leftFl; canClose = rightFl;
      }
      pushDelim(c, len, canOpen, canClose, text[j] || '');
      i = j;
      continue;
    }
    if (c === '<') {
      // autolink?
      const gt = text.indexOf('>', i + 1);
      let done = false;
      if (gt !== -1) {
        const inner = text.slice(i + 1, gt);
        if (inner.length > 0 && !/[ <>\n]/.test(inner)) {
          // email?
          const em = matchBareEmail(inner, 0);
          if (em && em.end === inner.length) {
            const href = 'mailto:' + inner;
            nodes.push({ t: 3, href, title: null, auto: true });
            pushText(inner);
            nodes.push({ t: 4 });
            i = gt + 1; done = true;
          } else if (!inner.includes('@')) {
            const sm = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):/.exec(inner);
            if (sm) {
              nodes.push({ t: 3, href: inner, title: null, auto: true });
              pushText(inner);
              nodes.push({ t: 4 });
              i = gt + 1; done = true;
            }
          } else {
            // has @ but not a valid email: fall through to scheme check
            const sm = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):/.exec(inner);
            if (sm) {
              nodes.push({ t: 3, href: inner, title: null, auto: true });
              pushText(inner);
              nodes.push({ t: 4 });
              i = gt + 1; done = true;
            }
          }
        }
      }
      if (done) continue;
      const tag = matchHtmlTagAt(text, i);
      if (tag) {
        nodes.push({ t: 6, s: text.slice(i, i + tag.len) });
        if (tag.name === 'a') {
          if (tag.closing) state.inRawA = false;
          else {
            const afterName = text.slice(i + 2, i + tag.len);
            if (afterName !== '>' && afterName !== '/>') state.inRawA = true;
          }
        }
        i += tag.len;
        continue;
      }
      pushText('<');
      i++;
      continue;
    }
    if (c === '&') {
      const ent = matchEntity(text, i);
      if (ent) { pushRaw(escText(ent.text)); i += ent.len; continue; }
      pushText('&');
      i++;
      continue;
    }
    // bare URL / bare email
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'x' || c === 'm' || c === 'M') {
      if (!state.inRawA && !hasActiveOpener()) {
        const u = tryBareUrlAt(i);
        if (u) {
          const href = u.url.startsWith('www.') ? 'http://' + u.url : u.url;
          nodes.push({ t: 3, href, title: null, auto: true, bare: true });
          pushText(u.url);
          nodes.push({ t: 4 });
          i = u.end;
          continue;
        }
      }
    }
    if (isLocalPartChar(c) && (i === 0 || !isLocalPartChar(text[i - 1]))) {
      if (!state.inRawA && !hasActiveOpener()) {
        const e = matchBareEmail(text, i, underCloserAt);
        if (e) {
          nodes.push({ t: 3, href: 'mailto:' + e.url, title: null, auto: true, bare: true });
          pushText(e.url);
          nodes.push({ t: 4 });
          i = e.end;
          continue;
        }
      }
    }
    // plain text run
    const j = consumeTextRun(i);
    if (j > i) { pushText(text.slice(i, j)); i = j; continue; }
    pushText(c);
    i++;
  }
  resolveEmphasis(nodes, delims);
  return nodes;
}

// ---------- emphasis resolution ----------
function resolveEmphasis(nodes, delims) {
  const byId = new Map(delims.map(d => [d.id, d]));
  // assign linkIds
  let linkIdCounter = 0;
  const depthStack = [];
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    if (nd.t === 3) { linkIdCounter++; depthStack.push(linkIdCounter); }
    else if (nd.t === 4) { depthStack.pop(); }
    else if (nd.t === 2) { nd.linkId = depthStack.length ? depthStack[depthStack.length - 1] : 0; }
  }
  // poisoned-link suppression: up to the LAST code span in the block
  const suppressed = new Set();
  const openStack = [];
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    if (nd.t === 3) openStack.push(n);
    else if (nd.t === 4 && openStack.length) {
      const o = openStack.pop();
      let label = '';
      for (let q = o + 1; q < n; q++) { if (nodes[q].t === 0) label += nodes[q].s; }
      if (unpairedBacktickRuns(label) >= 2) {
        let lastCode = -1;
        for (let q = n + 1; q < nodes.length; q++) { if (nodes[q].t === 1) lastCode = q; }
        if (lastCode !== -1) {
          for (let q = n + 1; q < lastCode; q++) {
            const d = nodes[q];
            if (d.t === 2 && d.linkId === 0) suppressed.add(d);
          }
        }
      }
    }
  }
  const act = delims.filter(d => !d.dead && !suppressed.has(d) && d.len > 0);
  const prev = new Array(act.length).fill(-1);
  const next = new Array(act.length).fill(-1);
  for (let k = 0; k < act.length; k++) { prev[k] = k - 1; next[k] = k + 1 < act.length ? k + 1 : -1; }
  const posOf = new Map(act.map((d, k) => [d, k]));
  const formed = [];
  function unlink(k) {
    const p = prev[k], nx = next[k];
    if (p !== -1) next[p] = nx;
    if (nx !== -1) prev[nx] = p;
    prev[k] = next[k] = -2;
  }
  function insideFormed(opId) {
    for (const f of formed) { if (f[0] < opId && opId < f[1]) return true; }
    return false;
  }
  function kRuleCheck(op, cur, use0) {
    for (const fp of formed) {
      const oId = fp[0], cId = fp[1], fUse = fp[2];
      if (!(op.id < oId && cId < cur.id)) continue;
      const innerOp = byId.get(oId), innerCl = byId.get(cId);
      if (!innerOp || !innerCl) continue;
      if (innerOp.ch !== op.ch) continue;
      if (fUse === use0 && innerOp.orig === op.orig) continue;
      if (innerOp.canClose) continue;
      if (!/[\p{L}\p{N}]/u.test(innerCl.nextCh || '')) continue;
      if (use0 > fUse) {
        let cancelled = false;
        for (const d of act) {
          if (d.id > cId && d.id < cur.id && d.canClose && !d.canOpen) { cancelled = true; break; }
        }
        if (cancelled) continue;
      }
      if (cur.len <= 2) return { blocks: true, kInside: false };
      return { blocks: false, kInside: true };
    }
    return { blocks: false, kInside: false };
  }
  function nextCloserPos(fromK) {
    for (let k = fromK; k < act.length; k++) {
      if (prev[k] !== -2 && act[k].canClose && act[k].len > 0) return k;
    }
    return -1;
  }
  let curK = nextCloserPos(0);
  while (curK !== -1) {
    const cur = act[curK];
    let paired = false;
    let opK = prev[curK];
    while (opK !== -1) {
      const op = act[opK];
      if (op.ch === cur.ch && op.canOpen && op.len > 0 && op.linkId === cur.linkId && !insideFormed(op.id)) {
        const odd = ((op.canOpen && op.canClose) || (cur.canOpen && cur.canClose)) &&
          ((op.orig + cur.orig) % 3 === 0) && !((op.orig % 3 === 0) && (cur.orig % 3 === 0));
        if (odd) { opK = prev[opK]; continue; }
        if (cur.ch === '~' && (op.len !== cur.len || op.len > 2)) { opK = prev[opK]; continue; }
        let use0;
        if (cur.ch === '~') use0 = op.len;
        else use0 = (op.len >= 2 && cur.len >= 2) ? 2 : 1;
        if (cur.ch !== '~') {
          const kr = kRuleCheck(op, cur, use0);
          if (kr.blocks) { opK = prev[opK]; continue; }
          if (kr.kInside) cur.leftoverInside = true;
        }
        op.opens.push({ n: use0, ch: cur.ch });
        cur.closes.push({ n: use0, ch: cur.ch });
        op.len -= use0; cur.len -= use0;
        formed.push([op.id, cur.id, use0]);
        if (op.len === 0) unlink(opK);
        paired = true;
        break;
      }
      opK = prev[opK];
    }
    if (cur.len === 0) {
      const nx = next[curK];
      unlink(curK);
      curK = nextCloserPos(nx !== -1 ? nx : act.length);
    } else if (!paired) {
      curK = nextCloserPos(next[curK] !== -1 ? next[curK] : act.length);
    }
    // else paired with len left: retry same curK
  }
}
function plainTextOf(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0) out += nd.s;
    else if (nd.t === 1) out += nd.s;
    else if (nd.t === 2) out += nd.ch.repeat(Math.max(0, nd.len));
    else if (nd.t === 5) out += plainTextOf(nd.altNodes);
    else if (nd.t === 8) out += '\n';
    else if (nd.t === 9) out += '[';
    else if (nd.t === 10) out += '![';
  }
  return out;
}
function hrefOut(raw, plain) {
  const enc = encodeHref(raw);
  return plain ? escCode(enc) : escAttr(enc);
}
function openTag(o) {
  if (o.ch === '~') return '<del>';
  return o.n === 2 ? '<strong>' : '<em>';
}
function closeTag(o) {
  if (o.ch === '~') return '</del>';
  return o.n === 2 ? '</strong>' : '</em>';
}
function renderInline(nodes) {
  let out = '';
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    if (nd.t === 0) out += nd.raw ? nd.s : escText(nd.s);
    else if (nd.t === 1) out += '<code>' + escCode(nd.s) + '</code>';
    else if (nd.t === 2) {
      const leftover = Math.max(0, nd.len);
      if (leftover > 0 && nd.leftoverInside && nd.closes.length > 0 && nd.opens.length === 0) {
        out += nd.ch.repeat(leftover);
        for (const o of nd.closes) out += closeTag(o);
        for (let k = nd.opens.length - 1; k >= 0; k--) out += openTag(nd.opens[k]);
      } else {
        for (const o of nd.closes) out += closeTag(o);
        if (leftover > 0) out += nd.ch.repeat(leftover);
        for (let k = nd.opens.length - 1; k >= 0; k--) out += openTag(nd.opens[k]);
      }
    }
    else if (nd.t === 3) {
      out += '<a href="' + hrefOut(nd.href, !!(nd.bare || nd.auto)) + '"' +
        (nd.title != null ? ' title="' + escAttr(nd.title) + '"' : '') + '>';
    }
    else if (nd.t === 4) out += '</a>';
    else if (nd.t === 5) {
      out += '<img src="' + hrefOut(nd.src, false) + '" alt="' + escAttr(plainTextOf(nd.altNodes)) + '"' +
        (nd.title != null ? ' title="' + escAttr(nd.title) + '"' : '') + '>';
    }
    else if (nd.t === 6) out += nd.s;
    else if (nd.t === 7) out += '<br>';
    else if (nd.t === 8) out += '\n';
    else if (nd.t === 9) out += '[';
    else if (nd.t === 10) out += '![';
  }
  return out;
}

// ---------- block renderer ----------
function renderTable(node, refs, state) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < node.header.length; c++) {
    const al = node.aligns[c] ? ' align="' + node.aligns[c] + '"' : '';
    out += '<th' + al + '>' + renderInline(parseInline(node.header[c], refs, state)) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (node.rows.length > 0) {
    out += '<tbody>';
    for (const row of node.rows) {
      out += '<tr>\n';
      for (let c = 0; c < row.length; c++) {
        const al = node.aligns[c] ? ' align="' + node.aligns[c] + '"' : '';
        out += '<td' + al + '>' + renderInline(parseInline(row[c], refs, state)) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}
function renderBlock(node, refs, state) {
  switch (node.t) {
    case 'para':
      return '<p>' + renderInline(parseInline(node.text, refs, state)) + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + renderInline(parseInline(node.text, refs, state)) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'fence': {
      const body = node.lines.join('\n');
      const lang = node.lang ? ' class="language-' + escAttr(node.lang) + '"' : '';
      return '<pre><code' + lang + '>' + escCode(body) + (node.lines.length ? '\n' : '') + '</code></pre>\n';
    }
    case 'code': {
      const body = node.lines.join('\n');
      return '<pre><code>' + escCode(body) + (node.lines.length ? '\n' : '') + '</code></pre>\n';
    }
    case 'html': {
      const body = node.lines.join('\n');
      return body + (node.trailingNL ? '\n' : '');
    }
    case 'quote':
      return '<blockquote>\n' + renderBlocks(node.children, refs, state) + '</blockquote>\n';
    case 'list': {
      const tag = node.bullet ? 'ul' : 'ol';
      const start = (!node.bullet && node.start !== 1) ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of node.children) out += renderItem(item, node, refs, state);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'table':
      return renderTable(node, refs, state);
  }
  return '';
}
function renderItem(item, list, refs, state) {
  const listLoose = list.loose || list.children.some(it => it.loose);
  const useP = listLoose;
  const checkbox = item.task
    ? (item.task === 'x' ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">')
    : '';
  let out = '<li>';
  let cbPlaced = false;
  for (let k = 0; k < item.children.length; k++) {
    const child = item.children[k];
    if (child.t === 'para') {
      const inner = renderInline(parseInline(child.text, refs, state));
      if (useP) {
        out += '<p>' + (k === 0 && checkbox && !cbPlaced ? checkbox : '') + inner + '</p>\n';
        if (k === 0 && checkbox) cbPlaced = true;
      } else {
        if (k === 0 && checkbox && !cbPlaced) { out += checkbox; cbPlaced = true; }
        out += inner;
      }
    } else {
      if (k === 0 && checkbox && !cbPlaced) { out += checkbox; cbPlaced = true; }
      out += renderBlock(child, refs, state);
    }
  }
  if (checkbox && !cbPlaced) out += checkbox;
  out += '</li>\n';
  return out;
}
function renderBlocks(children, refs, state) {
  let out = '';
  for (const node of children) out += renderBlock(node, refs, state);
  return out;
}
export function parse(markdown) {
  const state = { inRawA: false };
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const endsWithNL = src.endsWith('\n');
  let lines = src.split('\n');
  if (endsWithNL) lines.pop();
  const { root, refs } = parseBlocks(lines, endsWithNL);
  return renderBlocks(root.children, refs, state);
}
