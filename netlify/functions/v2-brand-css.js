/**
 * GET /api/v2-brand-css?report_id=<uuid>
 *
 * Returns a JSON bundle with everything the editor preview needs to
 * render a module's html_cache so it matches smyra-render output:
 *
 *   {
 *     css: "...",              // @font-face + :root tokens + design-system.css + template css_base
 *     logos: [                 // brand_logos rows, data-URI baked
 *       { variant, format, data_uri }
 *     ],
 *     assets: [                // v2_assets / design_assets for this report
 *       { id, ref, url, data_uri? }
 *     ]
 *   }
 *
 * Auth: Hub JWT OR editor capability token. Editor tokens must match
 * the report_id query param.
 */
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { getSql } from "./db.js";

// Legacy design-system.css file loading removed: all reports composed after
// migration 019 carry document_css which already bundles the design-system
// classes inline (see smyra-core compose-pages buildDocumentCss). The
// filesystem load + esbuild ESM-shim collision (__filename / import.meta.url)
// was crashing this function at load time with 502 → editor never received
// any CSS bundle. Removing the load path also removes the failure mode.
//
// Legacy reports (pre-019) without document_css fall back to a degraded
// bundle of brand tokens + font-face only. Those reports are either
// already-archived or not actively rendered; re-rendering them will
// generate a fresh document_css and restore full styling.

function buildFontFaceCss(brandFonts) {
  const blocks = [];
  for (const font of brandFonts || []) {
    const family = font.family || "sans-serif";
    const weight = font.weight || "400";
    const style = font.style || "normal";
    // Strip whitespace from base64 — Brand-OS stores fonts with PEM-style
    // 76-char line wrapping; embedding raw newlines into url('data:font/...
    // ;base64,<b64>') makes Chromium treat the unescaped \n as an
    // unterminated-string error. The src: declaration is dropped AND the
    // surrounding <style> block enters error-recovery — the entire
    // ~700-rule sheet collapses to 1 rule (first @font-face header). Same
    // fix as render.py 2026-05-07; same fix applies in the editor's CSS
    // endpoint. base64 alphabet [A-Za-z0-9+/=] has no meaningful
    // whitespace so stripping is lossless.
    const dataB64 = (font.data_base64 || "").replace(/\s+/g, "");
    if (!dataB64) continue;

    const fmt = (font.format || "woff2").toLowerCase();
    const mimeMap = {
      woff2: "font/woff2",
      woff: "font/woff",
      ttf: "font/ttf",
      otf: "font/otf",
    };
    const fmtHintMap = {
      woff2: "woff2",
      woff: "woff",
      ttf: "truetype",
      otf: "opentype",
    };
    const mime = mimeMap[fmt] || "font/woff2";
    const fmtHint = fmtHintMap[fmt] || "woff2";

    blocks.push(
      `@font-face {\n` +
      `  font-family: '${family}';\n` +
      `  font-weight: ${weight};\n` +
      `  font-style: ${style};\n` +
      `  src: url('data:${mime};base64,${dataB64}') format('${fmtHint}');\n` +
      `  font-display: block;\n` +
      `}`
    );
  }
  return blocks.join("\n");
}

/**
 * Translate brand token keys to the CSS custom property names the
 * component templates actually reference (e.g. var(--primary), not
 * var(--primary_color)). Mirrors the mapping in smyra-core
 * compose-pages buildStyleBlock — both sides must agree.
 */
