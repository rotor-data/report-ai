/**
 * GET /api/v2-pdf?key=<blob_key>
 *
 * Serves a PDF from the "report-ai-pdfs" Netlify Blob store.
 *
 * Implementation: Netlify Functions v2 native Web Request handler with
 * a streamed Response body. The previous v1 base64-body handler was
 * capped at 6 MB (Lambda response payload cap) — rich freeform reports
 * with image-led pages routinely exceeded that and crashed with
 * `Function.ResponseSizeTooLarge`. v2 streaming has no such cap.
 */
async function resolveBlobStore(storeName, req) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (typeof connectLambda === "function" && req) {
      try { connectLambda(req); } catch { /* not a lambda req — fall through */ }
    }
    return getStore(storeName);
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: storeName, siteID, token });
    throw new Error(`Cannot access blob store "${storeName}"`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return new Response(JSON.stringify({ error: "Missing ?key=" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
  if (key.includes("..") || key.startsWith("/")) {
    return new Response(JSON.stringify({ error: "Invalid key" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  try {
    const store = await resolveBlobStore("report-ai-pdfs", req);
    // type:"stream" returns a ReadableStream → Response body streams
    // bytes through without ever materialising the full PDF in memory
    // or hitting Lambda's 6 MB response cap.
    const stream = await store.get(key, { type: "stream" });
    if (!stream) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    // Detect content-type + disposition from the file extension. Default
    // to inline-PDF preview, but force attachment-download for .pptx so
    // browsers don't try to preview it via their PDF reader (which would
    // show binary garbage). Same proxy serves both PDF and pptx blobs.
    const filenameRaw = key.split("/").pop() || "report.pdf";
    const isPptx = /\.pptx$/i.test(filenameRaw);
    const contentType = isPptx
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "application/pdf";
    const disposition = isPptx
      ? `attachment; filename="${filenameRaw}"`
      : `inline; filename="${filenameRaw}"`;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": disposition,
        "Cache-Control": "private, max-age=300",
        ...CORS,
      },
    });
  } catch (err) {
    console.error("[v2-pdf]", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }
}

// Routing handled by netlify.toml's `/api/*` wildcard — no `config.path`
// here. Adding one would create a second route that'd race the wildcard.
