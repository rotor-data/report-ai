/**
 * POST /.netlify/functions/mcp-v2 — Report Engine v2 MCP endpoint
 *
 * JSON-RPC 2.0 server for report2__* tools.
 * Auth: Hub JWT (RS256) in Authorization: Bearer header.
 *
 * Architecture:
 *   Modular report builder with column-based layouts,
 *   Python render service for HTML→PDF, and Netlify Blobs for storage.
 */
import { randomUUID } from "node:crypto";
import { readBearerToken, verifyHubJwt } from "./verify-hub-jwt.js";
import { getSql } from "./db.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";
import { createEditorToken } from "./editor-token.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || "http://localhost:8080";

const VALID_MODULE_TYPES = ["cover", "chapter_break", "back_cover", "layout", "freeform"];

const VALID_COLUMNS = ["full", "half", "primary", "sidebar", "thirds", "wide-left", "quarter"];
const MAX_SLOTS = { full: 1, half: 2, primary: 2, sidebar: 2, thirds: 3, "wide-left": 2, quarter: 2 };
const VALID_CATEGORIES = ["text", "data", "media"];

const DEFAULT_HEIGHT_BUDGET_MM = 240;

const FULL_BLEED_TYPES = new Set(["cover", "chapter_break", "back_cover"]);

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

function textResult(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function errorResult(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ─── Render service helper ──────────────────────────────────────────────────

async function callRenderService(path, body, tenantId) {
  const token = mintSmyraRenderToken({ tenantId });
  const res = await fetch(`${RENDER_SERVICE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Render service ${path} returned ${res.status}: ${text}`);
  }
  // /render/pdf returns raw application/pdf bytes; other endpoints return JSON.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/pdf")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { pdf_bytes: buf };
  }
  return res.json();
}

// ─── Blob store helper ──────────────────────────────────────────────────────

async function getBlobStore(storeName, event) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (event) connectLambda(event);
    return getStore(storeName);
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: storeName, siteID, token });
    throw new Error(`Cannot access blob store "${storeName}"`);
  }
}

// ─── Fetch brand context for render calls ───────────────────────────────────

