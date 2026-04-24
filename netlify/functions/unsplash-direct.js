/**
 * GET /api/unsplash-direct?q=<query>&w=<width>&h=<height>&orientation=<landscape|portrait|squarish>
 *
 * Single-call Unsplash resolver for Claude-generated report HTML.
 * Returns a 302 redirect to the Unsplash CDN URL of the first search
 * hit for `q` at the requested dimensions. Designed to be embedded
 * directly as `<img src="/api/unsplash-direct?q=team-meeting&w=1200&h=800">`
 * in freeform HTML — WeasyPrint follows the redirect at render time.
 *
 * Caching strategy:
 *   1. Blob cache `unsplash-cache/<sha256(q|w|h|orient)>.json` stores
 *      the picked photo_id + url the first time we resolve a query.
 *   2. Subsequent requests skip the Unsplash API call entirely and
 *      redirect straight to the cached CDN URL. Same seed → same
 *      image → deterministic PDFs.
 *   3. Unsplash rate-limit (50 req/h on free plan) is effectively
 *      unused after the first pass through a report's images.
 *
 * Attribution:
 *   Unsplash API guidelines ask for a trigger-download call on use.
 *   We fire it once per cache miss (fire-and-forget) so the photo's
 *   download counter stays honest. Not blocking on it — if the call
 *   fails, the redirect still goes through.
 *
 * NO auth on this endpoint — it's meant to be fetched by WeasyPrint
 * (no headers) and by browsers rendering the editor. The query
 * surface is small (read-only search), so abuse risk is low. If we
 * ever need to protect it, add a signed-token query param.
 *
 * Env: UNSPLASH_ACCESS_KEY (required for cache misses; cache hits
 * continue to work without it).
 */
import { createHash } from "node:crypto";

const UNSPLASH_SEARCH = "https://api.unsplash.com/search/photos";

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

function normaliseOrientation(w, h, explicit) {
  if (explicit && ["landscape", "portrait", "squarish"].includes(explicit)) return explicit;
  if (!w || !h) return "landscape";
  const ratio = w / h;
  if (ratio > 1.25) return "landscape";
  if (ratio < 0.85) return "portrait";
  return "squarish";
}

function clampDim(v, def, max = 3000) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.round(n), max);
}

function redirect(location, maxAge = 86400) {
  return {
    statusCode: 302,
    headers: {
      Location: location,
      "Cache-Control": `public, max-age=${maxAge}`,
      "Access-Control-Allow-Origin": "*",
    },
    body: "",
  };
}

function errorImage(message, status = 502) {
  // Return a tiny transparent PNG rather than 4xx/5xx — prevents
  // WeasyPrint from aborting the whole page render when a single
  // placeholder can't be resolved. 1x1 transparent PNG is 68 bytes.
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
    "base64"
  );
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "image/png",
      "X-Unsplash-Direct-Error": message.slice(0, 120),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: tinyPng.toString("base64"),
    isBase64Encoded: true,
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const params = event.queryStringParameters || {};
  const q = (params.q || "").trim();
  if (q.length < 2) return errorImage("q must be ≥ 2 chars", 400);

  const w = clampDim(params.w, 1200);
  const h = clampDim(params.h, 800);
  const orientation = normaliseOrientation(w, h, params.orientation);

  const cacheHash = createHash("sha256")
    .update([q.toLowerCase(), w, h, orientation].join("|"))
    .digest("hex").slice(0, 16);
  const cacheKey = `unsplash-cache/${cacheHash}.json`;

  // ── 1. Cache hit → 302 to cached CDN URL ─────────────────────────────────
  let store;
  try { store = await getBlobStore("report-ai-assets", event); } catch { /* continue without cache */ }

  if (store) {
    try {
      const cached = await store.get(cacheKey, { type: "json" });
      if (cached?.photo_url) {
        return redirect(cached.photo_url);
      }
    } catch { /* cache miss or parse error — fall through */ }
  }

  // ── 2. Cache miss → Unsplash search for one photo ────────────────────────
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return errorImage("UNSPLASH_ACCESS_KEY not configured", 503);

  let photo;
  try {
    const searchUrl = `${UNSPLASH_SEARCH}?query=${encodeURIComponent(q)}&per_page=1&orientation=${orientation}`;
    const res = await fetch(searchUrl, {
      headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return errorImage(`Unsplash ${res.status}: ${text.slice(0, 80)}`);
    }
    const data = await res.json();
    photo = data?.results?.[0];
  } catch (err) {
    return errorImage(`Unsplash fetch failed: ${err?.message || err}`);
  }

  if (!photo?.urls?.raw) {
    return errorImage(`no results for "${q}"`, 404);
  }

  // Build a sized URL from the raw endpoint — &w=&h=&fit=crop lets
  // Unsplash re-encode at the exact dimensions we want, no post-
  // processing on our side needed.
  const photoUrl = `${photo.urls.raw}&w=${w}&h=${h}&fit=crop&auto=format&q=80`;

  // ── 3. Write cache (fire-and-forget) ─────────────────────────────────────
  if (store) {
    store.setJSON(cacheKey, {
      photo_id: photo.id,
      photo_url: photoUrl,
      query: q,
      w, h, orientation,
      cached_at: new Date().toISOString(),
      source: photo.links?.html,
      photographer: photo.user?.name,
    }).catch((err) => console.warn("[unsplash-direct] cache write failed:", err?.message || err));
  }

  // ── 4. Trigger download (Unsplash guideline; fire-and-forget) ────────────
  if (photo.links?.download_location) {
    fetch(photo.links.download_location, {
      headers: { Authorization: `Client-ID ${key}` },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => { /* non-fatal */ });
  }

  return redirect(photoUrl);
};
