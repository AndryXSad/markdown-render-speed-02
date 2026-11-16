// parse.js — dependency-free CommonMark 0.31.2 + GFM renderer, byte-identical to
// marked 18.1.3 with default options (gfm, breaks off, pedantic off, async off).
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// Single ES module, zero imports. export parse(markdown) -> HTML string.
// Architecture: block parser (frame stack + two-phase line loop) -> inline
// parser (flat node list + delimiter-stack emphasis) -> renderer (one walk).
// Where marked deviates from the spec, marked wins; the tricky cases are
// documented inline next to the code that handles them (see linkTextOk,
// hasClosingParen, and the emphasis boundary rule in resolveEmphasis).

// ============================ helpers ============================

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  return ch !== '' && PUNCT_RE.test(ch);
}
function isSpaceCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' ||
    (ch !== '' && (ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') ||
      ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' || ch === '\u3000'));
}
function isAsciiPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isAlphaNum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Plain HTML escape for code content: every & becomes &amp; (entities are
// NOT preserved inside code spans / code blocks).
const ESC_PLAIN_RE2 = /[&<>"']/g;
function escCode(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_PLAIN_RE2, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

// Escape text for HTML output. An & that starts an entity-like sequence
// (&word; or &#...;) is left alone; any other & becomes &amp;.
const ESC_TEST = /[&<>"']/;
const ESC_RE = /&(?!(?:[A-Za-z0-9_]+|#[0-9]+|#[xX][0-9a-fA-F]+);)|[<>"']/g;
function escText(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

// Escape for attribute values (href/title/lang): same as text, but an & that
// starts an entity-like sequence is left alone (named entities are NOT decoded).
function escAttr(s) {
  return escText(s);
}

// Percent-encode a URL the way marked does: encodeURI, then un-escape %25 -> %.
function encodeHref(s) {
  return encodeURI(s).replace(/%25/g, '%');
}

// href for inline / reference links and images: encode + entity-aware escape.
function hrefInline(dest) {
  return escAttr(encodeHref(dest));
}
// href for bare / autolink URLs: encode + plain escape (& always -> &amp;).
const ESC_PLAIN_RE = /[&<>"']/g;
function hrefBare(url) {
  const e = encodeHref(url);
  if (!ESC_TEST.test(e)) return e;
  return e.replace(ESC_PLAIN_RE, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}

// Decode a numeric character reference. Returns the character (or U+FFFD).
function decodeNumeric(numStr, hex) {
  let cp;
  if (hex) {
    cp = parseInt(numStr, 16);
  } else {
    cp = parseInt(numStr, 10);
  }
  if (!isFinite(cp) || cp <= 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// Match an entity at s[i] ('&'). Returns {len, out} where out is the verbatim
// text to emit (named entity, left as-is) or a decoded char (numeric), or null.
function matchEntity(s, i) {
  // numeric: &#123; &#x1F; &#X1F;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : s[j] >= '0' && s[j] <= '9')) j++;
    if (j > start && s[j] === ';') {
      const cp = hex ? parseInt(s.slice(start, j), 16) : parseInt(s.slice(start, j), 10);
      if (!isFinite(cp) || cp > 0x10FFFF) return null; // out of range: not an entity
      return { len: j + 1 - i, out: decodeNumeric(s.slice(start, j), hex), numeric: true };
    }
    return null;
  }
  // named: &word; (letters, digits, underscore) — left verbatim, never decoded.
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') j++;
    else break;
  }
  if (j > i + 1 && s[j] === ';') {
    return { len: j + 1 - i, out: s.slice(i, j + 1), numeric: false };
  }
  return null;
}

// Normalize a link label: collapse whitespace runs to a single space, trim,
// case-fold. Unicode case folding maps ß and ẞ to "ss" (toLowerCase alone
// maps ẞ to ß), so fold those first, plus the common ligatures.
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim()
    .replace(/[ßẞ]/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .toLowerCase();
}

// ============================ inline parser ============================

// Node types (flat list; links are open/close marker nodes so rendering is a
// single left-to-right walk):
//  0 text {s}
//  1 code {s}
//  2 delim {ch, len, orig, canOpen, canClose, opens:[], closes:[], linkId}
//  3 linkOpen {href, title}
//  4 linkClose {}
//  5 img {src, altNodes, title} (alt computed from altNodes after emphasis)
//  6 html {s}   (raw inline html, emitted verbatim)
//  7 br {}      (hard break -> <br>)
//  8 soft {}    (soft break -> \n)
//  9 open {}    (unresolved '[' marker, renders as '[')
// 10 openImg {} (unresolved '![' marker, renders as '![')

const EMAIL_LOCAL = /[A-Za-z0-9._+\-]/;
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?/;

// Try to match a bare email starting at position i (start of a local-part run).
// Returns the matched email string or null.
function matchBareEmail(s, i, underCloser) {
  const n = s.length;
  let j = i;
  while (j < n && EMAIL_LOCAL.test(s[j])) j++;
  if (j === i) return null;
  if (s[j] !== '@') return null;
  const local = s.slice(i, j);
  let k = j + 1;
  // domain: label (. label)+ ; each label [A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?
  let labels = 0;
  let lastEnd = -1;
  while (true) {
    if (k >= n || !isAlphaNum(s[k])) return null;
    let m = k + 1;
    while (m < n && ((s[m] >= 'a' && s[m] <= 'z') || (s[m] >= 'A' && s[m] <= 'Z') || (s[m] >= '0' && s[m] <= '9') || s[m] === '-' || s[m] === '_')) m++;
    // label must end with alphanum (back up over any trailing - / _)
    while (m > k && !isAlphaNum(s[m - 1])) m--;
    if (m === k) return null;
    labels++;
    lastEnd = m;
    k = m;
    // a '.' continues the domain only if another label follows it; a
    // trailing '.' (or ',') is text, not part of the address
    if (s[k] === '.' && k + 1 < n && isAlphaNum(s[k + 1])) { k++; continue; }
    break;
  }
  if (labels < 2) return null;
  // char after domain must not be - or _ (a trailing '_' would make the
  // address part of a longer token) — unless the '_' is a closing
  // emphasis delimiter: an earlier '_' opener pairs with it, so the
  // email ends before it (marked: `_foo bar@example.com_` links)
  if (s[lastEnd] === '-' || s[lastEnd] === '_') {
    if (s[lastEnd] === '_' && underCloser && underCloser(lastEnd)) return s.slice(i, lastEnd);
    return null;
  }
  return s.slice(i, lastEnd);
}

// Match a bare URL (http/https/ftp/www/xmpp/mailto) at position i.
// Returns {len, href, text} or null. `text` is the display text, `href` the URL.
// `brk` is the position of a `]` that must not be swallowed (it closes a
// link text whose destination follows); -1 / omitted = no such bracket.
function matchBareUrl(s, i, brk = -1) {
  const n = s.length;
  let scheme = null; // 'http' | 'https' | 'ftp' | 'www' | 'xmpp' | 'mailto'
  let start = i;
  // http/https/ftp schemes are case-insensitive (marked); www./xmpp:/
  // mailto: are lowercase only (WWW./MAILTO:/XMPP: do not link)
  const low8 = s.slice(i, i + 8).toLowerCase();
  if (low8.startsWith('http://')) { scheme = 'http'; start = i + 7; }
  else if (low8.startsWith('https://')) { scheme = 'https'; start = i + 8; }
  else if (low8.startsWith('ftp://')) { scheme = 'ftp'; start = i + 6; }
  else if (s.startsWith('www.', i)) { scheme = 'www'; start = i + 4; }
  else if (s.startsWith('xmpp:', i)) { scheme = 'xmpp'; start = i + 5; }
  else if (s.startsWith('mailto:', i)) { scheme = 'mailto'; start = i + 7; }
  else return null;

  if (scheme === 'xmpp' || scheme === 'mailto') {
    // scheme: + bare email [+ /resource]  (xmpp only)
    const em = matchBareEmail(s, start);
    if (!em) return null;
    let end = start + em.length;
    let text = s.slice(i, end);
    if (scheme === 'xmpp' && s[end] === '/') {
      // one /resource segment: [A-Za-z0-9.@]+, trailing . / @ trimmed
      let r = end + 1;
      while (r < n && ((s[r] >= 'a' && s[r] <= 'z') || (s[r] >= 'A' && s[r] <= 'Z') || (s[r] >= '0' && s[r] <= '9') || s[r] === '.' || s[r] === '@')) r++;
      let rend = r;
      while (rend > end + 1 && (s[rend - 1] === '.' || s[rend - 1] === '@')) rend--;
      if (rend > end + 1) { end = rend; text = s.slice(i, end); }
    }
    return { len: end - i, href: text, text };
  }

  // http/https/ftp/www: consume [^\s<>]+ then trim trailing punct / balance parens
  // (stops at `brk`, a `]` that closes a link text — see the caller)
  let j = start;
  while (j < n && j !== brk && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '\r' && s[j] !== '<' && s[j].charCodeAt(0) >= 32 && s[j] !== '\u007f') j++;
  if (j === start) return null;
  let url = s.slice(i, j);
  // www. needs at least one char after the prefix (already true) — but a lone
  // "www." with nothing after is not a link; also require the domain-ish part
  // to contain at least one non-punct char? www.a links, so any char counts.
  if (scheme === 'www' && url.length <= 4) return null;
  // trim trailing punctuation ? ! . , : * _ ~ ; — a trailing ';' is also
  // excluded (marked), but a trailing entity '&word;' must be stripped
  // as a whole first, so the entity check runs before the ';' trim
  const TRAIL = '? ! . , : * _ ~ ;';
  const ENT_RE = /&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z0-9]+);$/;
  // balance parens (marked): a trailing ')' is dropped when it is
  // unmatched, or when the group it closes contains a nested '('
  // (a bare URL allows only one level of parens at its end); an
  // unclosed '(' truncates the URL at that '('. An unmatched ')'
  // EARLIER in the URL does not unbalance a later group: the depth
  // never goes below zero (so `https://e.com/s)](https://i.io/q)`
  // keeps its final ')' and the whole group). The nested-group trim
  // intentionally leaves an unclosed '(' behind, so once it has run
  // the unclosed-'(' truncation below is suppressed for the rest of
  // this URL (noUnclosedTrunc).
  let noUnclosedTrunc = false;
  let changed = true;
  while (changed) {
    changed = false;
    const em0 = ENT_RE.exec(url);
    if (em0) { url = url.slice(0, url.length - em0[0].length); changed = true; }
    while (url.length > 0 && TRAIL.indexOf(url[url.length - 1]) >= 0) {
      url = url.slice(0, -1); changed = true;
    }
    let depth = 0;
    for (let k = 0; k < url.length; k++) {
      if (url[k] === '(') depth++;
      else if (url[k] === ')') { if (depth > 0) depth--; }
    }
    if (depth > 0 && !noUnclosedTrunc) {
      // find first unclosed '(' : walk with a stack
      const stack = [];
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') stack.push(k);
        else if (url[k] === ')') { if (stack.length) stack.pop(); }
      }
      if (stack.length) { url = url.slice(0, stack[0]); changed = true; }
    } else if (depth === 0) {
      // trim trailing ')' that are unmatched or close a nested group
      let t = url.length;
      while (t > 0 && url[t - 1] === ')') {
        // find the '(' matching this ')' (scan back from t-1)
        let d = 0, open = -1;
        for (let k = t - 1; k >= 0; k--) {
          if (url[k] === ')') d++;
          else if (url[k] === '(') {
            d--;
            if (d === 0) { open = k; break; }
          }
        }
        if (open < 0) { t--; changed = true; continue; } // unmatched
        // does the group (open, t-1) contain another '(' ?
        let nested = false;
        for (let k = open + 1; k < t - 1; k++) if (url[k] === '(') { nested = true; break; }
        if (nested) { t--; changed = true; noUnclosedTrunc = true; continue; }
        break;
      }
      if (t < url.length) url = url.slice(0, t);
    }
  }
  if (url.length === 0) return null;
  const href = scheme === 'www' ? 'http://' + url : url;
  return { len: url.length, href, text: url };
}

// Try to match an autolink <...> at s[i]. Returns {len, href, text} or null.
function matchAutolink(s, i) {
  const n = s.length;
  if (s[i] !== '<') return null;
  const end = s.indexOf('>', i + 1);
  if (end < 0) return null;
  const inner = s.slice(i + 1, end);
  if (inner.length === 0) return null;
  if (/[\s<>]/.test(inner)) return null;
  // email: local@domain (CommonMark autolink email; no dot required)
  const at = inner.indexOf('@');
  if (at > 0) {
    const emRe = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
    if (emRe.test(inner)) {
      return { len: end + 1 - i, href: 'mailto:' + inner, text: inner };
    }
    // not a valid email: fall through to the scheme check (e.g. MAILTO:)
  }
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  const col = inner.indexOf(':');
  if (col >= 2 && col <= 32) {
    const scheme = inner.slice(0, col);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) {
      return { len: end + 1 - i, href: inner, text: inner };
    }
  }
  return null;
}

// Try to match an inline HTML tag at s[i]. Returns {len} or null.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (s[i] !== '<') return null;
  // comment <!-- ... -->
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { len: 5 };
    if (s.startsWith('<!--->', i)) return { len: 6 };
    const end = s.indexOf('-->', i + 4);
    if (end < 0) return null;
    return { len: end + 3 - i };
  }
  // processing instruction <? ... ?>
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end < 0) return null;
    return { len: end + 2 - i };
  }
  // declaration <!A ... >  (letter after !)
  if (s.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
    const end = s.indexOf('>', i + 2);
    if (end < 0) return null;
    return { len: end + 1 - i };
  }
  // CDATA <![CDATA[ ... ]]>
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end < 0) return null;
    return { len: end + 3 - i };
  }
  // open / close tag
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return null;
  const nameStart = j;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  const nameEnd = j;
  const name = s.slice(nameStart, nameEnd).toLowerCase();
  if (closing) {
    // closing tag: optional spaces then >
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '>') return { len: k + 1 - i, name, closing: true };
    return null;
  }
  // open tag: attributes (each preceded by whitespace), optional / , then >
  while (true) {
    if (j >= n) return null;
    const c = s[j];
    if (c === '>') return { len: j + 1 - i, name, closing: false };
    if (c === '/') {
      if (s[j + 1] === '>') return { len: j + 2 - i, name, closing: false };
      return null;
    }
    if (c !== ' ' && c !== '\t' && c !== '\n') return null;
    // skip whitespace
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j >= n) return null;
    if (s[j] === '>' || (s[j] === '/' && s[j + 1] === '>')) continue;
    // attribute name: first char is a letter, '_', ':' or non-ASCII
    if (!/[A-Za-z_:]/.test(s[j]) && s[j] !== '_' && !(s[j] >= '\u0080')) return null;
    while (j < n && /[A-Za-z0-9_.:\-]/.test(s[j])) j++;
    // optional whitespace, optional = value
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      if (s[k] === '"' || s[k] === "'") {
        const q = s[k];
        k++;
        const eq = s.indexOf(q, k);
        if (eq < 0) return null;
        j = eq + 1;
      } else {
        // unquoted value: no spaces, ", ', =, <, >, `
        let v = k;
        while (v < n && !/[\s"'=<>`]/.test(s[v])) v++;
        if (v === k) return null;
        j = v;
      }
    }
    // no '=': boolean attribute; leave j at the end of the name so the
    // next loop iteration skips the whitespace itself
  }
}

