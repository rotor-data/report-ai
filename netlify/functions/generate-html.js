import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { GUARDRAILS_PROMPT, validateHtml } from "./guardrails.js";
import { checkRateLimit } from "./rate-limit.js";

const schema = z.object({
  document_id: z.string().uuid(),
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTableValue(value, column) {
  if (value == null || value === "") return "";

  const asNumber = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));

  if (column.type === "currency" && Number.isFinite(asNumber)) {
    return new Intl.NumberFormat("sv-SE", {
      style: "currency",
      currency: column.currency_code || "SEK",
      maximumFractionDigits: 0,
    }).format(asNumber);
  }

  if (column.type === "percent" && Number.isFinite(asNumber)) {
    return `${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 }).format(asNumber * 100)} %`;
  }

  if (column.type === "number" && Number.isFinite(asNumber)) {
    return new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 2 }).format(asNumber);
  }

  return String(value);
}

function renderTableModule(module) {
  const data = module.data || {};
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];

  if (!columns.length) {
    return `<section class="module table"><h2>${escapeHtml(module.title ?? "Tabell")}</h2><div class="stub-box">Tabell saknar kolumner</div></section>`;
  }

  const head = columns
    .map((col) => `<th style="text-align:${escapeHtml(col.align || (col.type === "text" ? "left" : "right"))}">${escapeHtml(col.header || col.id)}</th>`)
    .join("");

  const body = rows
    .map((row) => {
      const cells = columns
        .map((col) => {
          const raw = row?.cells?.[col.id];
          const text = formatTableValue(raw, col);
          const align = col.align || (col.type === "text" ? "left" : "right");
          return `<td style="text-align:${escapeHtml(align)}">${escapeHtml(text)}</td>`;
        })
        .join("");

      const className = row?.is_total ? " class=\"is-total\"" : "";
      return `<tr${className}>${cells}</tr>`;
    })
    .join("\n");

  return `<section class="module table">
    <h2>${escapeHtml(module.title ?? "Tabell")}</h2>
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${data.caption ? `<p class=\"table-caption\">${escapeHtml(data.caption)}</p>` : ""}
    ${data.notes ? `<p class=\"table-notes\">${escapeHtml(data.notes)}</p>` : ""}
  </section>`;
}

function renderModule(module) {
  if (module.module_type === "table") return renderTableModule(module);
  const content = module.content ? `<p>${escapeHtml(module.content)}</p>` : '<div class="stub-box">Innehåll saknas</div>';
  return `<section class="module ${escapeHtml(module.module_type)}"><h2>${escapeHtml(module.title ?? module.module_type)}</h2>${content}</section>`;
}

function fontFaceCss(fonts) {
  return fonts
    .map((font) => {
      const src = String(font.blob_key || "").startsWith("http") ? font.blob_key : "";
      if (!src) return "";
      return `@font-face { font-family: '${escapeHtml(font.family_name)}'; src: url('${escapeHtml(src)}') format('${escapeHtml(font.format)}'); font-style: ${escapeHtml(font.style || "normal")}; font-weight: ${escapeHtml(font.weight || "400")}; }`;
    })
    .join("\n");
}

function renderFallbackHtml(document, fonts) {
  const sections = (document.module_plan ?? []).map((m) => renderModule(m)).join("\n");
  const heading = document.design_system?.typography?.heading || "sans-serif";
  const body = document.design_system?.typography?.body || "serif";

  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4; margin: 15mm; }
    ${fontFaceCss(fonts)}
    body { font-family: '${escapeHtml(body)}', sans-serif; color: #111; }
    h1, h2, h3 { font-family: '${escapeHtml(heading)}', sans-serif; }
    .module { break-inside: avoid; margin-bottom: 12mm; }
    .cover { page-break-after: always; }
    .back_cover { page-break-before: always; }
    .stub-box { min-height: 24mm; border: 1px dashed #9aa; background: #f8fbfd; padding: 8mm; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; background: #e6eef5; }
    td, th { border: 1px solid #ccd8e0; padding: 3mm 2mm; font-size: 9pt; }
    .table-caption { font-size: 8.5pt; margin-top: 2mm; }
    .table-notes { font-size: 7.5pt; color: #4f5f6e; }
    .is-total td { font-weight: 700; }
  </style>
</head>
<body>
${sections}
</body>
</html>`;
}

async function generateWithClaude(document, fonts, issues = []) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return renderFallbackHtml(document, fonts);

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";

  const prompt = {
    design_system: document.design_system,
    module_plan: document.module_plan,
    fonts,
    issues,
  };

  const message = await client.messages.create({
    model,
    max_tokens: 6000,
    system: `${GUARDRAILS_PROMPT}\nReturn HTML only.`,
    messages: [{ role: "user", content: JSON.stringify(prompt) }],
  });

  const text = message.content?.find((part) => part.type === "text")?.text;
  return text || renderFallbackHtml(document, fonts);
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const rl = checkRateLimit({ route: "generate-html", hubUserId: auth.hubUserId, max: 6, windowMs: 60_000 });
  if (!rl.ok) return json(event, 429, { error: "Rate limit exceeded", retry_after_seconds: rl.retryAfterSeconds });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(event, 400, { error: "Invalid JSON" });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM documents
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;

  const doc = rows[0];
  if (!doc) return json(event, 404, { error: "Document not found" });

  const fonts = await sql`
    SELECT family_name, weight, style, format, blob_key
    FROM custom_fonts
    WHERE hub_user_id = ${auth.hubUserId}
    ORDER BY created_at DESC
  `;

  let html = await generateWithClaude(doc, fonts, []);
  let validation = validateHtml(html);

  if (!validation.valid) {
    html = await generateWithClaude(doc, fonts, validation.issues);
    validation = validateHtml(html);
  }

  await sql`
    UPDATE documents
    SET
      html_output = ${html},
      status = ${validation.valid ? "ready" : "error"}::doc_status,
      updated_at = NOW()
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
  `;

  return json(event, 200, {
    ok: validation.valid,
    html_output: html,
    warnings: validation.issues,
  });
};
