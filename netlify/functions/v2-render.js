/**
 * REST endpoint for Report Engine v2 PDF rendering.
 *
 * POST /api/v2-render  { report_id, mode }  → calls smyra-render /render/pdf,
 * stores result in Netlify Blobs, returns { pdf_url }.
 *
 * Auth: Hub JWT.
 */
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";

const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || "http://localhost:8080";

const renderSchema = z.object({
  report_id: z.string().uuid(),
  mode: z.enum(["draft", "final"]).default("draft"),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

/**
 * Emit a :root/:host style block that sets the CSS variables for any
 * tokens the author overrode in the Rapport-stil panel. Kept small and
 * self-contained (same mapping as v2-brand-css.buildTokenCss) so the
 * renderer gets the same semantics as the editor preview.
 */
function buildOverrideCss(overrides) {
  if (!overrides || typeof overrides !== "object") return "";
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
  const fontMap = {
    font_display: "--font-display",
    font_heading: "--font-heading",
    font_body: "--font-body",
  };
  const lines = [];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === undefined || v === "") continue;
    if (colorMap[k]) { lines.push(`  ${colorMap[k]}: ${v};`); continue; }
    if (fontMap[k])  { lines.push(`  ${fontMap[k]}: ${v};`); continue; }
    if (k === "base_font_size") {
      const val = /^\d+(\.\d+)?$/.test(String(v).trim()) ? `${v}pt` : v;
      lines.push(`  --base-font-size: ${val};`);
      continue;
    }
    if (k === "heading_scale") {
      lines.push(`  --heading-scale: ${v};`);
      continue;
    }
  }
  if (!lines.length) return "";
  // Colors + fonts go in :root and win the cascade. Base-font-size
  // scaling is appended ONLY if the author actually set one — an
  // empty/absent override shouldn't rewrite the design-system
  // typography classes, because that zeroed out body text in early
  // iterations when var(--base-font-size, 11pt) failed in WeasyPrint's
  // calc() parser on some edge cases.
  let extra = "";
  const basePx = overrides.base_font_size;
  if (basePx) {
    const base = /^\d+(\.\d+)?$/.test(String(basePx).trim()) ? `${basePx}pt` : basePx;
    extra = `
/* Typography scale tracks the author's chosen base size. Only emitted
   when base_font_size is explicitly overridden so unset reports keep
   the design-system.css defaults. */
.t-body  { font-size: calc(${base} * 0.95); }
.t-intro { font-size: calc(${base} * 1.05); }
.t-h1    { font-size: calc(${base} * 1.5);  }
.t-h2    { font-size: calc(${base} * 1.25); }
.t-h3    { font-size: calc(${base} * 1.1);  }
.t-caption { font-size: calc(${base} * 0.85); }
.t-display    { font-size: calc(${base} * 2);   }
.t-display-xl { font-size: calc(${base} * 2.5); }
`;
  }
  return `
:root { ${lines.join(" ")} }
a { color: var(--link, var(--primary)); }
${extra}`;
}

async function callRenderService(path, body, tenantId) {
  const token = mintSmyraRenderToken({ tenantId });
  const res = await fetch(`${RENDER_SERVICE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Render service ${path} returned ${res.status}: ${text}`);
  }
  // /render/pdf returns raw application/pdf bytes; other endpoints return JSON.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/pdf")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { pdf_bytes: buf };
  }
  return res.json();
}

async function getBlobStore(storeName, event) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (event) connectLambda(event);
    return getStore(storeName);
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: storeName, siteID, token });
    throw new Error(`Cannot access blob store "${storeName}"`);
  }
}

