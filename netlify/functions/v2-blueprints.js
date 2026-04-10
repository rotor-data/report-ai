/**
 * REST endpoints for Report Engine v2 blueprints.
 *
 * GET  /api/v2-blueprints?brand_id=...   → list blueprints
 * POST /api/v2-blueprints                 → save blueprint from report
 *                                           body: { report_id, name }
 * POST /api/v2-blueprints/create-from     → create a new report from blueprint
 *                                           body: { blueprint_id, title, document_type }
 *
 * Auth: Hub JWT.
 */
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

const saveSchema = z.object({
  report_id: z.string().uuid(),
  name: z.string().min(1),
});

const createFromSchema = z.object({
  blueprint_id: z.string().uuid(),
  title: z.string().min(1),
  document_type: z.string().min(1),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

function isCreateFromPath(path = "") {
  return path.split("?")[0].endsWith("/create-from");
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();

  try {
    if (event.httpMethod === "GET") {
      const brandId = event.queryStringParameters?.brand_id;
      if (!brandId) return json(event, 400, { error: "brand_id query param required" });

      const rows = await sql`
        SELECT id, brand_id, name, source_report_id, created_at,
               jsonb_array_length(modules) AS module_count
        FROM report_blueprints WHERE brand_id = ${brandId}
        ORDER BY created_at DESC
      `;
      return json(event, 200, { items: rows });
    }

    if (event.httpMethod === "POST" && isCreateFromPath(event.path)) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });
      const parsed = createFromSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const { blueprint_id, title, document_type } = parsed.data;

      const blueprints = await sql`
        SELECT id, brand_id, modules FROM report_blueprints WHERE id = ${blueprint_id} LIMIT 1
      `;
      if (!blueprints.length) return json(event, 404, { error: "Blueprint not found" });
      const bp = blueprints[0];

      const brands = await sql`SELECT tenant_id FROM brands WHERE id = ${bp.brand_id} LIMIT 1`;
      if (!brands.length) return json(event, 400, { error: "Brand not found" });
      const tenantId = brands[0].tenant_id;

      const reportRows = await sql`
        INSERT INTO v2_reports (tenant_id, brand_id, title, document_type, status)
        VALUES (${tenantId}, ${bp.brand_id}, ${title}, ${document_type}, 'draft')
        RETURNING id, tenant_id, brand_id, title, document_type, status, created_at, updated_at
      `;
      const reportId = reportRows[0].id;

      const bpModules = typeof bp.modules === "string" ? JSON.parse(bp.modules) : bp.modules;
      for (const mod of bpModules) {
        await sql`
          INSERT INTO v2_report_modules (report_id, module_type, order_index, content, style)
          VALUES (
            ${reportId}, ${mod.module_type}, ${mod.order_index},
            ${JSON.stringify(mod.content || {})}::jsonb,
            ${JSON.stringify(mod.style || {})}::jsonb
          )
        `;
      }

      return json(event, 201, { item: reportRows[0], module_count: bpModules.length });
    }

    if (event.httpMethod === "POST") {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });
      const parsed = saveSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const { report_id, name } = parsed.data;

      const reports = await sql`SELECT id, brand_id FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
      if (!reports.length) return json(event, 404, { error: "Report not found" });
      const brandId = reports[0].brand_id;
      if (!brandId) return json(event, 400, { error: "Report has no brand_id" });

      const modules = await sql`
        SELECT module_type, order_index, style
        FROM v2_report_modules WHERE report_id = ${report_id}
        ORDER BY order_index
      `;
      const blueprintModules = modules.map((m) => ({
        module_type: m.module_type,
        order_index: m.order_index,
        style: m.style,
        content: {},
      }));

      const rows = await sql`
        INSERT INTO report_blueprints (brand_id, name, source_report_id, modules)
        VALUES (${brandId}, ${name}, ${report_id}, ${JSON.stringify(blueprintModules)}::jsonb)
        RETURNING id, brand_id, name, source_report_id, created_at
      `;
      return json(event, 201, { item: rows[0], module_count: blueprintModules.length });
    }

    return json(event, 405, { error: "Method Not Allowed" });
  } catch (err) {
    console.error("[v2-blueprints]", err);
    return json(event, 500, { error: err.message });
  }
};
