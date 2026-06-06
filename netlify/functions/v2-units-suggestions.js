/**
 * GET /api/v2/units/suggestions?report_id=<uuid>
 *
 * Heuristic type-correction suggestions for the report's content units.
 * Reads `v2_content_units`, runs each row through `suggestTypeCorrection`,
 * and returns the actionable subset (confidence >= 0.6).
 *
 * Auth: Hub JWT or Editor capability token (editor token must match the
 * report). The endpoint is read-only — no DB writes here. Apply happens
 * via POST /api/v2/units/apply-suggestions.
 *
 * The suggestions helper is imported lazily so cold starts on PATCH
 * (the hot path) don't pull in the heuristic regexes.
 */
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { getSql } from "./db.js";

const CONFIDENCE_THRESHOLD = 0.6;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "GET") {
    return json(event, 405, { error: "Method Not Allowed" });
  }

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const reportId = event.queryStringParameters?.report_id;
  if (!reportId) return json(event, 400, { error: "Missing report_id" });

  if (editorScopeMismatch(auth, reportId)) {
    return json(event, 403, { error: "Editor token does not match report" });
  }

  const sql = getSql();

  try {
    const rows = await sql`
      SELECT unit_id, type, level, text
      FROM v2_content_units
      WHERE report_id = ${reportId}
      ORDER BY order_index ASC
    `;

    // Lazy import — keeps the patch hot-path bundle small.
    const { suggestTypeCorrection } = await import("../../src/lib/unit-suggestions.js");

    const suggestions = [];
    for (const row of rows) {
      const matches = suggestTypeCorrection(row);
      const top = matches.find((m) => m.confidence >= CONFIDENCE_THRESHOLD);
      if (!top) continue;
      suggestions.push({
        unit_id: row.unit_id,
        current_type: row.type,
        suggested_type: top.suggested_type,
        confidence: top.confidence,
        reasoning: top.reasoning,
        ...(top.level !== undefined ? { level: top.level } : {}),
      });
    }

    return json(event, 200, { suggestions });
  } catch (err) {
    console.error("[v2-units-suggestions]", err);
    return json(event, 500, { error: err.message || "Internal error" });
  }
};