// Whether a link's raw text can form an inline or full/collapsed reference
// link in marked (derived from oracle probes; shortcut references are exempt).
// See linkTextOk below for the greedy code-span scan rule.
//   [a b `c d](u)                      -> NO link (lone backtick mid-text)
// Whether a link's raw text can form an inline or full/collapsed reference
// link in marked (derived from oracle probes; shortcut references are exempt).
// Scan greedily for code spans of the form <backtick run> <content with no
// backticks> <backtick run> (the two runs need not match in length). An
// escaped backtick (\`) is literal text, not a delimiter. If the scan
// consumes the whole text, the link may form. If it stops at a backtick run
// that cannot start such a code span, the link may still form only when that
// run extends to the very end of the text (a trailing backtick run).
// Examples (marked):
//   [a b ``c` d](u)                  -> link (`` ``c` `` pairs, then text)
//   [a b c``d e](u)                  -> NO link (`` `` `` has no closer)
//   [but _previous from `` a ` b ``_](u) -> NO link (trailing `` `` ``
//      is followed by `_`, not at the end)
//   [but previous _from_ `` a ` b ``](u) -> link (trailing `` `` `` at end)
//   [client ``commit` tests next](u) -> link (`` ``commit` `` pairs)
//   [else value \` path](u)          -> link (the \` is escaped, not a tick)
function linkTextOk(t) {
  let p = 0;
  const n = t.length;
  // backtick runs that find no closer of exactly their own length
  let unpaired = 0;
  while (p < n) {
    const c = t[p];
    if (c === '\\' && p + 1 < n) { p += 2; continue; }
    if (c !== '`') { p++; continue; }
    let run = 0;
    while (p + run < n && t[p + run] === '`') run++;
    // the code-span closer is the next run of exactly `run` backticks
    let q = p + run, found = -1;
    while (q < n) {
      if (t[q] === '`') {
        let r2 = 0;
        while (q + r2 < n && t[q + r2] === '`') r2++;
        if (r2 === run) { found = q; break; }
        q += r2;
      } else q++;
    }
    if (found < 0) { unpaired++; p += run; continue; }
    // a code span whose content holds a backtick ("poisoned") invalidates
    // the label when anything follows the span (J-rule: J1/J6 pass, J2/J3/
    // J4/I2/I4/H1 fail); as the last thing in the label it is harmless
    let poisoned = false;
    for (let k = p + run; k < found; k++) {
      if (t[k] === '`') { poisoned = true; break; }
    }
    if (poisoned && found + run < n) return false;
    p = found + run;
  }
  // exactly one unpaired run invalidates the label (cm-525, cm-537, G4,
  // G9, F6, I3); zero, or two+ runs of different lengths (doc-35, G5, G6),
  // are literal backticks and the label is fine
  return unpaired !== 1;
}

// Count backtick runs in `t` that find no closer of exactly their own
// length (same exact-length pairing as linkTextOk, but returns the
// count). A formed link can only have 0 or >= 2 unpaired runs (exactly
// one invalidates the label, so the link never forms); >= 2 means the
// link text holds literal backticks ("poisoned", e.g. `issue ``small``).
function unpairedBacktickRuns(t) {
  let p = 0;
  const n = t.length;
  let unpaired = 0;
  while (p < n) {
    const c = t[p];
    if (c === '\\' && p + 1 < n) { p += 2; continue; }
    if (c !== '`') { p++; continue; }
    let run = 0;
    while (p + run < n && t[p + run] === '`') run++;
    let q = p + run, found = -1;
    while (q < n) {
      if (t[q] === '`') {
        let r2 = 0;
        while (q + r2 < n && t[q + r2] === '`') r2++;
        if (r2 === run) { found = q; break; }
        q += r2;
      } else q++;
    }
    if (found < 0) { unpaired++; p += run; continue; }
    p = found + run;
  }
  return unpaired;
}

// Does the '(' at s[i] have a matching closing ')' later (paren-depth scan,
// skipping <...> destinations and quoted titles)? Used to decide whether a
// failed inline link suppresses emphasis inside its text: marked leaves the
// emphasis literal when the `[...](...)` group is closed (even if the dest,
// title or label is invalid), but resolves it normally when there is no
// closing paren or no '(' at all. Examples (marked):
//   [a _b c_](u "unclosed) -> _b c_ literal (closed paren, bad title)
//   [a _b c_](u v)          -> _b c_ literal (closed paren, bad dest)
//   [a _b c_](u             -> <em>b c</em> (no closing paren)
//   [a _b c_][r]            -> <em>b c</em> (no '('; a ref, not inline)
function hasClosingParen(s, i) {
  const n = s.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s[j];
    if (c === '<') {
      const e = s.indexOf('>', j + 1);
      if (e < 0) { j++; continue; }
      j = e + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = s.indexOf(c, j + 1);
      if (e < 0) { j++; continue; }
      j = e + 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return true;
    }
    j++;
  }
  return false;
}

// Parse a link destination + optional title starting at s[i] (after '[' text
// and ']' — i.e. s[i] is '(' for inline links). Returns {len, dest, title}
// or null. `len` counts from i (includes the parens).
function tryInlineLink(s, i) {
  const n = s.length;
  if (s[i] !== '(') return null;
  let j = i + 1;
  // skip spaces/tabs/newlines
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= n) return null;
  let dest = '';
  if (s[j] === '<') {
    // the closing > must be unescaped (an escaped \> does not close it)
    let end = -1;
    for (let e = j + 1; e < n; e++) {
      if (s[e] === '\\' && e + 1 < n && isAsciiPunct(s[e + 1])) { e++; continue; }
      if (s[e] === '>') { end = e; break; }
      if (s[e] === '\n' || s[e] === '<') break;
    }
    if (end < 0) return null;
    dest = s.slice(j + 1, end);
    j = end + 1;
  } else {
    // bare destination: balanced parens, no spaces/control chars
    let depth = 0, k = j;
    while (k < n) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c.charCodeAt(0) < 32) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { k += 2; continue; }
      k++;
    }
    if (depth !== 0) return null;
    dest = s.slice(j, k);
    j = k;
  }
  // optional title
  let title = null;
  let k = j;
  while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  if (k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const open = s[k];
    const close = open === '(' ? ')' : open;
    let t = k + 1, val = '', ok = false;
    while (t < n) {
      const c = s[t];
      if (c === '\\' && t + 1 < n && (isAsciiPunct(s[t + 1]))) { val += s[t + 1]; t += 2; continue; }
      if (c === close) { ok = true; break; }
      if (open !== '(' && c === '\n') { /* newline allowed in title? keep */ }
      val += c; t++;
    }
    if (!ok) return null;
    title = val;
    j = t + 1;
    k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  }
  if (s[k] !== ')') return null;
  return { len: k + 1 - i, dest, title };
}

