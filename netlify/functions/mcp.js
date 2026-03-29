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

### CRITICAL RULES:
- **NEVER invent brand colors, fonts, or tone.** Ask first.
- **NEVER generate content from thin air.** Ask user to paste content.
- **ALWAYS speak the user's language.**
- **Ask ONE focused question at a time.**

## Architecture: THEME / DESIGN / TEMPLATE

Three separate layers — never conflate them:

THEME = raw design tokens only
  Colors (primary, secondary, accent, text, text_light, bg, bg_alt, surface)
  Typography scale (font families, sizes 42/28/20/16/13/10.5/9pt, weights, line-height)
  Spacing system (base_mm, section_gap_mm, column_gap_mm)
  Page geometry (A4, margins)
  → Stored in document.design_system

DESIGN = how the theme is applied visually
  hierarchy: what dominates visually (e.g. "cover title is 48pt, KPI values are 32pt, body is 10.5pt")
  rhythm: spacing pattern between sections (e.g. "16mm between modules, 8mm inside")
  density: airy / balanced / compact (affects spacing multiplier)
  module_behavior: per-module layout rules (bleed, insets, max text width)
  → Stored in document.design_system.design {}

TEMPLATE = document structure
  Which modules in which order
  Required sections per document type
  → Stored in document.module_plan []

Rules:
- THEME can change without affecting DESIGN
- DESIGN can change without affecting TEMPLATE
- TEMPLATE can change without affecting THEME
- When generating HTML, read DESIGN to decide spacing, hierarchy, density — not just THEME tokens

## Locking

Parts of the document state can be LOCKED to prevent accidental changes:
- theme_locked: true → design_system tokens cannot be modified
- template_locked: true → module_plan structure cannot be modified
- design_locked: true → design_system.design cannot be modified
- content: NEVER locked — always free to iterate

Lock state is stored in document.design_system._locks = { theme: bool, template: bool, design: bool }

When a part is locked:
- Tell the user: "[THEME LOCKED] Temat är låst. Skriv 'lås upp theme' för att ändra."
- Do NOT modify locked parts
- Only unlock via explicit user command: "lås upp theme" / "unlock theme"

After Step 1.5 (design preview approved): auto-lock theme and design.
After Step 2 (module plan approved): auto-lock template.
Content and module HTML are always editable.

### Step 0: Choose Document Type
Call get_template_info (without document_type) to see available types.
Ask user what they want. If they already specified, skip ahead.

### Step 1: Theme + Design Extraction
Ask for: company name, website URL (call extract_brand_from_url), colors, fonts, tone.
Also ask about DESIGN preferences:
- "Vill du ha en luftig, balanserad eller kompakt layout?" (density)
- "Ska visuell hierarki vara standard, editorial eller datatung?" (hierarchy)
If custom fonts are available (custom_fonts[]), present them.
If user says "välj åt mig", pick a cohesive theme+design and explain.
Call create_document + save_design_system (with both theme tokens AND design object).

### Step 1.5: DESIGN PREVIEW — MANDATORY
Call preview_design. Show URL to user.
"Öppna länken. Kolla färger, typsnitt, modulernas spacing och bredd. Godkänn eller be om ändringar."
WAIT for approval.
On approval: auto-lock theme + design (call lock_state twice).
Present:

STATUS: Design approved and locked.
ACTIONS: [start content] [adjust design] [change document type]
NEXT: Paste or describe your content.

### Step 2: Content & Module Planning
ASK user to PASTE content. WAIT.
Map content to modules. Call save_module_plan.
Call preview_structure — show to user. Get approval.
Call preview_content — show to user. Get approval.
On approval: auto-lock template.
Present:

STATUS: Structure and content approved. Template locked.
DIFF: [list modules added]
ACTIONS: [generate document] [edit module] [add module]
NEXT: Generating HTML module by module.

### Step 3: HTML Generation — MODULE BY MODULE
For each module: call save_module_html.
Every fragment MUST use the 4-level margin system.
Text modules MUST have content-frame wrappers.
After all saved: call assemble_document.

### Step 4: PDF Export
Call export_pdf. Present download link.

STATUS: PDF generated (X KB).
ACTIONS: [download] [preview in browser] [revise module] [new document]
NEXT: Done. Ask if adjustments needed.

## HTML Fragment Rules (for save_module_html)

Each fragment is ONE <section> element. Do NOT include <!DOCTYPE>, <html>, <head>, or <style> — those are added by assemble_document.

