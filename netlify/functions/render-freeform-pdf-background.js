/**
 * POST /.netlify/functions/render-freeform-pdf-background
 *
 * Netlify Background Function. Runs the full alpha-v3 PDF render
 * outside the 26s foreground cap that bounds `mcp-v2.js`'s
 * `handleRenderFreeformPdf`. Up to 15 min processing — needed for
 * 30+ page reports where the synchronous mcp-v2 path was blowing
 * the Netlify foreground timeout.
 *
 * Invoked by the hub's render-worker-background.js for ALL freeform
 * PDF jobs (anything with `payload.kind !== 'pptx'` and a `pages`
 * array). Body shape:
 *
 *   {
 *     job_id: string,                  // render_jobs.id in hub DB
 *     hub_callback_url: string,        // POST here when finished
 *     hub_callback_secret: string,     // shared secret -> x-render-callback-secret
 *     payload: { pages, design_system_css, brand_id, page_format, ... },
 *     report_id: string,
 *     mode: 'draft' | 'final',
 *   }
 *
 * On completion we POST {job_id, status, pdf_url|error_message, duration_ms, thumbnails?}
 * to the hub callback URL. The hub writes to render_jobs and smyra-core's
 * polling sees the result.
 *
 * Authenticated via the hub JWT (same as mcp-v2). Background functions
 * cannot return errors meaningfully (Netlify treats them as
 * fire-and-forget), so all failures route through the callback's
 * error_message path instead.
 *
 * Mirrors render-freeform-pptx-background.js — only difference is it
 * calls /render/pdf (raw bytes) and optionally /render/rasterize for
 * draft-mode thumbnails. Helpers are duplicated rather than imported
 * because the pptx BG follows the same pattern (refactor later if a
 * third worker shows up).
 */
import { verifyHubJwt } from "./verify-hub-jwt.js";
import { getSql } from "./db.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";

const RENDER_SERVICE_URL = process.env.SMYRA_RENDER_URL || "https://smyra-render-178695091452.europe-north1.run.app";

// ─── Duplicated helpers from mcp-v2.js / pptx BG (refactor later) ───────────

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

