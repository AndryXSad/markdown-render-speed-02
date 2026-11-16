// A fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer written from
// scratch, matching the HTML that marked 18.1.3 produces with its default
// options (gfm on, breaks off, pedantic off, async off). It was built by
// reading the CommonMark and GFM specifications and by differential testing
// against marked's output on the spec examples; no marked code is used here.
//
// Design: a line-oriented block parser builds a small block tree (link
// reference definitions are collected first, then inline content is parsed),
// and a single-pass inline scanner produces tokens which an emphasis pass
// then resolves. Rendering writes straight into string arrays.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text the way marked does for normal text, titles, hrefs and fenced
// code info strings: &, <, >, " and ' are escaped, except that an & that
// starts something shaped like an entity reference (&name;, &#123;, &#x1f;)
// is left alone.
const ESC_NO_ENCODE_RE = /&(?!(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|\w+);)|[<>"']/g;
function escNoEncode(s) {
  return s.replace(ESC_NO_ENCODE_RE, (c) => ESC_MAP[c]);
}

// Escape code spans and code blocks: every one of &, <, >, " and ' is escaped.
const ESC_CODE_RE = /[&<>"']/g;
function escCode(s) {
  return s.replace(ESC_CODE_RE, (c) => ESC_MAP[c]);
}

// A link destination becomes an href by percent-encoding it (encodeURI) and
// then escaping it the way text is escaped.
function cleanHref(dest) {
  let u;
  try {
    u = encodeURI(dest);
  } catch (_e) {
    u = dest;
  }
  return escNoEncode(u);
}

function isDigit(c) { return c >= 48 && c <= 57; }
function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13; }
function isPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// Decode a numeric character reference at s[i] (s[i] === '&').
// Only numeric references are decoded; named entities are left untouched.
// Returns { ch, next } or null.
function decodeEntity(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null; // '#'
  let j = i + 2;
  let hex = false;
  const c = s.charCodeAt(j);
  if (c === 120 || c === 88) { hex = true; j++; } // x X
  const start = j;
  if (hex) {
    while (j < s.length && isHex(s.charCodeAt(j))) j++;
  } else {
    while (j < s.length && isDigit(s.charCodeAt(j))) j++;
  }
  const digits = j - start;
  if (digits === 0) return null;
  if (hex ? digits > 6 : digits > 7) return null;
  if (j >= s.length || s.charCodeAt(j) !== 59) return null; // ';'
  let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return { ch: String.fromCodePoint(cp), next: j + 1 };
}

// Normalize a link label: unescape backslash punctuation, collapse every
// run of whitespace (including newlines) to one space, trim, lowercase.
function normalizeLabel(raw) {
  // Labels are compared with backslash escapes PRESERVED (a label 'foo\!'
  // does not match a definition 'foo!'); only whitespace is collapsed,
  // and case is folded (with German sharp-s folding to 'ss').
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (out.length > 0 && out[out.length - 1] !== ' ') out += ' ';
    } else if (ch === '\u00df' || ch === '\u1e9e') {
      out += 'ss';
    } else {
      out += ch;
    }
  }
  if (out.length > 0 && out[out.length - 1] === ' ') out = out.slice(0, -1);
  return out.toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline parsing
// Node kinds: 0 text {s, force?}  1 code {s}  2 html {s}  3 br
//             4 link {href, title, ch}  5 image {src, alt, title}
//             6 autolink {href, text} (already escaped)  7 delim {c, n, open, close}
//             8 opener {img, active, pos}  9 em {ch}  10 strong {ch}  11 del {ch}

function skipWs(src, j) {
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13) j++;
    else break;
  }
  return j;
}

// Parse a link title starting at src[j] ('"' or "'" or '('). Returns
// { title, next } or null.
function parseTitle(src, j) {
  const q = src[j];
  const close = q === '(' ? ')' : q;
  let k = j + 1;
  let t = '';
  const n = src.length;
  while (k < n) {
    const c = src[k];
    if (c === '\\' && k + 1 < n && isPunctCode(src.charCodeAt(k + 1))) {
      t += src[k + 1];
      k += 2;
      continue;
    }
    if (c === close) return { title: t, next: k + 1 };
    if (q === '(' && c === '(') return null;
    t += c;
    k++;
  }
  return null;
}

// Parse an inline link "(...)" starting at src[i] === '('. Returns
// { href, title, next } or null.
function parseInlineLink(src, i) {
  const n = src.length;
  let j = skipWs(src, i + 1);
  if (j >= n) return null;
  let dest = '';
  if (src[j] === '<') {
    j++;
    while (j < n) {
      const c = src[j];
      if (c === '\n') return null;
      if (c === '\\' && j + 1 < n && isPunctCode(src.charCodeAt(j + 1))) {
        dest += src[j + 1];
        j += 2;
        continue;
      }
      if (c === '>') break;
      dest += c;
      j++;
    }
    if (j >= n) return null;
    j++;
  } else {
    let depth = 0;
    while (j < n) {
      const c = src[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      const cc = src.charCodeAt(j);
      if (cc < 32 || cc === 127) return null;
      if (c === '\\' && j + 1 < n && isPunctCode(src.charCodeAt(j + 1))) {
        dest += src[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') { depth++; dest += c; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        dest += c;
        j++;
        continue;
      }
      dest += c;
      j++;
    }
  }
  j = skipWs(src, j);
  let title = null;
  if (j < n && (src[j] === '"' || src[j] === "'" || src[j] === '(')) {
    const t = parseTitle(src, j);
    if (!t) return null;
    title = t.title;
    j = skipWs(src, t.next);
  }
  if (j >= n || src[j] !== ')') return null;
  return { href: dest, title, next: j + 1 };
}

// Parse a reference label "[...]" starting at src[j] === '['. An unescaped
// '[' inside the label makes it invalid (no nested labels). Escaped
// characters are kept verbatim. Returns { label, next } (label raw, not
// normalized) or null.
function parseRefLabel(src, j) {
  const n = src.length;
  let k = j + 1;
  let label = '';
  while (k < n) {
    const c = src[k];
    if (c === '\\' && k + 1 < n && isPunctCode(src.charCodeAt(k + 1))) {
      label += src[k];
      label += src[k + 1];
      k += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') return { label, next: k + 1 };
    label += c;
    k++;
  }
  return null;
}

const URL_TRAILING_PUNCT = new Set([63, 33, 46, 44, 58, 59, 42, 95, 126]); // ? ! . , : ; * _ ~

// Match an extended autolink (www. / http(s):// / ftp://) at src[i].
// hasOpener: whether an active link opener is open (a ']' that could close
// it, when followed by '(' or '[', ends the URL instead of joining it).
// Returns { end } or null; the URL text is src.slice(i, end).
// Match an extended autolink starting at src[i]: "www." or a scheme URL
// (http/https/ftp). hasOpener is a lazy () => bool consulted only when a ']'
// is met during the scan. Returns { end } or null.
function matchExtUrl(src, i, hasOpener) {
  const n = src.length;
  let start;
  if (src.startsWith('www.', i)) {
    const a = src.charCodeAt(i + 4);
    if (a === 46 || a === 32 || a === 9 || a === 10 || a === 13 || a === 60 || a === undefined) return null;
    start = i + 4;
  } else {
    const sl = schemePrefixLen(src, i);
    if (sl === 0) return null;
    const a = src.charCodeAt(i + sl);
    if (a === undefined || !isAlnum(a)) return null;
    start = i + sl;
  }
  let j = start;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break; // ws or '<'
    if (c === 93) { // ']'
      // Ends the URL only when an active link opener exists and the next
      // char is '(' or '['; otherwise ']' is a normal URL character.
      if (hasOpener() && (src.charCodeAt(j + 1) === 40 || src.charCodeAt(j + 1) === 91)) break;
    }
    j++;
  }
  if (j === start) return null;
  let t = j;
  // Trailing entity-like "&name;" is dropped whole; numeric "&#65;" loses
  // only its ';'.
  const amp = src.lastIndexOf('&', t - 1);
  if (amp >= i && amp + 1 < t && src[t - 1] === ';') {
    const ent = src.slice(amp + 1, t - 1);
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(ent)) t = amp;
    else if (/^#[0-9]+$/.test(ent) || /^#[Xx][0-9A-Fa-f]+$/.test(ent)) t = t - 1;
  }
  // Trim trailing punctuation.
  while (t > start && URL_TRAILING_PUNCT.has(src.charCodeAt(t - 1))) t--;
  // Truncate at the first unclosed '(' (an opening paren with no matching
  // ')'); a ')' that is not trailing is kept.
  const s = src.slice(start, t);
  const openStack = [];
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '(') openStack.push(k);
    else if (s[k] === ')') {
      if (openStack.length > 0) openStack.pop();
    }
  }
  if (openStack.length > 0) t = start + openStack[0];
  else {
    let open2 = 0, close2 = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '(') open2++;
      else if (s[k] === ')') close2++;
    }
    while (close2 > open2 && t > start && src.charCodeAt(t - 1) === 41) { t--; close2--; }
  }
  if (t <= start) return null;
  return { end: t };
}

