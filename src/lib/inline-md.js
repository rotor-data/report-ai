/**
 * Inline markdown parser — strict subset for the content-units pipeline.
 *
 * Supported syntax (greedy, non-overlapping, single left-to-right scan):
 *
 *     **bold**            -> <strong>bold</strong>
 *     *italic*            -> <em>italic</em>
 *     [text](https://x)   -> <a href="https://x">text</a>
 *     <br>                -> <br>  (passes through)
 *
 * Everything else is HTML-escaped. URL allowlist limits link schemes to
 * http://, https://, mailto:, and root-relative /api/... paths. Disallowed
 * schemes degrade to escaped literal text. Nested markers inside the outer
 * match are literal — `**foo *bar* baz**` parses as
 * `<strong>foo *bar* baz</strong>`.
 *
 * Mirrors smyra-render/inline_md.py exactly. Pure function, no DOM.
 */

const ESC_RE = /[<>&"]/g;
const ESC_MAP = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
};

function escape(text) {
  return text.replace(ESC_RE, (ch) => ESC_MAP[ch]);
}

// http://, https://, mailto:, or root-relative /api/...
const URL_ALLOW_RE = /^(?:https?:\/\/[^\s)]+|mailto:[^\s)]+|\/api\/[^\s)]*)$/;

function isSafeUrl(url) {
  return URL_ALLOW_RE.test(url);
}

// Greedy non-recursive matchers. Order doesn't matter — we always pick the
// leftmost match. Bold uses lazy `.+?` to avoid swallowing past a closing `**`.
//
// JS lacks Python's `re.DOTALL` flag for `.` — use `[\s\S]` to match any char
// including newlines.
const BOLD_RE = /\*\*([\s\S]+?)\*\*/g;
const ITALIC_RE = /(?<!\*)\*(?!\*)([\s\S]+?)(?<!\*)\*(?!\*)/g;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const BR_RE = /<br\s*\/?>/gi;

function boldHandler(m) {
  return `<strong>${escape(m[1])}</strong>`;
}

function italicHandler(m) {
  return `<em>${escape(m[1])}</em>`;
}

function linkHandler(m) {
  const label = m[1];
  const url = m[2];
  if (!isSafeUrl(url)) {
    // Fall back to escaped literal — entire `[text](url)` becomes text.
    return escape(m[0]);
  }
  return `<a href="${escape(url)}">${escape(label)}</a>`;
}

function brHandler() {
  return '<br>';
}

const MATCHERS = [
  [BOLD_RE, boldHandler],
  [LINK_RE, linkHandler],
  [BR_RE, brHandler],
  [ITALIC_RE, italicHandler],
];

// Fresh exec from `start` for a sticky-free pattern. We clone the regex per
// call so concurrent uses don't trip over `lastIndex` state.
function searchFrom(pattern, text, start) {
  // Build a non-global copy to use exec without lastIndex side effects.
  const flags = pattern.flags.replace('g', '');
  const re = new RegExp(pattern.source, flags);
  const sub = text.slice(start);
  const m = re.exec(sub);
  if (!m) return null;
  return {
    index: m.index + start,
    end: m.index + m[0].length + start,
    match: m,
  };
}

function nextMatch(text, start) {
  let best = null;
  for (const [pat, handler] of MATCHERS) {
    const r = searchFrom(pat, text, start);
    if (!r) continue;
    if (best === null || r.index < best.index) {
      best = { index: r.index, end: r.end, match: r.match, handler };
    }
  }
  return best;
}

/**
 * Parse `text` as inline markdown and return safe HTML.
 *
 * Empty / falsy input returns ''. All non-markdown content is HTML-escaped.
 * Disallowed link schemes degrade gracefully to escaped literal text.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function parseInlineMarkdown(text) {
  if (!text) return '';

  const out = [];
  let pos = 0;
  const n = text.length;

  while (pos < n) {
    const nxt = nextMatch(text, pos);
    if (nxt === null) {
      out.push(escape(text.slice(pos)));
      break;
    }
    if (nxt.index > pos) {
      out.push(escape(text.slice(pos, nxt.index)));
    }
    out.push(nxt.handler(nxt.match));
    pos = nxt.end;
  }

  return out.join('');
}