async function fetchBrandContext(sql, brandId) {
  if (!brandId) return { tokens: {}, fonts: [], logos: [] };

  const brands = await sql`SELECT tokens FROM brands WHERE id = ${brandId} LIMIT 1`;
  const tokens = brands[0]?.tokens || {};

  const fonts = await sql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brandId}`;
  const logos = await sql`SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id = ${brandId}`;

  return { tokens, fonts, logos };
}

// ─── TOOLS array ────────────────────────────────────────────────────────────

const TOOLS = [
  // ── CRUD ──
  {
    name: "create",
    description: "Create a new v2 report.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string", description: "Tenant UUID" },
        brand_id: { type: "string", description: "Brand UUID" },
        title: { type: "string" },
        document_type: { type: "string" },
        template_id: { type: "string", description: "Optional template ID" },
      },
      required: ["tenant_id", "brand_id", "title", "document_type"],
    },
  },
  {
    name: "add_module",
    description: "Add a module to a report. Two modes: (1) html_content — provide Claude-authored HTML using the design system CSS classes. Use module_type='freeform'. (2) Legacy — provide module_type + content JSON for Jinja2 template rendering.",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string" },
        module_type: { type: "string", enum: VALID_MODULE_TYPES },
        html_content: { type: "string", description: "Claude-authored HTML using design system classes. When provided, content/style are ignored." },
        content: { type: "object", description: "Legacy: module content payload for Jinja2 templates" },
        style: { type: "object", description: "Optional style overrides (legacy path)" },
        after_module_id: { type: "string", description: "Insert after this module (null = first)" },
      },
      required: ["report_id", "module_type"],
    },
  },
  {
    name: "update_module",
    description: "Update a module. Provide html_content for freeform modules, or content/style for legacy modules. Re-renders HTML cache.",
    inputSchema: {
      type: "object",
      properties: {
        module_id: { type: "string" },
        html_content: { type: "string", description: "Claude-authored HTML (replaces existing html_content)" },
        content: { type: "object" },
        style: { type: "object" },
      },
      required: ["module_id"],
    },
  },
  {
    name: "move_module",
    description: "Reorder a module within the report.",
    inputSchema: {
      type: "object",
      properties: {
        module_id: { type: "string" },
        after_module_id: { type: "string", description: "Place after this module. Omit or null for first position." },
      },
      required: ["module_id"],
    },
  },
  {
    name: "delete_module",
    description: "Delete a module from the report.",
    inputSchema: {
      type: "object",
      properties: { module_id: { type: "string" } },
      required: ["module_id"],
    },
  },
  {
    name: "get_structure",
    description: "Get full report structure: report metadata, pages, and modules as a JSON tree.",
    inputSchema: {
      type: "object",
      properties: { report_id: { type: "string" } },
      required: ["report_id"],
    },
  },

  // ── Page Builder + PDF ──
  {
    name: "build_pages",
    description: "Run page builder algorithm: assigns modules to pages based on height budget (240mm default). Full-bleed modules get their own page.",
    inputSchema: {
      type: "object",
      properties: { report_id: { type: "string" } },
      required: ["report_id"],
    },
  },
  {
    name: "render_pdf",
    description: "Generate PDF via Python render service. Stores result in Netlify Blobs.",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string" },
        mode: { type: "string", enum: ["draft", "final"], description: "Draft includes watermark" },
      },
      required: ["report_id", "mode"],
    },
  },
  {
    name: "render_module_thumbnails",
    description: "Render each built module in a report as an individual PNG thumbnail. Returns per-module thumbnail URLs so the workflow can show per-module design previews for user approval before final PDF assembly.",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string", description: "Report UUID" },
      },
      required: ["report_id"],
    },
  },
  {
    name: "preview_plan",
    description: "Render a stub PDF from a plan_structure plan (no DB writes) and return per-module thumbnail URLs. Used by workflow plan-review steps to show visual previews before build_modules runs. Each plan module is converted to stub content (heading/body_sketch text becomes the rendered content) and rendered through the same Python service as final reports.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string", description: "Brand UUID for tokens/fonts/logos" },
        tenant_id: { type: "string", description: "Tenant UUID for blob namespacing" },
        template_id: { type: "string", description: "Optional template ID, defaults to standard-v1" },
        plan: {
          type: "array",
          description: "Plan modules (same shape as report2.plan_structure output): {local_id, module_type, title, summary?, column_preset?, slots?}",
          items: { type: "object" },
        },
      },
      required: ["brand_id", "plan"],
    },
  },
  {
    name: "get_editor_url",
    description: "Get a signed editor URL for the visual report editor.",
    inputSchema: {
      type: "object",
      properties: { report_id: { type: "string" } },
      required: ["report_id"],
    },
  },

  // ── Brand + Assets ──
  {
    name: "save_brand_tokens",
    description: "Save or update brand design tokens (colors, typography, spacing).",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string" },
        tokens: { type: "object", description: "Brand design tokens JSONB" },
      },
      required: ["brand_id", "tokens"],
    },
  },
  {
    name: "get_brand_tokens",
    description: "Get brand design tokens.",
    inputSchema: {
      type: "object",
      properties: { brand_id: { type: "string" } },
      required: ["brand_id"],
    },
  },
  {
    name: "upload_font",
    description: "Upload a font file for a brand.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string" },
        family: { type: "string" },
        weight: { type: "integer" },
        style: { type: "string", enum: ["normal", "italic"] },
        format: { type: "string", enum: ["woff2", "woff", "ttf", "otf"] },
        data_base64: { type: "string" },
      },
      required: ["brand_id", "family", "weight", "style", "format", "data_base64"],
    },
  },
  {
    name: "upload_logo",
    description: "Upload a logo variant for a brand.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string" },
        variant: { type: "string", description: "e.g. primary, monochrome, icon" },
        format: { type: "string", enum: ["svg", "png", "jpg"] },
        data_base64: { type: "string" },
      },
      required: ["brand_id", "variant", "format", "data_base64"],
    },
  },
  {
    name: "upload_asset",
    description: "Upload an image asset (photo, icon, SVG) for a tenant.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        filename: { type: "string" },
        mime_type: { type: "string" },
        data_base64: { type: "string" },
      },
      required: ["tenant_id", "filename", "mime_type", "data_base64"],
    },
  },

  {
    name: "list_assets",
    description: "List uploaded image assets for a tenant. Returns asset_id, filename, mime_type, asset_class (photo/icon/svg), and storage_url. Use to discover available images for placing in report components.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string" },
        asset_class: { type: "string", description: "Filter by class: photo, icon, svg. Omit for all." },
      },
      required: ["tenant_id"],
    },
  },

  // ── Brands ──
  {
    name: "list_brands",
    description: "List brands belonging to a tenant. Used by the workflow runner to resolve a brand_id at workflow start.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string", description: "Tenant UUID to filter by" },
      },
      required: ["tenant_id"],
    },
  },

  // ── Templates + Blueprints ──
  {
    name: "list_templates",
    description: "List available report templates.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_stub_plan",
    description: "Get the default module stub plan for a document type. Returns an ordered list of modules (cover, text_spread, kpi_grid, etc.) that form the standard structure for this document type.",
    inputSchema: {
      type: "object",
      properties: {
        document_type: { type: "string", description: "Document type key (e.g. quarterly, annual_report, pitch, case_study)" },
      },
      required: ["document_type"],
    },
  },
  {
    name: "get_module_schema",
    description: "Get JSON schema for module types and slot categories. Optionally filter by template or module type.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: { type: "string" },
        module_type: { type: "string", enum: VALID_MODULE_TYPES },
      },
    },
  },
  {
    name: "save_blueprint",
    description: "Save a report's structure as a reusable blueprint (keeps styles, removes content).",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string" },
        name: { type: "string" },
      },
      required: ["report_id", "name"],
    },
  },
  {
    name: "list_blueprints",
    description: "List saved blueprints for a brand.",
    inputSchema: {
      type: "object",
      properties: { brand_id: { type: "string" } },
      required: ["brand_id"],
    },
  },
  {
    name: "create_from_blueprint",
    description: "Create a new report from a saved blueprint.",
    inputSchema: {
      type: "object",
      properties: {
        blueprint_id: { type: "string" },
        title: { type: "string" },
        document_type: { type: "string" },
      },
      required: ["blueprint_id", "title", "document_type"],
    },
  },

  // ── Component library ──
  {
    name: "save_component",
    description: "Save or update a reusable HTML component in a brand's component library. Components are small HTML templates (~10-30 lines) with {{PLACEHOLDER}} tokens. A brand can have multiple NAMED VARIANTS of the same component_type (e.g. 'Bold', 'Minimal', 'Editorial' headings) — pass `variant_name` to distinguish them. Set is_default=true to make one variant the default for its component_type. Pass component_id to update an existing component.",
    inputSchema: {
      type: "object",
      properties: {
        component_id: { type: "string", description: "Existing component ID to update (omit for new component)" },
        brand_id: { type: "string" },
        component_type: { type: "string", description: "Canonical component type id (validated in application code, DB constraint relaxed)." },
        variant_name: { type: "string", description: "Named variant of this component_type (e.g. 'Bold', 'Minimal', 'Editorial'). Defaults to 'Default'. Two components with the same (component_type, variant_name) for the same brand are NOT allowed — use component_id to update existing." },
        label: { type: "string", description: "Human-readable name, e.g. 'KPI-grupp med accent-border'" },
        html_template: { type: "string", description: "HTML with {{PLACEHOLDER}} tokens using design system CSS classes" },
        placeholder_schema: { type: "array", items: { type: "object" }, description: "Array of {name, required?, type?} describing placeholders" },
        design_notes: { type: "string", description: "Art director notes explaining the design choices" },
        source: { type: "string", enum: ["extraction", "report", "manual"] },
        is_default: { type: "boolean", description: "Set as default variant for this component_type+brand. Clears default flag on other variants of the same type." },
        extraction_id: { type: "string", description: "Optional design_extractions row this component was derived from" },
        is_public: { type: "boolean", description: "If true, any brand may fork this component into their own library" },
        unsplash_query: { type: "string", description: "Semantic hint for image placeholders, e.g. 'corporate boardroom blue'" },
        reference_page_numbers: { type: "array", items: { type: "integer" }, description: "Page numbers in the source PDF where this component appears" },
      },
      required: ["brand_id", "component_type", "label", "html_template"],
    },
  },
  {
    name: "list_components",
    description: "List components in a brand's component library. Returns all named variants per component_type. Filter by component_type to narrow results. Optionally include public components shared by other brands.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string" },
        component_type: { type: "string", description: "Filter by type (optional)" },
        variant_name: { type: "string", description: "Filter to one specific variant (optional)" },
        include_public: { type: "boolean", description: "Also include is_public=true components from other brands" },
        extraction_id: { type: "string", description: "Filter to one specific extraction session" },
      },
      required: ["brand_id"],
    },
  },
  {
    name: "fork_component",
    description: "Copy a component from any brand's library (must be is_public=true if the source brand differs) into the target brand's library. Returns the new component_id. Use this to reuse a McKinsey-style pullquote designed for brand A in brand B's reports.",
    inputSchema: {
      type: "object",
      properties: {
        source_component_id: { type: "string" },
        target_brand_id: { type: "string" },
        label: { type: "string", description: "Optional new label for the forked copy" },
        is_default: { type: "boolean", description: "Mark as default for this type in the target brand" },
      },
      required: ["source_component_id", "target_brand_id"],
    },
  },
  {
    name: "create_design_extraction",
    description: "Create a new design_extractions row for storing reference-PDF design tokens and component inventory. This is the ONLY safe place to store colors/fonts extracted from a reference document. Do NOT call save_brand_tokens with reference colors — they would overwrite the real brand. The extraction can later be promoted to brand tokens via apply_design_extraction if the user explicitly wants it.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string", description: "Brand that will own the extracted components" },
        label: { type: "string", description: "Human-readable label, e.g. 'McKinsey Global AI Report 2025'" },
        source_description: { type: "string", description: "Where the reference came from (URL, filename)" },
        suggested_tokens: { type: "object", description: "Initial token overlay (colors, fonts). Same shape as brands.tokens." },
        inventory: { type: "array", items: { type: "object" }, description: "Initial component inventory (optional — can be filled in later via update_design_extraction)" },
        reference_pages: { type: "array", items: { type: "object" }, description: "Rasterized page refs [{page, url, key}]" },
      },
      required: ["brand_id", "label"],
    },
  },
  {
    name: "update_design_extraction",
    description: "Update a design_extractions row. Use to add/replace suggested_tokens, inventory, reference_pages, or change status ('draft' → 'ready' → 'applied').",
    inputSchema: {
      type: "object",
      properties: {
        extraction_id: { type: "string" },
        label: { type: "string" },
        source_description: { type: "string" },
        suggested_tokens: { type: "object" },
        inventory: { type: "array", items: { type: "object" } },
        reference_pages: { type: "array", items: { type: "object" } },
        status: { type: "string", enum: ["draft", "ready", "applied", "archived"] },
      },
      required: ["extraction_id"],
    },
  },
  {
    name: "get_design_extraction",
    description: "Fetch a design_extractions row by id, including suggested_tokens, inventory, and reference_pages.",
    inputSchema: {
      type: "object",
      properties: { extraction_id: { type: "string" } },
      required: ["extraction_id"],
    },
  },
  {
    name: "list_design_extractions",
    description: "List all design_extractions for a brand.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string" },
        status: { type: "string", enum: ["draft", "ready", "applied", "archived"] },
      },
      required: ["brand_id"],
    },
  },
  {
    name: "apply_design_extraction",
    description: "EXPLICIT user action — promotes an extraction's suggested_tokens onto the real brand.tokens. This is the ONLY path that changes a brand's colors/fonts from reference data. Requires explicit user confirmation. Sets extraction.status='applied'.",
    inputSchema: {
      type: "object",
      properties: {
        extraction_id: { type: "string" },
        token_keys: { type: "array", items: { type: "string" }, description: "Optional — only apply these keys (default: all keys in suggested_tokens)" },
      },
      required: ["extraction_id"],
    },
  },
  {
    name: "get_component",
    description: "Get a single component with its full HTML template.",
    inputSchema: {
      type: "object",
      properties: {
        component_id: { type: "string" },
      },
      required: ["component_id"],
    },
  },
  {
    name: "render_component_preview",
    description: "Render a component with placeholder values (or lorem ipsum defaults) and return the measured height. Useful for previewing a component before adding it to a report.",
    inputSchema: {
      type: "object",
      properties: {
        component_id: { type: "string", description: "Existing component ID (fetches template from DB)" },
        html_template: { type: "string", description: "Or provide HTML directly (for preview before saving)" },
        brand_id: { type: "string", description: "Required when using html_template directly" },
        placeholder_values: { type: "object", description: "Key-value map to fill {{PLACEHOLDER}} tokens" },
      },
    },
  },

  // ── Lager 2 (meta-code) ──
  {
    name: "rasterize_pdf",
    description: "Convert PDF pages to PNG images via the Python render service.",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string" },
        pages: { type: "array", items: { type: "integer" }, description: "Page numbers to rasterize (omit for all)" },
      },
      required: ["report_id"],
    },
  },
  {
    name: "request_upload",
    description: "Generate a one-time upload link for the user. Use this when the user wants to provide a PDF or image as a reference document but it's too large to include in the conversation. Returns a URL where the user can drag-and-drop their file. After they confirm the upload is done, use the returned upload_token with extract_design_from_pdf or other tools.",
    inputSchema: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "Brief description shown to user, e.g. 'reference PDF for design extraction'" },
      },
    },
  },
  {
    name: "check_upload",
    description: "Check if a file has been uploaded via a previously generated upload link.",
    inputSchema: {
      type: "object",
      properties: {
        upload_token: { type: "string", description: "Token from request_upload" },
      },
      required: ["upload_token"],
    },
  },
  {
    name: "extract_design_from_pdf",
    description: "LAYER 2 META-TOOL. Extract brand design tokens from a reference PDF. Provide upload_token (from request_upload), source_url, or pdf_base64. The server analyzes the PDF structure directly — no images needed.",
    inputSchema: {
      type: "object",
      properties: {
        upload_token: { type: "string", description: "Token from request_upload (preferred for user-uploaded files)" },
        source_url: { type: "string", description: "URL to the PDF document" },
        pdf_base64: { type: "string", description: "Base64-encoded PDF (ONLY for small documents < 1MB)" },
        brand_id: { type: "string", description: "Brand to save tokens to" },
        pages: { type: "array", items: { type: "integer" }, description: "Page numbers to analyze (default: first 10)" },
      },
      required: ["brand_id"],
    },
  },
  {
    name: "generate_template",
    description: "LAYER 2 META-TOOL. Returns an instruction chain to analyze a reference HTML file and generate a token-based Jinja2 template variant.",
    inputSchema: {
      type: "object",
      properties: {
        reference_html: { type: "string", description: "Reference HTML document to analyze" },
        template_name: { type: "string", description: "Name for the new template (e.g. 'editorial-v1')" },
      },
      required: ["reference_html", "template_name"],
    },
  },
  {
    name: "debug_rendering",
    description: "LAYER 2 META-TOOL. Returns an instruction chain to debug a rendering issue for a specific module. Claude inspects the module, renders it, rasterizes the output, and suggests a fix.",
    inputSchema: {
      type: "object",
      properties: {
        module_id: { type: "string" },
        issue: { type: "string", description: "Optional description of the problem" },
      },
      required: ["module_id"],
    },
  },
  {
    name: "create_slot_variant",
    description: "LAYER 2 META-TOOL. Returns an instruction chain to design a new slot content variant (within text/data/media categories).",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["text", "data", "media"] },
        description: { type: "string", description: "What the new variant should do" },
        example_content: { type: "object", description: "Example content payload for the new variant" },
      },
      required: ["category", "description"],
    },
  },
];

// ─── Handler: create ────────────────────────────────────────────────────────

async function handleCreate(userId, args) {
  const sql = getSql();
  const { tenant_id, brand_id, title, document_type, template_id } = args;
  if (!tenant_id || !brand_id || !title || !document_type) {
    return errorResult("tenant_id, brand_id, title, and document_type are required.");
  }

  const rows = await sql`
    INSERT INTO v2_reports (tenant_id, brand_id, template_id, title, document_type, status)
    VALUES (${tenant_id}, ${brand_id}, ${template_id || null}, ${title}, ${document_type}, 'draft')
    RETURNING id, tenant_id, brand_id, template_id, title, document_type, status, created_at
  `;
  return textResult({ report_id: rows[0].id, ...rows[0], next_step: "Add modules with report2__add_module." });
}

// ─── Handler: add_module ────────────────────────────────────────────────────

async function handleAddModule(userId, args) {
  const sql = getSql();
  const { report_id, module_type, content, style, after_module_id, html_content } = args;

  if (!report_id || !module_type) {
    return errorResult("report_id and module_type are required.");
  }
  if (!html_content && !content) {
    return errorResult("Either html_content or content is required.");
  }
  if (!VALID_MODULE_TYPES.includes(module_type)) {
    return errorResult(`Invalid module_type. Must be one of: ${VALID_MODULE_TYPES.join(", ")}`);
  }

  // Validate layout columns (only for legacy path, skip for freeform/html_content)
  if (module_type === "layout" && !html_content) {
    const columns = content.columns;
    if (!columns || !VALID_COLUMNS.includes(columns)) {
      return errorResult(`Layout modules require content.columns to be one of: ${VALID_COLUMNS.join(", ")}`);
    }
    const slots = content.slots;
    if (slots && Array.isArray(slots)) {
      if (slots.length > MAX_SLOTS[columns]) {
        return errorResult(`Column preset "${columns}" supports max ${MAX_SLOTS[columns]} slots, got ${slots.length}.`);
      }
      for (const slot of slots) {
        if (slot.category && !VALID_CATEGORIES.includes(slot.category)) {
          return errorResult(`Invalid slot category "${slot.category}". Must be one of: ${VALID_CATEGORIES.join(", ")}`);
        }
      }
    }
  }

  // Verify report exists and get brand_id + tenant_id
  const reports = await sql`SELECT id, brand_id, tenant_id FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);
  const brandId = reports[0].brand_id;
  const tenantId = reports[0].tenant_id;

  // Determine order_index
  let orderIndex;
  if (after_module_id) {
    const afterMods = await sql`
      SELECT order_index FROM v2_report_modules WHERE id = ${after_module_id} AND report_id = ${report_id} LIMIT 1
    `;
    if (!afterMods.length) return errorResult(`Module ${after_module_id} not found in report.`);
    const afterIdx = afterMods[0].order_index;
    // Shift subsequent modules
    await sql`
      UPDATE v2_report_modules SET order_index = order_index + 1
      WHERE report_id = ${report_id} AND order_index > ${afterIdx}
    `;
    orderIndex = afterIdx + 1;
  } else {
    const maxRows = await sql`
      SELECT COALESCE(MAX(order_index), -1) AS max_idx FROM v2_report_modules WHERE report_id = ${report_id}
    `;
    orderIndex = maxRows[0].max_idx + 1;
  }

  // Insert module
  const moduleId = randomUUID();
  await sql`
    INSERT INTO v2_report_modules (id, report_id, module_type, order_index, content, style, html_content)
    VALUES (${moduleId}, ${report_id}, ${module_type}, ${orderIndex},
            ${JSON.stringify(content || {})}::jsonb, ${JSON.stringify(style || {})}::jsonb,
            ${html_content || null})
  `;

  // Call Python render service for html_cache + height_mm
  let heightMm = null;
  try {
    const brand = await fetchBrandContext(sql, brandId);
    const renderPayload = html_content
      ? { html_content, brand_tokens: brand.tokens, brand_fonts: brand.fonts, mode: 'draft' }
      : { module_type, content, style: style || {}, brand_tokens: brand.tokens, brand_fonts: brand.fonts };
    const renderResult = await callRenderService("/render/module", renderPayload, tenantId);
    heightMm = renderResult.height_mm ?? null;
    const htmlCache = renderResult.html_fragment ?? renderResult.html ?? null;
    await sql`
      UPDATE v2_report_modules SET html_cache = ${htmlCache}, height_mm = ${heightMm}
      WHERE id = ${moduleId}
    `;
  } catch (e) {
    console.warn(`[mcp-v2] Render failed for module ${moduleId}:`, e.message);
  }

  return textResult({ module_id: moduleId, order_index: orderIndex, height_mm: heightMm });
}

