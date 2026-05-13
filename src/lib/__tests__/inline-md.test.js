import { describe, it, expect } from 'vitest';
import { parseInlineMarkdown } from '../inline-md.js';

describe('parseInlineMarkdown — empty / passthrough', () => {
  it('empty string returns empty', () => {
    expect(parseInlineMarkdown('')).toBe('');
  });
  it('null returns empty', () => {
    expect(parseInlineMarkdown(null)).toBe('');
  });
  it('undefined returns empty', () => {
    expect(parseInlineMarkdown(undefined)).toBe('');
  });
  it('plain text passes through', () => {
    expect(parseInlineMarkdown('Hello world')).toBe('Hello world');
  });
});

describe('parseInlineMarkdown — bold', () => {
  it('bold simple', () => {
    expect(parseInlineMarkdown('**bold**')).toBe('<strong>bold</strong>');
  });
  it('bold in sentence', () => {
    expect(parseInlineMarkdown('a **bold** word')).toBe(
      'a <strong>bold</strong> word',
    );
  });
  it('bold recurses into inner italic (Python parity)', () => {
    // 2026-05-14: inline-md was extended; bold/italic/link/attr-span
    // handlers now recurse into their captured group so nested markers
    // render as nested tags. Matches smyra-render/inline_md.py exactly.
    expect(parseInlineMarkdown('**foo *bar* baz**')).toBe(
      '<strong>foo <em>bar</em> baz</strong>',
    );
  });
  it('unclosed bold marker escapes', () => {
    expect(parseInlineMarkdown('**foo')).toBe('**foo');
  });
  it('lone double star', () => {
    expect(parseInlineMarkdown('**')).toBe('**');
  });
});

describe('parseInlineMarkdown — italic', () => {
  it('italic simple', () => {
    expect(parseInlineMarkdown('*italic*')).toBe('<em>italic</em>');
  });
  it('italic in sentence', () => {
    expect(parseInlineMarkdown('an *italic* word')).toBe(
      'an <em>italic</em> word',
    );
  });
  it('italic-inside-bold renders as nested <em> after recursion', () => {
    // See note above: 2026-05-14 Python-parity extension changed nesting
    // behaviour. Bold no longer "eats" inner italic markers — they
    // render as nested <em>.
    const out = parseInlineMarkdown('**foo *bar* baz**');
    expect(out).toContain('<em>bar</em>');
  });
});

describe('parseInlineMarkdown — links', () => {
  it('https link', () => {
    expect(parseInlineMarkdown('[Anthropic](https://anthropic.com)')).toBe(
      '<a href="https://anthropic.com">Anthropic</a>',
    );
  });
  it('http link', () => {
    expect(parseInlineMarkdown('[ex](http://example.com)')).toBe(
      '<a href="http://example.com">ex</a>',
    );
  });
  it('mailto link', () => {
    expect(parseInlineMarkdown('[contact](mailto:foo@example.com)')).toBe(
      '<a href="mailto:foo@example.com">contact</a>',
    );
  });
  it('root-relative /api link', () => {
    expect(parseInlineMarkdown('[asset](/api/unsplash-direct?q=foo)')).toBe(
      '<a href="/api/unsplash-direct?q=foo">asset</a>',
    );
  });
  it('javascript scheme escapes', () => {
    const out = parseInlineMarkdown('[click](javascript:alert(1))');
    expect(out).not.toContain('<a');
    expect(out).toContain('javascript');
  });
  it('relative non-/api escapes', () => {
    const out = parseInlineMarkdown('[x](../private/file)');
    expect(out).not.toContain('<a');
  });
  it('data: url escapes', () => {
    const out = parseInlineMarkdown('[x](data:text/html,<script>)');
    expect(out).not.toContain('<a');
    expect(out).toContain('&lt;script&gt;');
  });
  it('empty label allowed', () => {
    expect(parseInlineMarkdown('[](https://example.com)')).toBe(
      '<a href="https://example.com"></a>',
    );
  });
});

describe('parseInlineMarkdown — <br>', () => {
  it('br passthrough', () => {
    expect(parseInlineMarkdown('line one<br>line two')).toBe(
      'line one<br>line two',
    );
  });
  it('br self-closing normalises', () => {
    expect(parseInlineMarkdown('a<br/>b')).toBe('a<br>b');
  });
  it('br with space', () => {
    expect(parseInlineMarkdown('a<br />b')).toBe('a<br>b');
  });
});

