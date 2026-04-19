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
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { getSql } from "./db.js";

// NOTE: can't use `__filename` / `__dirname` as identifiers here —
// esbuild (Netlify's bundler) auto-emits shims with those names on ESM
// modules, which collides with explicit `const` declarations and crashes
// the function at load time with "Identifier '__filename' has already
// been declared". Use unique names.
const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = dirname(MODULE_FILE);

// Cache design-system.css across invocations (small file, rarely changes)
let _designSystemCache = null;
async function loadDesignSystemCss() {
  if (_designSystemCache !== null) return _designSystemCache;
  try {
    const p = join(MODULE_DIR, "assets", "design-system.css");
    _designSystemCache = await readFile(p, "utf8");
  } catch (err) {
    console.warn("[v2-brand-css] design-system.css not found:", err.message);
    _designSystemCache = "/* design-system.css missing */";
  }
  return _designSystemCache;
}

function buildFontFaceCss(brandFonts) {
  const blocks = [];
  for (const font of brandFonts || []) {
    const family = font.family || "sans-serif";
    const weight = font.weight || "400";
    const style = font.style || "normal";
    const dataB64 = font.data_base64 || "";
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
    accent_color: "--accent",
    secondary_color: "--secondary",
    text_color: "--text",
    text_muted_color: "--text-muted",
    bg_color: "--bg",
    bg_light_color: "--bg-light",
    surface_color: "--surface",
    border_color: "--border",
  };
  const spacingMap = {
    margin_top_mm: "--margin-top",
    margin_bottom_mm: "--margin-bottom",
    margin_inner_mm: "--margin-inner",
    margin_outer_mm: "--margin-outer",
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
    "--accent": "#e94560",
    "--text": "#1a1a1a",
    "--text-muted": "#6b7280",
    "--bg": "#ffffff",
    "--bg-light": "#f5f5f5",
    "--surface": "#ffffff",
    "--border": "#e5e7eb",
    "--font-display": "system-ui, sans-serif",
    "--font-heading": "system-ui, sans-serif",
    "--font-body": "system-ui, sans-serif",
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

  const sql = getSql();

  try {
    const [report] = await sql`
      SELECT id, brand_id, template_id, tenant_id, document_css FROM v2_reports WHERE id = ${reportId} LIMIT 1
    `;
    if (!report) return json(event, 404, { error: "Report not found" });

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

    const fontFaceCss = buildFontFaceCss(fonts);
    const tokenCss = buildTokenCss(tokens);

    // Preferred path: the compose step has snapshotted a single document_css
    // that already contains brand vars + design-system + per-component CSS in
    // deterministic layer order. Serve that straight to the editor so its
    // preview matches the PDF exactly. @font-face blocks still need to be
    // prepended — those are per-brand, not per-report.
    let bundle;
    if (report.document_css && report.document_css.trim()) {
      bundle = [
        "/* ========== @font-face (brand fonts) ========== */",
        fontFaceCss,
        "/* ========== document_css snapshot (compose_pages) ========== */",
        report.document_css,
        "/* ========== template css_base ========== */",
        cssBase,
      ].join("\n\n");
    } else {
      // Legacy path for reports composed before 019_document_css landed.
      const designSystemCss = await loadDesignSystemCss();
      bundle = [
        "/* ========== @font-face ========== */",
        fontFaceCss,
        "/* ========== :root tokens ========== */",
        tokenCss,
        "/* ========== design-system.css ========== */",
        designSystemCss,
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
    });
  } catch (err) {
    console.error("[v2-brand-css]", err);
    return json(event, 500, { error: err.message });
  }
};
