/**
 * GET /api/v2-brand-css?report_id=<uuid>
 *
 * Returns the complete CSS bundle needed to render a report preview
 * in the editor shadow DOM so it matches what smyra-render produces.
 *
 * Bundle contents:
 *   1. @font-face declarations (base64 embedded, same as render.py _build_font_face_css)
 *   2. :root CSS custom properties from brand_tokens (same as _build_token_css)
 *   3. design-system.css utility classes (.page, .grid--N, .t-display, etc.)
 *
 * Auth: Hub JWT OR editor capability token. When an editor token is
 * used, the scoped report_id must match the query param.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { json, noContent, getCorsHeaders } from "./cors.js";
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

    // brand_fonts stores `format` (not mime), e.g. 'woff2' | 'woff' | 'ttf' | 'otf'
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
      SELECT id, brand_id, template_id FROM v2_reports WHERE id = ${reportId} LIMIT 1
    `;
    if (!report) return json(event, 404, { error: "Report not found" });

    // Brand tokens + fonts
    let tokens = {};
    let fonts = [];
    if (report.brand_id) {
      const brands = await sql`SELECT tokens FROM brands WHERE id = ${report.brand_id} LIMIT 1`;
      tokens = brands[0]?.tokens || {};
      fonts = await sql`
        SELECT family, weight, style, format, data_base64
        FROM brand_fonts WHERE brand_id = ${report.brand_id}
      `;
    }

    // Template css_base (optional — some templates ship extra CSS)
    let cssBase = "";
    if (report.template_id) {
      const [tpl] = await sql`SELECT css_base FROM report_templates WHERE id = ${report.template_id} LIMIT 1`;
      cssBase = tpl?.css_base || "";
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

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "private, max-age=60",
        ...getCorsHeaders(event),
      },
      body: bundle,
    };
  } catch (err) {
    console.error("[v2-brand-css]", err);
    return json(event, 500, { error: err.message });
  }
};