// Unescape backslash escapes in a link destination / title.
function unescapeStr(s) {
  if (!s.includes('\\')) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Plain text of an image's alt nodes (computed after emphasis resolution,
// so emphasis markers that paired are gone and only literal ones remain).
function altTextOf(imgNode) {
  let out = '';
  for (const nd of imgNode.altNodes) {
    if (nd.t === 0) out += nd.s;
    else if (nd.t === 1) out += nd.s;
    else if (nd.t === 2) out += nd.ch.repeat(nd.len);
    else if (nd.t === 5) out += altTextOf(nd);
    else if (nd.t === 8) out += '\n';
    else if (nd.t === 9) out += '[';
    else if (nd.t === 10) out += '![';
    else if (nd.t === 3 || nd.t === 4 || nd.t === 6 || nd.t === 7) { /* skip */ }
  }
  return out;
}

// Render the alt text of an image: plain text of its link-text nodes.
function plainTextOf(nodes, a, b) {
  let out = '';
  for (let k = a; k < b; k++) {
    const nd = nodes[k];
    if (nd.t === 0) out += nd.s;
    else if (nd.t === 1) out += nd.s;
    else if (nd.t === 2) out += nd.ch.repeat(nd.len);
    else if (nd.t === 5) out += altTextOf(nd);
    else if (nd.t === 6) out += '';
    else if (nd.t === 7) out += '';
    else if (nd.t === 8) out += '\n';
    else if (nd.t === 9) out += '[';
    else if (nd.t === 10) out += '![';
    else if (nd.t === 3) { /* linkOpen: skip, children handled by their own nodes */ }
    else if (nd.t === 4) { /* linkClose */ }
  }
  return out;
}

// ============================ inline main ============================

// Whether the inline parser is currently inside a raw <a>...</a> element
// (marked quirk): an opening <a> tag seen as inline HTML sets this and a
// closing </a> clears it, and the flag LEAKS across blocks for the rest of
// the document. While set, bare URL/email autolinks are not recognised
// (Q1-Q7); angle autolinks <...> still are. HTML blocks do not touch it
// (the tag there never reaches the inline parser). Reset per parse().
let inRawA = false;

function inlineParse(text, refs) {
  const nodes = [];
  const delims = [];
  const openers = [];
  const n = text.length;
  let i = 0;

  function pushText(s) {
    if (!s) return;
    const l = nodes[nodes.length - 1];
    // never merge into a raw (entity) node: the following text must still
    // be escaped, or a '>' after '&copy;' would leak out unescaped
    if (l && l.t === 0 && !l.raw) l.s += s;
    else nodes.push({ t: 0, s });
  }
  function pushDelim(ch, len, canOpen, canClose, nextCh) {
    const d = { t: 2, ch, len, orig: len, canOpen, canClose, nextCh: nextCh || '', opens: [], closes: [], linkId: null, id: delims.length };
    nodes.push(d);
    delims.push(d);
  }
  // Is the '_' run at pos a plausible closing emphasis delimiter? (It can
  // close, and an earlier '_' opener exists.) Used to rescue a bare email
  // that ends right before such a run (e.g. `_foo bar@example.com_`).
  function underCloserAt(pos) {
    let m = pos;
    while (m < n && text[m] === '_') m++;
    if (m === pos) return false;
    const prev = pos > 0 ? text[pos - 1] : '';
    const next = m < n ? text[m] : '';
    const prevWs = prev === '' || isSpaceCh(prev);
    const nextWs = next === '' || isSpaceCh(next);
    const prevPunct = prev !== '' && isPunct(prev);
    const nextPunct = next !== '' && isPunct(next);
    const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
    const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
    if (!(rightFlank && (!leftFlank || nextPunct))) return false;
    for (const d of delims) if (d.ch === '_' && d.canOpen && d.len > 0) return true;
    return false;
  }
  // Would the ']' at position j close the topmost open '[' opener into a
  // link/image? A pure mirror of the ']' handler's decision (no mutation).
  // A code span must not swallow such a bracket (marked resolves the link
  // first: `[run ``response`][tool-91]` links, the backtick stays literal).
  function bracketFormsLink(j) {
    let oi = openers.length - 1;
    while (oi >= 0 && !openers[oi].active) oi--;
    if (oi < 0) return false;
    const op = openers[oi];
    let hasLink = false;
    if (!op.img) {
      for (let k = op.ni + 1; k < nodes.length; k++) {
        if (nodes[k].t === 3 && !nodes[k].auto) { hasLink = true; break; }
      }
    }
    if (hasLink) return false;
    const rawLabel = text.slice(op.src + (op.img ? 2 : 1), j);
    const after = j + 1;
    const textOk = linkTextOk(rawLabel);
    if (text[after] === '(' && textOk) {
      if (tryInlineLink(text, after)) return true;
      const norm = normalizeLabel(rawLabel);
      return !!(norm && refs.has(norm));
    }
    if (text[after] === '[' && textOk) {
      const close = text.indexOf(']', after + 1);
      if (close >= after + 1) {
        const label = close === after + 1 ? rawLabel : text.slice(after + 1, close);
        const norm = normalizeLabel(label);
        if (norm && refs.has(norm)) return true;
      }
      return false;
    }
    const norm = normalizeLabel(rawLabel);
    return !!(norm && refs.has(norm));
  }

  // Does the label contain a code span (exact-length backtick runs)
  // whose content itself contains a backtick? Such a "poisoned" span
  // (`` `` a ` b `` ``) makes a failed link leave its emphasis literal
  // (H1, I2, I6, I7); a clean span or a merely unclosed run (I3) does not.
  function hasPoisonedCodeSpan(t) {
    let p = 0;
    const n = t.length;
    while (p < n) {
      const c = t[p];
      if (c === '\\' && p + 1 < n) { p += 2; continue; }
      if (c !== '`') { p++; continue; }
      let run = 0;
      while (p + run < n && t[p + run] === '`') run++;
      let q = p + run, found = -1;
      while (q < n) {
        if (t[q] === '`') {
          let r2 = 0;
          while (q + r2 < n && t[q + r2] === '`') r2++;
          if (r2 === run) { found = q; break; }
          q += r2;
        } else q++;
      }
      if (found < 0) { p += run; continue; }
      for (let k = p + run; k < found; k++) {
        if (t[k] === '`') return true;
      }
      p = found + run;
    }
    return false;
  }

  while (i < n) {
    const c = text[i];
    // newline: hard break if 2+ trailing spaces, else soft break
    if (c === '\n') {
      const l = nodes[nodes.length - 1];
      if (l && l.t === 0) {
        const m = / +$/.exec(l.s);
        if (m && m[0].length >= 2) {
          l.s = l.s.slice(0, -m[0].length);
          if (!l.s) nodes.pop();
          nodes.push({ t: 7 });
          i++;
          // a hard break strips the next line's leading spaces/tabs
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
          continue;
        }
      }
      nodes.push({ t: 8 });
      i++;
      continue;
    }
    // backslash escape / hard break
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        nodes.push({ t: 7 });
        i += 2;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx && isAsciiPunct(nx)) { pushText(nx === '&' ? '&amp;' : nx); i += 2; continue; }
      pushText('\\');
      i++;
      continue;
    }
    // code span
    if (c === '`') {
      let m = 0;
      while (i + m < n && text[i + m] === '`') m++;
      // find a run of exactly m backticks; a ']' that would close an open
      // link text stops the search (the span cannot swallow it)
      let j = i + m, found = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r = 0;
          while (j + r < n && text[j + r] === '`') r++;
          if (r === m) { found = j; break; }
          j += r;
        } else {
          if (text[j] === ']' && bracketFormsLink(j)) break;
          j++;
        }
      }
      if (found >= 0) {
        let content = text.slice(i + m, found);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ t: 1, s: content });
        i = found + m;
        continue;
      }
      pushText('`'.repeat(m));
      i += m;
      continue;
    }
    // image / link opener (src = source index of the '[' or '!')
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
    // close bracket: try to resolve a link / image with the TOP active
    // opener only. If it cannot form a link, that opener is deactivated and
    // the ']' is literal text; the next ']' tries the next opener.
    if (c === ']') {
      let resolved = false;
      // find topmost active opener
      let oi = openers.length - 1;
      while (oi >= 0 && !openers[oi].active) oi--;
      if (oi >= 0) {
        const op = openers[oi];
        const startNi = op.ni;
        // a link's text must not contain a *link* node; an autolink or bare
        // URL/email inside the text is fine (it becomes part of the text)
        let hasLink = false;
        if (!op.img) {
          for (let k = startNi + 1; k < nodes.length; k++) {
            if (nodes[k].t === 3 && !nodes[k].auto) { hasLink = true; break; }
          }
        }
        // the raw source text of the link text (keeps backslashes, so a
        // label 'foo\!' does not match a definition 'foo!')
        const rawLabel = text.slice(op.src + (op.img ? 2 : 1), i);
        let href = null, title = null, consumed = 0;
        const after = i + 1;
        // a link text that fails the label rule cannot form an inline or
        // full/collapsed reference link (but may still be a shortcut)
        const textOk = linkTextOk(rawLabel);
        if (!hasLink && text[after] === '(' && textOk) {
          const r = tryInlineLink(text, after);
          if (r) { href = unescapeStr(r.dest); title = r.title === null ? null : unescapeStr(r.title); consumed = (after - i) + r.len; }
          // a failed inline-link attempt still falls back to shortcut
          if (href === null) {
            const norm = normalizeLabel(rawLabel);
            if (norm && refs.has(norm)) {
              const ref = refs.get(norm);
              href = ref.dest; title = ref.title; consumed = 1;
            }
          }
        } else if (!hasLink && text[after] === '[' && textOk) {
          // full or collapsed reference; a failed '[label]' is not a shortcut
          const close = text.indexOf(']', after + 1);
          if (close >= after + 1) {
            let label;
            if (close === after + 1) label = rawLabel;
            else label = text.slice(after + 1, close);
            const norm = normalizeLabel(label);
            if (norm && refs.has(norm)) {
              const ref = refs.get(norm);
              href = ref.dest; title = ref.title; consumed = (close + 1) - i;
            }
          }
        } else if (!hasLink) {
          // shortcut reference
          const norm = normalizeLabel(rawLabel);
          if (norm && refs.has(norm)) {
            const ref = refs.get(norm);
            href = ref.dest; title = ref.title; consumed = 1;
          }
        }
        if (href !== null) {
          // form the link / image
          if (op.img) {
            // defer the alt text: it is computed after emphasis resolution
            // (so '*bar*' in the alt becomes 'bar')
            const imgNode = { t: 5, src: hrefInline(href), altNodes: nodes.slice(startNi + 1), title: title === null ? null : escAttr(title) };
            nodes.splice(startNi, nodes.length - startNi, imgNode);
          } else {
            const kids = nodes.splice(startNi + 1, nodes.length - (startNi + 1));
            // a bare URL/email autolink inside a formed link renders as
            // plain text (marked: bare autolinks are not recognised
            // inside links); an angle autolink stays a link. Flatten
            // each bare autolink triple (open, text, close) to its text.
            const flat = [];
            for (let k = 0; k < kids.length; k++) {
              if (kids[k].t === 3 && kids[k].auto && !kids[k].angle && kids[k + 1] && kids[k + 1].t === 0 && kids[k + 2] && kids[k + 2].t === 4) {
                flat.push(kids[k + 1]);
                k += 2;
              } else flat.push(kids[k]);
            }
            const open = { t: 3, href: hrefInline(href), title: title === null ? null : escAttr(title) };
            nodes.splice(startNi, 1, open, ...flat, { t: 4 });
          }
          // deactivate openers inside the link text
          openers.length = oi;
          i += consumed;
          resolved = true;
        } else {
          op.active = false;
          // a failed inline-link attempt whose `(` group is closed leaves
          // the emphasis inside the text literal (marked); without a
          // closing paren, or for a ref/shortcut, emphasis resolves normally.
          // But NOT when the link failed only because its text contains a
          // nested link (cm-519: the emphasis still forms there). The
          // suppression applies when the label is valid (the failure is
          // the destination's fault) or when the label holds a poisoned
          // code span (H1, I2, I6, I7); a merely unclosed backtick run
          // (I3) leaves the emphasis alone.
          if (!op.img && !hasLink && (textOk || hasPoisonedCodeSpan(rawLabel)) && text[after] === '(' && hasClosingParen(text, after)) {
            for (let k = startNi + 1; k < nodes.length; k++) {
              if (nodes[k].t === 2) { nodes[k].canOpen = false; nodes[k].canClose = false; }
            }
          }
        }
      }
      if (!resolved) { pushText(']'); i++; }
      continue;
    }
    // emphasis / strikethrough delimiters
    if (c === '*' || c === '_' || c === '~') {
      let m = 0;
      while (i + m < n && text[i + m] === c) m++;
      const prev = i > 0 ? text[i - 1] : '';
      const next = i + m < n ? text[i + m] : '';
      const prevWs = prev === '' || isSpaceCh(prev);
      const nextWs = next === '' || isSpaceCh(next);
      const prevPunct = prev !== '' && isPunct(prev);
      const nextPunct = next !== '' && isPunct(next);
      const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || prevPunct);
        canClose = rightFlank && (!leftFlank || nextPunct);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      // '~' runs longer than 2 cannot form del; keep them as delimiters of
      // length m but they will only pair when lengths match (1 or 2).
      // nextCh (the char after the run) is kept for the emphasis-blocking
      // rule in resolveEmphasis.
      pushDelim(c, m, canOpen, canClose, next);
      i += m;
      continue;
    }
    // autolink / html tag
    if (c === '<') {
      const al = matchAutolink(text, i);
      if (al) {
        // angle autolinks stay links even inside a formed link (marked);
        // bare URLs/emails do not (they are demoted there) — tag them
        const open = { t: 3, href: hrefBare(al.href), title: null, auto: true, angle: true };
        nodes.push(open, { t: 0, s: al.text }, { t: 4 });
        i += al.len;
        continue;
      }
      const tag = matchHtmlTag(text, i);
      if (tag) {
        // a raw <a> opens the "inside a link" state (bare autolinks stop
        // being recognised); </a> closes it (see inRawA above). But a
        // bare <a> or <a/> (name immediately followed by > or />) does NOT
        // open it (marked: only a tag with whitespace or attributes
        // after the name counts; S1/S2/S14/S15 vs S3-S11/S16).
        if (tag.name === 'a') {
          if (tag.closing) inRawA = false;
          else {
            const afterName = text.slice(i + 2, i + tag.len);
            if (afterName !== '>' && afterName !== '/>') inRawA = true;
          }
        }
        nodes.push({ t: 6, s: text.slice(i, i + tag.len) });
        i += tag.len;
        continue;
      }
      pushText('&lt;');
      i++;
      continue;
    }
    // entity
    if (c === '&') {
      const e = matchEntity(text, i);
      if (e) {
        if (e.numeric) pushText(e.out);
        else nodes.push({ t: 0, s: e.out, raw: true });
        i += e.len;
        continue;
      }
      pushText('&amp;');
      i++;
      continue;
    }
    // bare URL / www / xmpp / mailto / email
    // (H/F included: http/https/ftp schemes are case-insensitive)
    if (c === 'h' || c === 'f' || c === 'w' || c === 'x' || c === 'm' || c === 'H' || c === 'F') {
      // a bare URL inside link text must not swallow the `]` that closes
      // the text when a valid destination follows it (R7: the `]` then
      // closes the text; with no destination the `]` stays in the URL,
      // R4-R6). Mirror the `]` handler's destination checks.
      let brk = -1;
      if (openers.length) {
        let oi = openers.length - 1;
        while (oi >= 0 && !openers[oi].active) oi--;
        if (oi >= 0 && openers[oi].src < i) {
          let e = i;
          while (e < n && text[e] !== ' ' && text[e] !== '\t' && text[e] !== '\n' && text[e] !== '\r' && text[e] !== '<' && text[e].charCodeAt(0) >= 32 && text[e] !== '\u007f') e++;
          const b = text.indexOf(']', i);
          if (b !== -1 && b < e) {
            const op = openers[oi];
            let hasLink = false;
            if (!op.img) {
              for (let k = op.ni + 1; k < nodes.length; k++) {
                if (nodes[k].t === 3 && !nodes[k].auto) { hasLink = true; break; }
              }
            }
            if (!hasLink) {
              const after = b + 1;
              const rawLabel = text.slice(op.src + (op.img ? 2 : 1), b);
              let destOk = false;
              if (text[after] === '(' && linkTextOk(rawLabel)) {
                if (tryInlineLink(text, after)) destOk = true;
                else { const norm = normalizeLabel(rawLabel); if (norm && refs.has(norm)) destOk = true; }
              } else if (text[after] === '[' && linkTextOk(rawLabel)) {
                const close = text.indexOf(']', after + 1);
                if (close >= after + 1) {
                  const label = close === after + 1 ? rawLabel : text.slice(after + 1, close);
                  const norm = normalizeLabel(label);
                  if (norm && refs.has(norm)) destOk = true;
                }
              } else {
                const norm = normalizeLabel(rawLabel);
                if (norm && refs.has(norm)) destOk = true;
              }
              if (destOk) brk = b;
            }
          }
        }
      }
      // a bare URL inside a raw <a> element is not an autolink (marked)
      const bu = inRawA ? null : matchBareUrl(text, i, brk);
      if (bu) {
        const open = { t: 3, href: hrefBare(bu.href), title: null, auto: true };
        nodes.push(open, { t: 0, s: bu.text }, { t: 4 });
        i += bu.len;
        continue;
      }
    }
    // bare email (only at the start of a local-part run); not an autolink
    // inside a raw <a> element (marked)
    if (EMAIL_LOCAL.test(c) && (i === 0 || !EMAIL_LOCAL.test(text[i - 1]))) {
      const em = inRawA ? null : matchBareEmail(text, i, underCloserAt);
      if (em) {
        const open = { t: 3, href: 'mailto:' + em, title: null, auto: true };
        nodes.push(open, { t: 0, s: em }, { t: 4 });
        i += em.length;
        continue;
      }
    }
    // plain text run
    let j = i + 1;
    while (j < n) {
      const ch = text[j];
      if (ch === '\n' || ch === '\\' || ch === '`' || ch === '[' || ch === ']' || ch === '*' || ch === '_' || ch === '~' || ch === '<' || ch === '&' || ch === '!') break;
      if ((ch === 'h' || ch === 'f' || ch === 'w' || ch === 'x' || ch === 'm' || ch === 'H' || ch === 'F')) break;
      if (EMAIL_LOCAL.test(ch) && !EMAIL_LOCAL.test(text[j - 1])) break;
      j++;
    }
    pushText(text.slice(i, j));
    i = j;
  }

  // ---- assign link ids (which link each delimiter is inside) ----
  let linkDepth = 0, linkId = 0;
  const linkStack = [];
  for (const nd of nodes) {
    if (nd.t === 3) { linkId++; linkStack.push(linkId); }
    else if (nd.t === 4) { linkStack.pop(); }
    else if (nd.t === 2) { nd.linkId = linkStack.length ? linkStack[linkStack.length - 1] : 0; }
  }
  linkDepth = linkId;

  // marked quirk: a link whose text holds >= 2 unpaired backtick runs
  // ("poisoned", e.g. `issue ``small``) suppresses ALL emphasis pairs
  // (*, _, **, __) after the link up to the next code span in the same
  // block; emphasis after that code span resolves normally (I1-I8).
  // With no code span after the link there is no suppression (I5), and
  // a code span BEFORE the emphasis does not suppress it (I6). A proper
  // code span in the link text is not poisoned (its backticks are not
  // literal text, H7). Suppressed delimiters are dropped from the
  // resolution list only; they stay in `nodes` and render literally.
  {
    const suppressed = new Set();
    for (let k = 0; k < nodes.length; k++) {
      if (nodes[k].t !== 3) continue;
      let depth = 1, closeIdx = -1;
      for (let m = k + 1; m < nodes.length; m++) {
        if (nodes[m].t === 3) depth++;
        else if (nodes[m].t === 4) { depth--; if (depth === 0) { closeIdx = m; break; } }
      }
      if (closeIdx < 0) continue;
      let label = '';
      for (let m = k + 1; m < closeIdx; m++) if (nodes[m].t === 0) label += nodes[m].s;
      if (unpairedBacktickRuns(label) < 2) continue;
      let codeIdx = -1;
      for (let m = closeIdx + 1; m < nodes.length; m++) {
        if (nodes[m].t === 1) { codeIdx = m; break; }
      }
      if (codeIdx < 0) continue;
      // only top-level delimiters are suppressed: emphasis inside
      // another link's text still resolves normally (doc-35
      // [default run*fast*] keeps its <em> even inside the window)
      for (let m = closeIdx + 1; m < codeIdx; m++) {
        if (nodes[m].t === 2 && nodes[m].linkId === 0) suppressed.add(nodes[m]);
      }
    }
    if (suppressed.size) {
      for (let k = delims.length - 1; k >= 0; k--) {
        if (suppressed.has(delims[k])) delims.splice(k, 1);
      }
    }
  }

  // ---- emphasis / strikethrough resolution (spec appendix algorithm) ----
  resolveEmphasis(nodes, delims);

  return renderInline(nodes);
}

