// Markdown renderer byte-identical to marked 18.1.3 defaults
// (gfm: true, breaks: false, pedantic: false, async: false).
// Zero imports. Single export: parse(markdown).
//
// Architecture: a two-phase block parser (container matching, then leaf
// handling / block starts) feeding a flat inline node list that is
// resolved (links, emphasis) and rendered in one left-to-right walk.

const PUNCT = /[\p{P}\p{S}]/u;
const WS = /\s/;

function isPunct(ch) { return ch !== undefined && PUNCT.test(ch); }
function isWs(ch) { return ch === undefined || WS.test(ch); }

// ---------- escaping ----------

// Text escape: & < > " ' escaped, except an & that starts an
// entity-like sequence (&word; / &#123; / &#x1f;) is left verbatim.
function escText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const m = /^&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z0-9_]+);/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
      out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

// Code escape: every & becomes &amp; (no entity preservation).
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

// Attribute escape: same as text escape (entity-aware).
const escAttr = escText;

// URL percent-encoding: encodeURI, then un-escape %25 back to %.
function encodeHref(s) {
  return encodeURI(s).replace(/%25/g, '%');
}

// Decode a numeric entity only (&#[0-9]+; / &#x[hex];). Returns the
// decoded string, or null when it is not a numeric entity. Values
// > 0x10FFFF are not entities; surrogates / 0 become U+FFFD.
function matchEntity(s, i) {
  if (s[i] !== '&') return null;
  let j = i + 1;
  if (s[j] !== '#') return null;
  j++;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : /[0-9]/.test(s[j]))) j++;
  if (j === start || s[j] !== ';') return null;
  const v = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (v > 0x10FFFF) return null;
  const cp = (v === 0 || (v >= 0xD800 && v <= 0xDFFF)) ? 0xFFFD : v;
  return { text: String.fromCodePoint(cp), len: j + 1 - i };
}

// Link-label normalization: collapse whitespace runs to one space,
// trim, Unicode case-fold (ligatures + ß/ẞ -> ss, then lowercase).
function normalizeLabel(s) {
  const folded = s.replace(/\s+/g, ' ').trim()
    .replace(/\uFB00/g, 'ff').replace(/\uFB01/g, 'fi').replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi').replace(/\uFB04/g, 'ffl').replace(/\uFB05/g, 'st')
    .replace(/\uFB06/g, 'st').replace(/\u00DF/g, 'ss').replace(/\u1E9E/g, 'ss');
  return folded.toLowerCase();
}

// ---------- inline HTML tag matching ----------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match an inline HTML tag at s[i] === '<'. Returns {len, name, closing}
// or null. name is lowercased, closing is true for </...>.
function matchHtmlTag(s, i) {
  if (s[i] !== '<') return null;
  let j = i + 1;
  // comment
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { len: 5, name: '', closing: false };
    if (s.startsWith('<!--->', i)) return { len: 6, name: '', closing: false };
    const e = s.indexOf('-->', i + 4);
    if (e < 0) return null;
    return { len: e + 3 - i, name: '', closing: false };
  }
  // processing instruction
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e < 0) return null;
    return { len: e + 2 - i, name: '', closing: false };
  }
  // declaration / CDATA
  if (s.startsWith('<!', i)) {
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      if (e < 0) return null;
      return { len: e + 3 - i, name: '', closing: false };
    }
    if (i + 2 < s.length && /[A-Za-z]/.test(s[i + 2])) {
      const e = s.indexOf('>', i + 2);
      if (e < 0) return null;
      return { len: e + 1 - i, name: '', closing: false };
    }
    return null;
  }
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= s.length || !/[A-Za-z]/.test(s[j])) return null;
  const nameStart = j;
  while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
  const name = s.slice(nameStart, j).toLowerCase();
  if (closing) {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] !== '>') return null;
    return { len: j + 1 - i, name, closing: true };
  }
  // open tag: attributes
  while (true) {
    // whitespace before an attribute (or the closing > / />)
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '>') return { len: k + 1 - i, name, closing: false };
    if (s[k] === '/' && s[k + 1] === '>') return { len: k + 2 - i, name, closing: false };
    if (k === j) return null; // no whitespace before attribute
    j = k;
    // attribute name
    if (j >= s.length || !/[A-Za-z_:]/.test(s[j]) && !(s.charCodeAt(j) > 127)) return null;
    j++;
    while (j < s.length && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional = value (a valueless attribute must not skip whitespace)
    let m = j;
    while (m < s.length && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
    if (s[m] === '=') {
      j = m + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e < 0) return null;
        j = e + 1;
      } else {
        if (j >= s.length || /[ \t\n"'=<>`]/.test(s[j])) return null;
        while (j < s.length && !/[ \t\n"'=<>`]/.test(s[j])) j++;
      }
    }
    // loop: next attribute or close (j stays; whitespace handled at top)
  }
}

// HTML block start match (types 1-7). Returns {type, end} or null.
// end is the end-condition string for types 1-5 (lowercased match).
function matchHtmlBlockStart(content) {
  let i = 0;
  while (i < content.length && content[i] === ' ' && i < 3) i++;
  if (content[i] !== '<') return null;
  const rest = content.slice(i);
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
  const tag = matchHtmlTag(content, i);
  if (tag) {
    let k = i + tag.len;
    while (k < content.length && (content[k] === ' ' || content[k] === '\t')) k++;
    if (k >= content.length) return { type: 7, end: null };
  }
  return null;
}

// Unescape backslash + ASCII punctuation only.
function isAsciiPunct(ch) { return /[!-/:-@\[-`{-~]/.test(ch); }
function unescapeStr(s) {
  if (!s.includes('\\')) return s;
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// ---------- bare URLs / emails ----------

const TRAIL = '?!.,: *_~;';

// Count backtick runs that find no closer of exactly their own length
// (exact-length pairing, as the real code-span scan does). Escaped
// backticks are literal.
function unpairedBacktickRuns(t) {
  const runs = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '`' && (i === 0 || t[i - 1] !== '\\')) {
      let j = i;
      while (j < t.length && t[j] === '`') j++;
      runs.push({ pos: i, len: j - i });
      i = j - 1;
    }
  }
  let unpaired = 0;
  const used = new Array(runs.length).fill(false);
  for (let a = 0; a < runs.length; a++) {
    if (used[a]) continue;
    let paired = false;
    for (let b = a + 1; b < runs.length; b++) {
      if (!used[b] && runs[b].len === runs[a].len) { used[a] = used[b] = true; paired = true; break; }
    }
    if (!paired) unpaired++;
  }
  return unpaired;
}

// Validate a link label's backticks: exactly one unpaired run
// invalidates it; zero or 2+ (of different lengths) are literal.
function linkTextOk(t) {
  return unpairedBacktickRuns(t) !== 1;
}

// Does the label hold a "poisoned" code span: a code span (paired run)
// whose content itself holds a backtick, with something after the span.
function hasPoisonedCodeSpan(t) {
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '`' && (i === 0 || t[i - 1] !== '\\')) {
      let j = i;
      while (j < t.length && t[j] === '`') j++;
      const len = j - i;
      // find closer of same length
      let k = j;
      while (k < t.length) {
        if (t[k] === '`' && (k === 0 || t[k - 1] !== '\\')) {
          let l = k;
          while (l < t.length && t[l] === '`') l++;
          if (l - k === len) {
            const inner = t.slice(j, k);
            if (inner.includes('`') && l < t.length) return true;
            i = l - 1;
            break;
          }
          k = l;
        } else k++;
      }
      if (k >= t.length) return false;
    }
  }
  return false;
}

