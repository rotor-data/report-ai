/**
 * Inline markdown parser — strict subset for the content-units pipeline.
 *
 * Supported syntax (all greedy, non-overlapping):
 *
 *     **bold**            -> <strong>bold</strong>
 *     *italic*            -> <em>italic</em>
 *     ==highlight==       -> <mark>highlight</mark>
 *     ~~strike~~          -> <s>strike</s>
 *     `code`              -> <code>code</code>  (HTML-escaped, no recursion)
 *     [text](url)         -> <a href="url">text</a>
 *     [text]{attrs}       -> <span ...>text</span>  (attr allowlist enforced)
 *     <br>                -> <br>  (passes through)
 *
 * Everything else is HTML-escaped. URL allowlist limits link schemes to
 * http://, https://, mailto:, and root-relative /api/... paths. Disallowed
 * schemes degrade to escaped literal text. Nested same-marker pairs are
 * not supported (`**` cannot wrap `**`); attr-span and link bodies DO
 * recurse for nested inline markdown. Code body is raw text, escaped only.
 *
 * Attribute allowlist for `[text]{attrs}`: `class`, `id`, `data-*`,
 * `title`, `lang`. Any other attribute (style, onclick, …) makes the
 * parser reject the WHOLE construct and emit the raw literal as escaped
 * text plus a console.warn.
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

// --- Attribute allowlist for [text]{attrs} --------------------------------

const ATTR_ALLOWED_KEYS = new Set(['class', 'id', 'title', 'lang']);
const DATA_KEY_RE = /^data-[A-Za-z0-9_:-]+$/;

function isAllowedAttrKey(key) {
  if (ATTR_ALLOWED_KEYS.has(key)) return true;
  if (key.startsWith('data-') && key.length > 5) {
    return DATA_KEY_RE.test(key);
  }
  return false;
}

// Tokeniser for the `{attrs}` body. Each iteration consumes one of:
//   - `.foo` class shorthand
//   - `#bar` id shorthand
//   - `key="value"` or `key='value'` or `key=value` (unquoted)
//   - bare `key` (rejected — not meaningful for our use cases)
const ATTR_TOKEN_RE = new RegExp(
  '\\s*' +
    '(?:' +
    '\\.(?<cls>[A-Za-z_][\\w-]*)' +
    '|#(?<id>[A-Za-z_][\\w-]*)' +
    '|(?<key>[A-Za-z_][\\w:-]*)' +
    '(?:\\s*=\\s*(?:"(?<dq>[^"]*)"|\'(?<sq>[^\']*)\'|(?<uq>[^\\s\'"]+)))?' +
    ')' +
    '\\s*',
  'y',
);

/**
 * Parse the inside of `{...}` into an attr dict.
 *
 * Returns null if any key is not in the allowlist OR the body fails to
 * tokenise — caller must then reject the WHOLE [text]{...} construct.
 * Returns `{}` for an empty/whitespace body. Bare keys (no value) are
 * rejected.
 */
function parseAttrs(body) {
  const classes = [];
  const out = {};
  let pos = 0;
  const n = body.length;

  while (pos < n) {
    // Skip leading whitespace; if only whitespace remains, we're done.
    while (pos < n && /\s/.test(body[pos])) pos += 1;
    if (pos >= n) break;

    ATTR_TOKEN_RE.lastIndex = pos;
    const m = ATTR_TOKEN_RE.exec(body);
    if (!m || ATTR_TOKEN_RE.lastIndex === pos) return null;
    pos = ATTR_TOKEN_RE.lastIndex;

    const g = m.groups || {};
    if (g.cls !== undefined) {
      classes.push(g.cls);
      continue;
    }
    if (g.id !== undefined) {
      out.id = g.id;
      continue;
    }
    const key = g.key;
    if (!key) return null;
    if (!isAllowedAttrKey(key)) return null;

    let value;
    if (g.dq !== undefined) value = g.dq;
    else if (g.sq !== undefined) value = g.sq;
    else if (g.uq !== undefined) value = g.uq;
    else return null; // bare key, no value — rejected

    if (key === 'class') {
      for (const c of value.split(/\s+/)) if (c) classes.push(c);
    } else if (key === 'id') {
      out.id = value;
    } else {
      out[key] = value;
    }
  }

  if (classes.length > 0) {
    const seen = new Set();
    const ordered = [];
    for (const c of classes) {
      if (c && !seen.has(c)) {
        seen.add(c);
        ordered.push(c);
      }
    }
    out.class = ordered.join(' ');
  }

  return out;
}

