import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  return json(event, 200, {
    ok: true,
    provisioned: true,
    module_tenant_ref: `report_ai_${auth.hubUserId}`,
    connect_required: false,
  });
};