// Scan forward from i for a closing paren of an inline link attempt:
// paren-depth scan skipping <...> and quoted titles; an unclosed
// quote/angle counts as a normal char.
function hasClosingParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '<') {
      const e = s.indexOf('>', j + 1);
      if (e < 0) continue;
      j = e;
    } else if (c === '"' || c === "'") {
      const e = s.indexOf(c, j + 1);
      if (e < 0) continue;
      j = e;
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

const EMAIL_LOCAL = /^[A-Za-z0-9._+\-]+/;
const EMAIL_DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9_\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_\-]*[A-Za-z0-9])?)+/;

// Match a bare email at s[i]. onClose is an optional callback used to
// allow a trailing _ run that closes an earlier _ emphasis opener.
// Returns {len} or null.
function matchBareEmail(s, i, onClose) {
  const lm = EMAIL_LOCAL.exec(s.slice(i));
  if (!lm || s[i + lm[0].length] !== '@') return null;
  let p = i + lm[0].length + 1;
  const dm = EMAIL_DOMAIN.exec(s.slice(p));
  if (!dm) return null;
  let end = p + dm[0].length;
  // back up over trailing -/_ in the last label
  while (end > p && (s[end - 1] === '-' || s[end - 1] === '_')) end--;
  if (end === p) return null;
  // the char after the domain must not be - or _ (unless the _ run is a
  // plausible closing emphasis delimiter with an earlier _ opener)
  if (s[end] === '-') return null;
  if (s[end] === '_') {
    let k = end;
    while (s[k] === '_') k++;
    if (!(onClose && onClose(k))) return null;
    end = k;
  }
  return { len: end - i };
}

const SCHEMES = ['http://', 'https://', 'ftp://'];

// Match a bare URL autolink at s[i]. brk: optional stop index (a ]
// that closes a link text when a valid destination follows it).
// Returns {len, href} or null. href is the display/URL text.
function matchBareUrl(s, i, brk = -1) {
  let start = -1, scheme = null;
  const low = s.slice(i, i + 8).toLowerCase();
  for (const sc of SCHEMES) if (low.startsWith(sc)) { start = i; scheme = sc; break; }
  if (start < 0) {
    if (low.startsWith('www.')) { start = i; scheme = 'www.'; }
    else if (s.slice(i, i + 5).toLowerCase() === 'xmpp:') { start = i; scheme = 'xmpp:'; }
    else if (s.slice(i, i + 7).toLowerCase() === 'mailto:') { start = i; scheme = 'mailto:'; }
  }
  if (start < 0) return null;
  // www. is lowercase only; schemes are case-insensitive
  if (scheme === 'www.' && s.slice(i, i + 4) !== 'www.') return null;
  if (scheme === 'xmpp:' && s.slice(i, i + 5) !== 'xmpp:') return null;
  if (scheme === 'mailto:' && s.slice(i, i + 7) !== 'mailto:') return null;
  let p = i + scheme.length;
  if (scheme === 'www.' && p >= s.length) return null;
  if (scheme === 'xmpp:') {
    const em = matchBareEmail(s, p);
    if (!em) return null;
    p += em.len;
    // optional one /resource segment
    if (s[p] === '/') {
      let q = p + 1;
      while (q < s.length && /[A-Za-z0-9.@]/.test(s[q])) q++;
      while (q > p + 1 && (s[q - 1] === '.' || s[q - 1] === '@')) q--;
      if (q > p + 1) p = q;
    }
    return { len: p - i, href: s.slice(i, p), text: s.slice(i, p) };
  }
  if (scheme === 'mailto:') {
    const em = matchBareEmail(s, p);
    if (!em) return null;
    p += em.len;
    return { len: p - i, href: s.slice(i, p), text: s.slice(i, p) };
  }
  // http/https/ftp/www: consume [^\s<>]+
  let end = p;
  const limit = brk >= 0 ? Math.min(brk, s.length) : s.length;
  while (end < limit && !/[\s<>]/.test(s[end])) end++;
  let url = s.slice(i, end);
  // trim loop: trailing punctuation, entity, unclosed paren, unmatched /
  // nested-group closing paren. Paren logic must interleave with the
  // punctuation trim (dropping a ) can reveal a TRAIL char).
  let noUnclosedTrunc = false;
  let changed = true;
  while (changed) {
    changed = false;
    // trailing entity-like &word; / &#...; is not part of the URL
    const em = /&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z0-9_]+);$/.exec(url);
    if (em) { url = url.slice(0, url.length - em[0].length); changed = true; continue; }
    // trailing punctuation
    while (url.length && TRAIL.includes(url[url.length - 1])) { url = url.slice(0, -1); changed = true; }
    if (!url.length) return null;
    // paren handling: depth with clamping at zero
    let depth = 0;
    for (let k = 0; k < url.length; k++) {
      if (url[k] === '(') depth++;
      else if (url[k] === ')') { if (depth > 0) depth--; }
    }
    if (depth > 0 && !noUnclosedTrunc) {
      // truncate at the first unclosed ( : stack of open positions
      const stack = [];
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') stack.push(k);
        else if (url[k] === ')') stack.pop();
      }
      if (stack.length) { url = url.slice(0, stack[0]); changed = true; continue; }
    }
    // trailing ) : drop when unmatched, or when its group holds a nested (
    while (url.endsWith(')')) {
      const t = url.length;
      let d = 0, open = -1;
      for (let k = t - 1; k >= 0; k--) {
        if (url[k] === ')') d++;
        else if (url[k] === '(') {
          d--;
          if (d === 0) { open = k; break; }
        }
      }
      if (open < 0) { url = url.slice(0, -1); changed = true; continue; }
      const group = url.slice(open + 1, t - 1);
      if (group.includes('(')) {
        url = url.slice(0, -1);
        noUnclosedTrunc = true;
        changed = true;
        continue;
      }
      break;
    }
  }
  if (!url.length) return null;
  return { len: url.length, href: scheme === 'www.' ? 'http://' + url : url, text: url };
}

