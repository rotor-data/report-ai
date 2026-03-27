/**
 * POST /.netlify/functions/hub-provision
 *
 * Called by the Hub when a user subscribes to Report AI.
 * Idempotent — safe to call multiple times for the same user.
 * No external OAuth needed (unlike ai-cms), so connect_required = false.
 */
import { readBearerToken, verifyHubJwt } from "./verify-hub-jwt.js";
import { getSql } from "./db.js";

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const publicPem = process.env.HUB_JWT_PUBLIC_KEY_PEM;
  const issuer = process.env.HUB_JWT_ISSUER ?? "hub.rotor-platform.com";
  const audience = process.env.MODULE_AUDIENCE ?? "report-ai";
  if (!publicPem) return jsonResponse(500, { error: "HUB_JWT_PUBLIC_KEY_PEM not configured" });

  const token = readBearerToken(event);
  const auth = verifyHubJwt(token, { publicPem, issuer, audience });
  if (!auth.ok) return jsonResponse(401, { error: auth.error });

  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }

  const hubUserId = body.hub_user_id;
  if (!hubUserId) return jsonResponse(400, { error: "hub_user_id is required" });

  // Idempotent: check if user already has documents — if not, that's fine,
  // they'll create them via MCP tools. No additional setup needed.
  const sql = getSql();
  const existing = await sql`
    SELECT COUNT(*)::int AS doc_count
    FROM documents
    WHERE hub_user_id = ${hubUserId} AND deleted_at IS NULL
  `;

  const moduleTenantRef = `report_ai_${hubUserId}`;

  console.log("[hub-provision] provisioned", {
    hub_user_id: hubUserId,
    module_tenant_ref: moduleTenantRef,
    existing_docs: existing[0]?.doc_count ?? 0,
  });

  return jsonResponse(200, {
    ok: true,
    provisioned: true,
    module_tenant_ref: moduleTenantRef,
    connect_required: false,
  });
};
