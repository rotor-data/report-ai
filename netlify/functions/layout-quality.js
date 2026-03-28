export function hasColorTokens(designSystem) {
  const colors = designSystem?.colors;
  if (!colors || typeof colors !== "object") return false;
  return Boolean(colors.primary && colors.secondary && colors.accent);
}

export function hasTypographyTokens(designSystem) {
  const typography = designSystem?.typography;
  if (!typography || typeof typography !== "object") return false;
  return Boolean(typography.heading_family || typography.heading) && Boolean(typography.body_family || typography.body);
}

export function computeBrandReadiness({ designSystem, fontsCount = 0, assets = [] }) {
  const hasDesignExample = assets.some((a) => a.asset_type === "design_example" || a.asset_type === "pdf_reference");
  const missing = [];
  if (!hasColorTokens(designSystem)) missing.push("colors");
  if (!hasTypographyTokens(designSystem) && fontsCount === 0) missing.push("fonts");
  if (!hasDesignExample) missing.push("design_examples");

  return {
    ok: missing.length === 0,
    missing,
    confidence_score: missing.length === 0 ? 0.95 : missing.length === 1 ? 0.7 : 0.45,
    fallback_mode: missing.length > 0,
  };
}

export function validateHtmlWithLayoutRules(html = "") {
  const issues = [];
  const lower = html.toLowerCase();

  if (!html.trim()) {
    issues.push({ severity: "error", code: "html.empty", message: "HTML output saknas." });
    return issues;
  }

  if (/<script\b/i.test(html)) {
    issues.push({ severity: "error", code: "html.script_forbidden", message: "Skript-taggar är inte tillåtna i print-HTML." });
  }
  if (!/@page\s*\{/i.test(html)) {
    issues.push({ severity: "error", code: "layout.page_rule_missing", message: "@page-regel saknas." });
  }
  if (/body\s*\{[^}]*margin\s*:\s*0\b/i.test(lower)) {
    issues.push({ severity: "error", code: "layout.body_margin_zero", message: "body margin:0 är inte tillåtet." });
  }
  if (!/class=["'][^"']*cover/i.test(html)) {
    issues.push({ severity: "error", code: "layout.cover_missing", message: "Omslagsmodul saknas." });
  }
  if (!/class=["'][^"']*back_cover/i.test(html)) {
    issues.push({ severity: "error", code: "layout.back_cover_missing", message: "Baksidesmodul saknas." });
  }
  if (/src\s*:\s*url\(['"]data:font/i.test(lower)) {
    issues.push({ severity: "error", code: "font.embedded_base64", message: "Inbäddade base64-fonter är inte tillåtna. Använd asset-URL." });
  }
  if (/data-full-page-background=["']true["']/i.test(html)) {
    const hasFullBleedRule = /(width\s*:\s*210mm|inset\s*:\s*0|height\s*:\s*297mm)/i.test(html);
    if (!hasFullBleedRule) {
      issues.push({
        severity: "error",
        code: "layout.full_page_background_not_full",
        message: "Bakgrund markerad som helsida täcker inte hela sidan/bleed.",
      });
    }
  }
  if (!/data-node-id=/i.test(html)) {
    issues.push({
      severity: "warning",
      code: "layout.node_ids_missing",
      message: "HTML saknar data-node-id. Punktpatchar blir mindre stabila.",
    });
  }

  return issues;
}

export function summarizePreflight(html = "", issues = []) {
  const blockingCount = issues.filter((i) => i.severity === "error").length;
  return {
    blocking_issues: blockingCount,
    warning_issues: issues.length - blockingCount,
    html_size_bytes: Buffer.byteLength(html || "", "utf8"),
    checked_at: new Date().toISOString(),
  };
}
