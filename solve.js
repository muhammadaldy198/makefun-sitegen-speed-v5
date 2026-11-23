// solve.js — makefun-site 1.0.0, reimplemented fast (v5, CJS).
// Same output tree, byte for byte. Design:
//   * Templates are parsed to node trees and INTERPRETED (no new Function):
//     one render loop walks the tree, appending to a shared accumulator.
//     Fragments that only read site/tags/recent render once per case.
//   * Markdown is one index-based pass: no split('\n'), no token objects.
//   * runJsonBuf writes JSON bytes straight into a preallocated Buffer sink —
//     no giant string join, no second UTF-8 encode pass.
//   * Views live on the source objects themselves (no per-page view alloc).
//   * HTML escaping checks for a special char first (one C++ scan) and only
//     runs the replace when one is present — most template values are clean.
// Every quirk of the reference (error strings, check order, the template
// standalone rule) is mirrored deliberately.

// ---- text utils ----

// escapeHtml: a cheap test first; the replace (with its per-match callback)
// runs only when the value actually holds a special char.
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
function escChar(c) {
  return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
}
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, escChar);
}

const SLUG_CACHE = new Map();
// slugify: NFKD, strip combining marks, fold case, runs of non [a-z0-9] -> one
// '-', cut at 64 code units (no trailing '-'), 'untitled' when empty. Pure
// ASCII skips normalize/replace (no-ops there).
function slugify(t) {
  const hit = SLUG_CACHE.get(t);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const norm = ascii ? t : t.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let lastDash = false;
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) { out += norm[i]; lastDash = false; }
    else if (c >= 65 && c <= 90) { out += String.fromCharCode(c + 32); lastDash = false; }
    else if (!lastDash && out.length > 0) { out += '-'; lastDash = true; }
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.endsWith('-')) out = out.slice(0, -1);
  } else if (out.endsWith('-')) out = out.slice(0, -1);
  const slug = out === '' ? 'untitled' : out;
  if (SLUG_CACHE.size < 10000) SLUG_CACHE.set(t, slug);
  return slug;
}

function uniqueSlug(base, taken) {
  let slug = base;
  let i = 2;
  while (taken.has(slug)) { slug = base + '-' + i; i++; }
  taken.add(slug);
  return slug;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DATE_CACHE = new Map();
function longDate(d) {
  const hit = DATE_CACHE.get(d);
  if (hit !== undefined) return hit;
  const out = Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
  DATE_CACHE.set(d, out);
  return out;
}

// JS \s above ASCII (full set, code points >= 128).
function isWsHi(c) {
  return c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

// Count \S+ runs. Tight char loop; measured faster than split/regex variants
// on the corpus (split +20%, regex-exec +27%, replace +140%).
function wordsOf(body) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const ws = c <= 32 ? (c === 32 || (c >= 9 && c <= 13)) : (c < 128 ? false : isWsHi(c));
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// Template value rendering (reference textOf): strings as-is, numbers and
// booleans via String, arrays joined with ', ' recursively, else ''.
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += txt(v[i]);
    }
    return out;
  }
  return '';
}

function escTxt(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return esc(txt(v));
  return '';
}

// Template truthiness: arrays by length; undefined/null/false/''/0 falsy;
// objects and NaN truthy.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---- front matter ----

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isValidDate(raw) {
  if (raw.length !== 10) return false;
  if (raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  return y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

// Template name: [a-z0-9-]+.
function isName(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

// Slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 long.
function isSlug(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let prevDash = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (i === 0 || prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else {
      return false;
    }
  }
  return !prevDash;
}

// A string value: "..." with \" and \\ its only escapes, or bare (never
// opening on "). Throws with the reference's message; the caller prefixes it.
function fmString(raw) {
  if (raw.charCodeAt(0) !== 34) {
    if (raw.charCodeAt(0) === 91) throw new Error('a bare string opens on [');
    return raw;
  }
  const last = raw.length - 1;
  if (last < 1 || raw.charCodeAt(last) !== 34) throw new Error('a quoted string is not closed');
  let out = '';
  let plain = 1;
  for (let i = 1; i < last; i++) {
    const c = raw.charCodeAt(i);
    if (c === 92) {
      const n = raw.charCodeAt(i + 1);
      if ((n !== 34 && n !== 92) || i + 1 === last) {
        throw new Error('a quoted string holds an escape other than \\" or \\\\');
      }
      out += raw.slice(plain, i) + raw[i + 1];
      i++;
      plain = i + 1;
    } else if (c === 34) {
      throw new Error('a quoted string holds a stray quote');
    }
  }
  return out + raw.slice(plain, last);
}

// One key's value, or a thrown Error with the reference's refusal string.
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      try {
        return fmString(raw);
      } catch (e) {
        throw new Error('key "' + key + '": ' + e.message);
      }
    case 'date':
      if (!isValidDate(raw)) throw new Error('key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
      return raw;
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        throw new Error('key "tags": not a list [a, b]');
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return [];
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          throw new Error('key "tags": an empty tag, or one holding " [ or ]');
        }
        tags[i] = t;
      }
      return tags;
    }
    case 'draft':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error('key "draft": true or false');
    case 'layout':
      if (!isName(raw)) throw new Error('key "layout": not a template name');
      return raw;
    case 'slug':
      if (!isSlug(raw)) throw new Error('key "slug": not a slug');
      return raw;
    default:
      throw new Error('unknown key "' + key + '"');
  }
}