// ─── Handler: update_module ─────────────────────────────────────────────────

async function handleUpdateModule(userId, args) {
  const sql = getSql();
  const { module_id, content, style, html_content } = args;
  if (!module_id) return errorResult("module_id is required.");
  if (!content && !style && !html_content) return errorResult("At least one of html_content, content, or style is required.");

  // Get existing module + report brand + tenant
  const mods = await sql`
    SELECT m.id, m.report_id, m.module_type, m.content, m.style, m.html_content, r.brand_id, r.tenant_id
    FROM v2_report_modules m
    JOIN v2_reports r ON r.id = m.report_id
    WHERE m.id = ${module_id}
    LIMIT 1
  `;
  if (!mods.length) return errorResult(`Module ${module_id} not found.`);
  const mod = mods[0];

  const newContent = content || mod.content;
  const newStyle = style || mod.style;
  const newHtmlContent = html_content !== undefined ? html_content : mod.html_content;

  // Update module, invalidate cache
  await sql`
    UPDATE v2_report_modules
    SET content = ${JSON.stringify(newContent)}::jsonb,
        style = ${JSON.stringify(newStyle)}::jsonb,
        html_content = ${newHtmlContent || null},
        html_cache = NULL,
        height_mm = NULL
    WHERE id = ${module_id}
  `;

  // Re-render
  let heightMm = null;
  try {
    const brand = await fetchBrandContext(sql, mod.brand_id);
    const renderPayload = newHtmlContent
      ? { html_content: newHtmlContent, brand_tokens: brand.tokens, brand_fonts: brand.fonts, mode: 'draft' }
      : { module_type: mod.module_type, content: newContent, style: newStyle, brand_tokens: brand.tokens, brand_fonts: brand.fonts };
    const renderResult = await callRenderService("/render/module", renderPayload, mod.tenant_id);
    heightMm = renderResult.height_mm ?? null;
    const htmlCache = renderResult.html_fragment ?? renderResult.html ?? null;
    await sql`
      UPDATE v2_report_modules SET html_cache = ${htmlCache}, height_mm = ${heightMm}
      WHERE id = ${module_id}
    `;
  } catch (e) {
    console.warn(`[mcp-v2] Re-render failed for module ${module_id}:`, e.message);
  }

  return textResult({ module_id, height_mm: heightMm });
}

// ─── Handler: move_module ───────────────────────────────────────────────────

async function handleMoveModule(userId, args) {
  const sql = getSql();
  const { module_id, after_module_id } = args;
  if (!module_id) return errorResult("module_id is required.");

  const mods = await sql`
    SELECT id, report_id, order_index FROM v2_report_modules WHERE id = ${module_id} LIMIT 1
  `;
  if (!mods.length) return errorResult(`Module ${module_id} not found.`);
  const { report_id, order_index: oldIdx } = mods[0];

  // Remove from current position
  await sql`
    UPDATE v2_report_modules SET order_index = order_index - 1
    WHERE report_id = ${report_id} AND order_index > ${oldIdx}
  `;

  // Determine new position
  let newIdx;
  if (after_module_id) {
    const afterMods = await sql`
      SELECT order_index FROM v2_report_modules WHERE id = ${after_module_id} AND report_id = ${report_id} LIMIT 1
    `;
    if (!afterMods.length) return errorResult(`Module ${after_module_id} not found in report.`);
    newIdx = afterMods[0].order_index + 1;
  } else {
    newIdx = 0;
  }

  // Shift to make room
  await sql`
    UPDATE v2_report_modules SET order_index = order_index + 1
    WHERE report_id = ${report_id} AND order_index >= ${newIdx} AND id != ${module_id}
  `;

  await sql`UPDATE v2_report_modules SET order_index = ${newIdx} WHERE id = ${module_id}`;

  return textResult({ module_id, new_order_index: newIdx });
}

// ─── Handler: delete_module ─────────────────────────────────────────────────

async function handleDeleteModule(userId, args) {
  const sql = getSql();
  const { module_id } = args;
  if (!module_id) return errorResult("module_id is required.");

  const mods = await sql`
    SELECT report_id, order_index FROM v2_report_modules WHERE id = ${module_id} LIMIT 1
  `;
  if (!mods.length) return errorResult(`Module ${module_id} not found.`);
  const { report_id, order_index } = mods[0];

  await sql`DELETE FROM v2_report_modules WHERE id = ${module_id}`;

  // Re-index remaining modules
  await sql`
    UPDATE v2_report_modules SET order_index = order_index - 1
    WHERE report_id = ${report_id} AND order_index > ${order_index}
  `;

  return textResult({ deleted: module_id });
}

// ─── Handler: get_structure ─────────────────────────────────────────────────

async function handleGetStructure(userId, args) {
  const sql = getSql();
  const { report_id } = args;
  if (!report_id) return errorResult("report_id is required.");

  const reports = await sql`
    SELECT id, tenant_id, brand_id, template_id, title, document_type, status, created_at, updated_at
    FROM v2_reports WHERE id = ${report_id} LIMIT 1
  `;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);
  const report = reports[0];

  const pages = await sql`
    SELECT id, page_number, page_type, created_at
    FROM v2_report_pages WHERE report_id = ${report_id}
    ORDER BY page_number
  `;

  const modules = await sql`
    SELECT id, page_id, module_type, order_index, content, style, html_cache, height_mm, created_at, updated_at
    FROM v2_report_modules WHERE report_id = ${report_id}
    ORDER BY order_index
  `;

  // Build tree: pages with their modules
  const pageMap = new Map();
  for (const p of pages) {
    pageMap.set(p.id, { ...p, modules: [] });
  }
  const unassigned = [];
  for (const m of modules) {
    if (m.page_id && pageMap.has(m.page_id)) {
      pageMap.get(m.page_id).modules.push(m);
    } else {
      unassigned.push(m);
    }
  }

  return textResult({
    report,
    pages: [...pageMap.values()],
    unassigned_modules: unassigned,
    module_count: modules.length,
    page_count: pages.length,
  });
}

// ─── Handler: build_pages ───────────────────────────────────────────────────

async function handleBuildPages(userId, args) {
  const sql = getSql();
  const { report_id } = args;
  if (!report_id) return errorResult("report_id is required.");

  const reports = await sql`
    SELECT id, template_id FROM v2_reports WHERE id = ${report_id} LIMIT 1
  `;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);

  // Get height budget from template schema or use default
  let heightBudget = DEFAULT_HEIGHT_BUDGET_MM;
  if (reports[0].template_id) {
    const templates = await sql`SELECT schema FROM report_templates WHERE id = ${reports[0].template_id} LIMIT 1`;
    if (templates[0]?.schema?.page?.content_height_mm) {
      heightBudget = templates[0].schema.page.content_height_mm;
    }
  }

  // Get all modules ordered
  const modules = await sql`
    SELECT id, module_type, order_index, height_mm
    FROM v2_report_modules WHERE report_id = ${report_id}
    ORDER BY order_index
  `;

  if (!modules.length) return errorResult("Report has no modules. Add modules first.");

  // Clear existing pages
  await sql`DELETE FROM v2_report_pages WHERE report_id = ${report_id}`;

  // Page builder algorithm
  let pageNumber = 1;
  let currentPageHeight = 0;
  let currentPageId = null;
  const pageSummary = [];

  for (const mod of modules) {
    const isFullBleed = FULL_BLEED_TYPES.has(mod.module_type);
    // Default to 60mm if height_mm is NULL (e.g. freeform modules not yet rendered)
    const modHeight = mod.height_mm ?? 60;

    if (isFullBleed) {
      // Full-bleed modules always get their own page
      const pageRows = await sql`
        INSERT INTO v2_report_pages (report_id, page_number, page_type)
        VALUES (${report_id}, ${pageNumber}, ${mod.module_type})
        RETURNING id
      `;
      await sql`UPDATE v2_report_modules SET page_id = ${pageRows[0].id} WHERE id = ${mod.id}`;
      pageSummary.push({ page: pageNumber, type: mod.module_type, modules: 1 });
      pageNumber++;
      currentPageId = null;
      currentPageHeight = 0;
    } else {
      // Layout module: stack until height budget exceeded
      if (!currentPageId || currentPageHeight + modHeight > heightBudget) {
        const pageRows = await sql`
          INSERT INTO v2_report_pages (report_id, page_number, page_type)
          VALUES (${report_id}, ${pageNumber}, 'content')
          RETURNING id
        `;
        currentPageId = pageRows[0].id;
        currentPageHeight = 0;
        pageSummary.push({ page: pageNumber, type: "content", modules: 0 });
        pageNumber++;
      }
      await sql`UPDATE v2_report_modules SET page_id = ${currentPageId} WHERE id = ${mod.id}`;
      currentPageHeight += modHeight;
      pageSummary[pageSummary.length - 1].modules++;
    }
  }

  const totalPages = pageNumber - 1;
  const summaryText = pageSummary.map(p =>
    `  Page ${p.page}: ${p.type} (${p.modules} module${p.modules !== 1 ? "s" : ""})`
  ).join("\n");

  return textResult({
    total_pages: totalPages,
    height_budget_mm: heightBudget,
    summary: `Built ${totalPages} pages:\n${summaryText}`,
  });
}

// ─── Handler: render_pdf ────────────────────────────────────────────────────

