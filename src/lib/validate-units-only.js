/**
 * Server-side validator: rejects alpha-v3 page HTML that carries inline
 * body text instead of `data-unit` references.
 *
 * Rationale (resilient-dazzling-koala plan, Layer D.2)
 *   In the units-mode pipeline, every text-bearing element on a page must
 *   reference a `v2_content_units` row via a `data-unit="<unit_id>"`
 *   attribute. The element itself is empty in the composed HTML — the
 *   renderer (smyra-render) and the editor preview substitute the unit's
 *   text in at render-time. This keeps content separate from layout and
 *   lets revisions edit a unit without touching every page that uses it.
 *
 *   If Claude (or a buggy step) inlines text directly into a `<p>` /
 *   `<h1>` / `<li>` etc., that text bypasses the units store, which means:
 *     - Edits to the unit don't propagate to the page.
 *     - The editor's units sidebar shows the unit but the page still
 *       prints the stale inline copy.
 *     - Re-rendering after a unit change silently produces the wrong PDF.
 *
 *   We catch this on write (persist_freeform_pages) and on render
 *   (render_freeform_pdf) so corrupt pages never reach the database or
 *   the renderer.
 *
 * Tags considered "text-bearing"
 *   The set below covers all block-level elements that carry user-visible
 *   prose in the alpha-v3 catalogue. `<div>`, `<section>`, `<aside>`,
 *   `<img>`, `<svg>`, etc. are layout containers — their text is allowed
 *   only via descendant text-bearing elements.
 *
 * Pure function. Exported as ESM. No I/O, no DB, no globals.
 */

import { parse } from 'node-html-parser';

/**
 * Block-level tags that must reference a unit when they contain text.
 * Lowercase — node-html-parser normalises tag names to uppercase, so
 * comparisons happen on `el.tagName.toLowerCase()`.
 */
const TEXT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p',
  'blockquote',
  'li',
  'caption', 'figcaption',
  'dt', 'dd',
]);

/**
 * Returns the *direct* text content of an element with HTML entities
 * already decoded by node-html-parser, then trimmed.
 *
 * We use `.text` (which recursively concatenates descendant text) — that
 * way `<blockquote><p>real text</p></blockquote>` reports the inner text
 * for the inner <p> and the outer <blockquote> still gets caught if the
 * structure is `<blockquote>some inline text</blockquote>` with no
 * data-unit.
 */
function elementText(el) {
  return (el.text || '').trim();
}

/**
 * Validate that every text-bearing element on the page either carries a
 * data-unit attribute or is empty (decorative).
 *
 * @param {string} html - Freeform HTML for a single page.
 * @returns {{ valid: boolean, violations: Array<{tag: string, sample: string}> }}
 */
export function validateUnitsOnly(html) {
  if (typeof html !== 'string' || html.length === 0) {
    return { valid: true, violations: [] };
  }

  const root = parse(html, {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: {
      script: false,
      style: false,
    },
  });

  const violations = [];

  // Walk every element. node-html-parser exposes a node tree; querySelectorAll
  // with a wildcard returns every descendant element.
  const all = root.querySelectorAll('*');
  for (const el of all) {
    const tag = (el.rawTagName || el.tagName || '').toLowerCase();
    if (!TEXT_TAGS.has(tag)) continue;

    // OK if the element references a unit. node-html-parser exposes
    // attributes via `el.attributes` (lowercased keys).
    if (el.getAttribute && el.getAttribute('data-unit')) continue;

    const text = elementText(el);
    if (!text) continue; // empty / whitespace-only / decorative

    violations.push({
      tag,
      sample: text.slice(0, 60),
    });
  }

  return { valid: violations.length === 0, violations };
}

export default validateUnitsOnly;
