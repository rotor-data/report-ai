/**
 * Module Renderers — XML → HTML compilation
 *
 * Each module type has a fixed XML schema and a renderer that compiles
 * the structured data into HTML using design_system CSS variables.
 *
 * Claude sends structured XML/JSON per module → server renders to HTML.
 * This eliminates Claude improvising HTML and ensures consistent output.
 */

// ─── Helpers ───────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNumber(val) {
  if (val == null) return "";
  const n = Number(val);
  if (isNaN(n)) return esc(String(val));
  return n.toLocaleString("sv-SE");
}

function renderMarkdown(text) {
  if (!text) return "";
  // Minimal markdown: **bold**, *italic*, line breaks
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");
}

function wrapParagraphs(text) {
  if (!text) return "";
  const parts = String(text).split(/\n\n+/);
  return parts.map(p => `<p>${renderMarkdown(p.trim())}</p>`).join("\n    ");
}

// ─── Module Schemas ────────────────────────────────────────────────────────

/**
 * Schema definitions per module type.
 * Used for documentation/validation — tells Claude exactly what to provide.
 */
export const MODULE_SCHEMAS = {
  cover: {
    description: "Full-bleed cover page with title, subtitle, date and optional logo",
    fields: {
      title: { type: "string", required: true, description: "Main document title" },
      subtitle: { type: "string", description: "Subtitle or document type label" },
      date: { type: "string", description: "Date or period, e.g. 'Q1 2026' or 'Årsredovisning 2025'" },
      author: { type: "string", description: "Company name or author" },
      background_color: { type: "string", description: "Override cover background (hex). Defaults to primary color." },
    },
  },

  chapter_break: {
    description: "Section divider with chapter number and title",
    fields: {
      chapter_number: { type: "number", description: "Chapter number (displayed large)" },
      title: { type: "string", required: true, description: "Chapter title" },
      subtitle: { type: "string", description: "Optional chapter subtitle" },
    },
  },

  text_spread: {
    description: "Narrative text — CEO letters, summaries, analysis. Flows naturally across pages.",
    fields: {
      heading: { type: "string", description: "Section heading (h2)" },
      body: { type: "string", required: true, description: "Body text. Use \\n\\n for paragraph breaks. Supports **bold** and *italic*." },
      aside: { type: "object", description: "Optional pull quote or sidebar", fields: {
        text: { type: "string", required: true },
        attribution: { type: "string" },
      }},
    },
  },

  kpi_grid: {
    description: "2-6 KPI cards showing key metrics with optional trend indicators",
    fields: {
      heading: { type: "string", description: "Optional section heading" },
      kpis: { type: "array", required: true, description: "Array of KPI objects", items: {
        label: { type: "string", required: true, description: "KPI name, e.g. 'Omsättning'" },
        value: { type: "string", required: true, description: "Formatted value, e.g. '142'" },
        unit: { type: "string", description: "Unit label, e.g. 'MSEK', '%'" },
        change: { type: "string", description: "Change indicator, e.g. '+12%', '-3%'" },
      }},
    },
  },

  table: {
    description: "Data table with headers and rows. Numbers are right-aligned automatically.",
    fields: {
      heading: { type: "string", description: "Table heading" },
      caption: { type: "string", description: "Table caption/source note" },
      columns: { type: "array", required: true, description: "Column definitions", items: {
        header: { type: "string", required: true },
        align: { type: "string", description: "'left' (default) or 'right' (for numbers)" },
      }},
      rows: { type: "array", required: true, description: "Array of row arrays. Each row has one value per column." },
      total_row: { type: "array", description: "Optional total/summary row (rendered bold with top border)" },
    },
  },

  quote_callout: {
    description: "Pull quote or testimonial with attribution",
    fields: {
      quote: { type: "string", required: true, description: "The quote text" },
      attribution: { type: "string", description: "Who said it" },
      role: { type: "string", description: "Title/role of the person" },
    },
  },

  image_text: {
    description: "50/50 split with image placeholder and text",
    fields: {
      heading: { type: "string", description: "Section heading" },
      body: { type: "string", required: true, description: "Body text for the text side" },
      image_alt: { type: "string", description: "Description of what the image should show" },
      image_position: { type: "string", description: "'left' (default) or 'right'" },
    },
  },

  data_chart: {
    description: "Chart with data. Server renders SVG from structured data.",
    fields: {
      title: { type: "string", description: "Chart title" },
      caption: { type: "string", description: "Chart caption/source" },
      chart_type: { type: "string", required: true, description: "'bar', 'line', or 'pie'" },
      series: { type: "array", required: true, description: "Data points", items: {
        label: { type: "string", required: true },
        value: { type: "number", required: true },
      }},
      x_label: { type: "string", description: "X-axis label" },
      y_label: { type: "string", description: "Y-axis label" },
    },
  },

  two_col_text: {
    description: "Two-column text layout for balanced content",
    fields: {
      heading: { type: "string", description: "Section heading (spans both columns)" },
      body: { type: "string", required: true, description: "Text content. CSS column-count splits it automatically. Use \\n\\n for paragraphs." },
    },
  },

  financial_summary: {
    description: "Hero numbers prominently displayed with supporting detail table",
    fields: {
      heading: { type: "string", description: "Section heading" },
      hero_numbers: { type: "array", required: true, description: "1-4 hero metrics displayed large", items: {
        label: { type: "string", required: true },
        value: { type: "string", required: true },
        unit: { type: "string" },
      }},
      table: { type: "object", description: "Optional supporting table (same schema as table module)", fields: {
        columns: { type: "array" },
        rows: { type: "array" },
        total_row: { type: "array" },
      }},
    },
  },

  back_cover: {
    description: "Back cover with company info, contact details and disclaimers",
    fields: {
      company_name: { type: "string", required: true },
      tagline: { type: "string", description: "Company tagline or slogan" },
      address: { type: "string" },
      phone: { type: "string" },
      email: { type: "string" },
      website: { type: "string" },
      disclaimer: { type: "string", description: "Legal disclaimer text" },
    },
  },
};