async function handleRenderPdf(userId, args, event) {
  const sql = getSql();
  const { report_id, mode } = args;
  if (!report_id || !mode) return errorResult("report_id and mode are required.");

  // Fetch report + brand context
  const reports = await sql`
    SELECT r.id, r.tenant_id, r.brand_id, r.title, r.template_id
    FROM v2_reports r WHERE r.id = ${report_id} LIMIT 1
  `;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);
  const report = reports[0];

  // Fetch pages and modules
  const pages = await sql`
    SELECT id, page_number, page_type FROM v2_report_pages
    WHERE report_id = ${report_id} ORDER BY page_number
  `;
  const modules = await sql`
    SELECT id, page_id, module_type, order_index, content, style, html_cache, html_content
    FROM v2_report_modules WHERE report_id = ${report_id} ORDER BY order_index
  `;

  // Fetch brand tokens and fonts
  const brand = await fetchBrandContext(sql, report.brand_id);

  // Fetch template CSS — warn if missing so callers know design system is bare
  let cssBase = "";
  let cssWarning = null;
  if (report.template_id) {
    const templates = await sql`SELECT css_base FROM report_templates WHERE id = ${report.template_id} LIMIT 1`;
    cssBase = templates[0]?.css_base || "";
    if (!cssBase) {
      cssWarning = `Template ${report.template_id} has no css_base — PDF will use design-system defaults only.`;
      console.warn(`[render_pdf] ${cssWarning}`);
    }
  } else {
    cssWarning = "No template_id on report — PDF will use design-system defaults only.";
    console.warn(`[render_pdf] ${cssWarning}`);
  }

  // Call Python render service
  const pdfResult = await callRenderService("/render/pdf", {
    report_id,
    title: report.title,
    mode,
    pages: pages.map(p => ({
      ...p,
      modules: modules.filter(m => m.page_id === p.id),
    })),
    brand_tokens: brand.tokens,
    brand_fonts: brand.fonts,
    brand_logos: brand.logos,
    css_base: cssBase,
  }, report.tenant_id);

  // Store PDF in Netlify Blobs
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blobKey = `tenants/${report.tenant_id}/reports/${report_id}/${mode}-${timestamp}.pdf`;
  const store = await getBlobStore("report-ai-pdfs", event);
  const pdfBuffer = pdfResult.pdf_bytes
    ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
  if (!pdfBuffer) throw new Error("Render service returned no PDF bytes");
  await store.set(blobKey, pdfBuffer, { contentType: "application/pdf" });

  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const pdfUrl = `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(blobKey)}`;

  // For draft mode, also rasterize each page and save thumbnails so callers
  // (e.g. workflow steps, the React editor) can show inline visual previews
  // without depending on a PDF viewer. We skip this for final mode to keep
  // export latency down — final exports are downloaded as PDF, not previewed.
  let thumbnails = [];
  if (mode === "draft") {
    try {
      const raster = await callRenderService("/render/rasterize", {
        pdf_base64: pdfBuffer.toString("base64"),
      }, report.tenant_id);
      const assetStore = await getBlobStore("report-ai-assets", event);
      for (const page of raster.pages || []) {
        const thumbKey = `tenants/${report.tenant_id}/reports/${report_id}/thumbs/${timestamp}-page-${page.page}.png`;
        const pngBuffer = Buffer.from(page.png_base64, "base64");
        await assetStore.set(thumbKey, pngBuffer, { contentType: "image/png" });
        thumbnails.push({
          page: page.page,
          url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(thumbKey)}`,
        });
      }
    } catch (err) {
      console.warn("[render_pdf] rasterize failed (non-fatal):", err.message);
    }
  }

  return textResult({
    pdf_url: pdfUrl,
    blob_key: blobKey,
    page_count: pdfResult.page_count ?? pages.length,
    mode,
    size_bytes: pdfBuffer.length,
    thumbnails,
  });
}

// ─── Handler: preview_plan ──────────────────────────────────────────────────

/**
 * Convert a plan_structure plan module → renderable content/style.
 * Mirrors smyra-core build-modules.ts toApiContent() so the preview matches
 * what build_modules would actually produce (minus any rewrites Claude does
 * to slot text between plan_structure and build_modules).
 */
function planModuleToRenderable(m) {
  if (m.content) return { content: m.content, style: m.style };

  if (m.module_type === "cover") {
    return { content: { title: m.title, subtitle: m.summary ?? "" }, style: m.style };
  }
  if (m.module_type === "back_cover") {
    return { content: { company_name: m.title, disclaimer: m.summary ?? "" }, style: m.style };
  }
  if (m.module_type === "chapter_break") {
    return { content: { chapter_title: m.title }, style: m.style };
  }

  // layout
  const slots = (m.slots ?? []).map((s) => ({
    category: s.category,
    content: s.category === "text"
      ? { heading: s.heading ?? m.title, body: s.body_sketch ?? "" }
      : s.category === "data"
      ? { label: s.heading ?? "", value: s.body_sketch ?? "" }
      : { caption: s.heading ?? "" },
  }));
  return {
    content: { columns: m.column_preset ?? "full", slots },
    style: m.style,
  };
}

async function handlePreviewPlan(userId, args, event) {
  const sql = getSql();
  const { brand_id, tenant_id, plan, template_id } = args;
  if (!brand_id) return errorResult("brand_id is required.");
  if (!Array.isArray(plan) || plan.length === 0) return errorResult("plan must be a non-empty array.");

  const tenantId = tenant_id || (await sql`SELECT tenant_id FROM brands WHERE id = ${brand_id} LIMIT 1`)[0]?.tenant_id;
  if (!tenantId) return errorResult(`Could not resolve tenant_id for brand ${brand_id}.`);

  const brand = await fetchBrandContext(sql, brand_id);

  let cssBase = "";
  const tplId = template_id || "standard-v1";
  const templates = await sql`SELECT css_base FROM report_templates WHERE id = ${tplId} LIMIT 1`;
  cssBase = templates[0]?.css_base || "";

  // Build one synthetic page per plan module so each module gets its own thumbnail.
  const pages = plan.map((m, idx) => {
    const { content, style } = planModuleToRenderable(m);
    return {
      page_number: idx + 1,
      page_type: m.module_type === "cover" || m.module_type === "back_cover" || m.module_type === "chapter_break" ? m.module_type : "content",
      modules: [
        {
          id: m.local_id || `preview-${idx + 1}`,
          module_type: m.module_type,
          order_index: idx,
          content,
          style: style || {},
        },
      ],
    };
  });

  const pdfResult = await callRenderService("/render/pdf", {
    title: "Plan preview",
    mode: "draft",
    pages,
    brand_tokens: brand.tokens,
    brand_fonts: brand.fonts,
    brand_logos: brand.logos,
    css_base: cssBase,
  }, tenantId);

  const pdfBuffer = pdfResult.pdf_bytes
    ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
  if (!pdfBuffer) throw new Error("Render service returned no PDF bytes for preview");

  // Rasterize → store one PNG per page → map back to plan local_ids
  const raster = await callRenderService("/render/rasterize", {
    pdf_base64: pdfBuffer.toString("base64"),
  }, tenantId);

  const assetStore = await getBlobStore("report-ai-assets", event);
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const previews = [];

  for (const page of raster.pages || []) {
    const planIndex = page.page - 1;
    const planModule = plan[planIndex];
    if (!planModule) continue;
    const thumbKey = `tenants/${tenantId}/plan-previews/${timestamp}-${planModule.local_id || `m${page.page}`}.png`;
    const pngBuffer = Buffer.from(page.png_base64, "base64");
    await assetStore.set(thumbKey, pngBuffer, { contentType: "image/png" });
    previews.push({
      local_id: planModule.local_id,
      title: planModule.title,
      page: page.page,
      thumbnail_url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(thumbKey)}`,
    });
  }

  return textResult({
    previews,
    module_count: plan.length,
    rendered: previews.length,
  });
}

// ─── Handler: render_module_thumbnails ──────────────────────────────────────

async function handleRenderModuleThumbnails(userId, args, event) {
  const sql = getSql();
  const { report_id } = args;
  if (!report_id) return errorResult("report_id is required.");

  const reports = await sql`
    SELECT r.id, r.tenant_id, r.brand_id, r.template_id
    FROM v2_reports r WHERE r.id = ${report_id} LIMIT 1
  `;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);
  const report = reports[0];

  const modules = await sql`
    SELECT id, module_type, order_index, content, style
    FROM v2_report_modules
    WHERE report_id = ${report_id}
    ORDER BY order_index
  `;
  if (!modules.length) return errorResult("No modules found.");

  const brand = await fetchBrandContext(sql, report.brand_id);

  // Build a single PDF with one module per page, then rasterize.
  const pages = modules.map((mod, idx) => ({
    page_number: idx + 1,
    page_type: FULL_BLEED_TYPES.has(mod.module_type) ? mod.module_type : "content",
    modules: [{
      id: mod.id,
      module_type: mod.module_type,
      order_index: mod.order_index,
      content: mod.content || {},
      style: mod.style || {},
    }],
  }));

  const pdfResult = await callRenderService("/render/pdf", {
    title: "Module thumbnails",
    mode: "draft",
    pages,
    brand_tokens: brand.tokens,
    brand_fonts: brand.fonts,
    brand_logos: brand.logos,
  }, report.tenant_id);

  const pdfBuffer = pdfResult.pdf_bytes
    ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
  if (!pdfBuffer) throw new Error("Render returned no PDF");

  const raster = await callRenderService("/render/rasterize", {
    pdf_base64: pdfBuffer.toString("base64"),
  }, report.tenant_id);

  const assetStore = await getBlobStore("report-ai-assets", event);
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const thumbnails = [];

  for (const page of raster.pages || []) {
    const mod = modules[page.page - 1];
    if (!mod) continue;
    const thumbKey = `tenants/${report.tenant_id}/reports/${report_id}/module-thumbs/${timestamp}-${mod.id}.png`;
    const pngBuffer = Buffer.from(page.png_base64, "base64");
    await assetStore.set(thumbKey, pngBuffer, { contentType: "image/png" });
    thumbnails.push({
      module_id: mod.id,
      module_type: mod.module_type,
      order_index: mod.order_index,
      title: mod.content?.title || mod.content?.chapter_title || mod.content?.company_name || `Modul ${page.page}`,
      thumbnail_url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(thumbKey)}`,
    });
  }

  return textResult({
    thumbnails,
    module_count: modules.length,
    rendered: thumbnails.length,
  });
}

// ─── Handler: get_editor_url ────────────────────────────────────────────────

async function handleGetEditorUrl(userId, args) {
  const sql = getSql();
  const { report_id } = args;
  if (!report_id) return errorResult("report_id is required.");

  const reports = await sql`SELECT id FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);

  const token = createEditorToken(userId, report_id);
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const editorUrl = `${siteUrl}/editor/v2?token=${token}`;

  return textResult({ editor_url: editorUrl, expires_in: "7 days" });
}

// ─── Handler: save_brand_tokens ─────────────────────────────────────────────

async function handleSaveBrandTokens(userId, args) {
  const sql = getSql();
  const { brand_id, tokens } = args;
  if (!brand_id || !tokens) return errorResult("brand_id and tokens are required.");

  // MERGE — only overwrite keys that are provided, preserve the rest.
  // This prevents session-local overrides from wiping unrelated token keys.
  const rows = await sql`
    UPDATE brands
    SET tokens = COALESCE(tokens, '{}'::jsonb) || ${JSON.stringify(tokens)}::jsonb,
        updated_at = NOW()
    WHERE id = ${brand_id}
    RETURNING id, tenant_id, name, tokens
  `;
  if (!rows.length) return errorResult(`Brand ${brand_id} not found.`);

  return textResult({ brand_id: rows[0].id, updated: true, merged_keys: Object.keys(tokens) });
}

