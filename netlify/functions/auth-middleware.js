import { verifyHubJwt } from "./verify-hub-jwt.js";
import { verifyEditorToken } from "./editor-token.js";

export function requireHubAuth(event) {
  const token = (event.headers?.authorization ?? event.headers?.Authorization ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) return { ok: false, status: 401, error: "Unauthorized" };

  const jwt = verifyHubJwt(token, {
    publicPem: process.env.HUB_JWT_PUBLIC_KEY_PEM,
    issuer: process.env.HUB_JWT_ISSUER ?? "hub.rotor-platform.com",
    audience: process.env.MODULE_AUDIENCE ?? "report-ai",
  });

  if (!jwt.ok) return { ok: false, status: 401, error: jwt.error };

  const hubUserId = jwt.payload.sub ?? jwt.payload.hub_user_id;
  if (!hubUserId) return { ok: false, status: 401, error: "Missing subject" };

  return { ok: true, hubUserId, payload: jwt.payload };
}

/**
 * Accept either a Hub JWT (Authorization: Bearer ...) OR an editor HMAC
 * capability token (X-Editor-Token header). The editor token is scoped
 * to a single report; callers should enforce `editorScope.reportId`
 * matches the report being operated on.
 *
 * Returns:
 *   { ok: true, hubUserId, editorScope?: { reportId } }
 *   { ok: false, status, error }
 */
export function requireHubOrEditorAuth(event) {
  const editorToken =
    event.headers?.["x-editor-token"] ??
    event.headers?.["X-Editor-Token"] ??
    null;

  if (editorToken) {
    const v = verifyEditorToken(editorToken);
    if (!v.ok) return { ok: false, status: 401, error: v.error };
    return {
      ok: true,
      hubUserId: v.hubUserId,
      editorScope: { reportId: v.reportId },
    };
  }

  return requireHubAuth(event);
}

/**
 * Helper: returns true if the given auth result is scoped to a single
 * report id that does NOT match the one being accessed. Use this in
 * endpoints that accept both auth types.
 */
export function editorScopeMismatch(auth, reportId) {
  return !!(auth?.editorScope && reportId && auth.editorScope.reportId !== reportId);
}