const EMAIL_LOCAL = new Set();
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-") EMAIL_LOCAL.add(ch.charCodeAt(0));

function isDomainChar(c) { return isAlnum(c) || c === 45; } // alnum or '-'

// Match an email autolink whose '@' is at src[at]. txt is the current text
// run (its last character is the one just before '@' in src). Returns
// { start, end } (absolute indices into src) or null; start is the local
// part's start, or the start of a lowercase "mailto:" prefix just before it.
function matchEmail(src, at, txt) {
  const n = src.length;
  // Domain: labels of [A-Za-z0-9-]+ separated by '.', at least two labels.
  let j = at + 1;
  let labels = 0;
  let end = -1;
  while (j < n) {
    const ls = j;
    while (j < n && isDomainChar(src.charCodeAt(j))) j++;
    if (j === ls) break;
    labels++;
    end = j;
    if (j < n && src.charCodeAt(j) === 46) { j++; continue; } // '.'
    break;
  }
  if (labels < 2 || end === -1) return null;
  // The last domain label must not end with '-', and the char right after
  // the domain must not be '_' (both invalidate the autolink).
  if (src[end - 1] === '-') return null;
  if (end < n && src[end] === '_') return null;
  // Local part: scan back inside the current text run.
  let s = txt.length;
  while (s > 0 && EMAIL_LOCAL.has(txt.charCodeAt(s - 1))) s--;
  if (s === txt.length) return null; // empty local part
  const local = txt.slice(s);
  // The local part must sit verbatim in the source just before '@' (it does
  // not when a decoded entity is inside it; then there is no autolink).
  if (at - local.length < 0 || src.slice(at - local.length, at) !== local) return null;
  let start = at - local.length;
  // Optional lowercase "mailto:" prefix immediately before the local part.
  let hasMailto = false;
  if (start >= 7 && src.slice(start - 7, start) === 'mailto:') { start -= 7; hasMailto = true; }
  // Optional lowercase "xmpp:" prefix: the link then also takes one
  // trailing '/resource' segment of alphanumerics.
  let hasXmpp = false;
  if (!hasMailto && start >= 5 && src.slice(start - 5, start) === 'xmpp:') {
    start -= 5; hasXmpp = true;
    // One trailing '/resource' segment: alphanumerics, '.' and '@'
    // (e.g. '/txt', '/txt@bin.com'); '-' '_' '/' end it.
    if (end < n && src[end] === '/') {
      let p = end + 1;
      while (p < n) {
        const cc = src.charCodeAt(p);
        if (isAlnum(cc) || cc === 46 || cc === 64) p++;
        else break;
      }
      // Trim trailing '.'/'@' from the resource.
      while (p > end + 1 && (src[p - 1] === '.' || src[p - 1] === '@')) p--;
      if (p > end + 1 && isAlnum(src.charCodeAt(end + 1))) end = p;
    }
  }
  return { start, end, s, hasMailto, hasXmpp };
}

// Match an inline HTML tag at src[i] === '<' (comment, PI, declaration,
// CDATA, or an open/close tag with attributes). Returns { end } or null.
function matchHtmlTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    // '<!-->' and '<!--->' are complete (empty) comments by themselves.
    if (src.startsWith('<!-->', i)) return { end: i + 5 };
    if (src.startsWith('<!--->', i)) return { end: i + 6 };
    const e = src.indexOf('-->', i + 4);
    if (e === -1) return null;
    return { end: e + 3 };
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    if (e === -1) return null;
    return { end: e + 2 };
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    if (e === -1) return null;
    return { end: e + 3 };
  }
  if (src.startsWith('<!', i)) {
    if (i + 2 >= n || !isAlpha(src.charCodeAt(i + 2))) return null;
    let j = i + 2;
    while (j < n && src[j] !== '>') j++;
    if (j >= n) return null;
    return { end: j + 1 };
  }
  let j = i + 1;
  const isClose = src[j] === '/';
  if (isClose) j++;
  if (j >= n || !isAlpha(src.charCodeAt(j))) return null;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnum(c) || c === 45) j++;
    else break;
  }
  for (;;) {
    let k = j;
    let sawSpace = false;
    while (k < n && isSpace(src.charCodeAt(k))) { k++; sawSpace = true; }
    if (k >= n) return null;
    const c = src.charCodeAt(k);
    if (c === 62) return { end: k + 1 }; // '>'
    // A closing tag takes no attributes and no '/>'.
    if (isClose) return null;
    if (c === 47) { // '/'
      if (k + 1 < n && src.charCodeAt(k + 1) === 62) return { end: k + 2 };
      return null;
    }
    // An attribute must be preceded by whitespace.
    if (!sawSpace) return null;
    if (!isAlpha(c) && c !== 95 && c !== 58) return null; // attr name start
    j = k;
    while (j < n) {
      const cc = src.charCodeAt(j);
      if (isAlnum(cc) || cc === 95 || cc === 58 || cc === 46 || cc === 45) j++;
      else break;
    }
    const nameEnd = j;
    k = j;
    while (k < n && isSpace(src.charCodeAt(k))) k++;
    if (k < n && src.charCodeAt(k) === 61) { // '='
      k++;
      while (k < n && isSpace(src.charCodeAt(k))) k++;
      if (k >= n) return null;
      const q = src.charCodeAt(k);
      if (q === 34 || q === 39) {
        const quote = src[k];
        k++;
        // A quoted attribute value may span lines.
        while (k < n && src[k] !== quote) k++;
        if (k >= n || src[k] !== quote) return null;
        j = k + 1;
      } else {
        const vs = k;
        while (k < n) {
          const cc = src.charCodeAt(k);
          if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 34 || cc === 39 || cc === 61 || cc === 60 || cc === 62 || cc === 96) break;
          k++;
        }
        if (k === vs) return null; // empty unquoted value
        j = k;
      }
    } else {
      // A valueless attribute: rewind to just after its name so the next
      // loop iteration sees the whitespace before the next attribute.
      j = nameEnd;
    }
  }
}

// Match an angle-bracket autolink <...> at src[i] === '<'.
// Returns { end, href, text, raw } or null.
function matchAngleAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 62) break; // '>'
    if (c === 60 || c <= 32 || c === 127) return null; // '<', space, control
    j++;
  }
  if (j >= n) return null;
  const content = src.slice(i + 1, j);
  if (content.length === 0) return null;
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  const colon = content.indexOf(':');
  if (colon >= 2 && colon <= 32 && isAlpha(content.charCodeAt(0))) {
    let ok = true;
    for (let k = 1; k < colon; k++) {
      const c = content.charCodeAt(k);
      if (!isAlnum(c) && c !== 43 && c !== 46 && c !== 45) { ok = false; break; }
    }
    if (ok) {
      return { end: j + 1, href: escCode(encodeURI(content)), text: escCode(content), raw: content };
    }
  }
  // Email: local@domain with at least one dot in the domain.
  const at = content.indexOf('@');
  if (at > 0) {
    let ok = true;
    for (let k = 0; k < at; k++) {
      if (!EMAIL_LOCAL.has(content.charCodeAt(k))) { ok = false; break; }
    }
    if (ok) {
      const dom = content.slice(at + 1);
      const parts = dom.split('.');
      if (parts.length >= 2 && parts.every((p) => p.length > 0 && /^[A-Za-z0-9-]+$/.test(p))) {
        return { end: j + 1, href: escCode(encodeURI('mailto:' + content)), text: escCode(content), raw: content };
      }
    }
  }
  return null;
}

