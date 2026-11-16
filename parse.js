// markdown-render-speed-02 — from-scratch CommonMark 0.31.2 + GFM 0.29 parser,
// byte-identical to marked 18.1.3 (default options) on the practice set.
// ES module, zero imports. export parse(markdown).
// Rebuilt from BUILD.md design notes (session 6).

const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/u;
const LETTER_DIGIT_RE = /[\p{L}\p{N}]/u;

function isPunct(ch) { return ch !== undefined && ch !== '' && PUNCT_RE.test(ch); }
function isSpace(ch) { return ch !== undefined && ch !== '' && SPACE_RE.test(ch); }
function isLetterDigit(ch) { return ch !== undefined && ch !== '' && LETTER_DIGIT_RE.test(ch); }

// ---------- escaping ----------
function escText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const m = /^&(?:[A-Za-z0-9_]+|#[0-9]+|#[xX][0-9a-fA-F]+);/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; }
      else out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
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
  return encodeURI(s).replace(/%25/g, '%').replace(/"/g, '%22')
    .replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\\/g, '%5C');
}

// ---------- entities ----------
function matchEntity(s, i) {
  if (s[i] !== '&') return null;
  let m = /^&#([0-9]+);/.exec(s.slice(i));
  if (m) {
    const v = parseInt(m[1], 10);
    if (v > 0x10FFFF) return null;
    const cp = (v === 0 || (v >= 0xD800 && v <= 0xDFFF)) ? 0xFFFD : v;
    return { text: String.fromCodePoint(cp), len: m[0].length };
  }
  m = /^&#[xX]([0-9a-fA-F]+);/.exec(s.slice(i));
  if (m) {
    const v = parseInt(m[1], 16);
    if (v > 0x10FFFF) return null;
    const cp = (v === 0 || (v >= 0xD800 && v <= 0xDFFF)) ? 0xFFFD : v;
    return { text: String.fromCodePoint(cp), len: m[0].length };
  }
  m = /^&[A-Za-z0-9_]+;/.exec(s.slice(i));
  if (m) return { text: m[0], len: m[0].length, named: true };
  return null;
}

// ---------- label normalization ----------
const FOLD_MAP = { '\u00df': 'ss', '\u1e9e': 'ss', '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st' };
function normalizeLabel(s) {
  let t = s.replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of t) out += FOLD_MAP[ch] || ch;
  return out.toLowerCase();
}

// ---------- inline HTML tag ----------
// Returns {len, name, closing} or null. name is lowercased tag name ('' if none).
function matchHtmlTag(s, i) {
  if (s[i] !== '<') return null;
  const rest = s.slice(i);
  let m = /^<!--(?:>|->|[\s\S]*?-->)/.exec(rest);
  if (m) return { len: m[0].length, name: '', closing: false };
  m = /^<\?[\s\S]*?\?>/.exec(rest);
  if (m) return { len: m[0].length, name: '', closing: false };
  m = /^<![A-Za-z][\s\S]*?>/.exec(rest);
  if (m) return { len: m[0].length, name: '', closing: false };
  m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(rest);
  if (m) return { len: m[0].length, name: '', closing: false };
  // open / close tag
  m = /^<\/?[A-Za-z][A-Za-z0-9-]*/.exec(rest);
  if (!m) return null;
  const closing = rest[1] === '/';
  const name = m[0].replace(/^<\/?/, '').toLowerCase();
  let p = i + m[0].length;
  if (closing) {
    while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
    if (s[p] !== '>') return null;
    return { len: p + 1 - i, name, closing: true };
  }
  // attributes; sepPending: whitespace consumed by a boolean attribute counts as separator (S5.1 cm-616)
  let sepPending = false;
  for (;;) {
    // skip whitespace (record that we saw a separator)
    let sawWs = false;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) { sawWs = true; p++; }
    if (sawWs) sepPending = true;
    if (p >= s.length) return null;
    const c = s[p];
    if (c === '>') return { len: p + 1 - i, name, closing: false };
    if (c === '/' && s[p + 1] === '>') return { len: p + 2 - i, name, closing: false };
    if (c === '/' || c === '=' || c === '"' || c === "'" || c === '<' || c === '`') return null;
    // attribute name must be preceded by whitespace (cm-609: `<m:abc>` is not a tag)
    if (!sepPending) return null;
    if (!/[A-Za-z_:]/.test(c) && c.codePointAt(0) < 128) return null;
    // attribute name
    p++;
    while (p < s.length && /[A-Za-z0-9_.:-]/.test(s[p])) p++;
    // optional = value
    let q = p;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
    if (s[q] === '=') {
      q++;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
      if (s[q] === '"') {
        const e = s.indexOf('"', q + 1);
        if (e < 0) return null;
        q = e + 1;
      } else if (s[q] === "'") {
        const e = s.indexOf("'", q + 1);
        if (e < 0) return null;
        q = e + 1;
      } else {
        // unquoted: no space " ' = < > `
        while (q < s.length && !/[\s"'=< >`]/.test(s[q])) q++;
        if (q === p) return null;
      }
      p = q;
      sepPending = false;
    } else {
      // boolean attribute: whitespace consumed before it counts as separator for the NEXT attr
      p = q;
      sepPending = true;
    }
  }
}

// ---------- bare URLs / emails ----------
const TRAIL = '?!.,: *_~;';
function trimBareUrl(u) {
  // returns trimmed url (S3.5, S3.16)
  let s = u;
  let noUnclosedTrunc = false;
  for (;;) {
    let changed = false;
    // trailing entity-like &word; / &#...; stripped whole
    const em = /&(?:[A-Za-z0-9_]+|#[0-9]+|#[xX][0-9a-fA-F]+);$/.exec(s);
    if (em) { s = s.slice(0, s.length - em[0].length); changed = true; }
    // trailing punctuation
    while (s.length && TRAIL.indexOf(s[s.length - 1]) >= 0) { s = s.slice(0, -1); changed = true; }
    if (!s.length) break;
    // paren handling (S3.16): depth with clamping; nested-group trim
    if (!noUnclosedTrunc) {
      let depth = 0, firstOpen = -1;
      for (let k = 0; k < s.length; k++) {
        if (s[k] === '(') { if (depth === 0) firstOpen = k; depth++; }
        else if (s[k] === ')') { if (depth > 0) depth--; }
      }
      if (depth > 0 && firstOpen >= 0) { s = s.slice(0, firstOpen); changed = true; }
    }
    // trailing ')' trim
    while (s.length && s[s.length - 1] === ')') {
      // find matching '(' scanning back from this ')'
      let d = 0, open = -1, nested = false;
      for (let k = s.length - 1; k >= 0; k--) {
        if (s[k] === ')') d++;
        else if (s[k] === '(') {
          d--;
          if (d === 0) { open = k; break; }
        }
      }
      if (open < 0) { s = s.slice(0, -1); changed = true; continue; }
      // group (open, end): does it contain another '(' ?
      let hasNested = false;
      for (let k = open + 1; k < s.length - 1; k++) if (s[k] === '(') { hasNested = true; break; }
      if (hasNested) { s = s.slice(0, -1); noUnclosedTrunc = true; changed = true; continue; }
      break;
    }
    if (!changed) break;
  }
  return s;
}
const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const BARE_EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
function matchBareEmailAt(s, i, underCloserAt) {
  // local part [A-Za-z0-9._+-]+ then @ then domain labels joined by '.', >= 2 labels
  let j = i;
  if (!BARE_EMAIL_LOCAL.test(s[j] || '')) return null;
  while (j < s.length && BARE_EMAIL_LOCAL.test(s[j])) j++;
  if (s[j] !== '@') return null;
  const local = s.slice(i, j);
  if (!local) return null;
  j++;
  const dStart = j;
  // domain: labels [A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])? joined by '.'
  let labels = 0, lastEnd = j;
  for (;;) {
    if (!/[A-Za-z0-9]/.test(s[j] || '')) return null;
    j++;
    while (j < s.length && /[A-Za-z0-9_-]/.test(s[j])) j++;
    // back up over trailing -/_ (S3.8: all of them)
    let e = j;
    while (e > dStart && (s[e - 1] === '-' || s[e - 1] === '_')) e--;
    if (e === dStart) return null;
    // last label must end alnum: check char before e is alnum
    if (!/[A-Za-z0-9]/.test(s[e - 1])) return null;
    labels++;
    lastEnd = e;
    if (s[j] === '.') {
      // '.' only continues domain when followed by a label char (S5.4)
      if (!/[A-Za-z0-9]/.test(s[j + 1] || '')) break;
      j++;
      continue;
    }
    break;
  }
  if (labels < 2) return null;
  // char after domain must not be - or _ (S3.8: unless closing-emphasis rule)
  const after = s[lastEnd];
  if (after === '-' || after === '_') {
    if (after === '_' && underCloserAt && underCloserAt(lastEnd)) {
      // plausible closing emphasis delimiter with an earlier _ opener: link anyway
    } else return null;
  }
  return { len: lastEnd - i, addr: s.slice(i, lastEnd) };
}
function matchBareUrl(s, i, brk) {
  // brk: index of a ']' that closes a link text when a valid destination follows (S3.4)
  const rest = brk >= 0 ? s.slice(i, brk) : s.slice(i);
  let m = /^(?:https?|ftp):\/\//i.exec(rest);
  let scheme = null, href = null;
  if (m) { scheme = m[0]; }
  else if (/^www\./.test(rest)) { scheme = 'www.'; }
  else if (/^xmpp:/.test(rest)) { scheme = 'xmpp:'; }
  else if (/^mailto:/.test(rest)) { scheme = 'mailto:'; }
  else return null;
  let end;
  if (scheme === 'xmpp:') {
    // xmpp: + email (dot required) + optional ONE /resource [A-Za-z0-9.@]+
    const em = matchBareEmailAt(s, i + 5);
    if (!em) return null;
    let e = i + 5 + em.len;
    if (s[e] === '/') {
      let r = e + 1;
      while (r < s.length && /[A-Za-z0-9.@]/.test(s[r])) r++;
      while (r > e + 1 && (s[r - 1] === '.' || s[r - 1] === '@')) r--;
      if (r > e + 1) e = r;
    }
    end = e;
  } else if (scheme === 'mailto:') {
    const em = matchBareEmailAt(s, i + 7);
    if (!em) return null;
    end = i + 7 + em.len;
  } else {
    // consume [^\s<>]+
    let j = i;
    const lim = brk >= 0 ? brk : s.length;
    while (j < lim && !/[\s<>]/.test(s[j])) j++;
    if (scheme === 'www.' && j === i + 4) return null;
    let u = s.slice(i, j);
    u = trimBareUrl(u);
    if (!u) return null;
    if (scheme === 'www.' && u.length <= 4) return null;
    end = i + u.length;
  }
  const url = s.slice(i, end);
  if (scheme === 'www.') href = 'http://' + url;
  else href = url;
  return { len: end - i, url, href };
}

// ---------- backslash unescape ----------
const ASCII_PUNCT = /[!\"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~]/;
function unescapeBackslashes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// ---------- link-text backtick rules (S3.9) ----------
function backtickRuns(label) {
  const runs = [];
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\' && label[i + 1] === '`') { i++; continue; }
    if (label[i] === '`') {
      let j = i;
      while (j < label.length && label[j] === '`') j++;
      runs.push({ pos: i, len: j - i });
      i = j - 1;
    }
  }
  const spans = [];
  let unpaired = 0;
  const used = new Array(runs.length).fill(false);
  for (let a = 0; a < runs.length; a++) {
    if (used[a]) continue;
    let b = -1;
    for (let c = a + 1; c < runs.length; c++) {
      if (!used[c] && runs[c].len === runs[a].len) { b = c; break; }
    }
    if (b < 0) { unpaired++; continue; }
    for (let c = a; c <= b; c++) used[c] = true;
    spans.push({ start: runs[a].pos, end: runs[b].pos + runs[b].len, content: label.slice(runs[a].pos + runs[a].len, runs[b].pos) });
  }
  return { spans, unpaired };
}
function linkTextOk(label) {
  const { spans, unpaired } = backtickRuns(label);
  if (unpaired === 1) return false;
  for (const sp of spans) {
    if (sp.content.indexOf('`') >= 0 && sp.end < label.length) return false;
  }
  return true;
}
function unpairedBacktickRuns(t) { return backtickRuns(t).unpaired; }
function hasPoisonedCodeSpan(label) {
  const { spans } = backtickRuns(label);
  return spans.some(sp => sp.content.indexOf('`') >= 0);
}

// ---------- inline link destination/title (pure) ----------
function tryInlineLink(s, i) {
  // s[i] === '('
  let p = i + 1;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  let dest = '';
  if (s[p] === '<') {
    let q = p + 1;
    while (q < s.length && s[q] !== '>' && s[q] !== '\n' && s[q] !== '<') {
      if (s[q] === '\\' && s[q + 1] === '>') { q += 2; continue; }
      q++;
    }
    if (s[q] !== '>') return { ok: false };
    dest = s.slice(p + 1, q);
    p = q + 1;
  } else {
    let depth = 0, q = p;
    while (q < s.length) {
      const c = s[q];
      if (c === '\\' && q + 1 < s.length) { q += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      q++;
    }
    dest = s.slice(p, q);
    p = q;
  }
  let title = null;
  let r = p;
  while (r < s.length && (s[r] === ' ' || s[r] === '\t' || s[r] === '\n')) r++;
  if (s[r] === '"' || s[r] === "'" || s[r] === '(') {
    const q0 = s[r];
    const close = q0 === '(' ? ')' : q0;
    let q = r + 1, ok = false;
    while (q < s.length) {
      if (s[q] === '\\' && q + 1 < s.length) { q += 2; continue; }
      if (s[q] === close) { ok = true; break; }
      q++;
    }
    if (!ok) return { ok: false };
    title = s.slice(r + 1, q);
    r = q + 1;
    while (r < s.length && (s[r] === ' ' || s[r] === '\t' || s[r] === '\n')) r++;
  }
  if (s[r] !== ')') return { ok: false };
  return { ok: true, href: unescapeBackslashes(dest), title: title === null ? null : unescapeBackslashes(title), end: r + 1 };
}
function hasClosingParen(s, openIdx) {
  let depth = 0;
  for (let p = openIdx; p < s.length; p++) {
    const c = s[p];
    if (c === '<') {
      let q = p + 1;
      while (q < s.length && s[q] !== '>' && s[q] !== '\n') {
        if (s[q] === '\\' && s[q + 1] === '>') q += 2; else q++;
      }
      if (s[q] === '>') { p = q; continue; }
    } else if (c === '"' || c === "'") {
      let q = p + 1;
      while (q < s.length && s[q] !== c) {
        if (s[q] === '\\' && q + 1 < s.length) q += 2; else q++;
      }
      if (s[q] === c) { p = q; continue; }
    } else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return true; }
  }
  return false;
}

// ---------- autolink email ----------
function matchAutolinkEmail(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  const local = s.slice(0, at);
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local)) return false;
  const dom = s.slice(at + 1);
  if (!dom) return false;
  const labels = dom.split('.');
  for (const lb of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(lb)) return false;
  }
  return true;
}