### CSS Class Pattern:
\`<section class="module module-{type}" data-module-id="{id}">\`

### 4-Level Margin System — MANDATORY:
Every module fragment must use this structure:

LEVEL 1 — PAGE MARGINS: handled by @page CSS rule. Never set body margins.
LEVEL 2 — CONTENT FRAME: wrap body text in <div class="content-frame">. This ensures max-width and centering.
LEVEL 3 — MODULE INSETS: use <div class="module-inset"> for per-module padding when needed.
LEVEL 4 — FULL-BLEED: use class="full-bleed" only on cover, chapter_break, back_cover. NEVER on text modules.

Body text (text_spread, two_col_text) MUST always be inside a content-frame.
Body text MUST NEVER be flush against the page edge.
Body text max-width: 150mm (ensures ~65-75 characters per line for optimal readability).

### Module-Specific Layout Rules:

**cover** (full-bleed):
  <section class="module module-cover"><div class="content-frame">...</div></section>
  - height: 297mm, full-bleed background, content centered via flex
  - Content-frame inside for text positioning

**chapter_break** (full-bleed):
  <section class="module module-chapter-break"><div class="content-frame">...</div></section>
  - height: 297mm, chapter number + title

**text_spread** (content-frame REQUIRED):
  <section class="module module-text-spread"><div class="content-frame">...</div></section>
  - NO height set — flows naturally
  - ALL text inside content-frame (max-width 150mm, centered)
  - Paragraphs: margin-bottom: var(--spacing-base)
  - page-break-inside: avoid on paragraphs

**kpi_grid** (content-frame):
  <section class="module module-kpi-grid"><div class="content-frame">...</div></section>
  - Grid inside content-frame
  - page-break-inside: avoid on .kpi-card

**table** (content-frame):
  <section class="module module-table"><div class="content-frame">...</div></section>
  - Table inside content-frame (max-width 175mm)
  - page-break-inside: avoid on table

**quote_callout** (content-frame, narrow):
  <section class="module module-quote-callout"><div class="content-frame">...</div></section>
  - Narrow content-frame (max-width 130mm via CSS)

**data_chart** (content-frame):
  <section class="module module-data-chart"><div class="content-frame">...</div></section>
  - SVG inside content-frame

**financial_summary** (content-frame):
  <section class="module module-financial-summary"><div class="content-frame">...</div></section>
  - Hero numbers + table inside content-frame

**two_col_text** (content-frame REQUIRED):
  <section class="module module-two-col-text"><div class="content-frame">...</div></section>
  - column-count: 2 inside content-frame

**back_cover** (full-bleed):
  <section class="module module-back-cover"><div class="content-frame">...</div></section>
  - height: 297mm, flex-end layout

## Response Format — GUI-like behavior

ALL responses must follow this structure:

STATUS: [what just happened]
[optional diff if something changed]

ACTIONS:
- [action 1]
- [action 2]
NEXT: [what happens next if user approves]

Rules:
- Never use free-form dialog. Always use STATUS / ACTIONS / NEXT.
- Keep STATUS to one line.
- Keep ACTIONS to 2-4 concrete choices.
- NEXT should be one sentence.

## Output Discipline

- All output must be structured and directly actionable.
- No filler, no fluff, no restating what the user said.
- When showing design_system or module_plan: show only the relevant part, not the entire object.
- When a small change is made: show ONLY the diff, not the full structure.

## Diff Logic

When any part of the document changes, show a diff:

DIFF:
UPDATED: design.rhythm "balanced" → "airy"
ADDED: module #5 quote_callout "CEO Quote"
REMOVED: module #3 data_chart "Revenue Chart"

Rules:
- ADDED = new item
- UPDATED = changed value (show old → new)
- REMOVED = deleted item
- UNCHANGED items: do not list them
- For module HTML changes: show only module title + what changed, NOT the full HTML

## Preview Workflow

Step 1: Theme + Design → save_design_system
Step 1.5: DESIGN PREVIEW → preview_design → user approves look
Step 2: Module plan → save_module_plan → STRUCTURE PREVIEW → preview_structure → user approves structure
Step 2.5: CONTENT PREVIEW → preview_content → user approves content mapping
Step 3: HTML generation (module by module) → save_module_html per module → assemble_document
Step 4: export_pdf

Previews are decision tools, not final output.
After design preview approved: auto-lock theme + design.
After structure preview approved: auto-lock template.

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

function buildFontFaceCss(customFonts = []) {
  return customFonts
    .filter((f) => f.blob_key && String(f.blob_key).startsWith("http"))
    .map((f) => `@font-face {
  font-family: '${f.family_name}';
  src: url('${f.blob_key}') format('${f.format || "woff2"}');
  font-weight: ${f.weight || "400"};
  font-style: ${f.style || "normal"};
  font-display: swap;
}`)
    .join("\n");
}

function buildDocumentCss(ds, customFonts = []) {
  const c = ds?.colors || {};
  const t = ds?.typography || {};
  const s = ds?.spacing || {};
  const p = ds?.page || {};

  const fontFaces = buildFontFaceCss(customFonts);

  return `${fontFaces ? fontFaces + "\n" : ""}
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

/* ── 4-level margin system ── */
/* Level 1: Page margins — handled by @page rule above */
/* Level 2: Content frame — main text area */
.content-frame {
  max-width: ${ds?.design?.module_behavior?.text_spread?.max_text_width_mm || 160}mm;
  margin-left: auto;
  margin-right: auto;
  padding: 0 ${ds?.design?.module_behavior?.text_spread?.inset_mm || 0}mm;
}

/* Level 3: Module insets — per-module internal padding */
.module-inset {
  padding-left: var(--spacing-section);
  padding-right: var(--spacing-section);
}

/* Level 4: Full-bleed — explicitly override margins */
.full-bleed {
  margin-left: calc(-1 * ${p.margin_outer_mm || 20}mm);
  margin-right: calc(-1 * ${p.margin_inner_mm || 25}mm);
  padding: 0;
}

/* ── Design-driven spacing ── */
.rhythm-airy .module { margin-bottom: ${(s.section_gap_mm || 15) * 1.5}mm; }
.rhythm-balanced .module { margin-bottom: ${s.section_gap_mm || 15}mm; }
.rhythm-compact .module { margin-bottom: ${(s.section_gap_mm || 15) * 0.6}mm; }

.density-airy { --density-factor: 1.4; }
.density-balanced { --density-factor: 1.0; }
.density-compact { --density-factor: 0.7; }

