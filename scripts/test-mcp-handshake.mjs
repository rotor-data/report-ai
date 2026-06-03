#!/usr/bin/env node
/**
 * Layer 2 — MCP handshake.
 *
 * Loads the bundled (or source) mcp-v2 Netlify handler in-process and
 * invokes the tools/list method via a synthetic Lambda event. Asserts
 * the response has the expected shape: 50+ tools, every tool has
 * {name, description, inputSchema}.
 *
 * Auth strategy:
 *   - If HUB_JWT_PRIVATE_KEY_PEM is set, mint a real RS256 JWT and call
 *     through the production verifier. This requires HUB_JWT_PUBLIC_KEY_PEM
 *     to be set (or derivable from the private key — handler currently
 *     requires the public PEM as an env var).
 *   - If env is unset, attempt to derive a public key from the private
 *     key and inject it into process.env before loading the handler.
 *   - If no PEM is available at all, skip with a clear warning. Layer 1
 *     bundle-smoke already verifies the handler loads cleanly; this test
 *     is specifically about the auth-passing tools/list response shape.
 */
import { randomUUID, createSign, createPrivateKey, createPublicKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function normalizePem(raw) {
  if (!raw) return raw;
  let s = raw.replace(/\\n/g, '\n');
  if (/-----\n[A-Za-z0-9+/]/.test(s)) return s.trim();
  const headerMatch = s.match(/(-----BEGIN [A-Z ]+-----)/);
  const footerMatch = s.match(/(-----END [A-Z ]+-----)/);
  if (!headerMatch || !footerMatch) return s.trim();
  const header = headerMatch[1];
  const footer = footerMatch[1];
  const bodyStart = s.indexOf(header) + header.length;
  const bodyEnd = s.indexOf(footer);
  const base64 = s.slice(bodyStart, bodyEnd).replace(/\s+/g, '');
  const lines = base64.match(/.{1,64}/g) || [];
  return [header, ...lines, footer].join('\n');
}

function mintJwt({ privatePem, aud, sub, tenantId, ttlSec = 300 }) {
  const key = createPrivateKey(privatePem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: process.env.HUB_JWT_ISSUER || 'hub.rotor-platform.com',
    aud, sub, iat: now, exp: now + ttlSec, tenant_id: tenantId,
  };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signInput = `${encHeader}.${encPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signInput);
  return `${signInput}.${base64url(signer.sign(key))}`;
}

const privatePemRaw = (process.env.TEST_JWT_PRIVATE_KEY_PEM ?? process.env.HUB_JWT_PRIVATE_KEY_PEM);
if (!privatePemRaw) {
  console.warn('[handshake] HUB_JWT_PRIVATE_KEY_PEM not set — skipping handshake test (CI-only check).');
  console.warn('[handshake] Layer 1 bundle-smoke verifies the handler loads; this test is a noop without auth.');
  process.exit(0);
}

const privatePem = normalizePem(privatePemRaw);

// Normalise HUB_JWT_ISSUER — GH Actions secrets that are unset evaluate
// to empty string in the workflow env. JS `??` keeps the empty string
// (server-side mcp-v2.js uses ??), JS `||` falls back to default (this
// script's mint uses ||). Mismatch → "Invalid issuer". Set the env var
// to the resolved value BEFORE the handler module loads its constants.
if (!process.env.HUB_JWT_ISSUER) {
  process.env.HUB_JWT_ISSUER = 'hub.rotor-platform.com';
}

// Derive public PEM if not set — handler requires HUB_JWT_PUBLIC_KEY_PEM
if (!process.env.HUB_JWT_PUBLIC_KEY_PEM) {
  try {
    const pub = createPublicKey(privatePem).export({ format: 'pem', type: 'spki' });
    process.env.HUB_JWT_PUBLIC_KEY_PEM = pub;
    console.log('[handshake] derived public PEM from private key');
  } catch (err) {
    console.error('[handshake] failed to derive public PEM:', err.message);
    process.exit(1);
  }
}

// Load handler from source (ESM). Layer 1 bundle-smoke covers the bundled
// path; here we exercise the JSON-RPC dispatcher, not the bundling.
const handlerPath = join(repoRoot, 'netlify/functions/mcp-v2.js');
if (!existsSync(handlerPath)) {
  console.error('[handshake] mcp-v2.js not found at', handlerPath);
  process.exit(1);
}

const mod = await import('file://' + handlerPath);
const handler = mod.handler;
if (typeof handler !== 'function') {
  console.error('[handshake] mcp-v2 exports no handler function');
  process.exit(1);
}

const token = mintJwt({
  privatePem,
  aud: 'report-ai-v2',
  sub: randomUUID(),
  tenantId: randomUUID(),
});

function makeEvent(rpcBody) {
  return {
    httpMethod: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(rpcBody),
  };
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

console.log('[handshake] POST initialize');
const initResp = await handler(makeEvent({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
const initBody = JSON.parse(initResp.body);
check('initialize returns 200', initResp.statusCode === 200, `got ${initResp.statusCode}`);
check('initialize has serverInfo', initBody?.result?.serverInfo?.name, JSON.stringify(initBody).slice(0, 200));
check('initialize has protocolVersion', typeof initBody?.result?.protocolVersion === 'string');

console.log('[handshake] POST tools/list');
const listResp = await handler(makeEvent({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
const listBody = JSON.parse(listResp.body);
check('tools/list returns 200', listResp.statusCode === 200, `got ${listResp.statusCode}`);
const tools = listBody?.result?.tools;
check('tools/list returns array', Array.isArray(tools), `type=${typeof tools}`);
if (Array.isArray(tools)) {
  check(`tools/list has ≥50 tools`, tools.length >= 50, `got ${tools.length}`);
  let missingName = 0, missingDesc = 0, missingSchema = 0, dupNames = 0;
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !t.name) missingName++;
    else if (seen.has(t.name)) dupNames++;
    else seen.add(t.name);
    if (!t?.description || typeof t.description !== 'string') missingDesc++;
    if (!t?.inputSchema || typeof t.inputSchema !== 'object') missingSchema++;
  }
  check('every tool has name', missingName === 0, `${missingName} missing`);
  check('every tool has description', missingDesc === 0, `${missingDesc} missing`);
  check('every tool has inputSchema', missingSchema === 0, `${missingSchema} missing`);
  check('no duplicate tool names', dupNames === 0, `${dupNames} duplicates`);
  console.log(`[handshake] tools list: ${tools.length} tools`);
}

if (failures > 0) {
  console.error(`[handshake] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('[handshake] OK');
