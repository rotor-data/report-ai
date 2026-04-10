/**
 * Mint an HS256 JWT for the smyra-render service using Node's built-in crypto.
 * No external deps — avoids pulling jsonwebtoken/jose just for one tiny helper.
 *
 * Usage:
 *   const token = mintSmyraRenderToken({ tenantId: 'abc', ttlSec: 120 });
 *   fetch(url, { headers: { Authorization: `Bearer ${token}` } });
 */
import { createHmac } from "node:crypto";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function mintSmyraRenderToken({ tenantId, ttlSec = 120, extraClaims = {} } = {}) {
  const secret = process.env.SMYRA_RENDER_JWT_SECRET;
  if (!secret) {
    throw new Error("SMYRA_RENDER_JWT_SECRET is not configured");
  }
  if (!tenantId) {
    throw new Error("mintSmyraRenderToken requires a tenantId");
  }

  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: "HS256", typ: "JWT" };
  // Deliberately omit `aud`: smyra-render's jwt.decode() is called without
  // an `audience` param, so any aud claim trips PyJWT's MissingRequiredClaim
  // check. Adding aud back requires also passing audience= in app.py.
  const payload = {
    sub: tenantId,
    tenant_id: tenantId,
    iat: now,
    exp: now + ttlSec,
    iss: "report-ai",
    ...extraClaims,
  };

  const encHeader  = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signInput  = `${encHeader}.${encPayload}`;

  const sig = createHmac("sha256", secret).update(signInput).digest();
  const encSig = sig
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signInput}.${encSig}`;
}
