#!/usr/bin/env node
/**
 * Layer 2 — JWT mint + verify round-trip.
 *
 * Mints a Hub-style RS256 JWT with aud='report-ai-v2' using
 * HUB_JWT_PRIVATE_KEY_PEM, then calls the mcp-v2 handler locally and
 * asserts the auth path accepts it (i.e. returns a non-401 for
 * tools/list).
 *
 * Also verifies a NEGATIVE case: a JWT signed with the same key but
 * aud='wrong-audience' is rejected with 401. Catches audience-validation
 * regressions.
 *
 * Skips with warning if HUB_JWT_PRIVATE_KEY_PEM is unset.
 */
import { randomUUID, createSign, createPrivateKey, createPublicKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function normalizePem(raw) {
  if (!raw) return raw;
  let s = raw.replace(/\\n/g, '\n');
  if (/-----\n[A-Za-z0-9+/]/.test(s)) return s.trim();
  const hM = s.match(/(-----BEGIN [A-Z ]+-----)/);
  const fM = s.match(/(-----END [A-Z ]+-----)/);
  if (!hM || !fM) return s.trim();
  const h = hM[1], f = fM[1];
  const bs = s.indexOf(h) + h.length, be = s.indexOf(f);
  const b = s.slice(bs, be).replace(/\s+/g, '');
  const lines = b.match(/.{1,64}/g) || [];
  return [h, ...lines, f].join('\n');
}

function mintJwt({ privatePem, aud, sub, tenantId, ttlSec = 300 }) {
  const key = createPrivateKey(privatePem);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.HUB_JWT_ISSUER || 'hub.rotor-platform.com',
    aud, sub, iat: now, exp: now + ttlSec, tenant_id: tenantId,
  };
  const eh = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const ep = base64url(JSON.stringify(payload));
  const signInput = `${eh}.${ep}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signInput);
  return `${signInput}.${base64url(signer.sign(key))}`;
}

const privatePemRaw = (process.env.TEST_JWT_PRIVATE_KEY_PEM ?? process.env.HUB_JWT_PRIVATE_KEY_PEM);
if (!privatePemRaw) {
  console.warn('[jwt-verify] HUB_JWT_PRIVATE_KEY_PEM not set — skipping (CI-only check).');
  process.exit(0);
}
const privatePem = normalizePem(privatePemRaw);

// Derive + inject public PEM
if (!process.env.HUB_JWT_PUBLIC_KEY_PEM) {
  try {
    process.env.HUB_JWT_PUBLIC_KEY_PEM = createPublicKey(privatePem).export({ format: 'pem', type: 'spki' });
  } catch (err) {
    console.error('[jwt-verify] failed to derive public PEM:', err.message);
    process.exit(1);
  }
}

const mod = await import('file://' + join(repoRoot, 'netlify/functions/mcp-v2.js'));
const handler = mod.handler;

function makeEvent(token, body) {
  return {
    httpMethod: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const goodToken = mintJwt({ privatePem, aud: 'report-ai-v2', sub: randomUUID(), tenantId: randomUUID() });
const badAudToken = mintJwt({ privatePem, aud: 'evil-other-module', sub: randomUUID(), tenantId: randomUUID() });

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

console.log('[jwt-verify] valid aud=report-ai-v2 token');
const goodResp = await handler(makeEvent(goodToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
check('valid token → 200', goodResp.statusCode === 200, `got ${goodResp.statusCode}: ${(goodResp.body || '').slice(0, 200)}`);

console.log('[jwt-verify] invalid aud token');
const badResp = await handler(makeEvent(badAudToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
check('wrong-aud token → 401', badResp.statusCode === 401, `got ${badResp.statusCode}: ${(badResp.body || '').slice(0, 200)}`);

console.log('[jwt-verify] missing token');
const noResp = await handler({ httpMethod: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
check('no auth header → 401', noResp.statusCode === 401, `got ${noResp.statusCode}`);

if (failures > 0) {
  console.error(`[jwt-verify] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('[jwt-verify] OK');