function resolveEmphasis(nodes, delims) {
  // Build a doubly-linked list over delims (only those with len>0).
  const alive = delims.filter(d => d.len > 0);
  if (!alive.length) return;
  const nextOf = new Map(), prevOf = new Map();
  for (let k = 0; k < alive.length; k++) {
    if (k > 0) prevOf.set(alive[k], alive[k - 1]);
    if (k < alive.length - 1) nextOf.set(alive[k], alive[k + 1]);
  }
  // formed emphasis boundaries [openId, closeId, use]: a delimiter inside
  // one cannot pair with a delimiter outside it (cm-469, cm-470); `use`
  // (1 = em, 2 = strong) is kept for the blocking rule below
  const formed = [];
  const wordCh = /[\p{L}\p{N}]/u;
  function insideFormed(id) {
    for (let k = 0; k < formed.length; k++) {
      if (formed[k][0] < id && id < formed[k][1]) return true;
    }
    return false;
  }
  let cur = alive.find(d => d.canClose);
  while (cur) {
    // look back for an opener
    let opener = prevOf.get(cur);
    let found = null;
    // set when the K-rule is relevant for this closer but does not
    // block (cur.len > 2): the pair forms and the closer's leftover
    // delimiters render INSIDE the emphasis (see renderer)
    let kInside = false;
    while (opener) {
      if (opener.ch === cur.ch && opener.canOpen && opener.len > 0 && opener.linkId === cur.linkId && !insideFormed(opener.id)) {
        if (cur.ch === '~') {
          // strikethrough: lengths must match and be 1 or 2
          if (opener.len !== cur.len || cur.len > 2) {
            opener = prevOf.get(opener);
            continue;
          }
        } else {
          const eitherBoth = (opener.canOpen && opener.canClose) || (cur.canOpen && cur.canClose);
          if (eitherBoth) {
            const sum = opener.orig + cur.orig;
            if (sum % 3 === 0 && !(opener.orig % 3 === 0 && cur.orig % 3 === 0)) {
              opener = prevOf.get(opener);
              continue;
            }
          }
        }
        if (cur.ch !== '~') {
          // marked quirk (K-rule): an inner pair of a different length
          // (em vs strong) whose closer is immediately followed by a
          // letter/digit, and whose opener cannot close, blocks the
          // outer pair (e.g. `*a **b**c*` stays literal, while
          // `*a **b** c*`, `*a *b*c*` and `*x**b**c*` all form).
          // Same-length inner pairs and cross-char pairs do not block.
          // The block only applies when the closer run is short
          // (cur.len <= 2): a run of 3+ leaves the outer pair forming
          // (`**a *b*c***` -> <strong>a <em>b</em>c*</strong>,
          // `*a **b**c***` -> <em>a <strong>b</strong>c**</em>),
          // while a run of 1-2 blocks (`**a *b*c**` and
          // `*a **b**c**` both stay literal for the outer pair).
          // When the rule is relevant but the run is long, the pair
          // forms and the closer's leftover renders INSIDE (kInside).
          const use0 = (opener.len >= 2 && cur.len >= 2) ? 2 : 1;
          let blocked = false;
          for (let k = 0; k < formed.length; k++) {
            const fp = formed[k];
            if (fp[0] > opener.id && fp[1] < cur.id && fp[2] !== use0) {
              const iOp = delims[fp[0]], iCl = delims[fp[1]];
              if (iOp.ch === cur.ch && !iOp.canClose && wordCh.test(iCl.nextCh)) {
                if (cur.len <= 2) { blocked = true; }
                else { kInside = true; }
                break;
              }
            }
          }
          if (blocked) { opener = prevOf.get(opener); continue; }
        }
        found = opener;
        break;
      }
      opener = prevOf.get(opener);
    }
    if (found) {
      let use;
      if (cur.ch === '~') {
        use = found.len;
      } else {
        use = (found.len >= 2 && cur.len >= 2) ? 2 : 1;
      }
      found.opens.push({ n: use, ch: found.ch });
      cur.closes.push({ n: use, ch: cur.ch });
      if (kInside) cur.leftoverInside = true;
      formed.push([found.id, cur.id, use]);
      found.len -= use;
      cur.len -= use;
      if (found.len === 0) {
        const p = prevOf.get(found), nx = nextOf.get(found);
        if (p) nextOf.set(p, nx); if (nx) prevOf.set(nx, p);
      }
      if (cur.len === 0) {
        const nx = nextOf.get(cur);
        cur = nx;
        while (cur && !cur.canClose) cur = nextOf.get(cur);
      }
      // else cur stays (still a closer with delimiters left)
    } else {
      let nx = nextOf.get(cur);
      while (nx && !nx.canClose) nx = nextOf.get(nx);
      cur = nx;
    }
  }
}

