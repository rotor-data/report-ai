import { z } from "zod";
import { PDFDocument } from "pdf-lib";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const schema = z.object({
  document_id: z.string().uuid().optional(),
  manifest_id: z.string().uuid().optional(),
}).refine((data) => Boolean(data.document_id) !== Boolean(data.manifest_id), {
  message: "Provide exactly one of document_id or manifest_id",
});

function ensureHtmlDocument(html = "") {
  if (/<html[\s>]/i.test(html)) return html;
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
${html}
</body>
</html>`;
}

async function launchBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

async function renderHtmlToPdfBuffer(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setContent(ensureHtmlDocument(html), { waitUntil: "networkidle0", timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

export async function mergeManifestPdf(manifestId, hubUserId) {
  const sql = getSql();

  const rows = await sql`
    SELECT rp.page_number, rgp.html_output
    FROM report_pages rp
    JOIN report_generated_pages rgp ON rgp.page_id = rp.id
    JOIN report_manifests rm ON rm.id = rp.manifest_id
    WHERE rp.manifest_id = ${manifestId}::uuid
      AND rm.hub_user_id = ${hubUserId}
    ORDER BY rp.page_number ASC
  `;

  if (rows.length === 0) {
    throw new Error("No generated pages found for manifest");
  }

  const browser = await launchBrowser();

  try {
    const mergedPdf = await PDFDocument.create();

    for (const row of rows) {
      const pagePdfBuffer = await renderHtmlToPdfBuffer(browser, row.html_output || "");
      const pagePdfDoc = await PDFDocument.load(pagePdfBuffer);
      const copiedPages = await mergedPdf.copyPages(pagePdfDoc, pagePdfDoc.getPageIndices());
      for (const copiedPage of copiedPages) {
        mergedPdf.addPage(copiedPage);
      }
    }

    const mergedBytes = await mergedPdf.save();
    return {
      pdfBuffer: Buffer.from(mergedBytes),
      pageCount: rows.length,
    };
  } finally {
    await browser.close();
  }
}

async function renderDocumentPdf(documentId, hubUserId) {
  const sql = getSql();
  const rows = await sql`
    SELECT html_output
    FROM documents
    WHERE id = ${documentId} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;

  const doc = rows[0];
  if (!doc?.html_output) throw new Error("Document has no HTML output");

  const browser = await launchBrowser();
  try {
    const pdfBuffer = await renderHtmlToPdfBuffer(browser, doc.html_output);
    return { pdfBuffer };
  } finally {
    await browser.close();
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(event, 400, { error: "Invalid JSON" });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

  try {
    if (parsed.data.manifest_id) {
      const merged = await mergeManifestPdf(parsed.data.manifest_id, auth.hubUserId);
      return json(event, 200, {
        ok: true,
        manifest_id: parsed.data.manifest_id,
        page_count: merged.pageCount,
        pdf_base64: merged.pdfBuffer.toString("base64"),
      });
    }

    const rendered = await renderDocumentPdf(parsed.data.document_id, auth.hubUserId);
    return json(event, 200, {
      ok: true,
      document_id: parsed.data.document_id,
      pdf_base64: rendered.pdfBuffer.toString("base64"),
    });
  } catch (e) {
    return json(event, 500, {
      error: "Local PDF export failed",
      details: e?.message || "Unknown error",
    });
  }
};