function ciStarts(src, i, lower) {
  for (let k = 0; k < lower.length; k++) {
    const c = src.charCodeAt(i + k);
    if (c !== lower.charCodeAt(k) && c !== lower.charCodeAt(k) - 32) return false;
  }
  return true;
}

// Length of the scheme:// prefix at src[i] (0 if none). Schemes are
// case-insensitive: http, https, ftp.
function schemePrefixLen(src, i) {
  const c0 = src.charCodeAt(i);
  if (c0 === 104 || c0 === 72) {
    if (ciStarts(src, i + 1, 'ttp://')) return 7;
    if (ciStarts(src, i + 1, 'ttps://')) return 8;
  } else if (c0 === 102 || c0 === 70) {
    if (ciStarts(src, i + 1, 'tp://')) return 6;
  }
  return 0;
}

// ---- emphasis resolution ----

// Resolve * / _ / ~ delimiters in a node list. Mutates delimiter counts;
// returns a new list with <em>/<strong>/<del> elements (k:9).
function resolveEmphasis(nodes) {
  const items = nodes.slice();
  const stack = []; // opener delimiter nodes (references), in document order
  let i = 0;
  while (i < items.length) {
    const node = items[i];
    if (node.k !== 7) { i++; continue; }
    if (node.open) stack.push(node);
    if (node.close) {
      let nextI = i + 1;
      while (node.n > 0) {
        let si = -1;
        for (let q = stack.length - 1; q >= 0; q--) {
          const op = stack[q];
          if (op === node) continue; // a delimiter cannot pair with itself
          if (op.n === 0) continue;
          if (op.c !== node.c) continue;
          if (op.c === '_' && op.n % 3 === 0 && node.n % 3 === 0) continue;
          si = q; break;
        }
        if (si === -1) break;
        const op = stack[si];
        const use = Math.min(op.n, node.n, 2);
        const tag = op.c === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const oi = items.indexOf(op);
        const ci = items.indexOf(node);
        const el = { k: 9, tag, ch: items.slice(oi + 1, ci) };
        op.n -= use;
        node.n -= use;
        const repl = [];
        if (op.n > 0) repl.push(op);
        repl.push(el);
        if (node.n > 0) repl.push(node);
        items.splice(oi, ci - oi + 1, ...repl);
        // Pop the opener and everything after it (openers inside the new
        // element can no longer match at this level).
        stack.length = si;
        if (op.n > 0) stack.push(op);
        if (node.n > 0 && node.open) stack.push(node);
        nextI = oi + repl.length;
      }
      i = nextI;
      continue;
    }
    i++;
  }
  return items;
}

// Convert extended autolinks inside a link's text back to plain text
// (recursively, so emphasis around them is kept).
function stripExtAutolinks(nodes) {
  for (let q = 0; q < nodes.length; q++) {
    const node = nodes[q];
    if (node.k === 6 && node.ext) nodes[q] = { k: 0, s: node.raw };
    else if (node.k === 9 || node.k === 4) stripExtAutolinks(node.ch);
  }
}

function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.k === 0 || node.k === 1) out += node.s;
    else if (node.k === 4 || node.k === 9) out += plainText(node.ch);
    else if (node.k === 5) out += node.alt;
    else if (node.k === 6) out += node.raw;
    else if (node.k === 7) out += node.c.repeat(node.n);
    else if (node.k === 8) out += node.img ? '![' : '[';
  }
  return out;
}

function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.k === 0) out += node.esc ? ESC_MAP[node.s] : escNoEncode(node.s);
    else if (node.k === 1) out += '<code>' + escCode(node.s) + '</code>';
    else if (node.k === 2) out += node.s;
    else if (node.k === 3) out += '<br>';
    else if (node.k === 4) {
      out += '<a href="' + node.href + '"';
      if (node.title !== null) out += ' title="' + node.title + '"';
      out += '>' + renderInline(node.ch) + '</a>';
    } else if (node.k === 5) {
      out += '<img src="' + node.src + '" alt="' + node.alt + '"';
      if (node.title !== null) out += ' title="' + node.title + '"';
      out += '>';
    } else if (node.k === 6) out += '<a href="' + node.href + '">' + node.text + '</a>';
    else if (node.k === 7) out += node.c.repeat(node.n);
    else if (node.k === 8) out += node.img ? '![' : '[';
    else if (node.k === 9) out += '<' + node.tag + '>' + renderInline(node.ch) + '</' + node.tag + '>';
  }
  return out;
}

function safeEncodeURI(s) {
  try {
    // encodeURI encodes '%', but a '%' is never encoded in a link
    // destination (an existing '%20' stays, and a bare '%' stays too).
    return encodeURI(s).replace(/%25/g, '%');
  } catch (e) { return s; }
}

// Try to form a link/image for the ']' at src[closerPos] whose opener is op.
// Returns { href, title, next } or null.
function tryLinkTarget(src, closerPos, op, refs) {
  const n = src.length;
  const j = closerPos + 1;
  const textStart = op.pos + (op.img ? 2 : 1);
  if (j < n && src[j] === '(') {
    const t = parseInlineLink(src, j);
    if (t) return { href: escNoEncode(safeEncodeURI(t.href)), title: t.title === null ? null : escNoEncode(t.title), next: t.next };
    // A failed inline link falls back to a shortcut reference: '[foo]'
    // may still link if a def exists, leaving '(...)' as plain text.
  }
  if (j < n && src[j] === '[') {
    const lab = parseRefLabel(src, j);
    if (!lab) return null;
    if (lab.label.length === 0) {
      // Collapsed reference: the label is the link text itself.
      const def = refs.get(normalizeLabel(src.slice(textStart, closerPos)));
      if (def) return { href: def.href, title: def.title, next: lab.next };
      return null;
    }
    const def = refs.get(normalizeLabel(lab.label));
    if (def) return { href: def.href, title: def.title, next: lab.next };
    return null;
  }
  // Shortcut reference.
  const def = refs.get(normalizeLabel(src.slice(textStart, closerPos)));
  if (def) return { href: def.href, title: def.title, next: closerPos + 1 };
  return null;
}

function isWhitespaceChar(ch) {
  if (ch === '') return false;
  return /\s/.test(ch);
}

const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return isPunctCode(c);
  return UNICODE_PUNCT.test(ch);
}

