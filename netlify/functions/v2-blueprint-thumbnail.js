/**
 * GET /api/v2-blueprint-thumbnail?key=<blob_key>
 *
 * Public endpoint that serves a blueprint thumbnail PNG from the
 * "report-ai-blueprint-thumbs" Netlify Blob store. No auth — URLs
 * are embedded in MCP tool responses so Claude.ai can render them
 * inline in chat, and those clients don't carry our JWT.
 *
 * Keys are generated server-side in v2-blueprints.js and include
 * the blueprint id + timestamp, so they're unguessable enough for
 * the "inline in chat preview" threat model. If we ever need to
 * gate by tenant, migrate keys to include a capability token.
 */
import { noContent, json } from "./cors.js";

async function getBlobStore(event) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (event) connectLambda(event);
    return getStore("report-ai-blueprint-thumbs");
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: "report-ai-blueprint-thumbs", siteID, token });
    throw new Error(`Cannot access blob store "report-ai-blueprint-thumbs"`);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "GET") return json(event, 405, { error: "Method Not Allowed" });

  const key = event.queryStringParameters?.key;
  if (!key) return json(event, 400, { error: "Missing ?key=" });
  // Defensive: reject path traversal + absolute keys.
  if (key.includes("..") || key.startsWith("/")) {
    return json(event, 400, { error: "Invalid key" });
  }

  try {
    const store = await getBlobStore(event);
    const buf = await store.get(key, { type: "arrayBuffer" });
    if (!buf) return json(event, 404, { error: "Not found" });

    const bytes = Buffer.from(buf);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.length),
        // Aggressive caching — the key includes a timestamp, so any
        // change to the thumbnail produces a new URL. Immutable is safe.
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
      body: bytes.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("[v2-blueprint-thumbnail]", err);
    return json(event, 500, { error: err.message });
  }
};