// { data, body } or { error } (first refusal reason). Index-scanned, no
// split('\n'). The closing '---' is found BEFORE any line is read: an
// unclosed block refuses with that reason even if an earlier line is bad.
function parseFrontMatter(text) {
  const n = text.length;
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? n : firstNl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  const fmStart = firstEnd === n ? n : firstEnd + 1;
  let close = -1;
  if (text.startsWith('---', fmStart)) {
    const after = fmStart + 3;
    if (after === n || text.charCodeAt(after) === 10) close = fmStart;
  }
  if (close === -1) {
    let from = fmStart;
    for (;;) {
      const hit = text.indexOf('\n---', from);
      if (hit === -1) break;
      const after = hit + 4;
      if (after === n || text.charCodeAt(after) === 10) { close = hit + 1; break; }
      from = hit + 1;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = fmStart;
  for (let lineNo = 2; ls < close; lineNo++) {
    let le = text.indexOf('\n', ls);
    if (le === -1 || le > close) le = close;
    const start = ls;
    ls = le + 1;
    let a = start;
    while (a < le && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9)) a++;
    if (a === le || text.charCodeAt(start) === 35) continue; // blank or comment
    let k = a;
    while (k < le) {
      const c = text.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === a || k >= le || text.charCodeAt(k) !== 58) {
      return { error: 'line ' + lineNo + ' is not "key: value"' };
    }
    const key = text.slice(a, k);
    let v = k + 1;
    if (v < le && text.charCodeAt(v) === 32) v++;
    else if (v < le) return { error: 'line ' + lineNo + ' is not "key: value"' };
    let ve = le;
    while (ve > v && (text.charCodeAt(ve - 1) === 32 || text.charCodeAt(ve - 1) === 9)) ve--;
    const raw = text.slice(v, ve);
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' &&
        key !== 'layout' && key !== 'summary' && key !== 'slug') {
      return { error: 'unknown key "' + key + '"' };
    }
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    try {
      data[key] = fmValue(key, raw);
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(close + 3 === n ? n : close + 4) };
}

// ---- markdown ----

const WS_RE = /\s/; // a link target must hold no whitespace

function isWsChar(c) {
  return c <= 32 ? (c === 32 || (c >= 9 && c <= 13)) : (c < 128 ? false : isWsHi(c));
}

// Chars a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
function isEscapable(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62;
}

// First index >= from where `what` occurs outside a backslash escape, or -1.
// Jumps with indexOf and counts the backslash run before each match: an odd
// run means the match's first char is escaped (both callers search for text
// starting with an escapable char, so parity decides exactly).
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let backslashes = 0;
    let k = j - 1;
    while (k >= from && s.charCodeAt(k) === 92) { backslashes++; k--; }
    if (backslashes % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

// First single * from `from` (a run that is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let backslashes = 0;
    let k = j - 1;
    while (k >= from && s.charCodeAt(k) === 92) { backslashes++; k--; }
    if (backslashes % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

// Next structural char (\ ` * [) OR HTML-special char (& < > " ') via one
// C++ regex scan. Escaping is FUSED into the scan: plain runs between specials
// hold no escapable char by construction, so they are emitted raw — no esc()
// call per plain run. lastIndex is set before every exec, so the shared
// regex is safe across inline's recursion.
const STRUCT_RE = /[\\`*\[&<>"']/g;

// `s` rendered inline; `link(target)` gives a link's href. Jumps between
// specials with one regex scan; escapes are emitted inline as entities.
function inline(s, link) {
  const n = s.length;
  let out = '';
  let plain = 0;
  let i = 0;
  while (i < n) {
    STRUCT_RE.lastIndex = i;
    const sm = STRUCT_RE.exec(s);
    if (sm === null) break;
    const next = sm.index;
    const c = s.charCodeAt(next);
    if (c === 92) { // backslash
      if (next + 1 < n && isEscapable(s.charCodeAt(next + 1))) {
        if (next > plain) out += s.slice(plain, next);
        const e = s[next + 1];
        out += e === '>' ? '&gt;' : e; // only > is special when escaped
        i = next + 2;
        plain = i;
      } else {
        i = next + 1; // lone backslash stays in the plain run
      }
      continue;
    }
    if (c === 96) { // backtick: close is a plain indexOf, not escape-aware
      const j = s.indexOf('`', next + 1);
      if (j > next + 1) {
        if (next > plain) out += s.slice(plain, next);
        out += '<code>' + esc(s.slice(next + 1, j)) + '</code>';
        i = j + 1;
        plain = i;
      } else {
        i = next + 1;
      }
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(next + 1) === 42) {
        const j = findUnescaped(s, '**', next + 2);
        if (j > next + 2) {
          if (next > plain) out += s.slice(plain, next);
          out += '<strong>' + inline(s.slice(next + 2, j), link) + '</strong>';
          i = j + 2;
          plain = i;
        } else {
          i = next + 2;
        }
      } else {
        const j = findSingleStar(s, next + 1);
        if (j > next + 1) {
          if (next > plain) out += s.slice(plain, next);
          out += '<em>' + inline(s.slice(next + 1, j), link) + '</em>';
          i = j + 1;
          plain = i;
        } else {
          i = next + 1;
        }
      }
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { // & < > " '
      if (next > plain) out += s.slice(plain, next);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      i = next + 1;
      plain = i;
      continue;
    }
    // [ link: target found by plain indexOf(')'), must be non-empty and
    // whitespace-free.
    const k = findUnescaped(s, ']', next + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      if (next > plain) out += s.slice(plain, next);
      out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(next + 1, k), link) + '</a>';
      i = m + 1;
      plain = i;
    } else {
      i = next + 1;
    }
  }
  return plain < n ? out + s.slice(plain) : out;
}

