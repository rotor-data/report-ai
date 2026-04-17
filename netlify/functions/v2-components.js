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
  if (event.httpMethod !== "GET") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const componentId = getIdFromPath(event.path);

  try {
    // Single component
    if (componentId) {
      const rows = await sql`
        SELECT id, brand_id, component_type, label, html_template,
               placeholder_schema, design_notes, source, version, is_default
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
          SELECT id, brand_id, component_type, label, html_template,
                 placeholder_schema, design_notes, source, version, is_default
          FROM brand_components
          WHERE brand_id = ${brandId} AND component_type = ${componentType}
          ORDER BY is_default DESC, updated_at DESC
        `
      : await sql`
          SELECT id, brand_id, component_type, label, html_template,
                 placeholder_schema, design_notes, source, version, is_default
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
