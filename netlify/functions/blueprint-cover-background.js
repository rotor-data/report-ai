/**
 * POST /.netlify/functions/blueprint-cover-background
 *
 * Netlify Background Function. Renders sample_pages_html[0] for a
 * newly-saved blueprint and writes the resulting PNG URL to
 * report_blueprints.cover_thumbnail_url. Previously this work was
 * done via `Promise.resolve().then(() => renderBlueprintCover(...))`
 * inside `handleSaveBlueprint` in mcp-v2.js, which pinned the
 * foreground Lambda waiting for Chromium rasterisation (5–15s) even
 * though the save response had already been written.
 *
 * Trigger body:
 *   {
 *     blueprint_id:      string (UUID),
 *     sample_html:       string  (sample_pages_html[0], raw or wrapped),
 *     design_system_css: string,
 *     brand_id:          string (UUID),
 *     page_format?:      string  (default 'a4_portrait')
 *   }
 *
 * Auth: shared-secret header `x-internal-trigger-secret` matching env
 * `INTERNAL_TRIGGER_SECRET`. Fail-closed if env not set.
 *
 * Errors are logged and swallowed — a missing cover just means the
 * setup picker falls back to a text-only choice.
 */
import { randomUUID, createHash } from "node:crypto";
import { getSql } from "./db.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";

const RENDER_SERVICE_URL = process.env.SMYRA_RENDER_URL || process.env.RENDER_SERVICE_URL || "https://smyra-render-178695091452.europe-north1.run.app";

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
    return getStore({ name: storeName });
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

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const expectedSecret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!expectedSecret) {
    console.warn("[blueprint-cover-bg] INTERNAL_TRIGGER_SECRET not configured — refusing to run");
    return new Response("not configured", { status: 503 });
  }
  const providedSecret = req.headers.get("x-internal-trigger-secret") || "";
  if (providedSecret !== expectedSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const { blueprint_id, sample_html, design_system_css, brand_id } = body || {};
  const pageFormat = (body?.page_format && typeof body.page_format === "string") ? body.page_format : "a4_portrait";

  if (!blueprint_id || !brand_id || typeof sample_html !== "string" || !sample_html.length || typeof design_system_css !== "string") {
    console.warn("[blueprint-cover-bg] missing fields");
    return new Response("bad request", { status: 400 });
  }

  try {
    const sql = getSql();
    const brandRows = await sql`SELECT tenant_id FROM brands WHERE id = ${brand_id} LIMIT 1`;
    const tenantId = brandRows[0]?.tenant_id;
    if (!tenantId) {
      console.warn(`[blueprint-cover-bg] brand ${brand_id} has no tenant_id`);
      return new Response("brand not found", { status: 404 });
    }

    const cssHash = createHash("sha256").update(design_system_css).digest("hex").slice(0, 8);
    const pageHash = createHash("sha256").update(sample_html).digest("hex").slice(0, 8);
    const blobKey = `thumbnails/${brand_id}/${cssHash}-${pageHash}-p1.png`;
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const url = `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`;

    const assetStore = await getBlobStore("report-ai-assets");
    let cached = false;
    try {
      if (await assetStore.getMetadata(blobKey)) cached = true;
    } catch { /* cache miss */ }

    if (!cached) {
      const brand = await fetchBrandContext(sql, brand_id);
      const syntheticPage = {
        id: randomUUID(),
        page_number: 1,
        page_type: "cover",
        modules: [{
          module_type: "freeform_page",
          order_index: 0,
          html_content: sample_html,
          html_cache: sample_html,
          content: {},
          style: {},
          background: null,
        }],
      };
      const pdfResult = await callRenderService("/render/pdf", {
        report_id: randomUUID(),
        title: "Blueprint cover",
        mode: "draft",
        page_format: pageFormat,
        pages: [syntheticPage],
        brand_tokens: brand.tokens ?? {},
        brand_fonts: brand.fonts ?? [],
        brand_logos: brand.logos ?? [],
        css_base: "",
        document_css: design_system_css,
        document_css_overrides: "",
        style_overrides: {},
      }, tenantId);
      const pdfBuffer = pdfResult.pdf_bytes
        ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
      if (!pdfBuffer) throw new Error("render returned no PDF bytes");
      const raster = await callRenderService("/render/rasterize", {
        pdf_base64: pdfBuffer.toString("base64"),
      }, tenantId);
      const rasterPage = raster.pages?.[0];
      if (!rasterPage?.png_base64) throw new Error("rasterize returned no PNG");
      await assetStore.set(blobKey, Buffer.from(rasterPage.png_base64, "base64"), { contentType: "image/png" });
    }

    await sql`UPDATE report_blueprints SET cover_thumbnail_url = ${url} WHERE id = ${blueprint_id}`;
    console.log(`[blueprint-cover-bg] ${blueprint_id} cover ${cached ? "reused" : "rendered"}`);
    return new Response("ok", { status: 202 });
  } catch (err) {
    console.error(`[blueprint-cover-bg] ${blueprint_id} failed:`, err?.message || err);
    return new Response("error", { status: 202 });
  }
}