/* ── Body text protection ── */
.module-text-spread .content-frame,
.module-two-col-text .content-frame {
  max-width: ${ds?.design?.module_behavior?.text_spread?.max_text_width_mm || 150}mm;
  margin: 0 auto;
}

/* ── Module-specific layout rules ── */
.module-cover { position: relative; overflow: hidden; }
.module-cover .content-frame { position: relative; z-index: 1; }
.module-chapter-break .content-frame { max-width: 180mm; }
.module-kpi-grid .content-frame { max-width: 180mm; margin: 0 auto; }
.module-table .content-frame { max-width: 175mm; margin: 0 auto; }
.module-quote-callout .content-frame { max-width: 130mm; margin: 0 auto; }
.module-financial-summary .content-frame { max-width: 175mm; margin: 0 auto; }
.module-data-chart .content-frame { max-width: 170mm; margin: 0 auto; }
`;
}

function assembleHtml(designSystem, modules, customFonts = []) {
  const css = buildDocumentCss(designSystem, customFonts);
  const design = designSystem?.design || {};
  const rhythmClass = `rhythm-${design.rhythm || "balanced"}`;
  const densityClass = `density-${design.density || "balanced"}`;
  const fragments = modules
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .map((m) => m.html_fragment || `<section class="module module-${m.module_type}"><div class="content-frame"><p>[${m.title}]</p></div></section>`)
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
<body class="${rhythmClass} ${densityClass}">
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
    description: "Step 1: Save theme tokens + design layer. design_system must include: colors, typography, spacing, page, AND a design object: { hierarchy: 'standard'|'editorial'|'data-dense', rhythm: 'airy'|'balanced'|'compact', density: 'airy'|'balanced'|'compact', module_behavior: { cover: {bleed:true}, text_spread: {max_text_width_mm:140, inset_mm:25}, ... } }. NEVER use made-up token values.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_input: { type: "object", description: "Raw brand input: { company_name, colors, fonts, tone, logo_url }" },
        design_system: { type: "object", description: "Structured tokens: { colors, typography, spacing, page }. Font families must be system fonts or names from custom_fonts[]." },
      },
      required: ["document_id", "design_system"],
    },
  },
  {
    name: "preview_design",
    description: "Step 1.5 — MANDATORY: Generate a visual design moodboard showing all module types (cover, KPI grid, text spread, table, quote, chart, back cover) rendered with the actual design system. ALWAYS call this after save_design_system and BEFORE proceeding to content. Show the URL to the user and wait for their approval before continuing. This is how the user sees and approves the look & feel.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        company_name: { type: "string", description: "Company name to show in the moodboard" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "preview_structure",
    description: "Generate a STRUCTURE PREVIEW showing the document's section hierarchy, module types, and order as a structured outline. Returns a text representation — not HTML. Use after save_module_plan to confirm structure with the user before generating HTML.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "preview_content",
    description: "Generate a CONTENT PREVIEW showing how the user's actual content maps into each module. Returns a text summary per module: title, content snippet, data summary. Use before generating HTML to let the user verify content placement. This is NOT the final output — it is a decision tool.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
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
    name: "lock_state",
    description: "Lock or unlock theme, design, or template. Locked parts cannot be modified. Content is always unlocked.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        action: { type: "string", enum: ["lock", "unlock"] },
        target: { type: "string", enum: ["theme", "design", "template"] },
      },
      required: ["document_id", "action", "target"],
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
  const existingDoc = await sql`
    SELECT design_system
    FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existingDoc[0]?.design_system?._locks?.theme) {
    return { content: [{ type: "text", text: "BLOCKED: Theme is locked. User must say 'unlock theme' / 'lås upp theme' to modify." }], isError: true };
  }
  if (existingDoc[0]?.design_system?._locks?.design) {
    return { content: [{ type: "text", text: "BLOCKED: Design is locked. User must say 'unlock design' / 'lås upp design' to modify." }], isError: true };
  }

  const incoming = { ...(args.design_system || {}) };
  const design = incoming.design || {
    hierarchy: "standard",
    rhythm: "balanced",
    density: "balanced",
    module_behavior: {},
  };
  incoming.design = {
    hierarchy: design.hierarchy || "standard",
    rhythm: design.rhythm || "balanced",
    density: design.density || "balanced",
    module_behavior: design.module_behavior || {},
  };
  incoming._locks = existingDoc[0]?.design_system?._locks || incoming._locks || { theme: false, template: false, design: false };

  const rows = await sql`
    UPDATE documents SET
      brand_input = ${JSON.stringify(args.brand_input ?? {})}::jsonb,
      design_system = ${JSON.stringify(incoming)}::jsonb,
      status = 'ready'::doc_status, updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    RETURNING id, status
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  return { content: [{ type: "text", text: `Design system saved. Next: ask user to paste content, then call save_module_plan.` }] };
}

async function handleSaveModulePlan(hubUserId, args) {
  const sql = getSql();
  const docCheck = await sql`
    SELECT design_system
    FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (docCheck[0]?.design_system?._locks?.template) {
    return { content: [{ type: "text", text: "BLOCKED: Template is locked. User must say 'unlock template' / 'lås upp template' to modify." }], isError: true };
  }

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

