/**
 * POST /.netlify/functions/mcp — Report AI MCP endpoint
 *
 * JSON-RPC 2.0 server following the Rotor Platform module contract.
 * Auth: Hub JWT (RS256) in Authorization: Bearer header.
 *
 * Architecture:
 *   save_module_html  → saves HTML fragment per module (small payloads)
 *   assemble_document → server builds full HTML from fragments + design CSS
 *   export_pdf        → renders assembled HTML to PDF via local headless Chrome
 */
import { randomUUID } from "node:crypto";
import { readBearerToken, verifyHubJwt } from "./verify-hub-jwt.js";
import { getSql } from "./db.js";
import { getTemplate, mergeMissingStubs, getDefaultStubPlan } from "./document-type-templates.js";
import { GUARDRAILS_PROMPT, validateHtml } from "./guardrails.js";
import { previewKey } from "./preview.js";

// ─── JSON-RPC helpers ───────────────────────────────────────────────────────

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}
function rpcResult(id, result) {
  return jsonResponse(200, { jsonrpc: "2.0", result, id });
}
function rpcError(id, code, message) {
  return jsonResponse(200, { jsonrpc: "2.0", error: { code, message }, id });
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MODULE_TYPES = [
  "cover", "chapter_break", "kpi_grid", "text_spread", "table",
  "quote_callout", "image_text", "data_chart", "two_col_text",
  "financial_summary", "back_cover",
];

const MODULE_TYPE_DESCRIPTIONS = {
  cover: "Full-bleed cover page. Title, subtitle, date, logo. Always first. height: 297mm, no @page margins on :first.",
  chapter_break: "Section divider. Chapter number + title. height: 297mm. page-break-before: always.",
  text_spread: "Narrative text (CEO letter, summaries). Flows naturally across pages. Use proper paragraph spacing.",
  kpi_grid: "2-6 KPI cards in CSS grid. Each: large number (28-36pt), label (9pt), optional trend arrow.",
  table: "Data table. border-collapse, th with primary-color border, numbers right-aligned, .total bold.",
  quote_callout: "Pull quote / testimonial. Large text (24-32pt), attribution, accent color vertical rule.",
  image_text: "50/50 split — image placeholder + text. Image area gets colored placeholder box.",
  data_chart: "SVG chart placeholder with descriptive caption. Use inline SVG for line/bar/pie charts.",
  two_col_text: "Two-column layout. column-count: 2, column-gap, balanced heights.",
  financial_summary: "Hero numbers + supporting table. Revenue, EBITDA, margins prominently displayed.",
  back_cover: "Company info, disclaimers, contact. Always last. height: 297mm, flex-end layout.",
};

const DOCUMENT_TYPE_CATALOG = [
  { id: "annual_report", label: "Årsredovisning", description: "Komplett årsredovisning med VD-ord, nyckeltal, finansiell sammanfattning." },
  { id: "quarterly", label: "Kvartalsrapport", description: "Finansiell rapport med nyckeltal, resultat och utsikter." },
  { id: "sustainability_report", label: "Hållbarhetsrapport", description: "ESG-redovisning med miljö-, sociala och styrningsdata." },
  { id: "board_report", label: "Styrelserapport", description: "Beslutsunderlag med sammanfattning och beslutspunkter." },
  { id: "investor_update", label: "Investeraruppdatering", description: "Kort uppdatering med nyckeltal och finansiell utveckling." },
  { id: "pitch", label: "Pitch deck", description: "Visuellt presentations-dokument för investerare eller kunder." },
  { id: "proposal", label: "Offert / Förslag", description: "Formellt förslag med scope, tidsplan och prissättning." },
  { id: "sales_proposal", label: "Säljförslag", description: "Kommersiellt förslag med erbjudande och prislista." },
  { id: "case_study", label: "Kundcase", description: "Utmaning → lösning → resultat med mätbara KPI:er." },
  { id: "white_paper", label: "White paper", description: "Fördjupande rapport med research och analys." },
  { id: "project_report", label: "Projektrapport", description: "Status med milstolpar, risker och nästa steg." },
  { id: "brand_guide", label: "Brandguide", description: "Varumärkesmanual med logotyp, färger, typografi." },
  { id: "product_sheet", label: "Produktblad", description: "Kompakt produktpresentation med specifikationer." },
  { id: "newsletter", label: "Nyhetsbrev (print)", description: "Tryckt nyhetsbrev med artiklar och nyheter." },
  { id: "event_program", label: "Eventprogram", description: "Program med schema och talarinfo." },
  { id: "company_profile", label: "Företagspresentation", description: "Företagsöversikt med historia, team, nyckeltal." },
];

const DESIGN_SYSTEM_SCHEMA = {
  colors: { primary: "#1A2B5C", secondary: "#4A7C9E", accent: "#E8A838", text: "#1A1A1A", text_light: "#666666", bg: "#FFFFFF", bg_alt: "#F5F5F0", surface: "#E8E4DE" },
  typography: { heading_family: "Georgia, serif", body_family: "system-ui, sans-serif", heading_weight: "700", base_size_pt: 10.5, line_height: 1.5, scale: [42, 28, 20, 16, 13, 10.5, 9] },
  spacing: { base_mm: 5, section_gap_mm: 15, column_gap_mm: 8 },
  page: { size: "A4", margin_top_mm: 20, margin_bottom_mm: 25, margin_inner_mm: 25, margin_outer_mm: 20 },
};

const _MODULE_REF = Object.entries(MODULE_TYPE_DESCRIPTIONS)
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join("\n");

const WORKFLOW_PROMPT = `## Report AI — Modular Document Workflow

You are a professional document designer. You create InDesign-quality print documents using HTML + CSS Paged Media.

### CRITICAL RULES
- **NEVER invent brand colors, fonts, or tone.** ASK the user first.
- **NEVER generate content from thin air.** ASK the user to paste/describe their content.
- **ALWAYS speak the user's language** (Swedish if they write Swedish).
- **Ask ONE focused question at a time.**

---

### Step 0: Choose Document Type
Call get_template_info (without document_type) to see available types. Ask the user what they want. If they already specified, skip ahead.

### Step 1: Brand Extraction
Ask for: company name, website URL (call extract_brand_from_url), colors, fonts, tone.
If the user says "välj åt mig", pick a cohesive design and explain your choices.
Call create_document + save_design_system.

### Step 2: Content & Module Planning
ASK the user to PASTE their text/data. WAIT for it.
Map content to modules, present the plan, get confirmation.
Call save_module_plan.

### Step 3: HTML Generation — MODULE BY MODULE
**IMPORTANT: Generate HTML one module at a time using save_module_html.**
This avoids huge payloads and makes revisions fast (re-save only the changed module).

For each module in the plan, call save_module_html with:
- module_id (from the plan)
- html_fragment: a single <section class="module module-{type}"> element

After all modules are saved, call assemble_document to build the complete HTML.

### Step 4: PDF Export & Download
Call export_pdf to generate a PDF. Returns a download URL the user can save.
Also call get_preview_url for a browser preview if they want to inspect first.

---

## HTML Fragment Rules (for save_module_html)

Each fragment is ONE <section> element. Do NOT include <!DOCTYPE>, <html>, <head>, or <style> — those are added by assemble_document.

### CSS Class Pattern:
\`<section class="module module-{type}" data-module-id="{id}">\`

### Use CSS variables from the design system:
var(--color-primary), var(--font-heading), var(--spacing-base), etc.
NEVER hardcode colors or font names in fragments.

### Module-specific rules:
- **cover**: height: 297mm; full-bleed background; centered title. NO @page margins (handled by @page :first).
- **chapter_break**: height: 297mm; chapter number + title centered.
- **text_spread**: normal flow; paragraphs with margin-bottom: var(--spacing-base); proper heading hierarchy.
- **kpi_grid**: CSS grid; .kpi-card with large .kpi-value (28-36pt) + .kpi-label (9pt).
- **table**: full-width; border-collapse; th bottom-border in primary color; numbers right-aligned; .total row bold.
- **data_chart**: Use INLINE SVG for charts (line, bar, pie). NO <script> or JS. SVG viewBox="0 0 width height". Include axis labels, data points, legend in SVG. Add a <figcaption> below.
- **back_cover**: height: 297mm; content pushed to bottom with flex-end.

### Typography:
- h1: 42pt (cover only), h2: 28pt, h3: 20pt, body: var(--base-size), captions: 9pt
- Min font: 7pt

### Number formatting (sv-SE):
- Thousands: 1 234 567 (thin space)
- Decimals: comma (1 234,50)
- Currency: 48,2 MSEK
- Percent: 12,7 %

### FONTS — CRITICAL:
- Use Google Fonts via @import URL in the design system, e.g.: @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Playfair+Display:wght@700&display=swap');
- NEVER embed fonts as base64 data URLs — this bloats HTML to 900K+
- Fallback to system fonts: system-ui, -apple-system, sans-serif

### Page breaks:
- .module { page-break-after: always; } .module:last-child { page-break-after: auto; }
- NEVER set height on text_spread or flowing content modules — let them grow naturally
- ONLY set height: 297mm on cover, chapter_break, back_cover (full-page modules)
- Use page-break-inside: avoid on KPI cards, table rows, and quote blocks

### SVG Chart Example (line chart):
\`\`\`html
<figure class="chart">
  <svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
    <line x1="40" y1="180" x2="380" y2="180" stroke="var(--color-surface)" stroke-width="1"/>
    <line x1="40" y1="20" x2="40" y2="180" stroke="var(--color-surface)" stroke-width="1"/>
    <polyline points="40,160 120,120 200,140 280,80 360,40" fill="none" stroke="var(--color-primary)" stroke-width="2.5"/>
    <circle cx="40" cy="160" r="4" fill="var(--color-primary)"/>
    <circle cx="120" cy="120" r="4" fill="var(--color-primary)"/>
    <text x="40" y="195" font-size="8pt" fill="var(--color-text-light)">Q1</text>
    <text x="120" y="195" font-size="8pt" fill="var(--color-text-light)">Q2</text>
  </svg>
  <figcaption>Omsättning per kvartal, MSEK</figcaption>
</figure>
\`\`\`

---

## Revisions
When the user wants to change something:
1. Identify which module(s) need updating
2. Call save_module_html ONLY for the changed module(s)
3. Call assemble_document to rebuild
4. Call export_pdf for a new PDF

NEVER re-generate all modules for a small change. This is the key advantage of the modular approach.

---

## Module Types Reference
${_MODULE_REF}

## Design System Schema
${JSON.stringify(DESIGN_SYSTEM_SCHEMA, null, 2)}`;

const TABLE_SCHEMA_EXAMPLE = {
  columns: [
    { id: "col_a", header: "Region", type: "text", align: "left" },
    { id: "col_b", header: "Revenue", type: "currency", currency_code: "SEK", align: "right" },
    { id: "col_c", header: "Growth", type: "percent", align: "right" },
  ],
  rows: [
    { id: "row_1", is_header: false, is_total: false, cells: { col_a: "Norden", col_b: 48200000, col_c: 0.127 } },
    { id: "row_total", is_header: false, is_total: true, cells: { col_a: "Total", col_b: 142000000, col_c: 0.118 } },
  ],
};

// ─── HTML Assembly ──────────────────────────────────────────────────────────

function buildDocumentCss(ds) {
  const c = ds?.colors || {};
  const t = ds?.typography || {};
  const s = ds?.spacing || {};
  const p = ds?.page || {};

  // Google Fonts import if heading/body contain known Google Font names
  const googleImport = ds?.google_fonts_import || "";

  return `${googleImport}
:root {
  --color-primary: ${c.primary || "#1A2B5C"};
  --color-secondary: ${c.secondary || "#4A7C9E"};
  --color-accent: ${c.accent || "#E8A838"};
  --color-text: ${c.text || "#1A1A1A"};
  --color-text-light: ${c.text_light || "#666666"};
  --color-bg: ${c.bg || "#FFFFFF"};
  --color-bg-alt: ${c.bg_alt || "#F5F5F0"};
  --color-surface: ${c.surface || "#E8E4DE"};
  --font-heading: ${t.heading_family || "Georgia, serif"};
  --font-body: ${t.body_family || "system-ui, sans-serif"};
  --heading-weight: ${t.heading_weight || "700"};
  --base-size: ${t.base_size_pt || 10.5}pt;
  --line-height: ${t.line_height || 1.5};
  --spacing-base: ${s.base_mm || 5}mm;
  --spacing-section: ${s.section_gap_mm || 15}mm;
  --spacing-col-gap: ${s.column_gap_mm || 8}mm;
}
@page {
  size: ${p.size || "A4"};
  margin: ${p.margin_top_mm || 20}mm ${p.margin_outer_mm || 20}mm ${p.margin_bottom_mm || 25}mm ${p.margin_inner_mm || 25}mm;
  @bottom-center { content: counter(page); font-size: 9pt; color: var(--color-text-light); }
}
@page :first { margin: 0; @bottom-center { content: none; } }
@page :left  { margin-left: ${p.margin_outer_mm || 20}mm; margin-right: ${p.margin_inner_mm || 25}mm; }
@page :right { margin-left: ${p.margin_inner_mm || 25}mm; margin-right: ${p.margin_outer_mm || 20}mm; }
body {
  font-family: var(--font-body);
  font-size: var(--base-size);
  line-height: var(--line-height);
  color: var(--color-text);
  margin: 0;
  padding: 0;
}
h1 { font-family: var(--font-heading); font-size: 42pt; font-weight: var(--heading-weight); margin: 0 0 var(--spacing-base); }
h2 { font-family: var(--font-heading); font-size: 28pt; font-weight: var(--heading-weight); margin: 0 0 var(--spacing-base); }
h3 { font-family: var(--font-heading); font-size: 20pt; font-weight: var(--heading-weight); margin: 0 0 var(--spacing-base); }
p { margin: 0 0 var(--spacing-base); }

/* Module base */
.module { page-break-after: always; padding: var(--spacing-section); box-sizing: border-box; }
.module:last-child { page-break-after: auto; }

/* Full-page modules */
.module-cover { height: 297mm; padding: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; background: var(--color-primary); color: white; text-align: center; }
.module-chapter-break { height: 297mm; display: flex; flex-direction: column; justify-content: center; }
.module-back-cover { height: 297mm; display: flex; flex-direction: column; justify-content: flex-end; background: var(--color-bg-alt); }

/* Flowing modules — NO height set, let content flow */
.module-text-spread { }
.module-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(70mm, 1fr)); gap: var(--spacing-base); }
.module-financial-summary { }
.module-two-col-text { column-count: 2; column-gap: var(--spacing-col-gap); }
.module-quote-callout { display: flex; flex-direction: column; justify-content: center; min-height: 100mm; }
.module-image-text { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-col-gap); align-items: start; }
.module-data-chart { }

/* Component styles */
.kpi-card { padding: var(--spacing-base); page-break-inside: avoid; }
.kpi-value { font-size: 32pt; font-weight: 700; color: var(--color-primary); line-height: 1.1; }
.kpi-label { font-size: 9pt; color: var(--color-text-light); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2mm; }
.kpi-delta { font-size: 10pt; margin-top: 1mm; }
.kpi-delta.positive { color: #2e7d32; }
.kpi-delta.negative { color: #c62828; }

table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th { text-align: left; border-bottom: 2pt solid var(--color-primary); padding: 2mm 3mm; font-weight: 700; }
td { padding: 2mm 3mm; border-bottom: 0.5pt solid var(--color-surface); }
tr.total td { font-weight: 700; border-top: 1pt solid var(--color-text); border-bottom: none; }
td.number, th.number { text-align: right; font-variant-numeric: tabular-nums; }

.chapter-number { font-size: 64pt; font-weight: 700; color: var(--color-accent); line-height: 1; }
blockquote { font-size: 24pt; font-family: var(--font-heading); line-height: 1.3; border-left: 4pt solid var(--color-accent); padding-left: var(--spacing-base); margin: var(--spacing-section) 0; }
blockquote cite { display: block; font-size: 10pt; font-family: var(--font-body); color: var(--color-text-light); margin-top: var(--spacing-base); }

figure.chart { page-break-inside: avoid; margin: var(--spacing-base) 0; }
figure.chart svg { width: 100%; max-height: 200mm; }
figcaption { font-size: 9pt; color: var(--color-text-light); margin-top: 2mm; }

.image-placeholder { background: var(--color-bg-alt); border: 1pt dashed var(--color-surface); display: flex; align-items: center; justify-content: center; min-height: 80mm; color: var(--color-text-light); font-size: 9pt; }
`;
}

function assembleHtml(designSystem, modules) {
  const css = buildDocumentCss(designSystem);
  const fragments = modules
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .map((m) => m.html_fragment || `<section class="module module-${m.module_type}"><p>[${m.title} — inget HTML-fragment sparat ännu]</p></section>`)
    .join("\n\n");

  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${css}
</style>
</head>
<body>
${fragments}
</body>
</html>`;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_template_info",
    description: "CALL THIS FIRST. Returns workflow guide, document types, module descriptions, design system schema, and guardrails. Pass document_type to get required sections; omit for general guide + type catalog.",
    inputSchema: {
      type: "object",
      properties: {
        document_type: {
          type: "string",
          enum: [
            "annual_report", "quarterly", "pitch", "proposal",
            "sustainability_report", "board_report", "investor_update",
            "case_study", "white_paper", "sales_proposal",
            "project_report", "brand_guide", "product_sheet",
            "newsletter", "event_program", "company_profile",
          ],
        },
      },
    },
  },
  {
    name: "list_documents",
    description: "List all report documents for the current user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_document",
    description: "Get a document with all fields. Use to check current state.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "create_document",
    description: "Create a new report document. You MUST have asked the user about brand and content BEFORE calling this.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        document_type: {
          type: "string",
          enum: [
            "annual_report", "quarterly", "pitch", "proposal",
            "sustainability_report", "board_report", "investor_update",
            "case_study", "white_paper", "sales_proposal",
            "project_report", "brand_guide", "product_sheet",
            "newsletter", "event_program", "company_profile",
          ],
        },
      },
      required: ["title", "document_type"],
    },
  },
  {
    name: "save_design_system",
    description: "Step 1: Save design system. NEVER use made-up values. Include google_fonts_import (@import url) if using Google Fonts.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_input: { type: "object", description: "Raw brand input: { company_name, colors, fonts, tone, logo_url }" },
        design_system: { type: "object", description: "Structured tokens + google_fonts_import string" },
      },
      required: ["document_id", "design_system"],
    },
  },
  {
    name: "save_module_plan",
    description: "Step 2: Save module plan. Map the user's ACTUAL content to modules. Ask user to paste content if you don't have it.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        raw_content: { type: "string", description: "The raw content the user pasted" },
        module_plan: { type: "array", items: { type: "object" }, description: "Ordered: { module_type, title, semantic_role?, content?, data? }" },
      },
      required: ["document_id", "module_plan"],
    },
  },
  {
    name: "save_module_html",
    description: "Step 3: Save HTML fragment for ONE module. Call this for each module in the plan. The fragment is a single <section class='module module-{type}'> element — do NOT include doctype, head, style, or body tags. Use CSS variables from the design system. For charts use inline SVG (no JS). For fonts use Google Fonts @import (no base64). After saving all modules, call assemble_document.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        module_id: { type: "string", description: "The module ID from the plan" },
        html_fragment: { type: "string", description: "Single <section> HTML fragment for this module" },
      },
      required: ["document_id", "module_id", "html_fragment"],
    },
  },
  {
    name: "assemble_document",
    description: "Step 3b: Server assembles the complete HTML from all module fragments + design system CSS. Call this AFTER saving all module HTML fragments. Validates against guardrails. Returns status and preview URL.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "export_pdf",
    description: "Step 4: Generate PDF from the assembled HTML using built-in headless Chrome. No API key needed. Returns a download URL where the user can save the PDF. Call assemble_document first.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "get_preview_url",
    description: "Get a browser preview URL for the document. User opens in Chrome to inspect the layout before PDF export.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "extract_brand_from_url",
    description: "Extract brand design info from a website URL. Scrapes colors, fonts, CSS tokens. Use when user provides their company website.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

// ─── Tool handlers ──────────────────────────────────────────────────────────

async function handleListDocuments(hubUserId) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, document_type, status, created_at, updated_at
    FROM documents WHERE hub_user_id = ${hubUserId} AND deleted_at IS NULL
    ORDER BY updated_at DESC
  `;
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
}

async function handleGetDocument(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, document_type, status, brand_input, design_system,
           raw_content, module_plan, created_at, updated_at
    FROM documents WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL LIMIT 1
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  // Don't return html_output (too large) — return module plan with fragment status
  const doc = { ...rows[0] };
  if (doc.module_plan) {
    doc.module_plan = doc.module_plan.map((m) => ({
      ...m,
      has_html: Boolean(m.html_fragment),
      html_fragment: undefined, // don't send fragments back
    }));
  }
  return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
}

async function handleCreateDocument(hubUserId, args) {
  const sql = getSql();
  let stubPlan = [];
  try { stubPlan = await getDefaultStubPlan(args.document_type); } catch {}
  const planWithIds = stubPlan.map((m) => ({ id: randomUUID(), ...m }));

  const rows = await sql`
    INSERT INTO documents (hub_user_id, title, document_type, module_plan, status)
    VALUES (${hubUserId}, ${args.title}, ${args.document_type}::document_type, ${JSON.stringify(planWithIds)}::jsonb, 'draft')
    RETURNING id, title, document_type, status, module_plan, created_at
  `;
  return { content: [{ type: "text", text: JSON.stringify({ ...rows[0], next_step: "Call save_design_system with the user's brand info." }, null, 2) }] };
}

async function handleSaveDesignSystem(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    UPDATE documents SET
      brand_input = ${JSON.stringify(args.brand_input ?? {})}::jsonb,
      design_system = ${JSON.stringify(args.design_system)}::jsonb,
      status = 'ready'::doc_status, updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    RETURNING id, status
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  return { content: [{ type: "text", text: `Design system saved. Next: ask user to paste content, then call save_module_plan.` }] };
}

async function handleSaveModulePlan(hubUserId, args) {
  const sql = getSql();
  const docs = await sql`SELECT id, document_type FROM documents WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL LIMIT 1`;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const planWithIds = args.module_plan.map((m, idx) => ({ id: m.id ?? randomUUID(), order: idx + 1, ...m }));
  let merged;
  try { merged = await mergeMissingStubs(docs[0].document_type, planWithIds); } catch { merged = { modulePlan: planWithIds, warnings: [] }; }

  await sql`UPDATE documents SET raw_content = ${args.raw_content ?? null}, module_plan = ${JSON.stringify(merged.modulePlan)}::jsonb, status = 'ready'::doc_status, updated_at = NOW() WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL`;

  return { content: [{ type: "text", text: JSON.stringify({
    ok: true, module_count: merged.modulePlan.length,
    modules: merged.modulePlan.map((m) => ({ id: m.id, module_type: m.module_type, title: m.title })),
    warnings: merged.warnings.length > 0 ? merged.warnings.map((w) => w.label).join(", ") : null,
    next_step: "Now generate HTML for each module using save_module_html, one at a time.",
  }, null, 2) }] };
}

async function handleSaveModuleHtml(hubUserId, args) {
  const sql = getSql();
  const docs = await sql`SELECT id, module_plan FROM documents WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL LIMIT 1`;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const plan = docs[0].module_plan || [];
  const moduleIdx = plan.findIndex((m) => m.id === args.module_id);
  if (moduleIdx === -1) return { content: [{ type: "text", text: `Module ${args.module_id} not found in plan` }], isError: true };

  // Store the HTML fragment in the module plan entry
  plan[moduleIdx].html_fragment = args.html_fragment;

  await sql`UPDATE documents SET module_plan = ${JSON.stringify(plan)}::jsonb, updated_at = NOW() WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL`;

  const saved = plan.filter((m) => m.html_fragment).length;
  const total = plan.length;
  const remaining = plan.filter((m) => !m.html_fragment).map((m) => ({ id: m.id, type: m.module_type, title: m.title }));

  return { content: [{ type: "text", text: JSON.stringify({
    ok: true, module: plan[moduleIdx].title, saved_count: saved, total_count: total,
    remaining: remaining.length > 0 ? remaining : null,
    next_step: remaining.length > 0 ? `Save HTML for the next module: ${remaining[0].title} (${remaining[0].id})` : "All modules saved! Call assemble_document to build the complete HTML.",
  }, null, 2) }] };
}

async function handleAssembleDocument(hubUserId, args) {
  const sql = getSql();
  const docs = await sql`SELECT id, module_plan, design_system, title FROM documents WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL LIMIT 1`;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const plan = docs[0].module_plan || [];
  const missing = plan.filter((m) => !m.html_fragment);
  if (missing.length > 0) {
    return { content: [{ type: "text", text: `${missing.length} module(s) still missing HTML: ${missing.map((m) => m.title).join(", ")}. Save them first.` }], isError: true };
  }

  const html = assembleHtml(docs[0].design_system || {}, plan);
  const validation = validateHtml(html);

  await sql`UPDATE documents SET html_output = ${html}, status = ${validation.valid ? "ready" : "error"}::doc_status, updated_at = NOW() WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL`;

  const key = previewKey(args.document_id);
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || "https://rotor-report-ai.netlify.app";

  if (!validation.valid) {
    return { content: [{ type: "text", text: `Document assembled but has guardrail issues:\n${validation.issues.map((i) => `- ${i}`).join("\n")}\n\nFix the affected module(s) with save_module_html and call assemble_document again.` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify({
    ok: true, html_size_kb: Math.round(html.length / 1024),
    preview_url: `${siteUrl}/api/preview?id=${args.document_id}&key=${key}`,
    next_step: "Call export_pdf to generate a downloadable PDF.",
  }, null, 2) }] };
}

async function handleExportPdf(hubUserId, args) {
  const sql = getSql();
  const docs = await sql`SELECT id, html_output, title FROM documents WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL LIMIT 1`;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  if (!docs[0].html_output) return { content: [{ type: "text", text: "No assembled HTML. Call assemble_document first." }], isError: true };

  try {
    const chromium = await import("@sparticuz/chromium");
    const puppeteer = await import("puppeteer-core");

    const browser = await puppeteer.default.launch({
      args: chromium.default.args,
      defaultViewport: chromium.default.defaultViewport,
      executablePath: await chromium.default.executablePath(),
      headless: chromium.default.headless,
    });

    const page = await browser.newPage();
    await page.setContent(docs[0].html_output, { waitUntil: "networkidle0", timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await browser.close();

    // Store PDF as base64 in a separate column or return directly
    const pdfBase64 = pdfBuffer.toString("base64");
    const pdfSizeKb = Math.round(pdfBase64.length * 0.75 / 1024);

    // Store in DB for download
    await sql`UPDATE documents SET status = 'ready'::doc_status, updated_at = NOW() WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL`;

    // Return download URL via preview function with pdf flag
    const key = previewKey(args.document_id);
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || "https://rotor-report-ai.netlify.app";
    const downloadUrl = `${siteUrl}/api/preview?id=${args.document_id}&key=${key}&format=pdf`;

    // Store the PDF bytes temporarily (we'll serve via the preview function)
    // For now, store in a pdf_output column if available, otherwise use blobs
    try {
      await sql`UPDATE documents SET pdf_output = decode(${pdfBase64}, 'base64'), updated_at = NOW() WHERE id = ${args.document_id}`;
    } catch {
      // pdf_output column might not exist — that's OK, we still have the base64
      console.warn("[export_pdf] Could not store PDF in pdf_output column");
    }

    return { content: [{ type: "text", text: JSON.stringify({
      ok: true,
      pdf_size_kb: pdfSizeKb,
      download_url: downloadUrl,
      title: docs[0].title,
      instructions: "Klicka på länken för att ladda ner PDF:en. Alternativt kan du öppna preview-länken i Chrome och skriva ut till PDF med ⌘P.",
    }, null, 2) }] };
  } catch (e) {
    console.error("[export_pdf] Chrome rendering failed:", e);
    // Fallback to preview URL
    const key = previewKey(args.document_id);
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || "https://rotor-report-ai.netlify.app";
    return { content: [{ type: "text", text: JSON.stringify({
      ok: false,
      error: "PDF-rendering misslyckades på servern. Du kan istället öppna preview-länken i Chrome och spara som PDF med ⌘P / Ctrl+P.",
      preview_url: `${siteUrl}/api/preview?id=${args.document_id}&key=${key}`,
      technical_error: e.message,
    }, null, 2) }] };
  }
}

async function handleGetTemplateInfo(hubUserId, args) {
  const sql = getSql();
  const docType = args?.document_type || null;
  const template = docType ? await getTemplate(docType) : null;
  let fonts = [];
  try { fonts = await sql`SELECT family_name, weight, style, format, blob_key FROM custom_fonts WHERE hub_user_id = ${hubUserId} ORDER BY created_at DESC`; } catch {}

  const result = {
    workflow_prompt: WORKFLOW_PROMPT,
    module_type_descriptions: MODULE_TYPE_DESCRIPTIONS,
    design_system_schema: DESIGN_SYSTEM_SCHEMA,
    available_document_types: DOCUMENT_TYPE_CATALOG,
    available_module_types: MODULE_TYPES,
    guardrails: GUARDRAILS_PROMPT,
    table_data_schema: TABLE_SCHEMA_EXAMPLE,
    custom_fonts: fonts,
  };
  if (docType && template) {
    result.document_type = docType;
    result.required_sections = template.required_sections ?? [];
    result.default_stub_plan = template.default_stub_plan ?? [];
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleGetPreviewUrl(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`SELECT id, html_output, title FROM documents WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL LIMIT 1`;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  if (!rows[0].html_output) return { content: [{ type: "text", text: "No HTML yet. Call assemble_document first." }], isError: true };

  const key = previewKey(args.document_id);
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || "https://rotor-report-ai.netlify.app";
  return { content: [{ type: "text", text: JSON.stringify({
    preview_url: `${siteUrl}/api/preview?id=${args.document_id}&key=${key}`,
    title: rows[0].title,
  }, null, 2) }] };
}

async function handleExtractBrandFromUrl(hubUserId, args) {
  if (!args.url) return { content: [{ type: "text", text: "URL is required" }], isError: true };
  try {
    const response = await fetch(args.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReportAI/1.0)", "Accept": "text/html" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { content: [{ type: "text", text: `Could not fetch: HTTP ${response.status}` }], isError: true };
    const html = await response.text();

    const hexColors = [...new Set((html.match(/#(?:[0-9a-fA-F]{3,8})\b/g) || []))];
    const fontMatches = [...html.matchAll(/font-family\s*:\s*([^;}"]+)/gi)].map((m) => m[1].trim());
    const fontFamilies = [...new Set(fontMatches)].slice(0, 10);
    const googleFonts = [...html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"&']+)/gi)]
      .map((m) => decodeURIComponent(m[1]).replace(/\+/g, " ").split("|").map((f) => f.split(":")[0].trim())).flat();
    const cssVars = {};
    for (const m of html.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;}"]+)/g)) cssVars[m[1].trim()] = m[2].trim();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

    const skip = new Set(["#fff", "#ffffff", "#000", "#000000", "#333", "#666", "#999", "#ccc", "#eee", "#f5f5f5"]);
    const brandColors = hexColors.filter((c) => !skip.has(c.toLowerCase())).slice(0, 15);

    return { content: [{ type: "text", text: JSON.stringify({
      source_url: args.url,
      page_title: titleMatch?.[1]?.trim() || null,
      colors: { hex: brandColors, suggestion: brandColors.length >= 3 ? `primary=${brandColors[0]}, secondary=${brandColors[1]}, accent=${brandColors[2]}` : "Ask user" },
      typography: { families: fontFamilies, google_fonts: [...new Set(googleFonts)] },
      css_tokens: Object.keys(cssVars).length > 0 ? cssVars : null,
      instructions: "Present findings to user. Ask to confirm before using. Supplement sparse data with tasteful defaults.",
    }, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Could not extract from ${args.url}: ${e.message}. Ask for brand details manually.` }], isError: true };
  }
}

// ─── Tool dispatch ──────────────────────────────────────────────────────────

const HANDLERS = {
  get_template_info: handleGetTemplateInfo,
  list_documents: handleListDocuments,
  get_document: handleGetDocument,
  create_document: handleCreateDocument,
  save_design_system: handleSaveDesignSystem,
  save_module_plan: handleSaveModulePlan,
  save_module_html: handleSaveModuleHtml,
  assemble_document: handleAssembleDocument,
  export_pdf: handleExportPdf,
  get_preview_url: handleGetPreviewUrl,
  extract_brand_from_url: handleExtractBrandFromUrl,
};

// ─── Main handler ───────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const publicPem = process.env.HUB_JWT_PUBLIC_KEY_PEM;
  const issuer = process.env.HUB_JWT_ISSUER ?? "hub.rotor-platform.com";
  const audience = process.env.MODULE_AUDIENCE ?? "report-ai";
  if (!publicPem) return jsonResponse(500, { error: "HUB_JWT_PUBLIC_KEY_PEM not configured" });

  const token = readBearerToken(event);
  const auth = verifyHubJwt(token, { publicPem, issuer, audience });
  if (!auth.ok) return jsonResponse(401, { error: auth.error });

  const hubUserId = auth.payload.sub ?? auth.payload.user_id ?? auth.payload.tenant_id;
  if (!hubUserId) return jsonResponse(401, { error: "JWT missing subject" });

  let rpc;
  try { rpc = JSON.parse(event.body ?? "{}"); } catch { return rpcError(null, -32700, "Parse error"); }

  const { method, params, id } = rpc;

  if (method === "initialize") return rpcResult(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "report-ai", version: "0.3.0" } });
  if (method === "notifications/initialized") return rpcResult(id, {});
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params?.name ?? "";
    const args = params?.arguments ?? {};
    const toolName = name.startsWith("report__") ? name.slice(8) : name;
    const fn = HANDLERS[toolName];
    if (!fn) return rpcError(id, -32601, `Unknown tool: ${name}`);
    try {
      return rpcResult(id, await fn(hubUserId, args));
    } catch (e) {
      console.error(`[mcp] ${toolName} failed:`, e);
      return rpcError(id, -32000, e.message ?? "Internal error");
    }
  }

  return rpcError(id, -32601, `Method not supported: ${method ?? ""}`);
};