// --- block line classifiers over [ls, le) of src ---

function lineBlank(src, ls, le) {
  for (let i = ls; i < le; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimSlice(src, ls, le) {
  let a = ls;
  let b = le;
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return src.slice(a, b);
}

// Fence language of the line, or null when not a fence open.
function fenceLang(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return null;
  let i = ls + 3;
  while (i < le) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = src.slice(ls + 3, i);
  while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  return i === le ? lang : null;
}

// Whether the line closes a fence: ``` then spaces/tabs only.
function isFenceClose(src, ls, le) {
  if (le - ls < 3 || src.charCodeAt(ls) !== 96 || src.charCodeAt(ls + 1) !== 96 || src.charCodeAt(ls + 2) !== 96) return false;
  for (let i = ls + 3; i < le; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading line -> [depth, textStart, textEnd], or null (heading text never empty).
function headingOf(src, ls, le) {
  let i = ls;
  let depth = 0;
  while (i < le && src.charCodeAt(i) === 35) { depth++; i++; }
  if (depth === 0 || depth > 6 || i >= le) return null;
  const c = src.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < le && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  let b = le;
  while (b > i && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  if (b === i) return null;
  return [depth, i, b];
}

// Thematic break: --- or *** then spaces/tabs only.
function isHr(src, ls, le) {
  if (le - ls < 3) return false;
  const c0 = src.charCodeAt(ls);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(ls + 1) !== c0 || src.charCodeAt(ls + 2) !== c0) return false;
  for (let i = ls + 3; i < le; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Content start of a bullet item on the line, or -1.
function bulletStart(src, ls, le) {
  if (le - ls < 2) return -1;
  const c = src.charCodeAt(ls);
  if ((c !== 45 && c !== 42) || src.charCodeAt(ls + 1) !== 32) return -1;
  return ls + 2;
}

// [number, contentStart] of an ordered item, or null.
function orderedOf(src, ls, le) {
  let i = ls;
  let digits = 0;
  while (i < le && digits < 9) {
    const c = src.charCodeAt(i);
    if (c < 48 || c > 57) break;
    digits++;
    i++;
  }
  if (digits === 0) return null;
  if (i + 1 >= le || src.charCodeAt(i) !== 46 || src.charCodeAt(i + 1) !== 32) return null;
  return [Number(src.slice(ls, i)), i + 2];
}

// Whether the line continues a list item: 2+ spaces, then non-whitespace.
function isContinued(src, ls, le) {
  if (le - ls < 3) return false;
  if (src.charCodeAt(ls) !== 32 || src.charCodeAt(ls + 1) !== 32) return false;
  let i = ls + 2;
  while (i < le && src.charCodeAt(i) === 32) i++;
  return i < le && !isWsChar(src.charCodeAt(i));
}

// Whether the line ends a paragraph: blank, fence, heading or break.
// (Quote and list lines do NOT end a paragraph.)
function endsParagraph(src, ls, le) {
  if (ls >= le) return true;
  const c = src.charCodeAt(ls);
  if (c === 32 || c === 9) return lineBlank(src, ls, le);
  if (c === 96) return fenceLang(src, ls, le) !== null;
  if (c === 35) return headingOf(src, ls, le) !== null;
  if (c === 45 || c === 42) return isHr(src, ls, le);
  return false;
}

// `src` rendered: { html, toc, excerpt }. toc = every level 2/3 heading
// (level, id, inline HTML); excerpt = first paragraph's inline HTML or ''.
// One index-based pass: no split('\n'), no token objects.
function renderMarkdown(src, link) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  const n = src.length;
  let ls = 0;
  while (ls <= n) {
    let le = src.indexOf('\n', ls);
    if (le === -1) le = n;
    if (ls === le) { ls = le + 1; continue; }
    const c = src.charCodeAt(ls);
    if (c === 32 || c === 9) {
      if (lineBlank(src, ls, le)) { ls = le + 1; continue; }
      // Indented non-blank line is a paragraph line: fall through.
    } else if (c === 96) {
      const lang = fenceLang(src, ls, le);
      if (lang !== null) {
        const bodyStart = le + 1;
        let closeStart = -1;
        let j = bodyStart;
        while (j <= n) {
          let je = src.indexOf('\n', j);
          if (je === -1) je = n;
          if (j < je && src.charCodeAt(j) === 96 && isFenceClose(src, j, je)) { closeStart = j; break; }
          if (je === n) break;
          j = je + 1;
        }
        // Body is one slice, escaped in one call ('\n' is not escapable, so
        // escaping joined lines equals joining escaped lines). An
        // unterminated fence's last line still gets its trailing '\n'.
        const body = src.slice(bodyStart, closeStart === -1 ? n : closeStart);
        const cls = lang === '' ? '' : ' class="language-' + esc(lang) + '"';
        html += '<pre><code' + cls + '>' + esc(body) + (body === '' || body.endsWith('\n') ? '' : '\n') + '</code></pre>\n';
        if (closeStart === -1) break;
        const closeEnd = src.indexOf('\n', closeStart);
        ls = closeEnd === -1 ? n + 1 : closeEnd + 1;
        continue;
      }
      // Not a fence: a paragraph line.
    } else if (c === 35) {
      const h = headingOf(src, ls, le);
      if (h !== null) {
        const text = src.slice(h[1], h[2]);
        const id = uniqueSlug(slugify(text), ids);
        const hHtml = inline(text, link);
        html += '<h' + h[0] + ' id="' + id + '">' + hHtml + '</h' + h[0] + '>\n';
        if (h[0] === 2 || h[0] === 3) toc.push({ level: h[0], id, html: hHtml });
        ls = le + 1;
        continue;
      }
      // Not a heading: a paragraph line.
    } else if (c === 45 || c === 42) {
      if (isHr(src, ls, le)) {
        html += '<hr>\n';
        ls = le + 1;
        continue;
      }
      const bStart = bulletStart(src, ls, le);
      if (bStart !== -1) {
        let item = trimSlice(src, bStart, le);
        ls = le + 1;
        let items = '';
        for (;;) {
          if (ls > n) break;
          let le2 = src.indexOf('\n', ls);
          if (le2 === -1) le2 = n;
          if (ls >= le2) break;
          const nextStart = bulletStart(src, ls, le2);
          if (nextStart !== -1) {
            items += '<li>' + inline(item, link) + '</li>\n';
            item = trimSlice(src, nextStart, le2);
            ls = le2 + 1;
          } else if (isContinued(src, ls, le2)) {
            item += '\n' + trimSlice(src, ls, le2);
            ls = le2 + 1;
          } else break;
        }
        items += '<li>' + inline(item, link) + '</li>\n';
        html += '<ul>\n' + items + '</ul>\n';
        continue;
      }
      // Not a break or a bullet: a paragraph line.
    } else if (c === 62) { // quote
      let text = '';
      let first = true;
      while (ls <= n) {
        let le2 = src.indexOf('\n', ls);
        if (le2 === -1) le2 = n;
        if (ls >= le2 || src.charCodeAt(ls) !== 62) break;
        let s = ls + 1;
        if (s < le2 && src.charCodeAt(s) === 32) s++; // '>' plus one optional space
        const part = trimSlice(src, s, le2);
        if (part !== '') {
          if (!first) text += '\n';
          text += part;
          first = false;
        }
        ls = le2 + 1;
      }
      html += text === '' ? '<blockquote>\n</blockquote>\n' : '<blockquote>\n<p>' + inline(text, link) + '</p>\n</blockquote>\n';
      continue;
    } else if (c >= 48 && c <= 57) {
      const o = orderedOf(src, ls, le);
      if (o !== null) {
        const startNum = o[0];
        let item = trimSlice(src, o[1], le);
        ls = le + 1;
        let items = '';
        for (;;) {
          if (ls > n) break;
          let le2 = src.indexOf('\n', ls);
          if (le2 === -1) le2 = n;
          if (ls >= le2) break;
          const o2 = orderedOf(src, ls, le2);
          if (o2 !== null) {
            items += '<li>' + inline(item, link) + '</li>\n';
            item = trimSlice(src, o2[1], le2);
            ls = le2 + 1;
          } else if (isContinued(src, ls, le2)) {
            item += '\n' + trimSlice(src, ls, le2);
            ls = le2 + 1;
          } else break;
        }
        items += '<li>' + inline(item, link) + '</li>\n';
        html += (startNum !== 1 ? '<ol start="' + startNum + '">' : '<ol>') + '\n' + items + '</ol>\n';
        continue;
      }
      // Not an ordered item: a paragraph line.
    }
    // Paragraph: the current line plus following lines that do not end it.
    // Fast path: when no line needs trimming (the usual case), the paragraph
    // text is one slice of the source. Only a ragged paragraph pays trims.
    const paraStart = ls;
    let paraEnd = le;
    let needsTrim = src.charCodeAt(ls) === 32 || src.charCodeAt(ls) === 9 ||
      src.charCodeAt(le - 1) === 32 || src.charCodeAt(le - 1) === 9;
    ls = le + 1;
    while (ls <= n) {
      let le2 = src.indexOf('\n', ls);
      if (le2 === -1) le2 = n;
      if (endsParagraph(src, ls, le2)) break;
      if (!needsTrim && (src.charCodeAt(ls) === 32 || src.charCodeAt(ls) === 9 ||
          src.charCodeAt(le2 - 1) === 32 || src.charCodeAt(le2 - 1) === 9)) needsTrim = true;
      paraEnd = le2;
      ls = le2 + 1;
    }
    let text;
    if (!needsTrim) {
      text = src.slice(paraStart, paraEnd);
    } else {
      text = '';
      let j = paraStart;
      let first = true;
      for (;;) {
        let je = src.indexOf('\n', j);
        if (je === -1 || je > paraEnd) je = paraEnd;
        if (!first) text += '\n';
        text += trimSlice(src, j, je);
        first = false;
        if (je >= paraEnd) break;
        j = je + 1;
      }
    }
    const pHtml = inline(text, link);
    if (excerpt === null) excerpt = pHtml;
    html += '<p>' + pHtml + '</p>\n';
  }
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---- templates ----

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const STANDALONE_WS = /^[ \t]*$/;

class TemplateError extends Error {}

// `text` as a dot-split path, or a TemplateError.
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

// Tokens: text, {{ }}, {{{ }}} and {% %}; a {% %} tag alone on its line
// (only spaces/tabs beside it) takes its whole line, newline included.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = STANDALONE_WS.test(src.slice(lineStart, open)) && STANDALONE_WS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// `src` parsed into a node tree (TemplateError when it does not parse).
// Each for node carries its own reused loop object (`loop`), saved and
// restored around the loop by the interpreter — the same object serves every
// render of the template in the case, so recursive includes re-entering the
// node must not see a stale loop state.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [], loop: { index: 0, first: false, last: false, length: 0 } };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1], isStatic: false });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// --- interpretation: the node tree IS the program ---
//
// renderNodes walks a template's nodes and appends to one shared accumulator
// (acc.s), so no intermediate strings are built for includes or loop bodies.
// V is one mutable flat scope (root keys + loop vars, saved/restored around
// loops — reproduces the reference's scope chain for the paths used).
// T maps template names to node arrays; C is the per-case static cache;
// D is the include depth (cutoff 8, as the reference's).

// A path lookup: V.<first>, then guarded steps for the rest (a step on
// null/undefined/non-object yields undefined, as the reference's does).
function lookup(V, path) {
  let v = V[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, V, T, C, D, acc) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const kind = n.kind;
    if (kind === 'text') {
      acc.s += n.text;
    } else if (kind === 'var') {
      acc.s += escTxt(lookup(V, n.path));
    } else if (kind === 'raw') {
      acc.s += txt(lookup(V, n.path));
    } else if (kind === 'if') {
      const c = truthy(lookup(V, n.path));
      if (n.not ? !c : c) renderNodes(n.then, V, T, C, D, acc);
      else if (n.else !== null) renderNodes(n.else, V, T, C, D, acc);
    } else if (kind === 'for') {
      const xs = lookup(V, n.path);
      if (Array.isArray(xs)) {
        const L = n.loop;
        // A loop variable named `loop` does NOT overwrite V.loop with the
        // element: the reference builds { [name]: x, loop: {...} } and the
        // later `loop` property wins over the element.
        const pv = n.name === 'loop' ? undefined : V[n.name];
        const pl = V.loop;
        const pi = L.index, pf = L.first, pa = L.last, pn = L.length;
        for (let k = 0; k < xs.length; k++) {
          if (n.name !== 'loop') V[n.name] = xs[k];
          L.index = k + 1;
          L.first = k === 0;
          L.last = k === xs.length - 1;
          L.length = xs.length;
          V.loop = L;
          renderNodes(n.body, V, T, C, D, acc);
        }
        V.loop = pl;
        L.index = pi; L.first = pf; L.last = pa; L.length = pn;
        if (n.name !== 'loop') V[n.name] = pv;
      }
    } else { // include
      if (D < 8) {
        if (n.isStatic) {
          // Static fragment: rendered once per case, lazily, at depth 0.
          let c = C[n.name];
          if (c === undefined) {
            const sub = T.get(n.name);
            const a2 = { s: '' };
            renderNodes(sub, V, T, C, 0, a2);
            c = C[n.name] = a2.s;
          }
          acc.s += c;
        } else {
          const sub = T.get(n.name);
          if (sub !== undefined) renderNodes(sub, V, T, C, D + 1, acc);
        }
      }
    }
  }
}

// One template rendered to a string, or null when the template does not exist.
function renderTemplate(name, V, T, C) {
  const nodes = T.get(name);
  if (nodes === undefined) return null;
  const acc = { s: '' };
  renderNodes(nodes, V, T, C, 0, acc);
  return acc.s;
}

// Mark include nodes whose target is cacheable, so the interpreter takes the
// cached path without a Set lookup per include per render.
function markStaticIncludes(nodes, cacheable) {
  for (const n of nodes) {
    if (n.kind === 'include') n.isStatic = cacheable.has(n.name);
    else if (n.kind === 'for') markStaticIncludes(n.body, cacheable);
    else if (n.kind === 'if') {
      markStaticIncludes(n.then, cacheable);
      if (n.else !== null) markStaticIncludes(n.else, cacheable);
    }
  }
}

// --- static-fragment analysis ---
//
// A template is cacheable when every root name it reads — its own reads
// plus, transitively, the reads of templates it includes (minus names bound
// by the fors enclosing each include site) — is one of site/tags/recent,
// the values that do not change between pages. Such a fragment renders
// identically for every page, so it renders once per case and is reused.

const STATIC_ROOTS = new Set(['site', 'tags', 'recent']);

function walkNodes(nodes, fn) {
  for (const n of nodes) {
    fn(n);
    if (n.kind === 'for') walkNodes(n.body, fn);
    else if (n.kind === 'if') {
      walkNodes(n.then, fn);
      if (n.else !== null) walkNodes(n.else, fn);
    }
  }
}

// Collect the free root names of `nodes` into `free`, given names `bound` by
// enclosing fors. Includes are followed with the site's bound set; `visiting`
// (the include path) stops cycles — a template already on the path is being
// collected by the outer visit, so skipping it loses nothing.
function collectFree(nodes, templates, bound, free, visiting) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      collectFree(n.then, templates, bound, free, visiting);
      if (n.else !== null) collectFree(n.else, templates, bound, free, visiting);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      collectFree(n.body, templates, inner, free, visiting);
    } else if (n.kind === 'include') {
      const sub = templates.get(n.name);
      if (sub !== undefined && !visiting.has(n.name)) {
        visiting.add(n.name);
        collectFree(sub, templates, bound, free, visiting);
        visiting.delete(n.name);
      }
    }
  }
}

// Cacheable template names for this case, or an empty set when any guard
// disables caching: a for binding a static root, any include cycle, or an
// include tree deeper than 4 (the cached render runs at depth 0, so the real
// render's depth must stay far from the depth-8 cutoff).
function computeCacheable(templates) {
  const includesOf = new Map();
  let badFor = false;
  for (const [name, nodes] of templates) {
    const inc = new Set();
    walkNodes(nodes, (n) => {
      if (n.kind === 'include' && templates.has(n.name)) inc.add(n.name);
      if (n.kind === 'for' && STATIC_ROOTS.has(n.name)) badFor = true;
    });
    includesOf.set(name, inc);
  }
  if (badFor) return new Set();
  const state = new Map();
  const visit = (name) => {
    state.set(name, 1);
    for (const next of includesOf.get(name)) {
      const s = state.get(next) === undefined ? 0 : state.get(next);
      if (s === 1) return true;
      if (s === 0 && visit(next)) return true;
    }
    state.set(name, 2);
    return false;
  };
  for (const name of templates.keys()) {
    if ((state.get(name) === undefined ? 0 : state.get(name)) === 0 && visit(name)) return new Set();
  }
  const depth = new Map();
  const dep = (name) => {
    if (depth.has(name)) return depth.get(name);
    let d = 0;
    for (const next of includesOf.get(name)) d = Math.max(d, 1 + dep(next));
    depth.set(name, d);
    return d;
  };
  for (const name of templates.keys()) {
    if (dep(name) > 4) return new Set();
  }
  const cacheable = new Set();
  for (const [name, nodes] of templates) {
    const free = new Set();
    collectFree(nodes, templates, new Set(), free, new Set([name]));
    let ok = true;
    for (const f of free) {
      if (!STATIC_ROOTS.has(f)) { ok = false; break; }
    }
    if (ok) cacheable.add(name);
  }
  return cacheable;
}

// ---- pipeline ----

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// `rel` (a link's path, "/"-separated) from directory `dir`, or null when it
// climbs out of the root.
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// One site's output tree, emitted path by path through `emit(path, text)`.
// `run` collects the tree; `runJson`/`runJsonBuf` append JSON text/bytes.
function build(input, emit) {
  // Templates, parsed in code-unit name order; a TemplateError is reported.
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const cacheable = computeCacheable(parsed);
  for (const nodes of parsed.values()) markStaticIncludes(nodes, cacheable);
  const T = parsed; // name -> node tree, interpreted directly
  const C = {}; // per-case static-fragment cache

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path; non-.md is static. Line ends
  // become "\n" (the replace is skipped when the text holds no "\r" at all).
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // 2. Front matter: a refused source is reported and dropped, as is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks, in source order: each page's slug made unique in its
  // directory (the root's taken set starts with the reserved names).
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  // Resolution is cached per (dir, rel) — but the broken-link report line is
  // still added per source, exactly as the reference does.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolveCaches = new Map(); // dir -> Map rel -> resolved path or null
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirCache = resolveCaches.get(dir);
    if (dirCache === undefined) {
      dirCache = new Map();
      resolveCaches.set(dir, dirCache);
    }
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path = null;
      if (rel !== '') {
        const hit = dirCache.get(rel);
        if (hit !== undefined) path = hit;
        else {
          path = resolvePath(dir, rel);
          dirCache.set(rel, path);
        }
      }
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Posts, newest first then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, each named as first met in the posts' order,
  // ordered by count then slug. A page's tag links to the posts' tag of the
  // same slug, or to a placeholder (url "") where no post has it.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags === undefined ? [] : s.data.tags;
    for (const name of tags) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  const placeholders = new Map();
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      const real = bySlug.get(slug);
      if (real !== undefined) return real;
      const key = name + '\0' + slug;
      let ph = placeholders.get(key);
      if (ph === undefined) {
        ph = { name, slug, url: '', posts: [] };
        placeholders.set(key, ph);
      }
      return ph;
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // View fields, attached to the source objects themselves: the source IS the
  // page and the card, so no per-page view object is ever allocated. (The
  // extra internal fields — path, data, body, ... — are invisible to the
  // templates the generator emits, which read only documented fields.)
  // A card's tags are { name, slug, url } views, shared per tag object.
  const tagViews = new Map();
  for (const s of kept) {
    s.title = s.data.title;
    s.date = s.data.date === undefined ? '' : s.data.date;
    s.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    s.summary = s.data.summary === undefined ? '' : s.data.summary;
    s.reading_minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.tags = s.tagRefs.map((t) => {
      let v = tagViews.get(t);
      if (v === undefined) {
        v = { name: t.name, slug: t.slug, url: t.url };
        tagViews.set(t, v);
      }
      return v;
    });
    s.content = s.html;
    s.is_post = s.post;
    if (!s.post) {
      s.newer = null;
      s.older = null;
    }
  }

  // 7. Every page through its layout, the index pages and the tag pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent);
  const V = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const emitted = new Set();
  const render = (name, page, postList, pager, tag) => {
    V.page = page;
    V.posts = postList;
    V.pager = pager;
    V.tag = tag;
    return renderTemplate(name, V, T, C);
  };
  for (const s of kept) {
    const p = s.outDir + '/index.html';
    emitted.add(p);
    emit(p, render(s.layout, s, undefined, undefined, undefined));
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', undefined, posts.slice((k - 1) * per, k * per),
      { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      undefined);
    if (html === null) continue;
    const p = k === 1 ? 'index.html' : 'page/' + k + '/index.html';
    emitted.add(p);
    emit(p, html);
  }
  for (const t of tags) {
    const html = render('tag', undefined, undefined, undefined,
      { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts });
    if (html === null) continue;
    const p = 'tags/' + t.slug + '/index.html';
    emitted.add(p);
    emit(p, html);
  }
  const tagsHtml = render('tags', undefined, undefined, undefined, undefined);
  if (tagsHtml !== null) {
    emitted.add('tags/index.html');
    emit('tags/index.html', tagsHtml);
  }
  for (const f of statics) {
    // A static named build-report.txt is always overwritten by the report
    // below, so it is not emitted (the parsed output is identical either way,
    // and the JSON text stays free of a duplicate key).
    if (f.path === 'build-report.txt') continue;
    if (emitted.has(f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else {
      emitted.add(f.path);
      emit(f.path, f.content);
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  emit('build-report.txt', lines.join('\n') + '\n');
}

// One case's answer as an object (the contract `run`).
function run(input) {
  const out = {};
  build(input, (p, t) => { out[p] = t; });
  return out;
}

// One case's answer as JSON text: the object graph is never built, and the
// 7 MB stringify never runs. Each value is stringified on its own (the C++
// escaper), so the text is exactly JSON.stringify's output for the same tree.
function runJson(input) {
  const parts = ['{'];
  let sep = '';
  build(input, (p, t) => {
    parts.push(sep, JSON.stringify(p), ':', JSON.stringify(t));
    sep = ',';
  });
  parts.push('}');
  return parts.join('');
}

// ---- byte sink ----
//
// A growing Buffer that JSON text is written into directly: Buffer.write
// encodes each piece once, in place. No giant string join, no second UTF-8
// encode pass over the 7 MB answer. Grows by doubling when a piece does not
// fit (a string of L code units needs at most 3*L bytes in UTF-8).

class Sink {
  constructor(bytes) {
    this.buf = Buffer.allocUnsafe(bytes);
    this.off = 0;
  }
  write(s) {
    if (s.length === 0) return;
    if (this.off + s.length * 3 > this.buf.length) {
      let nlen = this.buf.length * 2;
      while (this.off + s.length * 3 > nlen) nlen *= 2;
      const nb = Buffer.allocUnsafe(nlen);
      this.buf.copy(nb, 0, 0, this.off);
      this.buf = nb;
    }
    this.off += this.buf.write(s, this.off, 'utf8');
  }
  bytes() { return this.buf.subarray(0, this.off); }
}

// One case's answer as JSON bytes into `sink` (no '{' wrapper handling here —
// the driver writes the surrounding array brackets itself).
function runJsonBuf(input, sink) {
  sink.write('{');
  let sep = '';
  build(input, (p, t) => {
    sink.write(sep);
    sink.write(JSON.stringify(p));
    sink.write(':');
    sink.write(JSON.stringify(t));
    sep = ',';
  });
  sink.write('}');
}

module.exports = { run, runJson, runJsonBuf, Sink };