describe('parseInlineMarkdown — html escape', () => {
  it('< > escape', () => {
    expect(parseInlineMarkdown('a < b > c')).toBe('a &lt; b &gt; c');
  });
  it('& escape', () => {
    expect(parseInlineMarkdown('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });
  it('quote escape', () => {
    expect(parseInlineMarkdown('say "hi"')).toBe('say &quot;hi&quot;');
  });
  it('script tag escapes', () => {
    const out = parseInlineMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('alert(1)');
  });
  it('div tag escapes', () => {
    expect(parseInlineMarkdown('<div>x</div>')).toBe(
      '&lt;div&gt;x&lt;/div&gt;',
    );
  });
});

describe('parseInlineMarkdown — mixed', () => {
  it('bold containing link recurses (2026-05-14 parity)', () => {
    // Handlers now recurse — link inside bold renders as nested <a>.
    expect(parseInlineMarkdown('see **[docs](https://x.com)** here')).toBe(
      'see <strong><a href="https://x.com">docs</a></strong> here',
    );
  });
  it('link label containing bold recurses (2026-05-14 parity)', () => {
    expect(parseInlineMarkdown('[**bold**](https://x.com)')).toBe(
      '<a href="https://x.com"><strong>bold</strong></a>',
    );
  });
  it('multiple bolds in paragraph', () => {
    expect(parseInlineMarkdown('**a** then **b**')).toBe(
      '<strong>a</strong> then <strong>b</strong>',
    );
  });
  it('amp in link url escapes in attr', () => {
    expect(parseInlineMarkdown('[x](https://e.com/?a=1&b=2)')).toBe(
      '<a href="https://e.com/?a=1&amp;b=2">x</a>',
    );
  });
});

describe('parseInlineMarkdown — pathological', () => {
  it('lone asterisk', () => {
    expect(parseInlineMarkdown('a * b')).toBe('a * b');
  });
  it('three stars — no exception, no nesting', () => {
    const out = parseInlineMarkdown('***foo***');
    expect(out).not.toContain('<strong><em>');
  });
  it('bold across newlines', () => {
    expect(parseInlineMarkdown('**foo\nbar**')).toBe(
      '<strong>foo\nbar</strong>',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2026-05-14 extended subset — highlight / strike / code / attr-spans.
// Mirrors smyra-render/test_inline_md_ext.py cases for cross-language
// parity. The Python file is the source of truth; if a case here drifts,
// fix the JS mirror, NOT the Python.
// ────────────────────────────────────────────────────────────────────────

describe('parseInlineMarkdown — highlight (==hi==)', () => {
  it('basic', () => {
    expect(parseInlineMarkdown('==hilite==')).toBe('<mark>hilite</mark>');
  });
  it('in prose', () => {
    expect(parseInlineMarkdown('before ==mid== after')).toBe(
      'before <mark>mid</mark> after',
    );
  });
  it('empty inner does not match', () => {
    expect(parseInlineMarkdown('====')).toBe('====');
  });
  it('cannot span newline', () => {
    // Pattern is `==([^=\n]+?)==`, so a literal newline blocks the match.
    const out = parseInlineMarkdown('==a\nb==');
    expect(out).not.toContain('<mark>');
  });
});

describe('parseInlineMarkdown — strike (~~x~~)', () => {
  it('basic', () => {
    expect(parseInlineMarkdown('~~gone~~')).toBe('<s>gone</s>');
  });
  it('does not match across newline', () => {
    const out = parseInlineMarkdown('~~a\nb~~');
    expect(out).not.toContain('<s>');
  });
});

describe('parseInlineMarkdown — inline code (`x`)', () => {
  it('basic', () => {
    expect(parseInlineMarkdown('`foo`')).toBe('<code>foo</code>');
  });
  it('escapes html inside', () => {
    expect(parseInlineMarkdown('`<script>`')).toBe(
      '<code>&lt;script&gt;</code>',
    );
  });
  it('does NOT recurse markdown inside', () => {
    expect(parseInlineMarkdown('`**not bold**`')).toBe(
      '<code>**not bold**</code>',
    );
  });
  it('timestamp', () => {
    expect(parseInlineMarkdown('`08:21`')).toBe('<code>08:21</code>');
  });
});

describe('parseInlineMarkdown — attr-span ([x]{...})', () => {
  it('class shorthand', () => {
    expect(parseInlineMarkdown('[Axel]{.speaker}')).toBe(
      '<span class="speaker">Axel</span>',
    );
  });
  it('id shorthand', () => {
    expect(parseInlineMarkdown('[anchor]{#t1}')).toBe(
      '<span id="t1">anchor</span>',
    );
  });
  it('data-attr quoted', () => {
    expect(parseInlineMarkdown('[Axel]{data-speaker="Axel"}')).toBe(
      '<span data-speaker="Axel">Axel</span>',
    );
  });
  it('data-attr unquoted', () => {
    expect(parseInlineMarkdown('[t]{data-time=08:21}')).toBe(
      '<span data-time="08:21">t</span>',
    );
  });
  it('multiple', () => {
    expect(
      parseInlineMarkdown('[Axel]{.speaker .axel #t1 data-time="08:21"}'),
    ).toBe(
      '<span class="speaker axel" id="t1" data-time="08:21">Axel</span>',
    );
  });
  it('title attr', () => {
    expect(parseInlineMarkdown('[hover]{title="Click me"}')).toBe(
      '<span title="Click me">hover</span>',
    );
  });
  it('lang attr', () => {
    expect(parseInlineMarkdown('[bonjour]{lang="fr"}')).toBe(
      '<span lang="fr">bonjour</span>',
    );
  });
  it('inner content is recursively parsed', () => {
    expect(parseInlineMarkdown('[**bold** inside]{.foo}')).toBe(
      '<span class="foo"><strong>bold</strong> inside</span>',
    );
  });
  it('reject style attr → raw literal (escaped)', () => {
    expect(parseInlineMarkdown('[x]{style="evil"}')).toBe(
      '[x]{style=&quot;evil&quot;}',
    );
  });
  it('reject onclick → raw literal', () => {
    expect(parseInlineMarkdown('[x]{onclick="x"}')).toBe(
      '[x]{onclick=&quot;x&quot;}',
    );
  });
  it('reject when ANY key is disallowed (mixed)', () => {
    expect(parseInlineMarkdown('[x]{.ok onerror="x"}')).toBe(
      '[x]{.ok onerror=&quot;x&quot;}',
    );
  });
});

describe('parseInlineMarkdown — link recursion (2026-05-14)', () => {
  it('code inner', () => {
    expect(parseInlineMarkdown('[`code`](https://example.com)')).toBe(
      '<a href="https://example.com"><code>code</code></a>',
    );
  });
});

describe("parseInlineMarkdown — Daniel's dialog line", () => {
  it('bold + code combo', () => {
    expect(parseInlineMarkdown('**Axel** `08:21` Innan vi tittar…')).toBe(
      '<strong>Axel</strong> <code>08:21</code> Innan vi tittar…',
    );
  });
});
