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
import { randomUUID, randomBytes, createHmac } from "node:crypto";
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

// Per-format height budgets for packing layout modules on a single page.
// Derived from: (page_height_mm - top_margin - bottom_margin) - headroom.
// Headroom absorbs the known measurement/render delta (~10-20%) — /render/measure
// fragment probe underestimates full-page context render height. When the
// measurement pipeline tightens, these can grow closer to the real content
// area. Formats not listed fall back to HEIGHT_BUDGET_BY_FORMAT.a4_portrait.
//
// Numbers: physical page / margins / content height / budget (headroom)
//   a4_portrait:      210×297  / 18+16  /  263  /  215  (~48mm)
//   a4_landscape:     297×210  / 15+15  /  180  /  150  (~30mm)
//   us_letter:        216×279  / 20+20  /  239  /  195  (~44mm)
//   us_letter_land:   279×216  / 15+15  /  186  /  155  (~31mm)
//   presentation:     338×190  / 12+12  /  166  /  140  (~26mm)
//   square:           210×210  / 18+16  /  176  /  150  (~26mm)
//   digital:          1440×∞   /  n/a   /   ∞   /  800  (no hard limit; still want pagination)
const HEIGHT_BUDGET_BY_FORMAT = {
  a4_portrait: 215,
  a4_landscape: 150,
  us_letter: 195,
  us_letter_landscape: 155,
  presentation: 140,
  square: 150,
  digital: 800,
};
const DEFAULT_HEIGHT_BUDGET_MM = HEIGHT_BUDGET_BY_FORMAT.a4_portrait;
const SECTION_GAP_MM = 6;

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