let inRawA = false;

// ---------- inline parser ----------
// Node types: 0 text {s, raw?, lit?} | 1 code {s} | 2 delim {ch,len,orig,canOpen,canClose,opens,closes,linkId,id,nextCh,src,leftoverInside?}
// 3 linkOpen {href,title,auto?,angle?,bare?} | 4 linkClose | 5 img {src,altNodes,title} | 6 html {s} | 7 hardbreak | 8 softbreak | 9 open '[' | 10 open '!['
function parseInlineText(text, refs) {
  const nodes = [];
  const delims = [];
  const openers = [];
  let nextId = 0;
  let nextLinkId = 1;
  const n = text.length;

  function pushText(s, lit) {
    if (!s) return;
    const last = nodes[nodes.length - 1];
    if (last && last.t === 0 && !last.raw && !!last.lit === !!lit) { last.s += s; return; }
    nodes.push({ t: 0, s, lit: !!lit });
  }
  function hasLinkInRange(ni) {
    for (let k = ni + 1; k < nodes.length; k++) {
      if (nodes[k].t === 3 && !nodes[k].auto && !nodes[k].angle) return true;
    }
    return false;
  }
  // Pure mirror of the ']' handler decision. Returns {ok, kind, href, title, end}.
  function resolveLinkAt(j) {
    let oi = openers.length - 1;
    while (oi >= 0 && !openers[oi].active) oi--;
    if (oi < 0) return { ok: false };
    const op = openers[oi];
    const labelRaw = text.slice(op.src + (op.img ? 2 : 1), j);
    if (!op.img && hasLinkInRange(op.ni)) return { ok: false }; // a link's text cannot contain a link; an image's alt CAN
    if (!linkTextOk(labelRaw)) return { ok: false };
    const after = text[j + 1];
    if (after === '(') {
      const r = tryInlineLink(text, j + 1);
      if (r.ok) return { ok: true, kind: 'inline', href: r.href, title: r.title, end: r.end };
      const ref = refs.get(normalizeLabel(labelRaw));
      if (ref) return { ok: true, kind: 'shortcut', href: ref.href, title: ref.title, end: j + 1 };
      return { ok: false };
    }
    if (after === '[') {
      // full ref [label] or collapsed []
      if (text[j + 2] === ']') {
        const ref = refs.get(normalizeLabel(labelRaw));
        if (ref) return { ok: true, kind: 'collapsed', href: ref.href, title: ref.title, end: j + 3 };
        return { ok: false };
      }
      let k = j + 2, ok = true;
      while (k < n && text[k] !== ']') {
        if (text[k] === '\\' && k + 1 < n) { k += 2; continue; }
        if (text[k] === '[') { ok = false; break; }
        k++;
      }
      if (!ok || k >= n) return { ok: false };
      const lab = text.slice(j + 2, k);
      const ref = refs.get(normalizeLabel(lab));
      if (ref) return { ok: true, kind: 'ref', href: ref.href, title: ref.title, end: k + 1 };
      return { ok: false };
    }
    const ref = refs.get(normalizeLabel(labelRaw));
    if (ref) return { ok: true, kind: 'shortcut', href: ref.href, title: ref.title, end: j + 1 };
    return { ok: false };
  }
  function bracketFormsLink(j) { return resolveLinkAt(j).ok; }
  function underCloserAt(pos) {
    for (const d of delims) if (d.ch === '_' && d.canOpen && d.src < pos) return true;
    return false;
  }
  function suppressDelimsInRange(ni) {
    const keep = [];
    for (const d of delims) {
      // delim node objects are in `nodes`; find their index by identity is O(n^2) — instead track via node index stored at creation
      if (d._ni > ni) continue; // only delims created after the opener... (refined below)
      keep.push(d);
    }
    // NOTE: replaced by index-based suppression in handleCloseBracket (see below).
    return keep;
  }
  function emitBareLink(bu, isEmail) {
    const href = isEmail ? 'mailto:' + bu.url : bu.href;
    nodes.push({ t: 3, href, title: null, auto: true, bare: true });
    pushText(bu.url);
    nodes.push({ t: 4 });
  }

  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      if (last && last.t === 0 && / {2,}$/.test(last.s)) {
        last.s = last.s.replace(/ {2,}$/, '');
        if (!last.s) nodes.pop();
        nodes.push({ t: 7 });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      nodes.push({ t: 8 });
      i++;
      continue;
    }
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        nodes.push({ t: 7 });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT.test(nx)) {
        if (nx === '&') pushText('&', true);
        else pushText(nx);
        i += 2;
        continue;
      }
      pushText('\\');
      i++;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (k < n && text[k] === '`') k++;
      const L = k - i;
      let j = k, closer = -1;
      while (j < n) {
        if (text[j] === ']' && bracketFormsLink(j)) break;
        if (text[j] === '`') {
          let m2 = j;
          while (m2 < n && text[m2] === '`') m2++;
          if (m2 - j === L) { closer = j; break; }
          j = m2;
        } else j++;
      }
      if (closer < 0) { pushText('`'.repeat(L)); i += L; continue; }
      let content = text.slice(i + L, closer).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /\S/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 1, s: content });
      i = closer + L;
      continue;
    }
    if (c === '[') {
      openers.push({ ni: nodes.length, img: false, active: true, src: i });
      nodes.push({ t: 9 });
      i++;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      openers.push({ ni: nodes.length, img: true, active: true, src: i });
      nodes.push({ t: 10 });
      i += 2;
      continue;
    }
    if (c === ']') {
      // ---- ']' handler ----
      let oi = openers.length - 1;
      while (oi >= 0 && !openers[oi].active) oi--;
      if (oi < 0) { pushText(']'); i++; continue; }
      const op = openers[oi];
      const labelRaw = text.slice(op.src + (op.img ? 2 : 1), i);
      const res = resolveLinkAt(i);
      if (!res.ok) {
        op.active = false;
        const after = text[i + 1];
        if (after === '(' && !op.img && !hasLinkInRange(op.ni) && hasClosingParen(text, i + 1)) {
          if (linkTextOk(labelRaw) || hasPoisonedCodeSpan(labelRaw)) {
            // suppress emphasis delims inside the label range (nodes op.ni+1 .. end)
            const nodeIdx = new Map();
            for (let k = 0; k < nodes.length; k++) nodeIdx.set(nodes[k], k);
            for (let d = delims.length - 1; d >= 0; d--) {
              const idx = nodeIdx.get(delims[d]);
              if (idx !== undefined && idx > op.ni) delims.splice(d, 1);
            }
          }
        }
        pushText(']');
        i++;
        continue;
      }
      if (op.img) {
        const altNodes = nodes.slice(op.ni + 1);
        const lid = nextLinkId++;
        for (const an of altNodes) if (an.t === 2) an.linkId = lid;
        nodes.length = op.ni;
        nodes.push({ t: 5, src: res.href, altNodes, title: res.title });
        openers.length = oi;
        // demote bare autolinks in alt (they are plain text in alt anyway; no-op)
        i = res.end;
        continue;
      }
      // link forms: replace opener with linkOpen, append linkClose
      nodes[op.ni] = { t: 3, href: res.href, title: res.title };
      openers.length = oi;
      // S3.4 demotion: flatten bare autolink triples inside the link text
      for (let k = op.ni + 1; k < nodes.length; k++) {
        if (nodes[k].t === 3 && nodes[k].auto) {
          nodes.splice(k, 1); // remove linkOpen; text shifts to k, close at k+1
          nodes.splice(k + 1, 1); // remove linkClose; text stays at k
        }
      }
      nodes.push({ t: 4 });
      i = res.end;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let k = i;
      while (k < n && text[k] === c) k++;
      const len = k - i;
      const prev = i > 0 ? text[i - 1] : ' ';
      const next = k < n ? text[k] : ' ';
      const leftFl = !isSpace(next) && (!isPunct(next) || isSpace(prev) || isPunct(prev));
      const rightFl = !isSpace(prev) && (!isPunct(prev) || isSpace(next) || isPunct(next));
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFl; canClose = rightFl; }
      else if (c === '_') { canOpen = leftFl && (!rightFl || isPunct(prev)); canClose = rightFl && (!leftFl || isPunct(next)); }
      else { canOpen = leftFl; canClose = rightFl; }
      const nd = { t: 2, ch: c, len, orig: len, canOpen, canClose, opens: [], closes: [], linkId: 0, id: nextId++, nextCh: next, src: i };
      nodes.push(nd);
      delims.push(nd);
      i = k;
      continue;
    }
    if (c === '<') {
      const gt = text.indexOf('>', i);
      let done = false;
      if (gt > i) {
        const inner = text.slice(i + 1, gt);
        if (inner && !/[\s<>]/.test(inner)) {
          if (inner.indexOf('@') >= 0 && matchAutolinkEmail(inner)) {
            nodes.push({ t: 3, href: 'mailto:' + inner, title: null, angle: true, bare: true });
            pushText(inner);
            nodes.push({ t: 4 });
            i = gt + 1;
            done = true;
          } else {
            const sm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(inner);
            if (sm) {
              nodes.push({ t: 3, href: inner, title: null, angle: true, bare: true });
              pushText(inner);
              nodes.push({ t: 4 });
              i = gt + 1;
              done = true;
            }
          }
        }
      }
      if (done) continue;
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
    if (c === '&') {
      const e = matchEntity(text, i);
      if (e) {
        if (e.named) nodes.push({ t: 0, s: e.text, raw: true });
        else pushText(e.text); // numeric: decoded char, escaped by escText if special (cm-027)
        i += e.len; continue;
      }
      pushText('&amp;');
      i++;
      continue;
    }
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w' || c === 'W' || c === 'x' || c === 'X' || c === 'm' || c === 'M') {
      if (!inRawA) {
        // pre-scan for a ']' that closes a link text with a valid destination (S3.4)
        let brk = -1;
        let j = i;
        while (j < n && !/[\s<>]/.test(text[j])) { if (text[j] === ']') { brk = j; break; } j++; }
        if (brk >= 0 && !resolveLinkAt(brk).ok) brk = -1;
        const bu = matchBareUrl(text, i, brk);
        if (bu) { emitBareLink(bu, false); i += bu.len; continue; }
      }
      // fall through to email/text handling
    }
    // ---- text run (with email detection inside) ----
    {
      let j = i;
      while (j < n) {
        const cc = text[j];
        if (cc === '\n' || cc === '\\' || cc === '`' || cc === '[' || cc === ']' || cc === '*' || cc === '~' || cc === '<' || cc === '&' || cc === '!') break;
        if (cc === '_') {
          // '_' inside an email local part (e.g. a.b-c_d@a.b) is not an emphasis delimiter (gfm-632)
          let q = j;
          while (q < n && BARE_EMAIL_LOCAL.test(text[q])) q++;
          if (q < n && text[q] === '@') { j++; continue; }
          break;
        }
        if ((cc === 'h' || cc === 'H' || cc === 'f' || cc === 'F' || cc === 'w' || cc === 'W' || cc === 'x' || cc === 'X' || cc === 'm' || cc === 'M') && j > i) {
          // don't break the run if this letter is part of an email local part (an '@' follows over local chars) (cm-612, gfm-630/631/632)
          let q = j;
          while (q < n && BARE_EMAIL_LOCAL.test(text[q])) q++;
          if (q < n && text[q] === '@') { j = q; continue; }
          break;
        }
        j++;
      }
      if (j === i) { pushText(text[i]); i++; continue; } // lone '!' or failed URL-start char: consume one char
      if (!inRawA) {
        let k = i, emitted = false;
        while (k < j) {
          const at = text.indexOf('@', k);
          if (at < 0 || at >= j) break;
          let s0 = at - 1;
          while (s0 >= i && BARE_EMAIL_LOCAL.test(text[s0])) s0--;
          s0++;
          if (s0 < at) {
            const em = matchBareEmailAt(text, s0, underCloserAt);
            if (em) {
              if (s0 > i) pushText(text.slice(i, s0));
              emitBareLink({ url: em.addr, len: em.len }, true);
              i = s0 + em.len;
              emitted = true;
              break;
            }
          }
          k = at + 1;
        }
        if (emitted) continue;
      }
      pushText(text.slice(i, j));
      i = j;
      continue;
    }
  }

  // ---- assign linkIds (walk nodes, track link depth) ----
  {
    const stack = [];
    for (const nd of nodes) {
      if (nd.t === 3) { const id = nextLinkId++; stack.push(id); }
      else if (nd.t === 4) { stack.pop(); }
      else if (nd.t === 2) { nd.linkId = stack.length ? stack[stack.length - 1] : 0; }
    }
  }
  // ---- poisoned-link suppression (S3.17 + S4: up to LAST code span) ----
  {
    const suppressed = new Set();
    for (let a = 0; a < nodes.length; a++) {
      if (nodes[a].t !== 3 || nodes[a].auto || nodes[a].angle) continue;
      // find matching close
      let depth = 0, closeIdx = -1;
      for (let b = a; b < nodes.length; b++) {
        if (nodes[b].t === 3) depth++;
        else if (nodes[b].t === 4) { depth--; if (depth === 0) { closeIdx = b; break; } }
      }
      if (closeIdx < 0) continue;
      let label = '';
      for (let b = a + 1; b < closeIdx; b++) if (nodes[b].t === 0) label += nodes[b].s;
      if (unpairedBacktickRuns(label) < 2) continue;
      // last code span after the close
      let lastCode = -1;
      for (let b = closeIdx + 1; b < nodes.length; b++) if (nodes[b].t === 1) lastCode = b;
      if (lastCode < 0) continue;
      for (let b = closeIdx + 1; b < lastCode; b++) {
        if (nodes[b].t === 2 && nodes[b].linkId === 0) suppressed.add(nodes[b]);
      }
    }
    if (suppressed.size) {
      for (let d = delims.length - 1; d >= 0; d--) if (suppressed.has(delims[d])) delims.splice(d, 1);
    }
  }

  resolveEmphasis(nodes, delims);
  return nodes;
}