function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 0:
        out += nd.raw ? nd.s : escText(nd.s);
        break;
      case 1:
        out += '<code>' + escCode(nd.s) + '</code>';
        break;
      case 2: {
        // close tags, leftover literal, open tags
        const usedClose = nd.closes.reduce((a, s) => a + s.n, 0);
        const usedOpen = nd.opens.reduce((a, s) => a + s.n, 0);
        const leftover = nd.orig - usedClose - usedOpen;
        // a pure closer whose pair formed under the K-rule (relevant
        // but non-blocking, see resolveEmphasis) renders its leftover
        // delimiters INSIDE the emphasis, before the closing tag
        // (`**a *b*c***` -> <strong>a <em>b</em>c*</strong>); any other
        // closer renders them outside, after the tag (`*foo**` ->
        // <em>foo</em>*)
        if (leftover > 0 && nd.leftoverInside && nd.closes.length > 0 && nd.opens.length === 0) {
          out += escText(nd.ch.repeat(leftover));
        }
        for (const s of nd.closes) out += s.ch === '~' ? '</del>' : s.n === 2 ? '</strong>' : '</em>';
        if (leftover > 0 && !(nd.leftoverInside && nd.closes.length > 0 && nd.opens.length === 0)) out += escText(nd.ch.repeat(leftover));
        for (let k = nd.opens.length - 1; k >= 0; k--) {
          const s = nd.opens[k];
          out += s.ch === '~' ? '<del>' : s.n === 2 ? '<strong>' : '<em>';
        }
        break;
      }
      case 3:
        out += '<a href="' + nd.href + '"' + (nd.title !== null ? ' title="' + nd.title + '"' : '') + '>';
        break;
      case 4:
        out += '</a>';
        break;
      case 5:
        out += '<img src="' + nd.src + '" alt="' + escAttr(altTextOf(nd)) + '"' + (nd.title !== null ? ' title="' + nd.title + '"' : '') + '>';
        break;
      case 6:
        out += nd.s;
        break;
      case 7:
        out += '<br>';
        break;
      case 8:
        out += '\n';
        break;
      case 9:
        out += '[';
        break;
      case 10:
        out += '![';
        break;
    }
  }
  return out;
}

// ===================== BLOCK PARSER =====================
// Cursor over one line, tracking absolute column (tabs expand to the next
// multiple of 4). A tab straddling a consumed boundary is expanded into
// spaces and only the consumed part is removed (partial-tab handling).
function curRest(cur) { return cur.s.slice(cur.p); }
function curIsBlank(cur) {
  const s = cur.s; let i = cur.p;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i >= s.length;
}
function curCol(cur) { return cur.col; }
// Skip n columns of leading whitespace. Returns false if the line runs out
// of whitespace before n columns (i.e. it is not indented enough).
function curSkipWs(cur, n) {
  const s = cur.s;
  while (n > 0 && cur.p < s.length) {
    const ch = s[cur.p];
    if (ch === ' ') { cur.p++; cur.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (cur.col % 4);
      if (w <= n) { cur.p++; cur.col += w; n -= w; }
      else {
        // partial tab: expand into spaces, consume n of them
        cur.s = s.slice(0, cur.p) + '    '.slice(0, w) + s.slice(cur.p + 1);
        cur.p += n; cur.col += n; n = 0;
      }
    } else return false;
  }
  return n === 0;
}
// Skip up to n columns of whitespace (never fails).
function curSkipWsUpTo(cur, n) {
  const s = cur.s;
  while (n > 0 && cur.p < s.length) {
    const ch = s[cur.p];
    if (ch === ' ') { cur.p++; cur.col++; n--; }
    else if (ch === '\t') {
      const w = 4 - (cur.col % 4);
      if (w <= n) { cur.p++; cur.col += w; n -= w; }
      else {
        cur.s = s.slice(0, cur.p) + '    '.slice(0, w) + s.slice(cur.p + 1);
        cur.p += n; cur.col += n; n = 0;
      }
    } else break;
  }
}
function saveCur(cur) { return { s: cur.s, p: cur.p, col: cur.col }; }
// Strip up to n columns of indent from a FENCED-code content line
// (marked: a tab consumed here counts as exactly 1 column and is
// removed whole — unlike the spec's expansion to the next tab stop,
// which would leave (width - n) spaces behind).
function fenceStripIndent(cur, n) {
  const s = cur.s;
  while (n > 0 && cur.p < s.length) {
    const ch = s[cur.p];
    if (ch === ' ') { cur.p++; cur.col++; n--; }
    else if (ch === '\t') { cur.p++; cur.col += 4 - (cur.col % 4); n--; }
    else break;
  }
}
function restoreCur(cur, sv) { cur.s = sv.s; cur.p = sv.p; cur.col = sv.col; }

// ---- block-start matchers (operate on the content string after container
// stripping; they skip up to 3 leading spaces themselves) ----
function skip3(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  return i;
}
function matchATX(s) {
  const i = skip3(s);
  if (s[i] !== '#') return null;
  let j = i;
  while (j < s.length && s[j] === '#') j++;
  const level = j - i;
  if (level > 6) return null;
  if (j < s.length && s[j] !== ' ' && s[j] !== '\t') return null;
  let text = s.slice(j);
  // strip trailing spaces, then a closing sequence of #'s preceded by space,
  // then leading/trailing spaces
  text = text.replace(/[ \t]+$/, '');
  text = text.replace(/[ \t]+#+$/, '');
  text = text.replace(/^[ \t]+/, '');
  text = text.replace(/[ \t]+$/, '');
  return { level, text };
}
function matchFence(s) {
  const i = skip3(s);
  const ch = s[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  if (ch === '`' && s.indexOf('`', j) >= 0) return null;
  return { ch, len, info: s.slice(j), indent: i };
}
function isHrLine(s) {
  const i = skip3(s);
  const ch = s[i];
  if (ch !== '-' && ch !== '*' && ch !== '_') return null;
  let n = 0, j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === ch) { n++; j++; }
    else if (c === ' ' || c === '\t') j++;
    else return null;
  }
  return n >= 3 ? ch : null;
}
// Setext underline: ^ {0,3}(=+|-+)[ \t]*$  (tabs in the indent disqualify)
function matchSetext(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= s.length) return null;
  const ch = s[i];
  if (ch !== '=' && ch !== '-') return null;
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k < s.length) return null;
  return ch;
}
// List marker at the start of s (after up to 3 spaces). Returns null or
// {bullet|ordered, marker, num, delim, after} where `after` is the index
// just past the marker.
function matchListMarker(s) {
  const i = skip3(s);
  const ch = s[i];
  if (ch === '-' || ch === '+' || ch === '*') {
    if (s[i + 1] !== ' ' && s[i + 1] !== '\t' && s[i + 1] !== undefined) return null;
    return { bullet: true, marker: ch, after: i + 1, indent: i };
  }
  if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    const numStr = s.slice(i, j);
    if (numStr.length > 9) return null;
    const d = s[j];
    if (d !== '.' && d !== ')') return null;
    if (s[j + 1] !== ' ' && s[j + 1] !== '\t' && s[j + 1] !== undefined) return null;
    return { bullet: false, num: parseInt(numStr, 10), delim: d, after: j + 1, indent: i };
  }
  return null;
}
// HTML block start detection. Returns {type, end} or null. `end` is a
// substring (case-insensitive) whose presence on a line ends the block
// (types 1-5); types 6-7 end at a blank line (end = null).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));
function matchHtmlBlockStart(s) {
  const i = skip3(s);
  if (s[i] !== '<') return null;
  const rest = s.slice(i);
  const low = rest.toLowerCase();
  // type 1: script/pre/style/textarea (open tag only)
  let m = /^<(script|pre|style|textarea)([ \t>]|$)/.exec(low);
  if (m) return { type: 1, end: '</' + m[1] };
  // type 2: comment
  if (low.startsWith('<!--')) return { type: 2, end: '-->' };
  // type 3: processing instruction
  if (low.startsWith('<?')) return { type: 3, end: '?>' };
  // type 4: declaration <!Letter
  if (/^<![a-z]/i.test(rest)) return { type: 4, end: '>' };
  // type 5: CDATA
  if (low.startsWith('<![cdata[')) return { type: 5, end: ']]>' };
  // type 6: block-level tag (open or close), followed by space/tab/>/end
  m = /^<\/?([a-z][a-z0-9-]*)([ \t>]|$)/i.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, end: null };
  // type 7: a complete open/close tag alone on the line
  const tag = matchHtmlTag(s, i);
  if (tag) {
    let k = i + tag.len;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k >= s.length) return { type: 7, end: null };
  }
  return null;
}

