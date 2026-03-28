import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { summarizePreflight, validateHtmlWithLayoutRules } from "./layout-quality.js";

const schema = z.object({
  document_id: z.string().uuid(),
});

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(event, 400, { error: "Invalid JSON" });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

  const sql = getSql();
  const rows = await sql`
    SELECT id, html_output, layout_ast, design_system, decision_context
    FROM documents
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;

  const doc = rows[0];
  if (!doc) return json(event, 404, { error: "Document not found" });

  const issues = validateHtmlWithLayoutRules(doc.html_output || "");
  const metrics = {
    ...summarizePreflight(doc.html_output || "", issues),
    has_layout_ast: Boolean(doc.layout_ast),
  };

  await sql`
    INSERT INTO document_layout_metrics (document_id, metrics, issues, updated_at)
    VALUES (${doc.id}, ${JSON.stringify(metrics)}::jsonb, ${JSON.stringify(issues)}::jsonb, NOW())
    ON CONFLICT (document_id)
    DO UPDATE SET
      metrics = EXCLUDED.metrics,
      issues = EXCLUDED.issues,
      updated_at = NOW()
  `;

  return json(event, 200, {
    ok: metrics.blocking_issues === 0,
    metrics,
    issues,
    user_message:
      metrics.blocking_issues === 0
        ? "Preflight klar utan blockerande fel."
        : `Preflight hittade ${metrics.blocking_issues} blockerande problem som behöver fixas innan PDF-export.`,
  });
};
