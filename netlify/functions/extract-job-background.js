/**
 * POST /.netlify/functions/extract-job-background
 *
 * Netlify Background Function (15-min budget) for the slow design-extraction
 * ops that exceed the ~10s Claude.ai client timeout when run inline in
 * mcp-v2.js. Fas 3-async. Mirrors the existing background-function pattern
 * (blueprint-cover-background.js / render-freeform-pdf-background.js):
 * shared-secret trigger → do the slow work → write the result back to the
 * job row (here: report-ai's own `extract_jobs` table, NOT the hub's
 * render_jobs).
 *
 * Trigger body:
 *   { job_id: string }   // extract_jobs.id; all inputs live on the row
 *
 * Auth: shared-secret header `x-internal-trigger-secret` matching env
 * `INTERNAL_TRIGGER_SECRET` (same secret report-ai already uses to fire its
 * own background functions from mcp-v2.js). Fail-closed when env is unset.
 *
 * job_type dispatch (extract_jobs.job_type):
 *   'rasterize_upload' — PDF → per-page PNG (+ optional pre-analysis), cache
 *                        each PNG in blob store, store {pages,...} in result.
 *   'extract_design'   — /render/analyze-pdf, store the raw analysis in
 *                        result (mcp-v2's poll handler wraps it into the
 *                        Layer-2 meta-program — that assembly is cheap).
 *
 * NEVER throw out of the handler — background functions have no retry
 * semantics. Catch everything and record it on the job row so the poll
 * tool surfaces an actionable error. Errors use the same canonical contract
 * the foreground tools use (stored shape is just {message}; the poll handler
 * re-wraps via toolError).
 */
import { randomUUID, createHash, createHmac } from "node:crypto";
import { getSql } from "./db.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";

const RENDER_SERVICE_URL =
  process.env.SMYRA_RENDER_URL ||
  process.env.RENDER_SERVICE_URL ||
  "https://smyra-render-178695091452.europe-north1.run.app";

// ─── Duplicated helpers (BG-fn convention: duplicate, don't import from the
//     mcp-v2 function entrypoint — esbuild bundles each entrypoint separately) ─

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

// Mirror of mcp-v2.js _verifyUploadTokenInline — keep byte-identical.
function verifyUploadToken(token) {
  if (typeof token !== "string") return false;
  const parts = token.split("_");
  if (parts.length !== 3) return false;
  const [id, expiresStr, sig] = parts;
  const expires = parseInt(expiresStr);
  if (isNaN(expires) || Date.now() > expires) return false;
  const secret = process.env.SESSION_SECRET || process.env.HMAC_SECRET || "dev";
  const expected = createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex").slice(0, 16);
  return sig === expected;
}

async function resolvePdfBase64(input, event) {
  // Returns { base64 } or { error } — never throws on caller-fixable input.
  if (input.pdf_base64) return { base64: input.pdf_base64 };
  if (input.upload_token) {
    if (!verifyUploadToken(input.upload_token)) {
      return { error: "Upload token is invalid or expired." };
    }
    const store = await getBlobStore("upload-refs", event);
    const fileData = await store.get(`${input.upload_token}/file`, { type: "arrayBuffer" });
    if (!fileData) {
      return { error: "No file found for this upload token. Ask the user to upload the file first." };
    }
    return { base64: Buffer.from(fileData).toString("base64") };
  }
  return { error: "Provide upload_token or pdf_base64." };
}

// ─── job_type: rasterize_upload ─────────────────────────────────────────────
// Mirrors handleRasterizeUpload in mcp-v2.js (same caps + blob caching), but
// runs off the foreground budget and stores {pages,...} in extract_jobs.result.

