/**
 * POST /.netlify/functions/render-freeform-pptx-background
 *
 * Netlify Background Function. Runs the full alpha-v3 pptx render
 * outside the 26s foreground cap that bound `mcp-v2.js`'s
 * `handleRenderFreeformPptx`. Up to 15 min processing.
 *
 * Invoked by the hub's render-worker-background.js when it dequeues a
 * job with `mode='pptx'` or `payload.kind='pptx'`. Body shape:
 *
 *   {
 *     job_id: string,                  // render_jobs.id in hub DB
 *     hub_callback_url: string,        // POST here when finished
 *     hub_callback_secret: string,     // shared secret -> x-render-callback-secret
 *     payload: { pages, design_system_css, brand_id, page_format, ... },
 *     report_id: string,
 *   }
 *
 * On completion we POST {job_id, status, pdf_url|error_message, duration_ms}
 * to the hub callback URL. The hub writes to render_jobs and smyra-core's
 * polling sees the result.
 *
 * Authenticated via the hub JWT (same as mcp-v2) so only the hub worker
 * can invoke it. Background functions cannot return errors meaningfully
 * (Netlify treats them as fire-and-forget) so all failures route through
 * the callback's error_message path instead.
 */
import { verifyHubJwt } from "./verify-hub-jwt.js";
import { getSql } from "./db.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";

const RENDER_SERVICE_URL = process.env.SMYRA_RENDER_URL || "https://smyra-render-178695091452.europe-north1.run.app";

// ─── Duplicated helpers from mcp-v2.js (refactor later when more shared) ───

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

async function getBlobStore(storeName, event, opts = {}) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (event) connectLambda(event);
    return getStore({ name: storeName, ...opts });
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: storeName, siteID, token, ...opts });
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

