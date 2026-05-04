/**
 * End-to-end smoke test for the content-units pipeline (HTML side).
 *
 * Companion to smyra-core/tests/units-e2e.test.ts, which covers the
 * parser + applyUnitOps. This file exercises the wire-side concerns:
 *
 *   3. validateUnitsOnly — accepts ref-only pages, rejects inline-text.
 *   4. substituteUnits   — renders a forged ContentUnit[] + page-html
 *                          combination into a final HTML snapshot, byte-
 *                          identical across re-runs (idempotent).
 *
 * The fixture mirrors the smyra-core spec — a Swedish VD-letter with
 * heading / paragraph / blockquote / bullet-list — so the whole
 * pipeline (parse → page compose → validate → substitute) shares a
 * single canonical input. If any step regresses the asserts here flip.
 *
 * No DB. No network. Runs in jsdom; substituteUnits relies on
 * `document.createElement('template')` which jsdom provides.
 */
import { describe, it, expect } from 'vitest';
import { substituteUnits } from '../units-substitute.js';
import { validateUnitsOnly } from '../validate-units-only.js';

// ───────────────────────────────────────────────────────────────────────
// Fixture units — the result the smyra-core parseTextToUnits test asserts
// for the same VD-letter raw_content. Duplicated here (rather than
// imported across repos) so the report-ai test stays self-contained;
// drift on either side will trip the assertions in BOTH files.
// ───────────────────────────────────────────────────────────────────────

const FIXTURE_UNITS = [
  { unit_id: 'h1',  type: 'heading', level: 1, text: 'VD har ordet', order_index: 0 },
  { unit_id: 'u2',  type: 'paragraph',
    text: 'Året 2026 har varit ett av de mest formativa i bolagets historia.',
    order_index: 1 },
  { unit_id: 'h3',  type: 'heading', level: 2, text: 'Marknaden och vår position', order_index: 2 },
  { unit_id: 'u4',  type: 'paragraph',
    text: 'Vi har valt att stå fast vid vår **nischade strategi** — fokuserade verktyg, tätare kundrelationer.',
    order_index: 3 },
  { unit_id: 'bq5', type: 'blockquote',
    text: 'Vi vinner inte på bredd. Vi vinner på precision.',
    order_index: 4 },
  { unit_id: 'h6',  type: 'heading', level: 2, text: 'Tre prioriteringar', order_index: 5 },
  { unit_id: 'l7',  type: 'bullet_list',
    metadata: { items: [
      'Fördjupa närvaron hos befintliga kunder.',
      'Investera i talangbasen.',
      'Bygga AI-stödda arbetsflöden.',
    ] },
    order_index: 6 },
  { unit_id: 'h8',  type: 'heading', level: 2, text: 'Avslutningsvis', order_index: 7 },
  { unit_id: 'u9',  type: 'paragraph', text: 'Tack till våra kunder, partners och medarbetare.',
    order_index: 8 },
  // Pull-quote derived from bq5 — exercises the source-linking branch.
  { unit_id: 'pq1', type: 'pull_quote',
    text: 'Vi vinner på precision.',
    metadata: { quote_source_unit_id: 'bq5' },
    order_index: 9 },
];

// A "good" composed page: every text-bearing element references a unit
// via data-unit and carries no inline body. Decorative wrappers (div,
// section, aside) are allowed to contain layout markup.
const GOOD_PAGE_HTML = `
  <section class="page">
    <header>
      <h1 data-unit="h1"></h1>
    </header>
    <div class="body">
      <p data-unit="u2"></p>
      <h2 data-unit="h3"></h2>
      <p data-unit="u4"></p>
      <blockquote data-unit="bq5"></blockquote>
      <aside class="pull-quote">
        <blockquote data-unit="pq1"></blockquote>
      </aside>
      <h2 data-unit="h6"></h2>
      <ul data-unit="l7"></ul>
      <h2 data-unit="h8"></h2>
      <p data-unit="u9"></p>
    </div>
  </section>
`;

// A "bad" composed page: identical structure but inlines body prose
// directly into <p>/<blockquote>/<li> elements — the exact regression
// the validator must catch.
const BAD_PAGE_HTML = `
  <section class="page">
    <h1>VD har ordet</h1>
    <p>Året 2026 har varit ett av de mest formativa i bolagets historia.</p>
    <blockquote>Vi vinner inte på bredd. Vi vinner på precision.</blockquote>
    <ul>
      <li>Fördjupa närvaron.</li>
      <li>Investera i talangbasen.</li>
    </ul>
  </section>
`;

// ───────────────────────────────────────────────────────────────────────
// 3. validateUnitsOnly — gating contract.
// ───────────────────────────────────────────────────────────────────────