// ─── Module Renderers ──────────────────────────────────────────────────────

const renderers = {
  cover(data, moduleId) {
    const bg = data.background_color ? `background: ${esc(data.background_color)};` : "";
    return `<section class="module module-cover" data-module-id="${esc(moduleId)}"${bg ? ` style="${bg}"` : ""}>
  <div class="content-frame">
    ${data.subtitle ? `<p style="font-size: 13pt; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.8; margin-bottom: var(--spacing-base);">${esc(data.subtitle)}</p>` : ""}
    <h1>${esc(data.title)}</h1>
    ${data.date ? `<p style="font-size: 16pt; margin-top: var(--spacing-base); opacity: 0.9;">${esc(data.date)}</p>` : ""}
    ${data.author ? `<p style="font-size: 10pt; margin-top: var(--spacing-section); opacity: 0.7;">${esc(data.author)}</p>` : ""}
  </div>
</section>`;
  },

  chapter_break(data, moduleId) {
    return `<section class="module module-chapter-break" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    ${data.chapter_number != null ? `<div class="chapter-number">${esc(String(data.chapter_number))}</div>` : ""}
    <h2>${esc(data.title)}</h2>
    ${data.subtitle ? `<p style="font-size: 13pt; color: var(--color-text-light); margin-top: var(--spacing-base);">${esc(data.subtitle)}</p>` : ""}
  </div>
</section>`;
  },

  text_spread(data, moduleId) {
    const aside = data.aside ? `
    <blockquote>
      ${esc(data.aside.text)}
      ${data.aside.attribution ? `<cite>— ${esc(data.aside.attribution)}</cite>` : ""}
    </blockquote>` : "";
    return `<section class="module module-text-spread" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    ${data.heading ? `<h2>${esc(data.heading)}</h2>` : ""}
    ${wrapParagraphs(data.body)}${aside}
  </div>
</section>`;
  },

  kpi_grid(data, moduleId) {
    const kpis = (data.kpis || []).map(k => {
      const changeClass = k.change?.startsWith("+") ? "positive" : k.change?.startsWith("-") ? "negative" : "";
      return `    <div class="kpi-card">
      <div class="kpi-value">${esc(k.value)}${k.unit ? `<span style="font-size: 14pt; font-weight: 400; margin-left: 2mm;">${esc(k.unit)}</span>` : ""}</div>
      <div class="kpi-label">${esc(k.label)}</div>
      ${k.change ? `<div class="kpi-delta ${changeClass}">${esc(k.change)}</div>` : ""}
    </div>`;
    }).join("\n");

    return `<section class="module module-kpi-grid" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    ${data.heading ? `<h2 style="grid-column: 1 / -1; margin-bottom: var(--spacing-base);">${esc(data.heading)}</h2>` : ""}
${kpis}
  </div>
</section>`;
  },

  table(data, moduleId) {
    const cols = data.columns || [];
    const thead = cols.map(c =>
      `<th${c.align === "right" ? ` class="number"` : ""}>${esc(c.header)}</th>`
    ).join("");

    const rows = (data.rows || []).map(row => {
      const cells = row.map((val, i) => {
        const align = cols[i]?.align === "right" ? ` class="number"` : "";
        return `<td${align}>${esc(String(val ?? ""))}</td>`;
      }).join("");
      return `      <tr>${cells}</tr>`;
    }).join("\n");

    const totalRow = data.total_row ? `      <tr class="total">${data.total_row.map((val, i) => {
      const align = cols[i]?.align === "right" ? ` class="number"` : "";
      return `<td${align}>${esc(String(val ?? ""))}</td>`;
    }).join("")}</tr>` : "";

    return `<section class="module module-table" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    ${data.heading ? `<h2>${esc(data.heading)}</h2>` : ""}
    <table>
      <thead><tr>${thead}</tr></thead>
      <tbody>
${rows}
${totalRow}
      </tbody>
    </table>
    ${data.caption ? `<p style="font-size: 8pt; color: var(--color-text-light); margin-top: 2mm;">${esc(data.caption)}</p>` : ""}
  </div>
</section>`;
  },

  quote_callout(data, moduleId) {
    return `<section class="module module-quote-callout" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    <blockquote>
      ${esc(data.quote)}
      ${data.attribution || data.role ? `<cite>— ${esc(data.attribution || "")}${data.role ? `, ${esc(data.role)}` : ""}</cite>` : ""}
    </blockquote>
  </div>
</section>`;
  },

  image_text(data, moduleId) {
    const imgFirst = data.image_position !== "right";
    const imageHtml = `<div class="image-placeholder">${esc(data.image_alt || "Bild")}</div>`;
    const textHtml = `<div>
      ${data.heading ? `<h2>${esc(data.heading)}</h2>` : ""}
      ${wrapParagraphs(data.body)}
    </div>`;

    return `<section class="module module-image-text" data-module-id="${esc(moduleId)}">
  <div class="content-frame" style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-col-gap); align-items: start;">
    ${imgFirst ? imageHtml : textHtml}
    ${imgFirst ? textHtml : imageHtml}
  </div>
</section>`;
  },

  data_chart(data, moduleId) {
    const svg = renderChartSvg(data);
    return `<section class="module module-data-chart" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    ${data.title ? `<h2>${esc(data.title)}</h2>` : ""}
    <figure class="chart">
      ${svg}
      ${data.caption ? `<figcaption>${esc(data.caption)}</figcaption>` : ""}
    </figure>
  </div>
</section>`;
  },

  two_col_text(data, moduleId) {
    return `<section class="module module-two-col-text" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    ${data.heading ? `<h2 style="column-span: all;">${esc(data.heading)}</h2>` : ""}
    ${wrapParagraphs(data.body)}
  </div>
</section>`;
  },

  financial_summary(data, moduleId) {
    const heroes = (data.hero_numbers || []).map(h =>
      `    <div class="kpi-card">
      <div class="kpi-value">${esc(h.value)}${h.unit ? `<span style="font-size: 14pt; font-weight: 400; margin-left: 2mm;">${esc(h.unit)}</span>` : ""}</div>
      <div class="kpi-label">${esc(h.label)}</div>
    </div>`
    ).join("\n");

    let tableHtml = "";
    if (data.table?.columns && data.table?.rows) {
      const cols = data.table.columns;
      const thead = cols.map(c => `<th${c.align === "right" ? ` class="number"` : ""}>${esc(c.header)}</th>`).join("");
      const tbody = data.table.rows.map(row => {
        const cells = row.map((v, i) => `<td${cols[i]?.align === "right" ? ` class="number"` : ""}>${esc(String(v ?? ""))}</td>`).join("");
        return `<tr>${cells}</tr>`;
      }).join("\n        ");
      const totalRow = data.table.total_row ? `<tr class="total">${data.table.total_row.map((v, i) => `<td${cols[i]?.align === "right" ? ` class="number"` : ""}>${esc(String(v ?? ""))}</td>`).join("")}</tr>` : "";
      tableHtml = `
    <table style="margin-top: var(--spacing-section);">
      <thead><tr>${thead}</tr></thead>
      <tbody>
        ${tbody}
        ${totalRow}
      </tbody>
    </table>`;
    }

    return `<section class="module module-financial-summary" data-module-id="${esc(moduleId)}">
  <div class="content-frame">
    ${data.heading ? `<h2>${esc(data.heading)}</h2>` : ""}
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(60mm, 1fr)); gap: var(--spacing-base);">
${heroes}
    </div>${tableHtml}
  </div>
</section>`;
  },

  back_cover(data, moduleId) {
    return `<section class="module module-back-cover" data-module-id="${esc(moduleId)}">
  <div class="content-frame" style="text-align: center;">
    <h2 style="font-size: 20pt;">${esc(data.company_name)}</h2>
    ${data.tagline ? `<p style="font-size: 13pt; color: var(--color-text-light); margin-bottom: var(--spacing-section);">${esc(data.tagline)}</p>` : ""}
    <div style="font-size: 9pt; color: var(--color-text-light); line-height: 1.8;">
      ${data.address ? `<p>${esc(data.address)}</p>` : ""}
      ${data.phone ? `<p>${esc(data.phone)}</p>` : ""}
      ${data.email ? `<p>${esc(data.email)}</p>` : ""}
      ${data.website ? `<p>${esc(data.website)}</p>` : ""}
    </div>
    ${data.disclaimer ? `<p style="font-size: 7pt; color: var(--color-text-light); margin-top: var(--spacing-section); max-width: 130mm; margin-left: auto; margin-right: auto;">${esc(data.disclaimer)}</p>` : ""}
  </div>
</section>`;
  },
};