// ---- link reference definitions (parsed from paragraph lines) ----
// tryParseDef(lines, idx): the def may span lines (label, destination and
// title can each be on following lines). Returns {consumed, label, dest,
// title} or null. `consumed` counts the lines used.
function tryParseDef(lines, idx) {
  const s = lines.slice(idx).join('\n');
  let p = 0;
  while (p < s.length && s[p] === ' ' && p < 3) p++;
  if (s[p] !== '[') return null;
  p++;
  let label = '', closed = false;
  while (p < s.length) {
    const ch = s[p];
    // keep backslash escapes in the label (a label 'foo\!' does not match a
    // definition 'foo!'); an escaped ']' does not close the label
    if (ch === '\\' && p + 1 < s.length) { label += ch + s[p + 1]; p += 2; continue; }
    if (ch === ']') { closed = true; p++; break; }
    if (ch === '[') return null;
    label += ch; p++;
  }
  if (!closed) return null;
  const norm = normalizeLabel(label);
  if (!norm || norm.length > 999) return null;
  if (s[p] !== ':') return null;
  p++;
  // destination: spaces on this line; a newline moves to the next line
  // (whose leading whitespace is skipped); a tab here is invalid
  while (p < s.length && s[p] === ' ') p++;
  if (s[p] === '\t') return null;
  if (s[p] === '\n') {
    p++;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++;
    if (p >= s.length || s[p] === '\n') return null;
  }
  if (p >= s.length) return null;
  let dest = '';
  if (s[p] === '<') {
    // the closing > must be unescaped (an escaped \> does not close it)
    let end = -1;
    for (let e = p + 1; e < s.length; e++) {
      if (s[e] === '\\' && e + 1 < s.length && isAsciiPunct(s[e + 1])) { e++; continue; }
      if (s[e] === '>') { end = e; break; }
      if (s[e] === '\n' || s[e] === '<') break;
    }
    if (end < 0) return null;
    dest = s.slice(p + 1, end);
    p = end + 1;
  } else {
    let depth = 0, m = p;
    while (m < s.length) {
      const ch = s[m];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) break;
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (ch === '\\' && m + 1 < s.length && isAsciiPunct(s[m + 1])) { m += 2; continue; }
      m++;
    }
    if (depth !== 0) return null;
    dest = s.slice(p, m);
    if (!dest) return null;
    p = m;
  }
  dest = unescapeStr(dest);
  // title: optional, separated from the destination by whitespace; it may
  // be on the same line, the next line, or span several lines. If the title
  // does not parse cleanly, the definition is still valid without a title
  // (the would-be title line is then ordinary paragraph text).
  let title = null;
  let q = p, hadWs = false;
  while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) { hadWs = true; q++; }
  if (hadWs && q < s.length && (s[q] === '"' || s[q] === "'" || s[q] === '(')) {
    const open = s[q];
    const close = open === '(' ? ')' : open;
    let v = '', t = q + 1, ok = false;
    while (t < s.length) {
      if (s[t] === '\\' && t + 1 < s.length && isAsciiPunct(s[t + 1])) { v += s[t + 1]; t += 2; continue; }
      if (s[t] === close) { ok = true; break; }
      v += s[t]; t++;
    }
    if (ok) {
      let r = t + 1;
      while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
      if (r >= s.length || s[r] === '\n') { title = v; p = r; }
    }
  }
  if (title === null) {
    let r = p;
    while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
    if (r < s.length && s[r] !== '\n') return null; // junk after destination
    p = r;
  }
  let consumed = 1;
  for (let k = 0; k < p; k++) if (s[k] === '\n') consumed++;
  return { consumed, label: norm, dest, title };
}
function extractDefs(lines, refs) {
  let idx = 0;
  while (idx < lines.length) {
    const r = tryParseDef(lines, idx);
    if (!r) break;
    if (!refs.has(r.label)) refs.set(r.label, { dest: r.dest, title: r.title });
    idx += r.consumed;
  }
  return lines.slice(idx);
}

// ---- tables ----
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (s[i] === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur);
  return cells;
}
function isTableDelimiter(line) {
  const cells = splitTableRow(line);
  if (!cells.length) return false;
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c.trim())) return false;
  }
  return true;
}
function isTableLines(lines) {
  if (lines.length < 2) return false;
  if (!/(^|[^\\])\|/.test(lines[0])) return false;
  if (!isTableDelimiter(lines[1])) return false;
  // the delimiter row must have as many cells as the header row
  return splitTableRow(lines[0]).length === splitTableRow(lines[1]).length;
}
function buildTable(lines) {
  const dCells = splitTableRow(lines[1]);
  const aligns = dCells.map(c => {
    const t = c.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.startsWith(':')) return 'left';
    if (t.endsWith(':')) return 'right';
    return null;
  });
  const ncols = dCells.length;
  const header = splitTableRow(lines[0]).map(c => c.trim());
  while (header.length < ncols) header.push('');
  header.length = ncols;
  const rows = [];
  for (let k = 2; k < lines.length; k++) {
    const cells = splitTableRow(lines[k]).map(c => c.trim());
    while (cells.length < ncols) cells.push('');
    cells.length = ncols;
    rows.push(cells);
  }
  return { t: 'table', header, align: aligns, rows };
}
function finalizePara(leaf, refs) {
  const rest = extractDefs(leaf.lines, refs);
  if (rest.length === 0) return [];
  // a table may start partway through the paragraph (GFM: a table
  // interrupts a paragraph); find the first line that, with the next,
  // forms a table header + delimiter, and split there (M4)
  let tstart = -1;
  for (let k = 0; k + 1 < rest.length; k++) {
    if (isTableLines(rest.slice(k, k + 2))) { tstart = k; break; }
  }
  if (tstart < 0) return [{ t: 'para', lines: rest }];
  const out = [];
  if (tstart > 0) out.push({ t: 'para', lines: rest.slice(0, tstart) });
  out.push(buildTable(rest.slice(tstart)));
  return out;
}