async function runRasterizeUpload(sql, job, event) {
  const input = job.input || {};
  const tenantId = job.tenant_id || job.user_id || "system";

  const resolved = await resolvePdfBase64(input, event);
  if (resolved.error) throw new Error(resolved.error);
  const pdfBytesBase64 = resolved.base64;

  // HARD CAPS identical to the synchronous handler (Lambda 6MB body + 60s).
  const MAX_SAMPLE_COUNT = 12;
  const MAX_DPI = 72;
  const requestedDpi = typeof input.dpi === "number" && input.dpi > 0 ? input.dpi : 50;
  const requestedSampleCount = typeof input.max_pages === "number" && input.max_pages > 0 ? input.max_pages : 6;
  const effectiveDpi = Math.min(requestedDpi, MAX_DPI);
  const sampleCount = Math.min(requestedSampleCount, MAX_SAMPLE_COUNT);

  const raster = await callRenderService("/render/rasterize", {
    pdf_base64: pdfBytesBase64,
    dpi: effectiveDpi,
    sample_count: sampleCount,
    format: "jpeg",
    quality: 40,
    include_pre_analysis: !!input.include_pre_analysis,
  }, tenantId);

  const rasterPages = Array.isArray(raster?.pages) ? raster.pages : [];
  if (rasterPages.length === 0) {
    throw new Error("Render service returned no pages. PDF may be malformed.");
  }

  const assetStore = await getBlobStore("report-ai-assets", event);
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const sessionId = randomUUID();

  const pages = [];
  for (const rp of rasterPages) {
    if (typeof rp?.page !== "number" || typeof rp?.png_base64 !== "string") continue;
    const imgBuffer = Buffer.from(rp.png_base64, "base64");
    const mimeType = rp.mime_type || "image/jpeg";
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const hash = createHash("sha256").update(imgBuffer).digest("hex").slice(0, 12);
    const blobKey = `reference-rasters/${sessionId}/${hash}-p${rp.page}.${ext}`;
    await assetStore.set(blobKey, imgBuffer, { contentType: mimeType });
    pages.push({
      page_num: rp.page,
      png_base64: rp.png_base64,
      mime_type: mimeType,
      url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`,
      width: rp.width,
      height: rp.height,
      height_mm: rp.height_mm,
      ...(rp.pre_analysis ? { pre_analysis: rp.pre_analysis } : {}),
    });
  }

  return {
    pages,
    page_count: pages.length,
    total_pages_in_pdf: rasterPages.length,
    truncated: false,
    dpi: effectiveDpi,
  };
}

// ─── job_type: extract_design ───────────────────────────────────────────────
// The slow part is /render/analyze-pdf. We store the raw analysis; the poll
// handler in mcp-v2.js wraps it into the Layer-2 meta-program (cheap, pure).

async function runExtractDesign(sql, job, event) {
  const input = job.input || {};
  const brandId = input.brand_id;
  if (!brandId) throw new Error("brand_id is required.");

  const brands = await sql`SELECT tenant_id FROM brands WHERE id = ${brandId} LIMIT 1`;
  if (!brands.length) throw new Error(`Brand ${brandId} not found.`);
  const tenantId = brands[0].tenant_id;

  const analyzePayload = {};
  if (input.source_url) {
    analyzePayload.source_url = input.source_url;
  } else {
    const resolved = await resolvePdfBase64(input, event);
    if (resolved.error) throw new Error(resolved.error);
    analyzePayload.pdf_base64 = resolved.base64;
  }
  if (input.pages) analyzePayload.pages = input.pages;

  const pdfAnalysis = await callRenderService("/render/analyze-pdf", analyzePayload, tenantId);

  // Store only what the poll handler needs to assemble the meta-program.
  return { brand_id: brandId, pdf_analysis: pdfAnalysis };
}

// ─── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req) {
  const tStart = Date.now();
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const expectedSecret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!expectedSecret) {
    console.warn("[extract-job-bg] INTERNAL_TRIGGER_SECRET not configured — refusing to run");
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
  const jobId = body?.job_id;
  if (!jobId) return new Response("missing job_id", { status: 400 });

  const sql = getSql();

  // Load + claim the job (idempotent across fire-and-forget retries).
  let job;
  try {
    const rows = await sql`
      SELECT id, job_type, status, user_id, tenant_id, input, attempts
      FROM extract_jobs WHERE id = ${jobId} LIMIT 1
    `;
    job = rows[0];
  } catch (err) {
    console.error("[extract-job-bg] load failed:", err?.message || err);
    return new Response("db error", { status: 202 });
  }
  if (!job) {
    console.warn("[extract-job-bg] job not found", jobId);
    return new Response("not found", { status: 404 });
  }
  if (job.status === "done") return new Response("already done", { status: 202 });
  if (job.status === "failed" && job.attempts >= 3) return new Response("gave up", { status: 202 });

  await sql`
    UPDATE extract_jobs
    SET status = 'running', started_at = NOW(), attempts = attempts + 1, error_message = NULL
    WHERE id = ${jobId}
  `;

  try {
    let result;
    if (job.job_type === "rasterize_upload") {
      result = await runRasterizeUpload(sql, job, req);
    } else if (job.job_type === "extract_design") {
      result = await runExtractDesign(sql, job, req);
    } else {
      throw new Error(`Unknown job_type: ${job.job_type}`);
    }

    const duration = Date.now() - tStart;
    await sql`
      UPDATE extract_jobs
      SET status = 'done', result = ${JSON.stringify(result)}::jsonb,
          finished_at = NOW(), duration_ms = ${duration}, error_message = NULL
      WHERE id = ${jobId}
    `;
    console.log(`[extract-job-bg] ${jobId} (${job.job_type}) done in ${duration}ms`);
    return new Response("ok", { status: 202 });
  } catch (err) {
    const duration = Date.now() - tStart;
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    try {
      await sql`
        UPDATE extract_jobs
        SET status = 'failed', error_message = ${msg}, finished_at = NOW(), duration_ms = ${duration}
        WHERE id = ${jobId}
      `;
    } catch (e2) {
      console.error("[extract-job-bg] markFailed failed:", e2?.message || e2);
    }
    console.error(`[extract-job-bg] ${jobId} (${job.job_type}) failed:`, msg);
    return new Response("failed", { status: 202 });
  }
}
