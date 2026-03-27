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
`;

export function validateHtml(html = "") {
  const issues = [];
  const source = html.toLowerCase();

  if (!html.trim()) issues.push("HTML output is empty");
  if (/<script\b/i.test(html)) issues.push("Script tags are forbidden");
  if (/lorem ipsum/i.test(source)) issues.push("Lorem ipsum detected");
  if (!/@page\s*\{/i.test(html)) issues.push("Missing @page rule");
  if (/body\s*\{[^}]*margin\s*:\s*0\b/i.test(source)) issues.push("body margin: 0 is forbidden");
  if (!/class=["'][^"']*cover/i.test(html)) issues.push("cover module missing");
  if (!/class=["'][^"']*back_cover/i.test(html)) issues.push("back_cover module missing");

  return {
    valid: issues.length === 0,
    issues,
  };
}
