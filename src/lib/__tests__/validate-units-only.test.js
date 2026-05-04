import { describe, it, expect } from 'vitest';
import { validateUnitsOnly } from '../validate-units-only.js';

describe('validateUnitsOnly — valid pages', () => {
  it('accepts page with only data-unit refs', () => {
    const html = `
      <section class="page">
        <h1 data-unit="cover-title"></h1>
        <p data-unit="lead-1"></p>
      </section>
    `;
    const r = validateUnitsOnly(html);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('accepts decorative empty text-tag', () => {
    const r = validateUnitsOnly('<section><p></p><h2></h2></section>');
    expect(r.valid).toBe(true);
  });

  it('accepts whitespace-only inner content', () => {
    const r = validateUnitsOnly('<p>   \n\t  </p>');
    expect(r.valid).toBe(true);
  });

  it('accepts &nbsp;-only content as decorative spacer', () => {
    const r = validateUnitsOnly('<p>&nbsp;</p>');
    // node-html-parser decodes &nbsp; to a non-breaking space char;
    // .trim() strips ASCII whitespace but the NBSP remains.
    // We accept it as decorative-spacer behaviour because the rendered
    // output is visually empty. If this assertion ever flips, it's a
    // legitimate signal that we should normalise NBSP-only too.
    expect(r.valid).toBe(true);
  });

  it('accepts non-text container elements with content', () => {
    const html = `
      <section>
        <div>arbitrary div content is fine</div>
        <article>articles also fine</article>
        <aside>asides fine</aside>
      </section>
    `;
    const r = validateUnitsOnly(html);
    expect(r.valid).toBe(true);
  });

  it('accepts mixed page with <img> and ref-only <p>', () => {
    const html = `
      <section class="page">
        <img src="/api/unsplash-direct?q=ocean&w=1200&h=600" alt="" />
        <figure>
          <img src="hero.jpg" alt="" />
          <figcaption data-unit="hero-caption"></figcaption>
        </figure>
        <p data-unit="body-1"></p>
      </section>
    `;
    const r = validateUnitsOnly(html);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('accepts empty / null html', () => {
    expect(validateUnitsOnly('').valid).toBe(true);
    expect(validateUnitsOnly(null).valid).toBe(true);
    expect(validateUnitsOnly(undefined).valid).toBe(true);
  });
});

describe('validateUnitsOnly — invalid pages', () => {
  it('rejects inline <p>', () => {
    const r = validateUnitsOnly('<p>Some text</p>');
    expect(r.valid).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].tag).toBe('p');
    expect(r.violations[0].sample).toBe('Some text');
  });

  it('rejects inline <h1>', () => {
    const r = validateUnitsOnly('<h1>Heading</h1>');
    expect(r.valid).toBe(false);
    expect(r.violations[0].tag).toBe('h1');
    expect(r.violations[0].sample).toBe('Heading');
  });

  it('catches inner <p> inside blockquote', () => {
    // Both the outer <blockquote> and the inner <p> are text-bearing.
    // The outer's .text property pulls in the inner text (recursive),
    // so we expect violations on both — that's fine, the user gets
    // pointed to the deepest one to fix.
    const r = validateUnitsOnly('<blockquote><p>quoted text</p></blockquote>');
    expect(r.valid).toBe(false);
    const tags = r.violations.map((v) => v.tag).sort();
    expect(tags).toContain('p');
    expect(tags).toContain('blockquote');
  });

  it('rejects long-text and trims sample to 60 chars', () => {
    const long = 'a'.repeat(200);
    const r = validateUnitsOnly(`<p>${long}</p>`);
    expect(r.valid).toBe(false);
    expect(r.violations[0].sample.length).toBe(60);
  });

  it('reports multiple violations on one page', () => {
    const html = `
      <section>
        <h1>Title</h1>
        <p>body</p>
        <li>list</li>
      </section>
    `;
    const r = validateUnitsOnly(html);
    expect(r.valid).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
    const tags = r.violations.map((v) => v.tag);
    expect(tags).toContain('h1');
    expect(tags).toContain('p');
    expect(tags).toContain('li');
  });

  it('rejects uppercase tag names too (HTML is case-insensitive)', () => {
    const r = validateUnitsOnly('<P>Some text</P>');
    expect(r.valid).toBe(false);
    expect(r.violations[0].tag).toBe('p');
  });

  it('rejects mixed-case <H2>', () => {
    const r = validateUnitsOnly('<H2>heading</H2>');
    expect(r.valid).toBe(false);
    expect(r.violations[0].tag).toBe('h2');
  });

  it('rejects when data-unit is set on a parent but text inlined on child', () => {
    // data-unit on the wrapper does NOT excuse inline text on a child <p>.
    const r = validateUnitsOnly(
      '<div data-unit="wrap"><p>inline body</p></div>',
    );
    expect(r.valid).toBe(false);
    expect(r.violations[0].tag).toBe('p');
  });
});

describe('validateUnitsOnly — integration smoke', () => {
  it('accepts realistic alpha-v3 page', () => {
    const realisticPage = `
      <section class="page page--cover">
        <div class="cover-grid">
          <div class="cover-eyebrow">
            <span data-unit="eyebrow-1"></span>
          </div>
          <h1 class="cover-title" data-unit="cover-title"></h1>
          <p class="cover-lead" data-unit="cover-lead"></p>
          <figure class="cover-hero">
            <img src="https://rotor-report-ai.netlify.app/api/unsplash-direct?q=ocean&w=1600&h=900" alt="" />
            <figcaption data-unit="hero-caption"></figcaption>
          </figure>
          <ul class="cover-toc">
            <li data-unit="toc-1"></li>
            <li data-unit="toc-2"></li>
            <li data-unit="toc-3"></li>
          </ul>
        </div>
      </section>
    `;
    const r = validateUnitsOnly(realisticPage);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('rejects realistic page that snuck inline copy past the prompt', () => {
    const leakedPage = `
      <section class="page">
        <h1 data-unit="title"></h1>
        <p>Oh no — the model regressed and inlined this paragraph instead of using a unit ref.</p>
        <ul>
          <li data-unit="bullet-1"></li>
        </ul>
      </section>
    `;
    const r = validateUnitsOnly(leakedPage);
    expect(r.valid).toBe(false);
    expect(r.violations.some((v) => v.tag === 'p')).toBe(true);
  });
});