// ---------- emphasis resolution ----------
function kRuleCheck(op, cur, use, formed, byId, delims) {
  for (const f of formed) {
    if (f.openId > op.id && f.closeId < cur.id) {
      const innerOp = byId.get(f.openId);
      const innerCl = byId.get(f.closeId);
      if (!innerOp || !innerCl) continue;
      if ((f.use !== use || innerOp.orig !== op.orig) && f.ch === op.ch && !innerOp.canClose && isLetterDigit(innerCl.nextCh)) {
        if (use > f.use) {
          let cancelled = false;
          for (const d of delims) {
            if (d.id > f.closeId && d.id < cur.id && d.ch === op.ch && d.canClose && !d.canOpen) { cancelled = true; break; }
          }
          if (cancelled) continue;
        }
        return cur.len <= 2 ? 'block' : 'inside';
      }
    }
  }
  return null;
}
function resolveEmphasis(nodes, delims) {
  if (!delims.length) return;
  const byId = new Map();
  for (const d of delims) byId.set(d.id, d);
  // doubly-linked list over delims with len > 0, in creation order
  let head = null, prev = null;
  for (const d of delims) {
    if (d.len <= 0) continue;
    d._prev = prev;
    d._next = null;
    if (prev) prev._next = d;
    else head = d;
    prev = d;
  }
  const formed = []; // {openId, closeId, use, ch}
  function insideFormed(id) {
    for (const f of formed) if (id > f.openId && id < f.closeId) return true;
    return false;
  }
  function unlink(d) {
    if (d._prev) d._prev._next = d._next;
    else head = d._next;
    if (d._next) d._next._prev = d._prev;
    d._prev = d._next = null;
  }
  let cur = head;
  while (cur) {
    const nextCur = cur._next;
    if (!cur.canClose) { cur = nextCur; continue; }
    // nearest compatible opener (look back from the closer)
    let found = null, foundUse = 0;
    let op = cur._prev;
    while (op) {
      if (op.ch === cur.ch && op.canOpen && op.len > 0 && op.linkId === cur.linkId && !insideFormed(op.id)) {
        if ((op.canClose || cur.canOpen) && (op.orig + cur.orig) % 3 === 0 && !(op.orig % 3 === 0 && cur.orig % 3 === 0)) {
          op = op._prev; continue;
        }
        let use;
        if (cur.ch === '~') {
          if (op.len !== cur.len || op.len > 2) { op = op._prev; continue; }
          use = op.len;
        } else {
          use = (op.len >= 2 && cur.len >= 2) ? 2 : 1;
        }
        if (cur.ch !== '~') {
          const k = kRuleCheck(op, cur, use, formed, byId, delims);
          if (k === 'block') { op = op._prev; continue; }
          if (k === 'inside') cur.leftoverInside = true;
        }
        found = op; foundUse = use;
        break;
      }
      op = op._prev;
    }
    if (found) {
      found.opens.push({ n: foundUse, ch: found.ch });
      cur.closes.push({ n: foundUse, ch: cur.ch });
      found.len -= foundUse;
      cur.len -= foundUse;
      formed.push({ openId: found.id, closeId: cur.id, use: foundUse, ch: found.ch });
      if (found.len <= 0) unlink(found);
      if (cur.len <= 0) { unlink(cur); cur = nextCur; }
      // else: closer still has delimiters left -> re-process the same closer
    } else {
      cur = nextCur;
    }
  }
  for (const d of delims) { d._prev = d._next = null; }
}