function generateMoodboardHtml(ds, companyName, customFonts) {
  const css = buildDocumentCss(ds, customFonts);
  const c = ds?.colors || {};
  const name = companyName || "Företagsnamn AB";
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Designförhandsvisning — ${name}</title>
<style>
${css}

/* ── Moodboard shell ── */
html { background: #e8e8e8; }
body { margin: 0; padding: 0; background: #e8e8e8; }

.moodboard-header {
  background: #1a1a1a; color: #fff;
  font-family: system-ui, sans-serif; font-size: 13px;
  padding: 14px 24px; display: flex; justify-content: space-between; align-items: center;
  position: sticky; top: 0; z-index: 100;
}
.moodboard-header strong { font-size: 15px; }
.moodboard-label {
  background: #2a2a2a; color: #aaa;
  font-family: system-ui, sans-serif; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.1em; padding: 8px 24px; margin: 32px 24px 8px;
  border-radius: 4px;
}
.page-shell {
  width: 210mm; min-height: 80mm; background: white;
  box-shadow: 0 4px 24px rgba(0,0,0,0.18);
  margin: 0 auto 32px; overflow: hidden;
  break-inside: avoid;
}
.page-shell.full-page { min-height: 297mm; }
@media screen { .page-shell { max-width: 900px; } }

/* ── Sample content ── */
.sample-body-text { line-height: 1.6; }
.sample-body-text p { margin: 0 0 4mm; }
.color-swatch { display: inline-block; width: 32px; height: 32px; border-radius: 4px; margin-right: 8px; vertical-align: middle; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.12); }
.font-sample-row { margin: 6px 0; }

@media print { .moodboard-header { display: none; } html,body { background: white; } }
</style>
</head>
<body>

<div class="moodboard-header">
  <span><strong>Designförhandsvisning</strong> — ${name}</span>
  <span style="color:#888">Granska designen nedan och godkänn eller be om ändringar</span>
</div>

<!-- ── COLOR & TYPE TOKENS ── -->
<div class="moodboard-label">Designsystem — färger & typografi</div>
<div class="page-shell" style="padding: 12mm;">
  <h3 style="font-family: var(--font-heading); font-size: 16pt; margin: 0 0 6mm;">Färgpalett</h3>
  <div style="margin-bottom: 8mm; font-family: var(--font-body); font-size: 9pt;">
    <div style="margin-bottom: 3mm;"><span class="color-swatch" style="background: var(--color-primary)"></span><strong>Primär</strong> — ${c.primary || "#1A2B5C"} — rubriker, omslag, accenter</div>
    <div style="margin-bottom: 3mm;"><span class="color-swatch" style="background: var(--color-secondary)"></span><strong>Sekundär</strong> — ${c.secondary || "#4A7C9E"} — stödytor, subtext</div>
    <div style="margin-bottom: 3mm;"><span class="color-swatch" style="background: var(--color-accent)"></span><strong>Accent</strong> — ${c.accent || "#E8A838"} — KPI-värden, kapitelbrytare, citat</div>
    <div style="margin-bottom: 3mm;"><span class="color-swatch" style="background: var(--color-bg-alt); border: 1px solid #ddd;"></span><strong>Bakgrund alt</strong> — ${c.bg_alt || "#F5F5F0"} — alternativa ytor</div>
    <div><span class="color-swatch" style="background: var(--color-surface); border: 1px solid #ddd;"></span><strong>Yta</strong> — ${c.surface || "#E8E4DE"} — tabellrader, avdelare</div>
  </div>
  <h3 style="font-family: var(--font-heading); font-size: 16pt; margin: 6mm 0 4mm;">Typsnittsskala</h3>
  <div style="font-family: var(--font-body); font-size: 9pt; color: var(--color-text-light); margin-bottom: 3mm;">Rubrik: ${ds?.typography?.heading_family || "Georgia, serif"} &nbsp;·&nbsp; Brödtext: ${ds?.typography?.body_family || "system-ui, sans-serif"}</div>
  <div class="font-sample-row" style="font-family: var(--font-heading); font-size: 42pt; font-weight: var(--heading-weight); line-height: 1;">H1 — 42pt Omslag</div>
  <div class="font-sample-row" style="font-family: var(--font-heading); font-size: 28pt; font-weight: var(--heading-weight);">H2 — 28pt Avsnitt</div>
  <div class="font-sample-row" style="font-family: var(--font-heading); font-size: 20pt;">H3 — 20pt Underrubrik</div>
  <div class="font-sample-row" style="font-family: var(--font-body); font-size: var(--base-size); line-height: var(--line-height);">Brödtext — ${ds?.typography?.base_size_pt || 10.5}pt — Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus efficitur lectus vel urna convallis, nec facilisis eros vulputate.</div>
  <div class="font-sample-row" style="font-family: var(--font-body); font-size: 9pt; color: var(--color-text-light);">Caption / notering — 9pt — Källa: Årsredovisning ${year}</div>
</div>

<!-- ── COVER ── -->
<div class="moodboard-label">Modul: Omslag (cover)</div>
<div class="page-shell full-page">
  <section class="module module-cover" style="padding: 20mm;">
    <div class="content-frame">
      <div style="flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 16mm;">
        <div style="font-family: var(--font-body); font-size: 10pt; opacity: 0.6; margin-bottom: 6mm; text-transform: uppercase; letter-spacing: 0.15em;">${year}</div>
        <h1 style="color: white; margin-bottom: 4mm; font-size: 38pt;">Årsredovisning<br>${year}</h1>
        <p style="color: rgba(255,255,255,0.75); font-size: 14pt; margin: 0 0 8mm;">${name}</p>
        <div style="width: 40mm; height: 2pt; background: var(--color-accent);"></div>
      </div>
    </div>
  </section>
</div>

<!-- ── CHAPTER BREAK ── -->
<div class="moodboard-label">Modul: Kapitelbrytare (chapter_break)</div>
<div class="page-shell" style="min-height: 180mm;">
  <section class="module module-chapter-break" style="min-height: 180mm; padding: 16mm;">
    <div class="content-frame">
      <div class="chapter-number" style="font-size: 80pt; font-weight: 700; color: var(--color-accent); line-height: 1; margin-bottom: 6mm;">01</div>
      <h2 style="font-size: 28pt; color: var(--color-primary); margin: 0 0 4mm;">Verksamhetsöversikt</h2>
      <p style="font-size: 12pt; color: var(--color-text-light); margin: 0; max-width: 120mm;">En sammanfattning av årets verksamhet, strategiska prioriteringar och framsteg mot långsiktiga mål.</p>
    </div>
  </section>
</div>

<!-- ── KPI GRID ── -->
<div class="moodboard-label">Modul: Nyckeltal (kpi_grid)</div>
<div class="page-shell" style="padding: 10mm;">
  <section class="module module-kpi-grid" style="page-break-after: never;">
    <div class="content-frame" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--spacing-base);">
      <div class="kpi-card" style="border-top: 3pt solid var(--color-primary); padding-top: 4mm;">
        <div class="kpi-value">1 243 MSEK</div>
        <div class="kpi-label">Nettoomsättning</div>
        <div class="kpi-delta positive" style="font-size: 9pt; color: #2e7d32; margin-top: 2mm;">▲ 12,4 % vs föregående år</div>
      </div>
      <div class="kpi-card" style="border-top: 3pt solid var(--color-secondary); padding-top: 4mm;">
        <div class="kpi-value">187 MSEK</div>
        <div class="kpi-label">EBITDA</div>
        <div class="kpi-delta positive" style="font-size: 9pt; color: #2e7d32; margin-top: 2mm;">▲ 8,7 % vs föregående år</div>
      </div>
      <div class="kpi-card" style="border-top: 3pt solid var(--color-accent); padding-top: 4mm;">
        <div class="kpi-value">15,0 %</div>
        <div class="kpi-label">EBITDA-marginal</div>
        <div class="kpi-delta negative" style="font-size: 9pt; color: #c62828; margin-top: 2mm;">▼ 0,5 pp vs föregående år</div>
      </div>
      <div class="kpi-card" style="padding-top: 4mm; border-top: 1pt solid var(--color-surface);">
        <div class="kpi-value">2 847</div>
        <div class="kpi-label">Antal anställda</div>
      </div>
      <div class="kpi-card" style="padding-top: 4mm; border-top: 1pt solid var(--color-surface);">
        <div class="kpi-value">14</div>
        <div class="kpi-label">Länder</div>
      </div>
      <div class="kpi-card" style="padding-top: 4mm; border-top: 1pt solid var(--color-surface);">
        <div class="kpi-value">92 %</div>
        <div class="kpi-label">Kundnöjdhet (NPS)</div>
      </div>
    </div>
  </section>
</div>

<!-- ── TEXT SPREAD ── -->
<div class="moodboard-label">Modul: Textsida (text_spread) — VD-ord</div>
<div class="page-shell" style="padding: 14mm 16mm;">
  <section class="module module-text-spread">
    <div class="content-frame">
      <h3 style="color: var(--color-secondary); font-size: 10pt; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 3mm;">VD-ord</h3>
      <h2 style="font-size: 24pt; margin: 0 0 6mm; color: var(--color-primary);">${year} — ett år av stark tillväxt och strategisk förnyelse</h2>
      <div class="sample-body-text" style="column-count: 2; column-gap: var(--spacing-col-gap);">
        <p>Under ${year} fortsatte vår tillväxtresa med imponerande kraft. Vi nådde en nettoomsättning på 1 243 MSEK, en ökning med 12,4 procent jämfört med föregående år. Denna framgång är ett resultat av hårt arbete från vår dedikerade personal och ett tydligt strategiskt fokus.</p>
        <p>Vår satsning på digitala lösningar har gett tydliga resultat. Den digitala försäljningskanalen växte med 34 procent och utgör nu 28 procent av den totala omsättningen. Vi ser fortsatt stor potential i detta segment.</p>
        <p>Hållbarhet är en integrerad del av vår affärsstrategi. Under året minskade vi våra koldioxidutsläpp med 18 procent och är nu på god väg mot vårt mål om klimatneutralitet år 2030.</p>
        <p>Jag vill rikta ett varmt tack till alla medarbetare, kunder och aktieägare för ert fortsatta förtroende och engagemang.</p>
      </div>
      <div style="margin-top: 6mm; border-top: 1pt solid var(--color-surface); padding-top: 4mm;">
        <div style="font-family: var(--font-heading); font-size: 12pt; font-weight: 700;">Anna Lindqvist</div>
        <div style="font-size: 9pt; color: var(--color-text-light);">Verkställande direktör, ${name}</div>
      </div>
    </div>
  </section>
</div>

<!-- ── TABLE ── -->
<div class="moodboard-label">Modul: Tabell (table)</div>
<div class="page-shell" style="padding: 10mm 12mm;">
  <section class="module module-table">
    <div class="content-frame">
      <h3 style="font-size: 14pt; margin: 0 0 4mm; color: var(--color-primary);">Finansiell sammanfattning</h3>
      <table>
        <thead>
          <tr>
            <th>Post</th>
            <th class="number">${year}</th>
            <th class="number">${year - 1}</th>
            <th class="number">Förändring</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Nettoomsättning</td><td class="number">1 243,2</td><td class="number">1 106,0</td><td class="number" style="color:#2e7d32;">+12,4 %</td></tr>
          <tr><td>Bruttoresultat</td><td class="number">498,1</td><td class="number">436,4</td><td class="number" style="color:#2e7d32;">+14,1 %</td></tr>
          <tr><td>EBITDA</td><td class="number">187,0</td><td class="number">172,0</td><td class="number" style="color:#2e7d32;">+8,7 %</td></tr>
          <tr><td>EBIT</td><td class="number">143,2</td><td class="number">131,8</td><td class="number" style="color:#2e7d32;">+8,6 %</td></tr>
          <tr class="total"><td>Årets resultat</td><td class="number">98,4</td><td class="number">89,1</td><td class="number" style="color:#2e7d32;">+10,4 %</td></tr>
        </tbody>
      </table>
      <p style="font-size: 8pt; color: var(--color-text-light); margin-top: 2mm;">Alla belopp i MSEK.</p>
    </div>
  </section>
</div>

<!-- ── QUOTE CALLOUT ── -->
<div class="moodboard-label">Modul: Citat (quote_callout)</div>
<div class="page-shell" style="padding: 16mm; min-height: 100mm;">
  <section class="module module-quote-callout">
    <div class="content-frame">
      <blockquote>
        "Vi ser en marknad i snabb förändring där de som agerar med beslutsamhet och långsiktighet kommer att vinna. Det är precis vad vi gör."
        <cite>Anna Lindqvist, VD ${name}</cite>
      </blockquote>
    </div>
  </section>
</div>

<!-- ── SVG CHART ── -->
<div class="moodboard-label">Modul: Diagram (data_chart) — Inline SVG linjediagram</div>
<div class="page-shell" style="padding: 10mm 12mm;">
  <section class="module module-data-chart">
    <div class="content-frame">
      <h3 style="font-size: 14pt; margin: 0 0 4mm; color: var(--color-primary);">Omsättningsutveckling, MSEK</h3>
      <figure class="chart">
      <svg viewBox="0 0 500 220" xmlns="http://www.w3.org/2000/svg" style="width:100%; max-height:180px;">
        <!-- Grid lines -->
        <line x1="60" y1="20" x2="60" y2="180" stroke="${c.surface || "#E8E4DE"}" stroke-width="1"/>
        <line x1="60" y1="180" x2="480" y2="180" stroke="${c.surface || "#E8E4DE"}" stroke-width="1"/>
        <line x1="60" y1="130" x2="480" y2="130" stroke="${c.surface || "#E8E4DE"}" stroke-width="0.5" stroke-dasharray="4,4"/>
        <line x1="60" y1="80" x2="480" y2="80" stroke="${c.surface || "#E8E4DE"}" stroke-width="0.5" stroke-dasharray="4,4"/>
        <!-- Y axis labels -->
        <text x="50" y="184" text-anchor="end" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">800</text>
        <text x="50" y="134" text-anchor="end" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">1 000</text>
        <text x="50" y="84" text-anchor="end" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">1 200</text>
        <!-- Area fill -->
        <polygon points="60,155 165,148 270,138 375,125 480,104 480,180 60,180" fill="${c.primary || "#1A2B5C"}" opacity="0.08"/>
        <!-- Line -->
        <polyline points="60,155 165,148 270,138 375,125 480,104" fill="none" stroke="${c.primary || "#1A2B5C"}" stroke-width="2.5" stroke-linejoin="round"/>
        <!-- Comparison line -->
        <polyline points="60,162 165,160 270,155 375,148 480,135" fill="none" stroke="${c.secondary || "#4A7C9E"}" stroke-width="1.5" stroke-dasharray="6,3" stroke-linejoin="round"/>
        <!-- Data points -->
        <circle cx="60" cy="155" r="4" fill="${c.primary || "#1A2B5C"}"/>
        <circle cx="165" cy="148" r="4" fill="${c.primary || "#1A2B5C"}"/>
        <circle cx="270" cy="138" r="4" fill="${c.primary || "#1A2B5C"}"/>
        <circle cx="375" cy="125" r="4" fill="${c.primary || "#1A2B5C"}"/>
        <circle cx="480" cy="104" r="5" fill="${c.accent || "#E8A838"}"/>
        <!-- Value labels -->
        <text x="480" y="98" text-anchor="middle" font-size="9" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="system-ui">1 243</text>
        <!-- X axis labels -->
        <text x="60" y="198" text-anchor="middle" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">${year - 4}</text>
        <text x="165" y="198" text-anchor="middle" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">${year - 3}</text>
        <text x="270" y="198" text-anchor="middle" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">${year - 2}</text>
        <text x="375" y="198" text-anchor="middle" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">${year - 1}</text>
        <text x="480" y="198" text-anchor="middle" font-size="9" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="system-ui">${year}</text>
        <!-- Legend -->
        <line x1="330" y1="215" x2="350" y2="215" stroke="${c.primary || "#1A2B5C"}" stroke-width="2.5"/>
        <text x="355" y="218" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">Faktisk</text>
        <line x1="400" y1="215" x2="420" y2="215" stroke="${c.secondary || "#4A7C9E"}" stroke-width="1.5" stroke-dasharray="4,2"/>
        <text x="425" y="218" font-size="8" fill="${c.text_light || "#666"}" font-family="system-ui">Budget</text>
      </svg>
        <figcaption>Nettoomsättning per år, MSEK. Gestreckat: budget.</figcaption>
      </figure>
    </div>
  </section>
</div>

<!-- ── FINANCIAL SUMMARY ── -->
<div class="moodboard-label">Modul: Finansiell sammanfattning (financial_summary)</div>
<div class="page-shell" style="padding: 12mm; background: var(--color-bg-alt);">
  <section class="module module-financial-summary">
    <div class="content-frame">
      <h3 style="font-size: 14pt; margin: 0 0 6mm; color: var(--color-primary);">Finansiella höjdpunkter ${year}</h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin-bottom: 8mm;">
        <div style="background: var(--color-primary); color: white; padding: 8mm; border-radius: 2mm;">
          <div style="font-size: 36pt; font-weight: 700; line-height: 1;">1 243</div>
          <div style="font-size: 10pt; opacity: 0.8; margin-top: 2mm;">MSEK Nettoomsättning</div>
          <div style="font-size: 9pt; color: var(--color-accent); margin-top: 1mm;">▲ 12,4 % tillväxt</div>
        </div>
        <div style="background: white; padding: 8mm; border-radius: 2mm; border: 1pt solid var(--color-surface);">
          <div style="font-size: 36pt; font-weight: 700; line-height: 1; color: var(--color-primary);">15,0 %</div>
          <div style="font-size: 10pt; color: var(--color-text-light); margin-top: 2mm;">EBITDA-marginal</div>
          <div style="font-size: 9pt; color: #c62828; margin-top: 1mm;">▼ 0,5 pp</div>
        </div>
      </div>
      <table>
        <tr><td>Rörelseresultat (EBIT)</td><td class="number">143,2 MSEK</td></tr>
        <tr><td>Kassaflöde från verksamheten</td><td class="number">201,4 MSEK</td></tr>
        <tr class="total"><td>Utdelning per aktie</td><td class="number">4,50 SEK</td></tr>
      </table>
    </div>
  </section>
</div>

<!-- ── TWO COL TEXT ── -->
<div class="moodboard-label">Modul: Två kolumner (two_col_text)</div>
<div class="page-shell" style="padding: 12mm 14mm;">
  <section class="module module-two-col-text">
    <div class="content-frame">
      <h3 style="font-size: 14pt; margin: 0 0 4mm; color: var(--color-primary);">Marknad & omvärld</h3>
      <div class="module-two-col-text sample-body-text">
        <p>Den globala marknaden för digitala tjänster fortsatte att växa under ${year}, trots ett utmanande makroekonomiskt klimat. Räntehöjningar och inflationstryck påverkade köpbeteenden, men efterfrågan på effektivisering och automatisering förblev stark.</p>
        <p>Vår nordiska hemmamarknad stod för 48 procent av omsättningen och visade en tillväxt om 9,2 procent. Den tyska marknaden är nu vår näst största och växte med hela 22 procent.</p>
        <p>Vi bedömer att marknaden för AI-assisterade lösningar kommer att växa med 35-40 procent per år de kommande tre åren. Vi är väl positionerade för att ta en stor del av detta.</p>
        <p>Konkurrensbilden förblir fragmenterad med ett fåtal stora aktörer och många nischspelare. Vår differentieringsstrategi baseras på djup branschkännedom och lokal närvaro.</p>
      </div>
    </div>
  </section>
</div>

<!-- ── BACK COVER ── -->
<div class="moodboard-label">Modul: Baksida (back_cover)</div>
<div class="page-shell full-page">
  <section class="module module-back-cover" style="padding: 14mm;">
    <div class="content-frame">
      <div style="width: 20mm; height: 3pt; background: var(--color-accent); margin-bottom: 6mm;"></div>
      <div style="font-family: var(--font-heading); font-size: 14pt; font-weight: 700; color: var(--color-primary); margin-bottom: 2mm;">${name}</div>
      <div style="font-size: 9pt; color: var(--color-text-light); line-height: 1.8;">
        Org.nr 556xxx-xxxx<br>
        Huvudkontor: Storgatan 1, 111 11 Stockholm<br>
        info@foretaget.se | www.foretaget.se<br>
        +46 (0)8 123 456 78
      </div>
      <div style="margin-top: 6mm; font-size: 7.5pt; color: var(--color-text-light); max-width: 140mm; line-height: 1.5;">
        Denna årsredovisning är framtagen i enlighet med årsredovisningslagen (1995:1554) och Bokföringsnämndens allmänna råd. Rapporten har granskats av bolagets revisor.
      </div>
    </div>
  </section>
</div>

<div style="padding: 24px; font-family: system-ui, sans-serif; font-size: 13px; color: #666; text-align: center; background: #e8e8e8;">
  Designförhandsvisning för ${name} — genererad av Report AI
</div>

</body>
</html>`;
}

async function handlePreviewDesign(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, design_system, brand_input, title FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const doc = rows[0];
  if (!doc.design_system) {
    return { content: [{ type: "text", text: "Design system not saved yet. Call save_design_system first." }], isError: true };
  }

  let fonts = [];
  try {
    fonts = await sql`
      SELECT family_name, weight, style, format, blob_key
      FROM custom_fonts WHERE hub_user_id = ${hubUserId} ORDER BY created_at DESC
    `;
  } catch {}

  const companyName = args.company_name
    || doc.brand_input?.company_name
    || doc.title
    || "Företag AB";

  const moodboardHtml = generateMoodboardHtml(doc.design_system, companyName, fonts);

  // Save the moodboard as the current html_output so it can be previewed
  await sql`
    UPDATE documents SET html_output = ${moodboardHtml}, updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  const key = previewKey(args.document_id);
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || "https://rotor-report-ai.netlify.app";
  const previewUrl = `${siteUrl}/api/preview?id=${args.document_id}&key=${key}`;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        preview_url: previewUrl,
        instruction_for_claude: "Show this URL to the user. Explain that it shows all module types rendered with their chosen colors and fonts. Ask: 'Öppna länken och kolla designen. Ser färgerna, typografin och modulerna bra ut? Vill du ändra något innan vi fortsätter med innehållet?'. Wait for approval before proceeding to Step 2.",
        modules_shown: ["cover", "chapter_break", "kpi_grid", "text_spread", "table", "quote_callout", "data_chart (line chart)", "financial_summary", "two_col_text", "back_cover"],
        design_used: {
          primary: doc.design_system?.colors?.primary,
          heading_font: doc.design_system?.typography?.heading_family,
          body_font: doc.design_system?.typography?.body_family,
          custom_fonts_loaded: fonts.length,
        },
      }, null, 2),
    }],
  };
}

