/**
 * GET /api/v2-editor-url?report_id=<uuid>
 *
 * Mints a fresh HMAC editor capability token and returns the full
 * `/editor/v2?token=...` URL for the requested report.
 *
 * Used by the SPA dashboard's report-list to launch the modern editor
 * (token-authenticated, standalone surface). The MCP tool
 * `report2__get_editor_url` does the equivalent for chat-driven flows;
 * this endpoint exists so the in-browser dashboard can do the same
 * without going through MCP.
 *
 * Auth: Hub JWT only — editor tokens cannot mint new editor tokens
 * (avoids token-refresh loops + scope-creep). The hub user that owns
 * the report drives the userId stamped into the new token.
 */
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { createEditorToken } from "./editor-token.js";
import { getSql } from "./db.js";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "GET") {
    return json(event, 405, { error: "Method Not Allowed" });
  }

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const reportId = event.queryStringParameters?.report_id;
  if (!reportId) return json(event, 400, { error: "Missing report_id" });

  const sql = getSql();
  try {
    const [report] = await sql`
      SELECT id FROM v2_reports WHERE id = ${reportId} LIMIT 1
    `;
    if (!report) return json(event, 404, { error: "Report not found" });

    const token = createEditorToken(auth.hubUserId, reportId);
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
    const editorUrl = `${siteUrl}/editor/v2?token=${token}`;

    return json(event, 200, {
      editor_url: editorUrl,
      expires_in: "7 days",
    });
  } catch (err) {
    console.error("v2-editor-url error:", err);
    return json(event, 500, { error: err.message || "Server error" });
  }
};