// ---------- inline rendering ----------
function openTag(p) {
  if (p.ch === '~') return '<del>';
  return p.n === 2 ? '<strong>' : '<em>';
}
function closeTag(p) {
  if (p.ch === '~') return '</del>';
  return p.n === 2 ? '</strong>' : '</em>';
}
function plainText(ns) {
  let out = '';
  for (const nd of ns) {
    if (nd.t === 0 || nd.t === 1) out += nd.s;
    else if (nd.t === 2) out += nd.ch.repeat(Math.max(0, nd.len));
    else if (nd.t === 5) out += plainText(nd.altNodes);
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
      case 0: out += nd.lit ? escCode(nd.s) : (nd.raw ? nd.s : escText(nd.s)); break;
      case 1: out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 2: {
        const leftover = nd.ch.repeat(Math.max(0, nd.len));
        if (nd.leftoverInside && nd.len > 0 && nd.closes.length > 0 && nd.opens.length === 0) {
          out += leftover;
          for (const c of nd.closes) out += closeTag(c);
          for (let k = nd.opens.length - 1; k >= 0; k--) out += openTag(nd.opens[k]);
        } else {
          for (const c of nd.closes) out += closeTag(c);
          out += leftover;
          for (let k = nd.opens.length - 1; k >= 0; k--) out += openTag(nd.opens[k]);
        }
        break;
      }
      case 3: {
        const href = nd.bare ? escCode(encodeHref(nd.href)) : escAttr(encodeHref(nd.href));
        out += '<a href="' + href + '"' + (nd.title != null ? ' title="' + escAttr(nd.title) + '"' : '') + '>';
        break;
      }
      case 4: out += '</a>'; break;
      case 5: {
        const src = escAttr(encodeHref(nd.src));
        out += '<img src="' + src + '" alt="' + escAttr(plainText(nd.altNodes)) + '"' + (nd.title != null ? ' title="' + escAttr(nd.title) + '"' : '') + '>';
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

// ---------- block parser ----------
// Cursor: {s, p, col}. Tabs advance col to the next multiple of 4.
function saveCur(cur) { return { s: cur.s, p: cur.p, col: cur.col }; }
function restoreCur(cur, sv) { cur.s = sv.s; cur.p = sv.p; cur.col = sv.col; }
function curRest(cur) { return cur.s.slice(cur.p); }
function curBlank(cur) { return cur.p >= cur.s.length; }
function curSkipWs(cur, n) {
  let rem = n;
  while (rem > 0) {
    if (cur.p >= cur.s.length) return false;
    const c = cur.s[cur.p];
    if (c === ' ') { cur.p++; cur.col++; rem--; }
    else if (c === '\t') {
      const w = 4 - (cur.col % 4);
      if (w > rem) {
        const spaces = ' '.repeat(w);
        cur.s = cur.s.slice(0, cur.p) + spaces + cur.s.slice(cur.p + 1);
        cur.p += rem; cur.col += rem;
        return true;
      }
      cur.p++; cur.col += w; rem -= w;
    } else return false;
  }
  return true;
}
function curSkipWsUpTo(cur, n) {
  let rem = n, skipped = 0;
  while (rem > 0) {
    if (cur.p >= cur.s.length) break;
    const c = cur.s[cur.p];
    if (c === ' ') { cur.p++; cur.col++; rem--; skipped++; }
    else if (c === '\t') {
      const w = 4 - (cur.col % 4);
      if (w > rem) {
        const spaces = ' '.repeat(w);
        cur.s = cur.s.slice(0, cur.p) + spaces + cur.s.slice(cur.p + 1);
        cur.p += rem; cur.col += rem; skipped += rem;
        return skipped;
      }
      cur.p++; cur.col += w; rem -= w; skipped += w;
    } else break;
  }
  return skipped;
}
// Fence indent strip: a tab counts as exactly 1 column, removed whole (S3.6)
function fenceStripIndent(cur, n) {
  let rem = n;
  while (rem > 0 && cur.p < cur.s.length) {
    const c = cur.s[cur.p];
    if (c === ' ') { cur.p++; cur.col++; rem--; }
    else if (c === '\t') { cur.p++; cur.col = Math.floor(cur.col / 4) * 4 + 4; rem--; }
    else break;
  }
}
// Expand tabs in the leading whitespace run using the effective column (S4 + fe1be70)
function expandLeadingTabs(cur, qBase, qTab) {
  let j = cur.p, hasTab = false;
  while (j < cur.s.length && (cur.s[j] === ' ' || cur.s[j] === '\t')) {
    if (cur.s[j] === '\t') hasTab = true;
    j++;
  }
  if (!hasTab) return;
  let col = cur.col - qBase + (qTab ? 1 : 0);
  let out = '';
  for (let k = cur.p; k < j; k++) {
    if (cur.s[k] === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += ' '; col++; }
  }
  cur.s = cur.s.slice(0, cur.p) + out + cur.s.slice(j);
}

function matchATX(cur) {
  const sv = saveCur(cur);
  let sp = 0;
  while (sp < 3 && cur.s[cur.p] === ' ') { cur.p++; cur.col++; sp++; }
  if (cur.s[cur.p] !== '#') { restoreCur(cur, sv); return null; }
  let level = 0;
  while (cur.s[cur.p] === '#' && level < 6) { cur.p++; cur.col++; level++; }
  const c = cur.s[cur.p];
  if (c !== undefined && c !== ' ' && c !== '\t') { restoreCur(cur, sv); return null; }
  let t = cur.s.slice(cur.p).replace(/[ \t]+$/, '');
  const m = /^(.*?)[ \t]+#+$/.exec(t);
  if (m) t = m[1];
  t = t.replace(/^[ \t]+/, '');
  return { level, text: t };
}
function matchFence(cur) {
  const sv = saveCur(cur);
  let sp = 0;
  while (sp < 3 && cur.s[cur.p] === ' ') { cur.p++; cur.col++; sp++; }
  const ch = cur.s[cur.p];
  if (ch !== '`' && ch !== '~') { restoreCur(cur, sv); return null; }
  let len = 0;
  while (cur.s[cur.p] === ch) { cur.p++; cur.col++; len++; }
  if (len < 3) { restoreCur(cur, sv); return null; }
  const info = cur.s.slice(cur.p);
  if (ch === '`' && info.indexOf('`') >= 0) { restoreCur(cur, sv); return null; } // backtick fence info cannot contain backticks (cm-138/145/347); tilde info CAN (cm-146)
  const lang = unescapeBackslashes((info.trim().split(/\s+/)[0] || ''));
  return { ch, len, info, lang, indent: sp };
}
function isHrLine(cur) {
  const sv = saveCur(cur);
  let sp = 0;
  while (sp < 3 && cur.s[cur.p] === ' ') { cur.p++; cur.col++; sp++; }
  const c = cur.s[cur.p];
  if (c !== '-' && c !== '_' && c !== '*') { restoreCur(cur, sv); return false; }
  let count = 0, p = cur.p;
  while (p < cur.s.length) {
    const cc = cur.s[p];
    if (cc === c) { count++; p++; }
    else if (cc === ' ' || cc === '\t') p++;
    else { restoreCur(cur, sv); return false; }
  }
  restoreCur(cur, sv);
  return count >= 3;
}
function matchSetext(cur) {
  const sv = saveCur(cur);
  let sp = 0;
  while (sp < 3 && cur.s[cur.p] === ' ') { cur.p++; cur.col++; sp++; }
  const c = cur.s[cur.p];
  if (c !== '=' && c !== '-') { restoreCur(cur, sv); return null; }
  let j = cur.p;
  while (j < cur.s.length && cur.s[j] === c) j++;
  let k = j;
  while (k < cur.s.length && (cur.s[k] === ' ' || cur.s[k] === '\t')) k++;
  if (k < cur.s.length) { restoreCur(cur, sv); return null; }
  return { level: c === '=' ? 1 : 2, marker: c, len: j - cur.p };
}
function matchListMarker(cur) {
  const sv = saveCur(cur);
  let sp = 0;
  while (sp < 3 && cur.s[cur.p] === ' ') { cur.p++; cur.col++; sp++; }
  const startCol = cur.col;
  const c = cur.s[cur.p];
  let bullet = false, ordered = false, start = 1, delim = '', width = 0;
  if (c === '-' || c === '*' || c === '+') {
    bullet = true; delim = c;
    cur.p++; cur.col++;
    width = 1;
  } else if (c >= '0' && c <= '9') {
    let j = cur.p;
    while (j < cur.s.length && cur.s[j] >= '0' && cur.s[j] <= '9') j++;
    const numStr = cur.s.slice(cur.p, j);
    if (numStr.length > 9) { restoreCur(cur, sv); return null; }
    const d = cur.s[j];
    if (d !== '.' && d !== ')') { restoreCur(cur, sv); return null; }
    ordered = true; start = parseInt(numStr, 10); delim = d;
    width = numStr.length + 1;
    cur.p = j + 1; cur.col = startCol + width;
  } else { restoreCur(cur, sv); return null; }
  if (cur.p >= cur.s.length) {
    return { bullet, ordered, start, delim, contentIndent: startCol + width + 1, empty: true, markerWidth: width, startCol };
  }
  // count following whitespace columns
  let p2 = cur.p, col2 = cur.col, wsCols = 0;
  while (p2 < cur.s.length && (cur.s[p2] === ' ' || cur.s[p2] === '\t')) {
    if (cur.s[p2] === ' ') { p2++; col2++; wsCols++; }
    else { const w = 4 - (col2 % 4); p2++; col2 += w; wsCols += w; }
  }
  if (wsCols === 0) { restoreCur(cur, sv); return null; }
  if (p2 >= cur.s.length) {
    // empty item: only whitespace after the marker -> contentIndent = marker width + 1 (cm-279)
    curSkipWs(cur, 1);
    return { bullet, ordered, start, delim, contentIndent: startCol + width + 1, empty: true, markerWidth: width, startCol };
  }
  let contentIndent;
  if (wsCols === 1) contentIndent = startCol + width + 1;
  else if (wsCols >= 2 && wsCols <= 4) contentIndent = startCol + width + wsCols;
  else contentIndent = startCol + width + 1;
  curSkipWs(cur, contentIndent - startCol - width);
  return { bullet, ordered, start, delim, contentIndent, empty: false, markerWidth: width, startCol };
}
const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));
function matchHtmlBlockStart(cur) {
  const sv = saveCur(cur);
  let sp = 0;
  while (sp < 3 && cur.s[cur.p] === ' ') { cur.p++; cur.col++; sp++; }
  const rest = cur.s.slice(cur.p);
  let m;
  if (/^<(script|pre|style|textarea)(?:[ \t\n>]|\/>|$)/i.test(rest)) {
    const tag = /^<([A-Za-z]+)/.exec(rest)[1].toLowerCase();
    return { type: 1, end: '</' + tag + '>' };
  }
  if (rest.startsWith('<!--')) return { type: 2, end: '-->' };
  if (rest.startsWith('<?')) return { type: 3, end: '?>' };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4, end: '>' };
  if (rest.startsWith('<![CDATA[')) return { type: 5, end: ']]>' };
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)[\s>\/]/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, end: null };
  const tag = matchHtmlTag(cur.s, cur.p);
  if (tag) {
    // type 7: the tag must be followed only by whitespace or end of line (cm-613/614/615/623/344)
    const afterTag = cur.s.slice(cur.p + tag.len);
    if (/^[ \t]*$/.test(afterTag)) return { type: 7, end: null };
  }
  restoreCur(cur, sv);
  return null;
}
// matchQuote returns 0 (no match), 1 (matched), 2 (matched, tab directly after '>').
function matchQuote(cur) {
  const sv = saveCur(cur);
  let sp = 0;
  while (sp < 3 && cur.s[cur.p] === ' ') { cur.p++; cur.col++; sp++; }
  if (cur.s[cur.p] !== '>') { restoreCur(cur, sv); return 0; }
  cur.qb = cur.col;
  cur.p++; cur.col++;
  if (cur.s[cur.p] === '\t') return 2;
  if (cur.s[cur.p] === ' ' && cur.p + 1 < cur.s.length) { cur.p++; cur.col++; }
  return 1;
}
function matchItem(cur, fr, rawBlank) {
  // Hybrid indent: an item directly inside a blockquote uses its RELATIVE content indent
  // (columns from its marker to its content), because the quote prefix consumes a different
  // number of columns per line (`>-` vs `> ` vs `>  `), so absolute columns misalign
  // (doc-15/doc-22/doc-29: a nested marker / para at relative indent < contentIndent must
  // NOT re-enter the item). Deeper items and top-level items use the absolute column.
  const inQuote = fr.parent && fr.parent.parent && fr.parent.parent.t === 'quote';
  const target = inQuote ? fr.contentIndentRel : fr.contentIndent - cur.col;
  if (rawBlank) { curSkipWsUpTo(cur, target); return true; }
  const sv = saveCur(cur);
  const skipped = curSkipWsUpTo(cur, target);
  if (skipped < target) { restoreCur(cur, sv); return false; }
  return true;
}
function peek(fn, cur) { const sv = saveCur(cur); const r = fn(cur); restoreCur(cur, sv); return r; }
function isBlockStartLine(cur) {
  if (peek(matchATX, cur)) return true;
  if (isHrLine(cur)) return true;
  if (peek(matchFence, cur)) return true;
  if (/^ {0,3}>/.test(curRest(cur))) return true;
  if (peek(matchListMarker, cur)) return true;
  const hb = peek(matchHtmlBlockStart, cur);
  if (hb && hb.type !== 7) return true;
  return false;
}

