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

const VALID_MODULE_TYPES = ["cover", "chapter_break", "back_cover", "layout"];

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
    description: "Add a module to a report. For layout modules, provide columns preset and slot categories.",
    inputSchema: {
      type: "object",
      properties: {
        report_id: { type: "string" },
        module_type: { type: "string", enum: VALID_MODULE_TYPES },
        content: { type: "object", description: "Module content payload" },
        style: { type: "object", description: "Optional style overrides" },
        after_module_id: { type: "string", description: "Insert after this module (null = first)" },
      },
      required: ["report_id", "module_type", "content"],
    },
  },
  {
    name: "update_module",
    description: "Update a module's content and/or style. Re-renders HTML cache.",
    inputSchema: {
      type: "object",
      properties: {
        module_id: { type: "string" },
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

  // ── Templates + Blueprints ──
  {
    name: "list_templates",
    description: "List available report templates.",
    inputSchema: { type: "object", properties: {} },
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
    name: "extract_design_from_pdf",
    description: "LAYER 2 META-TOOL. Returns an instruction chain to extract brand design tokens from a reference PDF. Claude rasterizes the PDF, analyzes the images for colors/typography/spacing, and saves the result as brand tokens.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_base64: { type: "string", description: "Base64-encoded reference PDF" },
        brand_id: { type: "string", description: "Brand to save tokens to" },
      },
      required: ["pdf_base64", "brand_id"],
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
  const { report_id, module_type, content, style, after_module_id } = args;

  if (!report_id || !module_type || !content) {
    return errorResult("report_id, module_type, and content are required.");
  }
  if (!VALID_MODULE_TYPES.includes(module_type)) {
    return errorResult(`Invalid module_type. Must be one of: ${VALID_MODULE_TYPES.join(", ")}`);
  }

  // Validate layout columns
  if (module_type === "layout") {
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
    INSERT INTO v2_report_modules (id, report_id, module_type, order_index, content, style)
    VALUES (${moduleId}, ${report_id}, ${module_type}, ${orderIndex}, ${JSON.stringify(content)}::jsonb, ${JSON.stringify(style || {})}::jsonb)
  `;

  // Call Python render service for html_cache + height_mm
  let heightMm = null;
  try {
    const brand = await fetchBrandContext(sql, brandId);
    const renderResult = await callRenderService("/render/module", {
      module_id: moduleId,
      module_type,
      content,
      style: style || {},
      brand_tokens: brand.tokens,
      brand_fonts: brand.fonts,
    }, tenantId);
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
  const { module_id, content, style } = args;
  if (!module_id) return errorResult("module_id is required.");
  if (!content && !style) return errorResult("At least one of content or style is required.");

  // Get existing module + report brand + tenant
  const mods = await sql`
    SELECT m.id, m.report_id, m.module_type, m.content, m.style, r.brand_id, r.tenant_id
    FROM v2_report_modules m
    JOIN v2_reports r ON r.id = m.report_id
    WHERE m.id = ${module_id}
    LIMIT 1
  `;
  if (!mods.length) return errorResult(`Module ${module_id} not found.`);
  const mod = mods[0];

  const newContent = content || mod.content;
  const newStyle = style || mod.style;

  // Update module, invalidate cache
  await sql`
    UPDATE v2_report_modules
    SET content = ${JSON.stringify(newContent)}::jsonb,
        style = ${JSON.stringify(newStyle)}::jsonb,
        html_cache = NULL,
        height_mm = NULL
    WHERE id = ${module_id}
  `;

  // Re-render
  let heightMm = null;
  try {
    const brand = await fetchBrandContext(sql, mod.brand_id);
    const renderResult = await callRenderService("/render/module", {
      module_id,
      module_type: mod.module_type,
      content: newContent,
      style: newStyle,
      brand_tokens: brand.tokens,
      brand_fonts: brand.fonts,
    }, mod.tenant_id);
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
    const modHeight = mod.height_mm || 0;

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
    SELECT id, page_id, module_type, order_index, content, style, html_cache
    FROM v2_report_modules WHERE report_id = ${report_id} ORDER BY order_index
  `;

  // Fetch brand tokens and fonts
  const brand = await fetchBrandContext(sql, report.brand_id);

  // Fetch template CSS
  let cssBase = "";
  if (report.template_id) {
    const templates = await sql`SELECT css_base FROM report_templates WHERE id = ${report.template_id} LIMIT 1`;
    cssBase = templates[0]?.css_base || "";
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

  return textResult({
    pdf_url: pdfUrl,
    blob_key: blobKey,
    page_count: pdfResult.page_count ?? pages.length,
    mode,
    size_bytes: pdfBuffer.length,
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

  const rows = await sql`
    UPDATE brands SET tokens = ${JSON.stringify(tokens)}::jsonb
    WHERE id = ${brand_id}
    RETURNING id, tenant_id, name, tokens
  `;
  if (!rows.length) return errorResult(`Brand ${brand_id} not found.`);

  return textResult({ brand_id: rows[0].id, updated: true });
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

// ─── Handler: list_templates ────────────────────────────────────────────────

async function handleListTemplates(userId, args) {
  const sql = getSql();
  const rows = await sql`
    SELECT id, name, description, document_types, created_at
    FROM report_templates ORDER BY name
  `;
  return textResult({ templates: rows, count: rows.length });
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

// ─── Handler: extract_design_from_pdf (Layer 2) ─────────────────────────────

async function handleExtractDesignFromPdf(userId, args) {
  const sql = getSql();
  const { pdf_base64, brand_id } = args;
  if (!pdf_base64 || !brand_id) {
    return errorResult("pdf_base64 and brand_id are required.");
  }

  // Look up tenant from brand so smyra-render JWT carries a tenant_id claim.
  const brands = await sql`SELECT tenant_id FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (!brands.length) return errorResult(`Brand ${brand_id} not found.`);
  const tenantId = brands[0].tenant_id;

  // Rasterize directly via render service so the result is available as an
  // input to Claude's judgment step. We skip the report_id path because this
  // PDF isn't a report yet — it's a reference document.
  let rasterPages;
  try {
    const rasterResult = await callRenderService("/render/rasterize", {
      pdf_base64,
      pages: [1, 2, 3], // first three pages are usually enough
    }, tenantId);
    rasterPages = rasterResult.images || rasterResult.pages || [];
  } catch (e) {
    return errorResult(`Rasterize failed: ${e.message}`);
  }

  return metaResult({
    task: "Extract brand design tokens from reference PDF",
    description:
      "Analyze the rasterized pages below and identify the brand's visual identity. Produce a brand_tokens object matching the schema, then save via report2__save_brand_tokens.",
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
      raster_pages: rasterPages,
    },
    steps: [
      {
        action: "judge",
        instruction:
          "Examine the raster_pages images. Identify: (1) dominant brand color (primary), a darker variant, and an accent color; (2) body/heading/display typography (look up CSS-safe family names); (3) approximate page margins in mm; (4) column gaps and section spacing. Return a brand_tokens object matching output_schema. Prefer conservative defaults over guesses.",
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
  get_editor_url:        handleGetEditorUrl,
  save_brand_tokens:     handleSaveBrandTokens,
  get_brand_tokens:      handleGetBrandTokens,
  upload_font:           handleUploadFont,
  upload_logo:           handleUploadLogo,
  upload_asset:          handleUploadAsset,
  list_templates:        handleListTemplates,
  get_module_schema:     handleGetModuleSchema,
  save_blueprint:        handleSaveBlueprint,
  list_blueprints:       handleListBlueprints,
  create_from_blueprint: handleCreateFromBlueprint,
  rasterize_pdf:         handleRasterizePdf,
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