// ─── Handler: get_brand_tokens ──────────────────────────────────────────────

async function handleGetBrandTokens(userId, args) {
  const sql = getSql();
  const { brand_id } = args;
  if (!brand_id) return errorResult("brand_id is required.");

  const rows = await sql`SELECT id, tenant_id, name, tokens FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (!rows.length) return errorResult(`Brand ${brand_id} not found.`);

  return textResult(rows[0]);
}

// ─── Handler: upload_font ───────────────────────────────────────────────────

async function handleUploadFont(userId, args) {
  const sql = getSql();
  const { brand_id, family, weight, style, format, data_base64 } = args;
  if (!brand_id || !family || weight == null || !style || !format || !data_base64) {
    return errorResult("All fields are required: brand_id, family, weight, style, format, data_base64.");
  }

  const rows = await sql`
    INSERT INTO brand_fonts (brand_id, family, weight, style, format, data_base64)
    VALUES (${brand_id}, ${family}, ${weight}, ${style}, ${format}, ${data_base64})
    RETURNING id, brand_id, family, weight, style, format
  `;

  return textResult({ font_id: rows[0].id, family, weight, style, format });
}

// ─── Handler: upload_logo ───────────────────────────────────────────────────

async function handleUploadLogo(userId, args) {
  const sql = getSql();
  const { brand_id, variant, format, data_base64 } = args;
  if (!brand_id || !variant || !format || !data_base64) {
    return errorResult("All fields are required: brand_id, variant, format, data_base64.");
  }

  const rows = await sql`
    INSERT INTO brand_logos (brand_id, variant, format, data_base64)
    VALUES (${brand_id}, ${variant}, ${format}, ${data_base64})
    RETURNING id, brand_id, variant, format
  `;

  return textResult({ logo_id: rows[0].id, variant, format });
}

// ─── Handler: upload_asset ──────────────────────────────────────────────────

async function handleUploadAsset(userId, args, event) {
  const sql = getSql();
  const { tenant_id, filename, mime_type, data_base64 } = args;
  if (!tenant_id || !filename || !mime_type || !data_base64) {
    return errorResult("All fields are required: tenant_id, filename, mime_type, data_base64.");
  }

  // Determine asset_class from mime_type
  let assetClass;
  if (mime_type === "image/svg+xml") {
    assetClass = "svg";
  } else if (mime_type.startsWith("image/") && data_base64.length < 50000) {
    // Small images (< ~37KB raw) are likely icons
    assetClass = "icon";
  } else {
    assetClass = "photo";
  }

  // Store in Netlify Blobs
  const assetId = randomUUID();
  const ext = filename.split(".").pop() || "bin";
  const blobKey = `tenants/${tenant_id}/assets/${assetId}.${ext}`;
  const store = await getBlobStore("report-ai-assets", event);
  const buffer = Buffer.from(data_base64, "base64");
  const contentTypes = {
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  await store.set(blobKey, buffer, { contentType: contentTypes[ext] || mime_type });

  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const storageUrl = `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`;
  const sizeBytes = buffer.length;

  // DPI warning for photos under 150 DPI at A4 width (210mm)
  let warning = null;
  if (assetClass === "photo" && sizeBytes < 100000) {
    warning = "Image file is small — may appear low-resolution in print at A4 size.";
  }

  await sql`
    INSERT INTO tenant_assets (id, tenant_id, filename, mime_type, storage_url, size_bytes, asset_class)
    VALUES (${assetId}, ${tenant_id}, ${filename}, ${mime_type}, ${storageUrl}, ${sizeBytes}, ${assetClass})
  `;

  return textResult({ asset_id: assetId, asset_class: assetClass, size_bytes: sizeBytes, storage_url: storageUrl, warning });
}

// ─── Handler: list_assets ──────────────────────────────────────────────────

async function handleListAssets(userId, args) {
  const sql = getSql();
  const { tenant_id, asset_class } = args;
  if (!tenant_id) return errorResult("tenant_id is required.");

  let rows;
  if (asset_class) {
    rows = await sql`
      SELECT id, filename, mime_type, asset_class, storage_url, size_bytes, created_at
      FROM tenant_assets WHERE tenant_id = ${tenant_id} AND asset_class = ${asset_class}
      ORDER BY created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT id, filename, mime_type, asset_class, storage_url, size_bytes, created_at
      FROM tenant_assets WHERE tenant_id = ${tenant_id}
      ORDER BY asset_class, created_at DESC
    `;
  }

  return textResult({ assets: rows, count: rows.length });
}

// ─── Handler: list_templates ────────────────────────────────────────────────

async function handleListTemplates(userId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, name, description, document_types, created_at
    FROM report_templates ORDER BY name
  `;
  return textResult({ templates: rows, count: rows.length });
}

async function handleGetStubPlan(userId, args) {
  const { document_type } = args;
  if (!document_type) return errorResult("document_type is required.");

  const { getTemplate } = await import("./document-type-templates.js");
  const template = await getTemplate(document_type);
  if (!template) {
    return errorResult(`No template found for document type "${document_type}". Use "custom" for freeform documents.`);
  }
  return textResult({
    document_type: template.document_type,
    required_sections: template.required_sections,
    stub_plan: template.default_stub_plan,
    module_count: template.default_stub_plan?.length ?? 0,
  });
}

// ─── Handler: list_brands ───────────────────────────────────────────────────

async function handleListBrands(userId, args) {
  const { tenant_id } = args || {};
  if (!tenant_id) throw new Error("tenant_id required");
  const sql = getSql();
  const rows = await sql`
    SELECT id, tenant_id, name, tokens, created_at
    FROM brands
    WHERE tenant_id = ${tenant_id}
    ORDER BY created_at ASC
  `;
  return textResult({ brands: rows, count: rows.length });
}

// ─── Handler: get_module_schema ─────────────────────────────────────────────

async function handleGetModuleSchema(userId, args) {
  const { template_id, module_type } = args;
  const sql = getSql();

  // Base schema for all module types
  const moduleSchemas = {
    cover: {
      description: "Full-bleed cover page.",
      content_fields: { title: "string", subtitle: "string", date: "string", logo_asset_id: "string" },
      style_fields: { background_color: "string", text_color: "string", background_image_asset_id: "string" },
    },
    chapter_break: {
      description: "Full-bleed section divider.",
      content_fields: { chapter_number: "integer", chapter_title: "string" },
      style_fields: { background_color: "string", text_color: "string" },
    },
    back_cover: {
      description: "Full-bleed back cover with company info.",
      content_fields: { company_name: "string", address: "string", website: "string", disclaimer: "string", logo_asset_id: "string" },
      style_fields: { background_color: "string", text_color: "string" },
    },
    layout: {
      description: "Column-based layout module. Slots hold content blocks.",
      content_fields: {
        columns: { type: "string", enum: VALID_COLUMNS },
        slots: {
          type: "array",
          items: {
            category: { type: "string", enum: VALID_CATEGORIES },
            content: "object (varies by category)",
          },
        },
      },
      style_fields: { gap_mm: "number", padding_mm: "number", background_color: "string" },
      column_presets: Object.entries(MAX_SLOTS).map(([k, v]) => ({ preset: k, max_slots: v })),
      slot_categories: VALID_CATEGORIES,
    },
  };

  let result = moduleSchemas;
  if (module_type && moduleSchemas[module_type]) {
    result = { [module_type]: moduleSchemas[module_type] };
  }

  // If template_id provided, include template-specific schema extensions
  if (template_id) {
    const templates = await sql`SELECT schema FROM report_templates WHERE id = ${template_id} LIMIT 1`;
    if (templates[0]?.schema) {
      result._template_schema = templates[0].schema;
    }
  }

  return textResult(result);
}

// ─── Handler: save_blueprint ────────────────────────────────────────────────