// Parse an inline link "(...)" starting at s[i] === '('. Returns
// {href, title, end} (end = index just past ')') or null.
function tryInlineLink(s, i, defs) {
  let p = i + 1;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  let href = '';
  if (s[p] === '<') {
    let q = p + 1, closed = false;
    while (q < s.length) {
      if (s[q] === '\\' && q + 1 < s.length) { q += 2; continue; }
      if (s[q] === '>') { closed = true; break; }
      if (s[q] === '<' || s[q] === '\n') break;
      q++;
    }
    if (!closed) return null;
    href = unescapeStr(s.slice(p + 1, q));
    p = q + 1;
  } else {
    let depth = 0, q = p;
    while (q < s.length) {
      const c = s[q];
      if (c === '\\' && q + 1 < s.length) { q += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ' ' || c === '\t' || c === '\n') break;
      q++;
    }
    href = unescapeStr(s.slice(p, q));
    p = q;
  }
  // optional title
  let title = null;
  let save = p;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  if (p < s.length && (s[p] === '"' || s[p] === "'" || s[p] === '(')) {
    const open = s[p], close = open === '(' ? ')' : open;
    let q = p + 1, closed = false;
    while (q < s.length) {
      if (s[q] === '\\' && q + 1 < s.length && (s[q + 1] === open || s[q + 1] === '\\')) { q += 2; continue; }
      if (s[q] === close) { closed = true; break; }
      q++;
    }
    if (closed) {
      title = unescapeStr(s.slice(p + 1, q));
      p = q + 1;
    } else {
      p = save;
    }
  }
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  if (s[p] !== ')') return null;
  return { href, title, end: p + 1 };
}

// ---------- inline scanner ----------

let inRawA = false; // bare autolinks suppressed inside a raw <a ...> element

// Remove bare-URL/email autolink open/close pairs in nodes[from, to),
// keeping their text nodes.
function flattenBareAutos(nodes, from, to) {
  const drop = new Set();
  for (let k = from; k < to; k++) {
    const nd = nodes[k];
    if (nd.t === 3 && nd.auto && !nd.angle) {
      drop.add(k);
      let d = 1;
      for (let m = k + 1; m < to; m++) {
        if (nodes[m].t === 3) d++;
        else if (nodes[m].t === 4) { d--; if (d === 0) { drop.add(m); break; } }
      }
    }
  }
  if (!drop.size) return;
  const kept = [];
  for (let k = from; k < to; k++) if (!drop.has(k)) kept.push(nodes[k]);
  nodes.splice(from, to - from, ...kept);
}

