/**
 * REST endpoints for the brand component library.
 *
 * GET  /api/v2-components?brand_id=<uuid>[&component_type=...]
 *      → list brand_components metadata (with full html_template)
 *
 * GET  /api/v2-components/:id
 *      → fetch a single component by id
 *
 * Auth: Hub JWT OR editor token (editor token must resolve to a report
 * whose brand_id matches the requested brand_id).
 */
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

function getIdFromPath(path = "") {
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("v2-components");
  if (idx === -1) return null;
  return parts[idx + 1] ?? null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (!["GET", "DELETE", "PATCH"].includes(event.httpMethod)) return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const componentId = getIdFromPath(event.path);

  try {
    // DELETE: remove a component by id. Editor-token requests are rejected —
    // only Hub JWT holders (dashboard callers) may delete.
    if (event.httpMethod === "DELETE") {
      if (!componentId) return json(event, 400, { error: "Missing component id" });
      if (auth.editorScope) return json(event, 403, { error: "Editor token cannot delete components" });
      const deleted = await sql`DELETE FROM brand_components WHERE id = ${componentId} RETURNING id`;
      if (!deleted.length) return json(event, 404, { error: "Component not found" });
      return json(event, 200, { ok: true, id: componentId });
    }

    // PATCH: update status / variant_name / label. Hub JWT only.
    if (event.httpMethod === "PATCH") {
      if (!componentId) return json(event, 400, { error: "Missing component id" });
      if (auth.editorScope) return json(event, 403, { error: "Editor token cannot update components" });
      let body = {};
      try { body = event.body ? JSON.parse(event.body) : {}; } catch { return json(event, 400, { error: "Invalid JSON" }); }
      const { status, variant_name, label } = body;
      if (!status && typeof variant_name === "undefined" && typeof label === "undefined") {
        return json(event, 400, { error: "No updatable fields in body" });
      }
      if (status && !["draft", "ready", "deprecated"].includes(status)) {
        return json(event, 400, { error: "Invalid status" });
      }
      const updated = await sql`
        UPDATE brand_components SET
          status = COALESCE(${status ?? null}, status),
          variant_name = COALESCE(${typeof variant_name === "undefined" ? null : variant_name}, variant_name),
          label = COALESCE(${typeof label === "undefined" ? null : label}, label),
          updated_at = NOW()
        WHERE id = ${componentId}
        RETURNING id, status, variant_name, label
      `;
      if (!updated.length) return json(event, 404, { error: "Component not found" });
      return json(event, 200, { ok: true, item: updated[0] });
    }

    // Single component
    if (componentId) {
      const rows = await sql`
        SELECT id, brand_id, component_type, variant_name, page_format, status,
               label, html_template,
               placeholder_schema, design_notes, source, version, is_default,
               created_at, updated_at
        FROM brand_components WHERE id = ${componentId} LIMIT 1
      `;
      if (!rows.length) return json(event, 404, { error: "Component not found" });

      // Editor token: enforce that the component's brand matches the
      // editor's scoped report brand.
      if (auth.editorScope) {
        const reports = await sql`
          SELECT brand_id FROM v2_reports WHERE id = ${auth.editorScope.reportId} LIMIT 1
        `;
        if (!reports.length || reports[0].brand_id !== rows[0].brand_id) {
          return json(event, 403, { error: "Editor token does not match component brand" });
        }
      }
      return json(event, 200, { item: rows[0] });
    }

    // List
    const brandId = event.queryStringParameters?.brand_id;
    const componentType = event.queryStringParameters?.component_type;
    if (!brandId) return json(event, 400, { error: "Missing brand_id" });

    if (auth.editorScope) {
      const reports = await sql`
        SELECT brand_id FROM v2_reports WHERE id = ${auth.editorScope.reportId} LIMIT 1
      `;
      if (!reports.length || reports[0].brand_id !== brandId) {
        return json(event, 403, { error: "Editor token does not match brand" });
      }
    }

    const rows = componentType
      ? await sql`
          SELECT id, brand_id, component_type, variant_name, page_format, status,
                 label, html_template,
                 placeholder_schema, design_notes, source, version, is_default,
                 created_at, updated_at
          FROM brand_components
          WHERE brand_id = ${brandId} AND component_type = ${componentType}
          ORDER BY is_default DESC, updated_at DESC
        `
      : await sql`
          SELECT id, brand_id, component_type, variant_name, page_format, status,
                 label, html_template,
                 placeholder_schema, design_notes, source, version, is_default,
                 created_at, updated_at
          FROM brand_components
          WHERE brand_id = ${brandId}
          ORDER BY component_type, is_default DESC, updated_at DESC
        `;

    return json(event, 200, { items: rows, count: rows.length });
  } catch (err) {
    console.error("[v2-components]", err);
    return json(event, 500, { error: err.message });
  }
};
