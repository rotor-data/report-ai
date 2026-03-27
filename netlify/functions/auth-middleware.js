import { verifyHubJwt } from "./verify-hub-jwt.js";

export function requireHubAuth(event) {
  const token = (event.headers?.authorization ?? event.headers?.Authorization ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) return { ok: false, status: 401, error: "Unauthorized" };

  const jwt = verifyHubJwt(token, {
    publicPem: process.env.HUB_JWT_PUBLIC_KEY_PEM,
    issuer: process.env.HUB_JWT_ISSUER ?? "hub.rotor-platform.com",
    audience: "report-ai",
  });

  if (!jwt.ok) return { ok: false, status: 401, error: jwt.error };

  const hubUserId = jwt.payload.sub ?? jwt.payload.hub_user_id;
  if (!hubUserId) return { ok: false, status: 401, error: "Missing subject" };

  return { ok: true, hubUserId, payload: jwt.payload };
}
