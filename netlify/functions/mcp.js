/**
 * POST /.netlify/functions/mcp — Report AI MCP endpoint
 *
 * JSON-RPC 2.0 server following the Rotor Platform module contract.
 * Auth: Hub JWT (RS256) in Authorization: Bearer header.
 *
 * Tools are exposed without prefix — the Hub gateway adds "report__" automatically.
 */
import { randomUUID } from "node:crypto";
import { connectLambda, getStore } from "@netlify/blobs";
import { readBearerToken, verifyHubJwt } from "./verify-hub-jwt.js";
import { getSql } from "./db.js";
import { getTemplate, validateModulePlan, mergeMissingStubs, getDefaultStubPlan } from "./document-type-templates.js";
import { GUARDRAILS_PROMPT, validateHtml } from "./guardrails.js";
import { renderFallbackHtml } from "./html-helpers.js";
import {
  computeBrandReadiness,
  hasColorTokens,
  hasTypographyTokens,
  summarizePreflight,
  validateHtmlWithLayoutRules,
} from "./layout-quality.js";

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

function toolResponse(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function detectLanguage(input = "") {
  const text = String(input || "").toLowerCase();
  if (/[åäö]/.test(text) || /\b(och|inte|hur|färg|typsnitt|layout)\b/.test(text)) return "sv";
  return "en";
}

function toUserMessage(language, svMessage, enMessage) {
  return language === "sv" ? svMessage : enMessage;
}

function createAssetStore(event) {
  try {
    connectLambda(event);
    return getStore("report-ai-assets");
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !token) return null;
    return getStore({ name: "report-ai-assets", siteID, token });
  }
}

function buildBlobUrl(key) {
  const baseUrl = process.env.ASSET_BLOB_BASE_URL || process.env.FONT_BLOB_BASE_URL;
  if (!baseUrl) return key;
  return `${baseUrl.replace(/\/$/, "")}/${key}`;
}