// ---------- link reference definitions ----------
function parseOneDef(text, pos, refs) {
  const N = text.length;
  let p = pos;
  let sp = 0;
  while (sp < 3 && text[p] === ' ') { p++; sp++; }
  if (text[p] !== '[') return null;
  let q = p + 1, labelEnd = -1;
  while (q < N) {
    if (text[q] === '\\' && q + 1 < N) { q += 2; continue; }
    if (text[q] === '[') return null;
    if (text[q] === ']') { labelEnd = q; break; }
    q++;
  }
  if (labelEnd < 0) return null;
  const label = normalizeLabel(text.slice(p + 1, labelEnd));
  if (!label || label.length > 999) return null;
  q = labelEnd + 1;
  if (text[q] !== ':') return null;
  q++;
  let r = q;
  while (text[r] === ' ') r++;
  if (text[r] === '\t') return null;
  if (text[r] === '\n') {
    r++;
    while (r < N && (text[r] === ' ' || text[r] === '\t')) r++;
    if (r >= N) return null;
  }
  let dest = '';
  if (text[r] === '<') {
    let e = r + 1;
    while (e < N && text[e] !== '>' && text[e] !== '\n' && text[e] !== '<') {
      if (text[e] === '\\' && text[e + 1] === '>') { e += 2; continue; }
      e++;
    }
    if (text[e] !== '>') return null;
    dest = text.slice(r + 1, e);
    r = e + 1;
  } else {
    let depth = 0, e = r;
    while (e < N) {
      const c = text[e];
      if (c === '\\' && e + 1 < N) { e += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      e++;
    }
    if (e === r) return null;
    dest = text.slice(r, e);
    r = e;
  }
  dest = unescapeBackslashes(dest);
  let title = null;
  // --- optional title: same line, or the immediately following line (no blank line) ---
  const parseTitleAt = (t2) => {
    if (t2 === r) return 'nospace'; // title with NO separating whitespace is not a def
    const q0 = text[t2];
    const close = q0 === '(' ? ')' : q0;
    let e = t2 + 1, ok = false;
    while (e < N) {
      if (text[e] === '\\' && e + 1 < N) { e += 2; continue; }
      if (text[e] === close) { ok = true; break; }
      if (text[e] === '\n' && text[e + 1] === '\n') return 'blankline'; // blank line inside a title invalidates the def (cm-197)
      e++;
    }
    if (!ok) return 'unclosed';
    let f = e + 1;
    while (f < N && (text[f] === ' ' || text[f] === '\t')) f++;
    if (f < N && text[f] !== '\n') return 'junk'; // junk after the title invalidates the def (cm-209)
    title = unescapeBackslashes(text.slice(t2 + 1, e));
    r = f;
    return 'ok';
  };
  let tp = r;
  while (tp < N && (text[tp] === ' ' || text[tp] === '\t')) tp++;
  if (text[tp] === '"' || text[tp] === "'" || text[tp] === '(') {
    const st = parseTitleAt(tp);
    if (st !== 'ok') return null;
  } else if (text[tp] === '\n') {
    let q = tp + 1;
    while (q < N && (text[q] === ' ' || text[q] === '\t')) q++;
    if (q < N && text[q] !== '\n' && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
      // title on the next line: if malformed, the def is still valid WITHOUT it (cm-210)
      const st = parseTitleAt(q);
      if (st !== 'ok') r = tp;
    } else {
      r = tp; // no title; def ends at the end of the dest's line
    }
  } else if (tp >= N) {
    r = tp;
  } else {
    return null; // junk after the destination on the same line -> not a def
  }
  if (!refs.has(label)) refs.set(label, { href: dest, title });
  return { endPos: r };
}
function extractDefs(text, refs) {
  let pos = 0;
  const N = text.length;
  while (pos < N) {
    const r = parseOneDef(text, pos, refs);
    if (!r) break;
    pos = r.endPos;
    if (text[pos] === '\n') pos++;
    else break;
  }
  return text.slice(pos);
}

// ---------- tables ----------
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}
function trimEdgeCells(cells) {
  let c = cells.slice();
  if (c.length && c[0].trim() === '') c = c.slice(1);
  if (c.length && c[c.length - 1].trim() === '') c = c.slice(0, -1);
  return c;
}
function isTableLines(lines) {
  if (lines.length < 2) return false;
  const hRaw = splitRow(lines[0]);
  if (hRaw.length < 2) return false; // header must contain an unescaped |
  const hCells = trimEdgeCells(hRaw);
  const dCells = trimEdgeCells(splitRow(lines[1]));
  if (dCells.length !== hCells.length) return false;
  for (const dc of dCells) {
    if (!/^:?-+:?$/.test(dc.trim())) return false;
  }
  return true;
}
function buildTable(lines) {
  const hCells = trimEdgeCells(splitRow(lines[0])).map(c => c.trim());
  const dCells = trimEdgeCells(splitRow(lines[1]));
  const aligns = dCells.map(dc => {
    const t = dc.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.startsWith(':')) return 'left';
    if (t.endsWith(':')) return 'right';
    return null;
  });
  const rows = [];
  for (let k = 2; k < lines.length; k++) {
    const rc = trimEdgeCells(splitRow(lines[k])).map(c => c.trim());
    while (rc.length < hCells.length) rc.push('');
    if (rc.length > hCells.length) rc.length = hCells.length;
    rows.push(rc);
  }
  return { t: 'table', header: hCells, aligns, rows };
}
function paraContainsTable(lines) {
  for (let k = 0; k + 1 < lines.length; k++) {
    if (isTableLines(lines.slice(k, k + 2))) return true;
  }
  return false;
}
function finalizePara(lines, refs) {
  const text = lines.join('\n');
  const restText = extractDefs(text, refs);
  if (!restText || !/\S/.test(restText)) return null;
  const restLines = restText.split('\n');
  if (isTableLines(restLines)) return buildTable(restLines);
  for (let k = 0; k < restLines.length - 1; k++) {
    if (isTableLines(restLines.slice(k, k + 2))) {
      const paraPart = restLines.slice(0, k);
      const out = [];
      if (paraPart.length && /\S/.test(paraPart.join('\n'))) out.push({ t: 'para', lines: paraPart });
      out.push(buildTable(restLines.slice(k)));
      return out;
    }
  }
  return { t: 'para', lines: restLines };
}