describe('units e2e — validateUnitsOnly gating', () => {
  it('accepts a fully ref-only composed page', () => {
    const r = validateUnitsOnly(GOOD_PAGE_HTML);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('rejects a page that inlines body text in <h1>/<p>/<blockquote>/<li>', () => {
    const r = validateUnitsOnly(BAD_PAGE_HTML);
    expect(r.valid).toBe(false);
    // Every text-bearing element with prose must surface as a violation.
    const tags = r.violations.map((v) => v.tag).sort();
    expect(tags).toEqual(['blockquote', 'h1', 'li', 'li', 'p']);
    // Sample text is included so debugging isn't a guess.
    for (const v of r.violations) {
      expect(v.sample.length).toBeGreaterThan(0);
    }
  });

  it('rejects when even ONE text-bearing element inlines text', () => {
    // Otherwise-valid page with a single rogue <p>. Catches the case
    // where Claude composes 99% correctly and slips one paragraph in.
    const html = GOOD_PAGE_HTML.replace(
      '<p data-unit="u2"></p>',
      '<p>Sneaky inline text that bypasses units.</p>',
    );
    const r = validateUnitsOnly(html);
    expect(r.valid).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].tag).toBe('p');
  });

  it('pull-quote with source unit reference passes validation', () => {
    // Ref-only pull_quote element is fine; the source-linking check is
    // the applyUnitOps responsibility on the smyra-core side.
    const html = '<aside class="pull-quote"><blockquote data-unit="pq1"></blockquote></aside>';
    expect(validateUnitsOnly(html).valid).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// 4. End-to-end transform: forged units + ref-only page → substitution
//    → snapshot. Idempotent + deterministic.
// ───────────────────────────────────────────────────────────────────────

describe('units e2e — end-to-end substitution', () => {
  it('substitutes every unit referenced on the good page', () => {
    const out = substituteUnits(GOOD_PAGE_HTML, FIXTURE_UNITS);

    // No data-unit attribute should remain on text-bearing elements
    // post-substitution; the renderer relies on that as a "done"
    // signal and the editor preview's idempotence depends on it.
    expect(out).not.toMatch(/\sdata-unit=/);

    // Every unit text appears in the output.
    expect(out).toContain('VD har ordet');
    expect(out).toContain('Året 2026 har varit');
    expect(out).toContain('Marknaden och vår position');
    // Inline markdown rendered.
    expect(out).toContain('<strong>nischade strategi</strong>');
    // Bullet list expanded.
    expect(out).toContain('<li>Fördjupa närvaron hos befintliga kunder.</li>');
    expect(out).toContain('<li>Investera i talangbasen.</li>');
    expect(out).toContain('<li>Bygga AI-stödda arbetsflöden.</li>');
    // Pull-quote rendered with its derived text.
    expect(out).toContain('Vi vinner på precision.');
  });

  it('is idempotent — running substitution twice is a no-op', () => {
    const once = substituteUnits(GOOD_PAGE_HTML, FIXTURE_UNITS);
    const twice = substituteUnits(once, FIXTURE_UNITS);
    expect(twice).toBe(once);
  });

  it('is deterministic — same input → byte-identical output', () => {
    const a = substituteUnits(GOOD_PAGE_HTML, FIXTURE_UNITS);
    const b = substituteUnits(GOOD_PAGE_HTML, FIXTURE_UNITS);
    expect(a).toBe(b);
  });

  it('post-substitute HTML passes the validator round-trip', () => {
    // After substitution every text-bearing element carries inline text
    // (because that's literally what substitution does) — so the
    // validator MUST be applied BEFORE substitution. This test pins
    // that invariant: the gate runs on the composed page, not on the
    // rendered output.
    const composed = GOOD_PAGE_HTML;
    const rendered = substituteUnits(composed, FIXTURE_UNITS);
    expect(validateUnitsOnly(composed).valid).toBe(true);
    expect(validateUnitsOnly(rendered).valid).toBe(false);
  });

  it('warns + leaves placeholder empty when a unit_id is missing', () => {
    // Page references `u_missing` but no unit with that id is provided.
    // substituteUnits removes the data-unit attribute and clears the
    // element's body so the page still renders without orphan markers.
    const html = '<section><p data-unit="u_missing"></p></section>';
    const out = substituteUnits(html, FIXTURE_UNITS);
    expect(out).not.toMatch(/data-unit/);
    expect(out).toMatch(/<p><\/p>/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Snapshot test — full HTML output for the fixture. Captures everything
// the renderer emits in one regression-catcher; if anyone changes
// markdown handling, attribute stripping, or whitespace normalisation
// it surfaces immediately.
// ───────────────────────────────────────────────────────────────────────

describe('units e2e — full-page render snapshot', () => {
  it('produces a stable rendered HTML snapshot', () => {
    const out = substituteUnits(GOOD_PAGE_HTML, FIXTURE_UNITS);
    expect(out).toMatchSnapshot();
  });
});
