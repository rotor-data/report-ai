import { describe, it, expect } from 'vitest';
import { substituteUnits } from '../units-substitute.js';

const u = (unit_id, type, extra = {}) => ({
  unit_id,
  type,
  order_index: 0,
  ...extra,
});

describe('substituteUnits — inline-text types', () => {
  it('paragraph substitutes with markdown', () => {
    const out = substituteUnits(
      '<p data-unit="u1"></p>',
      [u('u1', 'paragraph', { text: 'hello **world**' })],
    );
    expect(out).toBe('<p>hello <strong>world</strong></p>');
  });

  it('heading substitutes', () => {
    const out = substituteUnits(
      '<h1 data-unit="h1"></h1>',
      [u('h1', 'heading', { text: 'Title', level: 1 })],
    );
    expect(out).toBe('<h1>Title</h1>');
  });

  it('lead/kicker/attribution/eyebrow', () => {
    for (const type_ of ['lead', 'kicker', 'attribution', 'eyebrow']) {
      const out = substituteUnits(
        '<p class="x" data-unit="u1"></p>',
        [u('u1', type_, { text: '*x*' })],
      );
      expect(out).toBe('<p class="x"><em>x</em></p>');
    }
  });

  it('blockquote/pull_quote/callout/info_box etc.', () => {
    for (const type_ of [
      'blockquote', 'pull_quote', 'callout',
      'info_box', 'warning_box', 'success_box', 'highlight',
    ]) {
      const out = substituteUnits(
        '<blockquote data-unit="u1"></blockquote>',
        [u('u1', type_, { text: 'Q' })],
      );
      expect(out).toBe('<blockquote>Q</blockquote>');
    }
  });

  it('caption/footnote/sidenote/citation', () => {
    for (const type_ of ['caption', 'footnote', 'sidenote', 'citation']) {
      const out = substituteUnits(
        '<aside data-unit="u1"></aside>',
        [u('u1', type_, { text: 'note' })],
      );
      expect(out).toBe('<aside>note</aside>');
    }
  });

  it('toc_entry', () => {
    const out = substituteUnits(
      '<li data-unit="t1"></li>',
      [u('t1', 'toc_entry', { text: 'Chapter One' })],
    );
    expect(out).toBe('<li>Chapter One</li>');
  });
});