// ---------- main parser ----------
export function parse(markdown) {
  inRawA = false;
  const text = markdown.replace(/\r\n?/g, '\n');
  const endsWithNL = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNL) lines.pop();
  const refs = new Map();
  const doc = { t: 'doc', children: [], blank: false, blankBelow: false, loose: false, parent: null };
  const stack = [doc];
  let leaf = null;

  function addBlock(frame, node) {
    if (frame.blankBelow && frame.children.length > 0) frame.loose = true;
    let f = frame;
    while (f) { f.blankBelow = false; f = f.parent; }
    frame.children.push(node);
  }
  function markBlank() {
    const top = stack[stack.length - 1];
    top.blank = true;
    top.blankBelow = true;
    if (top.t === 'quote') return;
    let f = top.parent;
    while (f) {
      f.blankBelow = true;
      if (f.t === 'quote') break;
      f = f.parent;
    }
  }
  function closeLeaf(how) {
    if (!leaf) return;
    const parent = leaf.parent;
    if (leaf.t === 'para') {
      let res;
      if (leaf.asHeading) {
        const ls = leaf.lines.slice();
        if (ls.length) {
          ls[0] = ls[0].replace(/^[ \t]+/, '');
          ls[ls.length - 1] = ls[ls.length - 1].replace(/[ \t]+$/, '');
        }
        res = { t: 'heading', level: leaf.asHeading, lines: ls };
      } else {
        res = finalizePara(leaf.lines, refs);
      }
      if (res) {
        if (Array.isArray(res)) for (const nd of res) addBlock(parent, nd);
        else addBlock(parent, res);
      }
    } else if (leaf.t === 'fence') {
      if (!leaf.anchored && parent.t === 'item' && how !== 'closed') leaf.lines = [];
      if (leaf.lines.length && leaf.lines[leaf.lines.length - 1] === '') leaf.lines.pop();
      addBlock(parent, { t: 'fence', lang: leaf.lang, lines: leaf.lines });
    } else if (leaf.t === 'code') {
      addBlock(parent, { t: 'code', lines: leaf.lines });
    } else if (leaf.t === 'html') {
      if (how === 'eof') leaf.trailingNL = endsWithNL;
      addBlock(parent, { t: 'html', text: leaf.lines.join('\n'), trailingNL: !!leaf.trailingNL });
    }
    leaf = null;
  }
  function popTo(n) {
    while (stack.length > n) {
      const fr = stack.pop();
      if (leaf && leaf.parent === fr) closeLeaf('container');
    }
  }
  function computeTrailingNL(li) {
    if (li + 1 >= lines.length) return endsWithNL;
    const nextRaw = lines[li + 1];
    const nc = { s: nextRaw, p: 0, col: 0, qb: 0 };
    const rawBlank = /^\s*$/.test(nextRaw);
    for (let si = 1; si < stack.length; si++) {
      const fr = stack[si];
      if (fr.t === 'quote') {
        if (matchQuote(nc) === 0) return false;
      } else if (fr.t === 'item') {
        if (!matchItem(nc, fr, rawBlank)) return false;
      }
    }
    return nc.p < nc.s.length;
  }
  function listCanInterrupt(lm, lf) {
    if (lm.empty) return false;
    if (lf.parent && lf.parent.t === 'item') return true;
    if (lm.bullet) return true;
    if (lm.ordered && lm.start === 1) return true;
    return false;
  }
  function isLazyLine(cur) {
    if (!leaf || leaf.t !== 'para') return false;
    const rest = curRest(cur);
    if (!/\S/.test(rest)) return false;
    if (peek(matchListMarker, cur)) return false;
    if (peek(matchATX, cur)) return false;
    if (peek(matchFence, cur)) return false;
    if (isHrLine(cur)) return false;
    const hb = peek(matchHtmlBlockStart, cur);
    if (hb && hb.type !== 7) return false;
    const st = peek(matchSetext, cur);
    if (st && st.marker === '-' && st.len >= 3) return false;
    return true;
  }
  function leadingWsCols(s, startCol) {
    let col = startCol;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === ' ') col++;
      else if (s[k] === '\t') col = Math.floor(col / 4) * 4 + 4;
      else break;
    }
    return col - startCol;
  }
  function hasQuoteAncestor(frame) {
    let f = frame;
    while (f) {
      if (f.t === 'quote') return true;
      f = f.parent;
    }
    return false;
  }

  let lastLazyLine = -1; // index of the last lazy-continuation line (persists across lines; prevLazy was reset each line)
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const rawBlank = /^\s*$/.test(raw);
    const cur = { s: raw, p: 0, col: 0, qb: 0 };
    // ---- Phase 1: container matching ----
    let failAt = -1;
    let qBase = 0, qTab = false, matchedQ = false;
    for (let si = 1; si < stack.length; si++) {
      const fr = stack[si];
      if (fr.t === 'quote') {
        const r = matchQuote(cur);
        if (r === 0) { failAt = si; break; }
        qBase = cur.qb; qTab = (r === 2); matchedQ = true;
      } else if (fr.t === 'item') {
        // a line that is blank after the already-matched containers (e.g. a lone `>`) is a blank line for the item too (doc-11)
        const blankRem = rawBlank || cur.p >= cur.s.length || /^\s*$/.test(cur.s.slice(cur.p));
        if (!matchItem(cur, fr, blankRem)) { failAt = si; break; }
      }
    }
    // ---- Phase 1 failAt handling ----
    let fenceFall = false;
    let lineDone = false;
    if (failAt >= 0) {
      const failFrame = stack[failAt];
      if (leaf && leaf.t === 'fence' && failFrame.t === 'quote') {
        closeLeaf('container');
        popTo(failAt);
        failAt = -1;
      } else if (leaf && leaf.t === 'fence' && failFrame.t === 'item' && leaf.parent && leaf.parent.t === 'quote' && leaf.parent.parent === failFrame && !rawBlank && !isBlockStartLine(cur)) {
        closeLeaf('container');
        popTo(failAt + 1);
        failAt = -1;
      } else if (leaf && leaf.t === 'fence' && failFrame.t === 'item') {
        fenceFall = true;
      } else if (isLazyLine(cur)) {
        // lazy continuation
        if (matchedQ) expandLeadingTabs(cur, qBase, qTab);
        const st = peek(matchSetext, cur);
        const inQuote = hasQuoteAncestor(leaf.parent);
        if (st && lastLazyLine === li - 1 && inQuote) {
          const rest = curRest(cur);
          const m = /^([ \t]*)(.*)$/.exec(rest);
          if (m[1].indexOf('\t') >= 0) leaf.lines.push(rest);
          else leaf.lines.push(' '.repeat(Math.max(4, m[1].length)) + m[2]);
        } else if (st && inQuote) {
          leaf.lines.push(curRest(cur));
        } else {
          const rest = curRest(cur);
          if (leadingWsCols(rest, cur.col) >= 4) {
            curSkipWs(cur, 4);
            leaf.lines.push(curRest(cur));
          } else {
            leaf.lines.push(rest);
          }
        }
        lastLazyLine = li;
        lineDone = true;
      } else {
        popTo(failAt);
        failAt = -1;
      }
    }
    if (lineDone) continue;
    // ---- Phase 2 ----
    let guard = 0;
    while (true) {
      if (++guard > 60) break;
      if (stack.length > 1) expandLeadingTabs(cur, matchedQ ? qBase : 0, matchedQ ? qTab : false);
      const isBlankNow = rawBlank || curBlank(cur);
      if (isBlankNow) {
        if (leaf) {
          if (leaf.t === 'para') {
            // Table continuation: a tab-only line after a table is an (empty) table row,
            // not a blank line (oracle: `\t` -> empty <tr>, table keeps consuming lines;
            // a spaces-only line IS a blank line and ends the table).
            if (/\t/.test(raw) && paraContainsTable(leaf.lines)) { leaf.lines.push(''); break; }
            closeLeaf('blank'); markBlank();
          }
          else if (leaf.t === 'fence') {
            // a whitespace-only line inside a fence is content, not a blank (cm-129)
            if (!fenceFall) { if (leaf.ch === '`') fenceStripIndent(cur, leaf.indent); leaf.lines.push(curRest(cur)); }
          }
          else if (leaf.t === 'code') { curSkipWsUpTo(cur, 4); leaf.pending.push(curRest(cur)); }
          else if (leaf.t === 'html') {
            if (leaf.type === 6 || leaf.type === 7) { closeLeaf('blank'); markBlank(); }
            else leaf.lines.push('');
          }
        } else {
          markBlank();
          const top = stack[stack.length - 1];
          if (top.t === 'item' && top.children.length === 0) stack.pop();
        }
        break;
      }
      if (!/\S/.test(curRest(cur))) {
        // whitespace-only remainder: content for an open para/fence, else no block starts
        if (leaf && leaf.t === 'para') leaf.lines.push(curRest(cur));
        else if (leaf && leaf.t === 'fence') leaf.lines.push(curRest(cur));
        else if (leaf && leaf.t === 'code') { curSkipWsUpTo(cur, 4); leaf.pending.push(curRest(cur)); }
        else if (leaf && leaf.t === 'html') {
          if (leaf.type === 6 || leaf.type === 7) closeLeaf('blank');
          else leaf.lines.push('');
        } else markBlank();
        break;
      }
      if (leaf) {
        if (leaf.t === 'fence') {
          const sv = saveCur(cur);
          const fm = matchFence(cur);
          if (fm && fm.ch === leaf.ch && fm.len >= leaf.len && fm.info.trim() === '') {
            closeLeaf('closed');
            break;
          }
          restoreCur(cur, sv);
          if (fenceFall) {
            if (!leaf.anchored) {
              closeLeaf('container');
              popTo(failAt);
              failAt = -1; fenceFall = false;
              continue;
            }
            if (isBlockStartLine(cur)) {
              closeLeaf('container');
              popTo(failAt);
              failAt = -1; fenceFall = false;
              continue;
            }
            const st = peek(matchSetext, cur);
            if (st && !(st.marker === '-' && st.len >= 3)) {
              const rest = curRest(cur);
              const m = /^([ \t]*)(.*)$/.exec(rest);
              if (m[1].indexOf('\t') >= 0) leaf.lines.push(rest);
              else leaf.lines.push(' '.repeat(Math.max(4, m[1].length)) + m[2]);
            } else {
              if (leaf.ch === '`') fenceStripIndent(cur, leaf.indent);
              leaf.lines.push(curRest(cur));
            }
            if (leaf.parent && leaf.parent.t === 'quote') closeLeaf('container');
            break;
          }
          if (leaf.ch === '`') fenceStripIndent(cur, leaf.indent);
          const pushed = curRest(cur);
          leaf.lines.push(pushed);
          if (failAt < 0 && /\S/.test(pushed)) leaf.anchored = true;
          break;
        }
        if (leaf.t === 'code') {
          const rest = curRest(cur);
          if (!/\S/.test(rest)) {
            curSkipWsUpTo(cur, 4);
            leaf.pending.push(curRest(cur));
            break;
          }
          const sv = saveCur(cur);
          if (curSkipWs(cur, 4)) {
            for (const pl of leaf.pending) leaf.lines.push(pl);
            leaf.pending = [];
            leaf.lines.push(curRest(cur));
            break;
          }
          restoreCur(cur, sv);
          closeLeaf('container');
          continue;
        }
        if (leaf.t === 'html') {
          const rest = curRest(cur);
          leaf.lines.push(rest);
          if (leaf.end) {
            const hay = leaf.type === 1 ? rest.toLowerCase() : rest;
            const needle = leaf.type === 1 ? leaf.end.toLowerCase() : leaf.end;
            if (hay.indexOf(needle) >= 0) {
              leaf.trailingNL = computeTrailingNL(li);
              closeLeaf('endcond');
            }
          }
          break;
        }
        if (leaf.t === 'para') {
          const st = peek(matchSetext, cur);
          if (st) {
            const restText = extractDefs(leaf.lines.join('\n'), refs);
            if (!restText || !/\S/.test(restText)) {
              closeLeaf('blank');
              continue;
            }
            const restLines = restText.split('\n');
            if (isTableLines(restLines)) {
              if (st.marker === '-' && st.len >= 3) {
                closeLeaf('blank');
                continue;
              }
              leaf.lines.push(curRest(cur));
              break;
            }
            leaf.lines = restLines;
            leaf.asHeading = st.level;
            closeLeaf('setext');
            break;
          }
          if (peek(matchATX, cur)) { closeLeaf('blank'); continue; }
          if (peek(matchFence, cur)) { closeLeaf('blank'); continue; }
          if (isHrLine(cur)) { closeLeaf('blank'); continue; }
          if (/^ {0,3}>/.test(curRest(cur))) { closeLeaf('blank'); continue; }
          const lm = peek(matchListMarker, cur);
          if (lm && listCanInterrupt(lm, leaf)) { closeLeaf('blank'); continue; }
          const hb = peek(matchHtmlBlockStart, cur);
          if (hb && hb.type !== 7) { closeLeaf('blank'); continue; }
          const content = curRest(cur);
          if (leaf.parent && leaf.parent.t === 'item' && leadingWsCols(content, cur.col) >= 4) {
            curSkipWs(cur, 4);
            leaf.lines.push(curRest(cur));
          } else {
            leaf.lines.push(content);
          }
          break;
        }
      }
      // ---- no leaf: block starts ----
      {
        const top = stack[stack.length - 1];
        if (top.t === 'list') {
          const lm0 = peek(matchListMarker, cur);
          // a marker line that is also an hr (e.g. `* * *`) is an hr, not a new item (cm-060)
          if (!lm0 || isHrLine(cur)) { stack.pop(); continue; }
        }
      }
      {
        const fe = matchFence(cur);
        if (fe) {
          leaf = { t: 'fence', parent: stack[stack.length - 1], ch: fe.ch, len: fe.len, indent: fe.indent, lang: fe.lang, lines: [], anchored: false };
          break;
        }
      }
      {
        const atx = matchATX(cur);
        if (atx) {
          addBlock(stack[stack.length - 1], { t: 'heading', level: atx.level, lines: [atx.text] });
          break;
        }
      }
      if (isHrLine(cur)) {
        addBlock(stack[stack.length - 1], { t: 'hr' });
        break;
      }
      {
        const sv = saveCur(cur);
        const r = matchQuote(cur);
        if (r !== 0) {
          const qf = { t: 'quote', children: [], blank: false, blankBelow: false, loose: false, parent: stack[stack.length - 1] };
          addBlock(stack[stack.length - 1], qf);
          stack.push(qf);
          qBase = cur.qb; qTab = (r === 2); matchedQ = true;
          continue;
        }
        restoreCur(cur, sv);
      }
      {
        const lm = peek(matchListMarker, cur);
        if (lm) {
          const top2 = stack[stack.length - 1];
          if (top2.t === 'list') {
            const sameType = (lm.bullet && top2.bullet && lm.delim === top2.delim) || (lm.ordered && top2.ordered && lm.delim === top2.delim);
            if (!sameType) { stack.pop(); continue; }
          }
          if (stack[stack.length - 1].t !== 'list') {
            const lf = { t: 'list', bullet: lm.bullet, ordered: lm.ordered, start: lm.start, delim: lm.delim, children: [], blank: false, blankBelow: false, loose: false, parent: stack[stack.length - 1] };
            addBlock(stack[stack.length - 1], lf);
            stack.push(lf);
          }
          matchListMarker(cur);
          const item = { t: 'item', contentIndent: lm.contentIndent, contentIndentRel: lm.contentIndent - lm.startCol, contentCol: cur.col, task: null, children: [], blank: false, blankBelow: false, loose: false, parent: stack[stack.length - 1] };
          // task checkbox: [] / [x] / [X] + space/tab + following content
          const rest0 = curRest(cur);
          const tm = /^\[( |x|X)\]([ \t]+)/.exec(rest0);
          if (tm && /\S/.test(rest0.slice(tm[0].length))) {
            item.task = tm[1];
            let cc = cur.col;
            for (const ch of tm[0]) { if (ch === '\t') cc = Math.floor(cc / 4) * 4 + 4; else cc++; }
            cur.p += tm[0].length;
            cur.col = cc;
          }
          addBlock(stack[stack.length - 1], item);
          stack.push(item);
          if (!/\S/.test(curRest(cur))) break; // empty item: line consumed
          continue;
        }
      }
      {
        const rawLine = curRest(cur);
        const hb = matchHtmlBlockStart(cur);
        if (hb) {
          leaf = { t: 'html', parent: stack[stack.length - 1], type: hb.type, end: hb.end, lines: [rawLine], trailingNL: false };
          if (hb.end) {
            const rest = curRest(cur);
            const hay = hb.type === 1 ? rest.toLowerCase() : rest;
            const needle = hb.type === 1 ? hb.end.toLowerCase() : hb.end;
            if (hay.indexOf(needle) >= 0) {
              leaf.trailingNL = computeTrailingNL(li);
              closeLeaf('endcond');
            }
          }
          break;
        }
      }
      {
        const sv = saveCur(cur);
        if (curSkipWs(cur, 4)) {
          leaf = { t: 'code', parent: stack[stack.length - 1], lines: [curRest(cur)], pending: [] };
          break;
        }
        restoreCur(cur, sv);
      }
      leaf = { t: 'para', parent: stack[stack.length - 1], lines: [curRest(cur)] };
      break;
    }
  }
  // EOF: close any open leaf
  closeLeaf('eof');
  return renderBlocks(doc.children, refs);
}