async function handleSaveBlueprint(userId, args) {
  const sql = getSql();
  const { report_id, name } = args;
  if (!report_id || !name) return errorResult("report_id and name are required.");

  // Fetch report and its brand
  const reports = await sql`SELECT id, brand_id FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);
  const brandId = reports[0].brand_id;
  if (!brandId) return errorResult("Report has no brand_id — cannot save blueprint without a brand.");

  // Extract module structure (styles preserved, content cleared)
  const modules = await sql`
    SELECT module_type, order_index, style
    FROM v2_report_modules WHERE report_id = ${report_id}
    ORDER BY order_index
  `;
  const blueprintModules = modules.map(m => ({
    module_type: m.module_type,
    order_index: m.order_index,
    style: m.style,
    content: {}, // Empty content — blueprint is structure only
  }));

  const rows = await sql`
    INSERT INTO report_blueprints (brand_id, name, source_report_id, modules)
    VALUES (${brandId}, ${name}, ${report_id}, ${JSON.stringify(blueprintModules)}::jsonb)
    RETURNING id, brand_id, name, created_at
  `;

  return textResult({ blueprint_id: rows[0].id, name, module_count: blueprintModules.length });
}

// ─── Handler: list_blueprints ───────────────────────────────────────────────

async function handleListBlueprints(userId, args) {
  const sql = getSql();
  const { brand_id } = args;
  if (!brand_id) return errorResult("brand_id is required.");

  const rows = await sql`
    SELECT id, name, source_report_id, created_at,
           jsonb_array_length(modules) AS module_count
    FROM report_blueprints WHERE brand_id = ${brand_id}
    ORDER BY created_at DESC
  `;
  return textResult({ blueprints: rows, count: rows.length });
}

// ─── Handler: create_from_blueprint ─────────────────────────────────────────

async function handleCreateFromBlueprint(userId, args) {
  const sql = getSql();
  const { blueprint_id, title, document_type } = args;
  if (!blueprint_id || !title || !document_type) {
    return errorResult("blueprint_id, title, and document_type are required.");
  }

  const blueprints = await sql`
    SELECT id, brand_id, modules FROM report_blueprints WHERE id = ${blueprint_id} LIMIT 1
  `;
  if (!blueprints.length) return errorResult(`Blueprint ${blueprint_id} not found.`);
  const bp = blueprints[0];

  // Look up tenant_id from brand
  const brands = await sql`SELECT tenant_id FROM brands WHERE id = ${bp.brand_id} LIMIT 1`;
  if (!brands.length) return errorResult(`Brand ${bp.brand_id} not found.`);
  const tenantId = brands[0].tenant_id;

  // Create report
  const reportRows = await sql`
    INSERT INTO v2_reports (tenant_id, brand_id, title, document_type, status)
    VALUES (${tenantId}, ${bp.brand_id}, ${title}, ${document_type}, 'draft')
    RETURNING id
  `;
  const reportId = reportRows[0].id;

  // Create modules from blueprint
  const bpModules = typeof bp.modules === "string" ? JSON.parse(bp.modules) : bp.modules;
  for (const mod of bpModules) {
    await sql`
      INSERT INTO v2_report_modules (report_id, module_type, order_index, content, style)
      VALUES (${reportId}, ${mod.module_type}, ${mod.order_index}, ${JSON.stringify(mod.content || {})}::jsonb, ${JSON.stringify(mod.style || {})}::jsonb)
    `;
  }

  return textResult({
    report_id: reportId,
    blueprint_id,
    title,
    document_type,
    module_count: bpModules.length,
    next_step: "Use report2__get_structure to see the report, then report2__update_module to add content.",
  });
}

// ─── Handler: save_component ────────────────────────────────────────────────

async function handleSaveComponent(userId, args) {
  const sql = getSql();
  const {
    component_id,
    brand_id,
    component_type,
    variant_name,
    label,
    html_template,
    placeholder_schema,
    design_notes,
    source,
    is_default,
    extraction_id,
    is_public,
    unsplash_query,
    reference_page_numbers,
  } = args;
  if (!brand_id || !component_type || !label || !html_template) {
    return errorResult("brand_id, component_type, label, and html_template are required.");
  }

  const variantLabel = (variant_name && String(variant_name).trim()) || 'Default';

  // If marking as default, clear existing defaults for this type+brand
  if (is_default) {
    if (component_id) {
      await sql`
        UPDATE brand_components SET is_default = false
        WHERE brand_id = ${brand_id} AND component_type = ${component_type} AND is_default = true AND id != ${component_id}
      `;
    } else {
      await sql`
        UPDATE brand_components SET is_default = false
        WHERE brand_id = ${brand_id} AND component_type = ${component_type} AND is_default = true
      `;
    }
  }

  // UPDATE existing component if component_id provided, otherwise INSERT (or UPSERT on variant match)
  if (component_id) {
    const rows = await sql`
      UPDATE brand_components
      SET label = ${label},
          variant_name = ${variantLabel},
          html_template = ${html_template},
          placeholder_schema = ${JSON.stringify(placeholder_schema || [])}::jsonb,
          design_notes = ${design_notes || null},
          source = ${source || 'manual'},
          is_default = ${is_default || false},
          extraction_id = ${extraction_id || null},
          is_public = ${is_public === true},
          unsplash_query = ${unsplash_query || null},
          reference_page_numbers = ${JSON.stringify(reference_page_numbers || [])}::jsonb,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${component_id} AND brand_id = ${brand_id}
      RETURNING id
    `;
    if (!rows.length) return errorResult(`Component ${component_id} not found for brand ${brand_id}.`);
    return textResult({ component_id: rows[0].id, component_type, variant_name: variantLabel, label, updated: true });
  }

  // If a variant with the same (brand, type, variant_name) already exists, update it in place
  // rather than inserting a duplicate. Caller can explicitly pick a new variant_name to force a new row.
  const existingSameVariant = await sql`
    SELECT id FROM brand_components
    WHERE brand_id = ${brand_id}
      AND component_type = ${component_type}
      AND variant_name = ${variantLabel}
    LIMIT 1
  `;
  if (existingSameVariant.length) {
    const existingId = existingSameVariant[0].id;
    const rows = await sql`
      UPDATE brand_components
      SET label = ${label},
          html_template = ${html_template},
          placeholder_schema = ${JSON.stringify(placeholder_schema || [])}::jsonb,
          design_notes = ${design_notes || null},
          source = ${source || 'manual'},
          is_default = ${is_default || false},
          extraction_id = ${extraction_id || null},
          is_public = ${is_public === true},
          unsplash_query = ${unsplash_query || null},
          reference_page_numbers = ${JSON.stringify(reference_page_numbers || [])}::jsonb,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${existingId}
      RETURNING id
    `;
    return textResult({ component_id: rows[0].id, component_type, variant_name: variantLabel, label, updated: true });
  }

  const rows = await sql`
    INSERT INTO brand_components (
      brand_id, component_type, variant_name, label, html_template, placeholder_schema,
      design_notes, source, is_default,
      extraction_id, is_public, unsplash_query, reference_page_numbers
    )
    VALUES (
      ${brand_id}, ${component_type}, ${variantLabel}, ${label}, ${html_template},
      ${JSON.stringify(placeholder_schema || [])}::jsonb,
      ${design_notes || null}, ${source || 'manual'}, ${is_default || false},
      ${extraction_id || null}, ${is_public === true}, ${unsplash_query || null},
      ${JSON.stringify(reference_page_numbers || [])}::jsonb
    )
    RETURNING id
  `;

  return textResult({ component_id: rows[0].id, component_type, variant_name: variantLabel, label });
}

// ─── Handler: list_components ───────────────────────────────────────────────

async function handleListComponents(userId, args) {
  const sql = getSql();
  const { brand_id, component_type, variant_name, include_public, extraction_id } = args;
  if (!brand_id) return errorResult("brand_id is required.");

  const typeFilter = component_type || null;
  const variantFilter = variant_name || null;
  const extractionFilter = extraction_id || null;
  const includePublic = include_public === true;

  const rows = await sql`
    SELECT id, brand_id, component_type, variant_name, label, is_default,
           placeholder_schema, html_template, design_notes, source,
           extraction_id, is_public, unsplash_query, reference_page_numbers,
           thumbnail_url, thumbnail_generated_at,
           version, created_at, updated_at
    FROM brand_components
    WHERE (brand_id = ${brand_id} OR (${includePublic} AND is_public = true))
      AND (${typeFilter}::text IS NULL OR component_type = ${typeFilter})
      AND (${variantFilter}::text IS NULL OR variant_name = ${variantFilter})
      AND (${extractionFilter}::uuid IS NULL OR extraction_id = ${extractionFilter}::uuid)
    ORDER BY component_type, is_default DESC, variant_name, updated_at DESC
  `;

  return textResult({ components: rows, count: rows.length });
}

// ─── Handler: fork_component ────────────────────────────────────────────────

async function handleForkComponent(userId, args) {
  const sql = getSql();
  const { source_component_id, target_brand_id, label, is_default } = args;
  if (!source_component_id || !target_brand_id) {
    return errorResult("source_component_id and target_brand_id are required.");
  }

  const srcRows = await sql`
    SELECT brand_id, component_type, label, html_template, placeholder_schema,
           design_notes, source, extraction_id, is_public, unsplash_query,
           reference_page_numbers
    FROM brand_components
    WHERE id = ${source_component_id}
    LIMIT 1
  `;
  if (!srcRows.length) return errorResult(`Source component ${source_component_id} not found.`);
  const src = srcRows[0];

  // Access control: must be same brand OR public.
  if (src.brand_id !== target_brand_id && src.is_public !== true) {
    return errorResult("Source component is not public; cannot fork into a different brand.");
  }

  if (is_default) {
    await sql`
      UPDATE brand_components SET is_default = false
      WHERE brand_id = ${target_brand_id} AND component_type = ${src.component_type} AND is_default = true
    `;
  }

  const rows = await sql`
    INSERT INTO brand_components (
      brand_id, component_type, label, html_template, placeholder_schema,
      design_notes, source, is_default,
      extraction_id, is_public, unsplash_query, reference_page_numbers
    )
    VALUES (
      ${target_brand_id}, ${src.component_type}, ${label || src.label},
      ${src.html_template},
      ${JSON.stringify(src.placeholder_schema || [])}::jsonb,
      ${src.design_notes}, 'fork', ${is_default === true},
      ${null}, ${false}, ${src.unsplash_query},
      ${JSON.stringify(src.reference_page_numbers || [])}::jsonb
    )
    RETURNING id
  `;

  return textResult({
    component_id: rows[0].id,
    source_component_id,
    target_brand_id,
    component_type: src.component_type,
    forked: true,
  });
}

// ─── Handler: create_design_extraction ──────────────────────────────────────

async function handleCreateDesignExtraction(userId, args) {
  const sql = getSql();
  const { brand_id, label, source_description, suggested_tokens, inventory, reference_pages } = args;
  if (!brand_id || !label) {
    return errorResult("brand_id and label are required.");
  }

  // Look up tenant_id for the brand so the extraction inherits it.
  const brandRows = await sql`SELECT tenant_id FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (!brandRows.length) return errorResult(`Brand ${brand_id} not found.`);
  const tenantId = brandRows[0].tenant_id || null;

  const rows = await sql`
    INSERT INTO design_extractions (
      brand_id, tenant_id, label, source_description,
      suggested_tokens, inventory, reference_pages, status
    )
    VALUES (
      ${brand_id}, ${tenantId}, ${label}, ${source_description || null},
      ${JSON.stringify(suggested_tokens || {})}::jsonb,
      ${JSON.stringify(inventory || [])}::jsonb,
      ${JSON.stringify(reference_pages || [])}::jsonb,
      'draft'
    )
    RETURNING id, brand_id, label, status, created_at
  `;

  return textResult({
    extraction_id: rows[0].id,
    ...rows[0],
    note: "Reference-derived tokens are stored on this extraction — they do NOT overwrite the brand. Use apply_design_extraction explicitly if the user wants to promote them.",
  });
}

// ─── Handler: update_design_extraction ──────────────────────────────────────

async function handleUpdateDesignExtraction(userId, args) {
  const sql = getSql();
  const { extraction_id, label, source_description, suggested_tokens, inventory, reference_pages, status } = args;
  if (!extraction_id) return errorResult("extraction_id is required.");

  const existing = await sql`SELECT * FROM design_extractions WHERE id = ${extraction_id} LIMIT 1`;
  if (!existing.length) return errorResult(`Extraction ${extraction_id} not found.`);
  const cur = existing[0];

  // Merge tokens if provided (overlay, not replace).
  const mergedTokens = suggested_tokens
    ? { ...(cur.suggested_tokens || {}), ...suggested_tokens }
    : (cur.suggested_tokens || {});

  const newLabel = label ?? cur.label;
  const newSource = source_description ?? cur.source_description;
  const newInventory = inventory ?? (cur.inventory || []);
  const newReferencePages = reference_pages ?? (cur.reference_pages || []);
  const newStatus = status ?? cur.status;

  const rows = await sql`
    UPDATE design_extractions
    SET label = ${newLabel},
        source_description = ${newSource},
        suggested_tokens = ${JSON.stringify(mergedTokens)}::jsonb,
        inventory = ${JSON.stringify(newInventory)}::jsonb,
        reference_pages = ${JSON.stringify(newReferencePages)}::jsonb,
        status = ${newStatus},
        updated_at = NOW()
    WHERE id = ${extraction_id}
    RETURNING id, brand_id, label, status, suggested_tokens, inventory, reference_pages, updated_at
  `;

  return textResult(rows[0]);
}

// ─── Handler: get_design_extraction ─────────────────────────────────────────

async function handleGetDesignExtraction(userId, args) {
  const sql = getSql();
  const { extraction_id } = args;
  if (!extraction_id) return errorResult("extraction_id is required.");

  const rows = await sql`
    SELECT id, brand_id, tenant_id, label, source_description,
           suggested_tokens, inventory, reference_pages, status,
           created_at, updated_at
    FROM design_extractions
    WHERE id = ${extraction_id}
    LIMIT 1
  `;
  if (!rows.length) return errorResult(`Extraction ${extraction_id} not found.`);

  // Also pull the component ids that reference this extraction so Claude
  // can see what's been designed so far.
  const components = await sql`
    SELECT id, component_type, label, is_default, is_public, reference_page_numbers
    FROM brand_components
    WHERE extraction_id = ${extraction_id}
    ORDER BY component_type, updated_at DESC
  `;

  return textResult({ ...rows[0], components });
}

// ─── Handler: list_design_extractions ───────────────────────────────────────