// Parse the inline content of a block (a paragraph, heading, table cell,
// ...) into HTML. refs maps normalized link labels to { href, title }.
function parseInline(src, refs) {
  const nodes = [];
  const openers = [];
  let txt = '';
  const n = src.length;
  let i = 0;
  const flush = () => { if (txt.length > 0) { nodes.push({ k: 0, s: txt }); txt = ''; } };
  const hasActiveOpener = () => {
    for (let q = openers.length - 1; q >= 0; q--) if (openers[q].active) return true;
    return false;
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      // Backslash + newline is a hard break; leading spaces/tabs of the
      // next line are stripped.
      if (i + 1 < n && src.charCodeAt(i + 1) === 10) {
        flush(); nodes.push({ k: 3, backslash: true }); i += 2;
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (i + 1 < n && isPunctCode(src.charCodeAt(i + 1))) {
        const ch = src[i + 1];
        if (ch === '&' || ch === '<' || ch === '>' || ch === '"' || ch === "'") {
          flush(); nodes.push({ k: 0, s: ch, esc: true });
        } else {
          txt += ch;
        }
        i += 2; continue;
      }
      txt += '\\'; i++; continue;
    }
    if (c === 96) { // backtick: code span
      let j = i; while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        const nb = src.indexOf('`', k);
        if (nb === -1) break;
        let m = nb; while (m < n && src.charCodeAt(m) === 96) m++;
        if (m - nb === run) { found = nb; break; }
        k = m;
      }
      if (found === -1) { txt += src.slice(i, j); i = j; continue; }
      let content = src.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^[ \t]+$/.test(content)) content = content.slice(1, -1);
      flush(); nodes.push({ k: 1, s: content }); i = found + run; continue;
    }
    if (c === 33 && src.charCodeAt(i + 1) === 91) { // '!['
      flush();
      const node = { k: 8, img: true, active: true, pos: i, idx: nodes.length };
      nodes.push(node); openers.push(node); i += 2; continue;
    }
    if (c === 91) { // '['
      flush();
      const node = { k: 8, img: false, active: true, pos: i, idx: nodes.length };
      nodes.push(node); openers.push(node); i++; continue;
    }
    if (c === 93) { // ']'
      flush();
      let oi = -1;
      for (let q = openers.length - 1; q >= 0; q--) { if (openers[q].active) { oi = q; break; } }
      if (oi === -1) { txt += ']'; i++; continue; }
      const op = openers[oi];
      const target = tryLinkTarget(src, i, op, refs);
      if (!target) { op.active = false; txt += ']'; i++; continue; }
      const children = resolveEmphasis(nodes.slice(op.idx + 1));
      stripExtAutolinks(children);
      nodes.length = op.idx;
      if (op.img) {
        nodes.push({ k: 5, src: target.href, alt: escNoEncode(plainText(children)), title: target.title });
      } else {
        nodes.push({ k: 4, href: target.href, title: target.title, ch: children });
        for (const o of openers) if (!o.img && o.active) o.active = false;
      }
      openers.length = oi;
      i = target.next;
      continue;
    }
    if (c === 42 || c === 95) { // '*' or '_'
      let j = i; while (j < n && src.charCodeAt(j) === c) j++;
      const run = j - i;
      const prev = i > 0 ? src[i - 1] : '';
      const next = j < n ? src[j] : '';
      const leftFlanking = next !== '' && !isWhitespaceChar(next) && (!isPunctChar(next) || prev === '' || isWhitespaceChar(prev) || isPunctChar(prev));
      const rightFlanking = prev !== '' && !isWhitespaceChar(prev) && (!isPunctChar(prev) || next === '' || isWhitespaceChar(next) || isPunctChar(next));
      let open, close;
      if (c === 42) { open = leftFlanking; close = rightFlanking; }
      else { open = leftFlanking && (!rightFlanking || isPunctChar(prev)); close = rightFlanking && (!leftFlanking || isPunctChar(next)); }
      // A run that can neither open nor close is literal text (this keeps
      // an intraword '_' inside an email local part in the text run).
      if (!open && !close) { txt += src.slice(i, j); i = j; continue; }
      flush(); nodes.push({ k: 7, c: c === 42 ? '*' : '_', n: run, open, close }); i = j; continue;
    }
    if (c === 126) { // '~'
      let j = i; while (j < n && src.charCodeAt(j) === 126) j++;
      const run = j - i;
      if (run > 2) { txt += src.slice(i, j); i = j; continue; }
      const prev = i > 0 ? src[i - 1] : '';
      const next = j < n ? src[j] : '';
      const leftFlanking = next !== '' && !isWhitespaceChar(next) && (!isPunctChar(next) || prev === '' || isWhitespaceChar(prev) || isPunctChar(prev));
      const rightFlanking = prev !== '' && !isWhitespaceChar(prev) && (!isPunctChar(prev) || next === '' || isWhitespaceChar(next) || isPunctChar(next));
      if (!leftFlanking && !rightFlanking) { txt += src.slice(i, j); i = j; continue; }
      flush(); nodes.push({ k: 7, c: '~', n: run, open: leftFlanking, close: rightFlanking }); i = j; continue;
    }
    if (c === 60) { // '<'
      const au = matchAngleAutolink(src, i);
      if (au) { flush(); nodes.push({ k: 6, href: au.href, text: au.text, ext: false, raw: au.raw }); i = au.end; continue; }
      const tag = matchHtmlTag(src, i);
      if (tag) { flush(); nodes.push({ k: 2, s: src.slice(i, tag.end) }); i = tag.end; continue; }
      txt += '<'; i++; continue;
    }
    if (c === 38) { // '&'
      const e = decodeEntity(src, i);
      if (e) {
        const ch = e.ch;
        if (ch === '&' || ch === '<' || ch === '>' || ch === '"' || ch === "'") {
          flush(); nodes.push({ k: 0, s: ch, esc: true });
        } else {
          txt += ch;
        }
        i = e.next; continue;
      }
      txt += '&'; i++; continue;
    }
    if (c === 10) { // newline: soft or hard break
      let sp = 0;
      while (sp < txt.length && txt.charCodeAt(txt.length - 1 - sp) === 32) sp++;
      if (sp >= 2) {
        txt = txt.slice(0, txt.length - sp); flush(); nodes.push({ k: 3 }); i++;
        // A hard break strips the next line's leading spaces/tabs.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      }
      txt += '\n'; i++; continue;
    }
    if (c === 119) { // 'w': www. autolink (lowercase only)
      if (src.startsWith('www.', i)) {
        const prev = i > 0 ? src.charCodeAt(i - 1) : -1;
        if (prev === -1 || prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 40 || prev === 42 || prev === 126 || prev === 95) {
          const m = matchExtUrl(src, i, hasActiveOpener);
          if (m) {
            const raw = src.slice(i, m.end);
            flush(); nodes.push({ k: 6, href: escCode(safeEncodeURI('http://' + raw)), text: escCode(raw), ext: true, raw }); i = m.end; continue;
          }
        }
      }
      txt += 'w'; i++; continue;
    }
    if (c === 104 || c === 72 || c === 102 || c === 70) { // h H f F: scheme autolink
      const m = matchExtUrl(src, i, hasActiveOpener);
      if (m) {
        const raw = src.slice(i, m.end);
        flush(); nodes.push({ k: 6, href: escCode(safeEncodeURI(raw)), text: escCode(raw), ext: true, raw }); i = m.end; continue;
      }
      txt += src[i]; i++; continue;
    }
    if (c === 64) { // '@': email autolink
      const em = matchEmail(src, i, txt);
      if (em) {
        const raw = src.slice(em.start, em.end);
        const emailPart = em.hasMailto ? raw.slice(7) : raw;
        const prefixLen = em.hasMailto ? 7 : (em.hasXmpp ? 5 : 0);
        const cutAt = em.s - prefixLen;
        if (cutAt >= 0) {
          const keep = txt.slice(0, cutAt);
          if (keep.length > 0) nodes.push({ k: 0, s: keep });
          txt = '';
          const href = em.hasXmpp ? safeEncodeURI(raw) : safeEncodeURI('mailto:' + emailPart);
          nodes.push({ k: 6, href: escCode(href), text: escCode(raw), ext: true, raw });
          i = em.end; continue;
        }
      }
      txt += '@'; i++; continue;
    }
    txt += src[i]; i++;
  }
  flush();
  return renderInline(resolveEmphasis(nodes));
}

// ---- block parser: line cursor (tab-aware) ----

