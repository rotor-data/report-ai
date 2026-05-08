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
 * Decorative-class allowlist (mirror of smyra-core's set). Text-bearing
 * elements with one of these classes are exempt from the data-unit
 * requirement — they're recognised as visual scaffolding.
 *
 * Daniel 2026-05-08: forcing every photo-caption / footnote / disclaimer
 * through plan_structure → unit_ops:add → patch was a UX dead-end. The
 * units pipeline is for content the user might EDIT later; ad-hoc
 * captions, sidenotes, and small print are visual scaffolding that
 * Claude can compose freely.
 */
const DECORATIVE_CLASSES = new Set([
  'caption', 'photo-caption', 'figure-caption', 'figcaption',
  'footnote', 'sidenote', 'annotation',
  'disclaimer', 'small-print', 'fine-print', 'legal',
  'attribution', 'eyebrow', 'kicker', 'overline',
  'meta', 'byline', 'page-number', 'pagenum',
  'breadcrumb', 'badge', 'label',
]);

function hasDecorativeClass(el) {
  const cls = (el.getAttribute && el.getAttribute('class')) || '';
  if (!cls) return false;
  for (const c of cls.toLowerCase().split(/\s+/)) {
    if (DECORATIVE_CLASSES.has(c)) return true;
  }
  return false;
}

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
 * @param {'production' | 'sample'} [mode='production'] - Strictness:
 *   - 'production': data-unit elements MUST be empty (renderer fills).
 *     Inline text inside data-unit is REJECTED.
 *   - 'sample': inline text inside data-unit is allowed (placeholder
 *     fallback for keep_placeholders rendering).
 *   Both modes reject "text without data-unit" and duplicate unit IDs.
 * @returns {{ valid: boolean, violations: Array<{tag: string, sample: string, reason?: string}> }}
 */
export function validateUnitsOnly(html, mode = 'production') {
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
  const seenUnitIds = new Map();

  // Walk every element. node-html-parser exposes a node tree; querySelectorAll
  // with a wildcard returns every descendant element.
  const all = root.querySelectorAll('*');
  for (const el of all) {
    const tag = (el.rawTagName || el.tagName || '').toLowerCase();
    if (!TEXT_TAGS.has(tag)) continue;

    const unitId = el.getAttribute && el.getAttribute('data-unit');
    const hasUnit = !!unitId;
    const text = elementText(el);

    // Duplicate-ref detection — fires regardless of mode.
    if (hasUnit) {
      if (seenUnitIds.has(unitId)) {
        violations.push({
          tag,
          sample: (text || seenUnitIds.get(unitId).sample || '').slice(0, 60),
          reason: 'duplicate_unit_id',
        });
      } else {
        seenUnitIds.set(unitId, { tag, sample: text.slice(0, 60) });
      }
    }

    if (!text) continue; // empty / decorative

    if (hasUnit) {
      if (mode === 'production') {
        violations.push({
          tag,
          sample: text.slice(0, 60),
          reason: 'inline_text_in_unit',
        });
      }
      // mode === 'sample': inline text inside data-unit is OK.
    } else {
      // No data-unit + text. Exempt: decorative-class allowlist
      // (caption, photo-caption, footnote, sidenote, disclaimer, etc.)
      // — visual scaffolding that doesn't belong in the units store.
      if (hasDecorativeClass(el)) continue;
      violations.push({
        tag,
        sample: text.slice(0, 60),
        reason: 'inline_text_no_unit',
      });
    }
  }

  return { valid: violations.length === 0, violations };
}

export default validateUnitsOnly;
