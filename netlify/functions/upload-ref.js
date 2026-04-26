import { getStore, connectLambda } from "@netlify/blobs";
import { randomBytes, createHmac } from "node:crypto";

/**
 * Temporary reference file upload.
 *
 * GET  /upload-ref?token=xxx  → Upload page (simple drag-and-drop)
 * POST /upload-ref?token=xxx  → Receive file, store in Blobs
 * GET  /upload-ref?token=xxx&check=1 → Check if file has been uploaded
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Resolve a Netlify Blobs store. The bare getStore() call requires Lambda
// context which is set up automatically for Netlify Functions v2 — but
// only after a fetch-style event arrives. POSTs from the upload page have
// to fall back to explicit siteID + API token env vars since the Functions
// v2 wrapper doesn't always inject Lambda context for Web Request handlers.
function getBlobStore(req) {
  try {
    // The 1st-gen Netlify Functions plugin injects Lambda context onto
    // process.env / globals; getStore() picks it up. For Web Request handlers
    // (default async (req) =>), we can sometimes pass the Request object's
    // Netlify-specific event body. Try the bare path first.
    return getStore({ name: "upload-refs", consistency: "strong" });
  } catch {
    // Fall back to explicit credentials.
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !token) {
      throw new Error(
        "Blob store unreachable: bare getStore() failed and NETLIFY_SITE_ID / NETLIFY_API_TOKEN env vars are not set. Configure them in the Netlify site settings."
      );
    }
    return getStore({ name: "upload-refs", siteID, token, consistency: "strong" });
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (!token || token.length < 16) {
    return new Response("Missing or invalid token", { status: 400, headers: CORS });
  }

  const store = getBlobStore();

  // --- Check if uploaded ---
  if (req.method === "GET" && url.searchParams.get("check") === "1") {
    try {
      const meta = await store.getMetadata(`${token}/file`);
      if (meta?.metadata) {
        return Response.json({
          uploaded: true,
          filename: meta.metadata.filename,
          mime_type: meta.metadata.mimeType,
          size: parseInt(meta.metadata.size || "0"),
          uploaded_at: meta.metadata.uploadedAt,
        }, { headers: CORS });
      }
    } catch {
      // not found
    }
    return Response.json({ uploaded: false }, { headers: CORS });
  }

  // --- Upload page ---
  if (req.method === "GET") {
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const html = uploadPageHtml(token, siteUrl);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
    });
  }

  // --- Receive upload (chunked or single-shot) ──────────────────────────
  // Netlify Functions cap synchronous request bodies at ~6 MB. Reference
  // brand books often exceed that, so we accept multi-part chunked
  // uploads. The client splits the file into ≤ 4 MB chunks and POSTs
  // each chunk individually with chunk_index / total_chunks; the final
  // chunk triggers concatenation of all chunks into the canonical
  // `${token}/file` blob. Single-shot uploads (small files, no chunking)
  // continue to work — they're treated as a 1-of-1 chunked upload.
  if (req.method === "POST") {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json({ error: "Expected multipart/form-data" }, { status: 400, headers: CORS });
    }

    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return Response.json({ error: "No file provided" }, { status: 400, headers: CORS });
    }

    const chunkIndex = parseInt(formData.get("chunk_index") ?? "0", 10);
    const totalChunks = parseInt(formData.get("total_chunks") ?? "1", 10);
    if (!Number.isFinite(chunkIndex) || !Number.isFinite(totalChunks)
        || chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks) {
      return Response.json({ error: "Invalid chunk_index / total_chunks" }, { status: 400, headers: CORS });
    }

    const chunkBuffer = Buffer.from(await file.arrayBuffer());
    if (chunkBuffer.length > 5 * 1024 * 1024) {
      return Response.json({
        error: `Chunk too large (${chunkBuffer.length} bytes). Use chunks ≤ 4 MB to stay under the function body limit.`,
      }, { status: 413, headers: CORS });
    }

    const filename = formData.get("filename") || file.name;
    const mimeType = formData.get("mime_type") || file.type || "application/octet-stream";

    // Single-shot path: 1 chunk → write straight to the canonical blob.
    if (totalChunks === 1) {
      await store.set(`${token}/file`, chunkBuffer, {
        metadata: {
          filename,
          mimeType,
          size: String(chunkBuffer.length),
          uploadedAt: new Date().toISOString(),
        },
      });
      return Response.json({
        ok: true,
        filename,
        size: chunkBuffer.length,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        finalized: true,
        token,
      }, { headers: CORS });
    }

    // Chunked path: write the chunk under a per-index key.
    const chunkKey = `${token}/chunks/${String(chunkIndex).padStart(4, "0")}`;
    await store.set(chunkKey, chunkBuffer, {
      metadata: { size: String(chunkBuffer.length) },
    });

    // If this isn't the final chunk, return progress and wait for more.
    if (chunkIndex + 1 < totalChunks) {
      return Response.json({
        ok: true,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        finalized: false,
      }, { headers: CORS });
    }

    // Final chunk arrived — concatenate all chunks into the canonical blob.
    const parts = [];
    let totalSize = 0;
    for (let i = 0; i < totalChunks; i++) {
      const key = `${token}/chunks/${String(i).padStart(4, "0")}`;
      const buf = await store.get(key, { type: "arrayBuffer" });
      if (!buf) {
        return Response.json({
          error: `Missing chunk ${i}/${totalChunks}. Restart the upload.`,
        }, { status: 400, headers: CORS });
      }
      const part = Buffer.from(buf);
      parts.push(part);
      totalSize += part.length;
    }
    const fullBuffer = Buffer.concat(parts, totalSize);

    if (fullBuffer.length > 50 * 1024 * 1024) {
      return Response.json({ error: "File too large (max 50 MB)" }, { status: 413, headers: CORS });
    }

    await store.set(`${token}/file`, fullBuffer, {
      metadata: {
        filename,
        mimeType,
        size: String(fullBuffer.length),
        uploadedAt: new Date().toISOString(),
      },
    });

    // Best-effort cleanup of chunk blobs (don't fail the response if they
    // can't be deleted; the canonical file is what downstream consumers
    // read).
    for (let i = 0; i < totalChunks; i++) {
      const key = `${token}/chunks/${String(i).padStart(4, "0")}`;
      await store.delete(key).catch(() => {});
    }

    return Response.json({
      ok: true,
      filename,
      size: fullBuffer.length,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      finalized: true,
      token,
    }, { headers: CORS });
  }

  return new Response("Method not allowed", { status: 405, headers: CORS });
};

/** Generate a signed upload token */
export function createUploadToken() {
  const id = randomBytes(16).toString("hex");
  const expires = Date.now() + 30 * 60 * 1000; // 30 min
  const secret = process.env.SESSION_SECRET || process.env.HMAC_SECRET || "dev";
  const sig = createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex").slice(0, 16);
  return { token: `${id}_${expires}_${sig}`, id, expires };
}

