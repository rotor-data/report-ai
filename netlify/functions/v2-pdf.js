/**
 * GET /api/v2-pdf?key=<blob_key>
 *
 * Serves a PDF from the "report-ai-pdfs" Netlify Blob store.
 * The blob_key contains tenant + report UUIDs, which act as unguessable
 * capability tokens — good enough for draft preview links. For production
 * finals we can add HMAC-signed short-lived URLs.
 */
import { noContent, json } from "./cors.js";

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

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "GET") return json(event, 405, { error: "Method Not Allowed" });

  const key = event.queryStringParameters?.key;
  if (!key) return json(event, 400, { error: "Missing ?key=" });

  // Basic path hygiene
  if (key.includes("..") || key.startsWith("/")) {
    return json(event, 400, { error: "Invalid key" });
  }

  try {
    const store = await getBlobStore("report-ai-pdfs", event);
    const buf = await store.get(key, { type: "arrayBuffer" });
    if (!buf) return json(event, 404, { error: "Not found" });

    const bytes = Buffer.from(buf);
    const filename = key.split("/").pop() || "report.pdf";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
      body: bytes.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("[v2-pdf]", err);
    return json(event, 500, { error: err.message });
  }
};