// A cursor into one line: { s, pos, col, tab }.
// tab > 0 means the tab at s[pos] was partially consumed and `tab` columns
// of it remain; the cursor is still positioned at that tab character.
function curAt(line) { return { s: line, pos: 0, col: 0, tab: 0 }; }
function curCopy(c) { return { s: c.s, pos: c.pos, col: c.col, tab: c.tab }; }
function curPeek(c) {
  if (c.tab > 0) return '\t';
  return c.pos < c.s.length ? c.s[c.pos] : '';
}
// Advance by up to `cols` columns of whitespace; returns columns advanced.
function curAdvance(c, cols) {
  let adv = 0;
  while (adv < cols) {
    if (c.tab > 0) {
      const take = Math.min(c.tab, cols - adv);
      c.tab -= take; c.col += take; adv += take;
      if (c.tab === 0) c.pos++;
    } else {
      const ch = c.s[c.pos];
      if (ch === ' ') { c.pos++; c.col++; adv++; }
      else if (ch === '\t') {
        const w = 4 - (c.col % 4);
        const take = Math.min(w, cols - adv);
        if (take === w) { c.pos++; c.col += w; adv += w; }
        else { c.tab = w - take; c.col += take; adv += take; }
      } else break;
    }
  }
  return adv;
}
// Number of whitespace columns available from the cursor.
function curIndent(c) {
  let cols = 0, pos = c.pos, col = c.col, tab = c.tab;
  for (;;) {
    if (tab > 0) { cols += tab; col += tab; pos++; tab = 0; }
    else {
      const ch = c.s[pos];
      if (ch === ' ') { cols++; col++; pos++; }
      else if (ch === '\t') { const w = 4 - (col % 4); cols += w; col += w; pos++; }
      else break;
    }
  }
  return cols;
}
// The rest of the line from the cursor, with a partially consumed tab
// materialized as spaces.
function curRest(c) {
  if (c.tab > 0) return ' '.repeat(c.tab) + c.s.slice(c.pos + 1);
  return c.s.slice(c.pos);
}
function isBlankLine(line) { return /^[ \t]*$/.test(line); }

// ---- leaf-start detectors (cursor is at the content start) ----