// Scan one paragraph's text into a flat node list. defs: Map label -> {href, title}.
function scanInline(text, defs) {
  const nodes = [];
  const delims = [];
  const openers = []; // {node, img, active, src}
  let delimId = 0;
  let cidCounter = 1;

  function pushText(s, raw) {
    if (!s) return;
    const last = nodes[nodes.length - 1];
    if (last && last.t === 0 && !last.raw && !raw) { last.s += s; return; }
    nodes.push({ t: 0, s, raw: !!raw });
  }
  function pushDelim(ch, run, canOpen, canClose) {
    const nd = { t: 2, ch, len: run, orig: run, canOpen, canClose, opens: [], closes: [], linkId: 0, id: delimId++, dead: false };
    nodes.push(nd);
    delims.push(nd);
    return nd;
  }
  function hasLinkInRange(fromIdx, toIdx) {
    for (let k = fromIdx; k < toIdx; k++) {
      const nd = nodes[k];
      if (nd.t === 3 && !nd.auto) return true;
    }
    return false;
  }
  // Would the ] at source position j form a link with the topmost
  // active opener? Pure mirror of the ] handler's decision.
  function bracketFormsLink(j) {
    let op = null;
    for (let k = openers.length - 1; k >= 0; k--) if (openers[k].active) { op = openers[k]; break; }
    if (!op) return false;
    const rawLabel = text.slice(op.src, j);
    const startIdx = nodes.indexOf(op.node);
    if (!op.img && hasLinkInRange(startIdx + 1, nodes.length)) return false;
    const after = text[j + 1];
    if (after === '(') {
      const r = tryInlineLink(text, j + 1, defs);
      if (!r) return false;
      return linkTextOk(rawLabel);
    }
    if (after === '[') {
      let q = j + 2;
      while (q < text.length && text[q] !== ']') q++;
      if (q >= text.length) return false;
      if (q === j + 2) return linkTextOk(rawLabel) && defs.has(normalizeLabel(rawLabel));
      const lbl = normalizeLabel(text.slice(j + 2, q));
      return linkTextOk(rawLabel) && defs.has(lbl);
    }
    return defs.has(normalizeLabel(rawLabel));
  }

  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    // newline: hard / soft break
    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      if (last && last.t === 0 && !last.raw && / {2,}$/.test(last.s)) {
        last.s = last.s.replace(/ {2,}$/, '');
        nodes.push({ t: 7 });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      nodes.push({ t: 8 });
      i++;
      continue;
    }
    // backslash
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        nodes.push({ t: 7 });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && /[!-/:-@\[-`{-~]/.test(nx)) {
        pushText(nx === '&' ? '&amp;' : nx === '>' ? '&gt;' : nx === '<' ? '&lt;' : nx === '"' ? '&quot;' : nx === "'" ? '&#39;' : nx);
        i += 2;
        continue;
      }
      pushText('\\');
      i++;
      continue;
    }
    // backtick run: code span
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (text[k] === '`') {
          let l = k;
          while (l < n && text[l] === '`') l++;
          if (l - k === run) { found = k; break; }
          k = l;
        } else if (text[k] === ']' && bracketFormsLink(k)) {
          // a ] that would close a link must not be swallowed
          break;
        } else k++;
      }
      if (found >= 0) {
        let inner = text.slice(j, found).replace(/\n/g, ' ');
        if (inner.length >= 2 && inner[0] === ' ' && inner[inner.length - 1] === ' ' && /[^ ]/.test(inner))
          inner = inner.slice(1, -1);
        nodes.push({ t: 1, s: inner });
        i = found + run;
        continue;
      }
      pushText('`'.repeat(run));
      i = j;
      continue;
    }
    // image / link opener
    if (c === '!' && text[i + 1] === '[') {
      const nd = { t: 10 };
      nodes.push(nd);
      openers.push({ node: nd, img: true, active: true, src: i + 2 });
      i += 2;
      continue;
    }
    if (c === '[') {
      const nd = { t: 9 };
      nodes.push(nd);
      openers.push({ node: nd, img: false, active: true, src: i + 1 });
      i++;
      continue;
    }
    // ] : link resolution
    if (c === ']') {
      let opIdx = -1;
      for (let k = openers.length - 1; k >= 0; k--) if (openers[k].active) { opIdx = k; break; }
      if (opIdx < 0) { pushText(']'); i++; continue; }
      const op = openers[opIdx];
      const startIdx = nodes.indexOf(op.node);
      const rawLabel = text.slice(op.src, i);
      const after = text[i + 1];
      let formed = null;
      const blocked = !op.img && hasLinkInRange(startIdx + 1, nodes.length);
      if (!blocked) {
        if (after === '(') {
          const r = tryInlineLink(text, i + 1, defs);
          if (r && linkTextOk(rawLabel)) formed = { href: r.href, title: r.title, end: r.end };
          else if (!r) {
            // failed inline attempt falls back to shortcut ref
            const d = defs.get(normalizeLabel(rawLabel));
            if (d) formed = { href: d.href, title: d.title, end: i + 1 };
          }
        } else if (after === '[') {
          let q = i + 2;
          while (q < n && text[q] !== ']') q++;
          if (q < n) {
            if (q === i + 2) {
              const d = defs.get(normalizeLabel(rawLabel));
              if (d && linkTextOk(rawLabel)) formed = { href: d.href, title: d.title, end: q + 1 };
            } else {
              const d = defs.get(normalizeLabel(text.slice(i + 2, q)));
              if (d && linkTextOk(rawLabel)) formed = { href: d.href, title: d.title, end: q + 1 };
            }
          }
          // a failed [label] does NOT fall back to shortcut
        } else {
          const d = defs.get(normalizeLabel(rawLabel));
          if (d) formed = { href: d.href, title: d.title, end: i + 1 };
        }
      }
      if (formed) {
        const kids = nodes.slice(startIdx + 1);
        if (op.img) {
          const imgNode = { t: 5, src: formed.href, title: formed.title, altNodes: kids, cid: cidCounter++ };
          nodes.splice(startIdx, nodes.length - startIdx, imgNode);
        } else {
          const openNode = { t: 3, href: formed.href, title: formed.title, auto: false, cid: cidCounter++ };
          nodes[startIdx] = openNode;
          // bare URL/email autolinks inside a formed link render as
          // plain text (angle autolinks stay nested links)
          flattenBareAutos(nodes, startIdx + 1, nodes.length);
          nodes.push({ t: 4 });
        }
        // deactivate openers inside the formed link text
        for (let k = opIdx + 1; k < openers.length; k++) openers[k].active = false;
        op.active = false;
        i = formed.end;
        continue;
      }
      // failed: suppress emphasis inside a failed closed inline link
      if (!op.img && after === '(' && hasClosingParen(text, i + 1) && !blocked &&
          (linkTextOk(rawLabel) || hasPoisonedCodeSpan(rawLabel))) {
        for (let k = startIdx + 1; k < nodes.length; k++) if (nodes[k].t === 2) nodes[k].dead = true;
      }
      op.active = false;
      pushText(']');
      i++;
      continue;
    }
    // emphasis / strikethrough delimiter run
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const run = j - i;
      const before = i > 0 ? text[i - 1] : undefined;
      const afterCh = j < n ? text[j] : undefined;
      const leftFlank = !isWs(afterCh) && (!isPunct(afterCh) || isWs(before) || isPunct(before));
      const rightFlank = !isWs(before) && (!isPunct(before) || isWs(afterCh) || isPunct(afterCh));
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || isPunct(before));
        canClose = rightFlank && (!leftFlank || isPunct(afterCh));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      const nd = pushDelim(c, run, canOpen, canClose);
      // record the char right after the run (K-rule needs it)
      nd.nextCh = afterCh;
      i = j;
      continue;
    }
    // < : autolink, then HTML tag
    if (c === '<') {
      // autolink <...>
      const gt = text.indexOf('>', i + 1);
      if (gt > i + 1) {
        const inner = text.slice(i + 1, gt);
        if (!/[ <>\n]/.test(inner)) {
          if (inner.includes('@')) {
            const em = matchBareEmail(inner, 0);
            if (em && em.len === inner.length) {
              nodes.push({ t: 3, href: 'mailto:' + inner, title: null, auto: true, angle: true, cid: cidCounter++ });
              pushText(inner);
              nodes.push({ t: 4 });
              i = gt + 1;
              continue;
            }
          }
          const sm = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(inner);
          if (sm) {
            nodes.push({ t: 3, href: inner, title: null, auto: true, angle: true, cid: cidCounter++ });
            pushText(inner);
            nodes.push({ t: 4 });
            i = gt + 1;
            continue;
          }
        }
      }
      const tag = matchHtmlTag(text, i);
      if (tag) {
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
    // & : entity (numeric entities decode to normal text, which is
    // then escaped on render; named entities stay verbatim)
    if (c === '&') {
      const ent = matchEntity(text, i);
      if (ent) { pushText(ent.text); i += ent.len; continue; }
      const nm = /^&[A-Za-z0-9_]+;/.exec(text.slice(i));
      if (nm) { pushText(nm[0], true); i += nm[0].length; continue; }
      pushText('&amp;');
      i++;
      continue;
    }
    // bare URL / bare email
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'W' || c === 'x' || c === 'X' || c === 'm' || c === 'M') {
      // pre-scan for a ] that would close a link text (brk)
      let brk = -1;
      const bj = text.indexOf(']', i);
      if (bj > i) {
        // the ] forms a link only if what follows is a valid destination
        if (bracketFormsLink(bj)) brk = bj;
      }
      const bu = inRawA ? null : matchBareUrl(text, i, brk);
      if (bu) {
        nodes.push({ t: 3, href: bu.href, title: null, auto: true, cid: cidCounter++ });
        pushText(bu.text);
        nodes.push({ t: 4 });
        i += bu.len;
        continue;
      }
    }
    if (/[A-Za-z0-9]/.test(c)) {
      const em = inRawA ? null : matchBareEmail(text, i, (k) => {
        // trailing _ run is a plausible closing delimiter when an
        // earlier _ opener exists in this paragraph
        for (let d = delims.length - 1; d >= 0; d--) {
          const dd = delims[d];
          if (dd.ch === '_' && dd.canOpen && !dd.dead) return true;
        }
        return false;
      });
      if (em) {
        nodes.push({ t: 3, href: 'mailto:' + text.slice(i, i + em.len), title: null, auto: true, cid: cidCounter++ });
        pushText(text.slice(i, i + em.len));
        nodes.push({ t: 4 });
        i += em.len;
        continue;
      }
    }
    // plain text run: stop at specials, at potential bare-URL starts,
    // and at word starts after a char that cannot be in an email local part
    let j = i;
    while (j < n) {
      const ch = text[j];
      if (ch === '\n' || ch === '\\' || ch === '`' || ch === '[' || ch === ']' ||
          ch === '*' || ch === '_' || ch === '~' || ch === '<' || ch === '&' || ch === '!') break;
      if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W' ||
          ch === 'x' || ch === 'X' || ch === 'm' || ch === 'M') break;
      if (/[A-Za-z0-9]/.test(ch) && j > i && !/[A-Za-z0-9._+\-]/.test(text[j - 1])) break;
      j++;
    }
    if (j === i) { pushText(text[i]); i++; }
    else { pushText(text.slice(i, j)); i = j; }
  }
  return { nodes, delims };
}

// Assign each delimiter the id of its innermost enclosing link/img
// container (0 = top level). Walk the main list and image alt lists.
function assignLinkIds(nodes) {
  const stack = [];
  function walk(list) {
    for (const nd of list) {
      if (nd.t === 3) { stack.push(nd.cid); }
      else if (nd.t === 4) { stack.pop(); }
      else if (nd.t === 2) { nd.linkId = stack.length ? stack[stack.length - 1] : 0; }
      else if (nd.t === 5) {
        stack.push(nd.cid);
        walk(nd.altNodes);
        stack.pop();
      }
    }
  }
  walk(nodes);
}