async function handleListDesignExtractions(userId, args) {
  const sql = getSql();
  const { brand_id, status } = args;
  if (!brand_id) return errorResult("brand_id is required.");

  const statusFilter = status || null;
  const rows = await sql`
    SELECT id, brand_id, label, source_description, status,
           jsonb_array_length(COALESCE(inventory, '[]'::jsonb)) AS inventory_count,
           jsonb_array_length(COALESCE(reference_pages, '[]'::jsonb)) AS reference_page_count,
           created_at, updated_at
    FROM design_extractions
    WHERE brand_id = ${brand_id}
      AND (${statusFilter}::text IS NULL OR status = ${statusFilter})
    ORDER BY updated_at DESC
  `;

  return textResult({ extractions: rows, count: rows.length });
}

// ─── Handler: apply_design_extraction ───────────────────────────────────────

async function handleApplyDesignExtraction(userId, args) {
  const sql = getSql();
  const { extraction_id, token_keys } = args;
  if (!extraction_id) return errorResult("extraction_id is required.");

  const rows = await sql`
    SELECT brand_id, suggested_tokens
    FROM design_extractions
    WHERE id = ${extraction_id}
    LIMIT 1
  `;
  if (!rows.length) return errorResult(`Extraction ${extraction_id} not found.`);
  const { brand_id, suggested_tokens } = rows[0];
  const suggestion = suggested_tokens || {};

  // Select which keys to apply.
  let overlay;
  if (Array.isArray(token_keys) && token_keys.length > 0) {
    overlay = {};
    for (const key of token_keys) {
      if (key in suggestion) overlay[key] = suggestion[key];
    }
  } else {
    overlay = suggestion;
  }

  if (Object.keys(overlay).length === 0) {
    return errorResult("No tokens to apply (suggested_tokens empty or token_keys filter matched nothing).");
  }

  // Merge into brand.tokens (do not blow away unrelated keys).
  const brandRows = await sql`SELECT tokens FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (!brandRows.length) return errorResult(`Brand ${brand_id} not found.`);
  const current = brandRows[0].tokens || {};
  const merged = { ...current, ...overlay };

  await sql`
    UPDATE brands
    SET tokens = ${JSON.stringify(merged)}::jsonb,
        updated_at = NOW()
    WHERE id = ${brand_id}
  `;

  await sql`
    UPDATE design_extractions
    SET status = 'applied', updated_at = NOW()
    WHERE id = ${extraction_id}
  `;

  return textResult({
    applied: true,
    extraction_id,
    brand_id,
    applied_keys: Object.keys(overlay),
    new_tokens: merged,
  });
}

// ─── Handler: get_component ─────────────────────────────────────────────────

async function handleGetComponent(userId, args) {
  const sql = getSql();
  const { component_id } = args;
  if (!component_id) return errorResult("component_id is required.");

  const rows = await sql`
    SELECT id, brand_id, component_type, variant_name, label, html_template, placeholder_schema,
           design_notes, source, version, is_default,
           extraction_id, is_public, unsplash_query, reference_page_numbers,
           created_at, updated_at
    FROM brand_components WHERE id = ${component_id} LIMIT 1
  `;
  if (!rows.length) return errorResult(`Component ${component_id} not found.`);

  return textResult(rows[0]);
}

// ─── Handler: render_component_preview ──────────────────────────────────────

async function handleRenderComponentPreview(userId, args, event) {
  const sql = getSql();
  const { component_id, html_template: directHtml, brand_id: directBrandId, placeholder_values } = args;

  let htmlTemplate, brandId;

  if (component_id) {
    const rows = await sql`
      SELECT html_template, brand_id FROM brand_components WHERE id = ${component_id} LIMIT 1
    `;
    if (!rows.length) return errorResult(`Component ${component_id} not found.`);
    htmlTemplate = rows[0].html_template;
    brandId = rows[0].brand_id;
  } else if (directHtml && directBrandId) {
    htmlTemplate = directHtml;
    brandId = directBrandId;
  } else {
    return errorResult("Provide component_id OR (html_template + brand_id).");
  }

  // Fill placeholders
  let filled = htmlTemplate;
  if (placeholder_values) {
    for (const [key, value] of Object.entries(placeholder_values)) {
      filled = filled.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
  }
  // Clean unfilled placeholders
  filled = filled.replace(/\{\{[A-Z_0-9]+\}\}/g, "");

  // Fetch brand tokens + fonts
  const brands = await sql`SELECT tokens FROM brands WHERE id = ${brandId} LIMIT 1`;
  const brandTokens = brands.length ? (brands[0].tokens || {}) : {};
  const fonts = await sql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brandId}`;

  // Look up tenant_id for blob storage path
  const brandRows = await sql`SELECT tenant_id FROM brands WHERE id = ${brandId} LIMIT 1`;
  const tenantId = brandRows[0]?.tenant_id || "unknown";

  // Render as single-page PDF so we can rasterize to PNG thumbnail
  const pdfResult = await callRenderService("/render/pdf", {
    title: "Component preview",
    mode: "draft",
    pages: [{
      page_number: 1,
      page_type: "content",
      modules: [{
        id: "preview",
        module_type: "freeform",
        order_index: 0,
        content: {},
        style: {},
        html_content: filled,
      }],
    }],
    brand_tokens: brandTokens,
    brand_fonts: fonts,
    brand_logos: [],
  }, tenantId);

  const pdfBuffer = pdfResult.pdf_bytes
    ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);

  let thumbnailUrl = null;
  let heightMm = pdfResult.page_heights?.[0] ?? 60;

  if (pdfBuffer) {
    // Rasterize PDF → PNG
    const raster = await callRenderService("/render/rasterize", {
      pdf_base64: pdfBuffer.toString("base64"),
    }, tenantId);

    if (raster.pages?.length) {
      const assetStore = await getBlobStore("report-ai-assets", event);
      const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const thumbKey = `tenants/${tenantId}/component-previews/${timestamp}-${brandId}.png`;
      const pngBuffer = Buffer.from(raster.pages[0].png_base64, "base64");
      await assetStore.set(thumbKey, pngBuffer, { contentType: "image/png" });
      thumbnailUrl = `${siteUrl}/api/v2-asset?key=${encodeURIComponent(thumbKey)}`;
    }
  }

  return textResult({ height_mm: heightMm, thumbnail_url: thumbnailUrl });
}

// ─── Handler: rasterize_pdf ─────────────────────────────────────────────────

async function handleRasterizePdf(userId, args, event) {
  const sql = getSql();
  const { report_id, pages } = args;
  if (!report_id) return errorResult("report_id is required.");

  const reports = await sql`
    SELECT id, tenant_id FROM v2_reports WHERE id = ${report_id} LIMIT 1
  `;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);
  const tenantId = reports[0].tenant_id;

  // Find latest PDF blob key
  const store = await getBlobStore("report-ai-pdfs", event);
  const prefix = `tenants/${tenantId}/reports/${report_id}/`;

  // Call Python render service to rasterize
  const result = await callRenderService("/render/rasterize", {
    report_id,
    pdf_blob_prefix: prefix,
    pages: pages || null,
  }, tenantId);

  // Store rasterized PNGs in blobs
  const rasterStore = await getBlobStore("report-ai-rasters", event);
  const imageUrls = [];
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";

  for (const page of result.pages || []) {
    const key = `tenants/${tenantId}/reports/${report_id}/page-${page.page_number}.png`;
    const buf = Buffer.from(page.png_base64, "base64");
    await rasterStore.set(key, buf, { contentType: "image/png" });
    imageUrls.push({
      page_number: page.page_number,
      url: `${siteUrl}/.netlify/blobs/report-ai-rasters/${key}`,
      width: page.width,
      height: page.height,
    });
  }

  return textResult({ report_id, images: imageUrls, count: imageUrls.length });
}

// ─── Layer 2 meta-code helpers ──────────────────────────────────────────────

/**
 * Layer 2 tools return a structured "meta" object that tells Claude how to
 * execute a multi-step task using Layer 1 tools, with Layer 3 judgment points.
 *
 * Shape:
 *   {
 *     mode: "meta",
 *     task: string,
 *     output_schema: object,
 *     save_result_via: string (tool name),
 *     steps: [
 *       { action: "tool", tool: "...", args: {...}, store_as: "..." },
 *       { action: "judge", instruction: "...", uses: ["step-name"], produces: "..." },
 *       { action: "tool", tool: "...", args_from: "..." },
 *     ]
 *   }
 */
function metaResult(meta) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ mode: "meta", ...meta }, null, 2) },
    ],
  };
}

// ─── Handler: request_upload ────────────────────────────────────────────────

async function handleRequestUpload(userId, args) {
  const { createUploadToken } = await import("./upload-ref.js");
  const { token } = createUploadToken();
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const uploadUrl = `${siteUrl}/upload-ref?token=${token}`;

  return textResult({
    upload_token: token,
    upload_url: uploadUrl,
    expires_in_minutes: 30,
    instruction: "Ge användaren denna länk. Filen analyseras direkt av servern — inga bilder skickas genom konversationen. När användaren bekräftar att uppladdningen är klar, använd upload_token med extract_design_from_pdf eller check_upload.",
  });
}

// ─── Handler: check_upload ─────────────────────────────────────────────────

async function handleCheckUpload(userId, args) {
  const { upload_token } = args;
  if (!upload_token) return errorResult("upload_token is required.");

  const { verifyUploadToken } = await import("./upload-ref.js");
  if (!verifyUploadToken(upload_token)) {
    return errorResult("Upload token is invalid or expired.");
  }

  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  try {
    const resp = await fetch(`${siteUrl}/upload-ref?token=${upload_token}&check=1`);
    const data = await resp.json();
    return textResult(data);
  } catch (e) {
    return errorResult(`Check failed: ${e.message}`);
  }
}

// ─── Handler: extract_design_from_pdf (Layer 2) ─────────────────────────────