function buildTokenCss(brandTokens) {
  if (!brandTokens || typeof brandTokens !== "object") return "";

  const colorMap = {
    primary_color: "--primary",
    primary_dark_color: "--primary-dark",
    secondary_color: "--secondary",
    accent_color: "--accent",
    text_color: "--text",
    text_muted_color: "--text-muted",
    bg_color: "--bg",
    bg_light_color: "--bg-light",
    surface_color: "--surface",
    border_color: "--border",
    link_color: "--link",
    success_color: "--success",
    warning_color: "--warning",
    danger_color: "--danger",
  };
  const spacingMap = {
    margin_top_mm: "--mg-top",
    margin_bottom_mm: "--mg-bottom",
    margin_inner_mm: "--mg-inner",
    margin_outer_mm: "--mg-outer",
    column_gap_mm: "--column-gap",
    section_gap_mm: "--section-gap",
  };

  const lines = [];
  for (const [key, value] of Object.entries(brandTokens)) {
    if (key.startsWith("_")) continue; // internal flags
    if (value == null || value === "") continue;
    if (colorMap[key]) {
      lines.push(`  ${colorMap[key]}: ${value};`);
      continue;
    }
    if (spacingMap[key]) {
      lines.push(`  ${spacingMap[key]}: ${value}mm;`);
      continue;
    }
    if (key === "base_font_size") {
      // Accept bare numbers ("11") or CSS lengths ("11pt", "14px").
      const v = /^\d+(\.\d+)?$/.test(String(value).trim()) ? `${value}pt` : value;
      lines.push(`  --base-font-size: ${v};`);
      continue;
    }
    if (key === "heading_scale") {
      lines.push(`  --heading-scale: ${value};`);
      continue;
    }
    if (key === "font_display") {
      lines.push(`  --font-display: '${value}', system-ui, sans-serif;`);
      continue;
    }
    if (key === "font_heading") {
      lines.push(`  --font-heading: '${value}', system-ui, sans-serif;`);
      continue;
    }
    if (key === "font_body") {
      lines.push(`  --font-body: '${value}', system-ui, sans-serif;`);
      continue;
    }
    // Pass-through for keys that are already CSS-style names, and for
    // document-specific tokens that don't match any preset map.
    const cssKey = key.startsWith("--") ? key : `--${key.replace(/_/g, "-")}`;
    lines.push(`  ${cssKey}: ${value};`);
  }

  // Sensible defaults so templates don't render with raw tokens
  const defaults = {
    "--primary": "#1a1a2e",
    "--primary-dark": "#0f0f1a",
    "--secondary": "#4a4a6a",
    "--accent": "#e94560",
    "--text": "#1a1a1a",
    "--text-muted": "#6b7280",
    "--bg": "#ffffff",
    "--bg-light": "#f5f5f5",
    "--surface": "#ffffff",
    "--border": "#e5e7eb",
    "--link": "var(--primary)",
    "--success": "#2e7b58",
    "--warning": "#a66a12",
    "--danger": "#a13f5a",
    "--font-display": "system-ui, sans-serif",
    "--font-heading": "system-ui, sans-serif",
    "--font-body": "system-ui, sans-serif",
    "--base-font-size": "11pt",
    "--radius": "4px",
    "--section-gap": "6mm",
  };
  for (const [cssVar, fallback] of Object.entries(defaults)) {
    const already = lines.some((l) => l.trim().startsWith(cssVar + ":"));
    if (!already) lines.push(`  ${cssVar}: ${fallback};`);
  }

  return `:root {\n${lines.join("\n")}\n}`;
}