// ─── Chart SVG Renderer ────────────────────────────────────────────────────

function renderChartSvg(data) {
  const series = data.series || [];
  if (series.length === 0) return `<svg viewBox="0 0 400 200"><text x="200" y="100" text-anchor="middle" fill="var(--color-text-light)">Ingen data</text></svg>`;

  const maxVal = Math.max(...series.map(s => s.value), 1);
  const w = 400, h = 200, pad = 40;

  if (data.chart_type === "pie") {
    return renderPieSvg(series, w, h);
  }

  if (data.chart_type === "line") {
    return renderLineSvg(series, w, h, pad, maxVal);
  }

  // Default: bar chart
  return renderBarSvg(series, w, h, pad, maxVal);
}

function renderBarSvg(series, w, h, pad, maxVal) {
  const barW = Math.min(40, (w - 2 * pad) / series.length - 8);
  const chartH = h - 2 * pad;
  const bars = series.map((s, i) => {
    const barH = (s.value / maxVal) * chartH;
    const x = pad + i * ((w - 2 * pad) / series.length) + ((w - 2 * pad) / series.length - barW) / 2;
    const y = h - pad - barH;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="var(--color-primary)" rx="2"/>
    <text x="${x + barW / 2}" y="${h - pad + 14}" text-anchor="middle" font-size="8" fill="var(--color-text-light)">${esc(s.label)}</text>
    <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="8" fill="var(--color-text)">${formatNumber(s.value)}</text>`;
  }).join("\n  ");

  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--color-surface)" stroke-width="1"/>
  ${bars}
</svg>`;
}

function renderLineSvg(series, w, h, pad, maxVal) {
  const chartH = h - 2 * pad;
  const stepX = (w - 2 * pad) / Math.max(series.length - 1, 1);
  const points = series.map((s, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (s.value / maxVal) * chartH;
    return `${x},${y}`;
  });

  const dots = series.map((s, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (s.value / maxVal) * chartH;
    return `<circle cx="${x}" cy="${y}" r="3" fill="var(--color-primary)"/>
    <text x="${x}" y="${h - pad + 14}" text-anchor="middle" font-size="8" fill="var(--color-text-light)">${esc(s.label)}</text>`;
  }).join("\n  ");

  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--color-surface)" stroke-width="1"/>
  <polyline points="${points.join(" ")}" fill="none" stroke="var(--color-primary)" stroke-width="2"/>
  ${dots}
</svg>`;
}

function renderPieSvg(series, w, h) {
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 30;
  const total = series.reduce((sum, s) => sum + s.value, 0) || 1;
  const colors = [
    "var(--color-primary)", "var(--color-secondary)", "var(--color-accent)",
    "var(--color-surface)", "var(--color-text-light)", "var(--color-bg-alt)",
  ];

  let startAngle = -Math.PI / 2;
  const slices = series.map((s, i) => {
    const angle = (s.value / total) * Math.PI * 2;
    const endAngle = startAngle + angle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const color = colors[i % colors.length];
    const path = `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z" fill="${color}"/>`;
    // Label
    const midAngle = startAngle + angle / 2;
    const lx = cx + (r + 16) * Math.cos(midAngle);
    const ly = cy + (r + 16) * Math.sin(midAngle);
    const label = `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="7" fill="var(--color-text-light)">${esc(s.label)}</text>`;
    startAngle = endAngle;
    return path + "\n  " + label;
  }).join("\n  ");

  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  ${slices}
