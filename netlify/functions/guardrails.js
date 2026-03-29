export const GUARDRAILS_PROMPT = `
Render print-ready HTML and CSS only. Follow these hard rules:
1. No JavaScript in output HTML.
2. Min font size: 9pt body, 7.5pt captions.
3. Keep contrast at WCAG AA for text on colored backgrounds.
4. No empty <section> elements.
5. Numeric table columns are right-aligned; header row has design background.
6. cover uses page-break-after: always; back_cover uses page-break-before: always.
7. Use @page with >=15mm margins; body margin:0 is forbidden.
8. No external image URLs except explicit logo_url.
9. No Lorem ipsum.
10. Do not embed fonts as data URLs; use asset URLs.
11. Elements marked as full-page backgrounds must cover the entire page.
`;

export function validateHtml(html = "") {
  const issues = [];
  const source = html.toLowerCase();

  if (!html.trim()) issues.push("HTML output is empty");
  if (/<script\b/i.test(html)) issues.push("Script tags are forbidden");
  if (/lorem ipsum/i.test(source)) issues.push("Lorem ipsum detected");
  if (!/@page\s*\{/i.test(html)) issues.push("Missing @page rule");
  if (/body\s*\{[^}]*margin\s*:\s*0\b/i.test(source)) issues.push("body margin: 0 is forbidden");
  if (/src\s*:\s*url\(['"]data:font/i.test(source)) issues.push("Embedded base64 font is forbidden");
  if (/data-full-page-background=["']true["']/i.test(html) && !/(width\s*:\s*210mm|inset\s*:\s*0|height\s*:\s*297mm)/i.test(html)) {
    issues.push("Full-page background is marked but does not cover the entire page");
  }
  if (!/class=["'][^"']*cover/i.test(html)) issues.push("cover module missing");
  if (!/class=["'][^"']*back_cover/i.test(html)) issues.push("back_cover module missing");

  // ── Layout validation ──
  // Check text modules have content-frame
  const textModuleTypes = ["text_spread", "two_col_text"];
  for (const type of textModuleTypes) {
    const modulePattern = new RegExp(`class="[^"]*module-${type}[^"]*"[\\s\\S]*?(?=<section|$)`, "gi");
    const matches = html.match(modulePattern) || [];
    for (const match of matches) {
      if (!match.includes("content-frame")) {
        issues.push(`Layout: ${type} module missing content-frame wrapper`);
      }
    }
  }

  // Check full-bleed not applied to text modules
  if (/module-text[_-]spread[^"]*full-bleed/i.test(html)) {
    issues.push("Layout: full-bleed incorrectly applied to text_spread module");
  }
  if (/module-two[_-]col[_-]text[^"]*full-bleed/i.test(html)) {
    issues.push("Layout: full-bleed incorrectly applied to two_col_text module");
  }

  // Check body text max-width (warn if content-frame missing entirely)
  if (html.includes("module-text-spread") && !html.includes("content-frame")) {
    issues.push("Layout: document has text_spread modules but no content-frame wrappers — body text will be flush against page edge");
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
