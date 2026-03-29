/**
 * GET /.netlify/functions/preview?id=<document_id>&key=<preview_key>
 *
 * Serves the stored HTML for a document as a viewable page.
 * The preview key is an HMAC of the document ID — no extra DB column needed.
 * Open in Chrome → Cmd/Ctrl+P → Save as PDF for print-quality output.
 */
import { createHmac } from "node:crypto";
import { getSql } from "./db.js";

function previewKey(documentId) {
  const secret = process.env.PREVIEW_SECRET || process.env.HUB_JWT_PUBLIC_KEY_PEM || "report-ai-preview";
  return createHmac("sha256", secret).update(documentId).digest("hex").slice(0, 16);
}

// Exported so mcp.js can generate preview URLs
export { previewKey };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }

  const params = event.queryStringParameters || {};
  const id = params.id;
  const key = params.key;

  if (!id || !key) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html" },
      body: "<h1>400 — Missing id or key parameter</h1>",
    };
  }

  if (key !== previewKey(id)) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "text/html" },
      body: "<h1>403 — Invalid preview key</h1>",
    };
  }

  const format = params.format || "html";

  try {
    const sql = getSql();

    // PDF download
    if (format === "pdf") {
      let pdfRows;
      try {
        pdfRows = await sql`SELECT pdf_output, title FROM documents WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
      } catch {
        // pdf_output column might not exist
        pdfRows = [];
      }
      if (pdfRows[0]?.pdf_output) {
        const filename = (pdfRows[0].title || "document").replace(/[^a-zA-Z0-9åäöÅÄÖ _-]/g, "") + ".pdf";
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "private, max-age=300",
          },
          body: Buffer.from(pdfRows[0].pdf_output).toString("base64"),
          isBase64Encoded: true,
        };
      }
      return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: "<h1>404 — PDF not generated yet</h1>" };
    }

    // HTML preview
    const rows = await sql`SELECT html_output, title FROM documents WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
    if (!rows[0] || !rows[0].html_output) {
      return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: "<h1>404 — Document not found or has no HTML</h1>" };
    }

    const printBanner = `
<div id="report-ai-banner" style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a2b5c;color:white;padding:10px 20px;font-family:system-ui,sans-serif;font-size:14px;display:flex;justify-content:space-between;align-items:center;print-color-adjust:exact;">
  <span><strong>Report AI Preview</strong> — ${escapeHtml(rows[0].title)}</span>
  <div>
    <button onclick="document.getElementById('report-ai-banner').style.display='none';window.print()" style="background:white;color:#1a2b5c;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px;">Skriv ut / Spara som PDF</button>
    <button onclick="document.getElementById('report-ai-banner').style.display='none'" style="background:transparent;color:white;border:1px solid rgba(255,255,255,0.3);padding:8px 16px;border-radius:4px;cursor:pointer;margin-left:8px;font-size:14px;">Dölj</button>
  </div>
</div>
<style>@media print{#report-ai-banner{display:none!important}body{padding-top:0!important}}</style>`;

    let html = rows[0].html_output;
    if (html.includes("<body")) {
      html = html.replace(/(<body[^>]*>)/i, `$1\n${printBanner}`);
    } else {
      html = printBanner + html;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, max-age=60" },
      body: html,
    };
  } catch (e) {
    console.error("[preview] Error:", e);
    return { statusCode: 500, headers: { "Content-Type": "text/html" }, body: `<h1>500</h1><p>${escapeHtml(e.message)}</p>` };
  }
};

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
