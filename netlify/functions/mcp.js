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
    description: "Create a new report document. Pre-populates module_plan with required section stubs for the chosen document type. Returns the full document.",
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
    description: "Save a design system (colors, typography, spacing, page layout) to a document. Call this after analyzing brand input and generating the design system JSON. The design system will be used when generating HTML.",
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
    description: "Save a module plan (ordered array of page modules) to a document. Automatically validates against required sections for the document type and merges missing stubs. Returns the final plan and any warnings about missing required sections.",
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
    description: "Save generated print-ready HTML to a document. Validates against guardrails (no scripts, min font sizes, cover/back_cover present, @page rules). Returns validation result with any issues found.",
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
    description: "Get all context needed to generate a report: required sections for the document type, available module types, print guardrails, table data schema, and the user's custom fonts. ALWAYS call this before generating a module plan or HTML.",
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