function dataUrlToBuffer(maybeDataUrl) {
  const clean = String(maybeDataUrl || "").includes(",") ? String(maybeDataUrl).split(",").pop() : String(maybeDataUrl);
  return Buffer.from(clean || "", "base64");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureLayoutAst(document) {
  if (document.layout_ast && typeof document.layout_ast === "object") return deepClone(document.layout_ast);
  const nodes = (document.module_plan || []).map((module, idx) => ({
    node_id: module.id || `module_${idx + 1}`,
    module_id: module.id || null,
    module_type: module.module_type,
    title: module.title || "",
    content: module.content || "",
    style: module.style || {},
    order: module.order ?? idx + 1,
  }));
  return { version: document.layout_version || 1, nodes };
}

function applyJsonPointerSet(root, pointer, value) {
  if (!pointer || pointer === "/") return value;
  const parts = pointer.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cursor[key] == null || typeof cursor[key] !== "object") {
      const nextKey = parts[i + 1];
      cursor[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    cursor = cursor[key];
  }
  const leaf = parts[parts.length - 1];
  cursor[leaf] = value;
  return root;
}

function applyLayoutPatch(layoutAst, patch) {
  const next = deepClone(layoutAst);
  if (!patch || typeof patch !== "object") return next;

  if (patch.op === "set_json_pointer" && patch.path) {
    return applyJsonPointerSet(next, patch.path, patch.value);
  }

  if (patch.op === "merge_node_style" && patch.node_id && patch.style && Array.isArray(next.nodes)) {
    next.nodes = next.nodes.map((node) => (node.node_id === patch.node_id ? { ...node, style: { ...(node.style || {}), ...patch.style } } : node));
    return next;
  }

  if (patch.op === "update_node_content" && patch.node_id && Array.isArray(next.nodes)) {
    next.nodes = next.nodes.map((node) =>
      node.node_id === patch.node_id ? { ...node, title: patch.title ?? node.title, content: patch.content ?? node.content } : node,
    );
    return next;
  }

  return next;
}

function applyHtmlPatch(html, patch) {
  if (!patch || typeof patch !== "object") return html;
  if (patch.op === "replace_html_fragment" && patch.find != null) {
    return String(html || "").split(String(patch.find)).join(String(patch.replace ?? ""));
  }
  if (patch.op === "append_css_rule" && patch.css) {
    const source = String(html || "");
    if (source.includes("</style>")) {
      return source.replace("</style>", `${patch.css}\n</style>`);
    }
    return `${source}\n<style>\n${patch.css}\n</style>`;
  }
  return html;
}

function missingBrandIntake(brandInput = {}, designSystem = {}) {
  const missing = [];
  if (!brandInput.company_name) missing.push("company_name");
  if (!brandInput.tone) missing.push("tone");
  if (!hasColorTokens(designSystem) && !brandInput.colors) missing.push("colors");
  if (!hasTypographyTokens(designSystem) && !brandInput.fonts) missing.push("fonts");
  return missing;
}

function firstFollowUpQuestion(language, missing) {
  const sv = {
    company_name: "Vad heter företaget exakt som det ska stå i dokumentet?",
    tone: "Vilken tonalitet vill du ha: formell, modern eller kreativ?",
    colors: "Vilka tre huvudfärger vill du att vi använder (primär, sekundär, accent)?",
    fonts: "Vilka typsnitt vill du använda för rubrik och brödtext?",
    design_references: "Har du ett designexempel (screenshot/PDF) att ladda upp som referens?",
    design_examples: "Kan du ladda upp ett designexempel (screenshot eller PDF) så jag kan matcha stilen bättre?",
  };
  const en = {
    company_name: "What is the exact company name to display in the document?",
    tone: "What tone do you want: formal, modern, or creative?",
    colors: "Which three main colors should we use (primary, secondary, accent)?",
    fonts: "Which fonts should we use for heading and body text?",
    design_references: "Do you have a design reference (screenshot/PDF) to upload?",
    design_examples: "Can you upload a design example (screenshot or PDF) so I can match style more accurately?",
  };
  const first = missing[0];
  if (!first) return null;
  return language === "sv" ? sv[first] : en[first];
}

function blockingQuestionResponse(language, missing, reason) {
  return {
    ...toolResponse({
      user_message: reason,
      follow_up_question: firstFollowUpQuestion(language, missing),
      missing,
      technical_details: { blocked: true, missing },
    }),
    isError: true,
  };
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
  "Call `export_pdf` only if PDF export is configured in the environment. If not configured, explain that PDF export is unavailable right now and continue with HTML + preflight guidance.",
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
  "",
  "## Communication Rules",
  "- Always speak in the user's language.",
  "- Be clear and helpful, but avoid heavy technical wording unless asked.",
  "- Ask one focused follow-up at a time when information is missing.",
  "- Offer 2-3 clear choices with short tradeoffs when decisions are needed.",
  "- Summarize what was decided and what happens next after each major step.",
  "",
  "## Safety Rules",
  "- Do not modify OAuth/JWT internals unless explicitly requested by a maintainer.",
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
  {
    name: "check_brand_readiness",
    description: "Check if required brand inputs exist (colors, fonts, design examples). Returns missing fields and confidence.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        language: { type: "string", enum: ["sv", "en"] },
      },
      required: ["document_id"],
    },
  },
  {
    name: "collect_brand_input",
    description: "Save brand answers in a friendly, guided flow. Also stores preferred language for future responses.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_answers: { type: "object" },
        language: { type: "string", enum: ["sv", "en"] },
      },
      required: ["document_id", "brand_answers"],
    },
  },
  {
    name: "upload_design_asset",
    description: "Upload and register design references (screenshots, PDFs, photos, logos) for a document or brand profile.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_profile_id: { type: "string" },
        asset_type: { type: "string", enum: ["design_example", "photo", "logo", "pdf_reference"] },
        filename: { type: "string" },
        mime_type: { type: "string" },
        file_base64: { type: "string" },
        blob_key: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["asset_type", "filename", "mime_type"],
    },
  },
  {
    name: "analyze_design_assets",
    description: "Analyze uploaded references and store structured design signals for AI decisions.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_profile_id: { type: "string" },
      },
    },
  },
  {
    name: "derive_typography_grid",
    description: "Derive an invisible baseline grid and typography constraints from design system + selected fonts.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        brand_profile_id: { type: "string" },
        base_size_pt: { type: "number" },
        line_height: { type: "number" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "create_or_update_brand_profile",
    description: "Create a new brand profile or add a new version with tokens, typography rules and policy mode.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "string" },
        name: { type: "string" },
        document_id: { type: "string" },
        brand_tokens: { type: "object" },
        typography_rules: { type: "object" },
        layout_policy: { type: "object" },
        source_asset_ids: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "suggest_cover_variants",
    description: "Generate a small set of creative but brand-safe cover concepts.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        count: { type: "number" },
        language: { type: "string", enum: ["sv", "en"] },
      },
      required: ["document_id"],
    },
  },
  {
    name: "suggest_layout_patches",
    description: "Suggest local layout improvements for a specific module or issue set, not a full rerender.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        target_module_id: { type: "string" },
        language: { type: "string", enum: ["sv", "en"] },
      },
      required: ["document_id"],
    },
  },
  {
    name: "apply_layout_patches",
    description: "Apply selected local patches to layout_ast and optional HTML fragments.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        patches: { type: "array", items: { type: "object" } },
        applied_by: { type: "string", enum: ["ai", "user"] },
      },
      required: ["document_id", "patches"],
    },
  },
  {
    name: "set_photo_focal_point",
    description: "Set or adjust focal point for a photo asset, used by future crops and placement.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["asset_id", "x", "y"],
    },
  },
  {
    name: "run_layout_preflight",
    description: "Run preflight checks for layout quality and print safety before export.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        language: { type: "string", enum: ["sv", "en"] },
      },
      required: ["document_id"],
    },
  },
];

// ─── Tool handlers ──────────────────────────────────────────────────────────

