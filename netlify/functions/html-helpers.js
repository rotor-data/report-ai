// Extracted rendering helpers — used by save_html MCP tool and frontend preview fallback.

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatTableValue(value, column) {
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

export function renderTableModule(module) {
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
    ${data.caption ? `<p class="table-caption">${escapeHtml(data.caption)}</p>` : ""}
    ${data.notes ? `<p class="table-notes">${escapeHtml(data.notes)}</p>` : ""}
  </section>`;
}

export function renderModule(module) {
  if (module.module_type === "table") return renderTableModule(module);
  const content = module.content ? `<p>${escapeHtml(module.content)}</p>` : '<div class="stub-box">Innehåll saknas</div>';
  return `<section class="module ${escapeHtml(module.module_type)}"><h2>${escapeHtml(module.title ?? module.module_type)}</h2>${content}</section>`;
}

export function fontFaceCss(fonts) {
  return fonts
    .map((font) => {
      const src = String(font.blob_key || "").startsWith("http") ? font.blob_key : "";
      if (!src) return "";
      return `@font-face { font-family: '${escapeHtml(font.family_name)}'; src: url('${escapeHtml(src)}') format('${escapeHtml(font.format)}'); font-style: ${escapeHtml(font.style || "normal")}; font-weight: ${escapeHtml(font.weight || "400")}; }`;
    })
    .join("\n");
}

export function renderFallbackHtml(document, fonts = []) {
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
