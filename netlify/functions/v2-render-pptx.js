/**
 * REST endpoint for editor-side .pptx export.
 *
 * POST /api/v2-render-pptx  { report_id }  → calls smyra-render /render/pptx,
 * stores result in Netlify Blobs, returns { pptx_url, pages_count, size_bytes }.
 *
 * Auth: Hub JWT OR editor token (same as v2-render).
 *
 * 2026-05-13: built so the editor's "Export to PowerPoint" button can
 * trigger a .pptx download independently of the workflow's export_pptx
 * choice. Mirrors v2-render.js (page assembly + brand resolution +
 * units fetch + render service call) but targets /render/pptx and
 * stores as .pptx.
 *
 * Sync — bounded by Netlify's 26s function cap. For 20+ page decks
 * (where Cloud Run /render/pptx exceeds the cap), users should fall
 * back on the workflow's export_pptx path which queues through the
 * render-freeform-pptx-background.js BG function (15 min cap).
 */
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";

const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || "http://localhost:8080";

const schema = z.object({
  report_id: z.string().uuid(),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
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
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

  const { report_id } = parsed.data;

  if (editorScopeMismatch(auth, report_id)) {
    return json(event, 403, { error: "Editor token does not match report" });
  }

  const sql = getSql();

  try {
    const reports = await sql`
      SELECT id, tenant_id, brand_id, title, page_format, document_css, document_css_overrides
      FROM v2_reports WHERE id = ${report_id} LIMIT 1
    `;
    if (!reports.length) return json(event, 404, { error: "Report not found" });
    const report = reports[0];

    const pages = await sql`
      SELECT id, page_number, page_type FROM v2_report_pages
      WHERE report_id = ${report_id} ORDER BY page_number
    `;
    const modules = await sql`
      SELECT id, page_id, module_type, order_index, html_cache, html_content
      FROM v2_report_modules WHERE report_id = ${report_id} ORDER BY order_index
    `;
    if (!pages.length) {
      return json(event, 400, { error: "No pages in report — nothing to export" });
    }

    // Build freeform-style page-payload for /render/pptx. Each page →
    // its single freeform module's html_cache (alpha-v3 invariant: one
    // module per page, module_type='freeform').
    const renderPages = [];
    for (const page of pages) {
      const pageMods = modules.filter((m) => m.page_id === page.id);
      if (pageMods.length === 0) continue;
      // Use the first freeform module's HTML. (Multi-module pages aren't
      // valid in alpha-v3 — this is defensive.)
      const mod = pageMods[0];
      const html = mod.html_cache || mod.html_content;
      if (!html) continue;
      renderPages.push({
        page_num: page.page_number,
        module_ids: [mod.id],
        html,
      });
    }
    if (renderPages.length === 0) {
      return json(event, 400, { error: "No renderable page HTML found" });
    }

    const brand = await fetchBrandContext(sql, report.brand_id);

    // Fetch units (same as v2-render's 2026-05-13 fix) so text gets
    // substituted into data-unit placeholders.
    const units = await sql`
      SELECT unit_id, type, level, text, metadata, order_index
      FROM v2_content_units
      WHERE report_id = ${report_id}
      ORDER BY order_index ASC
    `;

    // Call Cloud Run /render/pptx. Sync — bounded by Netlify 26s cap.
    const pptxResult = await callRenderService("/render/pptx", {
      pages: renderPages,
      design_system_css: report.document_css ?? "",
      augmented_design_css_additions: report.document_css_overrides ?? "",
      page_format: report.page_format || "a4_portrait",
      brand_tokens: brand.tokens ?? {},
      brand_fonts: brand.fonts ?? [],
      brand_logos: brand.logos ?? [],
      units: units ?? [],
      keep_placeholders: false,
    }, report.tenant_id);

    if (!pptxResult || typeof pptxResult.pptx_base64 !== "string" || !pptxResult.pptx_base64) {
      throw new Error("Render service returned no .pptx bytes");
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blobKey = `tenants/${report.tenant_id}/reports/${report_id}/pptx-${timestamp}.pptx`;
    const store = await getBlobStore("report-ai-pdfs", event);
    const pptxBuffer = Buffer.from(pptxResult.pptx_base64, "base64");
    await store.set(blobKey, pptxBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const pptxUrl = `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(blobKey)}`;

    return json(event, 200, {
      pptx_url: pptxUrl,
      blob_key: blobKey,
      pages_count: renderPages.length,
      size_bytes: pptxBuffer.length,
    });
  } catch (err) {
    console.error("[v2-render-pptx]", err);
    return json(event, 500, { error: err.message });
  }
};