// A link whose text holds >= 2 unpaired backtick runs suppresses all
// top-level emphasis after it up to the next code span in the block.
function poisonedLinkSuppression(nodes, delims) {
  for (let a = 0; a < nodes.length; a++) {
    const nd = nodes[a];
    if (nd.t !== 3) continue;
    let depth = 1, b = a + 1;
    while (b < nodes.length && depth > 0) {
      if (nodes[b].t === 3) depth++;
      else if (nodes[b].t === 4) depth--;
      b++;
    }
    const closeIdx = b - 1;
    let label = '';
    for (let k = a + 1; k < closeIdx; k++) if (nodes[k].t === 0) label += nodes[k].s;
    if (unpairedBacktickRuns(label) < 2) continue;
    let codeIdx = -1;
    for (let k = closeIdx + 1; k < nodes.length; k++) if (nodes[k].t === 1) { codeIdx = k; break; }
    if (codeIdx < 0) continue;
    for (let k = closeIdx + 1; k < codeIdx; k++) {
      const d = nodes[k];
      if (d.t === 2 && d.linkId === 0) d.dead = true;
    }
  }
}

// Emphasis / strikethrough resolution (spec appendix algorithm over a
// doubly-linked list of delimiters, in creation order).
function resolveEmphasis(delims) {
  const N = delims.length;
  const prev = new Array(N).fill(-1), next = new Array(N).fill(-1);
  let head = -1, last = -1;
  for (let i = 0; i < N; i++) {
    const d = delims[i];
    if (d.dead || d.len <= 0) continue;
    if (head < 0) head = i;
    prev[i] = last;
    if (last >= 0) next[last] = i;
    last = i;
  }
  const formed = []; // {openId, closeId, use, ch}
  const isInside = (id) => {
    for (const f of formed) if (id > f.openId && id < f.closeId) return true;
    return false;
  };
  let cur = head;
  while (cur >= 0) {
    const closer = delims[cur];
    if (!closer.canClose || closer.len <= 0 || closer.dead) { cur = next[cur]; continue; }
    // look back for an opener
    let paired = false;
    let o = prev[cur];
    while (o >= 0) {
      const opener = delims[o];
      if (opener.canOpen && opener.len > 0 && !opener.dead &&
          opener.ch === closer.ch && opener.linkId === closer.linkId &&
          !isInside(opener.id)) {
        let use;
        if (closer.ch === '~') {
          if (opener.len !== closer.len || opener.len > 2) { o = prev[o]; continue; }
          use = opener.len;
        } else {
          use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        }
        // odd-match rule
        if ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) {
          if ((opener.orig + closer.orig) % 3 === 0 &&
              !((opener.orig % 3 === 0) && (closer.orig % 3 === 0))) {
            o = prev[o]; continue;
          }
        }
        // K-rule (not for ~): an inner pair of a different length whose
        // closer is followed by a letter/digit, whose opener cannot
        // close, blocks this pair.
        let kBlock = false, kInside = false;
        if (closer.ch !== '~') {
          for (const f of formed) {
            if (f.openId > opener.id && f.closeId < closer.id && f.ch === closer.ch &&
                (f.use !== use || delims[f.openId].orig !== opener.orig) &&
                !delims[f.openId].canClose &&
                /[\p{L}\p{N}]/u.test(delims[f.closeId].nextCh || '')) {
              // pure-closer cancellation, only when the outer pair
              // would be stronger than the inner one
              let cancelled = false;
              if (use > f.use) {
                for (let m = f.closeId + 1; m < closer.id; m++) {
                  const dm = delims[m];
                  if (dm && dm.canClose && !dm.canOpen) { cancelled = true; break; }
                }
              }
              if (!cancelled) {
                if (closer.len <= 2) kBlock = true;
                else kInside = true;
              }
              break;
            }
          }
        }
        if (kBlock) { o = prev[o]; continue; }
        // form the pair
        opener.opens.push({ n: use, ch: opener.ch });
        closer.closes.push({ n: use, ch: closer.ch });
        opener.len -= use;
        closer.len -= use;
        if (kInside) closer.leftoverInside = true;
        formed.push({ openId: opener.id, closeId: closer.id, use, ch: closer.ch });
        if (opener.len === 0) {
          const po = prev[o], no = next[o];
          if (po >= 0) next[po] = no; else head = no;
          if (no >= 0) prev[no] = po;
        }
        if (closer.len === 0) {
          const nc = next[cur];
          const pc = prev[cur];
          if (pc >= 0) next[pc] = nc; else head = nc;
          if (nc >= 0) prev[nc] = pc;
          cur = nc;
          paired = true;
          break;
        }
        // closer still has length: look for another opener
        o = prev[o];
        paired = true;
        continue;
      }
      o = prev[o];
    }
    if (!paired && closer.len > 0) cur = next[cur];
    else if (!paired) cur = next[cur];
  }
}

// Plain text of a node list (for image alt), after emphasis resolution.
function plainTextOf(list) {
  let out = '';
  for (const nd of list) {
    if (nd.t === 0 || nd.t === 1) out += nd.s;
    else if (nd.t === 2) out += nd.ch.repeat(nd.len);
    else if (nd.t === 5) out += plainTextOf(nd.altNodes);
    else if (nd.t === 8) out += '\n';
    else if (nd.t === 9) out += '[';
    else if (nd.t === 10) out += '![';
  }
  return out;
}

function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 0: out += nd.raw ? nd.s : escText(nd.s); break;
      case 1: out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 2: {
        const leftover = nd.len;
        const openTag = (n, ch) => ch === '~' ? '<del>' : (n === 2 ? '<strong>' : '<em>');
        const closeTag = (n, ch) => ch === '~' ? '</del>' : (n === 2 ? '</strong>' : '</em>');
        if (leftover > 0 && nd.leftoverInside && nd.closes.length > 0 && nd.opens.length === 0) {
          out += nd.ch.repeat(leftover);
          for (const c of nd.closes) out += closeTag(c.n, c.ch);
        } else {
          for (const c of nd.closes) out += closeTag(c.n, c.ch);
          if (leftover > 0) out += nd.ch.repeat(leftover);
          for (let k = nd.opens.length - 1; k >= 0; k--) out += openTag(nd.opens[k].n, nd.opens[k].ch);
        }
        break;
      }
      case 3: {
        const href = nd.auto ? escCode(encodeHref(nd.href)) : escAttr(encodeHref(nd.href));
        out += '<a href="' + href + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>';
        break;
      }
      case 4: out += '</a>'; break;
      case 5: {
        out += '<img src="' + escAttr(encodeHref(nd.src)) + '" alt="' + escAttr(plainTextOf(nd.altNodes)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>';
        break;
      }
      case 6: out += nd.s; break;
      case 7: out += '<br>'; break;
      case 8: out += '\n'; break;
      case 9: out += '['; break;
      case 10: out += '!['; break;
    }
  }
  return out;
}

