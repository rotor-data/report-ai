import { createPublicKey, verify as verifySig } from "node:crypto";

export function readBearerToken(event) {
  const auth = event.headers?.authorization ?? event.headers?.Authorization ?? "";
  return auth.replace(/^Bearer\s+/i, "").trim() || null;
}

export function verifyHubJwt(token, { publicPem, issuer, audience }) {
  try {
    const [h, p, s] = (token ?? "").split(".");
    if (!h || !p || !s) return { ok: false, error: "Malformed JWT" };

    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));

    if (header.alg !== "RS256") return { ok: false, error: "Unsupported alg" };

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now) return { ok: false, error: "Token expired" };
    if (payload.iss !== issuer) return { ok: false, error: "Invalid issuer" };

    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(audience) : payload.aud === audience;
    if (!audOk) return { ok: false, error: "Invalid audience" };

    const key = createPublicKey(publicPem);
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, "base64url");
    const valid = verifySig("RSA-SHA256", data, key, sig);
    if (!valid) return { ok: false, error: "Signature invalid" };

    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error?.message ?? "JWT verify failed" };
  }
}
