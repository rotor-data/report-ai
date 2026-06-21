/**
 * Shared HMAC editor token (capability token) helpers.
 *
 * Format (base64url encoded):
 *   `${hubUserId}:${reportId}:${expiresMs}:${sig}`
 *
 * `sig` is the full hex HMAC-SHA256(payload, secret), where
 * payload is `${hubUserId}:${reportId}:${expiresMs}`.
 *
 * Used by mcp-v2.js (`report2__get_editor_url`), editor-session.js
 * (token verification for the React editor) and the v2-* REST endpoints
 * (when accessed via the editor instead of via the Hub).
 *
 * SECURITY NOTE: the signature is the FULL hex digest (was truncated to the
 * first 16 hex chars / 64 bits). This format change invalidates any editor
 * tokens minted under the old truncated scheme — acceptable given the short
 * TTL. Mint (createEditorToken) and verify (verifyEditorToken) must always use
 * the same full-length scheme; change both together.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function editorSecret() {
  // SECURITY (P0.4): fail CLOSED — no constant `"report-ai-editor"` fallback.
  // With the literal default, anyone could forge a capability token and take
  // over any report's editor. If neither env var is set, refuse to sign/verify.
  // (report-ai prod has HUB_JWT_PUBLIC_KEY_PEM set, so this path stays working.)
  const secret = process.env.PREVIEW_SECRET || process.env.HUB_JWT_PUBLIC_KEY_PEM;
  if (!secret) {
    throw new Error(
      "Editor token secret unavailable: set PREVIEW_SECRET or HUB_JWT_PUBLIC_KEY_PEM.",
    );
  }
  return secret;
}

export function createEditorToken(hubUserId, reportId, ttlMs = TOKEN_TTL_MS) {
  const expires = Date.now() + ttlMs;
  const payload = `${hubUserId}:${reportId}:${expires}`;
  const sig = createHmac("sha256", editorSecret())
    .update(payload)
    .digest("hex");
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
    .digest("hex");

  // Constant-time compare (length-guard first; timingSafeEqual throws on
  // mismatched lengths).
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, error: "Token signature mismatch" };
  }

  return { ok: true, hubUserId, reportId, expiresAt: expires };
}