// Full inline parse: scan, flatten bare autolinks inside formed links
// (done in the ] handler via auto flags), assign link ids, suppress
// poisoned-link emphasis, resolve emphasis, render.
function parseInline(text, defs) {
  const { nodes, delims } = scanInline(text, defs);
  assignLinkIds(nodes);
  poisonedLinkSuppression(nodes, delims);
  resolveEmphasis(delims);
  return renderInline(nodes);
}

// ---------- block matchers ----------

// Columns of the leading whitespace run of s, starting at column col.
function leadingWsCols(s, col) {
  let c = col, i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { c++; i++; }
    else if (s[i] === '\t') { c += 4 - (c % 4); i++; }
    else break;
  }
  return c - col;
}

// ATX heading: {level, text} or null.
function matchATX(content) {
  const i = skip3(content);
  if (content[i] !== '#') return null;
  let j = i;
  while (j < content.length && content[j] === '#') j++;
  const level = j - i;
  if (level > 6) return null;
  if (j < content.length && content[j] !== ' ' && content[j] !== '\t') return null;
  let text = content.slice(j);
  text = text.replace(/[ \t]+$/, '');
  text = text.replace(/[ \t]+#+$/, '');
  text = text.replace(/^[ \t]+/, '');
  text = text.replace(/[ \t]+$/, '');
  return { level, text };
}

// Fence: {ch, len, info, indent} or null. A backtick fence's info must
// not contain a backtick; a tilde fence's info may.
function matchFence(content) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
  if (!m) return null;
  const ch = m[1][0];
  if (ch === '`' && m[2].includes('`')) return null;
  const indent = content.length - content.replace(/^ */, '').length;
  return { ch, len: m[1].length, info: m[2], indent: Math.min(3, indent) };
}

// hr: up to 3 spaces, 3+ of the same char (- _ *) with only spaces/tabs.
function isHrLine(content) {
  let i = 0;
  while (i < content.length && content[i] === ' ' && i < 3) i++;
  const ch = content[i];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let n = 0, j = i;
  while (j < content.length) {
    const c = content[j];
    if (c === ch) { n++; j++; }
    else if (c === ' ' || c === '\t') j++;
    else return false;
  }
  return n >= 3;
}

// Setext underline: 1 (h1, =) or 2 (h2, -) or 0.
function matchSetext(content) {
  if (/^ {0,3}=+[ \t]*$/.test(content)) return 1;
  if (/^ {0,3}-+[ \t]*$/.test(content)) return 2;
  return 0;
}

// List marker: {bullet, marker, num, delim, after, indent} or null.
// `after` is the index just past the marker; `indent` the leading spaces.
function matchListMarker(content) {
  let i = 0;
  while (i < content.length && content[i] === ' ' && i < 3) i++;
  const ch = content[i];
  if (ch === '-' || ch === '+' || ch === '*') {
    if (content[i + 1] !== ' ' && content[i + 1] !== '\t' && content[i + 1] !== undefined) return null;
    return { bullet: true, marker: ch, after: i + 1, indent: i };
  }
  if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < content.length && content[j] >= '0' && content[j] <= '9') j++;
    const numStr = content.slice(i, j);
    if (numStr.length > 9) return null;
    const d = content[j];
    if (d !== '.' && d !== ')') return null;
    if (content[j + 1] !== ' ' && content[j + 1] !== '\t' && content[j + 1] !== undefined) return null;
    return { bullet: false, num: parseInt(numStr, 10), delim: d, after: j + 1, indent: i };
  }
  return null;
}

// Split a table row on unescaped | (a \| becomes | in the cell).
function splitTableRow(line) {
  const cells = [];
  let cur = '', i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  // strip one leading / trailing empty cell when the row starts/ends with |
  if (line.trimStart().startsWith('|') && cells.length && cells[0].trim() === '') cells.shift();
  if (line.trimEnd().endsWith('|') && cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(x => x.trim());
}

function hasUnescapedPipe(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') return true;
  }
  return false;
}

function isDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (!cells.length) return false;
  return cells.every(c => /^:?-+:?$/.test(c));
}

// A paragraph (lines) is a table iff line 0 has an unescaped | and
// line 1 is a delimiter row with as many cells as the header.
function isTableLines(lines) {
  if (lines.length < 2) return false;
  if (!hasUnescapedPipe(lines[0])) return false;
  if (!isDelimiterRow(lines[1])) return false;
  return splitTableRow(lines[0]).length === splitTableRow(lines[1]).length;
}

function tableAlignments(delimLine) {
  return splitTableRow(delimLine).map(c => {
    if (c.startsWith(':') && c.endsWith(':') && c.length > 2) return 'center';
    if (c.startsWith(':')) return 'left';
    if (c.endsWith(':')) return 'right';
    return null;
  });
}

// ---------- link reference definitions ----------

// Parse ONE definition at the start of src. Returns
// {end, label, href, title} (end = index just past the definition) or null.
function parseOneDef(src) {
  let p = 0;
  while (p < src.length && p < 3 && src[p] === ' ') p++;
  if (src[p] !== '[') return null;
  // label (may span lines; [ inside fails; \] does not close)
  let q = p + 1, label = '';
  let closed = false;
  while (q < src.length) {
    const c = src[q];
    if (c === '\\' && q + 1 < src.length) { label += src.slice(q, q + 2); q += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { closed = true; break; }
    label += c; q++;
  }
  if (!closed) return null;
  const norm = normalizeLabel(label);
  if (!norm || norm.length > 999) return null;
  q++;
  if (src[q] !== ':') return null;
  q++;
  // after ':' only spaces on the same line; a newline allows the
  // destination on the next line (any leading whitespace there)
  if (src[q] === '\t') return null;
  while (src[q] === ' ') q++;
  if (src[q] === '\n') {
    q++;
    while (src[q] === ' ' || src[q] === '\t') q++;
  } else if (src[q] === '\t') return null;
  // destination
  let href = '';
  if (src[q] === '<') {
    let r = q + 1, ok = false;
    while (r < src.length) {
      if (src[r] === '\\' && r + 1 < src.length) { r += 2; continue; }
      if (src[r] === '>') { ok = true; break; }
      if (src[r] === '<' || src[r] === '\n') break;
      r++;
    }
    if (!ok) return null;
    href = unescapeStr(src.slice(q + 1, r));
    q = r + 1;
  } else {
    let depth = 0, r = q;
    while (r < src.length) {
      const c = src[r];
      if (c === '\\' && r + 1 < src.length && isAsciiPunct(src[r + 1])) { r += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      r++;
    }
    if (depth !== 0) return null;
    if (r === q) return null;
    href = unescapeStr(src.slice(q, r));
    q = r;
  }
  // optional title, separated from the destination by whitespace; it
  // may be on the same line, the next line, or span several lines. If
  // the title does not parse cleanly, the definition is still valid
  // WITHOUT a title — unless there is junk after the destination on
  // the same line, which invalidates the whole definition.
  let title = null;
  let r2 = q, hadWs = false;
  while (r2 < src.length && (src[r2] === ' ' || src[r2] === '\t' || src[r2] === '\n')) { hadWs = true; r2++; }
  if (hadWs && r2 < src.length && (src[r2] === '"' || src[r2] === "'" || src[r2] === '(')) {
    const open = src[r2], close = open === '(' ? ')' : open;
    let v = '', t = r2 + 1, ok = false;
    while (t < src.length) {
      if (src[t] === '\\' && t + 1 < src.length && isAsciiPunct(src[t + 1])) { v += src[t + 1]; t += 2; continue; }
      if (src[t] === close) { ok = true; break; }
      v += src[t]; t++;
    }
    if (ok) {
      let rr = t + 1;
      while (rr < src.length && (src[rr] === ' ' || src[rr] === '\t')) rr++;
      if (rr >= src.length || src[rr] === '\n') { title = v; q = rr; }
    }
  }
  if (title === null) {
    let rr = q;
    while (rr < src.length && (src[rr] === ' ' || src[rr] === '\t')) rr++;
    if (rr < src.length && src[rr] !== '\n') return null;
    q = rr;
  }
  return { end: q, label: norm, href, title };
}

// Extract leading definitions from a paragraph's lines. Returns
// {defs: Map additions, rest: remaining lines}.
function extractDefs(lines) {
  const joined = lines.join('\n');
  const defs = new Map();
  let pos = 0;
  while (true) {
    const d = parseOneDef(joined.slice(pos));
    if (!d) break;
    if (!defs.has(d.label)) defs.set(d.label, { href: d.href, title: d.title });
    pos += d.end;
    if (joined[pos] === '\n') { pos++; continue; }
    break;
  }
  const restText = joined.slice(pos);
  const rest = restText === '' ? [] : restText.split('\n');
  return { defs, rest };
}

// ---------- cursor helpers ----------

function curRest(cur) { return cur.s.slice(cur.p); }
function curSkipWs(cur, n) {
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
    } else return false;
  }
  return n === 0;
}
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
function restoreCur(cur, sv) { cur.s = sv.s; cur.p = sv.p; cur.col = sv.col; }
// Strip up to n columns of indent from a fenced-code content line: a tab
// consumed here counts as exactly 1 column and is removed whole.
function fenceStripIndent(cur, n) {
  const s = cur.s;
  while (n > 0 && cur.p < s.length) {
    const ch = s[cur.p];
    if (ch === ' ') { cur.p++; cur.col++; n--; }
    else if (ch === '\t') { cur.p++; cur.col += 4 - (cur.col % 4); n--; }
    else break;
  }
}
function skip3(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  return i;
}

