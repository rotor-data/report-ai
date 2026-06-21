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
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
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
  page_format: z.string().optional(),
  // Per-report overrides on top of brand_tokens. Editor-side panels
  // write keys like primary / accent / text / bg / heading_font /
  // body_font. v2-brand-css merges this over the brand row at read
  // time so the whole editor preview + PDF pick up the override
  // without touching the shared brand.
  style_overrides: z.record(z.string(), z.any()).optional(),
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

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const reportId = getIdFromPath(event.path);

  // Editor tokens are scoped to one report — forbid list/create + cross-report access.
  if (auth.editorScope) {
    if (!reportId) return json(event, 403, { error: "Editor token scoped to single report" });
    if (editorScopeMismatch(auth, reportId)) {
      return json(event, 403, { error: "Editor token does not match report" });
    }
    if (event.httpMethod === "DELETE") {
      return json(event, 403, { error: "Delete not allowed with editor token" });
    }
  }

  // Hub-JWT path: bind every query to the caller's tenant. The JWT org is the
  // ONLY trusted tenant source — never the query param / body. A Hub JWT with
  // no tenant_id has no org context, so it FAILS CLOSED (403) rather than
  // running an unscoped query that would read/write across tenants.
  const hubTenantId = auth.editorScope
    ? null
    : (auth.payload?.tenant_id ?? auth.payload?.claims?.tenant_id ?? null);
  if (!auth.editorScope && !hubTenantId) {
    return json(event, 403, { error: "Token carries no tenant — access denied" });
  }

  try {
    if (event.httpMethod === "GET" && !reportId) {
      // Force the list filter to the JWT tenant — IGNORE any tenant_id query
      // param so a Hub user can never enumerate another org's reports.
      const rows = await sql`
        SELECT id, tenant_id, brand_id, template_id, title, document_type, status, created_at, updated_at
        FROM v2_reports
        WHERE tenant_id = ${hubTenantId}
        ORDER BY updated_at DESC
      `;
      return json(event, 200, { items: rows });
    }

    if (event.httpMethod === "GET" && reportId) {
      const reports = hubTenantId
        ? await sql`
            SELECT id, tenant_id, brand_id, template_id, title, document_type, status, page_format, style_overrides, created_at, updated_at
            FROM v2_reports WHERE id = ${reportId} AND tenant_id = ${hubTenantId} LIMIT 1
          `
        : await sql`
            SELECT id, tenant_id, brand_id, template_id, title, document_type, status, page_format, style_overrides, created_at, updated_at
            FROM v2_reports WHERE id = ${reportId} LIMIT 1
          `;
      if (!reports[0]) return json(event, 404, { error: "Report not found" });

      // Reflow plan 2026-05-08, Job 4: also surface block_type / block_index /
      // flow_pdf_pages so the editor can render flow-mode chapter blocks as
      // tall scrollable canvases (vs the default fixed-height `.page` clip)
      // and label them in the sidebar with their PDF-page span.
      const pages = await sql`
        SELECT id, page_number, page_type, block_type, block_index,
               flow_pdf_pages, created_at
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

      // Never trust the body tenant_id — bind the new report to the JWT tenant
      // (editor tokens can't reach POST: they're rejected above with no reportId).
      if (parsed.data.tenant_id !== hubTenantId) {
        return json(event, 403, { error: "tenant_id does not match caller's tenant" });
      }

      const id = randomUUID();
      const rows = await sql`
        INSERT INTO v2_reports (id, tenant_id, brand_id, template_id, title, document_type, status)
        VALUES (
          ${id},
          ${hubTenantId},
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

      // If page_format changes, bump pdf_cache_version so any cached PDF URL
      // from the previous format is no longer returned as fresh. The blob key
      // already includes a timestamp, so old renders aren't overwritten — they
      // just stop being surfaced as the "current" PDF.
      const styleJson =
        parsed.data.style_overrides !== undefined
          ? JSON.stringify(parsed.data.style_overrides)
          : null;
      const rows = hubTenantId
        ? await sql`
            UPDATE v2_reports
            SET
              title = COALESCE(${parsed.data.title ?? null}, title),
              status = COALESCE(${parsed.data.status ?? null}, status),
              page_format = COALESCE(${parsed.data.page_format ?? null}, page_format),
              style_overrides = COALESCE(${styleJson}::jsonb, style_overrides),
              updated_at = NOW()
            WHERE id = ${reportId} AND tenant_id = ${hubTenantId}
            RETURNING id, tenant_id, brand_id, template_id, title, document_type, status, page_format, style_overrides, created_at, updated_at
          `
        : await sql`
            UPDATE v2_reports
            SET
              title = COALESCE(${parsed.data.title ?? null}, title),
              status = COALESCE(${parsed.data.status ?? null}, status),
              page_format = COALESCE(${parsed.data.page_format ?? null}, page_format),
              style_overrides = COALESCE(${styleJson}::jsonb, style_overrides),
              updated_at = NOW()
            WHERE id = ${reportId}
            RETURNING id, tenant_id, brand_id, template_id, title, document_type, status, page_format, style_overrides, created_at, updated_at
          `;
      if (!rows[0]) return json(event, 404, { error: "Report not found" });
      return json(event, 200, { item: rows[0], page_format_changed: !!parsed.data.page_format });
    }

    if (event.httpMethod === "DELETE" && reportId) {
      // Tenant-scope the delete: confirm the report belongs to the caller's
      // tenant BEFORE cascading the child deletes, so a Hub user can't wipe
      // another org's report by id.
      const owned = await sql`
        SELECT id FROM v2_reports WHERE id = ${reportId} AND tenant_id = ${hubTenantId} LIMIT 1
      `;
      if (!owned[0]) return json(event, 404, { error: "Report not found" });
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
