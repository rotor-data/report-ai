/**
 * REST endpoints for Report Engine v2 reports.
 *
 * GET    /api/v2-reports?tenant_id=...      → list reports for tenant
 * GET    /api/v2-reports/:id                → single report with pages + modules
 * POST   /api/v2-reports                    → create report
 * PATCH  /api/v2-reports/:id                → update title/status
 * DELETE /api/v2-reports/:id                → delete report
 *
 * Auth: Hub JWT (matches pattern used by documents.js, brand-profiles.js, etc.)
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

const createSchema = z.object({
  tenant_id: z.string().uuid(),
  brand_id: z.string().uuid(),
  title: z.string().min(1),
  document_type: z.string().min(1),
  template_id: z.string().nullable().optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.string().optional(),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

function getIdFromPath(path = "") {
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("v2-reports");
  if (idx === -1) return null;
  return parts[idx + 1] ?? null;
}

function getQuery(event) {
  return event.queryStringParameters || {};
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const reportId = getIdFromPath(event.path);

  try {
    if (event.httpMethod === "GET" && !reportId) {
      const { tenant_id } = getQuery(event);
      if (!tenant_id) return json(event, 400, { error: "tenant_id query param required" });

      const rows = await sql`
        SELECT id, tenant_id, brand_id, template_id, title, document_type, status, created_at, updated_at
        FROM v2_reports
        WHERE tenant_id = ${tenant_id}
        ORDER BY updated_at DESC
      `;
      return json(event, 200, { items: rows });
    }

    if (event.httpMethod === "GET" && reportId) {
      const reports = await sql`
        SELECT id, tenant_id, brand_id, template_id, title, document_type, status, created_at, updated_at
        FROM v2_reports WHERE id = ${reportId} LIMIT 1
      `;
      if (!reports[0]) return json(event, 404, { error: "Report not found" });

      const pages = await sql`
        SELECT id, page_number, page_type, created_at
        FROM v2_report_pages WHERE report_id = ${reportId}
        ORDER BY page_number
      `;

      const modules = await sql`
        SELECT id, page_id, module_type, order_index, content, style, html_cache, height_mm, created_at, updated_at
        FROM v2_report_modules WHERE report_id = ${reportId}
        ORDER BY order_index
      `;

      return json(event, 200, { item: reports[0], pages, modules });
    }

    if (event.httpMethod === "POST" && !reportId) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const id = randomUUID();
      const rows = await sql`
        INSERT INTO v2_reports (id, tenant_id, brand_id, template_id, title, document_type, status)
        VALUES (
          ${id},
          ${parsed.data.tenant_id},
          ${parsed.data.brand_id},
          ${parsed.data.template_id || null},
          ${parsed.data.title},
          ${parsed.data.document_type},
          'draft'
        )
        RETURNING id, tenant_id, brand_id, template_id, title, document_type, status, created_at, updated_at
      `;
      return json(event, 201, { item: rows[0] });
    }

    if (event.httpMethod === "PATCH" && reportId) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const rows = await sql`
        UPDATE v2_reports
        SET
          title = COALESCE(${parsed.data.title ?? null}, title),
          status = COALESCE(${parsed.data.status ?? null}, status),
          updated_at = NOW()
        WHERE id = ${reportId}
        RETURNING id, tenant_id, brand_id, template_id, title, document_type, status, created_at, updated_at
      `;
      if (!rows[0]) return json(event, 404, { error: "Report not found" });
      return json(event, 200, { item: rows[0] });
    }

    if (event.httpMethod === "DELETE" && reportId) {
      await sql`DELETE FROM v2_report_modules WHERE report_id = ${reportId}`;
      await sql`DELETE FROM v2_report_pages WHERE report_id = ${reportId}`;
      const rows = await sql`DELETE FROM v2_reports WHERE id = ${reportId} RETURNING id`;
      if (!rows[0]) return json(event, 404, { error: "Report not found" });
      return noContent(event);
    }

    return json(event, 405, { error: "Method Not Allowed" });
  } catch (err) {
    console.error("[v2-reports]", err);
    return json(event, 500, { error: err.message });
  }
};