async function getBlobStore(storeName, event, opts = {}) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (event) connectLambda(event);
    return getStore({ name: storeName, ...opts });
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: storeName, siteID, token, ...opts });
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
        page_format: { type: "string", description: "Page format: a4_portrait (default) | a4_landscape | presentation | us_letter | square | digital" },
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
    name: "persist_freeform_pages",
    description: "alpha-v3: writes the final set of freeform HTML pages into v2_report_pages + v2_report_modules so the editor (/v2/reports/<id>) and the legacy render_pdf tool can find them. Called by smyra-core at module_review approve_all, BEFORE enqueueRender. The report must already exist (created_at row in v2_reports). Existing rows for the same (report_id, page_number) are replaced so retries and patches converge. Also writes the final document_css onto v2_reports.document_css.",
    inputSchema: {
      type: "object",
      required: ["report_id", "pages", "design_system_css"],
      properties: {
        report_id: { type: "string", description: "UUID of the v2_reports row to populate." },
        pages: {
          type: "array",
          items: {
            type: "object",
            required: ["page_num", "html"],
            properties: {
              page_num: { type: "number", description: "1-indexed page number." },
              page_type: { type: "string", description: "cover | content | chapter_break | back_cover. Defaults to content." },
              html: { type: "string", description: "Freeform HTML for this page (a <section class='page'> root, as produced by page_design)." },
            },
          },
        },
        design_system_css: { type: "string", description: "Final design_system_css for the report — stored on v2_reports.document_css so the editor and render_pdf can cascade it." },
        augmented_design_css_additions: { type: "string", description: "Optional CSS appended after design_system_css (module_review patches). Stored on v2_reports.document_css_overrides." },
      },
    },
  },
  {
    name: "render_freeform_pdf",
    description: "alpha-v3 render path: renders a PDF from freeform HTML pages + design_system_css passed inline. Used by the rotor-platform-hub's render-worker-background when a render_jobs row carries a freeform payload. Unlike render_pdf this does NOT read v2_report_pages — the caller is the source of truth for page content. Use render_pdf for legacy v2 reports.",
    inputSchema: {
      type: "object",
      required: ["payload", "report_id", "mode"],
      properties: {
        payload: {
          type: "object",
          required: ["pages", "design_system_css", "brand_id"],
          properties: {
            pages: {
              type: "array",
              items: {
                type: "object",
                required: ["page_num", "html"],
                properties: {
                  page_num: { type: "number" },
                  module_ids: { type: "array", items: { type: "string" } },
                  html: { type: "string" },
                },
              },
            },
            design_system_css: { type: "string" },
            augmented_design_css_additions: { type: "string" },
            brand_id: { type: "string" },
            page_format: { type: "string" },
            title: { type: "string" },
          },
        },
        report_id: { type: "string" },
        mode: { type: "string", enum: ["draft", "final"] },
      },
    },
  },
  {
    name: "render_freeform_thumbnails",
    description: "Render a list of freeform HTML pages as PNG thumbnails. Used by smyra-core workflow steps (design_language, page_design, module_review) to show the user visual previews of what Claude is about to approve, so they don't sign off blindly. Stores PNGs in the report-ai-assets blob store and returns hash-stable URLs.",
    inputSchema: {
      type: "object",
      required: ["pages", "design_system_css", "brand_id"],
      properties: {
        pages: {
          type: "array",
          description: "Pages to render. Each entry must have page_num (number) and html (non-empty string).",
          items: {
            type: "object",
            required: ["page_num", "html"],
            properties: {
              page_num: { type: "number" },
              html: { type: "string" },
            },
          },
        },
        design_system_css: {
          type: "string",
          description: "The report's design_system_css. Injected as document_css into each rendered page.",
        },
        brand_id: { type: "string", description: "Brand UUID for token resolution + blob-scoping." },
        page_format: { type: "string", description: "a4_portrait | a4_landscape | presentation | us_letter | square | digital. Default a4_portrait." },
        return_base64: { type: "boolean", description: "If true, each returned thumbnail also carries png_base64 alongside the URL. Used by workflow pauses that want to attach the image as an MCP image content block for Claude's multimodal view." },
        thumbnail_dpi: { type: "number", description: "When return_base64 is true, rasterize at this DPI instead of the default 150 so the base64 payload stays under MCP response-size limits. Recommended: 72 for design review, 48 for dense multi-page overviews. Ignored when return_base64 is false." },
      },
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
    description: "Save an alpha-v3 design-language blueprint (design_system_css + sample_pages_html + design_rules). Called by smyra-core after a design-extraction or user-driven design session. Returns blueprint_id. Visibility: 'brand' (default), 'tenant', or 'smyra' (requires ALLOW_SMYRA_WRITE env var).",
    inputSchema: {
      type: "object",
      required: ["name", "design_system_css", "sample_pages_html", "design_rules"],
      properties: {
        brand_id: { type: "string", description: "Required when visibility='brand'. The brand this blueprint belongs to." },
        tenant_id: { type: "string", description: "Required when visibility='tenant'. Stored as owner_tenant_id." },
        name: { type: "string", description: "Human-readable blueprint name." },
        visibility: { type: "string", enum: ["smyra", "tenant", "brand"], description: "Access scope. Default 'brand'. 'smyra' requires ALLOW_SMYRA_WRITE=true on server." },
        style_direction: { type: "string", description: "e.g. 'Editorial', 'Minimal', 'Dense', 'Corporate'" },
        design_system_css: { type: "string", description: "Full CSS design system — custom properties, base resets, component classes." },
        sample_pages_html: { type: "array", items: { type: "string" }, description: "Array of HTML strings, one per sample page. Stored as JSONB." },
        design_rules: { type: "string", description: "Plain-text art-direction rules describing when and how to use this design system." },
        doctype_hint: { type: "string", description: "Document type hint, e.g. 'quarterly', 'annual'. Stored in document_type column." },
        reference_source: { type: "string", enum: ["extracted_from_pdf", "user_created", "starter_pack"], description: "How the blueprint was produced." },
        module_count: { type: "number", description: "Approximate number of report modules this blueprint is designed for." },
        source_report_id: { type: "string", description: "Audit trail: the report_id this blueprint was extracted from (if any)." },
      },
    },
  },
  {
    name: "list_blueprints",
    description: "List alpha-v3 blueprints visible to the caller (brand-owned + Smyra templates). Returns only rows with a design_system_css payload — legacy blueprints are excluded. Filter by document_type or style.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string", description: "Include blueprints owned by this brand. Omit to see only Smyra-visibility blueprints." },
        document_type: { type: "string", description: "Filter: 'quarterly' | 'annual' | 'whitepaper' | 'case_study' | 'pitch' | 'newsletter' | 'research_brief' | 'product_spec' | 'esg_report' | 'investor_update'" },
        style: { type: "string", description: "Filter by style_direction, e.g. 'Editorial', 'Minimal', 'Dense', 'Corporate', 'Technical', 'Expressive', 'Hero'" },
      },
    },
  },
  {
    name: "get_blueprint",
    description: "Fetch the full alpha-v3 payload for a blueprint: design_system_css + sample_pages_html + design_rules + visibility. Called by smyra-core setup.ts right after the user picks a blueprint in the start-point. Enforces visibility-based auth.",
    inputSchema: {
      type: "object",
      required: ["blueprint_id"],
      properties: {
        blueprint_id: { type: "string", description: "UUID of the blueprint to fetch." },
      },
    },
  },
  {
    name: "list_smyra_templates",
    description: "List Smyra platform-level alpha-v3 blueprints (visibility='smyra'). Curated templates available to every tenant as a starting point. Returns alpha-v3 shape only (design_system_css required).",
    inputSchema: {
      type: "object",
      properties: {
        document_type: { type: "string", description: "e.g. 'quarterly', 'annual', 'whitepaper'" },
        style: { type: "string", description: "e.g. 'Editorial', 'Minimal'" },
      },
    },
  },
  {
    name: "preview_blueprint",
    description: "Get a detailed view of one blueprint: its slot structure, narrative guidance, large thumbnail URL, and a 'chat_summary' sentence describing what Claude will ask the user for. Use when the user wants to see a template in detail before committing.",
    inputSchema: {
      type: "object",
      properties: {
        blueprint_id: { type: "string" },
      },
      required: ["blueprint_id"],
    },
  },
  {
    name: "create_from_blueprint",
    description: "Create a new report linked to an alpha-v3 blueprint. For Smyra-visibility blueprints (no owner brand), pass brand_id explicitly. The blueprint must have design_system_css set (alpha-v3 only — legacy blueprints are rejected). Returns report_id; call get_blueprint separately for the full design payload.",
    inputSchema: {
      type: "object",
      properties: {
        blueprint_id: { type: "string" },
        title: { type: "string" },
        document_type: { type: "string" },
        brand_id: { type: "string", description: "Required when the blueprint is Smyra-visibility (has no owner brand). Ignored for brand-owned blueprints." },
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
        html_template: { type: "string", description: "HTML with {{PLACEHOLDER}} tokens. Use component-name-prefixed CSS classes (e.g. '.fs-blocks .val', '.heading-split __word') — NOT inline styles. One stylesheet per document at render time, so classes must not collide with other components." },
        css_template: { type: "string", description: "The CSS rules for the classes used in html_template. Scoped naturally by class prefix (e.g. '.fs-blocks .val { ... }'). Included in the document-level stylesheet at compose time so editor + PDF render identically." },
        splittable: { type: "boolean", description: "Can this variant be split across a page boundary? body_text / list DEFAULT true, other types DEFAULT false. Set true for plain lists / body text without per-item decoration. Set false for decorated variants (per-item backgrounds, gradients, borders) that look broken when split. Null/omitted = use the type default." },
        placeholder_schema: { type: "array", items: { type: "object" }, description: "Array of {name, required?, type?} describing placeholders" },
        design_notes: { type: "string", description: "Art director notes explaining the design choices" },
        source: { type: "string", enum: ["extraction", "report", "manual"] },
        is_default: { type: "boolean", description: "Set as default variant for this component_type+brand. Clears default flag on other variants of the same type." },
        extraction_id: { type: "string", description: "Optional design_extractions row this component was derived from" },
        is_public: { type: "boolean", description: "If true, any brand may fork this component into their own library" },
        unsplash_query: { type: "string", description: "Semantic hint for image placeholders, e.g. 'corporate boardroom blue'" },
        reference_page_numbers: { type: "array", items: { type: "integer" }, description: "Page numbers in the source PDF where this component appears" },
        harmony: { type: "array", items: { type: "string" }, description: "Optional palette-harmony tags (e.g. ['cool','monochrome']). Used by theme-reconcile to score variant picks against brand palette." },
        intensity: { type: "string", enum: ["quiet","medium","loud"], description: "Visual intensity of this variant. 'loud' = big display type, strong accent; 'quiet' = minimal, monochromatic." },
        accent_usage: { type: "string", enum: ["none","tint","strong"], description: "How prominently this variant uses the brand accent color. Variant-picker penalises 'strong' when brand accent is already loud." },
        content_tolerance: { type: "object", description: "Per-placeholder content tolerances, e.g. { TITLE: { ideal_chars: [8,24], max_chars: 40 } }. Variant-picker scores content fit against these." },
        chart_schema: { type: "object", description: "For chart variants only. Describes editable fields for the editor UI: { chart_type: ['bar','line'], labels: 'text[]', values: 'number[]', caption: 'text' }." },
        chart_color_mode: { type: "string", enum: ["brand","custom","brand-locked"], description: "For chart variants only. 'brand' = theme-reconcile computes palette from tokens (default). 'custom' = respect data-chart-colors attr. 'brand-locked' = ignore attr, force brand." },
        style_family: { type: "string", description: "Visual style family (Editorial, Creative, Minimal) used by the library picker to keep variants coherent across a single report. Picker prefers variants that share a family with the cover." },
        report_id: { type: "string", description: "If set, scopes this variant to a single report (brand_components.report_id). The variant becomes available ONLY when list_components is called with that report_id. Use for redesign-for-this-report flows to avoid polluting the permanent brand library." },
      },
      required: ["brand_id", "component_type", "label", "html_template"],
    },
  },
  {
    name: "list_components",
    description: "List components in a brand's component library. Returns all named variants per component_type. Filter by component_type to narrow results. Optionally include public components shared by other brands. Pass report_id to also include report-scoped variants.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string" },
        component_type: { type: "string", description: "Filter by type (optional)" },
        variant_name: { type: "string", description: "Filter to one specific variant (optional)" },
        include_public: { type: "boolean", description: "Also include is_public=true components from other brands" },
        extraction_id: { type: "string", description: "Filter to one specific extraction session" },
        report_id: { type: "string", description: "If set, results include brand-level variants (report_id IS NULL) AND variants scoped to this report_id. Report-scoped variants appear AFTER brand-level so downstream 'last wins by (type+variant)' logic prefers them." },
      },
      required: ["brand_id"],
    },
  },
  {
    name: "render_brand_components",
    description: "DEV: renders all saved brand_components for a brand into a single overview document (one card per component: name, variant, splittable flag, and the rendered preview). Returns a PDF URL so you can visually browse the entire library. Complements /v2/components dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        brand_id: { type: "string" },
        include_drafts: { type: "boolean", description: "Include draft/deprecated components (default false, ready only)" },
      },
      required: ["brand_id"],
    },
  },
  {
    name: "measure_height",
    description: "Measure the rendered height (mm) of an HTML fragment at a given page width. Thin wrapper around smyra-render /render/measure. Used by page-compose to detect page overflow before writing modules.",
    inputSchema: {
      type: "object",
      properties: {
        html_fragment: { type: "string" },
        page_width_mm: { type: "number" },
        brand_tokens: { type: "object" },
        brand_fonts: { type: "array" },
        document_css: { type: "string" },
      },
      required: ["html_fragment"],
    },
  },
  {
    name: "test_pipeline_smoke",
    description: "DEV (low-level pipeline test): creates a mini-report by inserting modules directly from the brand's existing library — SKIPS the workflow. Use to test compose/render/CSS pipeline in isolation. For a full workflow run (setup → plan → design → render, driven with canned inputs), use `workflow__test_run_report` instead.",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string" },
        verbose: { type: "boolean", description: "Include per-module HTML dumps (large output; default false)" },
      },
      required: ["report_id"],
    },
  },
  {
    name: "save_document_css",
    description: "Persist the assembled document-level stylesheet on v2_reports.document_css. Used by compose_pages after components are chosen; the editor and PDF render both load this exact string so preview and output match.",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string" },
        document_css: { type: "string" },
      },
      required: ["report_id", "document_css"],
    },
  },
  {
    name: "list_reports",
    description: "List existing v2 reports for a tenant or brand. Use when the user wants to reopen, re-render, or edit a previous report. Returns id, title, brand_id, tenant_id, template_id, updated_at, plus module count.",
    inputSchema: {
      type: "object",
      properties: {
        tenant_id: { type: "string", description: "Filter by tenant (optional)" },
        brand_id: { type: "string", description: "Filter by brand (optional)" },
        limit: { type: "number", description: "Max rows (default 20, max 100)" },
      },
    },
  },
  {
    name: "delete_component",
    description: "Delete a component from a brand's library. Use when the user wants to clean up unused or bad variants. Cannot be undone. For soft-delete (keep for history but hide from pickers), use save_component with status='deprecated' instead.",
    inputSchema: {
      type: "object",
      properties: {
        component_id: { type: "string", description: "Component to delete" },
        brand_id: { type: "string", description: "Must match — guards against cross-brand deletion" },
      },
      required: ["component_id", "brand_id"],
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
    name: "rasterize_upload",
    description: "Rasterize an uploaded PDF (referenced via upload_token from request_upload) into per-page PNG images. Returns base64 PNGs + cached image URLs. Used by design.extract_blueprint to feed reference pages back to the LLM as multimodal vision input.",
    inputSchema: {
      type: "object",
      properties: {
        upload_token: { type: "string", description: "Token from request_upload — server reads PDF from blob store." },
        pdf_base64: { type: "string", description: "Alternative: raw PDF bytes as base64. Use upload_token for anything > ~1 MB." },
        dpi: { type: "integer", description: "Rasterization DPI (default 96). Use 72 for thumbnails, 150 for high fidelity." },
        max_pages: { type: "integer", description: "Hard cap on pages rasterized (default 20). Reference PDFs longer than this should be sampled." },
      },
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
  const { tenant_id, brand_id, title, document_type, template_id, page_format } = args;
  if (!tenant_id || !brand_id || !title || !document_type) {
    return errorResult("tenant_id, brand_id, title, and document_type are required.");
  }
  const pageFormatValue = (page_format && typeof page_format === 'string') ? page_format : 'a4_portrait';

  const rows = await sql`
    INSERT INTO v2_reports (tenant_id, brand_id, template_id, title, document_type, status, page_format)
    VALUES (${tenant_id}, ${brand_id}, ${template_id || null}, ${title}, ${document_type}, 'draft', ${pageFormatValue})
    RETURNING id, tenant_id, brand_id, template_id, title, document_type, status, page_format, created_at
  `;
  return textResult({ report_id: rows[0].id, ...rows[0], next_step: "Add modules with report2__add_module." });
}

// ─── Handler: add_module ────────────────────────────────────────────────────

async function handleAddModule(userId, args) {
  const sql = getSql();
  const { report_id, module_type, content, style, after_module_id, html_content, order_index: explicitOrderIndex } = args;

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

  // Determine order_index. Three resolution modes:
  //   1. explicit order_index argument — caller knows exactly where the
  //      module goes. Essential for compose-pages, which parallelises
  //      addModule for 7+ pages; without explicit ordering the concurrent
  //      MAX(order_index) queries race and produce scrambled page order
  //      (cover ends up on page 3, back_cover on page 5 — the bug that
  //      forced compose-pages to run serially and eat Netlify's 26s limit).
  //   2. after_module_id — insert relative to an existing module, shift
  //      subsequent rows. Used by the editor's "insert module" action.
  //   3. fallback — next available order_index via MAX+1. Used by
  //      single-shot additions like the legacy append path.
  let orderIndex;
  if (typeof explicitOrderIndex === 'number' && Number.isFinite(explicitOrderIndex) && explicitOrderIndex >= 0) {
    orderIndex = Math.floor(explicitOrderIndex);
  } else if (after_module_id) {
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

  // Fast path: when html_content is provided it IS the final rendered HTML
  // (compose-pages builds it client-side from the designed components).
  // Write html_cache := html_content immediately so the editor/PDF have
  // content. Then call /render/measure SYNCHRONOUSLY to populate height_mm
  // — measure is much faster than /render/module (no re-wrapping the DOM,
  // just chrome-height probe) and is critical for handleBuildPages's
  // packing algorithm, which otherwise defaults to 60mm per module and
  // stuffs unrelated content onto one page.
  let heightMm = null;
  if (html_content) {
    try {
      await sql`
        UPDATE v2_report_modules SET html_cache = ${html_content}
        WHERE id = ${moduleId}
      `;
    } catch (e) {
      console.warn(`[mcp-v2] html_cache seed for ${moduleId} failed:`, e.message);
    }
    // Synchronous measure — /render/measure now honors document_css +
    // brand_tokens + brand_fonts (smyra-render commit 0b7644d), so the
    // height reflects the real rendered height, not a fragment probed
    // with browser-default fonts.
    try {
      const brand = await fetchBrandContext(sql, brandId);
      // Measure on page_width - 2*margin; default 170mm matches A4 portrait
      // minus 20mm margins.
      const measureResult = await callRenderService(
        "/render/measure",
        {
          html_fragment: html_content,
          page_width_mm: 170,
          brand_tokens: brand.tokens,
          brand_fonts: brand.fonts,
        },
        tenantId,
      );
      heightMm = measureResult.height_mm ?? null;
      if (heightMm != null) {
        await sql`UPDATE v2_report_modules SET height_mm = ${heightMm} WHERE id = ${moduleId}`;
      }
    } catch (e) {
      console.warn(`[mcp-v2] Measure failed for module ${moduleId}:`, e.message);
      // Height stays null. handleBuildPages falls back to 60mm default —
      // not ideal but content is still present.
    }
  } else {
    // Legacy path: no html_content, we must render from content+module_type.
    // Kept synchronous — legacy callers need html_cache for the response.
    try {
      const brand = await fetchBrandContext(sql, brandId);
      const renderResult = await callRenderService(
        "/render/module",
        { module_type, content, style: style || {}, brand_tokens: brand.tokens, brand_fonts: brand.fonts },
        tenantId,
      );
      heightMm = renderResult.height_mm ?? null;
      const htmlCache = renderResult.html_fragment ?? renderResult.html ?? null;
      await sql`
        UPDATE v2_report_modules SET html_cache = ${htmlCache}, height_mm = ${heightMm}
        WHERE id = ${moduleId}
      `;
    } catch (e) {
      console.warn(`[mcp-v2] Render failed for module ${moduleId}:`, e.message);
    }
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
  if (newHtmlContent) {
    // Fast path: freeform module — html_content IS the final rendered HTML.
    // Wrap it with any CSS-var style overrides on a :root-style shim and use
    // /render/measure to get an accurate height without a full re-render.
    // Mirrors handleAddModule's fast path so tweak:mN:--var:value updates are
    // cheap and re-rendered htmls stay WYSIWYG.
    let htmlCacheForEditor = newHtmlContent;
    try {
      const styleEntries = Object.entries(newStyle || {})
        .filter(([k, v]) => typeof k === 'string' && k.startsWith('--') && (typeof v === 'string' || typeof v === 'number'))
        .map(([k, v]) => `${k}: ${v};`)
        .join(' ');
      if (styleEntries) {
        // Wrap html_content in a div that carries the CSS-var overrides.
        // The vars cascade down to all components inside the module. We keep
        // the wrapper HTML in html_cache so editor + PDF both see it.
        htmlCacheForEditor = `<div class="v2-module-style-scope" style="${styleEntries}">${newHtmlContent}</div>`;
      }
      await sql`
        UPDATE v2_report_modules SET html_cache = ${htmlCacheForEditor}
        WHERE id = ${module_id}
      `;
    } catch (e) {
      console.warn(`[mcp-v2] html_cache seed for ${module_id} failed:`, e.message);
    }
    try {
      const brand = await fetchBrandContext(sql, mod.brand_id);
      const measureResult = await callRenderService(
        "/render/measure",
        {
          html_fragment: htmlCacheForEditor,
          page_width_mm: 170,
          brand_tokens: brand.tokens,
          brand_fonts: brand.fonts,
        },
        mod.tenant_id,
      );
      heightMm = measureResult.height_mm ?? null;
      if (heightMm != null) {
        await sql`UPDATE v2_report_modules SET height_mm = ${heightMm} WHERE id = ${module_id}`;
      }
    } catch (e) {
      console.warn(`[mcp-v2] Measure failed for module ${module_id}:`, e.message);
    }
  } else {
    // Legacy path: content+module_type → render from template
    try {
      const brand = await fetchBrandContext(sql, mod.brand_id);
      const renderResult = await callRenderService(
        "/render/module",
        { module_type: mod.module_type, content: newContent, style: newStyle, brand_tokens: brand.tokens, brand_fonts: brand.fonts },
        mod.tenant_id,
      );
      heightMm = renderResult.height_mm ?? null;
      const htmlCache = renderResult.html_fragment ?? renderResult.html ?? null;
      await sql`
        UPDATE v2_report_modules SET html_cache = ${htmlCache}, height_mm = ${heightMm}
        WHERE id = ${module_id}
      `;
    } catch (e) {
      console.warn(`[mcp-v2] Re-render failed for module ${module_id}:`, e.message);
    }
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
    SELECT id, template_id, page_format FROM v2_reports WHERE id = ${report_id} LIMIT 1
  `;
  if (!reports.length) return errorResult(`Report ${report_id} not found.`);

  // Height budget resolution priority:
  //   1. Template schema (if an explicit content_height_mm is set there)
  //   2. Report's page_format → HEIGHT_BUDGET_BY_FORMAT
  //   3. DEFAULT_HEIGHT_BUDGET_MM (A4 portrait)
  const reportFormat = reports[0].page_format || 'a4_portrait';
  let heightBudget = HEIGHT_BUDGET_BY_FORMAT[reportFormat] ?? DEFAULT_HEIGHT_BUDGET_MM;
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
      // Layout module: stack until height budget exceeded. Account for
      // the section-gap between modules — compose-pages emits a 6mm
      // spacer before each non-first module on a page. Without this the
      // packer silently under-counts by (n-1)*6mm.
      const gap = currentPageId ? SECTION_GAP_MM : 0;
      if (!currentPageId || currentPageHeight + gap + modHeight > heightBudget) {
        const pageRows = await sql`
          INSERT INTO v2_report_pages (report_id, page_number, page_type)
          VALUES (${report_id}, ${pageNumber}, 'content')
          RETURNING id
        `;
        currentPageId = pageRows[0].id;
        currentPageHeight = 0;
        pageSummary.push({ page: pageNumber, type: "content", modules: 0 });
        pageNumber++;
      } else {
        currentPageHeight += SECTION_GAP_MM;
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
  // IMPORTANT: SELECT document_css + style_overrides + page_format — the
  // Python render service needs the per-report stylesheet snapshot and
  // late-cascade overrides to reproduce the editor preview in PDF.
  // Without document_css the renderer falls back to generic defaults
  // and every component-level class rule (.dt-*, .tx-*, .cv-*, .bc-*)
  // drops out, which is why KPI value/label clump and cover titles
  // render without their bespoke CSS. See v2-render.js for the
  // original endpoint that got this right.
  const reports = await sql`
    SELECT r.id, r.tenant_id, r.brand_id, r.title, r.template_id,
           r.page_format, r.document_css, r.style_overrides
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
    SELECT id, page_id, module_type, order_index, content, style, html_cache, html_content, background
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

  // Build late-cascade overrides CSS so the Rapport-stil panel wins
  // over any :root tokens baked into document_css at compose time.
  // Same approach as v2-render.js.
  const overrides = report.style_overrides || {};
  const mergedTokens = { ...(brand.tokens || {}) };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === undefined || v === "") continue;
    mergedTokens[k] = v;
  }
  const overrideLines = Object.entries(overrides)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `--${k.replace(/_/g, "-")}: ${v};`);
  const overrideCss = overrideLines.length
    ? `:root { ${overrideLines.join(" ")} }`
    : "";

  // Call Python render service
  const pdfResult = await callRenderService("/render/pdf", {
    report_id,
    title: report.title,
    mode,
    page_format: report.page_format || "a4_portrait",
    pages: pages.map(p => ({
      ...p,
      modules: modules
        .filter(m => m.page_id === p.id)
        .map(m => ({ ...m, background: m.background || null })),
    })),
    brand_tokens: mergedTokens,
    brand_fonts: brand.fonts,
    brand_logos: brand.logos,
    css_base: cssBase,
    // document_css is the authoritative stylesheet snapshot written by
    // compose_pages — brand vars + design-system + per-component CSS.
    // Render service layers it over its generic defaults so output
    // matches the editor preview exactly.
    document_css: report.document_css ?? null,
    document_css_overrides: overrideCss,
    style_overrides: overrides,
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

  // Legacy shape detection: old callers passed { report_id, name }.
  // Alpha-v3 requires design_system_css + sample_pages_html + design_rules.
  if (args.report_id && !args.design_system_css) {
    return errorResult(
      "save_blueprint: alpha-v3 requires the full payload (design_system_css, sample_pages_html, design_rules). " +
      "Legacy {report_id, name} shape is no longer supported."
    );
  }

  const {
    brand_id,
    tenant_id,
    name,
    visibility = "brand",
    style_direction,
    design_system_css,
    sample_pages_html,
    design_rules,
    doctype_hint,
    reference_source,
    module_count,
    source_report_id,
  } = args;

  // Validate required alpha-v3 fields
  if (!name) return errorResult("name is required.");
  if (!design_system_css) return errorResult("design_system_css is required.");
  if (!Array.isArray(sample_pages_html) || sample_pages_html.length === 0) {
    return errorResult("sample_pages_html is required and must be a non-empty array of HTML strings.");
  }
  if (!design_rules) return errorResult("design_rules is required.");

  // Validate visibility-specific requirements
  if (visibility === "brand" && !brand_id) {
    return errorResult("brand_id is required when visibility='brand'.");
  }
  if (visibility === "tenant" && !tenant_id) {
    return errorResult("tenant_id is required when visibility='tenant'.");
  }

  // Smyra-visibility writes are restricted.
  // Decision: no admin concept exists in the JWT claims at this time.
  // We gate 'smyra' writes on the ALLOW_SMYRA_WRITE env var so that only
  // internal tooling/CI (which sets the env var) can publish platform templates.
  // Long-term fix: add an 'admin' scope to hub-minted JWTs and check that here.
  if (visibility === "smyra" && process.env.ALLOW_SMYRA_WRITE !== "true") {
    return errorResult("smyra visibility requires admin access (ALLOW_SMYRA_WRITE not enabled on this server).");
  }

  const samplePagesJson = JSON.stringify(sample_pages_html);

  const rows = await sql`
    INSERT INTO report_blueprints (
      brand_id,
      owner_tenant_id,
      name,
      visibility,
      style_direction,
      design_system_css,
      sample_pages_html,
      design_rules,
      document_type,
      reference_source,
      module_count,
      source_report_id,
      modules,
      slots
    ) VALUES (
      ${brand_id || null},
      ${tenant_id || null},
      ${name},
      ${visibility},
      ${style_direction || null},
      ${design_system_css},
      ${samplePagesJson}::jsonb,
      ${design_rules},
      ${doctype_hint || null},
      ${reference_source || null},
      ${module_count != null ? module_count : null},
      ${source_report_id || null},
      NULL,
      NULL
    )
    RETURNING id
  `;

  const blueprintId = rows[0].id;

  // Fire-and-forget: render a cover thumbnail from sample_pages_html[0] so
  // the setup picker can show a visual preview. Only for rows with a
  // brand_id (smyra-visibility starter packs are admin-seeded and get
  // covers via tooling). Errors are logged and swallowed — a missing
  // cover just means the picker falls back to a text-only choice.
  if (brand_id && typeof sample_pages_html[0] === "string") {
    Promise.resolve().then(() =>
      renderBlueprintCover(sql, {
        blueprintId,
        sampleHtml: sample_pages_html[0],
        designSystemCss: design_system_css,
        brandId: brand_id,
      })
    ).catch((err) =>
      console.error(`[blueprint_cover] ${blueprintId} background render failed:`, err?.message || err)
    );
  }

  return textResult({ blueprint_id: blueprintId });
}

// Renders sample_pages_html[0] once and stores the URL on the blueprint.
// Reuses the same content-addressed cache as render_freeform_thumbnails —
// if the page+CSS combo was ever rendered for preview, the blob already
// exists and we just record the URL. Called as background work from
// save_blueprint so the save response returns immediately.
async function renderBlueprintCover(sql, { blueprintId, sampleHtml, designSystemCss, brandId, pageFormat = "a4_portrait" }) {
  try {
    const brandRows = await sql`SELECT tenant_id FROM brands WHERE id = ${brandId} LIMIT 1`;
    const tenantId = brandRows[0]?.tenant_id;
    if (!tenantId) return;

    const { createHash } = await import("node:crypto");
    const cssHash = createHash("sha256").update(designSystemCss).digest("hex").slice(0, 8);
    const pageHash = createHash("sha256").update(sampleHtml).digest("hex").slice(0, 8);
    const blobKey = `thumbnails/${brandId}/${cssHash}-${pageHash}-p1.png`;
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const url = `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`;

    const assetStore = await getBlobStore("report-ai-assets");
    let cached = false;
    try {
      if (await assetStore.getMetadata(blobKey)) cached = true;
    } catch { /* cache miss */ }

    if (!cached) {
      const brand = await fetchBrandContext(sql, brandId);
      const syntheticPage = {
        id: randomUUID(),
        page_number: 1,
        page_type: "cover",
        modules: [{
          module_type: "freeform_page",
          order_index: 0,
          html_content: sampleHtml,
          html_cache: sampleHtml,
          content: {},
          style: {},
          background: null,
        }],
      };
      const pdfResult = await callRenderService("/render/pdf", {
        report_id: randomUUID(),
        title: "Blueprint cover",
        mode: "draft",
        page_format: pageFormat,
        pages: [syntheticPage],
        brand_tokens: brand.tokens ?? {},
        brand_fonts: brand.fonts ?? [],
        brand_logos: brand.logos ?? [],
        css_base: "",
        document_css: designSystemCss,
        document_css_overrides: "",
        style_overrides: {},
      }, tenantId);
      const pdfBuffer = pdfResult.pdf_bytes
        ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
      if (!pdfBuffer) throw new Error("render returned no PDF bytes");
      const raster = await callRenderService("/render/rasterize", {
        pdf_base64: pdfBuffer.toString("base64"),
      }, tenantId);
      const rasterPage = raster.pages?.[0];
      if (!rasterPage?.png_base64) throw new Error("rasterize returned no PNG");
      await assetStore.set(blobKey, Buffer.from(rasterPage.png_base64, "base64"), { contentType: "image/png" });
    }

    await sql`UPDATE report_blueprints SET cover_thumbnail_url = ${url} WHERE id = ${blueprintId}`;
    console.log(`[blueprint_cover] ${blueprintId} cover ${cached ? "reused" : "rendered"}`);
  } catch (err) {
    console.error(`[blueprint_cover] ${blueprintId} failed:`, err?.message || err);
  }
}

// ─── Blueprint helpers ──────────────────────────────────────────────────────

// Alpha-v3 list shape. Keeps responses lean — full CSS/HTML payload is only
// returned by handleGetBlueprint (called after the user picks a blueprint).
function shapeBlueprintListRow(r) {
  return {
    id: r.id,
    name: r.name,
    visibility: r.visibility,
    style_direction: r.style_direction,
    module_count: r.module_count != null ? r.module_count : null,
    // Rename document_type → doctype_hint in output to match alpha-v3 contract
    doctype_hint: r.document_type || null,
    cover_thumbnail_url: r.cover_thumbnail_url || null,
    created_at: r.created_at,
  };
}

// Full alpha-v3 payload shape — used by handleGetBlueprint.
function shapeBlueprintFullRow(r) {
  return {
    id: r.id,
    name: r.name,
    visibility: r.visibility,
    style_direction: r.style_direction,
    design_system_css: r.design_system_css,
    sample_pages_html: typeof r.sample_pages_html === "string"
      ? JSON.parse(r.sample_pages_html)
      : (r.sample_pages_html || []),
    design_rules: r.design_rules,
    doctype_hint: r.document_type || null,
    reference_source: r.reference_source || null,
    module_count: r.module_count != null ? r.module_count : null,
  };
}

// ─── Handler: list_blueprints ───────────────────────────────────────────────

async function handleListBlueprints(userId, args) {
  const sql = getSql();
  const { brand_id, document_type, style } = args || {};

  // Alpha-v3 only: filter to rows that have design_system_css populated.
  // Visibility: show Smyra-wide + tenant + brand-owned when brand_id supplied;
  // without brand_id, show only Smyra-visibility blueprints.
  let rows;
  if (brand_id) {
    rows = await sql`
      SELECT id, brand_id, visibility, name, document_type, style_direction,
             module_count, cover_thumbnail_url, created_at
      FROM report_blueprints
      WHERE design_system_css IS NOT NULL
        AND (visibility = 'smyra' OR brand_id = ${brand_id})
        AND (${document_type || null}::text IS NULL OR document_type = ${document_type || null})
        AND (${style || null}::text IS NULL OR style_direction = ${style || null})
      ORDER BY
        CASE visibility WHEN 'brand' THEN 0 WHEN 'tenant' THEN 1 WHEN 'smyra' THEN 2 END,
        updated_at DESC
      LIMIT 100
    `;
  } else {
    rows = await sql`
      SELECT id, brand_id, visibility, name, document_type, style_direction,
             module_count, cover_thumbnail_url, created_at
      FROM report_blueprints
      WHERE design_system_css IS NOT NULL
        AND visibility = 'smyra'
        AND (${document_type || null}::text IS NULL OR document_type = ${document_type || null})
        AND (${style || null}::text IS NULL OR style_direction = ${style || null})
      ORDER BY updated_at DESC
      LIMIT 100
    `;
  }

  const blueprints = rows.map(shapeBlueprintListRow);
  return textResult({
    blueprints,
    count: blueprints.length,
    filters: { brand_id, document_type, style },
  });
}

// ─── Handler: list_smyra_templates ──────────────────────────────────────────

async function handleListSmyraTemplates(userId, args) {
  // Shorthand for list_blueprints with visibility='smyra' — brand_id omitted
  // so only Smyra-visibility blueprints are returned.
  return handleListBlueprints(userId, { ...(args || {}), brand_id: undefined });
}

// ─── Handler: get_blueprint ─────────────────────────────────────────────────

async function handleGetBlueprint(userId, args) {
  const sql = getSql();
  const { blueprint_id } = args || {};
  if (!blueprint_id) return errorResult("blueprint_id is required.");

  const rows = await sql`
    SELECT id, brand_id, owner_tenant_id, visibility, name, document_type,
           style_direction, design_system_css, sample_pages_html, design_rules,
           reference_source, module_count
    FROM report_blueprints
    WHERE id = ${blueprint_id}
    LIMIT 1
  `;
  if (!rows.length) return errorResult("blueprint not found.");
  const r = rows[0];

  // Alpha-v3 only — legacy rows have no design_system_css
  if (!r.design_system_css) {
    return errorResult("blueprint is legacy (no alpha-v3 payload).");
  }

  // Visibility auth:
  //   'smyra'  → always accessible (platform-wide)
  //   'tenant' → owner_tenant_id must match (we trust the hub JWT sub as the
  //               tenant identifier; if it doesn't match, reject)
  //   'brand'  → brand_id is non-null and the hub is the authoritative caller;
  //               we trust the hub for brand auth (no brand ACL in this module)
  if (r.visibility === "tenant") {
    if (r.owner_tenant_id && r.owner_tenant_id !== userId) {
      return errorResult("blueprint not accessible.");
    }
  }
  // 'brand' and 'smyra' are accessible to any authenticated hub caller.

  return textResult(shapeBlueprintFullRow(r));
}

// ─── Handler: preview_blueprint ─────────────────────────────────────────────

async function handlePreviewBlueprint(userId, args) {
  const sql = getSql();
  const { blueprint_id } = args || {};
  if (!blueprint_id) return errorResult("blueprint_id is required.");

  const rows = await sql`
    SELECT id, brand_id, visibility, name, tagline, chat_summary,
           document_type, style_direction, tags, slots, narrative_guidance,
           modules, thumbnail_small_base64, thumbnail_url,
           pages_estimate, page_format, created_at, updated_at
    FROM report_blueprints WHERE id = ${blueprint_id} LIMIT 1
  `;
  if (!rows.length) return errorResult(`Blueprint ${blueprint_id} not found.`);
  const r = rows[0];

  const slots = typeof r.slots === "string" ? JSON.parse(r.slots) : r.slots;
  const modules = typeof r.modules === "string" ? JSON.parse(r.modules) : r.modules;
  const narrative = typeof r.narrative_guidance === "string"
    ? JSON.parse(r.narrative_guidance)
    : r.narrative_guidance;

  return textResult({
    ...shapeBlueprintRow(r, { includeThumb: true }),
    slots: slots || null,
    narrative_guidance: narrative || null,
    modules: modules || null,  // legacy compat
  });
}

// ─── Handler: create_from_blueprint ─────────────────────────────────────────

async function handleCreateFromBlueprint(userId, args) {
  const sql = getSql();
  const { blueprint_id, title, document_type } = args;
  if (!blueprint_id || !title || !document_type) {
    return errorResult("blueprint_id, title, and document_type are required.");
  }

  const blueprints = await sql`
    SELECT id, brand_id, owner_tenant_id, visibility, design_system_css, page_format
    FROM report_blueprints WHERE id = ${blueprint_id} LIMIT 1
  `;
  if (!blueprints.length) return errorResult(`Blueprint ${blueprint_id} not found.`);
  const bp = blueprints[0];

  // Alpha-v3 only — legacy blueprints (no design_system_css) must be recreated.
  if (!bp.design_system_css) {
    return errorResult("blueprint is legacy v2 — re-create it in alpha-v3 to use.");
  }

  // Resolve brand + tenant. Smyra-visibility blueprints have no brand,
  // so the caller must pass one to create a report under.
  let brandId = bp.brand_id;
  let tenantId = bp.owner_tenant_id;
  if (!brandId && args.brand_id) brandId = args.brand_id;
  if (!brandId) {
    return errorResult("This is a Smyra blueprint (no owner brand). Pass brand_id in the request to say which brand the report should be created under.");
  }
  if (!tenantId) {
    const brands = await sql`SELECT tenant_id FROM brands WHERE id = ${brandId} LIMIT 1`;
    if (!brands.length) return errorResult(`Brand ${brandId} not found.`);
    tenantId = brands[0].tenant_id;
  }

  // Create report linked to the blueprint. No modules are seeded — the hub
  // calls get_blueprint separately to fetch design payload and drive the
  // workflow from there.
  const reportRows = await sql`
    INSERT INTO v2_reports (tenant_id, brand_id, title, document_type, status, page_format)
    VALUES (${tenantId}, ${brandId}, ${title}, ${document_type}, 'draft', ${bp.page_format || 'a4_portrait'})
    RETURNING id
  `;
  const reportId = reportRows[0].id;

  return textResult({ report_id: reportId });
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
    css_template,
    splittable,
    placeholder_schema,
    design_notes,
    source,
    is_default,
    extraction_id,
    is_public,
    unsplash_query,
    reference_page_numbers,
    status,
    page_format,
    harmony,          // array of strings, default undefined
    intensity,        // 'quiet' | 'medium' | 'loud', default undefined
    accent_usage,     // 'none' | 'tint' | 'strong', default undefined
    content_tolerance, // object, default undefined
    chart_schema,     // object or null, default undefined
    chart_color_mode, // 'brand' | 'custom' | 'brand-locked', default undefined
    style_family,     // string, default undefined
    report_id,        // optional — scope variant to a single report
  } = args;
  const reportIdValue = (report_id && typeof report_id === 'string') ? report_id : null;
  const statusValue = ['draft', 'ready', 'deprecated'].includes(status) ? status : 'ready';
  const pageFormatValue = (page_format && typeof page_format === 'string') ? page_format : 'universal';
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
          css_template = ${css_template ?? null},
          splittable = ${typeof splittable === 'boolean' ? splittable : null},
          placeholder_schema = ${JSON.stringify(placeholder_schema || [])}::jsonb,
          design_notes = ${design_notes || null},
          source = ${source || 'manual'},
          is_default = ${is_default || false},
          extraction_id = ${extraction_id || null},
          is_public = ${is_public === true},
          unsplash_query = ${unsplash_query || null},
          reference_page_numbers = ${JSON.stringify(reference_page_numbers || [])}::jsonb,
          status = ${statusValue},
          page_format = ${pageFormatValue},
          harmony = COALESCE(${Array.isArray(harmony) ? harmony : null}::text[], harmony),
          intensity = COALESCE(${intensity ?? null}::text, intensity),
          accent_usage = COALESCE(${accent_usage ?? null}::text, accent_usage),
          content_tolerance = COALESCE(${content_tolerance ? JSON.stringify(content_tolerance) : null}::jsonb, content_tolerance),
          chart_schema = COALESCE(${chart_schema ? JSON.stringify(chart_schema) : null}::jsonb, chart_schema),
          chart_color_mode = COALESCE(${chart_color_mode ?? null}::text, chart_color_mode),
          style_family = COALESCE(${style_family ?? null}::text, style_family),
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${component_id} AND brand_id = ${brand_id}
      RETURNING id
    `;
    if (!rows.length) return errorResult(`Component ${component_id} not found for brand ${brand_id}.`);
    return textResult({ component_id: rows[0].id, component_type, variant_name: variantLabel, label, status: statusValue, updated: true });
  }

  // If a variant with the same (brand, type, variant_name, report_id) already exists, update it in place
  // rather than inserting a duplicate. Caller can explicitly pick a new variant_name to force a new row.
  // report_id NULL (brand-level) and a specific report_id are treated as separate scopes — a report-scoped
  // redesign must NOT silently overwrite the permanent brand-library variant with the same name.
  const existingSameVariant = reportIdValue
    ? await sql`
        SELECT id FROM brand_components
        WHERE brand_id = ${brand_id}
          AND component_type = ${component_type}
          AND variant_name = ${variantLabel}
          AND report_id = ${reportIdValue}
        LIMIT 1
      `
    : await sql`
        SELECT id FROM brand_components
        WHERE brand_id = ${brand_id}
          AND component_type = ${component_type}
          AND variant_name = ${variantLabel}
          AND report_id IS NULL
        LIMIT 1
      `;
  if (existingSameVariant.length) {
    const existingId = existingSameVariant[0].id;
    const rows = await sql`
      UPDATE brand_components
      SET label = ${label},
          html_template = ${html_template},
          css_template = ${css_template ?? null},
          splittable = ${typeof splittable === 'boolean' ? splittable : null},
          placeholder_schema = ${JSON.stringify(placeholder_schema || [])}::jsonb,
          design_notes = ${design_notes || null},
          source = ${source || 'manual'},
          is_default = ${is_default || false},
          extraction_id = ${extraction_id || null},
          is_public = ${is_public === true},
          unsplash_query = ${unsplash_query || null},
          reference_page_numbers = ${JSON.stringify(reference_page_numbers || [])}::jsonb,
          status = ${statusValue},
          page_format = ${pageFormatValue},
          harmony = COALESCE(${Array.isArray(harmony) ? harmony : null}::text[], harmony),
          intensity = COALESCE(${intensity ?? null}::text, intensity),
          accent_usage = COALESCE(${accent_usage ?? null}::text, accent_usage),
          content_tolerance = COALESCE(${content_tolerance ? JSON.stringify(content_tolerance) : null}::jsonb, content_tolerance),
          chart_schema = COALESCE(${chart_schema ? JSON.stringify(chart_schema) : null}::jsonb, chart_schema),
          chart_color_mode = COALESCE(${chart_color_mode ?? null}::text, chart_color_mode),
          style_family = COALESCE(${style_family ?? null}::text, style_family),
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${existingId}
      RETURNING id
    `;
    return textResult({ component_id: rows[0].id, component_type, variant_name: variantLabel, label, status: statusValue, updated: true });
  }

  const rows = await sql`
    INSERT INTO brand_components (
      brand_id, component_type, variant_name, label, html_template, css_template, splittable, placeholder_schema,
      design_notes, source, is_default,
      extraction_id, is_public, unsplash_query, reference_page_numbers, status, page_format,
      harmony, intensity, accent_usage, content_tolerance, chart_schema, chart_color_mode, style_family,
      report_id
    )
    VALUES (
      ${brand_id}, ${component_type}, ${variantLabel}, ${label}, ${html_template},
      ${css_template ?? null},
      ${typeof splittable === 'boolean' ? splittable : null},
      ${JSON.stringify(placeholder_schema || [])}::jsonb,
      ${design_notes || null}, ${source || 'manual'}, ${is_default || false},
      ${extraction_id || null}, ${is_public === true}, ${unsplash_query || null},
      ${JSON.stringify(reference_page_numbers || [])}::jsonb,
      ${statusValue}, ${pageFormatValue},
      ${Array.isArray(harmony) ? harmony : null}::text[],
      ${intensity ?? null}::text,
      ${accent_usage ?? null}::text,
      ${content_tolerance ? JSON.stringify(content_tolerance) : null}::jsonb,
      ${chart_schema ? JSON.stringify(chart_schema) : null}::jsonb,
      ${chart_color_mode ?? null}::text,
      ${style_family ?? null}::text,
      ${reportIdValue}::uuid
    )
    RETURNING id
  `;

  return textResult({ component_id: rows[0].id, component_type, variant_name: variantLabel, label, status: statusValue, page_format: pageFormatValue, report_id: reportIdValue });
}

// ─── Handler: list_components ───────────────────────────────────────────────

async function handleListComponents(userId, args) {
  const sql = getSql();
  const { brand_id, component_type, variant_name, include_public, extraction_id, include_drafts, status, page_format, report_id } = args;
  if (!brand_id) return errorResult("brand_id is required.");

  const typeFilter = component_type || null;
  const variantFilter = variant_name || null;
  const extractionFilter = extraction_id || null;
  const includePublic = include_public === true;
  const reportIdFilter = (report_id && typeof report_id === 'string') ? report_id : null;
  // Default: only 'ready' components. Caller can pass include_drafts=true
  // or status='all' / status='<specific>' to widen the query.
  const statusFilter = status === 'all'
    ? null
    : (status && ['draft', 'ready', 'deprecated'].includes(status) ? status : (include_drafts ? null : 'ready'));
  // page_format: when caller specifies a format, return components
  // tagged with that format OR 'universal' (format-agnostic). Pass
  // page_format='all' to skip the filter entirely.
  const pageFormatFilter = (page_format && page_format !== 'all' && typeof page_format === 'string') ? page_format : null;

  // report_id filter:
  //   - When reportIdFilter is set: include rows with report_id IS NULL (brand-level)
  //     AND rows matching that specific report_id. Brand-level variants appear
  //     first in the ORDER BY (report_id_sort=0 before 1) so downstream
  //     "last wins by (type+variant)" consumers correctly prefer report-scoped.
  //   - When reportIdFilter is NULL: only brand-level (report_id IS NULL). Keeps
  //     the pre-existing behaviour for callers that don't know about report scopes.
  const rows = await sql`
    SELECT id, brand_id, component_type, variant_name, label, is_default,
           placeholder_schema, html_template, css_template, splittable, design_notes, source,
           extraction_id, is_public, unsplash_query, reference_page_numbers,
           thumbnail_url, thumbnail_generated_at, status, page_format,
           harmony, intensity, accent_usage, content_tolerance, chart_schema, chart_color_mode, style_family,
           report_id,
           version, created_at, updated_at,
           CASE WHEN report_id IS NULL THEN 0 ELSE 1 END AS report_id_sort
    FROM brand_components
    WHERE (brand_id = ${brand_id} OR (${includePublic} AND is_public = true))
      AND (${typeFilter}::text IS NULL OR component_type = ${typeFilter})
      AND (${variantFilter}::text IS NULL OR variant_name = ${variantFilter})
      AND (${extractionFilter}::uuid IS NULL OR extraction_id = ${extractionFilter}::uuid)
      AND (${statusFilter}::text IS NULL OR status = ${statusFilter})
      AND (${pageFormatFilter}::text IS NULL OR page_format = ${pageFormatFilter} OR page_format = 'universal')
      AND (
        (${reportIdFilter}::uuid IS NULL AND report_id IS NULL)
        OR (${reportIdFilter}::uuid IS NOT NULL AND (report_id IS NULL OR report_id = ${reportIdFilter}::uuid))
      )
      AND html_template IS NOT NULL AND trim(html_template) != ''
    ORDER BY component_type, report_id_sort, is_default DESC, variant_name, updated_at DESC
  `;

  return textResult({ components: rows, count: rows.length });
}

// ─── Handler: fork_component ────────────────────────────────────────────────

// ─── Handler: render_brand_components ───────────────────────────────────────

async function handleRenderBrandComponents(userId, args) {
  const sql = getSql();
  const { brand_id, include_drafts } = args || {};
  if (!brand_id) return errorResult("brand_id is required.");

  const brands = await sql`SELECT id, tokens, tenant_id, name FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (!brands.length) return errorResult(`Brand ${brand_id} not found.`);
  const brand = brands[0];

  const components = include_drafts
    ? await sql`SELECT * FROM brand_components WHERE brand_id = ${brand_id} ORDER BY component_type, is_default DESC, variant_name`
    : await sql`SELECT * FROM brand_components WHERE brand_id = ${brand_id} AND status = 'ready' ORDER BY component_type, is_default DESC, variant_name`;

  if (!components.length) {
    return errorResult(`No components found for brand ${brand_id}.`);
  }

  // Build a single freeform HTML page listing every component with a preview.
  const tokens = brand.tokens || {};
  const fonts = await sql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brand_id}`;

  // Assemble page CSS: brand vars + all component CSS + overview chrome
  const cssLayers = [':root {'];
  const colorMap = {
    primary_color: '--primary', primary_dark_color: '--primary-dark', accent_color: '--accent',
    secondary_color: '--secondary', text_color: '--text', text_muted_color: '--text-muted',
    bg_color: '--bg', bg_light_color: '--bg-light', surface_color: '--surface', border_color: '--border',
  };
  for (const [k, v] of Object.entries(tokens)) {
    if (k.startsWith('_') || v == null || v === '') continue;
    if (colorMap[k]) { cssLayers.push(`  ${colorMap[k]}: ${v};`); continue; }
    if (k === 'font_display') { cssLayers.push(`  --font-display: '${v}', system-ui, sans-serif;`); continue; }
    if (k === 'font_heading') { cssLayers.push(`  --font-heading: '${v}', system-ui, sans-serif;`); continue; }
    if (k === 'font_body')    { cssLayers.push(`  --font-body: '${v}', system-ui, sans-serif;`); continue; }
    cssLayers.push(`  --${k.replace(/_/g, '-')}: ${v};`);
  }
  cssLayers.push('}');
  cssLayers.push(`
    .lib-page { padding: 15mm; font-family: var(--font-body, system-ui); color: var(--text, #111); background: var(--bg, #fff); }
    .lib-title { font-family: var(--font-display, serif); font-size: 18pt; margin-bottom: 8mm; color: var(--primary, #222); }
    .lib-card { margin-bottom: 12mm; padding: 6mm; border: 1px solid var(--border, #ddd); border-radius: 2mm; page-break-inside: avoid; }
    .lib-card-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4mm; border-bottom: 1px dashed var(--border, #ddd); padding-bottom: 2mm; }
    .lib-card-name { font-family: var(--font-heading, sans-serif); font-size: 11pt; font-weight: 600; color: var(--primary, #222); }
    .lib-card-meta { font-size: 7pt; color: var(--text-muted, #666); }
    .lib-card-badges { font-size: 7pt; }
    .lib-card-preview { padding: 4mm; background: var(--bg-light, #f5f5f5); border-radius: 1mm; }
    .lib-split-yes { color: #15803d; }
    .lib-split-no { color: #b91c1c; }
  `);
  for (const c of components) {
    if (c.css_template?.trim()) {
      cssLayers.push(`/* ${c.component_type} — ${c.variant_name || 'Default'} */`);
      cssLayers.push(c.css_template.trim());
    }
  }
  const pageCss = cssLayers.join('\n');

  const SPLIT_DEFAULTS_JS = {
    body_text: true, list: true,
  };
  function isSplit(c) {
    if (typeof c.splittable === 'boolean') return c.splittable;
    return SPLIT_DEFAULTS_JS[c.component_type] ?? false;
  }

  const cards = components.map(c => {
    // Fill placeholders with human-readable labels
    const filled = (c.html_template || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, k) => {
      // Use short examples for preview
      const labelMap = {
        TITLE: c.label || c.component_type,
        SUBTITLE: 'Exempeltext — undertitel',
        OVERLINE: 'KAPITEL 1',
        BODY: 'Detta är exempeltext för brödtextförhandsvisning. '.repeat(5).trim(),
        INTRO: 'Kort introduktion som visar intro-stilen.',
        DATE: new Date().getFullYear().toString(),
        CHAPTER_NUMBER: '01',
        FACT_VALUE_1: '15', FACT_LABEL_1: 'Kontor',
        FACT_VALUE_2: '4',  FACT_LABEL_2: 'Länder',
        FACT_VALUE_3: '342', FACT_LABEL_3: 'Anställda',
        FACT_VALUE_4: '98%', FACT_LABEL_4: 'Nöjdhet',
        KPI_VALUE_1: '15', KPI_LABEL_1: 'Kontor',
        KPI_VALUE_2: '4',  KPI_LABEL_2: 'Länder',
        KPI_VALUE_3: '342', KPI_LABEL_3: 'Anställda',
        KPI_VALUE_4: '98%', KPI_LABEL_4: 'Nöjdhet',
      };
      return labelMap[k] || `[${k}]`;
    });
    const split = isSplit(c);
    return `
      <div class="lib-card">
        <div class="lib-card-header">
          <div>
            <div class="lib-card-name">${escapeHtml(c.label || c.component_type)}</div>
            <div class="lib-card-meta">${c.component_type} • ${c.variant_name || 'Default'}${c.is_default ? ' • default' : ''}${c.page_format && c.page_format !== 'universal' ? ` • ${c.page_format}` : ''} • v${c.version}</div>
          </div>
          <div class="lib-card-badges">
            <span class="${split ? 'lib-split-yes' : 'lib-split-no'}">${split ? '✂ splittable' : '🔒 atomic'}</span>
          </div>
        </div>
        <div class="lib-card-preview">${filled}</div>
      </div>
    `;
  }).join('\n');

  const bodyHtml = `
    <div class="lib-page">
      <div class="lib-title">${escapeHtml(brand.name || 'Brand')} — komponentbibliotek (${components.length} komponenter)</div>
      ${cards}
    </div>
  `;

  // Render via smyra-render as a freeform page
  try {
    const pdfResult = await callRenderService("/render/pdf", {
      report_id: null,
      title: `${brand.name || 'Brand'} — component library`,
      mode: 'final',
      page_format: 'a4_portrait',
      pages: [{
        page_type: 'content',
        modules: [{
          module_type: 'freeform',
          html_content: bodyHtml,
          html_cache: bodyHtml,
        }],
      }],
      brand_tokens: tokens,
      brand_fonts: fonts,
      document_css: pageCss,
    }, brand.tenant_id);

    const { connectLambda, getStore } = await import("@netlify/blobs");
    let store;
    try { store = getStore("report-ai-pdfs"); } catch {
      const siteID = process.env.NETLIFY_SITE_ID;
      const token = process.env.NETLIFY_API_TOKEN;
      store = getStore({ name: "report-ai-pdfs", siteID, token });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blobKey = `tenants/${brand.tenant_id}/brand-library/${brand_id}/${timestamp}.pdf`;
    const pdfBuffer = pdfResult.pdf_bytes
      ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
    if (!pdfBuffer) throw new Error("Render service returned no PDF bytes");
    await store.set(blobKey, pdfBuffer, { contentType: "application/pdf" });

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const pdfUrl = `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(blobKey)}`;

    return textResult({
      ok: true,
      brand_id,
      brand_name: brand.name,
      components_rendered: components.length,
      pdf_url: pdfUrl,
      blob_key: blobKey,
      size_bytes: pdfBuffer.length,
    });
  } catch (err) {
    return errorResult(`render_brand_components failed: ${err.message}`);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Handler: measure_height ────────────────────────────────────────────────

async function handleMeasureHeight(userId, args) {
  const { html_fragment, page_width_mm, brand_tokens, brand_fonts, document_css } = args || {};
  if (typeof html_fragment !== "string" || !html_fragment.trim()) {
    return errorResult("html_fragment is required.");
  }
  // Tenant for the render JWT is derived from the caller's user; pick their
  // primary tenant. Falls back to 'default' if none resolved — /render/measure
  // only cares that the JWT parses, not that the tenant is meaningful.
  const sql = getSql();
  const tenantRow = await sql`SELECT tenant_id FROM v2_reports WHERE id IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
  const tenantId = tenantRow[0]?.tenant_id || "default";
  try {
    const res = await callRenderService("/render/measure", {
      html_fragment,
      page_width_mm: typeof page_width_mm === "number" ? page_width_mm : 170,
      brand_tokens: brand_tokens || {},
      brand_fonts: brand_fonts || [],
      document_css: typeof document_css === "string" ? document_css : undefined,
    }, tenantId);
    return textResult({ height_mm: res?.height_mm ?? null });
  } catch (err) {
    return errorResult(`measure_height failed: ${err.message}`);
  }
}

// ─── Handler: test_run_report ───────────────────────────────────────────────
//
// Dev-mode pipeline smoke test. Creates a mini-report from the brand's saved
// component library, composes it with document_css, and returns a markdown
// diagnostic of everything that looked wrong. Purpose: stop manually
// reproducing bugs — press a button, read the findings.

function fillTestTemplate(template, values) {
  if (!template) return '';
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, k) => {
    const v = values?.[k];
    return v != null ? String(v) : `{{${k}}}`;
  });
}

async function handleTestRunReport(userId, args) {
  const sql = getSql();
  const { brand_id, title: titleIn, verbose } = args || {};
  if (!brand_id) return errorResult("brand_id is required.");

  const title = titleIn || `Test run ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const warnings = [];
  const errors = [];
  const details = [];

  // ── 1. Brand + tokens + fonts
  const brands = await sql`SELECT id, tokens, tenant_id, name FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (!brands.length) return errorResult(`Brand ${brand_id} not found.`);
  const brand = brands[0];
  const tokens = brand.tokens || {};

  const fonts = await sql`SELECT family, weight FROM brand_fonts WHERE brand_id = ${brand_id}`;
  const loadedFamilies = new Set(fonts.map(f => String(f.family).toLowerCase()));
  const expectedFamilies = [tokens.font_display, tokens.font_heading, tokens.font_body]
    .filter(Boolean)
    .map(String);
  const missingFonts = [...new Set(expectedFamilies)]
    .filter(f => !loadedFamilies.has(f.toLowerCase()));
  if (missingFonts.length) {
    warnings.push(`Brand tokens reference **${missingFonts.join(', ')}** but no rows in \`brand_fonts\` match. Editor + PDF will fall back to system-ui for those.`);
  }

  // ── 2. Library picks
  const allComponents = await sql`
    SELECT id, component_type, variant_name, html_template, css_template, is_default, status, page_format
    FROM brand_components
    WHERE brand_id = ${brand_id} AND status = 'ready'
    ORDER BY is_default DESC, updated_at DESC
  `;
  const byType = new Map();
  for (const c of allComponents) {
    if (!byType.has(c.component_type)) byType.set(c.component_type, c);
  }

  const requiredTypes = ['cover', 'heading', 'body_text', 'kpi_group', 'back_cover'];
  const missing = requiredTypes.filter(t => !byType.has(t));
  if (missing.length) {
    warnings.push(`Brand library missing components: **${missing.join(', ')}**. Skeletons will be used for those.`);
  }

  const componentsWithoutCss = [...byType.values()].filter(c => !c.css_template?.trim());
  if (componentsWithoutCss.length) {
    warnings.push(`**${componentsWithoutCss.length}** library components have no \`css_template\` (saved before 019 migration). They'll render with their legacy inline styles only.`);
  }

  // ── 3. Canned plan — exercises all key paths
  const plan = [
    { type: 'cover',      content: { TITLE: title, SUBTITLE: 'Auto-generated pipeline test', DATE: new Date().getFullYear().toString() } },
    { type: 'heading',    content: { TITLE: 'Introduktion', OVERLINE: 'Kapitel 1' } },
    { type: 'body_text',  content: { INTRO: 'Detta är en auto-genererad testrapport som täcker pipelinen från plan till render.', BODY: 'Brödtext i två spalter. '.repeat(20).trim() } },
    { type: 'kpi_group',  content: { KPI_VALUE_1: '15', KPI_LABEL_1: 'Offices', KPI_VALUE_2: '4', KPI_LABEL_2: 'Countries', KPI_VALUE_3: '342', KPI_LABEL_3: 'Employees', KPI_VALUE_4: '98%', KPI_LABEL_4: 'Satisfaction' } },
    { type: 'back_cover', content: { TITLE: 'Slut.', SUBTITLE: 'Test run complete.' } },
  ];

  // ── 4. Create report
  let reportId;
  try {
    const rows = await sql`
      INSERT INTO v2_reports (tenant_id, brand_id, title, document_type, status, page_format)
      VALUES (${brand.tenant_id}, ${brand_id}, ${title}, 'test_run', 'draft', 'a4_portrait')
      RETURNING id
    `;
    reportId = rows[0].id;
  } catch (err) {
    errors.push(`Failed to create report: ${err.message}`);
    return textResult({ ok: false, errors, warnings, diagnostic_markdown: `❌ ${errors[0]}` });
  }

  // ── 5. Assemble document_css
  const cssLayers = [];
  cssLayers.push('/* ===== brand tokens (:root) ===== */');
  cssLayers.push(':root {');
  const colorMap = {
    primary_color: '--primary', primary_dark_color: '--primary-dark', accent_color: '--accent',
    secondary_color: '--secondary', text_color: '--text', text_muted_color: '--text-muted',
    bg_color: '--bg', bg_light_color: '--bg-light', surface_color: '--surface', border_color: '--border',
  };
  for (const [k, v] of Object.entries(tokens)) {
    if (k.startsWith('_') || v == null || v === '') continue;
    if (colorMap[k]) { cssLayers.push(`  ${colorMap[k]}: ${v};`); continue; }
    if (k === 'font_display') { cssLayers.push(`  --font-display: '${v}', system-ui, sans-serif;`); continue; }
    if (k === 'font_heading') { cssLayers.push(`  --font-heading: '${v}', system-ui, sans-serif;`); continue; }
    if (k === 'font_body')    { cssLayers.push(`  --font-body: '${v}', system-ui, sans-serif;`); continue; }
    cssLayers.push(`  --${k.replace(/_/g, '-')}: ${v};`);
  }
  cssLayers.push('}');
  cssLayers.push('');
  cssLayers.push('/* ===== component CSS ===== */');
  for (const c of byType.values()) {
    if (!c.css_template?.trim()) continue;
    cssLayers.push(`/* ${c.component_type} — ${c.variant_name || 'Default'} */`);
    cssLayers.push(c.css_template.trim());
    cssLayers.push('');
  }
  const documentCss = cssLayers.join('\n');
  await sql`UPDATE v2_reports SET document_css = ${documentCss}, updated_at = NOW() WHERE id = ${reportId}`;

  // ── 6. Insert modules + pages
  let unfilledCount = 0;
  let emptyTextNodes = 0;
  for (let i = 0; i < plan.length; i++) {
    const { type, content } = plan[i];
    const comp = byType.get(type);
    let htmlCache;
    if (comp?.html_template) {
      htmlCache = fillTestTemplate(comp.html_template, content);
      const unfilled = htmlCache.match(/\{\{\s*[A-Z_][A-Z0-9_]*\s*\}\}/g);
      if (unfilled?.length) {
        unfilledCount += unfilled.length;
        warnings.push(`Module ${i + 1} (${type}): **${unfilled.length} unfilled placeholders**: ${unfilled.slice(0, 3).join(', ')}${unfilled.length > 3 ? '…' : ''}. Plan content doesn't cover the template's tokens.`);
      }
      const emptyMatches = htmlCache.match(/<(div|span|p)[^>]*>\s*<\/\1>/g);
      if (emptyMatches?.length) {
        emptyTextNodes += emptyMatches.length;
      }
    } else {
      htmlCache = `<div class="t-skeleton" style="padding:10mm;background:#fef3c7;border:1px dashed #d97706;color:#92400e;">[skeleton: no library component for <strong>${type}</strong>]</div>`;
    }

    const pageType = (type === 'cover' || type === 'back_cover' || type === 'chapter_break') ? type : 'content';
    try {
      const pageRows = await sql`
        INSERT INTO v2_report_pages (report_id, page_number, page_type)
        VALUES (${reportId}, ${i + 1}, ${pageType})
        RETURNING id
      `;
      const pageId = pageRows[0].id;
      await sql`
        INSERT INTO v2_report_modules (report_id, page_id, module_type, order_index, content, html_content, html_cache, content_mapping)
        VALUES (${reportId}, ${pageId}, ${'freeform'}, ${i},
                ${JSON.stringify(content)}::jsonb, ${htmlCache}, ${htmlCache}, ${JSON.stringify(content)}::jsonb)
      `;
      details.push(`- ✅ Page ${i + 1} \`${type}\` (${htmlCache.length} bytes html_cache)`);
    } catch (err) {
      errors.push(`Module ${i + 1} (${type}) insert failed: ${err.message}`);
    }
  }

  if (emptyTextNodes > 0) {
    warnings.push(`Found **${emptyTextNodes}** empty text nodes across modules after placeholder fill. Likely cause: html_template has \`<div></div>\` shells waiting for content that doesn't exist in the plan.`);
  }

  // ── 7. Build diagnostic
  const lines = [];
  lines.push(`# Test run: ${title}`);
  lines.push('');
  lines.push(`- **Report id:** \`${reportId}\``);
  lines.push(`- **Brand:** ${brand.name || brand_id}`);
  lines.push(`- **Library:** ${byType.size} component types saved, ${[...byType.values()].filter(c => c.css_template).length} with css_template`);
  lines.push(`- **document_css:** ${documentCss.length} bytes`);
  lines.push(`- **Fonts uploaded:** ${fonts.length}${missingFonts.length ? ` (missing ${missingFonts.length})` : ''}`);
  lines.push(`- **Modules written:** ${plan.length - errors.length}/${plan.length}`);
  lines.push(`- **Unfilled placeholders:** ${unfilledCount}`);
  lines.push(`- **Empty text nodes after fill:** ${emptyTextNodes}`);
  lines.push('');

  if (errors.length) {
    lines.push('## ❌ Errors');
    for (const e of errors) lines.push(`- ${e}`);
    lines.push('');
  }
  if (warnings.length) {
    lines.push('## ⚠️ Warnings');
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  if (!errors.length && !warnings.length) {
    lines.push('## ✅ No issues found');
    lines.push('Pipeline wrote everything cleanly. Next: open the editor to eyeball the visual result.');
    lines.push('');
  }

  lines.push('## 🔍 How to inspect');
  lines.push(`- **Editor preview:** open the SPA at \`/v2/reports/${reportId}\` and verify each page renders with brand fonts + component styles.`);
  lines.push(`- **Render PDF:** \`POST /api/v2-render\` with \`{ "report_id": "${reportId}", "mode": "draft" }\` — compare against editor preview (they MUST match).`);
  lines.push(`- **Component library:** \`/v2/components\` (filter by this brand) to inspect saved components and their css_template.`);
  lines.push(`- **Delete test report when done:** \`DELETE /api/v2-reports/${reportId}\`.`);
  lines.push('');

  if (verbose && details.length) {
    lines.push('## 📋 Per-module trace');
    for (const d of details) lines.push(d);
    lines.push('');
  }

  return textResult({
    ok: errors.length === 0,
    report_id: reportId,
    warnings_count: warnings.length,
    errors_count: errors.length,
    unfilled_placeholders: unfilledCount,
    empty_text_nodes: emptyTextNodes,
    document_css_bytes: documentCss.length,
    components_used: byType.size,
    missing_components: missing,
    missing_fonts: missingFonts,
    diagnostic_markdown: lines.join('\n'),
  });
}

// ─── Handler: save_document_css ─────────────────────────────────────────────

async function handleSaveDocumentCss(userId, args) {
  const sql = getSql();
  const { report_id, document_css } = args || {};
  if (!report_id) return errorResult("report_id is required.");
  if (typeof document_css !== "string") return errorResult("document_css must be a string.");

  const rows = await sql`
    UPDATE v2_reports
    SET document_css = ${document_css}, updated_at = NOW()
    WHERE id = ${report_id}
    RETURNING id
  `;
  if (!rows.length) return errorResult(`Report ${report_id} not found.`);
  return textResult({ ok: true, report_id, bytes: document_css.length });
}

// ─── Handler: list_reports ──────────────────────────────────────────────────

async function handleListReports(userId, args) {
  const sql = getSql();
  const { tenant_id, brand_id, limit } = args || {};
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const tenantFilter = tenant_id || null;
  const brandFilter = brand_id || null;

  const rows = await sql`
    SELECT r.id, r.title, r.brand_id, r.tenant_id, r.template_id, r.page_format,
           r.created_at, r.updated_at,
           (SELECT COUNT(*)::int FROM v2_report_modules m WHERE m.report_id = r.id) AS module_count,
           (SELECT COUNT(*)::int FROM v2_report_pages p WHERE p.report_id = r.id) AS page_count
    FROM v2_reports r
    WHERE (${tenantFilter}::uuid IS NULL OR r.tenant_id = ${tenantFilter}::uuid)
      AND (${brandFilter}::uuid IS NULL OR r.brand_id = ${brandFilter}::uuid)
    ORDER BY r.updated_at DESC
    LIMIT ${cap}
  `;
  return textResult({ reports: rows, count: rows.length });
}

// ─── Handler: delete_component ──────────────────────────────────────────────

async function handleDeleteComponent(userId, args) {
  const sql = getSql();
  const { component_id, brand_id } = args;
  if (!component_id || !brand_id) {
    return errorResult("component_id and brand_id are required.");
  }
  const rows = await sql`
    DELETE FROM brand_components
    WHERE id = ${component_id} AND brand_id = ${brand_id}
    RETURNING id, component_type, variant_name, label
  `;
  if (!rows.length) {
    return errorResult(`Component ${component_id} not found for brand ${brand_id}.`);
  }
  return textResult({ deleted: true, component_id: rows[0].id, component_type: rows[0].component_type, variant_name: rows[0].variant_name, label: rows[0].label });
}

async function handleForkComponent(userId, args) {
  const sql = getSql();
  const { source_component_id, target_brand_id, label, is_default } = args;
  if (!source_component_id || !target_brand_id) {
    return errorResult("source_component_id and target_brand_id are required.");
  }

  const srcRows = await sql`
    SELECT brand_id, component_type, label, html_template, css_template, placeholder_schema,
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
      brand_id, component_type, label, html_template, css_template, placeholder_schema,
      design_notes, source, is_default,
      extraction_id, is_public, unsplash_query, reference_page_numbers
    )
    VALUES (
      ${target_brand_id}, ${src.component_type}, ${label || src.label},
      ${src.html_template}, ${src.css_template ?? null},
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
    SELECT id, brand_id, component_type, variant_name, label, html_template, css_template, splittable, placeholder_schema,
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

  let htmlTemplate, brandId, cssTemplate;

  if (component_id) {
    const rows = await sql`
      SELECT html_template, css_template, brand_id FROM brand_components WHERE id = ${component_id} LIMIT 1
    `;
    if (!rows.length) return errorResult(`Component ${component_id} not found.`);
    htmlTemplate = rows[0].html_template;
    cssTemplate = rows[0].css_template;
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

  // Wrap with component CSS so preview matches real render (compose-pages applies css_template per module)
  const htmlWithStyle = cssTemplate
    ? `<style>${cssTemplate}</style>\n${filled}`
    : filled;

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
        html_content: htmlWithStyle,
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

// ─── Handler: rasterize_upload ──────────────────────────────────────────────
// Standalone PDF-to-PNG rasterization that does NOT require a pre-existing
// report_id (unlike rasterize_pdf which reads from v2_reports). Used by
// the design.extract_blueprint workflow to turn a reference PDF into per-
// page images that get fed back to Claude as MCP image content blocks.

async function handleRasterizeUpload(userId, args, event) {
  const { upload_token, pdf_base64, dpi, max_pages } = args || {};
  if (!upload_token && !pdf_base64) {
    return errorResult("Provide upload_token (from request_upload) or pdf_base64.");
  }

  // Resolve the PDF bytes
  let pdfBytesBase64;
  if (upload_token) {
    const verifyUploadToken = _verifyUploadTokenInline;
    if (!verifyUploadToken(upload_token)) {
      return errorResult("Upload token is invalid or expired.");
    }
    // Eventual consistency: by the time the user has clicked through the
    // rasterize/extract step in Claude.ai, the upload has long since
    // finalised on the upload-ref function. Strong consistency requires
    // an `uncachedEdgeURL` property that isn't available via the
    // siteID+token fallback path, so we'd lose the fallback entirely.
    const store = await getBlobStore("upload-refs", event);
    const fileData = await store.get(`${upload_token}/file`, { type: "arrayBuffer" });
    if (!fileData) {
      return errorResult("No file found for this upload token. Ask the user to upload the file first.");
    }
    pdfBytesBase64 = Buffer.from(fileData).toString("base64");
  } else {
    pdfBytesBase64 = pdf_base64;
  }

  const effectiveDpi = typeof dpi === "number" && dpi > 0 ? dpi : 96;
  const pageCap = typeof max_pages === "number" && max_pages > 0 ? max_pages : 20;

  let raster;
  try {
    raster = await callRenderService("/render/rasterize", {
      pdf_base64: pdfBytesBase64,
      dpi: effectiveDpi,
    }, userId || "system");
  } catch (err) {
    return errorResult(`Rasterization failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const rasterPages = Array.isArray(raster?.pages) ? raster.pages : [];
  if (rasterPages.length === 0) {
    return errorResult("Render service returned no pages. PDF may be malformed.");
  }

  // Cap to max_pages — for long reference PDFs we sample the first N pages
  // (which usually carry the strongest visual signal: cover, hero spreads,
  // KPI sections). Beyond ~20 pages the cost/benefit of more vision tokens
  // drops off quickly.
  const kept = rasterPages.slice(0, pageCap);
  const truncated = rasterPages.length > pageCap;

  // Cache PNGs in blob store so subsequent revise rounds don't re-rasterize.
  const assetStore = await getBlobStore("report-ai-assets", event);
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  const { createHash, randomUUID } = await import("node:crypto");
  const sessionId = randomUUID();

  const pages = [];
  for (const rp of kept) {
    if (typeof rp?.page !== "number" || typeof rp?.png_base64 !== "string") continue;
    const pngBuffer = Buffer.from(rp.png_base64, "base64");
    const hash = createHash("sha256").update(pngBuffer).digest("hex").slice(0, 12);
    const blobKey = `reference-rasters/${sessionId}/${hash}-p${rp.page}.png`;
    await assetStore.set(blobKey, pngBuffer, { contentType: "image/png" });
    pages.push({
      page_num: rp.page,
      png_base64: rp.png_base64,
      url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`,
      width: rp.width,
      height: rp.height,
      height_mm: rp.height_mm,
    });
  }

  return textResult({
    pages,
    page_count: pages.length,
    total_pages_in_pdf: rasterPages.length,
    truncated,
    dpi: effectiveDpi,
  });
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
// Inlined token generation (was dynamic import from ./upload-ref.js, but
// that module is also a Netlify Function entrypoint — esbuild's bundling
// of named exports from a function file is unreliable, and the dynamic
// import would silently fail in the deployed lambda. Inlining keeps it
// in a single, self-contained module).

function _createUploadTokenInline() {
  const id = randomBytes(16).toString("hex");
  const expires = Date.now() + 30 * 60 * 1000; // 30 min
  const secret = process.env.SESSION_SECRET || process.env.HMAC_SECRET || "dev";
  const sig = createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex").slice(0, 16);
  return { token: `${id}_${expires}_${sig}`, id, expires };
}

function _verifyUploadTokenInline(token) {
  if (typeof token !== "string") return false;
  const parts = token.split("_");
  if (parts.length !== 3) return false;
  const [id, expiresStr, sig] = parts;
  const expires = parseInt(expiresStr);
  if (isNaN(expires) || Date.now() > expires) return false;
  const secret = process.env.SESSION_SECRET || process.env.HMAC_SECRET || "dev";
  const expected = createHmac("sha256", secret).update(`${id}:${expires}`).digest("hex").slice(0, 16);
  return sig === expected;
}

async function handleRequestUpload(userId, args) {
  try {
    const { token } = _createUploadTokenInline();
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const uploadUrl = `${siteUrl}/upload-ref?token=${token}`;

    return textResult({
      upload_token: token,
      upload_url: uploadUrl,
      expires_in_minutes: 30,
      instruction: "Ge användaren denna länk. Filen analyseras direkt av servern — inga bilder skickas genom konversationen. När användaren bekräftar att uppladdningen är klar, använd upload_token med rasterize_upload, extract_design_from_pdf eller check_upload.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[request_upload] failed:", msg, err?.stack);
    return errorResult(`Failed to generate upload token: ${msg}`);
  }
}

// ─── Handler: check_upload ─────────────────────────────────────────────────

async function handleCheckUpload(userId, args) {
  const { upload_token } = args;
  if (!upload_token) return errorResult("upload_token is required.");

  const verifyUploadToken = _verifyUploadTokenInline;
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
    const verifyUploadToken = _verifyUploadTokenInline;
    if (!verifyUploadToken(upload_token)) {
      return errorResult("Upload token is invalid or expired.");
    }
    // Eventual consistency: by the time the user has clicked through the
    // rasterize/extract step in Claude.ai, the upload has long since
    // finalised on the upload-ref function. Strong consistency requires
    // an `uncachedEdgeURL` property that isn't available via the
    // siteID+token fallback path, so we'd lose the fallback entirely.
    const store = await getBlobStore("upload-refs", event);
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

// Strip a single outer <section class="...page..."> wrapper from freeform
// HTML if present. Claude's design_language and page_design prompts ask
// for `<section class="page">…</section>` blocks, but render.py's freeform
// path adds its own <div class="page page--freeform"> wrapper around the
// fragment. Without unwrapping, both wrappers receive the design-system
// CSS's .page page-break + full-height rules → one logical page renders
// as two physical pages.
function unwrapSectionPage(html) {
  if (typeof html !== "string") return html;
  const trimmed = html.trim();
  // Allow attributes in any order; require class to contain "page".
  const m = trimmed.match(/^<section\b([^>]*)>([\s\S]*)<\/section>\s*$/i);
  if (!m) return html;
  const attrs = m[1] || "";
  const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  if (!classMatch || !/\bpage\b/.test(classMatch[1])) return html;
  return m[2];
}

// ─── Handler: render_freeform_thumbnails ────────────────────────────────────
// alpha-v3 preview rendering — returns content-addressed PNG thumbnail URLs
// for a set of freeform HTML pages without writing a full report PDF.

async function handleRenderFreeformThumbnails(userId, args, event) {
  const sql = getSql();
  const { pages, design_system_css, brand_id, page_format = "a4_portrait", return_base64 = false, thumbnail_dpi } = args || {};
  // When base64 is requested, default back to 72 DPI — base64 now ships
  // only as the MCP image content block (vision input to Claude), NOT in
  // the message text as a data URI, so no token inflation concern. 72 DPI
  // gives Claude enough detail to read typography. A typical 3-page pause
  // ≈ 1 MB image content which is fine for multimodal.
  const effectiveDpi = return_base64 ? (typeof thumbnail_dpi === "number" && thumbnail_dpi > 0 ? thumbnail_dpi : 72) : null;

  // ── 1. Validate input ──────────────────────────────────────────────────────
  if (!Array.isArray(pages) || pages.length === 0) {
    return errorResult("pages[] required and non-empty");
  }
  if (!design_system_css || typeof design_system_css !== "string") {
    return errorResult("design_system_css required");
  }
  if (!brand_id || !/^[0-9a-f-]{8,}$/i.test(brand_id)) {
    return errorResult("brand_id required (UUID)");
  }
  for (const p of pages) {
    if (typeof p?.page_num !== "number" || typeof p?.html !== "string" || p.html.length < 10) {
      return errorResult("each page must have numeric page_num + non-empty html");
    }
  }

  // ── 2. Resolve tenant_id from brand ────────────────────────────────────────
  const brandRows = await sql`SELECT tenant_id FROM brands WHERE id = ${brand_id} LIMIT 1`;
  const tenantId = brandRows[0]?.tenant_id;
  if (!tenantId) return errorResult(`brand ${brand_id} not found`);

  // ── 3. Fetch brand context (tokens, fonts, logos) ──────────────────────────
  const brand = await fetchBrandContext(sql, brand_id);

  // ── 4. Content-address: hash CSS once, hash each page's HTML individually ──
  const { createHash } = await import("node:crypto");
  const cssHash = createHash("sha256").update(design_system_css).digest("hex").slice(0, 8);

  const assetStore = await getBlobStore("report-ai-assets", event);
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";

  // ── 5. Plan cache keys ─────────────────────────────────────────────────────
  // Cache version — bump when render-pipeline behaviour changes in a way
  // that makes old cached blobs incorrect.
  //   v2 = module_type="freeform" (was "freeform_page"): render.py takes the
  //        freeform path instead of legacy path that nested .page wrappers.
  //   v3 = unified render: one multi-page PDF + one rasterize call for the
  //        whole batch (was N separate single-page PDFs). Rasterize output
  //        for a page at index i may differ bit-for-bit vs. the old single-
  //        page path (same content, different page-count metadata in the
  //        PDF) — bump the suffix so v2 blobs don't leak through.
  //   v4 = unwrap outer <section class="page"> before render — the old
  //        path double-wrapped the fragment so each sample rendered as
  //        two physical pages instead of one. Bump invalidates v3 blobs.
  const CACHE_VERSION = "v4";
  const dpiSuffix = effectiveDpi ? `-d${effectiveDpi}` : "";

  const pagePlans = pages.map((page) => {
    const pageHash = createHash("sha256").update(page.html).digest("hex").slice(0, 8);
    return {
      page_num: page.page_num,
      html: page.html,
      blobKey: `thumbnails/${brand_id}/${cssHash}-${pageHash}-p${page.page_num}${dpiSuffix}-${CACHE_VERSION}.png`,
    };
  });

  const allPagesHash = createHash("sha256")
    .update(pages.map((p) => `${p.page_num}:${p.html}`).join("\n"))
    .digest("hex").slice(0, 16);
  const pdfBlobKey = `preview-pdfs/${brand_id}/${cssHash}-${allPagesHash}-${page_format}.pdf`;
  const pdfStore = await getBlobStore("report-ai-pdfs", event);

  // ── 6. Per-page cache probe ────────────────────────────────────────────────
  // Concurrent probe of every thumbnail key. Fully cached pages skip the
  // render entirely; if ALL pages are cached AND the preview PDF exists,
  // no render service call at all.
  const cachedResults = new Array(pagePlans.length).fill(null);
  const cacheProbes = await Promise.allSettled(pagePlans.map(async (plan, i) => {
    const meta = await assetStore.getMetadata(plan.blobKey).catch(() => null);
    if (!meta) return;
    const result = {
      page_num: plan.page_num,
      thumbnail_url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(plan.blobKey)}`,
      cached: true,
    };
    if (return_base64) {
      const bytes = await assetStore.get(plan.blobKey, { type: "arrayBuffer" }).catch(() => null);
      if (bytes) result.png_base64 = Buffer.from(bytes).toString("base64");
    }
    cachedResults[i] = result;
  }));
  // Silent if probe throws; treat as cache miss.
  void cacheProbes;

  const missingIndices = pagePlans
    .map((_, i) => (cachedResults[i] == null ? i : -1))
    .filter((i) => i >= 0);

  const pdfMeta = await pdfStore.getMetadata(pdfBlobKey).catch(() => null);
  const pdfCached = !!pdfMeta;

  // ── 7. Render path — 2 calls total, regardless of page count ──────────────
  // Only fires when at least one thumbnail is missing OR the preview PDF
  // is missing. Full cache hit = zero render calls.
  const errors = [];
  let pdfBuffer = null;

  if (missingIndices.length > 0 || !pdfCached) {
    const allSyntheticPages = pages.map((p) => {
      // Strip the outer <section class="page"> wrapper if present.
      // render.py's freeform path wraps each module's html_cache in
      // <div class="page page--freeform"> — if the user's HTML already
      // contains its own <section class="page"> outer, the design-system
      // CSS targets BOTH (page-break-after, full-page sizing), producing
      // 2 pages per sample. Unwrapping the inner duplicate keeps the
      // outer div as the sole page-producing element.
      const unwrapped = unwrapSectionPage(p.html);
      return {
        id: randomUUID(),
        page_number: p.page_num,
        page_type: p.page_num === 1 ? "cover" : "content",
        modules: [{
          module_type: "freeform",
          order_index: 0,
          html_content: unwrapped,
          html_cache: unwrapped,
          content: {},
          style: {},
          background: null,
        }],
      };
    });

    try {
      const pdfResult = await callRenderService("/render/pdf", {
        report_id: randomUUID(),
        title: "Preview",
        mode: "draft",
        page_format,
        pages: allSyntheticPages,
        brand_tokens: brand.tokens ?? {},
        brand_fonts: brand.fonts ?? [],
        brand_logos: brand.logos ?? [],
        css_base: "",
        document_css: design_system_css,
        document_css_overrides: "",
        style_overrides: {},
      }, tenantId);
      pdfBuffer = pdfResult.pdf_bytes
        ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
      if (!pdfBuffer) throw new Error("render returned no PDF bytes");
      if (!pdfCached) {
        await pdfStore.set(pdfBlobKey, pdfBuffer, { contentType: "application/pdf" });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[render_freeform_thumbnails] PDF render failed:", reason);
      // No PDF means no rasterize source → mark all missing pages as errored
      // so the caller sees them in errors[] and can fall back to cached URLs.
      for (const i of missingIndices) {
        errors.push({ page_num: pagePlans[i].page_num, error: `PDF render failed: ${reason}` });
      }
    }

    // Rasterize the full multi-page PDF in one call, then split per page.
    if (pdfBuffer && missingIndices.length > 0) {
      try {
        const raster = await callRenderService("/render/rasterize", {
          pdf_base64: pdfBuffer.toString("base64"),
          ...(effectiveDpi ? { dpi: effectiveDpi } : {}),
        }, tenantId);
        const rasterPages = Array.isArray(raster.pages) ? raster.pages : [];
        // rasterize returns 1-indexed `page` numbers. Map back to our plans.
        const byPageNum = new Map();
        for (const rp of rasterPages) {
          if (typeof rp?.page === "number") byPageNum.set(rp.page, rp);
        }
        for (const i of missingIndices) {
          const plan = pagePlans[i];
          const rp = byPageNum.get(plan.page_num);
          if (!rp?.png_base64) {
            errors.push({ page_num: plan.page_num, error: "rasterize returned no PNG for this page" });
            console.error(`[render_freeform_thumbnails] page ${plan.page_num}: no PNG from rasterize`);
            continue;
          }
          try {
            const pngBuffer = Buffer.from(rp.png_base64, "base64");
            await assetStore.set(plan.blobKey, pngBuffer, { contentType: "image/png" });
            const result = {
              page_num: plan.page_num,
              thumbnail_url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(plan.blobKey)}`,
              cached: false,
            };
            if (rp.height_mm != null) result.height_mm = rp.height_mm;
            if (return_base64) result.png_base64 = rp.png_base64;
            cachedResults[i] = result;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            errors.push({ page_num: plan.page_num, error: `blob store failed: ${reason}` });
            console.error(`[render_freeform_thumbnails] page ${plan.page_num} blob write failed: ${reason}`);
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error("[render_freeform_thumbnails] rasterize failed:", reason);
        for (const i of missingIndices) {
          if (cachedResults[i] == null) {
            errors.push({ page_num: pagePlans[i].page_num, error: `rasterize failed: ${reason}` });
          }
        }
      }
    }
  }

  // Compose final thumbnails array (preserve request order, drop nulls).
  const thumbnails = cachedResults.filter(Boolean);

  const summary = { thumbnails, count: thumbnails.length, requested: pages.length };
  summary.preview_url = `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(pdfBlobKey)}`;
  if (errors.length > 0) {
    summary.errors = errors;
    summary.partial = true;
  }
  return textResult(summary);
}

// ─── HANDLERS map ───────────────────────────────────────────────────────────

// ─── Handler: persist_freeform_pages ───────────────────────────────────────
// Called by smyra-core at module_review approve_all (before enqueueRender)
// to materialise the final freeform pages into v2_report_pages +
// v2_report_modules. Without this step the editor at /v2/reports/<id>
// opens to an empty report and the legacy render_pdf tool fails with
// "pages is required" because its query returns no rows. Also stores
// the final CSS onto v2_reports so the editor cascades correctly.
//
// Idempotent: existing rows for the same (report_id, page_number) are
// deleted first, then re-inserted. Safe for retries or patch-loops.

async function handlePersistFreeformPages(userId, args) {
  const sql = getSql();
  const { report_id, pages, design_system_css, augmented_design_css_additions } = args || {};

  if (!report_id || !/^[0-9a-f-]{36}$/i.test(report_id)) {
    return errorResult("report_id is required (UUID).");
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return errorResult("pages[] required and non-empty.");
  }
  if (typeof design_system_css !== "string" || !design_system_css.trim()) {
    return errorResult("design_system_css is required.");
  }

  // Validate report exists (prevents orphan writes against a stale UUID).
  const reportRows = await sql`
    SELECT id, tenant_id FROM v2_reports WHERE id = ${report_id} LIMIT 1
  `;
  if (!reportRows.length) return errorResult(`Report ${report_id} not found.`);

  // Validate each page.
  for (const p of pages) {
    if (typeof p?.page_num !== "number" || p.page_num < 1) {
      return errorResult(`Invalid page_num: ${p?.page_num}`);
    }
    if (typeof p?.html !== "string" || p.html.length < 10) {
      return errorResult(`Page ${p.page_num} missing non-empty html.`);
    }
  }

  // Reset prior pages for this report so we don't leave stale page_numbers
  // from earlier runs. ON DELETE CASCADE on v2_report_modules wipes the
  // module rows automatically.
  await sql`DELETE FROM v2_report_pages WHERE report_id = ${report_id}`;

  // Insert new page rows + module rows in-order. One module per page is
  // enough for the freeform case — render_pdf reads html_cache off the
  // module and treats each as a standalone page.
  let inserted = 0;
  for (const p of pages) {
    const pageType = typeof p.page_type === "string" && p.page_type.length > 0
      ? p.page_type
      : (p.page_num === 1 ? "cover" : "content");
    const pageRows = await sql`
      INSERT INTO v2_report_pages (report_id, page_number, page_type)
      VALUES (${report_id}, ${p.page_num}, ${pageType})
      RETURNING id
    `;
    const pageId = pageRows[0].id;
    // Same unwrap as render_freeform_thumbnails: render.py wraps each
    // freeform module in <div class="page page--freeform"> — keeping
    // Claude's outer <section class="page"> would double-wrap and
    // double-page every saved page in the editor and final PDF.
    const html = unwrapSectionPage(p.html);
    await sql`
      INSERT INTO v2_report_modules (
        report_id, page_id, module_type, order_index,
        content, style, html_cache, html_content
      ) VALUES (
        ${report_id}, ${pageId}, 'freeform', 0,
        '{}'::jsonb, '{}'::jsonb, ${html}, ${html}
      )
    `;
    inserted++;
  }

  // Persist the final CSS so editor + render_pdf have the full cascade.
  await sql`
    UPDATE v2_reports
    SET document_css = ${design_system_css},
        document_css_overrides = ${augmented_design_css_additions || ""},
        updated_at = NOW()
    WHERE id = ${report_id}
  `;

  return textResult({
    report_id,
    pages_written: inserted,
    editor_url: `${process.env.URL || process.env.DEPLOY_PRIME_URL || ""}/v2/reports/${report_id}`,
  });
}

// ─── Handler: render_freeform_pdf ───────────────────────────────────────────
// alpha-v3 render path — caller provides pages as freeform HTML + CSS inline.
// Does NOT read v2_report_pages from DB; skips template/document_css logic.

async function handleRenderFreeformPdf(userId, args, event) {
  const { payload, report_id, mode } = args;

  // ── 1. Validate input ──────────────────────────────────────────────────────
  if (!payload || !report_id || !mode) {
    return errorResult("payload, report_id, and mode are required.");
  }
  if (!Array.isArray(payload.pages) || payload.pages.length === 0) {
    return errorResult("payload.pages must be a non-empty array.");
  }
  for (const p of payload.pages) {
    if (typeof p.page_num !== "number") {
      return errorResult("Each page must have a numeric page_num.");
    }
    if (typeof p.html !== "string" || !p.html.trim()) {
      return errorResult(`Page ${p.page_num} is missing a non-empty html string.`);
    }
  }
  if (typeof payload.design_system_css !== "string" || !payload.design_system_css.trim()) {
    return errorResult("payload.design_system_css must be a non-empty string.");
  }
  if (typeof payload.brand_id !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.brand_id)) {
    return errorResult("payload.brand_id must be a UUID string.");
  }

  const sql = getSql();

  // ── 2. Resolve tenant_id from brand ────────────────────────────────────────
  const brandRow = await sql`SELECT tenant_id FROM brands WHERE id = ${payload.brand_id} LIMIT 1`;
  const tenantId = brandRow[0]?.tenant_id;
  if (!tenantId) return errorResult(`Brand ${payload.brand_id} not found or has no tenant_id.`);

  // ── 3. Fetch brand context (tokens, fonts, logos) ──────────────────────────
  const brand = await fetchBrandContext(sql, payload.brand_id);

  // ── 4. Synthesise smyra-render pages ──────────────────────────────────────
  // module_type="freeform" routes through render.py's freeform path
  // (one <div class="page page--freeform"> per module, no nested
  // wrappers). The legacy "freeform_page" string falls into the
  // module-template path which double-wraps. unwrapSectionPage strips
  // any leading <section class="page"> Claude included so we don't
  // double-wrap from the OTHER direction.
  const syntheticPages = payload.pages.map(p => {
    const html = unwrapSectionPage(p.html);
    return {
      id: randomUUID(),
      page_number: p.page_num,
      page_type: p.page_num === 1 ? "cover" : "content",
      modules: [
        {
          module_type: "freeform",
          order_index: p.page_num,
          html_content: html,
          html_cache: html,
          content: {},
          style: {},
          background: null,
        },
      ],
    };
  });

  // ── 5. Compose document_css ─────────────────────────────────────────────────
  const fullCss = payload.design_system_css + (payload.augmented_design_css_additions ?? "");

  // ── 6. Call render service ──────────────────────────────────────────────────
  const pdfResult = await callRenderService("/render/pdf", {
    report_id,
    title: payload.title ?? "Untitled report",
    mode,
    page_format: payload.page_format ?? "a4_portrait",
    pages: syntheticPages,
    brand_tokens: brand.tokens ?? {},
    brand_fonts: brand.fonts ?? [],
    brand_logos: brand.logos ?? [],
    css_base: "",
    document_css: fullCss,
    document_css_overrides: "",
    style_overrides: {},
  }, tenantId);

  // ── 7. Store PDF in Netlify Blobs ───────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blobKey = `tenants/${tenantId}/reports/${report_id}/${mode}-${timestamp}.pdf`;
  const store = await getBlobStore("report-ai-pdfs", event);
  const pdfBuffer = pdfResult.pdf_bytes
    ?? (pdfResult.pdf_base64 ? Buffer.from(pdfResult.pdf_base64, "base64") : null);
  if (!pdfBuffer) throw new Error("Render service returned no PDF bytes");
  await store.set(blobKey, pdfBuffer, { contentType: "application/pdf" });

  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";

  // ── 8. Rasterize thumbnails for draft mode ──────────────────────────────────
  let thumbnails = [];
  if (mode === "draft") {
    try {
      const raster = await callRenderService("/render/rasterize", {
        pdf_base64: pdfBuffer.toString("base64"),
      }, tenantId);
      const assetStore = await getBlobStore("report-ai-assets", event);
      for (const page of raster.pages || []) {
        const thumbKey = `tenants/${tenantId}/reports/${report_id}/thumbs/${timestamp}-page-${page.page}.png`;
        const pngBuffer = Buffer.from(page.png_base64, "base64");
        await assetStore.set(thumbKey, pngBuffer, { contentType: "image/png" });
        thumbnails.push({
          page: page.page,
          url: `${siteUrl}/api/v2-asset?key=${encodeURIComponent(thumbKey)}`,
        });
      }
    } catch (err) {
      console.warn("[render_freeform_pdf] rasterize failed (non-fatal):", err.message);
    }
  }

  // ── 9. Return result ────────────────────────────────────────────────────────
  return textResult({
    pdf_url: `${siteUrl}/api/v2-pdf?key=${encodeURIComponent(blobKey)}`,
    thumbnails,
    mode,
    pages_count: payload.pages.length,
    freeform: true,
  });
}

const HANDLERS = {
  create:                handleCreate,
  add_module:            handleAddModule,
  update_module:         handleUpdateModule,
  move_module:           handleMoveModule,
  delete_module:         handleDeleteModule,
  get_structure:         handleGetStructure,
  build_pages:           handleBuildPages,
  render_pdf:            handleRenderPdf,
  render_freeform_pdf:         handleRenderFreeformPdf,
  render_freeform_thumbnails:  handleRenderFreeformThumbnails,
  persist_freeform_pages:      handlePersistFreeformPages,
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
  get_blueprint:         handleGetBlueprint,
  list_smyra_templates:  handleListSmyraTemplates,
  preview_blueprint:     handlePreviewBlueprint,
  create_from_blueprint: handleCreateFromBlueprint,
  save_component:        handleSaveComponent,
  list_components:       handleListComponents,
  delete_component:      handleDeleteComponent,
  list_reports:          handleListReports,
  save_document_css:     handleSaveDocumentCss,
  measure_height:        handleMeasureHeight,
  test_pipeline_smoke:   handleTestRunReport,
  render_brand_components: handleRenderBrandComponents,
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
  rasterize_upload:      handleRasterizeUpload,
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

  // Auth: Hub JWT (RS256). Hub mints with aud=<module_slug>, so v2 users come
  // through with aud='report-ai-v2'. Accept the legacy 'report-ai' audience
  // too so any still-provisioned v1 tokens don't break during migration.
  const publicPem = process.env.HUB_JWT_PUBLIC_KEY_PEM;
  const issuer = process.env.HUB_JWT_ISSUER ?? "hub.rotor-platform.com";
  const acceptedAudiences = process.env.MODULE_AUDIENCE
    ? [process.env.MODULE_AUDIENCE]
    : ["report-ai-v2", "report-ai"];
  if (!publicPem) return jsonResponse(500, { error: "HUB_JWT_PUBLIC_KEY_PEM not configured" });

  let auth;
  for (const audience of acceptedAudiences) {
    auth = verifyHubJwt(token, { publicPem, issuer, audience });
    if (auth.ok) break;
  }
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
