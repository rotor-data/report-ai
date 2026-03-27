import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { getDefaultStubPlan, mergeMissingStubs, validateModulePlan } from "./document-type-templates.js";

const createSchema = z.object({
  title: z.string().min(1),
  document_type: z.enum(["annual_report", "quarterly", "pitch", "proposal"]),
});

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(["draft", "generating", "ready", "error"]).optional(),
  brand_input: z.any().optional(),
  design_system: z.any().optional(),
  raw_content: z.string().optional(),
  module_plan: z.array(z.any()).optional(),
  html_output: z.string().optional(),
  auto_add_missing_sections: z.boolean().optional(),
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
  const idx = parts.lastIndexOf("documents");
  if (idx === -1) return null;
  return parts[idx + 1] ?? null;
}

function selectPublicDocFields(doc) {
  return {
    id: doc.id,
    title: doc.title,
    document_type: doc.document_type,
    status: doc.status,
    brand_input: doc.brand_input,
    design_system: doc.design_system,
    raw_content: doc.raw_content,
    module_plan: doc.module_plan,
    html_output: doc.html_output,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const docId = getIdFromPath(event.path);

  if (event.httpMethod === "GET" && !docId) {
    const rows = await sql`
      SELECT *
      FROM documents
      WHERE hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `;
    return json(event, 200, { items: rows.map(selectPublicDocFields) });
  }

  if (event.httpMethod === "GET" && docId) {
    const rows = await sql`
      SELECT *
      FROM documents
      WHERE id = ${docId} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      LIMIT 1
    `;

    if (!rows[0]) return json(event, 404, { error: "Document not found" });

    const validation = await validateModulePlan(rows[0].document_type, rows[0].module_plan ?? []);
    return json(event, 200, { item: selectPublicDocFields(rows[0]), warnings: validation.missing });
  }

  if (event.httpMethod === "POST" && !docId) {
    const body = parseBody(event);
    if (!body) return json(event, 400, { error: "Invalid JSON" });

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

    const defaultPlan = await getDefaultStubPlan(parsed.data.document_type);
    const modulePlan = defaultPlan.map((m, idx) => ({
      id: m.id ?? randomUUID(),
      order: m.order ?? idx + 1,
      ...m,
      stub: true,
    }));

    const id = randomUUID();
    const rows = await sql`
      INSERT INTO documents (id, hub_user_id, title, document_type, module_plan)
      VALUES (${id}, ${auth.hubUserId}, ${parsed.data.title}, ${parsed.data.document_type}, ${JSON.stringify(modulePlan)}::jsonb)
      RETURNING *
    `;

    const warnings = await validateModulePlan(rows[0].document_type, rows[0].module_plan ?? []);
    return json(event, 201, { item: selectPublicDocFields(rows[0]), warnings: warnings.missing });
  }

  if (event.httpMethod === "PATCH" && docId) {
    const body = parseBody(event);
    if (!body) return json(event, 400, { error: "Invalid JSON" });

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

    const rows = await sql`
      SELECT *
      FROM documents
      WHERE id = ${docId} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      LIMIT 1
    `;
    const existing = rows[0];
    if (!existing) return json(event, 404, { error: "Document not found" });

    let modulePlan = parsed.data.module_plan ?? existing.module_plan ?? [];
    if (has(parsed.data, "module_plan") && parsed.data.auto_add_missing_sections) {
      const merged = await mergeMissingStubs(existing.document_type, modulePlan);
      modulePlan = merged.modulePlan;
    }

    const warnings = (await validateModulePlan(existing.document_type, modulePlan)).missing;

    const updated = await sql`
      UPDATE documents
      SET
        title = COALESCE(${has(parsed.data, "title") ? parsed.data.title : null}, title),
        status = COALESCE(${has(parsed.data, "status") ? parsed.data.status : null}::doc_status, status),
        brand_input = COALESCE(${has(parsed.data, "brand_input") ? JSON.stringify(parsed.data.brand_input) : null}::jsonb, brand_input),
        design_system = COALESCE(${has(parsed.data, "design_system") ? JSON.stringify(parsed.data.design_system) : null}::jsonb, design_system),
        raw_content = COALESCE(${has(parsed.data, "raw_content") ? parsed.data.raw_content : null}, raw_content),
        module_plan = COALESCE(${has(parsed.data, "module_plan") ? JSON.stringify(modulePlan) : null}::jsonb, module_plan),
        html_output = COALESCE(${has(parsed.data, "html_output") ? parsed.data.html_output : null}, html_output),
        updated_at = NOW()
      WHERE id = ${docId} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      RETURNING *
    `;

    return json(event, 200, { item: selectPublicDocFields(updated[0]), warnings });
  }

  if (event.httpMethod === "DELETE" && docId) {
    const rows = await sql`
      UPDATE documents
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${docId} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      RETURNING id
    `;

    if (!rows[0]) return json(event, 404, { error: "Document not found" });
    return noContent(event);
  }

  return json(event, 405, { error: "Method Not Allowed" });
};
