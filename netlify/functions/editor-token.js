/**
 * Shared HMAC editor token (capability token) helpers.
 *
 * Format (base64url encoded):
 *   `${hubUserId}:${reportId}:${expiresMs}:${sig}`
 *
 * `sig` is the first 16 hex chars of HMAC-SHA256(payload, secret), where
 * payload is `${hubUserId}:${reportId}:${expiresMs}`.
 *
 * Used by mcp-v2.js (`report2__get_editor_url`), editor-session.js
 * (token verification for the React editor) and the v2-* REST endpoints
 * (when accessed via the editor instead of via the Hub).
 */
import { createHmac } from "node:crypto";

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function editorSecret() {
  return (
    process.env.PREVIEW_SECRET ||
    process.env.HUB_JWT_PUBLIC_KEY_PEM ||
    "report-ai-editor"
  );
}

export function createEditorToken(hubUserId, reportId, ttlMs = TOKEN_TTL_MS) {
  const expires = Date.now() + ttlMs;
  const payload = `${hubUserId}:${reportId}:${expires}`;
  const sig = createHmac("sha256", editorSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

/**
 * Verify a base64url editor token.
 *
 * @returns {{ ok: true, hubUserId: string, reportId: string, expiresAt: number }
 *           | { ok: false, error: string }}
 */
export function verifyEditorToken(token) {
  if (!token || typeof token !== "string") {
    return { ok: false, error: "Missing token" };
  }

  let raw;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return { ok: false, error: "Token decode failed" };
  }

  const parts = raw.split(":");
  if (parts.length !== 4) {
    return { ok: false, error: "Token format invalid" };
  }

  const [hubUserId, reportId, expiresStr, sig] = parts;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires)) {
    return { ok: false, error: "Token expiry invalid" };
  }
  if (Date.now() > expires) {
    return { ok: false, error: "Token expired" };
  }

  const payload = `${hubUserId}:${reportId}:${expires}`;
  const expected = createHmac("sha256", editorSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 16);

  if (expected !== sig) {
    return { ok: false, error: "Token signature mismatch" };
  }

  return { ok: true, hubUserId, reportId, expiresAt: expires };
}