async function handlePreviewStructure(hubUserId, args) {
  const sql = getSql();
  const docs = await sql`
    SELECT id, module_plan, document_type, title
    FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const plan = docs[0].module_plan || [];
  if (plan.length === 0) return { content: [{ type: "text", text: "Module plan is empty. Call save_module_plan first." }], isError: true };

  const lines = plan.map((m, i) => {
    const num = String(i + 1).padStart(2, "0");
    const bleed = ["cover", "chapter_break", "back_cover"].includes(m.module_type) ? " [FULL-BLEED]" : " [CONTENT-FRAME]";
    const role = m.semantic_role ? ` (${m.semantic_role})` : "";
    const hasHtml = m.html_fragment ? " ✓ HTML" : " ○ pending";
    return `${num}. ${m.module_type}${bleed} — "${m.title}"${role}${hasHtml}`;
  });

  const structure = [
    `STRUCTURE PREVIEW: ${docs[0].title}`,
    `Type: ${docs[0].document_type}`,
    `Modules: ${plan.length}`,
    `---`,
    ...lines,
    `---`,
    `ACTIONS: [approve] [reorder] [add module] [remove module]`,
  ].join("\n");

  return { content: [{ type: "text", text: structure }] };
}

async function handlePreviewContent(hubUserId, args) {
  const sql = getSql();
  const docs = await sql`
    SELECT id, module_plan, raw_content, title
    FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const plan = docs[0].module_plan || [];
  if (plan.length === 0) return { content: [{ type: "text", text: "Module plan is empty." }], isError: true };

  const lines = plan.map((m, i) => {
    const num = String(i + 1).padStart(2, "0");
    const contentSnippet = m.content ? m.content.slice(0, 120).replace(/\n/g, " ") + (m.content.length > 120 ? "..." : "") : "[no content yet]";
    const dataKeys = m.data && Object.keys(m.data).length > 0 ? ` data: {${Object.keys(m.data).join(", ")}}` : "";
    return `${num}. ${m.module_type} — "${m.title}"\n    Content: ${contentSnippet}${dataKeys}`;
  });

  const mappedCount = plan.filter((m) => m.content || (m.data && Object.keys(m.data).length > 0)).length;
  const preview = [
    `CONTENT PREVIEW: ${docs[0].title}`,
    `---`,
    ...lines,
    `---`,
    `STATUS: Content mapped to ${mappedCount}/${plan.length} modules`,
    `ACTIONS: [approve and generate HTML] [edit module content] [paste more content]`,
  ].join("\n");

  return { content: [{ type: "text", text: preview }] };
}