/** Verify token hasn't expired or been tampered with */
export function verifyUploadToken(token) {
  const parts = token.split("_");
  if (parts.length !== 3) return false;
  const [id, expiresStr, sig] = parts;
  const expires = parseInt(expiresStr);
  if (isNaN(expires) || Date.now() > expires) return false;
  const secret = process.env.SESSION_SECRET || process.env.HMAC_SECRET || "dev";
  const expected = createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex").slice(0, 16);
  return sig === expected;
}

function uploadPageHtml(token, siteUrl) {
  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ladda upp referensdokument</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Avenir Next", system-ui, sans-serif;
    background: #f7f3f5;
    color: #2a1f2a;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(126,68,90,0.08);
    padding: 40px;
    max-width: 480px;
    width: 100%;
    text-align: center;
  }
  h1 { font-size: 20px; margin-bottom: 8px; }
  .hint { font-size: 14px; color: #675f68; margin-bottom: 24px; line-height: 1.5; }
  .dropzone {
    border: 2px dashed #ddc5d1;
    border-radius: 12px;
    padding: 40px 20px;
    cursor: pointer;
    transition: all .2s;
    margin-bottom: 16px;
  }
  .dropzone:hover, .dropzone.drag { border-color: #a64f67; background: #fdf0f4; }
  .dropzone .icon { font-size: 32px; margin-bottom: 8px; }
  .dropzone p { font-size: 14px; color: #675f68; }
  .status { font-size: 14px; padding: 12px; border-radius: 8px; display: none; }
  .status.ok { display: block; background: #e8f5e9; color: #2e7b58; }
  .status.err { display: block; background: #fce4ec; color: #a13f5a; }
  .status.wait { display: block; background: #fff3e0; color: #99650d; }
  input[type="file"] { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>Ladda upp referensdokument</h1>
  <p class="hint">PDF:en analyseras direkt av servern. Inga bilder skickas till Claude — bara strukturerad data om färger, typsnitt och layout. Gå tillbaka till Claude.ai när uppladdningen är klar.</p>

  <div class="dropzone" id="dropzone">
    <div class="icon">&#128196;</div>
    <p>Dra in PDF eller klicka</p>
  </div>
  <input type="file" id="fileInput" accept=".pdf,application/pdf,.png,.jpg,.jpeg,.svg,image/*">
  <div class="status" id="status"></div>
</div>

<script>
const TOKEN = "${token}";
const UPLOAD_URL = "${siteUrl}/upload-ref?token=" + TOKEN;

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const status = document.getElementById("status");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  if (e.dataTransfer.files.length) upload(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files.length) upload(fileInput.files[0]); });

// 4 MB per chunk — keeps each request comfortably under Netlify's
// ~6 MB function body limit while minimising round-trip overhead.
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

async function upload(file) {
  if (file.size > MAX_FILE_SIZE) {
    status.className = "status err";
    status.textContent = "Filen &auml;r f&ouml;r stor (" + (file.size / 1024 / 1024).toFixed(1) + " MB, max 50 MB).";
    return;
  }

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  status.className = "status wait";
  status.textContent = "Laddar upp " + file.name + " (" + (file.size / 1024 / 1024).toFixed(1) + " MB)...";

  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const blob = file.slice(start, end);

      const form = new FormData();
      form.append("file", new File([blob], file.name, { type: file.type }));
      form.append("chunk_index", String(i));
      form.append("total_chunks", String(totalChunks));
      form.append("filename", file.name);
      form.append("mime_type", file.type || "application/octet-stream");

      const resp = await fetch(UPLOAD_URL, { method: "POST", body: form });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || ("Chunk " + (i + 1) + "/" + totalChunks + " misslyckades (HTTP " + resp.status + ")"));

      status.textContent = "Laddar upp del " + (i + 1) + " av " + totalChunks + "...";
    }

    status.className = "status ok";
    status.innerHTML = "<strong>" + file.name + "</strong> uppladdad. G&aring; tillbaka till Claude.ai och s&auml;g att du &auml;r klar.";
    dropzone.style.display = "none";
  } catch (err) {
    status.className = "status err";
    status.textContent = err.message;
  }
}
</script>
</body>
</html>`;
}