// ---- main block parser ----
function parseBlocks(lines, endsWithNL) {
  const refs = new Map();
  const root = { t: 'doc', children: [], blank: false, blankBelow: false, loose: false };
  const stack = [root];
  let leaf = null; // open leaf: {t, node, parent, ...}
  let rawBlank = false; // the current raw line is entirely whitespace

  function top() { return stack[stack.length - 1]; }
  function isBlankLine(s) {
    for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
    return true;
  }
  // Is the remaining content (after container stripping) blank? A line is
  // blank iff the raw line is all whitespace or nothing remains after the
  // container markers (a leftover run of spaces, e.g. ">  ", is content).
  function curBlank(cur) { return rawBlank || cur.p >= cur.s.length; }
  // Count leading whitespace columns of s starting at column startCol.
  function leadingWsCols(s, startCol) {
    let col = startCol, i = 0;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
      if (s[i] === ' ') { i++; col++; }
      else { col += 4 - (col % 4); i++; }
    }
    return col - startCol;
  }
  function addBlock(frame, node) {
    if (frame.blankBelow && frame.children.length > 0) frame.loose = true;
    // this block consumes the pending blank: clear it on the frame and
    // all its ancestors (a blank only loosens the next block's container)
    const fi = stack.indexOf(frame);
    if (fi >= 0) {
      for (let k = fi; k >= 1; k--) {
        stack[k].blank = false;
        stack[k].blankBelow = false;
      }
    } else {
      frame.blank = false;
      frame.blankBelow = false;
    }
    frame.children.push(node);
    return node;
  }
  function setBlankFlag() {
    // direct blank on the innermost frame; blankBelow propagates up through
    // lists/items but stops at a blockquote (a blank inside a quote does
    // not separate the surrounding list items)
    for (let k = stack.length - 1; k >= 1; k--) {
      stack[k].blankBelow = true;
      if (k === stack.length - 1) stack[k].blank = true;
      if (stack[k].t === 'quote') break;
    }
  }
  // Does line nextIdx stay inside the containers up to stack depth parentDepth?
  // (Used for the HTML block trailing-newline rule.)
  // Simulate container matching for the next line; returns the remainder
  // after the container markers, or null if the line leaves the container.
  function nextLineRemainder(nextIdx, parentDepth) {
    if (nextIdx >= lines.length) return null;
    if (parentDepth < 1) return lines[nextIdx];
    const c2 = { s: lines[nextIdx], p: 0, col: 0 };
    for (let k = 1; k <= parentDepth && k < stack.length; k++) {
      const fr = stack[k];
      if (fr.t === 'quote') {
        const sv = saveCur(c2);
        curSkipWsUpTo(c2, 3);
        if (c2.s[c2.p] === '>') { c2.p++; c2.col++; curSkipWsUpTo(c2, 1); }
        else { restoreCur(c2, sv); return null; }
      } else if (fr.t === 'item') {
        if (c2.p >= c2.s.length) return c2.s.slice(c2.p);
        const sv = saveCur(c2);
        // the item's content indent is relative to its base column
        // (already consumed by the outer frames), as in matchItem
        const need = fr.contentIndent;
        if (!(need <= 0 || curSkipWs(c2, need))) { restoreCur(c2, sv); return null; }
      }
      if (c2.p >= c2.s.length) return c2.s.slice(c2.p);
    }
    return c2.s.slice(c2.p);
  }
  function closeLeafHtml(lastIdx, how) {
    const node = leaf.node;
    let text = node.lines.join('\n');
    let addNL = false;
    if (how === 'endcond') {
      const nextIdx = lastIdx + 1;
      if (nextIdx >= lines.length) addNL = endsWithNL;
      else {
        // trailing newline iff the next line stays in the container and its
        // remainder is non-empty (a whitespace-only line still counts)
        const rem = nextLineRemainder(nextIdx, stack.indexOf(leaf.parent));
        if (rem !== null && rem.length > 0) addNL = true;
      }
    } else if (how === 'eof') {
      addNL = endsWithNL;
    }
    // 'blank' and 'container': no trailing newline
    if (addNL) text += '\n';
    node.text = text;
    leaf = null;
  }
  function closeLeaf(lastIdx, how) {
    if (!leaf) return;
    const node = leaf.node, par = leaf.parent;
    if (leaf.t === 'para') {
      const fins = finalizePara(leaf, refs);
      const arr = par.children;
      // finalizePara returns an array (a paragraph split by a table that
      // interrupts it yields two nodes); an empty array drops the leaf
      arr.splice(arr.length - 1, 1, ...fins);
    } else if (leaf.t === 'html') {
      closeLeafHtml(lastIdx === undefined ? leaf.lastIdx : lastIdx, how || 'container');
    } else if (leaf.t === 'fence' && par.t === 'item' && !leaf.anchored) {
      // a fence in a list item that never anchored (no non-blank content
      // line matched all containers) and never closed keeps none of its
      // whitespace-only content lines (a closed fence never reaches
      // here: closing it clears the leaf first)
      node.lines.length = 0;
    }
    // fence / code need no finalization (pending blanks are dropped)
    leaf = null;
  }
  function matchQuote(cur) {
    const sv = saveCur(cur);
    curSkipWsUpTo(cur, 3);
    if (cur.s[cur.p] === '>') {
      cur.p++; cur.col++;
      curSkipWsUpTo(cur, 1);
      return true;
    }
    restoreCur(cur, sv);
    return false;
  }
  function matchItem(cur, fr) {
    // a blank line is inside the item, but the item's indent is still
    // consumed from it (so a whitespace-only line inside a fenced code
    // block keeps only its remainder after the item indent, as marked
    // outdents the item body before lexing it)
    if (curBlank(cur)) { curSkipWsUpTo(cur, fr.contentIndent); return true; }
    const sv = saveCur(cur);
    if (curSkipWs(cur, fr.contentIndent)) return true;
    restoreCur(cur, sv);
    return false;
  }
  // Is `content` a line that can be a lazy paragraph continuation?
  function isLazyLine(content) {
    if (!content || isBlankLine(content)) return false;
    if (matchATX(content)) return false;
    if (matchFence(content)) return false;
    if (isHrLine(content)) return false;
    const hb = matchHtmlBlockStart(content);
    if (hb && hb.type <= 6) return false;
    const q = skip3(content);
    if (content[q] === '>') return false;
    if (matchSetext(content)) return true; // setext lines become lazy text
    const lm = matchListMarker(content);
    if (lm) {
      // a list marker interrupts a paragraph only if non-empty and
      // (bullet, or ordered starting with 1)
      let j = lm.after;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      if (j >= content.length) return true; // empty item: lazy
      if (lm.bullet || lm.num === 1) return false;
    }
    return true;
  }
  function listCanInterrupt(lm, content) {
    let j = lm.after;
    while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
    if (j >= content.length) return false;
    // a paragraph directly inside a list item is interrupted by ANY
    // ordered list marker (marked: `- foo\n  0. bar` starts a nested
    // list); at top level / in a quote only `1.` interrupts
    if (leaf && leaf.t === 'para' && leaf.parent && leaf.parent.t === 'item') return true;
    return lm.bullet || lm.num === 1;
  }
  function listContinues(list, lm) {
    if (list.bullet !== lm.bullet) return false;
    if (lm.bullet) return list.marker === lm.marker;
    return list.delim === lm.delim;
  }
  // does `content` start a new item of the innermost open list?
  function continuesOpenList(content) {
    const lm = matchListMarker(content);
    if (!lm) return false;
    for (let k = stack.length - 1; k >= 1; k--) {
      if (stack[k].t === 'list') return listContinues(stack[k], lm);
    }
    return false;
  }
  // is the open paragraph inside a list item? (a list marker line then
  // ends the item instead of being a lazy continuation)
  function paraInListItem() {
    if (!leaf || leaf.t !== 'para') return false;
    const pi = stack.indexOf(leaf.parent);
    if (pi < 0) return false;
    for (let k = pi; k >= 1; k--) {
      if (stack[k].t === 'item') return true;
    }
    return false;
  }

  for (let li = 0; li < lines.length; li++) {
    rawBlank = isBlankLine(lines[li]);
    const cur = { s: lines[li], p: 0, col: 0 };
    // ---- phase 1: match containers (outermost first) ----
    let failAt = -1;
    let fenceQuoteClose = false; // set when a line is absorbed as fence content past a failing quote
    for (let k = 1; k < stack.length; k++) {
      const fr = stack[k];
      if (fr.t === 'quote') {
        if (!matchQuote(cur)) { failAt = k; break; }
      } else if (fr.t === 'item') {
        if (!matchItem(cur, fr)) { failAt = k; break; }
      }
      // list frames are transparent
      // (no blank-line break here: a blank line must still be offered
      // to deeper item frames, so they can consume their indent, and
      // to deeper quote frames, which it fails — a blank line without
      // '>' ends a quote at any depth)
    }
    if (failAt >= 0) {
      // A fenced code block inside a list item: a line that fails the
      // item match is fence content ONLY once the fence is anchored (it
      // already holds a non-blank content line that matched all of its
      // containers) and only when the line is not a block start (ATX,
      // hr, fence, blockquote, list marker, HTML block type 1-6).
      // Before the anchor, or at a block start, the line ends the fence
      // and the item and is re-processed outside them (so a
      // closing-fence-looking line opens a NEW fence there). A
      // setext-looking line (not an hr) is absorbed as content with its
      // leading spaces raised to max(4, n) (a tab is kept). When the
      // failing frame is a quote, an absorbed line is the last line of
      // that quote: the fence closes and the quote pops after it.
      let fenceFall = false;
      // a blank line never falls through as fence content here: it ends
      // the quote (and the fence) instead (a blank line inside a fence
      // in a bare item never reaches this branch: it matches the item)
      if (leaf && leaf.t === 'fence' && leaf.parent.t === 'item' && !curBlank(cur)) {
        const rest = curRest(cur);
        const hb = matchHtmlBlockStart(rest);
        const blockStart = !!isHrLine(rest) || !!matchATX(rest) || !!matchFence(rest) || /^ {0,3}>/.test(rest) || !!matchListMarker(rest) || !!(hb && hb.type !== 7);
        if (leaf.anchored && !blockStart) {
          const se = matchSetext(rest);
          if (se) {
            if (rest[0] === '\t') leaf.node.lines.push(rest);
            else {
              let n = 0;
              while (n < rest.length && rest[n] === ' ') n++;
              leaf.node.lines.push(' '.repeat(Math.max(4, n)) + rest.slice(n));
            }
            if (stack[failAt].t === 'quote') {
              while (stack.length > failAt + 1) {
                const fr = stack.pop();
                if (leaf && leaf.parent === fr) closeLeaf(li - 1, 'container');
              }
            }
            continue;
          }
          fenceFall = true;
          if (stack[failAt].t === 'quote') fenceQuoteClose = true;
        }
      }
      if (!fenceFall) {
      // A fence in a quote in a list item: a plain/setext line that fails
      // the item match ends the fence and the quote but NOT the item
      // (marked keeps the line as bare text in the item, Q2, C3-C6).
      // Block-start lines still pop the item (C1, C2). Applies whether
      // the fence is anchored or not (C5).
      let keptItem = false;
      if (leaf && leaf.t === 'fence' && leaf.parent.t === 'quote' && !curBlank(cur)) {
        const qIdx = stack.indexOf(leaf.parent);
        if (qIdx > 0 && stack[qIdx - 1].t === 'item' && stack[failAt] === stack[qIdx - 1]) {
          const rest = curRest(cur);
          const hb = matchHtmlBlockStart(rest);
          const blockStart = !!isHrLine(rest) || !!matchATX(rest) || !!matchFence(rest) || /^ {0,3}>/.test(rest) || !!matchListMarker(rest) || !!(hb && hb.type !== 7);
          if (!blockStart) {
            while (stack.length > failAt + 1) {
              const fr = stack.pop();
              if (leaf && leaf.parent === fr) closeLeaf(li - 1, 'container');
            }
            keptItem = true;
          }
        }
      }
      if (!keptItem) {
      // lazy continuation? (a list marker line inside a list item, or one
      // that continues the open list, is a new item/list, not a lazy line)
      const lazyContent = curRest(cur);
      const isListLine = matchListMarker(lazyContent) && paraInListItem();
      if (leaf && leaf.t === 'para' && !isListLine && !continuesOpenList(lazyContent) && isLazyLine(lazyContent)) {
        const content = curRest(cur);
        const firstFailed = stack[failAt];
        const se = matchSetext(content);
        if (se && leaf.lastLazy && firstFailed.t === 'quote') {
          // lazy setext line: leading spaces become max(4, n); a tab is kept
          if (content[0] === '\t') {
            leaf.lines.push(content);
          } else {
            let n = 0;
            while (n < content.length && content[n] === ' ') n++;
            leaf.lines.push(' '.repeat(Math.max(4, n)) + content.slice(n));
          }
        } else if (leadingWsCols(content, cur.col) >= 4) {
          // lazy line with >= 4 columns of indent: strip 4 columns
          curSkipWs(cur, 4);
          leaf.lines.push(curRest(cur));
        } else {
          leaf.lines.push(content);
        }
        leaf.lastLazy = true;
        continue;
      }
      // not lazy: close containers down to failAt
      while (stack.length > failAt) {
        const fr = stack.pop();
        if (leaf && leaf.parent === fr) closeLeaf(li - 1, 'container');
      }
      }
      }
    }
    // ---- phase 2: process the remaining content ----
    while (true) {
      // Expand leading tabs to spaces (based on the current column) when the
      // line is inside a container: marked expands a tab in the leading
      // whitespace of a line inside a blockquote/list item (fence content,
      // indented code, and paragraph text alike), but preserves it at the
      // top level. E.g. `- ```\n  \tfoo` gives code `  foo`, while a
      // top-level ```\n\tfoo gives code `\tfoo`. This runs inside the loop
      // (not phase 1) because the container that opens on this very line
      // is not in the stack yet during phase 1.
      if (stack.length > 1) {
        const rest0 = curRest(cur);
        let k = 0, col = cur.col, out = '';
        let changed = false;
        while (k < rest0.length && (rest0[k] === ' ' || rest0[k] === '\t')) {
          if (rest0[k] === '\t') {
            const sp = 4 - (col % 4);
            out += ' '.repeat(sp);
            col += sp;
            changed = true;
          } else {
            out += ' ';
            col++;
          }
          k++;
        }
        if (changed) cur.s = cur.s.slice(0, cur.p) + out + rest0.slice(k);
      }
      const content = curRest(cur);
      // fence leaf
      if (leaf && leaf.t === 'fence') {
        const f = matchFence(content);
        // a closing fence must have no info string
        if (f && f.ch === leaf.ch && f.len >= leaf.len && f.info.trim() === '') {
          leaf = null; // closing fence: not part of the content
        } else {
          const sv = saveCur(cur);
          // marked strips the opening fence's indent from content lines
          // only for backtick fences; a tilde fence keeps the content
          // indentation verbatim (F2/F3/F7/T6/T10/T12/U1/U3)
          if (leaf.ch === '`') fenceStripIndent(cur, leaf.indent);
          const pushed = curRest(cur);
          leaf.node.lines.push(pushed);
          // the fence is anchored once a non-blank content line arrived
          // inside all of its containers (a line that failed container
          // matching never anchors it)
          if (failAt < 0 && /\S/.test(pushed)) leaf.anchored = true;
          restoreCur(cur, sv);
        }
        break;
      }
      // indented-code leaf
      if (leaf && leaf.t === 'code') {
        if (/^[ \t]*$/.test(curRest(cur))) {
          // a blank line inside code keeps its remainder after 4 columns
          curSkipWsUpTo(cur, 4);
          leaf.pending.push(curRest(cur));
          break;
        }
        const sv = saveCur(cur);
        if (curSkipWs(cur, 4)) {
          for (const b of leaf.pending) leaf.node.lines.push(b);
          leaf.pending = [];
          leaf.node.lines.push(curRest(cur));
        } else {
          restoreCur(cur, sv);
          closeLeaf(li - 1);
          continue;
        }
        break;
      }
      // html leaf
      if (leaf && leaf.t === 'html') {
        if (curBlank(cur)) {
          if (leaf.node.type <= 5) {
            leaf.node.lines.push('');
            leaf.lastIdx = li;
          } else {
            closeLeaf(li - 1, 'blank');
            setBlankFlag();
          }
          break;
        }
        leaf.node.lines.push(content);
        leaf.lastIdx = li;
        if (leaf.node.end && content.toLowerCase().includes(leaf.node.end)) {
          closeLeaf(li, 'endcond');
        }
        break;
      }
      // paragraph leaf
      if (leaf && leaf.t === 'para') {
        if (curBlank(cur)) {
          // a line of only spaces + a single trailing tab inside a table
          // is an empty table row (marked); any other blank line ends
          // the table (and the paragraph)
          if (/^ *\t$/.test(content) && isTableLines(leaf.lines)) {
            leaf.lines.push(content);
            leaf.lastLazy = false;
            break;
          }
          closeLeaf(li - 1); setBlankFlag(); break;
        }
        const se = matchSetext(content);
        if (se) {
          // definitions come first: they are stripped before the setext
          // (or table) decision is made on the remaining lines
          const rest = extractDefs(leaf.lines, refs);
          if (rest.length === 0) {
            // the paragraph was only definitions: the setext line starts
            // a new paragraph instead
            closeLeaf(li - 1, 'container');
            continue;
          }
          if (isTableLines(rest)) {
            if (se === '-' && isHrLine(content)) {
              closeLeaf(li - 1, 'container');
              addBlock(top(), { t: 'hr' });
            } else {
              leaf.lines.push(content);
              leaf.lastLazy = false;
            }
          } else {
            const node = leaf.node;
            node.t = 'heading';
            node.level = se === '=' ? 1 : 2;
            // setext heading text: leading whitespace of the first line and
            // trailing whitespace of the last line are stripped
            node.text = rest.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            leaf = null;
          }
          break;
        }
        if (matchATX(content) || matchFence(content) || isHrLine(content)) {
          closeLeaf(li - 1);
          continue;
        }
        const hb = matchHtmlBlockStart(content);
        if (hb && hb.type <= 6) { closeLeaf(li - 1); continue; }
        if (content[skip3(content)] === '>') { closeLeaf(li - 1); continue; }
        const lm = matchListMarker(content);
        if (lm && listCanInterrupt(lm, content)) { closeLeaf(li - 1); continue; }
        if (leaf.parent && leaf.parent.t === 'item' && leadingWsCols(content, cur.col) >= 4) {
          // a paragraph continuation inside a list item with >= 4 columns
          // of indent past the item indent loses 4 columns (marked; the
          // lazy branch already does this for lines that fail container
          // matching). At the top level or in a quote the indent is kept.
          curSkipWs(cur, 4);
          leaf.lines.push(curRest(cur));
        } else {
          leaf.lines.push(content);
        }
        leaf.lastLazy = false;
        break;
      }
      // no leaf open: start a new block
      if (top().t === 'list' && !curBlank(cur) && (!matchListMarker(content) || isHrLine(content))) {
        stack.pop();
        continue; // re-process the line at the parent level
      }
      if (curBlank(cur)) {
        // a blank line after an empty item closes the item (the list stays
        // open for a following item; a non-marker line will close the list)
        setBlankFlag();
        if (top().t === 'item' && top().children.length === 0) {
          stack.pop();
        }
        break;
      }
      // a whitespace-only line cannot start a block (cm-240)
      if (/^[ \t]*$/.test(content)) { setBlankFlag(); break; }
      const atx = matchATX(content);
      if (atx) { addBlock(top(), { t: 'heading', level: atx.level, text: atx.text }); break; }
      const fe = matchFence(content);
      if (fe) {
        const infoTrim = fe.info.replace(/^[ \t]+/, '');
        const lang = unescapeStr(infoTrim.split(/[ \t]/)[0] || '');
        const node = { t: 'fence', ch: fe.ch, len: fe.len, lang, lines: [] };
        addBlock(top(), node);
        leaf = { t: 'fence', node, parent: top(), ch: fe.ch, len: fe.len, indent: fe.indent, anchored: false };
        break;
      }
      if (isHrLine(content)) { addBlock(top(), { t: 'hr' }); break; }
      if (content[skip3(content)] === '>') {
        const quote = { t: 'quote', children: [], blank: false, blankBelow: false, loose: false };
        addBlock(top(), quote);
        stack.push(quote);
        curSkipWsUpTo(cur, 3);
        cur.p++; cur.col++;
        curSkipWsUpTo(cur, 1);
        continue;
      }
      const lm = matchListMarker(content);
      if (lm) {
        const t0 = top();
        let list = null;
        if (t0.t === 'list' && listContinues(t0, lm)) {
          list = t0;
        } else {
          if (t0.t === 'list') stack.pop();
          list = { t: 'list', bullet: lm.bullet, marker: lm.bullet ? lm.marker : null, delim: lm.bullet ? null : lm.delim, start: lm.bullet ? 1 : lm.num, children: [], blank: false, blankBelow: false, loose: false };
          addBlock(top(), list);
          stack.push(list);
        }
        // compute the item's content indent, relative to the
        // container-stripped content start (so >> and > > line up)
        const baseCol = cur.col;
        curSkipWsUpTo(cur, lm.indent);
        cur.p += lm.after - lm.indent; cur.col += lm.after - lm.indent;
        const markerEndCol = cur.col;
        let j = cur.p, col = cur.col, ws = 0;
        while (j < cur.s.length && (cur.s[j] === ' ' || cur.s[j] === '\t')) {
          if (cur.s[j] === ' ') { j++; col++; ws++; }
          else { const w = 4 - (col % 4); j++; col += w; ws += w; }
        }
        const hasContent = j < cur.s.length;
        let contentCol;
        if (!hasContent || ws >= 5) {
          contentCol = markerEndCol + 1;
          curSkipWs(cur, 1);
        } else {
          contentCol = col;
          cur.p = j; cur.col = col;
        }
        const contentIndent = contentCol - baseCol;
        // new item: looseness from a blank inside the previous item
        const prev = list.children[list.children.length - 1];
        if (prev && prev.blankBelow) list.loose = true;
        const item = { t: 'item', children: [], blank: false, blankBelow: false, loose: false, contentIndent, task: null };
        list.children.push(item);
        stack.push(item);
        // task list marker: [ ] / [x] / [X] followed by whitespace
        const rest = curRest(cur);
        if (rest.length >= 3 && rest[0] === '[' && (rest[1] === ' ' || rest[1] === 'x' || rest[1] === 'X') && rest[2] === ']' && (rest[3] === ' ' || rest[3] === '\t')) {
          item.task = rest[1] === ' ' ? ' ' : 'x';
          cur.p += 3; cur.col += 3;
          while (cur.p < cur.s.length && (cur.s[cur.p] === ' ' || cur.s[cur.p] === '\t')) { cur.p++; cur.col++; }
        }
        if (/^[ \t]*$/.test(curRest(cur))) break; // empty item: no content, no blank flag
        continue; // process the item's content
      }
      const hb2 = matchHtmlBlockStart(content);
      if (hb2) {
        const node = { t: 'html', type: hb2.type, end: hb2.end, lines: [content], text: '' };
        addBlock(top(), node);
        leaf = { t: 'html', node, parent: top(), lastIdx: li };
        if (hb2.end && content.toLowerCase().includes(hb2.end)) closeLeaf(li, 'endcond');
        break;
      }
      // indented code: indent >= 4
      {
        const sv = saveCur(cur);
        if (curSkipWs(cur, 4)) {
          const node = { t: 'code', lines: [curRest(cur)] };
          addBlock(top(), node);
          leaf = { t: 'code', node, parent: top(), pending: [] };
          break;
        }
        restoreCur(cur, sv);
      }
      // paragraph
      {
        const node = { t: 'para', lines: [content] };
        addBlock(top(), node);
        leaf = { t: 'para', node, parent: top(), lines: node.lines, lastLazy: false };
        break;
      }
    }
    if (fenceQuoteClose) {
      // a line absorbed as fence content past a failing quote was the
      // last line of that quote: close the fence and pop the frames
      // above the quote (the quote itself stays open)
      while (stack.length > failAt + 1) {
        const fr = stack.pop();
        if (leaf && leaf.parent === fr) closeLeaf(li - 1, 'container');
      }
    }
  }
  closeLeaf(lines.length - 1, 'eof');
  return { root, refs };
}

