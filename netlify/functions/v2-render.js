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
import { requireHubAuth } from "./auth-middleware.js";
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

async function getBlobStore(storeName) {
  const { getStore } = await import("@netlify/blobs");
  try {
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

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const body = parseBody(event);
  if (!body) return json(event, 400, { error: "Invalid JSON" });
  const parsed = renderSchema.safeParse(body);
  if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

  const { report_id, mode } = parsed.data;
  const sql = getSql();

  try {
    const reports = await sql`
      SELECT id, tenant_id, brand_id, title, template_id FROM v2_reports WHERE id = ${report_id} LIMIT 1
    `;
    if (!reports.length) return json(event, 404, { error: "Report not found" });
    const report = reports[0];

    const pages = await sql`
      SELECT id, page_number, page_type FROM v2_report_pages
      WHERE report_id = ${report_id} ORDER BY page_number
    `;
    const modules = await sql`
      SELECT id, page_id, module_type, order_index, content, style, html_cache
      FROM v2_report_modules WHERE report_id = ${report_id} ORDER BY order_index
    `;
    const brand = await fetchBrandContext(sql, report.brand_id);

    let cssBase = "";
    if (report.template_id) {
      const templates = await sql`SELECT css_base FROM report_templates WHERE id = ${report.template_id} LIMIT 1`;
      cssBase = templates[0]?.css_base || "";
    }

    const pdfResult = await callRenderService("/render/pdf", {
      report_id,
      title: report.title,
      mode,
      pages: pages.map((p) => ({
        ...p,
        modules: modules.filter((m) => m.page_id === p.id),
      })),
      brand_tokens: brand.tokens,
      brand_fonts: brand.fonts,
      brand_logos: brand.logos,
      css_base: cssBase,
    }, report.tenant_id);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blobKey = `tenants/${report.tenant_id}/reports/${report_id}/${mode}-${timestamp}.pdf`;
    const store = await getBlobStore("report-ai-pdfs");
    // smyra-render returns raw PDF bytes via callRenderService; legacy support
    // for pdf_base64 JSON shape is kept for local/dev mocks.
    const pdfBuffer = pdfResult.pdf_bytes
      ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
    if (!pdfBuffer) {
      throw new Error("Render service returned no PDF bytes");
    }
    await store.set(blobKey, pdfBuffer, { contentType: "application/pdf" });

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const pdfUrl = `${siteUrl}/.netlify/blobs/report-ai-pdfs/${blobKey}`;

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