</svg>`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Render a module from structured content data to an HTML fragment.
 *
 * @param {string} moduleType - One of the MODULE_TYPES
 * @param {object} content - Structured content matching the module schema
 * @param {string} moduleId - Module ID for data-module-id attribute
 * @returns {{ ok: boolean, html: string, error?: string }}
 */
export function renderModule(moduleType, content, moduleId) {
  const renderer = renderers[moduleType];
  if (!renderer) {
    return { ok: false, html: "", error: `Unknown module type: ${moduleType}` };
  }

  try {
    const html = renderer(content || {}, moduleId || "unknown");
    return { ok: true, html };
  } catch (err) {
    return { ok: false, html: "", error: `Render error for ${moduleType}: ${err.message}` };
  }
}

/**
 * Get the schema description for a module type (for tool descriptions).
 */
export function getModuleSchema(moduleType) {
  return MODULE_SCHEMAS[moduleType] || null;
}

/**
 * Build a compact schema reference string for use in tool descriptions.
 */
export function buildSchemaReference() {
  const lines = Object.entries(MODULE_SCHEMAS).map(([type, schema]) => {
    const fields = Object.entries(schema.fields)
      .map(([name, f]) => {
        const req = f.required ? " (required)" : "";
        if (f.type === "array" && f.items) {
          const itemFields = Object.entries(f.items).map(([k, v]) => `${k}: ${v.type}`).join(", ");
          return `  ${name}${req}: [{${itemFields}}]`;
        }
        if (f.type === "object" && f.fields) {
          const subFields = Object.entries(f.fields).map(([k, v]) => `${k}: ${v.type}`).join(", ");
          return `  ${name}${req}: {${subFields}}`;
        }
        return `  ${name}${req}: ${f.type}`;
      }).join("\n");
    return `**${type}** — ${schema.description}\n${fields}`;
  });
  return lines.join("\n\n");
}
