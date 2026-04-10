/**
 * GET /api/editor-session?token=<editor_token>
 *
 * Verifies an HMAC editor token issued by `report2__get_editor_url`
 * (mcp-v2.js → createEditorToken) and returns the scoped report
 * context needed to boot the React editor.
 *
 * Response shape:
 *   {
 *     hub_user_id, report_id, expires_at,
 *     report: { id, title, status, document_type, tenant_id, brand_id, ... },
 *     brand: { id, name, tokens }
 *   }
 *
 * This endpoint is the ONLY way the browser learns which report the
 * token is good for — everything else (module CRUD, render, assets)
 * goes through the existing v2-* REST endpoints using the token as
 * an `X-Editor-Token` header, verified by auth-middleware.
 */
import { json, noContent } from "./cors.js";
import { verifyEditorToken } from "./editor-token.js";
import { getSql } from "./db.js";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "GET") {
    return json(event, 405, { error: "Method not allowed" });
  }

  const token =
    event.queryStringParameters?.token ||
    (event.headers?.["x-editor-token"] ?? event.headers?.["X-Editor-Token"]);

  if (!token) return json(event, 400, { error: "Missing token" });

  const verify = verifyEditorToken(token);
  if (!verify.ok) return json(event, 401, { error: verify.error });

  const { hubUserId, reportId, expiresAt } = verify;
  const sql = getSql();

  try {
    const [report] = await sql`
      SELECT id, title, status, document_type, template_id,
             tenant_id, brand_id, created_at, updated_at
      FROM v2_reports
      WHERE id = ${reportId}
      LIMIT 1
    `;

    if (!report) return json(event, 404, { error: "Report not found" });

    const [brand] = await sql`
      SELECT id, name, tokens
      FROM brands
      WHERE id = ${report.brand_id}
      LIMIT 1
    `;

    return json(event, 200, {
      hub_user_id: hubUserId,
      report_id: reportId,
      expires_at: expiresAt,
      report,
      brand: brand ?? null,
    });
  } catch (err) {
    console.error("editor-session error:", err);
    return json(event, 500, { error: err.message || "Server error" });
  }
};