function unwrapSectionPage(html) {
  if (typeof html !== "string") return html;
  const trimmed = html.trim();
  const m = trimmed.match(/^<section\b([^>]*)>([\s\S]*)<\/section>\s*$/i);
  if (!m) return html;
  const attrs = m[1] || "";
  const inner = m[2];
  const classMatch = attrs.match(/\bclass\s*=\s*(["'])([^"']*)\1/i);
  if (!classMatch || !/\b(page|chapter)\b/.test(classMatch[2])) return html;
  // Keep the section wrapper intact (see mcp-v2.js docs on why).
  return html;
}

async function postCallback(url, secret, body) {
  if (!url || !secret) {
    console.warn("[render-pptx-bg] missing callback url/secret — cannot report job status");
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-render-callback-secret": secret,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[render-pptx-bg] callback failed:", err?.message ?? err);
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────

export default async function handler(req, ctx) {
  const tStart = Date.now();
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Hub JWT auth — same RS256 verify as mcp-v2. Hub worker mints with
  // module audience 'report-ai-v2' (or legacy 'report-ai').
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response("missing Authorization", { status: 401 });
  }
  const publicPem = process.env.HUB_JWT_PUBLIC_KEY_PEM;
  const issuer = process.env.HUB_JWT_ISSUER ?? "hub.rotor-platform.com";
  const acceptedAudiences = process.env.MODULE_AUDIENCE
    ? [process.env.MODULE_AUDIENCE]
    : ["report-ai-v2", "report-ai"];
  if (!publicPem) {
    return new Response("HUB_JWT_PUBLIC_KEY_PEM not configured", { status: 500 });
  }
  let auth;
  for (const audience of acceptedAudiences) {
    auth = verifyHubJwt(token, { publicPem, issuer, audience });
    if (auth.ok) break;
  }
  if (!auth?.ok) {
    console.warn("[render-pptx-bg] auth failed:", auth?.error);
    return new Response(`unauthorized: ${auth?.error || "unknown"}`, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const { job_id, hub_callback_url, hub_callback_secret, payload, report_id } = body || {};

  // Always callback on error — never let an unhandled throw kill the job silently.
  const fail = async (msg) => {
    console.error("[render-pptx-bg]", job_id, msg);
    await postCallback(hub_callback_url, hub_callback_secret, {
      job_id,
      status: "failed",
      error_message: String(msg).slice(0, 500),
      duration_ms: Date.now() - tStart,
    });
    // Background functions always return 202; the status is in the callback.
    return new Response("failed", { status: 202 });
  };

  if (!job_id) return fail("missing job_id");
  if (!report_id) return fail("missing report_id");
  if (!payload || !Array.isArray(payload.pages) || payload.pages.length === 0) {
    return fail("payload.pages required");
  }
  if (typeof payload.design_system_css !== "string" || !payload.design_system_css.trim()) {
    return fail("payload.design_system_css required");
  }
  if (typeof payload.brand_id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.brand_id)) {
    return fail("payload.brand_id must be a UUID");
  }

  try {
    const sql = getSql();

    // Resolve tenant_id from brand for blob-storage scoping and JWT.
    const brandRow = await sql`SELECT tenant_id FROM brands WHERE id = ${payload.brand_id} LIMIT 1`;
    const tenantId = brandRow[0]?.tenant_id;
    if (!tenantId) return fail(`Brand ${payload.brand_id} not found`);

    // Fetch brand context (tokens, fonts, logos).
    const brand = await fetchBrandContext(sql, payload.brand_id);

    // Resolve units (payload override > v2_content_units DB rows).
    let units;
    if (Array.isArray(payload.units) && payload.units.length > 0) {
      units = payload.units;
    } else {
      const unitRows = await sql`
        SELECT unit_id, type, level, text, metadata, order_index
        FROM v2_content_units
        WHERE report_id = ${report_id}::uuid
        ORDER BY order_index ASC
      `;
      units = unitRows || [];
    }

    const pages = payload.pages.map((p) => ({
      page_num: p.page_num,
      html: unwrapSectionPage(p.html),
    }));

    const fullCss = payload.design_system_css + (payload.augmented_design_css_additions ?? "");

    console.log(`[render-pptx-bg] ${job_id} starting render: ${pages.length} pages, brand=${payload.brand_id.slice(0, 8)}`);

    // ── Cloud Run /render/pptx ────────────────────────────────────────────
    const pptxResult = await callRenderService("/render/pptx", {
      pages,
      design_system_css: fullCss,
      page_format: payload.page_format ?? "a4_portrait",
      brand_tokens: brand.tokens ?? {},
      brand_fonts: brand.fonts ?? [],
      brand_logos: brand.logos ?? [],
      augmented_design_css_additions: payload.augmented_design_css_additions ?? "",
      units,
      keep_placeholders: payload.keep_placeholders === true,
    }, tenantId);

    if (!pptxResult || typeof pptxResult.pptx_base64 !== "string" || !pptxResult.pptx_base64) {
      return fail("Render service returned no .pptx bytes");
    }

    // ── Blob store ────────────────────────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blobKey = `tenants/${tenantId}/reports/${report_id}/pptx-${timestamp}.pptx`;
    const store = await getBlobStore("report-ai-pdfs", { ...req, ctx });
    const pptxBuffer = Buffer.from(pptxResult.pptx_base64, "base64");
    await store.set(blobKey, pptxBuffer, {
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const pptxUrl = `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(blobKey)}`;
    const duration = Date.now() - tStart;

    console.log(`[render-pptx-bg] ${job_id} done in ${duration}ms — ${Math.round(pptxBuffer.length / 1024)}KB`);

    await postCallback(hub_callback_url, hub_callback_secret, {
      job_id,
      status: "done",
      pdf_url: pptxUrl,    // hub stores under pdf_url column (artifact-url, name historic)
      duration_ms: duration,
      size_bytes: pptxBuffer.length,
      pages_count: pages.length,
    });

    return new Response("ok", { status: 202 });
  } catch (err) {
    return fail(err?.message ?? String(err));
  }
}
