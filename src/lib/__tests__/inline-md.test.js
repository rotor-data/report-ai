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
  it('bold greedy keeps inner italic literal', () => {
    expect(parseInlineMarkdown('**foo *bar* baz**')).toBe(
      '<strong>foo *bar* baz</strong>',
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
  it('italic does not consume double star', () => {
    const out = parseInlineMarkdown('**foo *bar* baz**');
    expect(out).not.toContain('<em>');
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
  it('bold and link (link inside bold is literal)', () => {
    expect(parseInlineMarkdown('see **[docs](https://x.com)** here')).toBe(
      'see <strong>[docs](https://x.com)</strong> here',
    );
  });
  it('link around bold is literal label', () => {
    expect(parseInlineMarkdown('[**bold**](https://x.com)')).toBe(
      '<a href="https://x.com">**bold**</a>',
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
