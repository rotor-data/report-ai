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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache design-system.css across invocations (small file, rarely changes)
let _designSystemCache = null;
async function loadDesignSystemCss() {
  if (_designSystemCache !== null) return _designSystemCache;
  try {
    const p = join(__dirname, "assets", "design-system.css");
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

function buildTokenCss(brandTokens) {
  if (!brandTokens || typeof brandTokens !== "object") return "";
  const entries = Object.entries(brandTokens);
  if (!entries.length) return "";
  const props = entries.map(([key, value]) => {
    const cssKey = key.startsWith("--") ? key : `--${key}`;
    return `  ${cssKey}: ${value};`;
  });
  return `:root {\n${props.join("\n")}\n}`;
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
      SELECT id, brand_id, template_id, tenant_id FROM v2_reports WHERE id = ${reportId} LIMIT 1
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
    const designSystemCss = await loadDesignSystemCss();

    const bundle = [
      "/* ========== @font-face ========== */",
      fontFaceCss,
      "/* ========== :root tokens ========== */",
      tokenCss,
      "/* ========== design-system.css ========== */",
      designSystemCss,
      "/* ========== template css_base ========== */",
      cssBase,
    ].join("\n\n");

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
