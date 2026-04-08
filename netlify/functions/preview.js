/**
 * GET /.netlify/functions/preview
 *
 * Legacy mode:
 *   ?id=<document_id>&key=<preview_key>
 *
 * V4 page mode:
 *   ?manifest_id=<manifest_id>&page=<page_number>&key=<preview_key>
 *   ?manifest_id=<manifest_id>&key=<preview_key> (all generated pages)
 */
import { createHmac } from "node:crypto";
import { getSql } from "./db.js";

function previewKey(subject) {
  const secret = process.env.PREVIEW_SECRET || process.env.HUB_JWT_PUBLIC_KEY_PEM || "report-ai-preview";
  return createHmac("sha256", secret).update(String(subject)).digest("hex").slice(0, 16);
}

export { previewKey };

function getPreviewSubject(params = {}) {
  if (params.id) return String(params.id);
  if (params.manifest_id) {
    const page = params.page || params.page_number || "all";
    return `${params.manifest_id}:${page}`;
  }
  return null;
}

function buildPrintBanner(title) {
  return `
<div id="report-ai-banner" style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a2b5c;color:white;padding:10px 20px;font-family:system-ui,sans-serif;font-size:14px;display:flex;justify-content:space-between;align-items:center;print-color-adjust:exact;">
  <span><strong>Report AI Preview</strong> — ${escapeHtml(title)}</span>
  <div>
    <button onclick="document.getElementById('report-ai-banner').style.display='none';window.print()" style="background:white;color:#1a2b5c;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-weight:600;font-size:14px;">Skriv ut / Spara som PDF</button>
    <button onclick="document.getElementById('report-ai-banner').style.display='none'" style="background:transparent;color:white;border:1px solid rgba(255,255,255,0.3);padding:8px 16px;border-radius:4px;cursor:pointer;margin-left:8px;font-size:14px;">Dölj</button>
  </div>
</div>
<style>@media print{#report-ai-banner{display:none!important}body{padding-top:0!important}}</style>`;
}

function injectBanner(html, title) {
  const banner = buildPrintBanner(title);
  if (html.includes("<body")) {
    return html.replace(/(<body[^>]*>)/i, `$1\n${banner}`);
  }
  return banner + html;
}

function wrapManifestPages(pages = []) {
  const body = pages
    .map((entry, index) => {
      const pageBreak = index === 0 ? "page-break-before:auto;" : "page-break-before:always;";
      return `<section data-page="${entry.page_number}" style="${pageBreak}">${entry.html_output || ""}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4; margin: 0; }
    body { margin: 0; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

async function fetchDocumentHtml(sql, id) {
  const rows = await sql`
    SELECT html_output, title
    FROM documents
    WHERE id = ${id} AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!rows[0] || !rows[0].html_output) return null;

  return {
    title: rows[0].title || "Document",
    html: rows[0].html_output,
  };
}

async function fetchManifestHtml(sql, manifestId, pageNumber) {
  if (Number.isFinite(pageNumber)) {
    const rows = await sql`
      SELECT rp.page_number, rgp.html_output
      FROM report_pages rp
      JOIN report_generated_pages rgp ON rgp.page_id = rp.id
      WHERE rp.manifest_id = ${manifestId}::uuid
        AND rp.page_number = ${pageNumber}
      LIMIT 1
    `;

    if (!rows[0] || !rows[0].html_output) return null;

    return {
      title: `Manifest ${manifestId} — page ${pageNumber}`,
      html: rows[0].html_output,
    };
  }

  const rows = await sql`
    SELECT rp.page_number, rgp.html_output
    FROM report_pages rp
    JOIN report_generated_pages rgp ON rgp.page_id = rp.id
    WHERE rp.manifest_id = ${manifestId}::uuid
    ORDER BY rp.page_number ASC
  `;

  if (rows.length === 0) return null;

  return {
    title: `Manifest ${manifestId}`,
    html: wrapManifestPages(rows),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders() };
  }

  const params = event.queryStringParameters || {};
  const key = params.key;
  const subject = getPreviewSubject(params);

  if (!subject || !key) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html" },
      body: "<h1>400 — Missing id/manifest_id or key parameter</h1>",
    };
  }

  if (key !== previewKey(subject)) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "text/html" },
      body: "<h1>403 — Invalid preview key</h1>",
    };
  }

  const format = params.format || "html";

  try {
    const sql = getSql();

    if (format === "pdf") {
      if (!params.id) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "text/html" },
          body: "<h1>400 — PDF download via preview is only supported for document previews</h1>",
        };
      }

      let pdfRows;
      try {
        pdfRows = await sql`SELECT pdf_output, title FROM documents WHERE id = ${params.id} AND deleted_at IS NULL LIMIT 1`;
      } catch {
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

      return {
        statusCode: 404,
        headers: { "Content-Type": "text/html" },
        body: "<h1>404 — PDF not generated yet</h1>",
      };
    }

    // Binary export formats: IDML, DOCX, PPTX
    const binaryFormats = {
      idml: { column: "idml_output", contentType: "application/octet-stream", ext: ".idml" },
      docx: { column: "docx_output", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
      pptx: { column: "pptx_output", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
    };

    if (binaryFormats[format]) {
      const fmt = binaryFormats[format];
      if (!params.id) {
        return { statusCode: 400, headers: { "Content-Type": "text/html" }, body: `<h1>400 — ${format.toUpperCase()} download requires a document id</h1>` };
      }

      let rows;
      try {
        rows = await sql`SELECT ${sql.unsafe(fmt.column)}, title FROM documents WHERE id = ${params.id} AND deleted_at IS NULL LIMIT 1`;
      } catch {
        rows = [];
      }

      const output = rows[0]?.[fmt.column];
      if (output) {
        const filename = (rows[0].title || "document").replace(/[^a-zA-Z0-9åäöÅÄÖ _-]/g, "") + fmt.ext;
        return {
          statusCode: 200,
          headers: {
            "Content-Type": fmt.contentType,
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "private, max-age=300",
          },
          body: Buffer.from(output).toString("base64"),
          isBase64Encoded: true,
        };
      }

      return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: `<h1>404 — ${format.toUpperCase()} not generated yet</h1>` };
    }

    let resolved;
    if (params.id) {
      resolved = await fetchDocumentHtml(sql, params.id);
    } else {
      const pageRaw = params.page || params.page_number;
      const pageNumber = pageRaw != null ? Number.parseInt(pageRaw, 10) : undefined;
      resolved = await fetchManifestHtml(sql, params.manifest_id, Number.isNaN(pageNumber) ? undefined : pageNumber);
    }

    if (!resolved) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "text/html" },
        body: "<h1>404 — Preview content not found</h1>",
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, max-age=60" },
      body: injectBanner(resolved.html, resolved.title),
    };
  } catch (e) {
    console.error("[preview] Error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html" },
      body: `<h1>500</h1><p>${escapeHtml(e.message)}</p>`,
    };
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