async function getBlobStore(storeName, event, opts = {}) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  // Best-effort: bind Lambda-v1 blobs context if the event carries one.
  // In Netlify Functions v2 handlers the caller spreads a `Request` here
  // which has no enumerable .blobs / .headers — connectLambda would throw
  // on undefined inputs. That's fine: v2's runtime injects the blobs
  // context via globalThis/NETLIFY_BLOBS_CONTEXT, so getStore({name})
  // works without it. We swallow the connectLambda error and let getStore
  // try the ambient context next.
  if (event) {
    try { connectLambda(event); } catch { /* v2 path: no Lambda event */ }
  }
  try {
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
  const classMatch = attrs.match(/\bclass\s*=\s*(["'])([^"']*)\1/i);
  if (!classMatch || !/\b(page|chapter)\b/.test(classMatch[2])) return html;
  // Keep the section wrapper intact (see mcp-v2.js docs on why).
  return html;
}

async function postCallback(url, secret, body) {
  if (!url || !secret) {
    console.warn("[render-pdf-bg] missing callback url/secret — cannot report job status");
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
    console.error("[render-pdf-bg] callback failed:", err?.message ?? err);
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
    console.warn("[render-pdf-bg] auth failed:", auth?.error);
    return new Response(`unauthorized: ${auth?.error || "unknown"}`, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const { job_id, hub_callback_url, hub_callback_secret, payload, report_id, mode } = body || {};

  // Always callback on error — never let an unhandled throw kill the job silently.
  const fail = async (msg) => {
    console.error("[render-pdf-bg]", job_id, msg);
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
  const renderMode = (mode === "final") ? "final" : "draft";

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
    const keepPlaceholders = payload.keep_placeholders === true;

    // page_format resolution: payload → v2_reports row → a4_portrait.
    let resolvedPageFormat = (typeof payload.page_format === "string" && payload.page_format.trim())
      ? payload.page_format.trim()
      : null;
    if (!resolvedPageFormat) {
      try {
        const fmtRows = await sql`SELECT page_format FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
        resolvedPageFormat = fmtRows[0]?.page_format || null;
      } catch (err) {
        console.warn("[render-pdf-bg] page_format lookup failed:", err.message);
      }
    }
    if (!resolvedPageFormat) resolvedPageFormat = "a4_portrait";

    // Synthesise smyra-render pages — same shape as mcp-v2 handler.
    const { randomUUID } = await import("node:crypto");
    const syntheticPages = payload.pages.map((p) => {
      const html = unwrapSectionPage(p.html);
      return {
        id: randomUUID(),
        page_number: p.page_num,
        page_type: p.page_num === 1 ? "cover" : "content",
        modules: [
          {
            module_type: "freeform",
            order_index: p.page_num,
            html_content: html,
            html_cache: html,
            content: {},
            style: {},
            background: null,
          },
        ],
      };
    });

    const fullCss = payload.design_system_css + (payload.augmented_design_css_additions ?? "");

    console.log(`[render-pdf-bg] ${job_id} starting render: ${payload.pages.length} pages, mode=${renderMode}, brand=${payload.brand_id.slice(0, 8)}`);

    // ── Cloud Run /render/pdf ─────────────────────────────────────────────
    const pdfResult = await callRenderService("/render/pdf", {
      report_id,
      title: payload.title ?? "Untitled report",
      mode: renderMode,
      page_format: resolvedPageFormat,
      pages: syntheticPages,
      brand_tokens: brand.tokens ?? {},
      brand_fonts: brand.fonts ?? [],
      brand_logos: brand.logos ?? [],
      css_base: "",
      document_css: fullCss,
      document_css_overrides: "",
      style_overrides: {},
      units,
      keep_placeholders: keepPlaceholders,
      // Request pagination_map so we can persist flow_pdf_pages per block.
      pagination_map: true,
    }, tenantId);

    const pdfBuffer = pdfResult.pdf_bytes
      ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
    if (!pdfBuffer) return fail("Render service returned no PDF bytes");

    // ── Blob store: PDF ──────────────────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blobKey = `tenants/${tenantId}/reports/${report_id}/${renderMode}-${timestamp}.pdf`;
    const store = await getBlobStore("report-ai-pdfs", { ...req, ctx });
    await store.set(blobKey, pdfBuffer, { contentType: "application/pdf" });

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const pdfUrl = `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(blobKey)}`;

    // ── Write back flow_pdf_pages (non-fatal) ────────────────────────────
    const paginationMap = Array.isArray(pdfResult.pagination_map) ? pdfResult.pagination_map : [];
    if (paginationMap.length > 0) {
      try {
        for (const m of paginationMap) {
          if (typeof m?.block_index !== "number" || !Array.isArray(m.pdf_pages)) continue;
          await sql`
            UPDATE v2_report_pages
               SET flow_pdf_pages = ${m.pdf_pages}::int[]
             WHERE report_id = ${report_id}::uuid AND block_index = ${m.block_index}
          `;
        }
      } catch (mapErr) {
        console.warn("[render-pdf-bg] flow_pdf_pages UPDATE failed (non-fatal):", mapErr.message);
      }
    }

    // ── Rasterize thumbnails for draft mode (non-fatal) ──────────────────
    let thumbnails = [];
    if (renderMode === "draft") {
      try {
        const raster = await callRenderService("/render/rasterize", {
          pdf_base64: pdfBuffer.toString("base64"),
        }, tenantId);
        const assetStore = await getBlobStore("report-ai-assets", { ...req, ctx });
        for (const page of raster.pages || []) {
          const thumbKey = `tenants/${tenantId}/reports/${report_id}/thumbs/${timestamp}-page-${page.page}.png`;
          const pngBuffer = Buffer.from(page.png_base64, "base64");
          await assetStore.set(thumbKey, pngBuffer, { contentType: "image/png" });
          thumbnails.push({
            page: page.page,
            url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(thumbKey)}`,
          });
        }
      } catch (err) {
        console.warn("[render-pdf-bg] rasterize failed (non-fatal):", err.message);
      }
    }

    // ── Persist composed CSS to v2_reports.document_css (non-fatal) ──────
    // Editor reads v2_reports.document_css for its brand-style injection.
    try {
      await sql`
        UPDATE v2_reports
        SET document_css = ${fullCss},
            document_css_overrides = ${payload.augmented_design_css_additions ?? ""},
            updated_at = NOW()
        WHERE id = ${report_id}::uuid
      `;
    } catch (err) {
      console.warn("[render-pdf-bg] failed to persist document_css:", err.message);
    }

    const duration = Date.now() - tStart;
    console.log(`[render-pdf-bg] ${job_id} done in ${duration}ms — ${Math.round(pdfBuffer.length / 1024)}KB, ${thumbnails.length} thumbnails`);

    await postCallback(hub_callback_url, hub_callback_secret, {
      job_id,
      status: "done",
      pdf_url: pdfUrl,
      thumbnails: thumbnails.length > 0 ? thumbnails : null,
      duration_ms: duration,
      size_bytes: pdfBuffer.length,
      pages_count: payload.pages.length,
    });

    return new Response("ok", { status: 202 });
  } catch (err) {
    return fail(err?.message ?? String(err));
  }
}
