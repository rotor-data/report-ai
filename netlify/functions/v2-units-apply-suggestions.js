/**
 * POST /api/v2/units/apply-suggestions
 *
 * Body: { report_id: string, unit_ids: string[] }
 *
 * For each unit_id the server (re-)runs `suggestTypeCorrection`, picks the
 * top suggestion >= 0.6 confidence, and applies the type (+ level if the
 * suggestion provides one). Text is left untouched.
 *
 * We re-run the heuristic on the server rather than trusting client-sent
 * suggestions: confidence values stay tied to the current text, and a
 * stale browser tab can't push arbitrary type changes by faking a
 * suggestion payload.
 *
 * Auth: Hub JWT or Editor token (scoped to the report).
 */
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { getSql } from "./db.js";

const CONFIDENCE_THRESHOLD = 0.6;

const bodySchema = z.object({
  report_id: z.string().uuid(),
  unit_ids: z.array(z.string().min(1)).min(1).max(500),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") {
    return json(event, 405, { error: "Method Not Allowed" });
  }

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const body = parseBody(event);
  if (!body) return json(event, 400, { error: "Invalid JSON" });

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });
  }
  const { report_id: reportId, unit_ids: unitIds } = parsed.data;

  if (editorScopeMismatch(auth, reportId)) {
    return json(event, 403, { error: "Editor token does not match report" });
  }

  const sql = getSql();
  const { suggestTypeCorrection } = await import("../../src/lib/unit-suggestions.js");

  const errors = [];
  let applied = 0;

  try {
    // Fetch all candidate units in one round-trip.
    const rows = await sql`
      SELECT unit_id, type, level, text
      FROM v2_content_units
      WHERE report_id = ${reportId}
        AND unit_id = ANY(${unitIds})
    `;
    const byId = new Map(rows.map((r) => [r.unit_id, r]));

    for (const unitId of unitIds) {
      const row = byId.get(unitId);
      if (!row) {
        errors.push({ unit_id: unitId, error: "Unit not found" });
        continue;
      }
      const matches = suggestTypeCorrection(row);
      const top = matches.find((m) => m.confidence >= CONFIDENCE_THRESHOLD);
      if (!top) {
        errors.push({ unit_id: unitId, error: "No actionable suggestion" });
        continue;
      }

      const newLevel = top.level !== undefined ? top.level : row.level;
      try {
        await sql`
          UPDATE v2_content_units
          SET type = ${top.suggested_type},
              level = ${newLevel},
              updated_at = NOW()
          WHERE report_id = ${reportId} AND unit_id = ${unitId}
        `;
        applied++;
      } catch (err) {
        errors.push({ unit_id: unitId, error: err.message || "Update failed" });
      }
    }

    return json(event, 200, { applied, errors });
  } catch (err) {
    console.error("[v2-units-apply-suggestions]", err);
    return json(event, 500, { error: err.message || "Internal error" });
  }
};
