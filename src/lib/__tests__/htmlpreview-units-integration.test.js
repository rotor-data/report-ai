/**
 * Smoke tests for HtmlPreview's content-units integration.
 *
 * The full HtmlPreview component depends on a real DOM with shadow-root
 * support and a host of editor-only behaviours; mounting it requires
 * @testing-library/react which is not in this project's deps. Instead,
 * this suite verifies the contract HtmlPreview relies on: that
 * substituteUnits is idempotent and no-ops when the units list is empty
 * — the two properties the editor preview depends on for legacy reports
 * to keep working unchanged.
 *
 * Manual end-to-end test sequence (run by hand):
 *   1. Open the modern editor for an alpha-v3 report
 *      (call `report2__get_editor_url` → `/editor/v2?token=…`).
 *   2. Confirm the right-most "Innehåll" panel lists every content unit.
 *   3. Type into a paragraph unit's textarea — the page preview updates
 *      in place within ~500ms.
 *   4. Refresh the page — the edit is persisted.
 *   5. Open a legacy (pre-030) report — the units panel is hidden and
 *      the preview matches its previous behaviour.
 */
import { describe, it, expect } from 'vitest';
import { substituteUnits } from '../units-substitute.js';

describe('HtmlPreview / units integration contract', () => {
  it('returns the source HTML untouched when units is empty', () => {
    const html = '<p>Just a legacy report.</p>';
    expect(substituteUnits(html, [])).toBe(html);
  });

  it('substitutes a paragraph unit and is idempotent on re-run', () => {
    const html = '<section class="page"><p data-unit="p1"></p></section>';
    const units = [{ unit_id: 'p1', type: 'paragraph', order_index: 0, text: 'Hej **världen**' }];
    const once = substituteUnits(html, units);
    expect(once).toContain('<strong>världen</strong>');
    // After substitution the data-unit attribute is gone, so re-running
    // is a true no-op (idempotence is the property HtmlPreview relies on
    // when state updates re-trigger the preview render).
    const twice = substituteUnits(once, units);
    expect(twice).toBe(once);
  });

  it('handles a freeform-style page with mixed unit types', () => {
    const html = `
      <section class="page page--freeform">
        <h1 data-unit="h1"></h1>
        <p data-unit="p1"></p>
        <ul data-unit="l1"></ul>
      </section>
    `;
    const units = [
      { unit_id: 'h1', type: 'heading', level: 1, order_index: 0, text: 'Title' },
      { unit_id: 'p1', type: 'paragraph', order_index: 1, text: 'Body.' },
      { unit_id: 'l1', type: 'bullet_list', order_index: 2, metadata: { items: ['a', 'b'] } },
    ];
    const out = substituteUnits(html, units);
    expect(out).toContain('Title');
    expect(out).toContain('Body.');
    expect(out).toContain('<li>a</li>');
    expect(out).toContain('<li>b</li>');
    // No unresolved data-unit attributes remain.
    expect(out).not.toMatch(/data-unit=/);
  });
});