// Build a table node from paragraph lines (lines[0] header, lines[1] delim).
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

// Extract leading defs from paragraph lines, merging into refs
// (first definition wins). Returns the remaining lines.
function takeDefs(lines, refs) {
  const { defs, rest } = extractDefs(lines);
  for (const [k, v] of defs) if (!refs.has(k)) refs.set(k, v);
  return rest;
}

function finalizePara(leaf, refs) {
  const rest = takeDefs(leaf.lines, refs);
  if (rest.length === 0) return [];
  // a table may start partway through the paragraph
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

// ---------- main block parser ----------

function parseBlocks(lines, endsWithNL) {
  const refs = new Map();
  const root = { t: 'doc', children: [], blank: false, blankBelow: false, loose: false };
  const stack = [root];
  let leaf = null;
  let rawBlank = false;

  function top() { return stack[stack.length - 1]; }
  function isBlankLine(s) {
    for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
    return true;
  }
  function curBlank(cur) { return rawBlank || cur.p >= cur.s.length; }
  function addBlock(frame, node) {
    if (frame.blankBelow && frame.children.length > 0) frame.loose = true;
    const fi = stack.indexOf(frame);
    if (fi >= 0) {
      for (let k = fi; k >= 1; k--) { stack[k].blank = false; stack[k].blankBelow = false; }
    } else { frame.blank = false; frame.blankBelow = false; }
    frame.children.push(node);
    return node;
  }
  function setBlankFlag() {
    for (let k = stack.length - 1; k >= 1; k--) {
      stack[k].blankBelow = true;
      if (k === stack.length - 1) stack[k].blank = true;
      if (stack[k].t === 'quote') break;
    }
  }
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
        const rem = nextLineRemainder(nextIdx, stack.indexOf(leaf.parent));
        if (rem !== null && rem.length > 0) addNL = true;
      }
    } else if (how === 'eof') {
      addNL = endsWithNL;
    }
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
      arr.splice(arr.length - 1, 1, ...fins);
    } else if (leaf.t === 'html') {
      closeLeafHtml(lastIdx === undefined ? leaf.lastIdx : lastIdx, how || 'container');
    } else if (leaf.t === 'fence' && par.t === 'item' && !leaf.anchored) {
      node.lines.length = 0;
    }
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
    if (curBlank(cur)) { curSkipWsUpTo(cur, fr.contentIndent); return true; }
    const sv = saveCur(cur);
    if (curSkipWs(cur, fr.contentIndent)) return true;
    restoreCur(cur, sv);
    return false;
  }
  function isLazyLine(content) {
    if (!content || isBlankLine(content)) return false;
    if (matchATX(content)) return false;
    if (matchFence(content)) return false;
    if (isHrLine(content)) return false;
    const hb = matchHtmlBlockStart(content);
    if (hb && hb.type <= 6) return false;
    const q = skip3(content);
    if (content[q] === '>') return false;
    if (matchSetext(content)) return true;
    const lm = matchListMarker(content);
    if (lm) {
      let j = lm.after;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      if (j >= content.length) return true;
      if (lm.bullet || lm.num === 1) return false;
    }
    return true;
  }
  function listCanInterrupt(lm, content) {
    let j = lm.after;
    while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
    if (j >= content.length) return false;
    // a paragraph directly inside a list item is interrupted by ANY
    // ordered list marker; at top level / in a quote only 1. interrupts
    if (leaf && leaf.t === 'para' && leaf.parent && leaf.parent.t === 'item') return true;
    return lm.bullet || lm.num === 1;
  }
  function listContinues(list, lm) {
    if (list.bullet !== lm.bullet) return false;
    if (lm.bullet) return list.marker === lm.marker;
    return list.delim === lm.delim;
  }
  function continuesOpenList(content) {
    const lm = matchListMarker(content);
    if (!lm) return false;
    for (let k = stack.length - 1; k >= 1; k--) {
      if (stack[k].t === 'list') return listContinues(stack[k], lm);
    }
    return false;
  }
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
    // column where the innermost quote's marker region began (for the
    // nested-quote tab rule); 0 when no quote is innermost
    let quoteBase = 0;
    // ---- phase 1: match containers (outermost first) ----
    let failAt = -1;
    let fenceQuoteClose = false;
    for (let k = 1; k < stack.length; k++) {
      const fr = stack[k];
      if (fr.t === 'quote') {
        const base = cur.col;
        if (!matchQuote(cur)) { failAt = k; break; }
        quoteBase = base;
      } else if (fr.t === 'item') {
        if (!matchItem(cur, fr)) { failAt = k; break; }
      }
      // list frames are transparent
    }
    if (failAt >= 0) {
      let fenceFall = false;
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
          const lazyContent = curRest(cur);
          const isListLine = matchListMarker(lazyContent) && paraInListItem();
          if (leaf && leaf.t === 'para' && !isListLine && !continuesOpenList(lazyContent) && isLazyLine(lazyContent)) {
            const content = curRest(cur);
            const firstFailed = stack[failAt];
            const se = matchSetext(content);
            if (se && leaf.lastLazy && firstFailed.t === 'quote') {
              if (content[0] === '\t') {
                leaf.lines.push(content);
              } else {
                let n = 0;
                while (n < content.length && content[n] === ' ') n++;
                leaf.lines.push(' '.repeat(Math.max(4, n)) + content.slice(n));
              }
            } else if (leadingWsCols(content, cur.col) >= 4) {
              curSkipWs(cur, 4);
              leaf.lines.push(curRest(cur));
            } else {
              leaf.lines.push(content);
            }
            leaf.lastLazy = true;
            continue;
          }
          while (stack.length > failAt) {
            const fr = stack.pop();
            if (leaf && leaf.parent === fr) closeLeaf(li - 1, 'container');
          }
        }
      }
    }
    // ---- phase 2: process the remaining content ----
    while (true) {
      // Expand leading tabs to spaces when the line is inside a container.
      // The tab's column is counted from the start of the INNERMOST
      // quote's marker region when the innermost container is a quote
      // (marked expands it as if the outer containers were already
      // stripped); otherwise from the line start. At the top level the
      // tab is preserved.
      if (stack.length > 1) {
        const rest0 = curRest(cur);
        const baseCol = (top().t === 'quote') ? quoteBase : 0;
        let k = 0, col = cur.col - baseCol, out = '';
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
        if (f && f.ch === leaf.ch && f.len >= leaf.len && f.info.trim() === '') {
          leaf = null;
        } else {
          const sv = saveCur(cur);
          if (leaf.ch === '`') fenceStripIndent(cur, leaf.indent);
          const pushed = curRest(cur);
          leaf.node.lines.push(pushed);
          if (failAt < 0 && /\S/.test(pushed)) leaf.anchored = true;
          restoreCur(cur, sv);
        }
        break;
      }
      // indented-code leaf
      if (leaf && leaf.t === 'code') {
        if (/^[ \t]*$/.test(curRest(cur))) {
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
          if (/^ *\t$/.test(content) && isTableLines(leaf.lines)) {
            leaf.lines.push(content);
            leaf.lastLazy = false;
            break;
          }
          closeLeaf(li - 1); setBlankFlag(); break;
        }
        const se = matchSetext(content);
        if (se) {
          const rest = takeDefs(leaf.lines, refs);
          if (rest.length === 0) {
            closeLeaf(li - 1, 'container');
            continue;
          }
          if (isTableLines(rest)) {
            if (se === 2 && isHrLine(content)) {
              closeLeaf(li - 1, 'container');
              addBlock(top(), { t: 'hr' });
            } else {
              leaf.lines.push(content);
              leaf.lastLazy = false;
            }
          } else {
            const node = leaf.node;
            node.t = 'heading';
            node.level = se === 1 ? 1 : 2;
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
        continue;
      }
      if (curBlank(cur)) {
        setBlankFlag();
        if (top().t === 'item' && top().children.length === 0) {
          stack.pop();
        }
        break;
      }
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
        quoteBase = cur.col;
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
        const prev = list.children[list.children.length - 1];
        if (prev && prev.blankBelow) list.loose = true;
        const item = { t: 'item', children: [], blank: false, blankBelow: false, loose: false, contentIndent, task: null };
        list.children.push(item);
        stack.push(item);
        const rest = curRest(cur);
        if (rest.length >= 3 && rest[0] === '[' && (rest[1] === ' ' || rest[1] === 'x' || rest[1] === 'X') && rest[2] === ']' && (rest[3] === ' ' || rest[3] === '\t')) {
          item.task = rest[1] === ' ' ? ' ' : 'x';
          cur.p += 3; cur.col += 3;
          while (cur.p < cur.s.length && (cur.s[cur.p] === ' ' || cur.s[cur.p] === '\t')) { cur.p++; cur.col++; }
        }
        if (/^[ \t]*$/.test(curRest(cur))) break;
        continue;
      }
      const hb2 = matchHtmlBlockStart(content);
      if (hb2) {
        const node = { t: 'html', type: hb2.type, end: hb2.end, lines: [content], text: '' };
        addBlock(top(), node);
        leaf = { t: 'html', node, parent: top(), lastIdx: li };
        if (hb2.end && content.toLowerCase().includes(hb2.end)) closeLeaf(li, 'endcond');
        break;
      }
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
      {
        const node = { t: 'para', lines: [content] };
        addBlock(top(), node);
        leaf = { t: 'para', node, parent: top(), lines: node.lines, lastLazy: false };
        break;
      }
    }
    if (fenceQuoteClose) {
      while (stack.length > failAt + 1) {
        const fr = stack.pop();
        if (leaf && leaf.parent === fr) closeLeaf(li - 1, 'container');
      }
    }
  }
  closeLeaf(lines.length - 1, 'eof');
  return { root, refs };
}

