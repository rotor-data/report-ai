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
import { getTemplate, validateModulePlan, mergeMissingStubs, getDefaultStubPlan } from "./document-type-templates.js";
import { GUARDRAILS_PROMPT, validateHtml } from "./guardrails.js";

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
  /* ── Design tokens as CSS custom properties ── */
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

  /* ── CSS Paged Media ── */
  @page {
    size: A4;
    margin: 20mm 20mm 25mm 25mm;
    @bottom-center { content: counter(page); font-size: 9pt; color: var(--color-text-light); }
  }
  @page :first { margin: 0; @bottom-center { content: none; } }
  @page :left  { margin-left: 20mm; margin-right: 25mm; }
  @page :right { margin-left: 25mm; margin-right: 20mm; }

  /* ── Base typography ── */
  body { font-family: var(--font-body); font-size: var(--base-size); line-height: var(--line-height); color: var(--color-text); }
  h1 { font-family: var(--font-heading); font-size: 42pt; font-weight: var(--heading-weight); }
  h2 { font-family: var(--font-heading); font-size: 28pt; }
  h3 { font-family: var(--font-heading); font-size: 20pt; }

  /* ── Module classes ── */
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

const WORKFLOW_PROMPT = [
  "## Report AI — 4-Step Document Workflow",
  "",
  "You MUST follow these four steps IN ORDER when creating any document. Never skip steps or jump ahead to HTML generation.",
  "",
  "### Step 1: Brand Extraction",
  "ALWAYS ask the user about their brand before creating anything. Ask for:",
  "- Company name and logo (URL or description)",
  "- Brand colors (primary, secondary, accent) — or ask if they have a brand guide",
  "- Preferred fonts (or let you choose)",
  "- Tone: formal/corporate, modern/clean, creative/bold",
  "- Any existing materials to reference",
  "",
  "Then call `save_design_system` with both brand_input (raw answers) and a complete design_system object following this schema:",
  JSON.stringify(DESIGN_SYSTEM_SCHEMA, null, 2),
  "",
  "Map every design token to a CSS custom property. All colors, font families, sizes, spacing, and page margins must be defined here — the HTML step will consume these tokens exclusively.",
  "",
  "### Step 2: Module Planning",
  "Based on the document type and content, plan which modules to include and in what order. Call `get_template_info` to see required sections for the document type, then call `save_module_plan`.",
  "",
  "Rules:",
  "- cover is always first, back_cover is always last",
  "- Use chapter_break to separate major sections",
  "- Match content to the right module type (financial data → table or financial_summary, key metrics → kpi_grid, narratives → text_spread)",
  '- Include semantic_role (e.g. "ceo_letter", "revenue_table") for each module',
  "- For table modules, structure data using the table_data_schema format",
  "",
  "### Step 3: HTML Generation",
  "Generate a single, self-contained HTML document. Requirements:",
  "- Use CSS Paged Media: @page rules with size: A4, proper margins (inner/outer for binding), page counters",
  "- Convert ALL design system tokens to CSS custom properties in :root",
  "- Use mm units for all physical dimensions (margins, spacing, page heights)",
  "- Use pt units for font sizes",
  '- Each module is a <section class="module module-{type}"> with page-break-after: always',
  "- Cover must be full-bleed (zero @page margin on :first page)",
  "- Tables: use border-collapse, proper alignment (text left, numbers right), total rows bold",
  "- Numbers: format with sv-SE locale (space as thousands separator: 1 234 567)",
  "- No <script> tags, no external resources except fonts",
  "- Minimum font size: 7pt",
  "- Include @font-face declarations if user has custom fonts",
  "- Target 210mm x 297mm (A4) — design every module to fit within page boundaries",
  "",
  "Call `save_html` with the complete HTML. Fix any guardrail issues and re-save if needed.",
  "",
  "### Step 4: PDF Export",
  "Call `export_pdf` to render via Browserless + Pagedjs. The HTML must already be saved.",
  "",
  "## Module Types Reference",
  _MODULE_REF,
  "",
  "## Swedish Document Conventions",
  "- Use sv-SE number formatting: 1 234 567,89 (thin space for thousands, comma for decimals)",
  "- Currency: 48,2 MSEK or 48 200 TSEK",
  '- Dates: 2026-03-28 or "28 mars 2026"',
  "- Percent: 12,7 % (space before %)",
  '- Use Swedish quotes: \u201Ctext\u201D',
].join("\n");

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
    name: "list_documents",
    description: "List all report documents for the current user. Returns id, title, document_type, status, created_at, updated_at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_document",
    description: "Get a single document with all fields: brand_input, design_system, module_plan, html_output, status. Use this to read current state before generating content.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string", description: "UUID of the document" } },
      required: ["document_id"],
    },
  },
  {
    name: "create_document",
    description: "Create a new report document. IMPORTANT: Before calling this, ask the user about their brand identity (colors, fonts, tone, logo). Pre-populates module_plan with required section stubs for the chosen document type. After creating, proceed to save_design_system with the brand info.",
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
    description: "Save a design system (colors, typography, spacing, page layout) to a document. This is Step 1 of the workflow. Provide both the raw brand_input from the user AND a complete design_system object with: colors (primary, secondary, accent, text, text_light, bg, bg_alt, surface), typography (heading_family, body_family, heading_weight, base_size_pt, line_height, scale[]), spacing (base_mm, section_gap_mm, column_gap_mm), page (size, margin_top_mm, margin_bottom_mm, margin_inner_mm, margin_outer_mm). Every token here becomes a CSS custom property in the HTML.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_input: { type: "object", description: "Original brand input from user (colors, fonts, company name, tone)" },
        design_system: {
          type: "object",
          description: "Complete design system: { colors: { primary, secondary, accent, text, bg }, typography: { heading, body, tone }, spacing: { base, section }, page: { size, margin_mm } }",
        },
      },
      required: ["document_id", "design_system"],
    },
  },
  {
    name: "save_module_plan",
    description: "Save a module plan (ordered array of page modules) to a document. This is Step 2 of the workflow. Map your content to the right module types: cover (always first), chapter_break (section dividers), text_spread (narratives), kpi_grid (metrics), table (data), quote_callout (testimonials), financial_summary (key figures), back_cover (always last). Each module needs: module_type, title, semantic_role, content/data. Validates against required sections and auto-adds missing stubs.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        raw_content: { type: "string", description: "The raw content or brief the module plan was based on" },
        module_plan: {
          type: "array",
          description: "Ordered array of modules. Each: { module_type, title, semantic_role?, content?, data? }. For table modules, data must follow the structured table schema.",
          items: { type: "object" },
        },
      },
      required: ["document_id", "module_plan"],
    },
  },
  {
    name: "save_html",
    description: "Save generated print-ready HTML to a document. This is Step 3. The HTML must be a complete, self-contained document with: CSS Paged Media (@page rules, size: A4, page-break-after), design system tokens as CSS custom properties in :root, mm units for physical dimensions, pt for font sizes, each module as <section class='module module-{type}'>, sv-SE number formatting, no <script> tags, min font 7pt. Validates against guardrails — fix issues and re-save if needed.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        html: { type: "string", description: "Complete HTML document with inline CSS and CSS paged media rules" },
      },
      required: ["document_id", "html"],
    },
  },
  {
    name: "get_template_info",
    description: "ALWAYS call this FIRST before doing anything. Returns the complete 4-step workflow guide, module type descriptions, design system schema, HTML template example, required sections for the document type, print guardrails, table data schema, and the user's custom fonts. This is your instruction manual for creating InDesign-quality documents.",
    inputSchema: {
      type: "object",
      properties: {
        document_type: { type: "string", enum: ["annual_report", "quarterly", "pitch", "proposal"] },
      },
      required: ["document_type"],
    },
  },
  {
    name: "export_pdf",
    description: "Export a document as PDF via Browserless + Pagedjs. Requires html_output to be saved first. Returns base64-encoded PDF bytes.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
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

  // Return structured data — truncate html_output if very large
  const doc = { ...rows[0] };
  if (doc.html_output && doc.html_output.length > 50000) {
    doc.html_output = doc.html_output.slice(0, 500) + `\n... (${doc.html_output.length} chars total, truncated)`;
  }
  return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
}

