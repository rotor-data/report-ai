/**
 * GET /api/unsplash-search?q=<query>
 *
 * Thin proxy to the Unsplash Search API so the browser never sees the
 * access key. Returns { results: [{ id, urls, alt_description, user }] }.
 *
 * Requires env var UNSPLASH_ACCESS_KEY. If missing the endpoint returns
 * an empty result set + a warning — the editor gracefully falls back to
 * "search disabled" messaging so the picker still works for upload +
 * library tabs.
 */
import { json } from "./cors.js";
import { requireHubOrEditorAuth } from "./auth-middleware.js";

const UNSPLASH_ENDPOINT = "https://api.unsplash.com/search/photos";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(event, 204, null);
  if (event.httpMethod !== "GET") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const q = (event.queryStringParameters || {}).q || "";
  if (q.trim().length < 2) return json(event, 400, { error: "q must be ≥ 2 chars" });

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    // Graceful degradation — the editor's dialog shows the "needs config"
    // hint rather than crashing.
    return json(event, 200, {
      results: [],
      warning: "UNSPLASH_ACCESS_KEY not configured — image search disabled.",
    });
  }

  try {
    const url = `${UNSPLASH_ENDPOINT}?query=${encodeURIComponent(q)}&per_page=24&orientation=landscape`;
    // Unsplash can be slow from Netlify's us-east edge (cold-start +
    // transatlantic hop). Try up to twice before giving up.
    let res;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(url, {
          headers: {
            Authorization: `Client-ID ${key}`,
            "Accept-Version": "v1",
          },
          signal: AbortSignal.timeout(18_000),
        });
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!res) {
      return json(event, 504, {
        error: `Unsplash timeout: ${lastErr?.message || "no response"}`,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return json(event, 502, { error: `Unsplash ${res.status}: ${text.slice(0, 200)}` });
    }
    // Useful rate-limit diagnostics
    const remaining = res.headers.get("x-ratelimit-remaining");
    const total = res.headers.get("x-ratelimit-limit");
    const data = await res.json();
    // Keep only the fields the picker actually needs — smaller payload,
    // less surface for the access-key to leak through debugging.
    const results = (data?.results || []).map((hit) => ({
      id: hit.id,
      alt_description: hit.alt_description,
      urls: {
        thumb: hit.urls?.thumb,
        small: hit.urls?.small,
        regular: hit.urls?.regular,
      },
      user: hit.user ? { name: hit.user.name, username: hit.user.username } : null,
      links: hit.links ? { html: hit.links.html } : null,
    }));
    return json(event, 200, {
      results,
      rate_limit: remaining && total ? { remaining: Number(remaining), total: Number(total) } : undefined,
    });
  } catch (err) {
    return json(event, 500, { error: err?.message || String(err) });
  }
};