// ---------- renderer ----------

function renderBlocks(nodes, refs) {
  let out = '';
  for (const nd of nodes) out += renderBlock(nd, refs);
  return out;
}

function renderBlock(nd, refs) {
  switch (nd.t) {
    case 'para':
      return '<p>' + parseInline(nd.lines.join('\n'), refs) + '</p>\n';
    case 'heading':
      return '<h' + nd.level + '>' + parseInline(nd.text, refs) + '</h' + nd.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code':
    case 'fence': {
      const ls = nd.t === 'fence' && nd.lines.length && nd.lines[nd.lines.length - 1] === ''
        ? nd.lines.slice(0, -1) : nd.lines;
      const body = ls.join('\n');
      const cls = nd.t === 'fence' && nd.lang ? ' class="language-' + escAttr(nd.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escCode(body) + (ls.length ? '\n' : '') + '</code></pre>\n';
    }
    case 'html':
      return nd.text;
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < nd.header.length; k++) {
        const a = nd.align[k] ? ' align="' + nd.align[k] + '"' : '';
        out += '<th' + a + '>' + parseInline(nd.header[k], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (nd.rows.length) {
        out += '<tbody>';
        for (const row of nd.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = nd.align[k] ? ' align="' + nd.align[k] + '"' : '';
            out += '<td' + a + '>' + parseInline(row[k], refs) + '</td>\n';
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
  let seenList = false;
  for (const ch of it.children) {
    if (ch.t === 'para') {
      const inner = parseInline(ch.lines.join('\n'), refs);
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

// ---------- entry ----------

export function parse(markdown) {
  const md = String(markdown).replace(/\r\n?/g, '\n');
  const endsWithNL = md.endsWith('\n');
  let lines = md.split('\n');
  if (endsWithNL) lines.pop();
  inRawA = false;
  const { root, refs } = parseBlocks(lines, endsWithNL);
  return renderBlocks(root.children, refs);
}