async function getOwnedDocument(sql, hubUserId, documentId) {
  const rows = await sql`
    SELECT *
    FROM documents
    WHERE id = ${documentId} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function listOwnedAssets(sql, hubUserId, { documentId = null, brandProfileId = null } = {}) {
  return sql`
    SELECT *
    FROM design_assets
    WHERE
      hub_user_id = ${hubUserId}
      AND deleted_at IS NULL
      AND (${documentId}::uuid IS NULL OR document_id = ${documentId}::uuid)
      AND (${brandProfileId}::uuid IS NULL OR brand_profile_id = ${brandProfileId}::uuid)
    ORDER BY created_at DESC
  `;
}

async function evaluateDocumentReadiness(sql, hubUserId, doc) {
  const fonts = await sql`
    SELECT id
    FROM custom_fonts
    WHERE hub_user_id = ${hubUserId}
    LIMIT 1
  `;
  const assets = await listOwnedAssets(sql, hubUserId, { documentId: doc.id });
  return computeBrandReadiness({
    designSystem: doc.design_system,
    fontsCount: fonts.length,
    assets,
  });
}

async function storeLayoutMetrics(sql, documentId, html, issues, extraMetrics = {}) {
  const metrics = { ...summarizePreflight(html, issues), ...extraMetrics };
  await sql`
    INSERT INTO document_layout_metrics (document_id, metrics, issues, updated_at)
    VALUES (${documentId}, ${JSON.stringify(metrics)}::jsonb, ${JSON.stringify(issues)}::jsonb, NOW())
    ON CONFLICT (document_id)
    DO UPDATE SET
      metrics = EXCLUDED.metrics,
      issues = EXCLUDED.issues,
      updated_at = NOW()
  `;
  return metrics;
}

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
           raw_content, module_plan, html_output, brand_profile_id,
           layout_ast, layout_fingerprint, layout_version, decision_context,
           created_at, updated_at
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
  const language = args.language || detectLanguage(args.title);

  const rows = await sql`
    INSERT INTO documents (hub_user_id, title, document_type, module_plan, status, decision_context)
    VALUES (
      ${hubUserId},
      ${args.title},
      ${args.document_type}::document_type,
      ${JSON.stringify(planWithIds)}::jsonb,
      'draft',
      ${JSON.stringify({ preferred_language: language })}::jsonb
    )
    RETURNING id, title, document_type, status, module_plan, created_at
  `;
  return toolResponse({
    user_message: toUserMessage(language, "Dokument skapat. Nu samlar vi in varumärkesunderlag.", "Document created. Next we collect brand input."),
    technical_details: rows[0],
  });
}

async function handleSaveDesignSystem(hubUserId, args) {
  const sql = getSql();
  const language = args.language || detectLanguage(JSON.stringify(args.brand_input || {}));
  const missing = missingBrandIntake(args.brand_input || {}, args.design_system || {});
  if (missing.length > 0) {
    return blockingQuestionResponse(
      language,
      missing,
      toUserMessage(
        language,
        "Jag behöver lite mer underlag innan jag sparar designsystemet.",
        "I need a bit more input before saving the design system.",
      ),
    );
  }
  const rows = await sql`
    UPDATE documents
    SET
      brand_input = ${JSON.stringify(args.brand_input ?? {})}::jsonb,
      design_system = ${JSON.stringify(args.design_system)}::jsonb,
      decision_context = COALESCE(decision_context, '{}'::jsonb) || ${JSON.stringify({
        preferred_language: language,
        brand_input_completed_at: new Date().toISOString(),
      })}::jsonb,
      status = 'ready'::doc_status,
      updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    RETURNING id, status
  `;
  if (!rows[0]) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  return toolResponse({
    user_message: toUserMessage(language, "Designsystem sparat. Vi kan gå vidare till modulplan.", "Design system saved. We can continue to module planning."),
    technical_details: { document_id: rows[0].id, status: rows[0].status },
  });
}

async function handleSaveModulePlan(hubUserId, args) {
  const sql = getSql();

  // Verify ownership and get document type
  const docs = await sql`
    SELECT id, document_type, design_system, brand_input, decision_context FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  const doc = docs[0];
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const language = args.language || doc.decision_context?.preferred_language || detectLanguage(JSON.stringify(doc.brand_input || {}));
  const readiness = await evaluateDocumentReadiness(sql, hubUserId, doc);
  if (!readiness.ok) {
    return blockingQuestionResponse(
      language,
      readiness.missing,
      toUserMessage(
        language,
        "Jag behöver saknade varumärkesdelar innan modulplanen kan låsas.",
        "I need missing brand inputs before module planning can be finalized.",
      ),
    );
  }

  // Assign IDs to modules that don't have them
  const planWithIds = args.module_plan.map((m, idx) => ({
    id: m.id ?? randomUUID(),
    order: idx + 1,
    ...m,
  }));

  // Validate and merge missing required stubs
  const merged = await mergeMissingStubs(doc.document_type, planWithIds);

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
    SELECT id, module_plan, design_system, brand_input, decision_context FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  const doc = docs[0];
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const language = args.language || doc.decision_context?.preferred_language || detectLanguage(JSON.stringify(doc.brand_input || {}));
  const readiness = await evaluateDocumentReadiness(sql, hubUserId, doc);
  if (!readiness.ok) {
    return blockingQuestionResponse(
      language,
      readiness.missing,
      toUserMessage(
        language,
        "Jag behöver saknade varumärkesdelar innan HTML kan sparas.",
        "I need missing brand inputs before HTML can be saved.",
      ),
    );
  }
  if (!Array.isArray(doc.module_plan) || doc.module_plan.length === 0) {
    return {
      ...toolResponse({
        user_message: toUserMessage(language, "Modulplan saknas. Skapa modulplan först.", "Module plan is missing. Create the module plan first."),
        follow_up_question: toUserMessage(language, "Vill du att jag föreslår en modulplan nu?", "Do you want me to suggest a module plan now?"),
        technical_details: { blocked: true, missing: ["module_plan"] },
      }),
      isError: true,
    };
  }

  // Validate HTML against guardrails
  const validation = validateHtml(args.html);
  const layoutIssues = validateHtmlWithLayoutRules(args.html);
  const blockingLayoutIssues = layoutIssues.filter((issue) => issue.severity === "error");
  const hasBlocking = !validation.valid || blockingLayoutIssues.length > 0;

  await sql`
    UPDATE documents
    SET
      html_output = ${args.html},
      status = ${hasBlocking ? "error" : "ready"}::doc_status,
      updated_at = NOW()
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  await storeLayoutMetrics(sql, args.document_id, args.html, layoutIssues);

  if (hasBlocking) {
    const merged = [
      ...(validation.issues || []).map((issue) => `- ${issue}`),
      ...blockingLayoutIssues.map((issue) => `- ${issue.message}`),
    ];
    return {
      content: [{
        type: "text",
        text: `HTML sparad men har blockerande problem:\n${merged.join("\n")}\n\nÅtgärda och kör save_html igen.`,
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
    communication_policy: {
      use_user_language: true,
      keep_non_technical_by_default: true,
      ask_one_question_at_a_time: true,
      include_next_step_summary: true,
    },
    table_data_schema: TABLE_SCHEMA_EXAMPLE,
    custom_fonts: fonts,
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleExportPdf(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT html_output, brand_input, decision_context, design_system, id
    FROM documents
    WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  const doc = rows[0];
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  if (!doc.html_output) return { content: [{ type: "text", text: "Document has no HTML output. Generate HTML first." }], isError: true };

  const language = args.language || doc.decision_context?.preferred_language || detectLanguage(JSON.stringify(doc.brand_input || {}));
  const readiness = await evaluateDocumentReadiness(sql, hubUserId, doc);
  if (!readiness.ok) {
    return blockingQuestionResponse(
      language,
      readiness.missing,
      toUserMessage(
        language,
        "Export stoppad tills saknade varumärkesdelar är ifyllda.",
        "Export blocked until missing brand inputs are completed.",
      ),
    );
  }

  const issues = validateHtmlWithLayoutRules(doc.html_output || "");
  const blocking = issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    return {
      ...toolResponse({
        user_message: toUserMessage(
          language,
          `Export stoppad. Jag hittade ${blocking.length} blockerande preflight-problem.`,
          `Export blocked. I found ${blocking.length} blocking preflight issues.`,
        ),
        follow_up_question: toUserMessage(language, "Vill du att jag föreslår punktpatchar för att lösa dem?", "Do you want me to suggest local patches to fix them?"),
        technical_details: { blocked: true, issues: blocking },
      }),
      isError: true,
    };
  }

  const browserlessToken = process.env.BROWSERLESS_TOKEN;
  const browserlessEndpoint = process.env.BROWSERLESS_ENDPOINT ?? "https://production-sfo.browserless.io/pdf";
  if (!browserlessToken) {
    return toolResponse({
      user_message: toUserMessage(
        language,
        "PDF-export är inte aktiverad i den här miljön just nu. Jag kan fortsätta med HTML och preflight.",
        "PDF export is not enabled in this environment right now. I can continue with HTML and preflight.",
      ),
      follow_up_question: toUserMessage(
        language,
        "Vill du att jag hjälper dig förbättra layouten vidare innan export aktiveras?",
        "Do you want me to keep improving the layout before export is enabled?",
      ),
      technical_details: { blocked: true, reason: "pdf_export_not_configured" },
    });
  }

  try {
    const response = await fetch(`${browserlessEndpoint}?token=${encodeURIComponent(browserlessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html: doc.html_output,
        options: { format: "A4", printBackground: true },
        addScriptTag: [{ url: "https://unpkg.com/pagedjs/dist/paged.polyfill.js" }],
        waitForFunction: "window.PagedPolyfill !== undefined",
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      return toolResponse({
        user_message: toUserMessage(
          language,
          "PDF-exporten gick inte igenom just nu. Innehållet är kvar och vi kan försöka igen.",
          "PDF export did not complete right now. Your content is safe and we can try again.",
        ),
        follow_up_question: toUserMessage(
          language,
          "Vill du att jag kör en ny preflight och sedan gör ett nytt exportförsök?",
          "Do you want me to run preflight again and then retry export?",
        ),
        technical_details: { blocked: true, reason: "browserless_export_failed", details: details.slice(0, 500) },
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer).toString("base64");
    return toolResponse({
      user_message: toUserMessage(language, "PDF-export klar.", "PDF export complete."),
      technical_details: {
        ok: true,
        approx_kb: Math.round(bytes.length * 0.75 / 1024),
        pdf_base64: bytes,
      },
    });
  } catch (error) {
    return toolResponse({
      user_message: toUserMessage(
        language,
        "PDF-export är tillfälligt otillgänglig från den här miljön. Vi kan fortsätta med layout och preflight under tiden.",
        "PDF export is temporarily unavailable from this environment. We can continue with layout and preflight in the meantime.",
      ),
      follow_up_question: toUserMessage(
        language,
        "Vill du att jag fortsätter med designförbättringar tills exporten fungerar?",
        "Do you want me to continue with design improvements until export works?",
      ),
      technical_details: { blocked: true, reason: "network_or_runtime_unavailable", error: error?.message || String(error) },
    });
  }
}

async function handleCheckBrandReadiness(hubUserId, args) {
  const sql = getSql();
  const doc = await getOwnedDocument(sql, hubUserId, args.document_id);
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const fonts = await sql`
    SELECT id
    FROM custom_fonts
    WHERE hub_user_id = ${hubUserId}
    LIMIT 1
  `;
  const assets = await listOwnedAssets(sql, hubUserId, { documentId: doc.id });
  const readiness = computeBrandReadiness({
    designSystem: doc.design_system,
    fontsCount: fonts.length,
    assets,
  });
  const language = args.language || doc.decision_context?.preferred_language || detectLanguage(JSON.stringify(doc.brand_input || {}));

  await sql`
    UPDATE documents
    SET
      status = ${readiness.ok ? "ready" : "analyzing"}::doc_status,
      decision_context = COALESCE(decision_context, '{}'::jsonb) || ${JSON.stringify({
        preferred_language: language,
        readiness,
      })}::jsonb,
      updated_at = NOW()
    WHERE id = ${doc.id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  return toolResponse({
    user_message: readiness.ok
      ? toUserMessage(language, "Allt som behövs för varumärkesstyrning finns på plats.", "All required brand inputs are available.")
      : toUserMessage(
          language,
          `Innan vi går vidare behöver du komplettera: ${readiness.missing.join(", ")}.`,
          `Before continuing, please provide: ${readiness.missing.join(", ")}.`,
        ),
    next_step: readiness.ok
      ? toUserMessage(language, "Fortsätt med modulplan eller cover-förslag.", "Continue with module planning or cover suggestions.")
      : toUserMessage(language, "Lägg till saknade delar så guidar jag dig vidare.", "Add the missing parts and I will guide you."),
    technical_details: readiness,
  });
}

async function handleCollectBrandInput(hubUserId, args) {
  const sql = getSql();
  const doc = await getOwnedDocument(sql, hubUserId, args.document_id);
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const mergedBrandInput = {
    ...(doc.brand_input || {}),
    ...(args.brand_answers || {}),
  };
  const language = args.language || detectLanguage(JSON.stringify(args.brand_answers || {}));

  await sql`
    UPDATE documents
    SET
      brand_input = ${JSON.stringify(mergedBrandInput)}::jsonb,
      decision_context = COALESCE(decision_context, '{}'::jsonb) || ${JSON.stringify({
        preferred_language: language,
        brand_answers_updated_at: new Date().toISOString(),
      })}::jsonb,
      updated_at = NOW()
    WHERE id = ${doc.id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  return toolResponse({
    user_message: toUserMessage(
      language,
      "Tack. Jag har sparat varumärkesunderlaget och använder det i nästa beslut.",
      "Thanks. I saved the brand input and will use it for the next decisions.",
    ),
    technical_details: {
      document_id: doc.id,
      brand_input_keys: Object.keys(mergedBrandInput),
      preferred_language: language,
    },
  });
}

async function handleUploadDesignAsset(hubUserId, args, context) {
  const sql = getSql();
  const assetType = args.asset_type;
  if (!assetType) return { content: [{ type: "text", text: "asset_type is required" }], isError: true };
  if (!args.file_base64 && !args.blob_key) return { content: [{ type: "text", text: "file_base64 or blob_key is required" }], isError: true };

  const filename = args.filename || `asset-${Date.now()}`;
  const mimeType = args.mime_type || "application/octet-stream";
  let blobKey = args.blob_key || null;

  if (!blobKey && args.file_base64) {
    const store = createAssetStore(context.event);
    if (!store) {
      return { content: [{ type: "text", text: "Blob store not configured" }], isError: true };
    }
    const ext = filename.includes(".") ? filename.split(".").pop() : "bin";
    const key = `${hubUserId}/${randomUUID()}.${ext}`;
    await store.set(key, dataUrlToBuffer(args.file_base64), {
      contentType: mimeType,
      metadata: { filename, asset_type: assetType },
    });
    blobKey = buildBlobUrl(key);
  }

  const assetId = randomUUID();
  const rows = await sql`
    INSERT INTO design_assets (
      id, hub_user_id, document_id, brand_profile_id, asset_type, mime_type, filename, blob_key, metadata
    ) VALUES (
      ${assetId},
      ${hubUserId},
      ${args.document_id ?? null}::uuid,
      ${args.brand_profile_id ?? null}::uuid,
      ${assetType},
      ${mimeType},
      ${filename},
      ${blobKey},
      ${JSON.stringify({
        ...(args.metadata || {}),
        uploaded_at: new Date().toISOString(),
      })}::jsonb
    )
    RETURNING *
  `;

  if (assetType === "photo") {
    for (const variant of ["thumb", "preview", "print"]) {
      await sql`
        INSERT INTO asset_derivatives (id, asset_id, variant, blob_key, metadata)
        VALUES (${randomUUID()}, ${assetId}, ${variant}, ${blobKey}, ${JSON.stringify({ autogenerated: true })}::jsonb)
        ON CONFLICT (asset_id, variant) DO NOTHING
      `;
    }
  }

  return toolResponse({
    user_message: "Asset uppladdad och sparad.",
    technical_details: {
      asset_id: rows[0].id,
      asset_type: rows[0].asset_type,
      blob_key: rows[0].blob_key,
    },
  });
}

async function handleAnalyzeDesignAssets(hubUserId, args) {
  const sql = getSql();
  const assets = await listOwnedAssets(sql, hubUserId, {
    documentId: args.document_id ?? null,
    brandProfileId: args.brand_profile_id ?? null,
  });
  if (assets.length === 0) {
    return toolResponse({
      user_message: "Inga assets hittades för analys.",
      technical_details: { analyzed_count: 0 },
    });
  }

  const analyzed = [];
  for (const asset of assets) {
    const analysis = {
      analyzed_at: new Date().toISOString(),
      kind: asset.asset_type,
      layout_hint: asset.mime_type.includes("pdf") ? "multi_page_reference" : "single_surface_reference",
      recommendations: asset.asset_type === "photo" ? ["set_focal_point"] : ["extract_spacing_and_typography"],
    };

    const updated = await sql`
      UPDATE design_assets
      SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ analysis })}::jsonb
      WHERE id = ${asset.id} AND hub_user_id = ${hubUserId}
      RETURNING id, metadata
    `;
    analyzed.push(updated[0]);
  }

  if (args.document_id) {
    const fingerprint = {
      analyzed_at: new Date().toISOString(),
      assets_used: analyzed.length,
      signals: {
        typography: "captured",
        spacing: "captured",
        color_palette: "captured",
      },
    };
    await sql`
      UPDATE documents
      SET
        layout_fingerprint = ${JSON.stringify(fingerprint)}::jsonb,
        status = 'analyzing'::doc_status,
        updated_at = NOW()
      WHERE id = ${args.document_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    `;
  }

  return toolResponse({
    user_message: `Analyserade ${analyzed.length} referensfiler och sparade designsignaler.`,
    technical_details: { analyzed_count: analyzed.length },
  });
}

async function handleDeriveTypographyGrid(hubUserId, args) {
  const sql = getSql();
  const doc = await getOwnedDocument(sql, hubUserId, args.document_id);
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const designSystem = deepClone(doc.design_system || {});
  designSystem.typography = designSystem.typography || {};
  const baseSizePt = Number(args.base_size_pt || designSystem.typography.base_size_pt || 10.5);
  const lineHeight = Number(args.line_height || designSystem.typography.line_height || 1.5);
  const baselineStepPt = Math.round(baseSizePt * lineHeight * 100) / 100;

  const typographyRules = {
    baseline_grid: {
      base_size_pt: baseSizePt,
      line_height: lineHeight,
      baseline_step_pt: baselineStepPt,
      max_line_length_chars: 75,
      min_line_length_chars: 45,
      widow_orphan_control: true,
    },
    generated_at: new Date().toISOString(),
  };

  designSystem.typography.base_size_pt = baseSizePt;
  designSystem.typography.line_height = lineHeight;
  designSystem.typography.baseline_grid = typographyRules.baseline_grid;

  await sql`
    UPDATE documents
    SET
      design_system = ${JSON.stringify(designSystem)}::jsonb,
      decision_context = COALESCE(decision_context, '{}'::jsonb) || ${JSON.stringify({
        typography_grid_derived: true,
      })}::jsonb,
      status = 'ready'::doc_status,
      updated_at = NOW()
    WHERE id = ${doc.id} AND hub_user_id = ${hubUserId}
  `;

  return toolResponse({
    user_message: "Typografisk baseline-grid är beräknad och sparad.",
    technical_details: typographyRules,
  });
}

async function handleCreateOrUpdateBrandProfile(hubUserId, args) {
  const sql = getSql();
  if (args.profile_id) {
    const profiles = await sql`
      SELECT *
      FROM brand_profiles
      WHERE id = ${args.profile_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
      LIMIT 1
    `;
    const profile = profiles[0];
    if (!profile) return { content: [{ type: "text", text: "Brand profile not found" }], isError: true };

    const latest = await sql`
      SELECT version_no
      FROM brand_profile_versions
      WHERE brand_profile_id = ${profile.id}
      ORDER BY version_no DESC
      LIMIT 1
    `;
    const nextVersion = (latest[0]?.version_no ?? 0) + 1;
    const rows = await sql`
      INSERT INTO brand_profile_versions (
        id, brand_profile_id, version_no, brand_tokens, typography_rules, layout_policy, source_asset_ids, notes
      ) VALUES (
        ${randomUUID()},
        ${profile.id},
        ${nextVersion},
        ${JSON.stringify(args.brand_tokens || {})}::jsonb,
        ${JSON.stringify(args.typography_rules || {})}::jsonb,
        ${JSON.stringify(args.layout_policy || { mode: "strict_brand" })}::jsonb,
        ${JSON.stringify(args.source_asset_ids || [])}::jsonb,
        ${args.notes ?? null}
      )
      RETURNING *
    `;
    if (args.name) {
      await sql`
        UPDATE brand_profiles SET name = ${args.name}, updated_at = NOW()
        WHERE id = ${profile.id}
      `;
    }
    return toolResponse({
      user_message: "Ny version av företagsprofilen är sparad.",
      technical_details: { profile_id: profile.id, version_no: rows[0].version_no },
    });
  }

  const doc = args.document_id ? await getOwnedDocument(sql, hubUserId, args.document_id) : null;
  const profileId = randomUUID();
  const profileName = args.name || (doc ? `${doc.title} Brand` : "Brand Profile");
  const profileRows = await sql`
    INSERT INTO brand_profiles (id, hub_user_id, name, status)
    VALUES (${profileId}, ${hubUserId}, ${profileName}, 'active')
    RETURNING *
  `;

  const versionRows = await sql`
    INSERT INTO brand_profile_versions (
      id, brand_profile_id, version_no, brand_tokens, typography_rules, layout_policy, source_asset_ids, notes
    ) VALUES (
      ${randomUUID()},
      ${profileId},
      1,
      ${JSON.stringify(args.brand_tokens || doc?.design_system || {})}::jsonb,
      ${JSON.stringify(args.typography_rules || {})}::jsonb,
      ${JSON.stringify(args.layout_policy || { mode: "strict_brand" })}::jsonb,
      ${JSON.stringify(args.source_asset_ids || [])}::jsonb,
      ${args.notes ?? null}
    )
    RETURNING *
  `;

  if (doc) {
    await sql`
      UPDATE documents
      SET brand_profile_id = ${profileId}, updated_at = NOW()
      WHERE id = ${doc.id} AND hub_user_id = ${hubUserId}
    `;
  }

  return toolResponse({
    user_message: "Företagsprofil skapad och kopplad.",
    technical_details: {
      profile: profileRows[0],
      version: versionRows[0],
    },
  });
}

async function handleSuggestCoverVariants(hubUserId, args) {
  const sql = getSql();
  const doc = await getOwnedDocument(sql, hubUserId, args.document_id);
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const language = args.language || doc.decision_context?.preferred_language || "sv";
  const readiness = await evaluateDocumentReadiness(sql, hubUserId, doc);
  if (!readiness.ok) {
    return blockingQuestionResponse(
      language,
      readiness.missing,
      toUserMessage(
        language,
        "Jag behöver saknade varumärkesdelar innan jag föreslår omslagskoncept.",
        "I need missing brand inputs before suggesting cover concepts.",
      ),
    );
  }
  const count = Math.min(5, Math.max(2, Number(args.count || 3)));
  const primary = doc.design_system?.colors?.primary || "#1A2B5C";
  const accent = doc.design_system?.colors?.accent || "#E8A838";

  const baseVariants = [
    {
      option_id: "cover_editorial_signal",
      name: toUserMessage(language, "Editorial signal", "Editorial signal"),
      summary: toUserMessage(language, "Stor titel med stark toppyta och diskret underrad.", "Large title with strong top field and subtle subtitle."),
      rationale: toUserMessage(language, "Hög tydlighet och tydlig hierarki.", "High clarity and strong hierarchy."),
      token_hints: { primary, accent, density: "airy" },
    },
    {
      option_id: "cover_data_forward",
      name: toUserMessage(language, "Data-first", "Data-first"),
      summary: toUserMessage(language, "Hero-tal i fokus och rubrik under.", "Hero metric first with title below."),
      rationale: toUserMessage(language, "Passar rapporter med tydligt nyckeltal.", "Fits reports with a strong KPI story."),
      token_hints: { primary, accent, density: "balanced" },
    },
    {
      option_id: "cover_photo_frame",
      name: toUserMessage(language, "Foto med ram", "Framed photo"),
      summary: toUserMessage(language, "Helsidesfoto med säker textzon och tydlig kontrastplatta.", "Full-page photo with safe text zone and contrast plate."),
      rationale: toUserMessage(language, "Bra när bildmaterialet är starkt.", "Best when photography is strong."),
      token_hints: { primary, accent, density: "immersive" },
    },
    {
      option_id: "cover_minimal_grid",
      name: toUserMessage(language, "Minimal grid", "Minimal grid"),
      summary: toUserMessage(language, "Mycket luft, strikt grid och små detaljmarkörer.", "High whitespace, strict grid, subtle detail markers."),
      rationale: toUserMessage(language, "Ger premiumkänsla och läsro.", "Premium feel with calm readability."),
      token_hints: { primary, accent, density: "minimal" },
    },
    {
      option_id: "cover_bold_band",
      name: toUserMessage(language, "Bold band", "Bold band"),
      summary: toUserMessage(language, "Tydligt färgband med titel och logotyp för snabb igenkänning.", "Strong color band with title and logo for quick recognition."),
      rationale: toUserMessage(language, "Tydlig varumärkesnärvaro.", "Strong brand presence."),
      token_hints: { primary, accent, density: "bold" },
    },
  ];

  await sql`
    UPDATE documents
    SET status = 'suggesting'::doc_status, updated_at = NOW()
    WHERE id = ${doc.id} AND hub_user_id = ${hubUserId}
  `;

  return toolResponse({
    user_message: toUserMessage(language, "Här är kreativa omslagsförslag. Välj ett alternativ så applicerar jag det.", "Here are cover concepts. Pick one and I will apply it."),
    options: baseVariants.slice(0, count),
    technical_details: { count },
  });
}

async function handleSuggestLayoutPatches(hubUserId, args) {
  const sql = getSql();
  const doc = await getOwnedDocument(sql, hubUserId, args.document_id);
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const language = args.language || doc.decision_context?.preferred_language || "sv";
  if (!doc.html_output) {
    return {
      ...toolResponse({
        user_message: toUserMessage(language, "Jag behöver HTML-utkastet innan jag kan föreslå patchar.", "I need draft HTML before I can suggest patches."),
        follow_up_question: toUserMessage(language, "Vill du att jag hjälper dig skapa HTML-utkastet nu?", "Do you want me to help generate the draft HTML now?"),
        technical_details: { blocked: true, missing: ["html_output"] },
      }),
      isError: true,
    };
  }
  const issues = validateHtmlWithLayoutRules(doc.html_output || "");
  const suggestions = [];

  for (const issue of issues) {
    if (issue.code === "layout.body_margin_zero") {
      suggestions.push({
        suggestion_id: randomUUID(),
        reason: issue.message,
        patch: { op: "append_css_rule", css: "body { margin: 15mm; }" },
      });
    }
    if (issue.code === "layout.page_rule_missing") {
      suggestions.push({
        suggestion_id: randomUUID(),
        reason: issue.message,
        patch: { op: "append_css_rule", css: "@page { size: A4; margin: 20mm; }" },
      });
    }
    if (issue.code === "font.embedded_base64") {
      suggestions.push({
        suggestion_id: randomUUID(),
        reason: issue.message,
        patch: { op: "replace_html_fragment", find: "data:font", replace: "https://fonts.invalid/replaced-font" },
      });
    }
  }

  if (args.target_module_id) {
    suggestions.push({
      suggestion_id: randomUUID(),
      reason: toUserMessage(language, "Öka läsbarhet och luft i vald modul.", "Improve readability and whitespace in the selected module."),
      patch: {
        op: "merge_node_style",
        node_id: args.target_module_id,
        style: { margin_bottom_mm: 10, padding_mm: 6 },
      },
    });
  }

  await sql`
    UPDATE documents
    SET status = 'suggesting'::doc_status, updated_at = NOW()
    WHERE id = ${doc.id} AND hub_user_id = ${hubUserId}
  `;

  return toolResponse({
    user_message:
      suggestions.length > 0
        ? toUserMessage(language, "Här är punktförslag. Välj vilka jag ska applicera.", "Here are local suggestions. Choose which ones to apply.")
        : toUserMessage(language, "Inga akuta patchar behövs just nu.", "No urgent patches are needed right now."),
    suggestions,
    technical_details: { issue_count: issues.length },
  });
}

async function handleApplyLayoutPatches(hubUserId, args) {
  const sql = getSql();
  const doc = await getOwnedDocument(sql, hubUserId, args.document_id);
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };
  if (!Array.isArray(args.patches) || args.patches.length === 0) {
    return { content: [{ type: "text", text: "patches must be a non-empty array" }], isError: true };
  }

  let nextLayoutAst = ensureLayoutAst(doc);
  let nextHtml = doc.html_output || "";
  let nextModulePlan = deepClone(doc.module_plan || []);
  const applied = [];

  for (const patch of args.patches) {
    const kind = patch.op || "unknown";
    if (["set_json_pointer", "merge_node_style", "update_node_content"].includes(kind)) {
      nextLayoutAst = applyLayoutPatch(nextLayoutAst, patch);
    }
    if (["replace_html_fragment", "append_css_rule"].includes(kind)) {
      nextHtml = applyHtmlPatch(nextHtml, patch);
    }
    if (kind === "update_module_content" && patch.module_id) {
      nextModulePlan = nextModulePlan.map((module) =>
        module.id === patch.module_id
          ? { ...module, title: patch.title ?? module.title, content: patch.content ?? module.content }
          : module,
      );
    }

    await sql`
      INSERT INTO document_layout_patches (id, document_id, target_node_id, patch, reason, applied_by)
      VALUES (
        ${randomUUID()},
        ${doc.id},
        ${patch.node_id ?? patch.module_id ?? null},
        ${JSON.stringify(patch)}::jsonb,
        ${patch.reason ?? null},
        ${args.applied_by === "user" ? "user" : "ai"}
      )
    `;
    applied.push({ op: kind, node: patch.node_id ?? patch.module_id ?? null });
  }

  if (!nextHtml && JSON.stringify(nextModulePlan) !== JSON.stringify(doc.module_plan || [])) {
    const fonts = await sql`
      SELECT family_name, weight, style, format, blob_key
      FROM custom_fonts
      WHERE hub_user_id = ${hubUserId}
      ORDER BY created_at DESC
    `;
    nextHtml = renderFallbackHtml({ ...doc, module_plan: nextModulePlan, design_system: doc.design_system || {} }, fonts);
  }

  const nextVersion = (doc.layout_version || 1) + 1;
  await sql`
    UPDATE documents
    SET
      layout_ast = ${JSON.stringify(nextLayoutAst)}::jsonb,
      module_plan = ${JSON.stringify(nextModulePlan)}::jsonb,
      html_output = COALESCE(${nextHtml || null}, html_output),
      layout_version = ${nextVersion},
      status = 'ready'::doc_status,
      updated_at = NOW()
    WHERE id = ${doc.id} AND hub_user_id = ${hubUserId}
  `;

  return toolResponse({
    user_message: "Punktjusteringar applicerade utan full omrendering.",
    technical_details: {
      applied_count: applied.length,
      layout_version: nextVersion,
    },
  });
}

async function handleSetPhotoFocalPoint(hubUserId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM design_assets
    WHERE id = ${args.asset_id} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  const asset = rows[0];
  if (!asset) return { content: [{ type: "text", text: "Asset not found" }], isError: true };

  const metadata = {
    ...(asset.metadata || {}),
    focal_point: { x: args.x, y: args.y },
    focal_point_updated_at: new Date().toISOString(),
  };
  const updated = await sql`
    UPDATE design_assets
    SET metadata = ${JSON.stringify(metadata)}::jsonb
    WHERE id = ${asset.id} AND hub_user_id = ${hubUserId}
    RETURNING id, asset_type, metadata
  `;

  return toolResponse({
    user_message: "Fokalpunkt sparad för fotot.",
    technical_details: updated[0],
  });
}

async function handleRunLayoutPreflight(hubUserId, args) {
  const sql = getSql();
  const doc = await getOwnedDocument(sql, hubUserId, args.document_id);
  if (!doc) return { content: [{ type: "text", text: "Document not found" }], isError: true };

  const language = args.language || doc.decision_context?.preferred_language || "sv";
  const issues = validateHtmlWithLayoutRules(doc.html_output || "");
  const metrics = await storeLayoutMetrics(sql, doc.id, doc.html_output || "", issues, {
    has_layout_ast: Boolean(doc.layout_ast),
  });

  const nextStatus = metrics.blocking_issues > 0 ? "error" : "ready";
  await sql`
    UPDATE documents
    SET status = ${nextStatus}::doc_status, updated_at = NOW()
    WHERE id = ${doc.id} AND hub_user_id = ${hubUserId}
  `;

  return toolResponse({
    user_message:
      metrics.blocking_issues === 0
        ? toUserMessage(language, "Preflight klar. Inga blockerande fel hittades.", "Preflight complete. No blocking issues found.")
        : toUserMessage(
            language,
            `Preflight hittade ${metrics.blocking_issues} blockerande fel som måste fixas innan export.`,
            `Preflight found ${metrics.blocking_issues} blocking issues that must be fixed before export.`,
          ),
    technical_details: { metrics, issues },
  });
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
  check_brand_readiness: handleCheckBrandReadiness,
  collect_brand_input: handleCollectBrandInput,
  upload_design_asset: handleUploadDesignAsset,
  analyze_design_assets: handleAnalyzeDesignAssets,
  derive_typography_grid: handleDeriveTypographyGrid,
  create_or_update_brand_profile: handleCreateOrUpdateBrandProfile,
  suggest_cover_variants: handleSuggestCoverVariants,
  suggest_layout_patches: handleSuggestLayoutPatches,
  apply_layout_patches: handleApplyLayoutPatches,
  set_photo_focal_point: handleSetPhotoFocalPoint,
  run_layout_preflight: handleRunLayoutPreflight,
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
      const result = await handlerFn(hubUserId, args, { event, rpc });
      return rpcResult(id, result);
    } catch (e) {
      console.error(`[mcp] tool ${toolName} failed:`, e);
      return rpcError(id, -32000, e.message ?? "Internal error");
    }
  }

  return rpcError(id, -32601, `Method not supported: ${method ?? ""}`);
};
