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

// metadata is JSONB — accept any shape but cap raw payload size to keep a
// runaway client from filling the column with megabytes.
const MAX_METADATA_BYTES = 1024 * 1024; // 1 MB

const updateSchema = z.object({
  text: z.string().nullable().optional(),
  level: z.number().int().min(1).max(6).nullable().optional(),
  metadata: z.record(z.string(), z.any()).nullable().optional(),
}).refine(
  (d) => d.text !== undefined || d.level !== undefined || d.metadata !== undefined,
  { message: "Provide at least one of: text, level, metadata" },
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

    // COALESCE-style update: only fields present in the body are written.
    // Zod's optional() lets `undefined` mean "leave alone"; explicit `null`
    // for `level`/`metadata` clears the column to NULL/{} respectively.
    const newText = parsed.data.text === undefined ? existing.text : parsed.data.text;
    const newLevel = parsed.data.level === undefined ? existing.level : parsed.data.level;
    const newMetadata = parsed.data.metadata === undefined
      ? existing.metadata
      : (parsed.data.metadata ?? {});

    const updated = await sql`
      UPDATE v2_content_units
      SET text = ${newText},
          level = ${newLevel},
          metadata = ${JSON.stringify(newMetadata)}::jsonb,
          updated_at = NOW()
      WHERE id = ${unitId}
      RETURNING id, report_id, unit_id, type, level, text, metadata,
                order_index, created_at, updated_at
    `;

    return json(event, 200, { item: updated[0] });
  } catch (err) {
    console.error("[v2-content-units]", err);
    return json(event, 500, { error: err.message || "Internal error" });
  }
};