async function fetchBrandContext(sql, brandId) {
  if (!brandId) return { tokens: {}, fonts: [], logos: [] };
  const brands = await sql`SELECT tokens FROM brands WHERE id = ${brandId} LIMIT 1`;
  const tokens = brands[0]?.tokens || {};
  const fonts = await sql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brandId}`;
  const logos = await sql`SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id = ${brandId}`;
  return { tokens, fonts, logos };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const body = parseBody(event);
  if (!body) return json(event, 400, { error: "Invalid JSON" });
  const parsed = renderSchema.safeParse(body);
  if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

  const { report_id, mode } = parsed.data;

  if (editorScopeMismatch(auth, report_id)) {
    return json(event, 403, { error: "Editor token does not match report" });
  }
  // Editor token only allows draft renders
  if (auth.editorScope && mode !== "draft") {
    return json(event, 403, { error: "Editor token only allows draft renders" });
  }

  const sql = getSql();

  try {
    const reports = await sql`
      SELECT id, tenant_id, brand_id, title, template_id, page_format,
             document_css, style_overrides
      FROM v2_reports WHERE id = ${report_id} LIMIT 1
    `;
    if (!reports.length) return json(event, 404, { error: "Report not found" });
    const report = reports[0];

    let pages = await sql`
      SELECT id, page_number, page_type FROM v2_report_pages
      WHERE report_id = ${report_id} ORDER BY page_number
    `;
    const modules = await sql`
      SELECT id, page_id, module_type, order_index, content, style, html_cache, html_content, background
      FROM v2_report_modules WHERE report_id = ${report_id} ORDER BY order_index
    `;

    // Auto-paginate: if no pages exist but modules do, create one page per module
    if (!pages.length && modules.length) {
      const { randomUUID } = await import("node:crypto");
      for (let i = 0; i < modules.length; i++) {
        const mod = modules[i];
        const pageId = randomUUID();
        const pageType = mod.module_type === "cover" ? "cover"
          : mod.module_type === "back_cover" ? "back_cover"
          : "content";
        await sql`
          INSERT INTO v2_report_pages (id, report_id, page_number, page_type)
          VALUES (${pageId}, ${report_id}, ${i + 1}, ${pageType})
        `;
        await sql`
          UPDATE v2_report_modules SET page_id = ${pageId} WHERE id = ${mod.id}
        `;
        mod.page_id = pageId;
      }
      pages = await sql`
        SELECT id, page_number, page_type FROM v2_report_pages
        WHERE report_id = ${report_id} ORDER BY page_number
      `;
    }

    // Repair orphaned modules: pages exist but some modules have
    // page_id=null (happens when modules are added/duplicated after
    // auto-paginate has already run — the insert path didn't set
    // page_id, so they silently dropped out of rendering). Attach each
    // orphan to a new page slotted at its order_index position.
    // Sort pages by the lowest order_index of any module attached to
    // them. Without this, pages created by the orphan-repair branch
    // (or by the insert-path) are appended with a high page_number
    // even though their modules live earlier in the order. Result:
    // cover lands after back_cover in the PDF. Render order of truth
    // = module order_index, so sort pages accordingly.
    const sortPagesByModuleOrder = () => {
      const firstIdxByPage = new Map();
      for (const m of modules) {
        if (!m.page_id) continue;
        const cur = firstIdxByPage.get(m.page_id);
        if (cur === undefined || m.order_index < cur) {
          firstIdxByPage.set(m.page_id, m.order_index);
        }
      }
      pages.sort((a, b) => {
        const ai = firstIdxByPage.get(a.id);
        const bi = firstIdxByPage.get(b.id);
        // Pages with no modules fall to the end
        if (ai === undefined && bi === undefined) return a.page_number - b.page_number;
        if (ai === undefined) return 1;
        if (bi === undefined) return -1;
        return ai - bi;
      });
    };
    sortPagesByModuleOrder();

    const orphans = modules.filter((m) => !m.page_id);
    if (orphans.length > 0) {
      const { randomUUID } = await import("node:crypto");
      // Sort by order_index so the new pages land in the right sequence
      orphans.sort((a, b) => a.order_index - b.order_index);
      for (const orphan of orphans) {
        const pageId = randomUUID();
        const pageType = orphan.module_type === "cover" ? "cover"
          : orphan.module_type === "back_cover" ? "back_cover"
          : orphan.module_type === "chapter_break" ? "chapter_break"
          : "content";
        // Pick a page_number that slots in roughly where the module
        // sits in order_index. Since we can't reshuffle existing
        // page_numbers here without more work, just append to the end
        // with (max + 1 + i). Render order comes from order_index /
        // page_number lexical sort below, so appending is fine for
        // the per-page wrapping but the orphan will land at the
        // bottom of the PDF. Better than disappearing.
        const maxRes = await sql`
          SELECT COALESCE(MAX(page_number), 0) AS m FROM v2_report_pages WHERE report_id = ${report_id}
        `;
        const nextPageNum = (maxRes[0]?.m || 0) + 1;
        await sql`
          INSERT INTO v2_report_pages (id, report_id, page_number, page_type)
          VALUES (${pageId}, ${report_id}, ${nextPageNum}, ${pageType})
        `;
        await sql`
          UPDATE v2_report_modules SET page_id = ${pageId} WHERE id = ${orphan.id}
        `;
        orphan.page_id = pageId;
        console.warn(`[v2-render] repaired orphaned module ${orphan.id} (${orphan.module_type}) → page ${pageId}`);
      }
      pages = await sql`
        SELECT id, page_number, page_type FROM v2_report_pages
        WHERE report_id = ${report_id} ORDER BY page_number
      `;
      sortPagesByModuleOrder();
    }

    if (!pages.length) {
      return json(event, 400, { error: "No pages or modules in report — nothing to render" });
    }

    const brand = await fetchBrandContext(sql, report.brand_id);

    // 2026-05-13: fetch alpha-v3 content units. Without this every
    // `<p data-unit="X"></p>` element in the page HTML rendered as empty
    // (handleRenderFreeformPdf in mcp-v2.js already fetches them; this
    // editor-side path was the missing twin — produced text-less PDFs
    // from the editor's "Render Draft" button). Legacy reports with no
    // units simply return an empty array, so substitute_units is a
    // no-op and HTML renders as today.
    const units = await sql`
      SELECT unit_id, type, level, text, metadata, order_index
      FROM v2_content_units
      WHERE report_id = ${report_id}
      ORDER BY order_index ASC
    `;

    let cssBase = "";
    if (report.template_id) {
      const templates = await sql`SELECT css_base FROM report_templates WHERE id = ${report.template_id} LIMIT 1`;
      cssBase = templates[0]?.css_base || "";
    }

    // Merge report-level style overrides on top of brand tokens so the
    // PDF matches what the editor's Rapport-stil panel shows. Empty or
    // null values fall through to brand defaults.
    const overrides = report.style_overrides || {};
    const mergedTokens = { ...(brand.tokens || {}) };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === undefined || v === "") continue;
      mergedTokens[k] = v;
    }

    // Build a late-cascade override block so overrides beat any :root
    // tokens baked into document_css at compose time. Uses the same
    // buildTokenCss as v2-brand-css (shape-compatible).
    const overrideCss = buildOverrideCss(overrides);

    // Pass per-module background spec to the renderer so cover photos,
    // gradients, vignettes and filters land in the PDF too.
    const pagesWithBackgrounds = pages.map((p) => ({
      ...p,
      modules: modules
        .filter((m) => m.page_id === p.id)
        .map((m) => ({
          ...m,
          // background is a JSONB column, already parsed. Safe to pass
          // through as-is — smyra-render builds absolutely-positioned
          // layers with CSS filter + gradient background-image.
          background: m.background || null,
        })),
    }));

    const pdfResult = await callRenderService("/render/pdf", {
      report_id,
      title: report.title,
      mode,
      page_format: report.page_format || 'a4_portrait',
      pages: pagesWithBackgrounds,
      brand_tokens: mergedTokens,
      brand_fonts: brand.fonts,
      brand_logos: brand.logos,
      css_base: cssBase,
      // document_css is the authoritative stylesheet snapshot written by
      // compose_pages — brand vars + design-system + per-component CSS.
      // When present, smyra-render layers it over its generic defaults so
      // WeasyPrint output matches the editor preview exactly.
      document_css: report.document_css ?? null,
      // Late-cascade rules so report-level overrides beat the :root
      // tokens that were baked into document_css at compose time —
      // same approach as v2-brand-css for the editor preview.
      document_css_overrides: overrideCss,
      // Also include raw overrides so smyra-render can log / debug.
      style_overrides: overrides,
      // alpha-v3 content units. Empty array for legacy reports — render
      // skips substitute_units entirely when units AND keep_placeholders
      // are both falsy, so legacy behaviour is preserved.
      units,
    }, report.tenant_id);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blobKey = `tenants/${report.tenant_id}/reports/${report_id}/${mode}-${timestamp}.pdf`;
    const store = await getBlobStore("report-ai-pdfs", event);
    // smyra-render returns raw PDF bytes via callRenderService; legacy support
    // for pdf_base64 JSON shape is kept for local/dev mocks.
    const pdfBuffer = pdfResult.pdf_bytes
      ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
    if (!pdfBuffer) {
      throw new Error("Render service returned no PDF bytes");
    }
    await store.set(blobKey, pdfBuffer, { contentType: "application/pdf" });

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const pdfUrl = `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(blobKey)}`;

    return json(event, 200, {
      pdf_url: pdfUrl,
      blob_key: blobKey,
      page_count: pages.length,
      mode,
      size_bytes: pdfBuffer.length,
    });
  } catch (err) {
    console.error("[v2-render]", err);
    return json(event, 500, { error: err.message });
  }
};