describe('substituteUnits — lists', () => {
  it('bullet_list items', () => {
    const out = substituteUnits(
      '<ul data-unit="l1"></ul>',
      [u('l1', 'bullet_list', { metadata: { items: ['one', '**two**'] } })],
    );
    expect(out).toBe('<ul><li>one</li><li><strong>two</strong></li></ul>');
  });

  it('numbered_list items', () => {
    const out = substituteUnits(
      '<ol data-unit="l1"></ol>',
      [u('l1', 'numbered_list', { metadata: { items: ['a', 'b'] } })],
    );
    expect(out).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('check_list items', () => {
    const out = substituteUnits(
      '<ul class="check" data-unit="l1"></ul>',
      [u('l1', 'check_list', { metadata: { items: ['done'] } })],
    );
    expect(out).toBe('<ul class="check"><li>done</li></ul>');
  });

  it('definition_list', () => {
    const out = substituteUnits(
      '<dl data-unit="d1"></dl>',
      [u('d1', 'definition_list', {
        metadata: {
          item_definitions: [
            { term: 'API', definition: 'app interface' },
          ],
        },
      })],
    );
    expect(out).toBe('<dl><dt>API</dt><dd>app interface</dd></dl>');
  });
});

describe('substituteUnits — data', () => {
  it('kpi value/label', () => {
    const out = substituteUnits(
      '<div class="kpi" data-unit="k1"></div>',
      [u('k1', 'kpi', { metadata: { kpi: { value: '42%', label: 'growth' } } })],
    );
    expect(out).toBe(
      '<div class="kpi">' +
      '<span class="kpi-value">42%</span>' +
      '<span class="kpi-label">growth</span>' +
      '</div>',
    );
  });

  it('kpi with change', () => {
    const out = substituteUnits(
      '<div data-unit="k1"></div>',
      [u('k1', 'kpi', {
        metadata: { kpi: { value: '42%', label: 'growth', change: '+3pp' } },
      })],
    );
    expect(out).toContain('<span class="kpi-change">+3pp</span>');
  });

  it('kpi_group', () => {
    const out = substituteUnits(
      '<div class="kpi-group" data-unit="kg1"></div>',
      [u('kg1', 'kpi_group', {
        metadata: {
          kpis: [
            { value: '1', label: 'a' },
            { value: '2', label: 'b' },
          ],
        },
      })],
    );
    const matches = out.match(/<div class="kpi">/g) || [];
    expect(matches.length).toBe(2);
    expect(out).toContain('<span class="kpi-value">1</span>');
    expect(out).toContain('<span class="kpi-value">2</span>');
  });

  it('stat_hero', () => {
    const out = substituteUnits(
      '<div data-unit="s1"></div>',
      [u('s1', 'stat_hero', {
        metadata: { stat: { value: '1M', label: 'users', context: 'global' } },
      })],
    );
    expect(out).toContain('<div class="stat-value">1M</div>');
    expect(out).toContain('<div class="stat-label">users</div>');
    expect(out).toContain('<div class="stat-context">global</div>');
  });

  it('table with header', () => {
    const out = substituteUnits(
      '<table data-unit="t1"></table>',
      [u('t1', 'table', {
        metadata: {
          table: {
            header: ['A', 'B'],
            rows: [['1', '2'], ['3', '4']],
          },
        },
      })],
    );
    expect(out).toContain('<thead><tr><th>A</th><th>B</th></tr></thead>');
    expect(out).toContain('<tr><td>1</td><td>2</td></tr>');
    expect(out).toContain('<tr><td>3</td><td>4</td></tr>');
  });

  it('table with caption', () => {
    const out = substituteUnits(
      '<table data-unit="t1"></table>',
      [u('t1', 'table', {
        metadata: { table: { caption: 'Q4 results', rows: [['x']] } },
      })],
    );
    expect(out).toContain('<caption>Q4 results</caption>');
  });

  it('comparison', () => {
    const out = substituteUnits(
      '<div data-unit="c1"></div>',
      [u('c1', 'comparison', {
        metadata: {
          comparison: {
            left_label: 'Pros',
            right_label: 'Cons',
            left: ['fast'],
            right: ['slow'],
          },
        },
      })],
    );
    expect(out).toContain('<h4>Pros</h4>');
    expect(out).toContain('<h4>Cons</h4>');
    expect(out).toContain('<li>fast</li>');
    expect(out).toContain('<li>slow</li>');
  });
});

describe('substituteUnits — structured', () => {
  it('timeline_event', () => {
    const out = substituteUnits(
      '<div data-unit="te1"></div>',
      [u('te1', 'timeline_event', {
        metadata: { timeline: { date: '2024', title: 'Launch', body: 'we shipped' } },
      })],
    );
    expect(out).toContain('<div class="event-date">2024</div>');
    expect(out).toContain('<div class="event-title">Launch</div>');
    expect(out).toContain('<p>we shipped</p>');
  });

  it('step', () => {
    const out = substituteUnits(
      '<div data-unit="st1"></div>',
      [u('st1', 'step', {
        metadata: { step: { number: 1, title: 'Read', body: 'open the book' } },
      })],
    );
    expect(out).toContain('<div class="step-num">1</div>');
    expect(out).toContain('<div class="step-title">Read</div>');
    expect(out).toContain('<p>open the book</p>');
  });

  it('testimonial with role and photo', () => {
    const out = substituteUnits(
      '<figure data-unit="t1"></figure>',
      [u('t1', 'testimonial', {
        metadata: {
          testimonial: {
            quote: 'Great!',
            person: 'Jane',
            role: 'CEO',
            photo_asset_ref: 'asset_42',
          },
        },
      })],
    );
    expect(
      out.includes('<img data-asset-ref="asset_42"/>') ||
      out.includes('<img data-asset-ref="asset_42">'),
    ).toBe(true);
    expect(out).toContain('<blockquote>Great!</blockquote>');
    expect(out).toContain('<figcaption>Jane, CEO</figcaption>');
  });

  it('testimonial without role', () => {
    const out = substituteUnits(
      '<figure data-unit="t1"></figure>',
      [u('t1', 'testimonial', {
        metadata: { testimonial: { quote: 'Hi', person: 'Bob' } },
      })],
    );
    expect(out).toContain('<figcaption>Bob</figcaption>');
  });

  it('glossary_item', () => {
    const out = substituteUnits(
      '<div data-unit="g1"></div>',
      [u('g1', 'glossary_item', {
        metadata: { glossary: { term: 'KPI', definition: 'key perf indicator' } },
      })],
    );
    expect(out).toContain('<dt>KPI</dt>');
    expect(out).toContain('<dd>key perf indicator</dd>');
  });
});

describe('substituteUnits — layout', () => {
  it('divider empty (void <hr>)', () => {
    const out = substituteUnits(
      '<hr data-unit="d1">',
      [u('d1', 'divider')],
    );
    expect(out).not.toContain('data-unit');
    expect(out).toContain('<hr');
  });

  it('spacer empty', () => {
    const out = substituteUnits(
      '<div class="spacer" data-unit="sp1"></div>',
      [u('sp1', 'spacer')],
    );
    expect(out).toBe('<div class="spacer"></div>');
  });

  it('page_break empty', () => {
    const out = substituteUnits(
      '<div data-unit="pb1"></div>',
      [u('pb1', 'page_break')],
    );
    expect(out).toBe('<div></div>');
  });
});

describe('substituteUnits — reference', () => {
  it('bibliography_entry full', () => {
    const out = substituteUnits(
      '<li data-unit="b1"></li>',
      [u('b1', 'bibliography_entry', {
        metadata: {
          bib: {
            authors: 'Smith, J.',
            title: 'A Book',
            publisher: 'ACME',
            year: 2024,
          },
        },
      })],
    );
    expect(out).toContain('Smith, J.');
    expect(out).toContain('<em>A Book</em>');
    expect(out).toContain('ACME, 2024');
  });

  it('bibliography_entry with url', () => {
    const out = substituteUnits(
      '<li data-unit="b1"></li>',
      [u('b1', 'bibliography_entry', {
        metadata: { bib: { title: 'X', url: 'https://example.com' } },
      })],
    );
    expect(out).toContain('href="https://example.com"');
  });
});

describe('substituteUnits — edge cases', () => {
  it('missing unit logs and empties', () => {
    const out = substituteUnits('<p data-unit="missing"></p>', []);
    expect(out).toBe('<p></p>');
  });

  it('kpi missing metadata fallback', () => {
    const out = substituteUnits(
      '<div data-unit="k1"></div>',
      [u('k1', 'kpi')],
    );
    expect(out).toContain('(missing data for k1)');
  });

  it('unknown type fallback', () => {
    const out = substituteUnits(
      '<div data-unit="u1"></div>',
      [u('u1', 'no_such_type', { text: 'hi' })],
    );
    expect(out).toContain('(missing data for u1)');
  });

  it('surrounding html preserved', () => {
    const html =
      '<section class="page"><div class="bg"></div>' +
      '<h1 class="title" data-unit="h1"></h1>' +
      '<p data-unit="p1"></p></section>';
    const out = substituteUnits(html, [
      u('h1', 'heading', { text: 'Hi', level: 1 }),
      u('p1', 'paragraph', { text: 'body' }),
    ]);
    expect(out).toContain('<section class="page">');
    expect(out).toContain('<div class="bg"></div>');
    expect(out).toContain('<h1 class="title">Hi</h1>');
    expect(out).toContain('<p>body</p>');
  });

  it('idempotent second pass', () => {
    const units = [u('u1', 'paragraph', { text: 'hello' })];
    const once = substituteUnits('<p data-unit="u1"></p>', units);
    const twice = substituteUnits(once, units);
    expect(once).toBe(twice);
    expect(once).not.toContain('data-unit');
  });

  it('empty html returns empty', () => {
    expect(substituteUnits('', [])).toBe('');
  });

  it('no data-unit attrs unchanged', () => {
    const html = '<p>plain html</p>';
    const out = substituteUnits(html, []);
    expect(out).toContain('<p>plain html</p>');
  });

  it('data-unit stripped after substitution', () => {
    const out = substituteUnits(
      '<p data-unit="u1"></p>',
      [u('u1', 'paragraph', { text: 'x' })],
    );
    expect(out).not.toContain('data-unit');
  });

  it('multiple units in one doc', () => {
    const html =
      '<section><h1 data-unit="h"></h1>' +
      '<ul data-unit="l"></ul></section>';
    const out = substituteUnits(html, [
      u('h', 'heading', { text: 'Title', level: 1 }),
      u('l', 'bullet_list', { metadata: { items: ['a', 'b'] } }),
    ]);
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<ul><li>a</li><li>b</li></ul>');
  });

  it('xss in unit text is escaped', () => {
    const out = substituteUnits(
      '<p data-unit="u1"></p>',
      [u('u1', 'paragraph', { text: '<script>alert(1)</script>' })],
    );
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('non-dict entries in units arg are skipped', () => {
    const out = substituteUnits(
      '<p data-unit="u1"></p>',
      [u('u1', 'paragraph', { text: 'hi' }), 'not a dict'],
    );
    expect(out).toBe('<p>hi</p>');
  });
});

describe('substituteUnits — cross-parity sanity', () => {
  it('produces exactly <p>Hello <strong>world</strong></p>', () => {
    const out = substituteUnits(
      '<p data-unit="u1"></p>',
      [{ unit_id: 'u1', type: 'paragraph', text: 'Hello **world**' }],
    );
    expect(out).toBe('<p>Hello <strong>world</strong></p>');
  });

  it('bullet_list with metadata-only items', () => {
    const out = substituteUnits(
      '<ul data-unit="l1"></ul>',
      [{ unit_id: 'l1', type: 'bullet_list', metadata: { items: ['one', 'two'] } }],
    );
    expect(out).toBe('<ul><li>one</li><li>two</li></ul>');
  });
});