async function handleCreateDocument(hubUserId, args) {
  const sql = getSql();
  const stubPlan = await getDefaultStubPlan(args.document_type);
  const planWithIds = stubPlan.map((m) => ({ id: randomUUID(), ...m }));

  const rows = await sql`
    INSERT INTO documents (hub_user_id, title, document_type, module_plan, status)
    VALUES (${hubUserId}, ${args.title}, ${args.document_type}::document_type, ${JSON.stringify(planWithIds)}::jsonb, 'draft')
    RETURNING id, title, document_type, status, module_plan, created_at
  `;
  return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] };
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
  return { content: [{ type: "text", text: `Design system saved for document ${rows[0].id}` }] };
}

async function handleSaveModulePlan(hubUserId, args) {
  const sql = getSql();

  // Verify ownership and get document type
  const docs = await sql`
    SELECT id, document_type FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  // Assign IDs to modules that don't have them
  const planWithIds = args.module_plan.map((m, idx) => ({
    id: m.id ?? randomUUID(),
    order: idx + 1,
    ...m,
  }));

  // Validate and merge missing required stubs
  const merged = await mergeMissingStubs(docs[0].document_type, planWithIds);

  await sql`
    UPDATE documents
    SET
      raw_content = ${args.raw_content ?? null},
      module_plan = ${JSON.stringify(merged.modulePlan)}::jsonb,
      status = 'ready'::doc_status,
      updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  const result = {
    ok: true,
    module_count: merged.modulePlan.length,
    warnings: merged.warnings.length > 0
      ? `Missing required sections were auto-added as stubs: ${merged.warnings.map((w) => w.label).join(", ")}`
      : null,
  };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleSaveHtml(hubUserId, args) {
  const sql = getSql();

  // Verify ownership
  const docs = await sql`
    SELECT id FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  // Validate HTML against guardrails
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
        text: `HTML saved but has guardrail issues:\n${validation.issues.map((i) => `- ${i}`).join("\n")}\n\nPlease fix these issues and call save_html again.`,
      }],
    };
  }

  return { content: [{ type: "text", text: `HTML saved successfully. Document is ready for PDF export.` }] };
}

async function handleGetTemplateInfo(hubUserId, args) {
  const sql = getSql();
  const template = await getTemplate(args.document_type);

  // Get user's custom fonts
  const fonts = await sql`
    SELECT family_name, weight, style, format, blob_key
    FROM custom_fonts
    WHERE hub_user_id = ${hubUserId}
    ORDER BY created_at DESC
  `;

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

async function handleExportPdf(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT html_output FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  if (!rows[0].html_output) return { content: [{ type: "text", text: "Document has no HTML output. Generate HTML first." }], isError: true };

  const browserlessToken = process.env.BROWSERLESS_TOKEN;
  const browserlessEndpoint = process.env.BROWSERLESS_ENDPOINT ?? "https://production-sfo.browserless.io/pdf";
  if (!browserlessToken) return { content: [{ type: "text", text: "PDF export not configured (BROWSERLESS_TOKEN missing)" }], isError: true };

  const response = await fetch(`${browserlessEndpoint}?token=${encodeURIComponent(browserlessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html: rows[0].html_output,
      options: { format: "A4", printBackground: true },
      addScriptTag: [{ url: "https://unpkg.com/pagedjs/dist/paged.polyfill.js" }],
      waitForFunction: "window.PagedPolyfill !== undefined",
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    return { content: [{ type: "text", text: `PDF export failed: ${details.slice(0, 500)}` }], isError: true };
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer).toString("base64");
  return { content: [{ type: "text", text: `PDF exported successfully (${Math.round(bytes.length * 0.75 / 1024)} KB). Base64 data available.` }] };
}

// ─── Tool dispatch ──────────────────────────────────────────────────────────

const HANDLERS = {
  list_documents:     handleListDocuments,
  get_document:       handleGetDocument,
  create_document:    handleCreateDocument,
  save_design_system: handleSaveDesignSystem,
  save_module_plan:   handleSaveModulePlan,
  save_html:          handleSaveHtml,
  get_template_info:  handleGetTemplateInfo,
  export_pdf:         handleExportPdf,
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

  // ── initialize ──────────────────────────────────────────────────────────
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "report-ai", version: "0.1.0" },
    });
  }

  // ── notifications/initialized ───────────────────────────────────────────
  if (method === "notifications/initialized") {
    return rpcResult(id, {});
  }

  // ── ping ────────────────────────────────────────────────────────────────
  if (method === "ping") {
    return rpcResult(id, {});
  }

  // ── tools/list ──────────────────────────────────────────────────────────
  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  // ── tools/call ──────────────────────────────────────────────────────────
  if (method === "tools/call") {
    const name = params?.name ?? "";
    const args = params?.arguments ?? {};

    // Strip "report__" prefix if Hub gateway included it
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