async function handleLockState(hubUserId, args) {
  const sql = getSql();
  const docs = await sql`
    SELECT id, design_system
    FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const ds = docs[0].design_system || {};
  ds._locks = ds._locks || {};
  ds._locks[args.target] = args.action === "lock";

  await sql`
    UPDATE documents
    SET design_system = ${JSON.stringify(ds)}::jsonb, updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  const status = args.action === "lock" ? "LOCKED" : "UNLOCKED";
  return { content: [{ type: "text", text: `${args.target.toUpperCase()}: ${status}` }] };
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

  let fonts = [];
  try {
    fonts = await sql`SELECT family_name, weight, style, format, blob_key FROM custom_fonts WHERE hub_user_id = ${hubUserId} ORDER BY created_at DESC`;
  } catch {}

  const html = assembleHtml(docs[0].design_system || {}, plan, fonts);
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
  get_template_info:       handleGetTemplateInfo,
  list_documents:          handleListDocuments,
  get_document:            handleGetDocument,
  create_document:         handleCreateDocument,
  save_design_system:      handleSaveDesignSystem,
  preview_design:          handlePreviewDesign,
  preview_structure:       handlePreviewStructure,
  preview_content:         handlePreviewContent,
  save_module_plan:        handleSaveModulePlan,
  lock_state:              handleLockState,
  save_module_html:        handleSaveModuleHtml,
  assemble_document:       handleAssembleDocument,
  export_pdf:              handleExportPdf,
  get_preview_url:         handleGetPreviewUrl,
  extract_brand_from_url:  handleExtractBrandFromUrl,
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