function renderAttrSpanOpen(attrs) {
  const parts = ['<span'];
  // Stable attribute ordering: class, id, then alphabetised remainder.
  if (attrs.class !== undefined) parts.push(` class="${escape(attrs.class)}"`);
  if (attrs.id !== undefined) parts.push(` id="${escape(attrs.id)}"`);
  const rest = Object.keys(attrs)
    .filter((k) => k !== 'class' && k !== 'id')
    .sort();
  for (const k of rest) {
    parts.push(` ${k}="${escape(attrs[k])}"`);
  }
  parts.push('>');
  return parts.join('');
}

// --- Match patterns -------------------------------------------------------
//
// JS lacks Python's `re.DOTALL` — use `[\s\S]` to match any char including
// newlines for the multi-line bold/italic patterns.

const BOLD_RE = /\*\*([\s\S]+?)\*\*/g;
const ITALIC_RE = /(?<!\*)\*(?!\*)([\s\S]+?)(?<!\*)\*(?!\*)/g;
const HILITE_RE = /==([^=\n]+?)==/g;
const STRIKE_RE = /~~([^~\n]+?)~~/g;
const CODE_RE = /`([^`\n]+?)`/g;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;
// Attribute-span: [text]{attrs}. Inner text forbids `]`; attrs body forbids `}`.
const ATTR_SPAN_RE = /\[([^\]]+)\]\{([^}]+)\}/g;
const BR_RE = /<br\s*\/?>/gi;

function boldHandler(m) {
  return `<strong>${parseInlineMarkdown(m[1])}</strong>`;
}

function italicHandler(m) {
  return `<em>${parseInlineMarkdown(m[1])}</em>`;
}

function hiliteHandler(m) {
  return `<mark>${parseInlineMarkdown(m[1])}</mark>`;
}

function strikeHandler(m) {
  return `<s>${parseInlineMarkdown(m[1])}</s>`;
}

function codeHandler(m) {
  // Code content is raw — escape but do NOT recurse into markdown.
  return `<code>${escape(m[1])}</code>`;
}

function linkHandler(m) {
  const label = m[1];
  const url = m[2];
  if (!isSafeUrl(url)) {
    return escape(m[0]);
  }
  return `<a href="${escape(url)}">${parseInlineMarkdown(label)}</a>`;
}

function attrSpanHandler(m) {
  const innerText = m[1];
  const attrsBody = m[2];
  const attrs = parseAttrs(attrsBody);
  if (attrs === null) {
    // Reject: emit the raw literal as escaped text, log a warning.
    // eslint-disable-next-line no-console
    console.warn(
      `inline_md: rejected disallowed attrs in \`${m[0]}\` — emitting raw`,
    );
    return escape(m[0]);
  }
  const open = renderAttrSpanOpen(attrs);
  return `${open}${parseInlineMarkdown(innerText)}</span>`;
}

function brHandler() {
  return '<br>';
}

const MATCHERS = [
  [BOLD_RE, boldHandler],
  [HILITE_RE, hiliteHandler],
  [STRIKE_RE, strikeHandler],
  [CODE_RE, codeHandler],
  [ATTR_SPAN_RE, attrSpanHandler],
  [LINK_RE, linkHandler],
  [BR_RE, brHandler],
  [ITALIC_RE, italicHandler],
];

// Fresh exec from `start` for a sticky-free pattern. Clone the regex per
// call so concurrent uses don't trip over `lastIndex` state.
function searchFrom(pattern, text, start) {
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
 * Disallowed `[text]{attrs}` constructs emit the raw literal (escaped)
 * and log a warning.
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