// ===================== RENDERER =====================
function renderBlocks(nodes, refs) {
  let out = '';
  for (const nd of nodes) out += renderBlock(nd, refs);
  return out;
}
function renderBlock(nd, refs) {
  switch (nd.t) {
    case 'para':
      return '<p>' + inlineParse(nd.lines.join('\n'), refs) + '</p>\n';
    case 'heading':
      return '<h' + nd.level + '>' + inlineParse(nd.text, refs) + '</h' + nd.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code':
    case 'fence': {
      // a fenced block drops exactly one trailing blank line
      const ls = nd.t === 'fence' && nd.lines.length && nd.lines[nd.lines.length - 1] === ''
        ? nd.lines.slice(0, -1) : nd.lines;
      const body = ls.join('\n');
      const cls = nd.t === 'fence' && nd.lang ? ' class="language-' + escAttr(nd.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escCode(body) + (body ? '\n' : '') + '</code></pre>\n';
    }
    case 'html':
      return nd.text;
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < nd.header.length; k++) {
        const a = nd.align[k] ? ' align="' + nd.align[k] + '"' : '';
        out += '<th' + a + '>' + inlineParse(nd.header[k], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (nd.rows.length) {
        out += '<tbody>';
        for (const row of nd.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = nd.align[k] ? ' align="' + nd.align[k] + '"' : '';
            out += '<td' + a + '>' + inlineParse(row[k], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    case 'quote': {
      let out = '<blockquote>\n';
      out += renderBlocks(nd.children, refs);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const loose = nd.loose || nd.children.some(it => it.loose);
      const tag = nd.bullet ? 'ul' : 'ol';
      const start = !nd.bullet && nd.start !== 1 ? ' start="' + nd.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const it of nd.children) out += renderItem(it, refs, loose);
      return out + '</' + tag + '>\n';
    }
  }
  return '';
}
function renderItem(it, refs, loose) {
  const check = it.task === null ? '' : (it.task === 'x'
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">');
  if (it.children.length === 0) return '<li>' + check + '</li>\n';
  let out = '<li>';
  let first = true;
  let seenList = false; // a paragraph after a nested list in the same item
  // renders with <p> even in a tight list (only the first paragraph of
  // a tight item, and paragraphs after non-list blocks, render bare)
  for (const ch of it.children) {
    if (ch.t === 'para') {
      const inner = inlineParse(ch.lines.join('\n'), refs);
      const wrap = loose || seenList;
      if (first && check) {
        out += wrap ? '<p>' + check + ' ' + inner + '</p>\n' : check + ' ' + inner;
      } else if (wrap) {
        out += '<p>' + inner + '</p>\n';
      } else {
        out += inner;
      }
    } else {
      if (ch.t === 'list') seenList = true;
      if (first && check) out += check + ' ';
      out += renderBlock(ch, refs);
    }
    first = false;
  }
  return out + '</li>\n';
}

// ===================== ENTRY =====================
export function parse(markdown) {
  const md = String(markdown).replace(/\r\n?/g, '\n');
  const endsWithNL = md.endsWith('\n');
  let lines = md.split('\n');
  if (endsWithNL) lines.pop();
  inRawA = false;
  const { root, refs } = parseBlocks(lines, endsWithNL);
  return renderBlocks(root.children, refs);
}