// ---------- renderer ----------
function renderBlocks(children, refs) {
  let out = '';
  for (const nd of children) out += renderBlock(nd, refs);
  return out;
}
function renderBlock(nd, refs) {
  switch (nd.t) {
    case 'para':
      return '<p>' + renderInline(parseInlineText(nd.lines.join('\n'), refs)) + '</p>\n';
    case 'heading':
      return '<h' + nd.level + '>' + renderInline(parseInlineText(nd.lines.join('\n'), refs)) + '</h' + nd.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'fence': {
      const body = nd.lines.join('\n');
      return '<pre><code' + (nd.lang ? ' class="language-' + escAttr(nd.lang) + '"' : '') + '>' + escCode(body) + (nd.lines.length ? '\n' : '') + '</code></pre>\n';
    }
    case 'code': {
      const body = nd.lines.join('\n');
      return '<pre><code>' + escCode(body) + (nd.lines.length ? '\n' : '') + '</code></pre>\n';
    }
    case 'html':
      return nd.text + (nd.trailingNL ? '\n' : '');
    case 'quote':
      return '<blockquote>\n' + renderBlocks(nd.children, refs) + '</blockquote>\n';
    case 'list': {
      const loose = nd.loose || nd.children.some(c => c.loose);
      const tag = nd.bullet ? 'ul' : 'ol';
      const start = (!nd.bullet && nd.start !== 1) ? ' start="' + nd.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const it of nd.children) out += renderItem(it, refs, loose);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'table':
      return renderTable(nd, refs);
    default:
      return '';
  }
}
function renderItem(nd, refs, listLoose) {
  const taskHtml = nd.task === null ? '' : (nd.task === ' ' ? '<input disabled="" type="checkbox">' : '<input checked="" disabled="" type="checkbox">');
  let out = '<li>';
  let taskPlaced = false;
  for (const ch of nd.children) {
    if (ch.t === 'para') {
      const inner = renderInline(parseInlineText(ch.lines.join('\n'), refs));
      if (!listLoose) {
        if (taskHtml && !taskPlaced) { out += taskHtml + ' '; taskPlaced = true; }
        out += inner;
      } else {
        out += '<p>';
        if (taskHtml && !taskPlaced) { out += taskHtml + ' '; taskPlaced = true; }
        out += inner;
        out += '</p>\n';
      }
    } else {
      if (taskHtml && !taskPlaced) { out += taskHtml; taskPlaced = true; }
      out += renderBlock(ch, refs);
    }
  }
  if (taskHtml && !taskPlaced) out += taskHtml;
  out += '</li>\n';
  return out;
}
function renderTable(nd, refs) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < nd.header.length; k++) {
    const a = nd.aligns[k];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInlineText(nd.header[k], refs)) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (nd.rows.length) {
    out += '<tbody>';
    for (const row of nd.rows) {
      out += '<tr>\n';
      for (let k = 0; k < row.length; k++) {
        const a = nd.aligns[k];
        out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInlineText(row[k], refs)) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}