// ATX heading: returns { level, text } or null. text is the raw inline
// source (closing sequence stripped).
function tryATX(c) {
  const save = curCopy(c);
  curAdvance(c, 3);
  // If the line had more than 3 cols of indent, the next char is still
  // whitespace -> not an ATX heading.
  if (curPeek(c) === ' ' || curPeek(c) === '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  let level = 0;
  while (curPeek(c) === '#') { level++; c.pos++; c.col++; }
  if (level === 0 || level > 6) { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  const nx = curPeek(c);
  if (nx !== '' && nx !== ' ' && nx !== '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  // Skip one run of spaces/tabs, then strip a closing sequence of #'s
  // preceded by a space.
  let rest = curRest(c).replace(/^[ \t]+/, '');
  rest = rest.replace(/[ \t]+$/, '');
  if (/^#+$/.test(rest)) rest = '';
  else {
    const m = rest.match(/^(.*?)[ \t]+#+$/);
    if (m) rest = m[1].replace(/[ \t]+$/, '');
  }
  return { level, text: rest };
}

// Fenced code: returns { char, len, info } or null.
function tryFence(c) {
  const save = curCopy(c);
  curAdvance(c, 3);
  if (curPeek(c) === ' ' || curPeek(c) === '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  const ch = curPeek(c);
  if (ch !== '`' && ch !== '~') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  let len = 0;
  while (curPeek(c) === ch) { len++; c.pos++; c.col++; }
  if (len < 3) { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  const rest = curRest(c);
  if (ch === '`' && rest.indexOf('`') !== -1) { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  let info = rest.replace(/^[ \t]+/, '').split(/[ \t]/)[0] || '';
  // Backslash escapes in the info string are processed.
  info = info.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  return { char: ch, len, info };
}

// Thematic break: returns true or null.
function tryHr(c) {
  const save = curCopy(c);
  curAdvance(c, 3);
  if (curPeek(c) === ' ' || curPeek(c) === '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  const ch = curPeek(c);
  if (ch !== '-' && ch !== '_' && ch !== '*') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  let count = 0;
  for (;;) {
    const p = curPeek(c);
    if (p === ch) { count++; c.pos++; c.col++; }
    else if (p === ' ' || p === '\t') { curAdvance(c, 1); }
    else if (p === '') break;
    else { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  }
  if (count < 3) { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  return true;
}

// HTML block start: returns { type, endTag, interrupts } or null.
// interrupts is false for a "lone tag" block (a line that is only a single
// HTML tag of a non-block tag); such a block starts when no paragraph is
// open but never interrupts one.
function tryHtmlBlock(c) {
  const save = curCopy(c);
  curAdvance(c, 3);
  if (curPeek(c) === ' ' || curPeek(c) === '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  const rest = curRest(c);
  if (rest[0] !== '<') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  if (rest.startsWith('<!--')) return { type: 2, endTag: '-->', interrupts: true };
  if (rest.startsWith('<?')) return { type: 3, endTag: '?>', interrupts: true };
  if (rest.startsWith('<![CDATA[')) return { type: 5, endTag: ']]>', interrupts: true };
  if (/^<!doctype/i.test(rest)) return { type: 6, endTag: null, interrupts: true };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4, endTag: '>', interrupts: true };
  const m = rest.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/);
  if (!m) { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  const tag = m[1].toLowerCase();
  const after = rest[m[0].length];
  if ((tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') &&
      (after === undefined || after === ' ' || after === '\t' || after === '>')) {
    return { type: 1, endTag: '</' + tag + '>', interrupts: true };
  }
  // Type 7: a block-level tag. The tag need not be complete on this line
  // (it may span lines, e.g. <div id="foo"\n  class="bar">); it is enough
  // that the tag name is a block tag and the char after the name is
  // whitespace, '>', '/', or EOL.
  if (BLOCK_TAGS.has(tag) && (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/')) {
    return { type: 7, endTag: null, interrupts: true };
  }
  // Lone tag: the line is only a single complete HTML tag (any tag name)
  // followed by whitespace.
  const tg = matchHtmlTag(rest, 0);
  if (tg) {
    const afterTag = rest.slice(tg.end);
    if (/^[ \t]*$/.test(afterTag)) return { type: 7, endTag: null, interrupts: false };
  }
  c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null;
}

// Block-level HTML tags (type 7). Note: marked's list is the CommonMark
// list minus 'p' (a <p> tag alone is a lone tag, not a block tag).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Blockquote marker: returns true if the line (after up to 3 spaces) starts
// with '>'. Does not advance the cursor.
function tryQuote(c) {
  const save = curCopy(c);
  curAdvance(c, 3);
  const ok = curPeek(c) === '>';
  c.pos = save.pos; c.col = save.col; c.tab = save.tab;
  return ok;
}

// List item marker: returns { ordered, start, delim, markerLen } or null.
function tryListMarker(c) {
  const save = curCopy(c);
  curAdvance(c, 3);
  if (curPeek(c) === ' ' || curPeek(c) === '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  const ch = curPeek(c);
  let ordered = false, start = 1, delim = '', markerLen = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    delim = ch; markerLen = 1; c.pos++; c.col++;
  } else if (ch >= '0' && ch <= '9') {
    let j = c.pos;
    while (j < c.s.length && c.s[j] >= '0' && c.s[j] <= '9' && j - c.pos < 9) j++;
    const digits = c.s.slice(c.pos, j);
    const d = c.s[j];
    if (d !== '.' && d !== ')') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
    ordered = true; delim = d; start = parseInt(digits, 10) || 0; markerLen = digits.length + 1;
    c.pos = j + 1; c.col += markerLen;
  } else {
    c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null;
  }
  // The marker must be followed by a space, tab, or end of line.
  const nx = curPeek(c);
  if (nx !== '' && nx !== ' ' && nx !== '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return null; }
  // An item is empty when only spaces/tabs follow the marker to EOL.
  let empty = true;
  if (nx !== '') {
    const c2 = curCopy(c);
    while (curPeek(c2) === ' ' || curPeek(c2) === '\t') curAdvance(c2, 1);
    empty = curPeek(c2) === '';
  }
  return { ordered, start, delim, markerLen, empty };
}

// Setext underline: returns 1 (===) or 2 (---) or 0. Cursor at content.
function trySetext(c) {
  const save = curCopy(c);
  curAdvance(c, 3);
  if (curPeek(c) === ' ' || curPeek(c) === '\t') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return 0; }
  const ch = curPeek(c);
  if (ch !== '=' && ch !== '-') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return 0; }
  let count = 0;
  while (curPeek(c) === ch) { count++; c.pos++; c.col++; }
  // Only spaces/tabs may follow the run.
  while (curPeek(c) === ' ' || curPeek(c) === '\t') { curAdvance(c, 1); }
  if (curPeek(c) !== '') { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return 0; }
  if (count === 0) { c.pos = save.pos; c.col = save.col; c.tab = save.tab; return 0; }
  return ch === '=' ? 1 : 2;
}

// ---- link reference definitions ----

// Parse as many link reference definitions as possible from the start of
// `text` (a paragraph's content, lines joined by '\n'). Adds them to refs
// (first definition wins) and returns the remaining text.
function parseRefDefs(text, refs) {
  let i = 0;
  const n = text.length;
  let consumed = 0;
  while (i < n) {
    const start = i;
    let sp = 0;
    while (i < n && text[i] === ' ' && sp < 3) { i++; sp++; }
    if (i < n && (text[i] === ' ' || text[i] === '\t')) break;
    if (i >= n || text[i] !== '[') break;
    const lab = parseRefLabel(text, i);
    if (!lab || lab.label.length === 0) break;
    // A label that normalizes to empty (e.g. only whitespace) is not a def.
    if (normalizeLabel(lab.label).length === 0) break;
    i = lab.next;
    if (i >= n || text[i] !== ':') break;
    i++;
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
    if (i >= n) break;
    let dest;
    if (text[i] === '<') {
      let j = i + 1, d = '', ok = false;
      while (j < n) {
        const ch = text[j];
        if (ch === '\n') break;
        if (ch === '>') { ok = true; break; }
        if (ch === '<') break;
        if (ch === '\\' && j + 1 < n && isPunctCode(text.charCodeAt(j + 1))) { d += text[j + 1]; j += 2; continue; }
        d += ch; j++;
      }
      if (!ok) break;
      dest = d; i = j + 1;
    } else {
      let j = i, d = '', parens = 0;
      while (j < n) {
        const ch = text[j];
        if (ch === ' ' || ch === '\t' || ch === '\n') break;
        if (ch === '(') parens++;
        else if (ch === ')') { if (parens === 0) break; parens--; }
        if (ch === '\\' && j + 1 < n && isPunctCode(text.charCodeAt(j + 1))) { d += text[j + 1]; j += 2; continue; }
        d += ch; j++;
      }
      if (d.length === 0) break;
      dest = d; i = j;
    }
    let title = null;
    let k = i;
    while (k < n && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    // A title must be separated from the dest by whitespace.
    if (k > i && k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
      const q = text[k];
      const close = q === '(' ? ')' : q;
      let j = k + 1, t = '', ok = false;
      while (j < n) {
        const ch = text[j];
        if (ch === close) { ok = true; break; }
        if (q === '(' && ch === '(') break;
        if (ch === '\\' && j + 1 < n && isPunctCode(text.charCodeAt(j + 1))) { t += text[j + 1]; j += 2; continue; }
        t += ch; j++;
      }
      if (ok) {
        let m = j + 1;
        while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
        if (m >= n || text[m] === '\n') { title = t; i = m; }
      }
    }
    let m = i;
    while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
    if (m < n && text[m] !== '\n') break;
    const key = normalizeLabel(lab.label);
    if (key.length > 0 && !refs.has(key)) {
      refs.set(key, { href: escNoEncode(safeEncodeURI(dest)), title: title === null ? null : escNoEncode(title) });
    }
    i = m < n ? m + 1 : m;
    consumed = i;
  }
  return text.slice(consumed);
}

// ---- tables ----

function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let startsWithPipe = false, endsWithPipe = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    // An escaped pipe '\|' is a literal '|' in the cell (the backslash is
    // removed here, so a code span sees '|' not '\|'); other escapes are
    // kept for the inline parser.
    if (ch === '\\' && k + 1 < line.length) {
      if (line[k + 1] === '|') { cur += '|'; k++; continue; }
      cur += ch + line[k + 1]; k++; continue;
    }
    if (ch === '|') {
      if (k === 0) startsWithPipe = true;
      if (k === line.length - 1) endsWithPipe = true;
      cells.push(cur); cur = ''; continue;
    }
    cur += ch;
  }
  cells.push(cur);
  const trimmed = cells.map((s) => s.trim());
  let start = startsWithPipe ? 1 : 0;
  let end = endsWithPipe ? trimmed.length - 1 : trimmed.length;
  return trimmed.slice(start, end);
}

// Does the line contain an unescaped '|' (a table pipe separator)?
function hasUnescapedPipe(line) {
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '\\' && k + 1 < line.length) { k++; continue; }
    if (line[k] === '|') return true;
  }
  return false;
}

// If the paragraph lines form a table, return { align, header, rows };
// otherwise null.
function tryTable(lines) {
  if (lines.length < 2) return null;
  if (!hasUnescapedPipe(lines[1])) return null;
  const header = splitTableRow(lines[0]);
  const delim = splitTableRow(lines[1]);
  if (header.length !== delim.length) return null;
  const align = [];
  for (const d of delim) {
    const t = d.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    align.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.startsWith(':') ? 'left' : t.endsWith(':') ? 'right' : null);
  }
  const rows = [];
  for (let r = 2; r < lines.length; r++) {
    const cells = splitTableRow(lines[r]);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
  }
  return { align, header, rows };
}

// ---- main block parser ----

export function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // Index of the last non-blank line (for HTML-block trailing-newline rules).
  let lastContentLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[^ \t]/.test(lines[i])) { lastContentLineIdx = i; break; }
  }
  const refs = new Map();
  const doc = { t: 'doc', ch: [] };
  const stack = [doc];
  let blankCount = 0;
  let blanksBefore = 0;
  const isContainer = (b) => b.t === 'doc' || b.t === 'quote' || b.t === 'list' || b.t === 'item';
  const tip = () => stack[stack.length - 1];
  // Append a line to a code block, tracking the last non-blank line's index
  // (for the trailing-newline rule).
  function addCodeLine(b, text, idx) {
    b.lines.push(text);
    if (text !== '') b.lastContentIdx = idx;
  }

  // Compute an HTML block's trailing-newline flag from its type, nesting,
  // and last line index.
  function setHtmlTrailingNL(b) {
    if (b.type <= 5) {
      // Types 1-5 end at an end tag. A trailing newline is kept when the
      // next line is non-blank (another block follows immediately), or when
      // the block is top-level and its last line is the last content line
      // of an input that ends with a newline.
      const next = b.lastLineIdx + 1;
      const followed = next < lines.length && /[^ \t]/.test(lines[next]);
      const atEof = b.topLevel && b.lastLineIdx === lastContentLineIdx && lines[lines.length - 1] === '';
      b.trailingNL = followed || atEof;
    } else b.trailingNL = !!(b.topLevel && b.lastLineIdx === lines.length - 2 && lines[lines.length - 1] === '');
  }

  function finalize(b) {
    if (b.t === 'para') {
      const text = b.lines.join('\n');
      const rest = parseRefDefs(text, refs);
      if (rest === '') return null;
      const restLines = rest.split('\n');
      const table = tryTable(restLines);
      if (table) return { t: 'table', align: table.align, header: table.header, rows: table.rows };
      b.text = rest;
      return b;
    }
    if (b.t === 'code') {
      // Only indented code strips trailing blank lines; fenced code keeps
      // them (they become newlines in the joined content).
      if (b.indented) {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
      if (b.indented && b.lines.length === 0) return null;
      let text = b.lines.join('\n');
      // A trailing newline is added only when the last line is non-blank
      // and was followed by a newline in the input.
      if (b.lines.length > 0 && b.lines[b.lines.length - 1] !== '' && (b.lastContentIdx ?? -1) < lines.length - 1) text += '\n';
      b.text = text;
    }
    if (b.t === 'html') {
      // Types 1-5 end at an end tag: the content keeps a trailing newline
      // when the last line was followed by a newline in the input, and the
      // block is top-level or more content follows it.
      // Types 6-7 end at a blank line: a trailing newline is kept only for
      // a top-level block whose last line is the last content line of the
      // input and the input ends with a newline.
      setHtmlTrailingNL(b);
    }
    return b;
  }
  function closeTo(keep) {
    while (stack.length > keep) {
      const b = stack.pop();
      const parent = stack[stack.length - 1];
      const repl = finalize(b);
      const idx = parent.ch.indexOf(b);
      if (idx === -1) continue;
      if (repl === null) parent.ch.splice(idx, 1);
      else if (repl !== b) parent.ch[idx] = repl;
    }
  }
  // Add a block to the current container (the tip). Marks the parent list
  // loose when a blank line separates two blocks inside an item.
  function addBlock(block) {
    while (tip().t === 'list') closeTo(stack.length - 1);
    const parent = tip();
    if (blanksBefore > 0 && parent.ch.length > 0 && parent.t === 'item') {
      const grand = stack[stack.length - 2];
      if (grand && grand.t === 'list') grand.loose = true;
    }
    parent.ch.push(block);
    return block;
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const blank = isBlankLine(line);
    if (!blank) { blanksBefore = blankCount; blankCount = 0; }

    // ---- Phase 1: match open containers ----
    // A blank line matches every container (consuming a marker when one is
    // present, otherwise matching without consuming).
    let cur = curAt(line);
    let lastMatched = 0;
    let failedAt = -1;
    let matchedItem = false;
    for (let si = 1; si < stack.length; si++) {
      const b = stack[si];
      if (!isContainer(b)) break;
      if (b.t === 'quote') {
        const save = curCopy(cur);
        curAdvance(cur, 3);
        if (curPeek(cur) === '>') { cur.pos++; cur.col++; curAdvance(cur, 1); lastMatched = si; }
        // A blank line without a '>' marker does NOT match the quote:
        // it closes the quote (a new '>' line after it starts a new quote).
        else { cur.pos = save.pos; cur.col = save.col; cur.tab = save.tab; failedAt = si; break; }
      } else if (b.t === 'list') {
        lastMatched = si;
      } else if (b.t === 'item') {
        const ind = curIndent(cur);
        // An empty item that saw a blank line before any content does not
        // match: it is closed and the line starts a new block outside it.
        if (b.ch.length === 0 && b.sawBlank && !blank) { failedAt = si; break; }
        // contentIndent is an absolute column; compare against the absolute
        // column of the first non-space char.
        if (cur.col + ind >= b.contentIndent) { curAdvance(cur, b.contentIndent - cur.col); lastMatched = si; matchedItem = true; }
        else if (blank) { lastMatched = si; matchedItem = true; }
        else { failedAt = si; break; }
      }
    }

    // ---- Blank line ----
    // A line that becomes blank after container stripping is a blank line,
    // except a whitespace-only line that continues an open paragraph
    // (all containers matched): it adds its whitespace to the paragraph.
    const restAfter = curRest(cur);
    const blankNow = blank || restAfter === '' ||
      (/^[ \t]*$/.test(restAfter) && (failedAt !== -1 || tip().t !== 'para'));
    if (blankNow) {
      blankCount++;
      if (failedAt !== -1) closeTo(failedAt);
      const t = tip();
      if (t.t === 'code' && t.fenced) { addCodeLine(t, curRestStrip(cur, t.fenceIndent || 0), li); continue; }
      if (t.t === 'html' && t.type <= 5) { t.lines.push(curRest(cur)); t.lastLineIdx = li; continue; }
      if (t.t === 'code' && t.indented) {
        const ind = curIndent(cur);
        addCodeLine(t, ind >= 4 ? curRestStrip(cur, 4) : '', li);
        continue;
      }
      if (!isContainer(t)) closeTo(stack.length - 1);
      // An empty list item that sees a blank line before any content is
      // closed: following indented lines are not part of it.
      if (t.t === 'item' && t.ch.length === 0) t.sawBlank = true;
      continue;
    }

    // ---- Lazy continuation line? ----
    const t = tip();
    if (failedAt !== -1 && t.t === 'para') {
      const hb = tryHtmlBlock(curCopy(cur));
      const interrupts = tryATX(curCopy(cur)) !== null || tryFence(curCopy(cur)) !== null ||
        tryHr(curCopy(cur)) !== null || tryListMarker(curCopy(cur)) !== null ||
        tryQuote(curCopy(cur)) || (hb !== null && hb.interrupts);
      if (!interrupts) {
        if (hb !== null) {
          // A lone-tag HTML block: it does not interrupt the paragraph, but
          // it is a new block, not a paragraph continuation. Close the
          // paragraph and add the block inside the current containers.
          closeTo(stack.length - 1);
          const block = { t: 'html', type: hb.type, endTag: hb.endTag, lines: [curRest(cur)], topLevel: stack.length === 1, lastLineIdx: li };
          setHtmlTrailingNL(block);
          addBlock(block);
          stack.push(block);
          continue;
        }
        const ind = curIndent(cur);
        let content = curRest(cur);
        if (ind >= 4) content = curRestStrip(cur, 4);
        t.lines.push(content);
        continue;
      }
    }
    if (failedAt !== -1) closeTo(failedAt);

    // ---- Phase 2: the open leaf consumes the line? ----
    let top = tip();
    if (top.t === 'code' && top.fenced) {
      const c3 = curCopy(cur);
      const f = tryFence(c3);
      if (f && f.char === top.char && f.len >= top.len && /^[ \t]*$/.test(curRest(c3))) { closeTo(stack.length - 1); continue; }
      addCodeLine(top, curRestStrip(cur, top.fenceIndent || 0), li);
      continue;
    }
    if (top.t === 'html') {
      const rest = curRest(cur);
      if (top.type <= 5) {
        top.lines.push(rest); top.lastLineIdx = li;
        if (rest.toLowerCase().includes(top.endTag.toLowerCase())) closeTo(stack.length - 1);
      } else {
        top.lines.push(rest); top.lastLineIdx = li;
      }
      continue;
    }
    if (top.t === 'code' && top.indented) {
      const ind = curIndent(cur);
      if (ind >= 4) { addCodeLine(top, curRestStrip(cur, 4), li); continue; }
      closeTo(stack.length - 1);
      top = tip();
    }

    // ---- A paragraph is open: setext, continuation, or a new block ----
    if (tip().t === 'para') {
      const st = trySetext(curCopy(cur));
      if (st !== 0) {
        const para = tip();
        // Extract link ref defs first: a setext heading is formed from the
        // remaining (non-def) content. If nothing remains, the setext line
        // is a paragraph continuation, not a heading.
        const rest = parseRefDefs(para.lines.join('\n'), refs);
        const text = rest.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
        if (text !== '') {
          const parent = stack[stack.length - 2];
          const idx = parent.ch.indexOf(para);
          stack.pop();
          parent.ch[idx] = { t: 'heading', level: st, text };
          continue;
        }
      }
      // A new block start interrupts the paragraph.
      const atx = tryATX(curCopy(cur));
      const fence = tryFence(curCopy(cur));
      const hr = tryHr(curCopy(cur));
      const html = tryHtmlBlock(curCopy(cur));
      const marker = tryListMarker(curCopy(cur));
      const quote = tryQuote(curCopy(cur));
      // A list item interrupts a paragraph only when it has content, and
      // an ordered item only when it starts at 1. Empty items do not.
      const listInterrupts = marker && !marker.empty && (!marker.ordered || marker.start === 1);
      if (atx || fence || hr || (html && html.interrupts) || listInterrupts || quote) {
        closeTo(stack.length - 1);
        // fall through to the new-block handling below
      } else {
        // Paragraph continuation line.
        const ind = curIndent(cur);
        let content = curRest(cur);
        if (ind >= 4 && matchedItem) content = curRestStrip(cur, 4);
        tip().lines.push(content);
        continue;
      }
    }

    // ---- New block starts (no paragraph open) ----
    // Loop: a blockquote or list item start consumes its marker and the
    // remaining content is re-processed as a new block start inside it.
    for (;;) {
      // Blockquote
      if (tryQuote(curCopy(cur))) {
        const quote = { t: 'quote', ch: [] };
        addBlock(quote);
        stack.push(quote);
        curAdvance(cur, 3);
        cur.pos++; cur.col++; // the '>'
        curAdvance(cur, 1); // one optional space/tab
        if (/^[ \t]*$/.test(curRest(cur))) break; // empty quote line
        continue;
      }
      // ATX heading
      let atx = tryATX(curCopy(cur));
      if (atx) { addBlock({ t: 'heading', level: atx.level, text: atx.text }); break; }
      // Fenced code
      let fence = tryFence(curCopy(cur));
      if (fence) {
        const block = { t: 'code', fenced: true, char: fence.char, len: fence.len, info: fence.info, lines: [], fenceIndent: curIndent(cur) };
        addBlock(block); stack.push(block); break;
      }
      // Thematic break
      if (tryHr(curCopy(cur))) { addBlock({ t: 'hr' }); break; }
      // HTML block
      let html = tryHtmlBlock(curCopy(cur));
      if (html) {
        const block = { t: 'html', type: html.type, endTag: html.endTag, lines: [curRest(cur)], topLevel: stack.length === 1, lastLineIdx: li };
        setHtmlTrailingNL(block);
        addBlock(block);
        if (html.type <= 5) {
          if (!curRest(cur).toLowerCase().includes((html.endTag || '').toLowerCase())) stack.push(block);
        } else stack.push(block);
        break;
      }
      // List item
      let marker = tryListMarker(curCopy(cur));
      if (marker) {
        // The marker's column (after up to 3 spaces of indent).
        const c2 = curCopy(cur);
        curAdvance(c2, 3);
        const markerCol = c2.col;
        c2.pos += marker.markerLen; c2.col += marker.markerLen;
        let contentIndent;
        const after = curPeek(c2);
        if (after === '') {
          contentIndent = markerCol + marker.markerLen + 1;
        } else {
          const c3 = curCopy(c2);
          let spaces = 0;
          while (curPeek(c3) === ' ' || curPeek(c3) === '\t') { curAdvance(c3, 1); spaces++; if (spaces >= 5) break; }
          if (spaces === 0) contentIndent = markerCol + marker.markerLen + 1;
          else if (spaces >= 5) contentIndent = markerCol + marker.markerLen + 1;
          // An empty item (spaces then EOL): content indent is marker + 1.
          else if (curPeek(c3) === '') contentIndent = markerCol + marker.markerLen + 1;
          else contentIndent = markerCol + marker.markerLen + spaces;
        }
        // Find or create the list.
        let list = null;
        let parent = tip();
        if (parent.t === 'list' && parent.ordered === marker.ordered && parent.delim === marker.delim) {
          list = parent;
          if (blanksBefore > 0 && list.ch.length > 0) list.loose = true;
          // A marker at or beyond the last item's content indent starts a
          // nested list inside that item instead of joining this list.
          const lastItem = list.ch[list.ch.length - 1];
          if (lastItem && markerCol >= lastItem.contentIndent) {
            const sub = { t: 'list', ordered: marker.ordered, start: marker.start, delim: marker.delim, loose: false, ch: [] };
            lastItem.ch.push(sub);
            stack.push(sub);
            list = sub;
          }
        } else {
          if (parent.t === 'list') { closeTo(stack.length - 1); parent = tip(); }
          list = { t: 'list', ordered: marker.ordered, start: marker.start, delim: marker.delim, loose: false, ch: [] };
          addBlock(list);
          stack.push(list);
        }
        const item = { t: 'item', contentIndent, markerCol, ch: [] };
        list.ch.push(item);
        stack.push(item);
        // The item's content starts after the marker + spaces.
        const c4 = curCopy(cur);
        curAdvance(c4, 3);
        c4.pos += marker.markerLen; c4.col += marker.markerLen;
        if (curPeek(c4) !== '') curAdvance(c4, contentIndent - (markerCol + marker.markerLen));
        cur = c4;
        if (/^[ \t]*$/.test(curRest(cur))) break; // empty item
        continue; // re-process the item's content as a new block start
      }
      // Indented code
      if (curIndent(cur) >= 4) {
        const block = { t: 'code', indented: true, lines: [curRestStrip(cur, 4)], lastContentIdx: li };
        addBlock(block); stack.push(block); break;
      }
      // Paragraph
      const para = { t: 'para', lines: [curRest(cur)] };
      addBlock(para); stack.push(para);
      break;
    }
  }
  closeTo(1);
  return renderBlocks(doc.ch, refs);
}

function curRestStrip(c, cols) {
  const cc = curCopy(c);
  curAdvance(cc, cols);
  return curRest(cc);
}

// ---- rendering ----

function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) {
    if (b.t === 'para') out += '<p>' + parseInline(b.text, refs) + '</p>\n';
    else if (b.t === 'heading') out += '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
    else if (b.t === 'code') {
      if (b.fenced) {
        out += '<pre><code' + (b.info ? ' class="language-' + escNoEncode(b.info) + '"' : '') + '>' +
          escCode(b.text) + '</code></pre>\n';
      } else {
        out += '<pre><code>' + escCode(b.text) + '</code></pre>\n';
      }
    } else if (b.t === 'html') out += b.lines.join('\n') + (b.trailingNL ? '\n' : '');
    else if (b.t === 'hr') out += '<hr>\n';
    else if (b.t === 'quote') out += '<blockquote>\n' + renderBlocks(b.ch, refs) + '</blockquote>\n';
    else if (b.t === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      out += '<' + tag + start + '>\n';
      for (const item of b.ch) out += renderItem(item, refs, b.loose);
      out += '</' + tag + '>\n';
    } else if (b.t === 'table') {
      out += '<table>\n<thead>\n<tr>\n';
      for (let ci = 0; ci < b.header.length; ci++) {
        const a = b.align[ci];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(b.header[ci], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let ci = 0; ci < row.length; ci++) {
            const a = b.align[ci];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(row[ci], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
    }
  }
  return out;
}

function renderItem(item, refs, loose) {
  let out = '<li>';
  const blocks = item.ch;
  if (blocks.length === 0) return out + '</li>\n';
  // Task marker: the first paragraph's text starts with "[ ] ", "[x] ", "[X] ".
  let first = blocks[0];
  let taskHtml = '';
  let taskText = null;
  if (first.t === 'para') {
    const m = first.text.match(/^\[([ xX])\] /);
    if (m) {
      taskHtml = m[1] === ' ' ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ';
      taskText = first.text.slice(4);
    }
  }
  if (!loose) {
    // Tight: paragraph children render as bare inline content.
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (b.t === 'para') {
        const text = (bi === 0 && taskText !== null) ? taskText : b.text;
        out += (bi === 0 ? taskHtml : '') + parseInline(text, refs);
      } else if (b.t === 'list' || b.t === 'quote' || b.t === 'table') {
        out += renderBlocks([b], refs);
      } else if (b.t === 'code') {
        if (b.fenced) out += '<pre><code' + (b.info ? ' class="language-' + escNoEncode(b.info) + '"' : '') + '>' + escCode(b.text) + '</code></pre>\n';
        else out += '<pre><code>' + escCode(b.text) + '</code></pre>\n';
      } else if (b.t === 'html') out += b.lines.join('\n') + (b.trailingNL ? '\n' : '');
      else if (b.t === 'heading') out += '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
      else if (b.t === 'hr') out += '<hr>\n';
    }
    out += '</li>\n';
    return out;
  }
  // Loose: paragraphs are wrapped in <p>.
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.t === 'para') {
      const text = (bi === 0 && taskText !== null) ? taskText : b.text;
      out += '<p>' + (bi === 0 ? taskHtml : '') + parseInline(text, refs) + '</p>\n';
    } else if (b.t === 'list' || b.t === 'quote' || b.t === 'table') {
      out += renderBlocks([b], refs);
    } else if (b.t === 'code') {
      if (b.fenced) out += '<pre><code' + (b.info ? ' class="language-' + escNoEncode(b.info) + '"' : '') + '>' + escCode(b.text) + '</code></pre>\n';
      else out += '<pre><code>' + escCode(b.text) + '</code></pre>\n';
    } else if (b.t === 'html') out += b.lines.join('\n') + (b.trailingNL ? '\n' : '');
    else if (b.t === 'heading') out += '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
    else if (b.t === 'hr') out += '<hr>\n';
  }
  out += '</li>\n';
  return out;
}
