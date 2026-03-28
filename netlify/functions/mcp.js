/**
 * POST /.netlify/functions/mcp — Report AI MCP endpoint
 *
 * JSON-RPC 2.0 server following the Rotor Platform module contract.
 * Auth: Hub JWT (RS256) in Authorization: Bearer header.
 *
 * Tools are exposed without prefix — the Hub gateway adds "report__" automatically.
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
  cover: "Full-bleed cover page. Contains logo, document title, subtitle, and optional date/author. Always the first module. Use strong visual hierarchy — title should dominate.",
  chapter_break: "Section divider page. Shows chapter number, chapter title, and optional intro paragraph. Use page-break-before: always. Creates rhythm between content sections.",
  text_spread: "One or two-page text content. Ideal for CEO letter, narrative summaries, strategy descriptions. Supports drop caps, pull quotes inline, and footnotes.",
  kpi_grid: "Key performance indicators in a grid layout, 2-4 KPIs per row. Each KPI: large number, label, optional delta/trend arrow. Use for financial highlights, operational metrics.",
  table: "Structured data table with proper column alignment. Supports header rows, total rows, alternating row shading. Data must follow the table_data_schema. Use for financial statements, comparisons.",
  quote_callout: "Full-page or half-page pull quote / testimonial. Large typography (24-32pt), attribution below. Use accent color for quotation marks or a vertical rule.",
  image_text: "Split layout — image placeholder on one side, text on the other (50/50 or 60/40). Image area gets a placeholder background with dimensions noted.",
  data_chart: "Placeholder for charts/visualizations. Include a descriptive caption and the data summary so the reader understands the chart even as a placeholder.",
  two_col_text: "Two-column text layout for dense content like appendices, notes, or detailed descriptions. Use column-gap and balanced column heights.",
  financial_summary: "Financial highlights page with key figures prominently displayed. Combines large hero numbers with supporting tables or mini-KPIs. Use for revenue, EBITDA, margins.",
  back_cover: "Back cover with company contact info, disclaimers, and optional logo. Always the last module. Keep minimal and clean.",
};

const DESIGN_SYSTEM_SCHEMA = {
  colors: {
    primary: "#1A2B5C",
    secondary: "#4A7C9E",
    accent: "#E8A838",
    text: "#1A1A1A",
    text_light: "#666666",
    bg: "#FFFFFF",
    bg_alt: "#F5F5F0",
    surface: "#E8E4DE",
  },
  typography: {
    heading_family: "Georgia, serif",
    body_family: "system-ui, sans-serif",
    heading_weight: "700",
    base_size_pt: 10.5,
    line_height: 1.5,
    scale: [42, 28, 20, 16, 13, 10.5, 9],
  },
  spacing: {
    base_mm: 5,
    section_gap_mm: 15,
    column_gap_mm: 8,
  },
  page: {
    size: "A4",
    margin_top_mm: 20,
    margin_bottom_mm: 25,
    margin_inner_mm: 25,
    margin_outer_mm: 20,
  },
};

const HTML_TEMPLATE_EXAMPLE = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --color-primary: #1A2B5C;
    --color-secondary: #4A7C9E;
    --color-accent: #E8A838;
    --color-text: #1A1A1A;
    --color-text-light: #666666;
    --color-bg: #FFFFFF;
    --color-bg-alt: #F5F5F0;
    --color-surface: #E8E4DE;
    --font-heading: Georgia, serif;
    --font-body: system-ui, sans-serif;
    --heading-weight: 700;
    --base-size: 10.5pt;
    --line-height: 1.5;
    --spacing-base: 5mm;
    --spacing-section: 15mm;
    --spacing-col-gap: 8mm;
  }
  @page { size: A4; margin: 20mm 20mm 25mm 25mm;
    @bottom-center { content: counter(page); font-size: 9pt; color: var(--color-text-light); }
  }
  @page :first { margin: 0; @bottom-center { content: none; } }
  @page :left  { margin-left: 20mm; margin-right: 25mm; }
  @page :right { margin-left: 25mm; margin-right: 20mm; }
  body { font-family: var(--font-body); font-size: var(--base-size); line-height: var(--line-height); color: var(--color-text); }
  h1 { font-family: var(--font-heading); font-size: 42pt; font-weight: var(--heading-weight); }
  h2 { font-family: var(--font-heading); font-size: 28pt; }
  h3 { font-family: var(--font-heading); font-size: 20pt; }
  .module { page-break-after: always; }
  .module:last-child { page-break-after: auto; }
  .module-cover { padding: 0; height: 297mm; display: flex; flex-direction: column; justify-content: center; align-items: center; background: var(--color-primary); color: white; }
  .module-chapter-break { height: 297mm; display: flex; flex-direction: column; justify-content: center; padding: var(--spacing-section); }
  .module-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120mm, 1fr)); gap: var(--spacing-base); }
  .kpi-card { padding: var(--spacing-base); }
  .kpi-value { font-size: 32pt; font-weight: 700; color: var(--color-primary); }
  .kpi-label { font-size: 9pt; color: var(--color-text-light); text-transform: uppercase; }
  .module-table table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  .module-table th { text-align: left; border-bottom: 2pt solid var(--color-primary); padding: 2mm 3mm; }
  .module-table td { padding: 2mm 3mm; border-bottom: 0.5pt solid var(--color-surface); }
  .module-table tr.total td { font-weight: 700; border-top: 1pt solid var(--color-text); }
  .module-two-col-text { column-count: 2; column-gap: var(--spacing-col-gap); }
  .module-back-cover { height: 297mm; display: flex; flex-direction: column; justify-content: flex-end; padding: var(--spacing-section); background: var(--color-bg-alt); }
</style>
</head>
<body>
  <section class="module module-cover">
    <h1>Document Title</h1>
    <p>Subtitle here</p>
  </section>
  <section class="module module-chapter-break">
    <span class="chapter-number">01</span>
    <h2>Chapter Title</h2>
  </section>
  <section class="module module-text-spread">
    <h3>Section heading</h3>
    <p>Body text...</p>
  </section>
  <section class="module module-back-cover">
    <p>Company Name AB | org.nr 556xxx-xxxx</p>
  </section>
</body>
</html>`;

const _MODULE_REF = Object.entries(MODULE_TYPE_DESCRIPTIONS)
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join("\n");

const WORKFLOW_PROMPT = `## Report AI — 4-Step Document Workflow

You are a professional document designer. You create InDesign-quality print documents using HTML + CSS Paged Media. You MUST follow these four steps IN ORDER. Never skip steps. Never assume information the user hasn't given you.

### CRITICAL RULES (read these first, always obey)
- **NEVER invent brand colors, fonts, or tone.** If the user hasn't told you → ASK before proceeding.
- **NEVER generate content from thin air.** If the user hasn't pasted or described the text/data → ASK them to paste it.
- **ALWAYS speak the user's language** (Swedish if they write Swedish, English if English).
- **Ask ONE focused question at a time** when information is missing. Don't overwhelm with 5 questions at once.
- **Summarize decisions** after each step: "Så här ser designsystemet ut nu: primärfärg X, typsnitt Y…"
- **Offer 2-3 choices with tradeoffs** when a design decision is needed (e.g., "Formell stil ger lugn och trovärdighet, kreativ ger mer energi och personlighet").

---

### Step 1: Brand Extraction (MANDATORY)

**Goal:** Build a complete design system BEFORE creating any document.

**1a. Gathering brand info — ask the user these questions (one at a time, adapt to what they've already told you):**
- "Vad heter företaget exakt som det ska stå på omslaget?"
- "Har du en webbplats jag kan hämta designinfo ifrån? (Jag kan extrahera färger, typsnitt och stil automatiskt)" → If they give a URL, call extract_brand_from_url to scrape colors, fonts, and styling. Use the extracted data as the starting point.
- "Har du en brandguide, logotyp eller exempelmaterial jag kan utgå ifrån? (Du kan klistra in en länk eller beskriva)"
- If URL extraction didn't give complete info, ask: "Vilka färger vill du använda?" → If they're unsure, offer 2-3 palette suggestions based on their industry/tone:
  - Corporate/formell: djupblå + grå + guld
  - Modern/tech: svart + vit + elektrisk blå
  - Kreativ/lekfull: korall + teal + ljusgrå
- "Vilka typsnitt föredrar du?" → If they're unsure, suggest:
  - Serif-rubrik + sans-serif-brödtext (klassiskt, trovärdigt)
  - Sans-serif genomgående (modernt, rent)
  - Slab-serif + monospace (djärvt, editorialt)
- "Vilken ton passar bäst: formell/corporate, modern/clean, eller kreativ/djärv?"

**1b. Building the design system — once you have answers, create a COMPLETE design system:**
- colors: primary, secondary, accent, text (#1A1A1A), text_light (#666), bg (#FFF), bg_alt (light tone), surface (border/divider tone)
- typography: heading_family, body_family, heading_weight, base_size_pt (10-11pt for body), line_height (1.4-1.6), scale (7 sizes from 42pt down to 9pt)
- spacing: base_mm (4-6mm), section_gap_mm (12-18mm), column_gap_mm (6-10mm)
- page: size (A4), margins (top 18-22mm, bottom 22-28mm, inner 22-28mm for binding, outer 18-22mm)

**1c. Confirming with user:**
Present the design system as a summary: "Här är designsystemet jag byggt utifrån dina val: [colors, fonts, tone]. Ser det bra ut, eller vill du justera något?"

WAIT for confirmation. Then call save_design_system.

---

### Step 2: Content & Module Planning

**Goal:** Map the user's REAL content to a structured module plan.

**2a. Getting the content — ask the user:**
- "Nu behöver jag innehållet. Klistra in texten/datan du vill ha med, eller beskriv vilka avsnitt rapporten ska ha."
- "Har du siffror/nyckeltal som ska lyftas fram? (Revenue, tillväxt, antal anställda…)"
- "Finns det tabeller eller finansiella data som ska med?"

WAIT for the user to paste/describe content. Do NOT proceed without real content.

**2b. Planning modules — map content to the right module types:**
- cover: ALWAYS first. Use title, subtitle, date, company name from brand input.
- chapter_break: Insert between major sections. Gives rhythm and breathing room.
- text_spread: For narratives like CEO letter, strategy descriptions, summaries. One spread = 1-2 pages.
- kpi_grid: For 2-6 key metrics. Each KPI gets: large number, label, optional trend arrow (▲/▼).
- table: For structured data. Use the table_data_schema format. Right-align numbers.
- financial_summary: For revenue/EBITDA/margin hero numbers + supporting details.
- quote_callout: For testimonials, CEO quotes, or important pull-quotes.
- image_text: Split layout with image placeholder + text.
- data_chart: Placeholder for charts with descriptive caption.
- two_col_text: Dense text in two columns (appendices, notes).
- back_cover: ALWAYS last. Company info, disclaimers, contact.

**2c. Presenting the plan:**
Show the user the proposed structure: "Så här tänker jag lägga upp rapporten: [list of modules]. Vill du ändra ordning eller lägga till/ta bort något?"

WAIT for confirmation. Then call save_module_plan with raw_content (the user's pasted text) and the module_plan array.

---

### Step 3: HTML Generation

**Goal:** Produce a single, self-contained HTML document that renders perfectly in print.

**3a. Document structure:**
- DOCTYPE html, lang attribute matching content language
- All CSS inline in a <style> block — no external stylesheets
- No <script> tags whatsoever
- No external images (use CSS backgrounds or placeholder boxes instead)

**3b. CSS Paged Media (this is what makes it InDesign-quality):**
\`\`\`css
@page {
  size: A4;
  margin: [top]mm [outer]mm [bottom]mm [inner]mm;
  @bottom-center { content: counter(page); font-size: 9pt; color: var(--color-text-light); }
}
@page :first { margin: 0; @bottom-center { content: none; } }
@page :left  { margin-left: [outer]mm; margin-right: [inner]mm; }
@page :right { margin-left: [inner]mm; margin-right: [outer]mm; }
\`\`\`

**3c. Design system as CSS custom properties:**
Convert EVERY token from the design system into a --var in :root. The HTML body must reference ONLY these variables — never hardcode colors or sizes.

**3d. Module HTML pattern:**
Each module is: \`<section class="module module-{type}">\`
- page-break-after: always on .module (except :last-child)
- Cover: height: 297mm, full-bleed background, centered content
- Chapter break: height: 297mm, large chapter number + title
- Text spread: standard page flow with proper headings
- KPI grid: CSS grid with minmax(80mm, 1fr) cards
- Table: full-width, border-collapse, th with primary-color bottom border, td with light borders, .total row bold
- Back cover: height: 297mm, pushed to bottom with flex-end

**3e. Typography rules:**
- Heading hierarchy: h1 (42pt cover), h2 (28pt sections), h3 (20pt subsections)
- Body: base_size_pt (typically 10-11pt)
- Captions/footnotes: 8-9pt
- KPI values: 28-36pt bold
- Minimum font size: 7pt (guardrail enforced)

**3f. Number formatting (sv-SE):**
- Thousands: thin space → 1 234 567
- Decimals: comma → 1 234,50
- Currency: 48,2 MSEK or 48 200 TSEK
- Percent: 12,7 % (with space)
- Dates: 2026-03-28 or "28 mars 2026"

**3g. Quality checklist before saving:**
✓ @page rule present with A4 size
✓ All design tokens as CSS variables
✓ Cover and back_cover modules present
✓ No <script> tags
✓ No lorem ipsum
✓ No hardcoded colors (use variables)
✓ Page breaks between modules
✓ Numbers formatted as sv-SE
✓ All content from user's input — nothing invented

Call save_html. If guardrails return issues, fix them and call save_html again.

---

### Step 4: Preview & PDF

Call get_preview_url. Present the link to the user with instructions:
- "Öppna denna länk i Chrome"
- "Klicka 'Skriv ut / Spara som PDF' eller tryck ⌘P / Ctrl+P"
- "Välj 'Spara som PDF' som destination"
- "CSS Paged Media-reglerna ser till att sidbrytningar, marginaler och layout blir exakt som designat"

Ask if they want adjustments: "Vill du att jag justerar något? Färger, typografi, ordning, innehåll?"

---

## Module Types Reference
${_MODULE_REF}

## Swedish Document Conventions
- Numbers: 1 234 567,89 (thin space thousands, comma decimals)
- Currency: 48,2 MSEK or 48 200 TSEK
- Dates: 2026-03-28 or "28 mars 2026"
- Percent: 12,7 % (space before %)
- Quotes: \u201Ctext\u201D

## Design System Schema Reference
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
  caption: "Revenue by region",
  notes: "All figures in MSEK.",
};

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_template_info",
    description: "CALL THIS FIRST before doing anything else. Returns the complete 4-step workflow guide you MUST follow, module type descriptions, design system schema, HTML template example, required sections for the document type, and guardrails. This is your instruction manual — read it carefully and follow every step.",
    inputSchema: {
      type: "object",
      properties: {
        document_type: { type: "string", enum: ["annual_report", "quarterly", "pitch", "proposal"] },
      },
      required: ["document_type"],
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
    description: "Create a new report document. IMPORTANT: Before calling this you MUST have asked the user about their brand (colors, fonts, tone). You MUST also have asked what content they want in the report. Do NOT call this until you have both brand info AND content from the user.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title" },
        document_type: { type: "string", enum: ["annual_report", "quarterly", "pitch", "proposal"] },
      },
      required: ["title", "document_type"],
    },
  },
  {
    name: "save_design_system",
    description: "Step 1: Save design system based on the user's brand answers. NEVER call this with made-up values — only use colors/fonts/tone the user actually provided. Provide brand_input (raw user answers) AND design_system (structured tokens).",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_input: {
          type: "object",
          description: "Raw brand input from user: { company_name, colors, fonts, tone, logo_url }",
        },
        design_system: {
          type: "object",
          description: "Complete design tokens: { colors: {primary,secondary,accent,text,text_light,bg,bg_alt,surface}, typography: {heading_family,body_family,heading_weight,base_size_pt,line_height,scale[]}, spacing: {base_mm,section_gap_mm,column_gap_mm}, page: {size,margin_top_mm,margin_bottom_mm,margin_inner_mm,margin_outer_mm} }",
        },
      },
      required: ["document_id", "design_system"],
    },
  },
  {
    name: "save_module_plan",
    description: "Step 2: Save module plan based on the user's ACTUAL content. Map their content to module types. NEVER generate fake content — use exactly what the user provided. Ask user to paste content if you don't have it.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        raw_content: { type: "string", description: "The raw text/data the user pasted or described" },
        module_plan: {
          type: "array",
          description: "Ordered modules: { module_type, title, semantic_role?, content?, data? }",
          items: { type: "object" },
        },
      },
      required: ["document_id", "module_plan"],
    },
  },
  {
    name: "save_html",
    description: "Step 3: Save print-ready HTML. Must include CSS Paged Media (@page, size: A4), design tokens as CSS custom properties, mm/pt units, module sections with page-break-after. Validates against guardrails — fix and re-save if issues found.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        html: { type: "string", description: "Complete self-contained HTML document" },
      },
      required: ["document_id", "html"],
    },
  },
  {
    name: "get_preview_url",
    description: "Step 4: Get a preview URL for the document. The user opens this in Chrome and uses Print (Cmd/Ctrl+P) → Save as PDF. The CSS Paged Media rules ensure perfect print layout. No external service or API key needed.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "extract_brand_from_url",
    description: "Extract brand design info from a website URL. Fetches the page HTML/CSS and extracts: color palette (primary, secondary, accent, backgrounds), typography (font families, weights, sizes), spacing patterns, and overall visual tone. Use this when the user provides their company website — it gives you a real starting point for the design system instead of guessing. Returns structured design signals you should use in save_design_system.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Website URL to analyze (e.g. https://example.com)" },
      },
      required: ["url"],
    },
  },
];

// ─── Tool handlers ──────────────────────────────────────────────────────────

async function handleListDocuments(hubUserId) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, document_type, status, created_at, updated_at
    FROM documents
    WHERE hub_user_id = ${hubUserId} AND deleted_at IS NULL
    ORDER BY updated_at DESC
  `;
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
}

async function handleGetDocument(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, document_type, status, brand_input, design_system,
           raw_content, module_plan, html_output, created_at, updated_at
    FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const doc = { ...rows[0] };
  if (doc.html_output && doc.html_output.length > 50000) {
    doc.html_output = doc.html_output.slice(0, 500) + `\n... (${doc.html_output.length} chars total, truncated)`;
  }
  return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
}

async function handleCreateDocument(hubUserId, args) {
  const sql = getSql();

  let stubPlan = [];
  try {
    stubPlan = await getDefaultStubPlan(args.document_type);
  } catch (e) {
    console.warn("[create_document] getDefaultStubPlan failed, using empty plan:", e.message);
  }
  const planWithIds = stubPlan.map((m) => ({ id: randomUUID(), ...m }));

  const rows = await sql`
    INSERT INTO documents (hub_user_id, title, document_type, module_plan, status)
    VALUES (${hubUserId}, ${args.title}, ${args.document_type}::document_type, ${JSON.stringify(planWithIds)}::jsonb, 'draft')
    RETURNING id, title, document_type, status, module_plan, created_at
  `;
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ...rows[0],
        next_step: "Now save the design system (Step 1) using the brand info the user provided.",
      }, null, 2),
    }],
  };
}

async function handleSaveDesignSystem(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    UPDATE documents
    SET
      brand_input = ${JSON.stringify(args.brand_input ?? {})}::jsonb,
      design_system = ${JSON.stringify(args.design_system)}::jsonb,
      status = 'ready'::doc_status,
      updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    RETURNING id, status
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  return {
    content: [{
      type: "text",
      text: `Design system saved for document ${rows[0].id}. Next step: ask user to paste their content, then call save_module_plan.`,
    }],
  };
}

async function handleSaveModulePlan(hubUserId, args) {
  const sql = getSql();

  const docs = await sql`
    SELECT id, document_type FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const planWithIds = args.module_plan.map((m, idx) => ({
    id: m.id ?? randomUUID(),
    order: idx + 1,
    ...m,
  }));

  let merged;
  try {
    merged = await mergeMissingStubs(docs[0].document_type, planWithIds);
  } catch (e) {
    console.warn("[save_module_plan] mergeMissingStubs failed:", e.message);
    merged = { modulePlan: planWithIds, warnings: [] };
  }

  await sql`
    UPDATE documents
    SET
      raw_content = ${args.raw_content ?? null},
      module_plan = ${JSON.stringify(merged.modulePlan)}::jsonb,
      status = 'ready'::doc_status,
      updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        module_count: merged.modulePlan.length,
        warnings: merged.warnings.length > 0
          ? `Auto-added missing required sections: ${merged.warnings.map((w) => w.label).join(", ")}`
          : null,
        next_step: "Now generate the full HTML (Step 3) and call save_html.",
      }, null, 2),
    }],
  };
}

async function handleSaveHtml(hubUserId, args) {
  const sql = getSql();

  const docs = await sql`
    SELECT id FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const validation = validateHtml(args.html);

  await sql`
    UPDATE documents
    SET
      html_output = ${args.html},
      status = ${validation.valid ? "ready" : "error"}::doc_status,
      updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  if (!validation.valid) {
    return {
      content: [{
        type: "text",
        text: `HTML saved but has guardrail issues:\n${validation.issues.map((i) => `- ${i}`).join("\n")}\n\nFix these issues and call save_html again.`,
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: "HTML saved successfully. Call get_preview_url to give the user a link to preview and print to PDF.",
    }],
  };
}

async function handleGetTemplateInfo(hubUserId, args) {
  const sql = getSql();
  const template = await getTemplate(args.document_type);

  let fonts = [];
  try {
    fonts = await sql`
      SELECT family_name, weight, style, format, blob_key
      FROM custom_fonts
      WHERE hub_user_id = ${hubUserId}
      ORDER BY created_at DESC
    `;
  } catch (e) {
    console.warn("[get_template_info] custom_fonts query failed:", e.message);
  }

  const result = {
    workflow_prompt: WORKFLOW_PROMPT,
    module_type_descriptions: MODULE_TYPE_DESCRIPTIONS,
    design_system_schema: DESIGN_SYSTEM_SCHEMA,
    html_template_example: HTML_TEMPLATE_EXAMPLE,
    document_type: args.document_type,
    required_sections: template?.required_sections ?? [],
    default_stub_plan: template?.default_stub_plan ?? [],
    available_module_types: MODULE_TYPES,
    guardrails: GUARDRAILS_PROMPT,
    table_data_schema: TABLE_SCHEMA_EXAMPLE,
    custom_fonts: fonts,
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleGetPreviewUrl(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, html_output, title FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  if (!rows[0].html_output) {
    return { content: [{ type: "text", text: "Document has no HTML yet. Generate HTML first (Step 3)." }], isError: true };
  }

  const key = previewKey(args.document_id);
  const siteUrl = process.env.URL || process.env.DEPLOY_URL || "https://rotor-report-ai.netlify.app";
  const previewUrl = `${siteUrl}/api/preview?id=${args.document_id}&key=${key}`;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        preview_url: previewUrl,
        instructions: "Öppna länken i Chrome. Klicka 'Skriv ut / Spara som PDF' eller tryck Cmd/Ctrl+P. Välj 'Spara som PDF'. CSS Paged Media-reglerna ser till att sidbrytningar, marginaler och layout blir rätt.",
        title: rows[0].title,
      }, null, 2),
    }],
  };
}

async function handleExtractBrandFromUrl(hubUserId, args) {
  const url = args.url;
  if (!url) return { content: [{ type: "text", text: "URL is required" }], isError: true };

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ReportAI/1.0; brand-extraction)",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { content: [{ type: "text", text: `Could not fetch ${url}: HTTP ${response.status}` }], isError: true };
    }

    const html = await response.text();

    // Extract colors from inline styles, style blocks, and common patterns
    const colorPattern = /#(?:[0-9a-fA-F]{3,8})\b/g;
    const rgbPattern = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/g;
    const hslPattern = /hsla?\(\s*\d+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?(?:\s*,\s*[\d.]+)?\s*\)/g;

    const hexColors = [...new Set((html.match(colorPattern) || []))];
    const rgbColors = [...new Set((html.match(rgbPattern) || []))];
    const hslColors = [...new Set((html.match(hslPattern) || []))];

    // Extract font families
    const fontPattern = /font-family\s*:\s*([^;}"]+)/gi;
    const fontMatches = [...html.matchAll(fontPattern)].map(m => m[1].trim());
    const fontFamilies = [...new Set(fontMatches)].slice(0, 10);

    // Extract Google Fonts references
    const googleFontPattern = /fonts\.googleapis\.com\/css2?\?family=([^"&']+)/gi;
    const googleFonts = [...html.matchAll(googleFontPattern)].map(m =>
      decodeURIComponent(m[1]).replace(/\+/g, " ").split("|").map(f => f.split(":")[0].trim())
    ).flat();

    // Extract CSS custom properties (design tokens)
    const cssVarPattern = /--([a-zA-Z0-9_-]+)\s*:\s*([^;}"]+)/g;
    const cssVariables = {};
    for (const match of html.matchAll(cssVarPattern)) {
      cssVariables[match[1].trim()] = match[2].trim();
    }

    // Extract font sizes
    const fontSizePattern = /font-size\s*:\s*([^;}"]+)/gi;
    const fontSizes = [...new Set([...html.matchAll(fontSizePattern)].map(m => m[1].trim()))].slice(0, 15);

    // Extract background colors
    const bgColorPattern = /background(?:-color)?\s*:\s*([^;}"]+)/gi;
    const bgColors = [...new Set([...html.matchAll(bgColorPattern)].map(m => m[1].trim()))].slice(0, 10);

    // Extract meta info
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i);
    const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i);

    // Filter to most likely brand colors (exclude common grays/whites/blacks)
    const isBrandColor = (c) => {
      const lower = c.toLowerCase();
      return !["#fff", "#ffffff", "#000", "#000000", "#333", "#666", "#999", "#ccc", "#eee", "#f5f5f5", "#fafafa"].includes(lower);
    };
    const brandHexColors = hexColors.filter(isBrandColor).slice(0, 15);

    const extraction = {
      source_url: url,
      page_title: titleMatch?.[1]?.trim() || null,
      page_description: descMatch?.[1]?.trim() || null,
      og_image: ogImageMatch?.[1]?.trim() || null,

      colors: {
        hex_colors_found: brandHexColors,
        rgb_colors_found: rgbColors.slice(0, 10),
        hsl_colors_found: hslColors.slice(0, 5),
        background_colors: bgColors,
        suggestion: brandHexColors.length >= 3
          ? `Possible palette: primary=${brandHexColors[0]}, secondary=${brandHexColors[1]}, accent=${brandHexColors[2]}`
          : "Could not determine a clear palette — ask the user to confirm colors.",
      },

      typography: {
        font_families: fontFamilies,
        google_fonts: [...new Set(googleFonts)],
        font_sizes: fontSizes,
        suggestion: fontFamilies.length > 0
          ? `Primary font families found: ${fontFamilies.slice(0, 3).join(", ")}`
          : "No clear font families detected — ask the user.",
      },

      css_design_tokens: Object.keys(cssVariables).length > 0
        ? cssVariables
        : "No CSS custom properties found on this page.",

      instructions_for_claude: [
        "Use the extracted colors and fonts as the STARTING POINT for the design system.",
        "Present these findings to the user: 'Jag hittade dessa färger och typsnitt på er webbplats: [list]. Ska jag använda dem?'",
        "The user may want to adjust — always confirm before saving.",
        "If the extraction is sparse, supplement with tasteful defaults that match the detected tone.",
        "Map the most prominent/repeated color as primary, the next as secondary, and any standout accent color as accent.",
        "For typography: use the first serif font found for headings and first sans-serif for body (or vice versa if the site is sans-first).",
      ],
    };

    return { content: [{ type: "text", text: JSON.stringify(extraction, null, 2) }] };
  } catch (e) {
    return {
      content: [{
        type: "text",
        text: `Could not extract brand info from ${url}: ${e.message}. Ask the user for brand details manually instead.`,
      }],
      isError: true,
    };
  }
}

// ─── Tool dispatch ──────────────────────────────────────────────────────────

const HANDLERS = {
  get_template_info:        handleGetTemplateInfo,
  list_documents:           handleListDocuments,
  get_document:             handleGetDocument,
  create_document:          handleCreateDocument,
  save_design_system:       handleSaveDesignSystem,
  save_module_plan:         handleSaveModulePlan,
  save_html:                handleSaveHtml,
  get_preview_url:          handleGetPreviewUrl,
  extract_brand_from_url:   handleExtractBrandFromUrl,
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
  try {
    rpc = JSON.parse(event.body ?? "{}");
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const { method, params, id } = rpc;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "report-ai", version: "0.2.0" },
    });
  }

  if (method === "notifications/initialized") return rpcResult(id, {});
  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = params?.name ?? "";
    const args = params?.arguments ?? {};
    const toolName = name.startsWith("report__") ? name.slice(8) : name;

    const handlerFn = HANDLERS[toolName];
    if (!handlerFn) return rpcError(id, -32601, `Unknown tool: ${name}`);

    try {
      const result = await handlerFn(hubUserId, args);
      return rpcResult(id, result);
    } catch (e) {
      console.error(`[mcp] tool ${toolName} failed:`, e);
      return rpcError(id, -32000, e.message ?? "Internal error");
    }
  }

  return rpcError(id, -32601, `Method not supported: ${method ?? ""}`);
};
