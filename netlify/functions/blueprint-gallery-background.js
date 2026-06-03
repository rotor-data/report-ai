/**
 * POST /.netlify/functions/blueprint-gallery-background
 *
 * Netlify Background Function. Renders a 2x2 grid PNG of the first
 * up-to-4 sample pages of a blueprint and writes its URL to
 * report_blueprints.gallery_url. Previously done via
 * `Promise.resolve().then(() => renderBlueprintGallery(...))` inside
 * `handleSaveBlueprint` in mcp-v2.js, which pinned the foreground
 * Lambda waiting on Chromium rasterisation.
 *
 * Trigger body:
 *   {
 *     blueprint_id:      string (UUID),
 *     samples:           Array<string | {html: string}>,
 *     design_system_css: string,
 *     brand_id:          string | null,
 *     tenant_id:         string | null,
 *     page_format?:      string  (default 'a4_portrait')
 *   }
 *
 * Auth: shared-secret header `x-internal-trigger-secret` matching env
 * `INTERNAL_TRIGGER_SECRET`. Fail-closed if env not set.
 */
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
    console.warn("[blueprint-gallery-bg] INTERNAL_TRIGGER_SECRET not configured — refusing to run");
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
  const { blueprint_id, samples, design_system_css, brand_id, tenant_id } = body || {};
  const pageFormat = (body?.page_format && typeof body.page_format === "string") ? body.page_format : "a4_portrait";

  if (!blueprint_id || !Array.isArray(samples) || samples.length === 0 || typeof design_system_css !== "string") {
    console.warn("[blueprint-gallery-bg] missing fields");
    return new Response("bad request", { status: 400 });
  }

  try {
    const sql = getSql();

    // Resolve tenant_id for the smyra-render JWT.
    let resolvedTenantId = tenant_id || null;
    if (!resolvedTenantId && brand_id) {
      const brandRows = await sql`SELECT tenant_id FROM brands WHERE id = ${brand_id} LIMIT 1`;
      resolvedTenantId = brandRows[0]?.tenant_id || null;
    }
    if (!resolvedTenantId) {
      // Smyra-visibility blueprints have neither — synthetic claim.
      resolvedTenantId = "smyra-platform";
    }

    const normalised = samples.slice(0, 4).map((s, i) => {
      const html = typeof s === "string" ? s : (s && typeof s === "object" && typeof s.html === "string" ? s.html : "");
      return { page_num: i + 1, html };
    }).filter((s) => s.html.length > 0);

    if (normalised.length === 0) {
      console.warn(`[blueprint-gallery-bg] ${blueprint_id} no usable samples`);
      return new Response("no samples", { status: 202 });
    }

    let brand = { tokens: {}, fonts: [], logos: [] };
    if (brand_id) {
      try { brand = await fetchBrandContext(sql, brand_id); } catch { /* fall back to empty */ }
    }

    const result = await callRenderService("/render/sample-grid", {
      pages: normalised,
      design_system_css,
      brand_tokens: brand.tokens ?? {},
      brand_fonts: brand.fonts ?? [],
      brand_logos: brand.logos ?? [],
      page_format: pageFormat,
      keep_placeholders: true,
    }, resolvedTenantId);

    const pngBase64 = result?.png_base64;
    if (!pngBase64) throw new Error("sample-grid returned no PNG");

    const blobKey = `blueprint-galleries/${blueprint_id}.png`;
    const assetStore = await getBlobStore("report-ai-assets");
    await assetStore.set(blobKey, Buffer.from(pngBase64, "base64"), { contentType: "image/png" });

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const url = `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`;

    await sql`
      UPDATE report_blueprints
      SET gallery_url = ${url}, gallery_generated_at = NOW()
      WHERE id = ${blueprint_id}
    `;
    console.log(`[blueprint-gallery-bg] ${blueprint_id} rendered ${result.page_count ?? normalised.length}-page grid`);
    return new Response("ok", { status: 202 });
  } catch (err) {
    console.error(`[blueprint-gallery-bg] ${blueprint_id} failed:`, err?.message || err);
    return new Response("error", { status: 202 });
  }
}
