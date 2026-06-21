/**
 * REST endpoint for editing v2 content units.
 *
 *   PATCH /api/v2/content_units/:id   → update text / level / metadata
 *
 * Auth: Hub JWT or Editor capability token. Editor tokens are scoped to a
 * single report — we cross-check that the unit's `report_id` matches the
 * token's `editorScope.reportId`. Hub JWTs implicitly trust the caller
 * because the Hub gateway already authenticated the user before issuing
 * them; cross-tenant access for hub-authenticated users is the usual
 * "user belongs to brand" check we apply elsewhere (see v2-modules.js
 * `assertEditorScopeForReport`).
 */
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { editDistance } from "../../src/lib/edit-distance.js";

// metadata is JSONB — accept any shape but cap raw payload size to keep a
// runaway client from filling the column with megabytes.
const MAX_METADATA_BYTES = 1024 * 1024; // 1 MB

const updateSchema = z.object({
  text: z.string().nullable().optional(),
  level: z.number().int().min(1).max(6).nullable().optional(),
  metadata: z.record(z.string(), z.any()).nullable().optional(),
  // Drag-to-reorder support: integer position within the report's units list.
  // The renderer/editor sort by order_index, so changing this is a no-op for
  // text contents but reshuffles the on-page ordering when refs are
  // re-resolved. Negative values are rejected.
  order_index: z.number().int().min(0).optional(),
  // Type-change support (rare, but needed for bulk-edit "change type").
  // Loose validation — server doesn't enforce the catalogue here; the
  // renderer falls back to a generic block for unknown types.
  type: z.string().min(1).max(64).optional(),
}).refine(
  (d) =>
    d.text !== undefined
    || d.level !== undefined
    || d.metadata !== undefined
    || d.order_index !== undefined
    || d.type !== undefined,
  { message: "Provide at least one of: text, level, metadata, order_index, type" },
);

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

/**
 * Pull the unit id off the path. Accepts both:
 *   /.netlify/functions/v2-content-units/<id>
 *   /api/v2/content_units/<id>
 * (the netlify.toml redirect rewrites the latter).
 */
function getIdFromPath(path = "") {
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  // Walk from the end — the id is always the trailing segment after one of
  // the known endpoint markers.
  const markers = ["content_units", "v2-content-units"];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (markers.includes(parts[i])) {
      return parts[i + 1] ?? null;
    }
  }
  return null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "PATCH") {
    return json(event, 405, { error: "Method Not Allowed" });
  }

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  // Hub-JWT path: JWT org is the only trusted tenant; a Hub JWT with no
  // tenant_id fails closed. Editor tokens are report-scoped (checked below).
  const hubTenantId = auth.editorScope
    ? null
    : (auth.payload?.tenant_id ?? auth.payload?.claims?.tenant_id ?? null);
  if (!auth.editorScope && !hubTenantId) {
    return json(event, 403, { error: "Token carries no tenant — access denied" });
  }

  const unitId = getIdFromPath(event.path);
  if (!unitId) return json(event, 400, { error: "Missing unit id" });

  const body = parseBody(event);
  if (!body) return json(event, 400, { error: "Invalid JSON" });

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });
  }

  // Metadata size sanity check — Zod can't express byte limits on JSONB.
  if (parsed.data.metadata !== undefined && parsed.data.metadata !== null) {
    let metaBytes = 0;
    try {
      metaBytes = Buffer.byteLength(JSON.stringify(parsed.data.metadata), "utf8");
    } catch {
      return json(event, 400, { error: "metadata is not JSON-serialisable" });
    }
    if (metaBytes > MAX_METADATA_BYTES) {
      return json(event, 400, {
        error: `metadata exceeds ${MAX_METADATA_BYTES} bytes (got ${metaBytes})`,
      });
    }
  }

  const sql = getSql();

  try {
    const rows = await sql`
      SELECT id, report_id, unit_id, type, level, text, metadata, order_index
      FROM v2_content_units
      WHERE id = ${unitId}
      LIMIT 1
    `;
    if (!rows.length) return json(event, 404, { error: "Unit not found" });
    const existing = rows[0];

    if (editorScopeMismatch(auth, existing.report_id)) {
      return json(event, 403, { error: "Editor token does not match report" });
    }

    // Hub-JWT path: confirm the unit's owning report belongs to the caller's
    // tenant. Without this any Hub user could edit any org's content units.
    if (hubTenantId) {
      const owner = await sql`
        SELECT tenant_id FROM v2_reports WHERE id = ${existing.report_id} LIMIT 1
      `;
      if (!owner.length || owner[0].tenant_id !== hubTenantId) {
        return json(event, 403, { error: "Unit not accessible in this tenant" });
      }
    }

    // COALESCE-style update: only fields present in the body are written.
    // Zod's optional() lets `undefined` mean "leave alone"; explicit `null`
    // for `level`/`metadata` clears the column to NULL/{} respectively.
    const newText = parsed.data.text === undefined ? existing.text : parsed.data.text;
    const newLevel = parsed.data.level === undefined ? existing.level : parsed.data.level;
    const newMetadata = parsed.data.metadata === undefined
      ? existing.metadata
      : (parsed.data.metadata ?? {});
    const newOrderIndex = parsed.data.order_index === undefined
      ? existing.order_index
      : parsed.data.order_index;
    const newType = parsed.data.type === undefined ? existing.type : parsed.data.type;

    const updated = await sql`
      UPDATE v2_content_units
      SET text = ${newText},
          level = ${newLevel},
          metadata = ${JSON.stringify(newMetadata)}::jsonb,
          order_index = ${newOrderIndex},
          type = ${newType},
          updated_at = NOW()
      WHERE id = ${unitId}
      RETURNING id, report_id, unit_id, type, level, text, metadata,
                order_index, created_at, updated_at
    `;

    // Fire-and-forget feedback row: capture the (before, after) delta so the
    // parse heuristics can learn from real edits. We only record when text or
    // type actually changed — order_index/metadata-only edits aren't
    // interesting to the parse model. Detached promise MUST have a .catch
    // (see hub CLAUDE.md "Fire-and-forget DB writes MUST have .catch") to
    // avoid unhandledRejection crashing the Lambda.
    const textChanged = parsed.data.text !== undefined && parsed.data.text !== existing.text;
    const typeChanged = parsed.data.type !== undefined && parsed.data.type !== existing.type;
    if (textChanged || typeChanged) {
      const dist = editDistance(existing.text, newText);
      sql`
        INSERT INTO unit_parse_feedback
          (report_id, unit_id, original_text, original_type,
           edited_text, edited_type, edit_distance)
        VALUES
          (${existing.report_id}, ${existing.unit_id},
           ${existing.text}, ${existing.type},
           ${newText}, ${newType}, ${dist})
        ON CONFLICT (report_id, unit_id, created_at) DO NOTHING
      `.catch((err) => console.warn("[unit-parse-feedback]", err?.message || err));
    }

    return json(event, 200, { item: updated[0] });
  } catch (err) {
    console.error("[v2-content-units]", err);
    return json(event, 500, { error: err.message || "Internal error" });
  }
};