function logoMime(format) {
  const fmt = String(format || "").toLowerCase();
  if (fmt === "svg" || fmt === "svg+xml") return "image/svg+xml";
  if (fmt === "png") return "image/png";
  if (fmt === "jpg" || fmt === "jpeg") return "image/jpeg";
  if (fmt === "webp") return "image/webp";
  if (fmt === "gif") return "image/gif";
  return "image/png";
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "GET") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const reportId = event.queryStringParameters?.report_id;
  if (!reportId) return json(event, 400, { error: "Missing report_id" });

  if (editorScopeMismatch(auth, reportId)) {
    return json(event, 403, { error: "Editor token does not match report" });
  }

  // Hub-JWT path: JWT org is the only trusted tenant; fail closed if absent.
  const hubTenantId = auth.editorScope
    ? null
    : (auth.payload?.tenant_id ?? auth.payload?.claims?.tenant_id ?? null);
  if (!auth.editorScope && !hubTenantId) {
    return json(event, 403, { error: "Token carries no tenant — access denied" });
  }

  const sql = getSql();

  try {
    const [report] = await sql`
      SELECT id, brand_id, template_id, tenant_id, document_css, style_overrides, page_format
      FROM v2_reports WHERE id = ${reportId} LIMIT 1
    `;
    if (!report) return json(event, 404, { error: "Report not found" });

    // Hub-JWT path: the report (and its bundled brand CSS / logos / assets)
    // must belong to the caller's tenant.
    if (hubTenantId && report.tenant_id !== hubTenantId) {
      return json(event, 403, { error: "Report not accessible in this tenant" });
    }

    // Brand tokens + fonts + logos
    let tokens = {};
    let fonts = [];
    let logoRows = [];
    if (report.brand_id) {
      const brands = await sql`SELECT tokens FROM brands WHERE id = ${report.brand_id} LIMIT 1`;
      tokens = brands[0]?.tokens || {};
      fonts = await sql`
        SELECT family, weight, style, format, data_base64
        FROM brand_fonts WHERE brand_id = ${report.brand_id}
      `;
      try {
        logoRows = await sql`
          SELECT variant, format, data_base64
          FROM brand_logos WHERE brand_id = ${report.brand_id}
        `;
      } catch (err) {
        console.warn("[v2-brand-css] brand_logos query failed:", err.message);
        logoRows = [];
      }
    }

    // Template css_base (optional)
    let cssBase = "";
    if (report.template_id) {
      try {
        const [tpl] = await sql`SELECT css_base FROM report_templates WHERE id = ${report.template_id} LIMIT 1`;
        cssBase = tpl?.css_base || "";
      } catch {
        /* template table may not exist in all envs */
      }
    }

    // Merge per-report overrides on top of the brand tokens. Shallow
    // merge — any key present on style_overrides wins. Empty strings
    // fall through to brand defaults so unsetting in the editor takes
    // the author back to the brand-level look without breaking it.
    const overrides = report.style_overrides || {};
    const mergedTokens = { ...tokens };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === undefined || v === "") continue;
      mergedTokens[k] = v;
    }

    const fontFaceCss = buildFontFaceCss(fonts);
    const tokenCss = buildTokenCss(mergedTokens);

    // Preferred path: the compose step has snapshotted a single document_css
    // that already contains brand vars + design-system + per-component CSS in
    // deterministic layer order. Serve that straight to the editor so its
    // preview matches the PDF exactly. @font-face blocks still need to be
    // prepended — those are per-brand, not per-report.
    let bundle;
    if (report.document_css && report.document_css.trim()) {
      // Build a late-cascade override block that lets the editor's
      // Rapport-stil panel outrank the :root tokens baked into
      // document_css at compose time. Without this, changes only
      // show up when the report is re-composed.
      const overrideTokenCss = Object.keys(overrides || {}).length
        ? buildTokenCss(overrides).replace(/^:root/, ":root, :host")
        : "";
      bundle = [
        "/* ========== @font-face (brand fonts) ========== */",
        fontFaceCss,
        "/* ========== document_css snapshot (compose_pages) ========== */",
        report.document_css,
        "/* ========== template css_base ========== */",
        cssBase,
        "/* ========== report-level overrides (wins cascade) ========== */",
        overrideTokenCss,
        // Default <a> rule so link color actually applies — brand
        // stylesheets often forget this.
        `a { color: var(--link, var(--primary)); }`,
        // Base-size scaling — ONLY when the author actually set a
        // base_font_size override. Emitting these calc() rules blankly
        // risks zeroing body text if --base-font-size isn't in root
        // (WeasyPrint edge cases + late-cascade timing). When unset,
        // leave design-system.css typography defaults alone.
        overrides.base_font_size
          ? (() => {
              const raw = overrides.base_font_size;
              const base = /^\d+(\.\d+)?$/.test(String(raw).trim()) ? `${raw}pt` : raw;
              return `
.t-body  { font-size: calc(${base} * 0.95); }
.t-intro { font-size: calc(${base} * 1.05); }
.t-h1    { font-size: calc(${base} * 1.5);  }
.t-h2    { font-size: calc(${base} * 1.25); }
.t-h3    { font-size: calc(${base} * 1.1);  }
.t-caption { font-size: calc(${base} * 0.85); }
.t-display    { font-size: calc(${base} * 2);   }
.t-display-xl { font-size: calc(${base} * 2.5); }
`;
            })()
          : "",
        // Re-tint SVG icons/illustrations using brand tokens. Most
        // templates hard-code fill/stroke on <svg> shapes, so we need
        // several strategies:
        // 1. Any svg with class "brand-primary"/"brand-accent"/"brand-text"
        //    gets a direct fill/stroke from the token.
        // 2. currentColor passes through color on the parent, so we
        //    explicitly set color on svg's closest container using a
        //    class convention.
        // 3. A data-recolor="primary|accent|text" attribute on the svg
        //    wins over anything above.
        `
svg.brand-primary, .text-primary svg { color: var(--primary); fill: var(--primary); }
svg.brand-accent,  .text-accent  svg { color: var(--accent);  fill: var(--accent); }
svg.brand-text,    .text-ink     svg { color: var(--text);    fill: var(--text); }
svg[data-recolor="primary"] * { fill: var(--primary) !important; stroke: var(--primary); }
svg[data-recolor="accent"]  * { fill: var(--accent)  !important; stroke: var(--accent); }
svg[data-recolor="text"]    * { fill: var(--text)    !important; stroke: var(--text); }
/* Generic: any SVG that explicitly uses currentColor already follows
   the element's color. Make sure the inherited color is set from
   whichever brand var the caller expects. */
svg * { transition: fill .1s, stroke .1s; }
`,
      ].join("\n\n");
    } else {
      // Legacy degraded fallback — tokens + @font-face + css_base only.
      // Reports composed before migration 019 don't carry document_css.
      // Re-compose the report to regenerate a full document_css bundle
      // (recommended). design-system.css is no longer loaded from disk
      // because esbuild's __filename / import.meta.url shim collision
      // crashes this function at module load.
      bundle = [
        "/* ========== @font-face ========== */",
        fontFaceCss,
        "/* ========== :root tokens ========== */",
        tokenCss,
        "/* ========== template css_base ========== */",
        cssBase,
      ].join("\n\n");
    }

    const logos = logoRows.map((row) => ({
      variant: row.variant || "default",
      format: row.format || "png",
      data_uri: row.data_base64
        ? `data:${logoMime(row.format)};base64,${row.data_base64}`
        : null,
    }));

    // Content units (alpha-v3 reports). Editor renders these via
    // substituteUnits() into [data-unit] placeholders in module HTML and
    // surfaces them as editable cards in the units side-panel. Legacy
    // reports (pre-030) have zero rows here and the array stays empty,
    // so the editor falls back to inline-HTML editing on those.
    let units = [];
    try {
      units = await sql`
        SELECT id, report_id, unit_id, type, level, text, metadata,
               order_index, created_at, updated_at
        FROM v2_content_units
        WHERE report_id = ${reportId}
        ORDER BY order_index ASC
      `;
    } catch (err) {
      // The table is created by migration 030 — environments that haven't
      // applied it yet should keep returning the rest of the bundle so the
      // editor still loads (degraded into legacy mode).
      console.warn("[v2-brand-css] v2_content_units query failed:", err.message);
      units = [];
    }

    // Assets referenced from module HTML via data-asset-ref="<id>".
    // tenant_assets (see migration 008) resolves to a storage URL the
    // editor iframe/shadow DOM can load directly.
    let assets = [];
    try {
      const rows = await sql`
        SELECT id, filename, mime_type, storage_url, asset_class
        FROM tenant_assets
        WHERE tenant_id = ${report.tenant_id}
        ORDER BY created_at DESC
        LIMIT 500
      `;
      assets = rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        mime_type: r.mime_type,
        url: r.storage_url,
        asset_class: r.asset_class,
      }));
    } catch (err) {
      console.warn("[v2-brand-css] tenant_assets query failed:", err.message);
      assets = [];
    }

    return json(event, 200, {
      css: bundle,
      logos,
      assets,
      // Expose the underlying tokens so the editor's Rapport-stil panel
      // can initialise its controls without re-parsing the CSS string.
      // tokens = what's actually in effect (brand + overrides applied);
      // brand_tokens = the pristine brand defaults (so "Återställ" works);
      // overrides = what the author has set per-report.
      tokens: mergedTokens,
      brand_tokens: tokens,
      overrides,
      // Paper-size identifier from v2_reports.page_format. Drives the
      // editor preview's frame dimensions so non-A4 reports
      // (presentation, square, etc) don't display in a 210×297mm box.
      page_format: report.page_format || "a4_portrait",
      // Alpha-v3 content units (empty for legacy reports — see fetch above).
      units,
    });
  } catch (err) {
    console.error("[v2-brand-css]", err);
    return json(event, 500, { error: err.message });
  }
};
