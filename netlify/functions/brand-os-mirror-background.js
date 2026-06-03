/**
 * POST /.netlify/functions/brand-os-mirror-background
 *
 * Netlify Background Function. Mirrors a report-ai brand_tokens write
 * out to brand-os' /v1/brand/visual endpoint, OUTSIDE the foreground
 * Lambda's lifecycle. Previously this fan-out was done via
 * `Promise.resolve().then(() => fetch(...))` inside
 * `handleSaveBrandTokens` in mcp-v2.js — but Netlify's default
 * `callbackWaitsForEmptyEventLoop=true` meant the foreground Lambda
 * was pinned waiting for the brand-os HTTP round-trip even though the
 * MCP response had already been written. That regressed cold-start
 * concurrency under load.
 *
 * Trigger body:
 *   {
 *     tenant_id: string (UUID),
 *     brand_id:  string (UUID),
 *     colors:    { [token]: hex_string }  // non-empty
 *   }
 *
 * Auth: shared-secret header `x-internal-trigger-secret` matching env
 * `INTERNAL_TRIGGER_SECRET`. If the env is not set the function refuses
 * to run (fail-closed: no anonymous brand mutations from the open web).
 *
 * Background functions are fire-and-forget; we never return a useful
 * status to the caller. All outcomes are logged.
 */

const BRAND_OS_BASE_URL = process.env.BRAND_OS_BASE_URL || "https://rotor-brand-os.netlify.app";

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const expectedSecret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!expectedSecret) {
    console.warn("[brand-os-mirror-bg] INTERNAL_TRIGGER_SECRET not configured — refusing to run");
    return new Response("not configured", { status: 503 });
  }
  const providedSecret = req.headers.get("x-internal-trigger-secret") || "";
  if (providedSecret !== expectedSecret) {
    console.warn("[brand-os-mirror-bg] bad secret");
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const { tenant_id, brand_id, colors } = body || {};
  if (!tenant_id || !brand_id || !colors || typeof colors !== "object") {
    console.warn("[brand-os-mirror-bg] missing fields:", { tenant_id: !!tenant_id, brand_id: !!brand_id, colors: !!colors });
    return new Response("bad request", { status: 400 });
  }
  if (Object.keys(colors).length === 0) {
    // Nothing to mirror; not an error.
    return new Response("noop", { status: 202 });
  }

  const platformKey = process.env.BRAND_OS_PLATFORM_API_KEY;
  if (!platformKey) {
    console.warn("[brand-os-mirror-bg] BRAND_OS_PLATFORM_API_KEY not configured, skipping mirror-write");
    return new Response("not configured", { status: 202 });
  }

  try {
    const res = await fetch(`${BRAND_OS_BASE_URL}/v1/brand/visual`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${platformKey}`,
        "X-Tenant-Id": tenant_id,
      },
      body: JSON.stringify({ brand_id, colors }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[brand-os-mirror-bg] non-ok ${res.status}: ${txt.slice(0, 200)}`);
    } else {
      console.log(`[brand-os-mirror-bg] mirrored brand ${brand_id} (${Object.keys(colors).length} colors)`);
    }
  } catch (e) {
    console.warn(`[brand-os-mirror-bg] error: ${e?.message || e}`);
  }

  return new Response("ok", { status: 202 });
}