async function handleExtractDesignFromPdf(userId, args, event) {
  const sql = getSql();
  const { pdf_base64, source_url, upload_token, brand_id, pages: requestedPages } = args;
  if (!brand_id) {
    return errorResult("brand_id is required.");
  }
  if (!pdf_base64 && !source_url && !upload_token) {
    return errorResult("Provide upload_token (from request_upload), source_url, or pdf_base64.");
  }

  // Look up tenant from brand so smyra-render JWT carries a tenant_id claim.
  const brands = await sql`SELECT tenant_id FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (!brands.length) return errorResult(`Brand ${brand_id} not found.`);
  const tenantId = brands[0].tenant_id;

  // Build analyze payload — resolve upload_token to actual PDF data
  const analyzePayload = {};

  if (upload_token) {
    // Fetch uploaded file from Blobs
    const { verifyUploadToken } = await import("./upload-ref.js");
    if (!verifyUploadToken(upload_token)) {
      return errorResult("Upload token is invalid or expired.");
    }
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "upload-refs", consistency: "strong" });
    const fileData = await store.get(`${upload_token}/file`, { type: "arrayBuffer" });
    if (!fileData) {
      return errorResult("No file found for this upload token. Ask the user to upload the file first.");
    }
    analyzePayload.pdf_base64 = Buffer.from(fileData).toString("base64");
  } else if (source_url) {
    analyzePayload.source_url = source_url;
  } else {
    analyzePayload.pdf_base64 = pdf_base64;
  }
  if (requestedPages) analyzePayload.pages = requestedPages;

  let pdfAnalysis;
  try {
    pdfAnalysis = await callRenderService("/render/analyze-pdf", analyzePayload, tenantId);
  } catch (e) {
    return errorResult(`PDF analysis failed: ${e.message}`);
  }

  return metaResult({
    task: "Map PDF design analysis to brand tokens",
    description:
      "The server has extracted colors, fonts, spacing, and layout from the PDF. " +
      "Review the analysis below and produce a brand_tokens object. " +
      "Map the extracted font names to CSS-safe font-family values. " +
      "Use the detected colors, margins, and layout to set appropriate tokens. " +
      "Then save via report2__save_brand_tokens.",
    output_schema: {
      type: "object",
      properties: {
        primary_color: { type: "string", description: "Hex primary color" },
        primary_dark_color: { type: "string" },
        accent_color: { type: "string" },
        text_color: { type: "string" },
        text_muted_color: { type: "string" },
        bg_color: { type: "string" },
        bg_light_color: { type: "string" },
        border_color: { type: "string" },
        font_display: { type: "string", description: "CSS font-family for titles" },
        font_heading: { type: "string" },
        font_body: { type: "string" },
        margin_top_mm: { type: "number" },
        margin_inner_mm: { type: "number" },
        margin_outer_mm: { type: "number" },
        margin_bottom_mm: { type: "number" },
        column_gap_mm: { type: "number" },
        section_gap_mm: { type: "number" },
      },
    },
    save_result_via: "report2__save_brand_tokens",
    inputs: {
      brand_id,
      pdf_analysis: pdfAnalysis,
    },
    steps: [
      {
        action: "judge",
        instruction:
          "Review the pdf_analysis data. " +
          "(1) Colors: use analysis.colors.primary as primary_color, darken it for primary_dark_color, use analysis.colors.accent as accent_color. Use text/text_muted from analysis. Derive bg_light_color and border_color from the palette. " +
          "(2) Typography: map analysis.typography.display_font/heading_font/body_font to CSS font-family values. If the PDF font name looks like a specific typeface (e.g. 'ObviouslyWide-Bold'), keep the family name and add a generic fallback. " +
          "(3) Layout: use analysis.layout.margins_mm for margin tokens. Estimate column_gap_mm and section_gap_mm from the layout. " +
          "Return a brand_tokens object matching output_schema.",
        produces: "brand_tokens",
      },
      {
        action: "tool",
        tool: "report2__save_brand_tokens",
        args: { brand_id },
        args_from: { tokens: "brand_tokens" },
      },
    ],
  });
}

// ─── Handler: generate_template (Layer 2) ───────────────────────────────────

async function handleGenerateTemplate(userId, args) {
  const { reference_html, template_name } = args;
  if (!reference_html || !template_name) {
    return errorResult("reference_html and template_name are required.");
  }

  return metaResult({
    task: `Generate a token-based Jinja2 template variant '${template_name}'`,
    description:
      "Analyze the reference HTML/CSS and produce Jinja2 partials that match the visual language while using brand tokens as CSS custom properties. The new template must: (1) declare the same structure as standard-v1 (base.jinja2, modules/*.jinja2, slots/*.jinja2); (2) replace hardcoded colors/fonts/spacing with {{ tokens.* | default(...) }}; (3) keep the 4 module types and 3 slot categories; (4) support style overrides at module and slot level via the chain `ss.x or ms.x or default`.",
    inputs: {
      template_name,
      reference_html_length: reference_html.length,
      reference_html_preview: reference_html.slice(0, 2000),
    },
    steps: [
      {
        action: "judge",
        instruction:
          "Read the reference_html. Extract: font-family stacks, primary/accent colors, heading sizes, body line-height, page margins, section spacing. List everything that should become a token.",
        produces: "design_audit",
      },
      {
        action: "judge",
        instruction:
          "Produce Jinja2 partial contents for: base.jinja2, modules/cover.jinja2, modules/chapter_break.jinja2, modules/back_cover.jinja2, modules/layout.jinja2, slots/text.jinja2, slots/data.jinja2, slots/media.jinja2. Every color/font/margin must reference a token. Preserve module_type and slot.category contracts.",
        produces: "template_files",
      },
      {
        action: "note",
        text: "Write the template_files to smyra-render/templates/<template_name>/ via the file system. Then register it by calling report2__list_templates to verify.",
      },
    ],
  });
}

// ─── Handler: debug_rendering (Layer 2) ─────────────────────────────────────

async function handleDebugRendering(userId, args) {
  const { module_id, issue } = args;
  if (!module_id) return errorResult("module_id is required.");

  const sql = getSql();
  const rows = await sql`
    SELECT m.id, m.module_type, m.content, m.style, m.html_cache, m.height_mm,
           r.id AS report_id, r.brand_id, r.template_id, r.tenant_id
    FROM v2_report_modules m
    JOIN v2_reports r ON r.id = m.report_id
    WHERE m.id = ${module_id}
    LIMIT 1
  `;
  if (!rows.length) return errorResult(`Module ${module_id} not found.`);
  const mod = rows[0];

  return metaResult({
    task: "Debug a rendering issue",
    inputs: {
      module_id,
      reported_issue: issue || "(not specified)",
      module_type: mod.module_type,
      content: mod.content,
      style: mod.style,
      height_mm: mod.height_mm,
      html_cache_preview: (mod.html_cache || "").slice(0, 2000),
      report_id: mod.report_id,
      brand_id: mod.brand_id,
      template_id: mod.template_id,
    },
    steps: [
      {
        action: "tool",
        tool: "report2__render_pdf",
        args: { report_id: mod.report_id, mode: "draft" },
        store_as: "draft_pdf",
      },
      {
        action: "tool",
        tool: "report2__rasterize_pdf",
        args: { report_id: mod.report_id },
        store_as: "page_images",
      },
      {
        action: "judge",
        instruction:
          "Inspect the page_images alongside the module content/style/html_cache. Identify the visible problem (overflow, wrong font, color mismatch, broken layout, missing asset). Propose a minimal fix: either (a) update content, (b) update module style overrides, or (c) change template. Be concrete — produce the exact args for report2__update_module.",
        uses: ["page_images"],
        produces: "fix_proposal",
      },
      {
        action: "tool",
        tool: "report2__update_module",
        args: { module_id },
        args_from: { content: "fix_proposal.content", style: "fix_proposal.style" },
        optional: true,
      },
    ],
  });
}

// ─── Handler: create_slot_variant (Layer 2) ─────────────────────────────────

async function handleCreateSlotVariant(userId, args) {
  const { category, description, example_content } = args;
  if (!category || !description) {
    return errorResult("category and description are required.");
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return errorResult(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }

  return metaResult({
    task: `Design a new '${category}' slot variant`,
    description:
      "Slot variants are content-driven — no 'variant' field. The presence of specific keys in the content object determines rendering. Your job is to: (1) define which content keys trigger this variant, (2) propose the Jinja2 block to add to slots/" + category + ".jinja2, (3) test it with example_content.",
    inputs: {
      category,
      user_description: description,
      example_content: example_content || null,
    },
    steps: [
      {
        action: "judge",
        instruction:
          "Given the description, decide which content keys are signature of this variant (must not collide with existing ones in the slot template). Produce a Jinja2 {% elif %} block that renders when those keys are present. Use style-override chain (ss.x or ms.x or default) for every dimension.",
        produces: "variant_block",
      },
      {
        action: "note",
        text: "Insert variant_block into smyra-render/templates/standard-v1/slots/" + category + ".jinja2 at the appropriate position (before the generic fallback).",
      },
      {
        action: "tool",
        tool: "report2__add_module",
        args: {
          module_type: "layout",
          content: {
            columns: "full",
            slots: [{ category, content: example_content || {} }],
          },
        },
        args_from: { report_id: "test_report_id" },
        optional: true,
        note: "Test render with the example_content to verify the new variant works.",
      },
    ],
  });
}

// ─── HANDLERS map ───────────────────────────────────────────────────────────

const HANDLERS = {
  create:                handleCreate,
  add_module:            handleAddModule,
  update_module:         handleUpdateModule,
  move_module:           handleMoveModule,
  delete_module:         handleDeleteModule,
  get_structure:         handleGetStructure,
  build_pages:           handleBuildPages,
  render_pdf:            handleRenderPdf,
  preview_plan:          handlePreviewPlan,
  render_module_thumbnails: handleRenderModuleThumbnails,
  get_editor_url:        handleGetEditorUrl,
  save_brand_tokens:     handleSaveBrandTokens,
  get_brand_tokens:      handleGetBrandTokens,
  upload_font:           handleUploadFont,
  upload_logo:           handleUploadLogo,
  upload_asset:          handleUploadAsset,
  list_assets:           handleListAssets,
  list_templates:        handleListTemplates,
  get_stub_plan:         handleGetStubPlan,
  list_brands:           handleListBrands,
  get_module_schema:     handleGetModuleSchema,
  save_blueprint:        handleSaveBlueprint,
  list_blueprints:       handleListBlueprints,
  create_from_blueprint: handleCreateFromBlueprint,
  save_component:        handleSaveComponent,
  list_components:       handleListComponents,
  get_component:         handleGetComponent,
  fork_component:        handleForkComponent,
  render_component_preview: handleRenderComponentPreview,
  // Design extraction lifecycle
  create_design_extraction: handleCreateDesignExtraction,
  update_design_extraction: handleUpdateDesignExtraction,
  get_design_extraction:    handleGetDesignExtraction,
  list_design_extractions:  handleListDesignExtractions,
  apply_design_extraction:  handleApplyDesignExtraction,
  rasterize_pdf:         handleRasterizePdf,
  request_upload:        handleRequestUpload,
  check_upload:          handleCheckUpload,
  // Layer 2 meta-code tools
  extract_design_from_pdf: handleExtractDesignFromPdf,
  generate_template:       handleGenerateTemplate,
  debug_rendering:         handleDebugRendering,
  create_slot_variant:     handleCreateSlotVariant,
};

// ─── Main handler ───────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const token = readBearerToken(event);

  // Auth: Hub JWT (RS256)
  const publicPem = process.env.HUB_JWT_PUBLIC_KEY_PEM;
  const issuer = process.env.HUB_JWT_ISSUER ?? "hub.rotor-platform.com";
  const audience = process.env.MODULE_AUDIENCE ?? "report-ai";
  if (!publicPem) return jsonResponse(500, { error: "HUB_JWT_PUBLIC_KEY_PEM not configured" });

  const auth = verifyHubJwt(token, { publicPem, issuer, audience });
  if (!auth.ok) return jsonResponse(401, { error: auth.error });

  const hubUserId = auth.payload.sub ?? auth.payload.user_id ?? auth.payload.tenant_id;
  if (!hubUserId) return jsonResponse(401, { error: "JWT missing subject" });

  let rpc;
  try { rpc = JSON.parse(event.body ?? "{}"); } catch { return rpcError(null, -32700, "Parse error"); }

  const { method, params, id } = rpc;

  if (method === "initialize") return rpcResult(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "report-ai-v2", version: "0.1.0" } });
  if (method === "notifications/initialized") return rpcResult(id, {});
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  if (method === "tools/call") {
    const name = params?.name ?? "";
    const args = params?.arguments ?? {};
    const toolName = name.startsWith("report2__") ? name.slice(9) : name;
    const fn = HANDLERS[toolName];
    if (!fn) return rpcError(id, -32601, `Unknown tool: ${name}`);

    try {
      return rpcResult(id, await fn(hubUserId, args, event));
    } catch (e) {
      console.error(`[mcp-v2] ${toolName} failed:`, e);
      return rpcError(id, -32000, e.message ?? "Internal error");
    }
  }

  return rpcError(id, -32601, `Method not supported: ${method ?? ""}`);
};
