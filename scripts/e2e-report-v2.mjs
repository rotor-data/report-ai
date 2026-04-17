#!/usr/bin/env node
/**
 * E2E smoke test: Hub JWT → report-ai /api/v2-render → Cloud Run → Blob.
 *
 * 1. Seed a minimal brand + report + page + layout module directly in Neon
 *    (report-ai DB).
 * 2. Mint a Hub RS256 JWT with aud=report-ai.
 * 3. Call POST https://report-ai.netlify.app/api/v2-render
 * 4. Download the returned pdf_url and verify %PDF magic.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { randomUUID, createSign, createPrivateKey } from 'node:crypto';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

// ─── Inline RS256 JWT minter (no jose dep) ─────────────────────────────────

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
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

function mintHubJwt({ aud, sub, claims, ttlSec = 300 }) {
  const pem = normalizePem(process.env.HUB_JWT_PRIVATE_KEY_PEM);
  if (!pem) throw new Error('HUB_JWT_PRIVATE_KEY_PEM missing');
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    ...(claims || {}),
    iss: process.env.HUB_JWT_ISSUER || 'hub.rotor-platform.com',
    aud,
    sub,
    iat: now,
    exp: now + ttlSec,
  };
  const encHeader  = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signInput  = `${encHeader}.${encPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signInput);
  const sig = signer.sign(key);
  return `${signInput}.${base64url(sig)}`;
}

// Minimal .env loader
function loadEnv(path) {
  try {
    const env = readFileSync(path, 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) {
        let v = m[2];
        // Strip single-pair surrounding quotes (but keep escapes intact)
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  } catch {}
}
loadEnv(new URL('../.env', import.meta.url).pathname);

const REPORT_AI_DB_URL =
  process.argv[2] ||
  'postgresql://neondb_owner:npg_X6yR4QdIOEro@ep-autumn-surf-als85l95-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const REPORT_AI_URL = process.env.REPORT_AI_URL || 'https://rotor-report-ai.netlify.app';

async function main() {
  console.log('=== E2E Report v2 smoke test ===');
  console.log('report-ai URL:', REPORT_AI_URL);

  // 1. Seed DB
  const pool = new Pool({ connectionString: REPORT_AI_DB_URL });
  const tenantId = randomUUID();
  const brandId  = randomUUID();
  const reportId = randomUUID();
  const pageId   = randomUUID();
  const moduleId = randomUUID();

  console.log('\n[1/4] Seeding test data...');
  console.log('  tenant_id:', tenantId);
  console.log('  report_id:', reportId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO brands (id, tenant_id, name, tokens)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [brandId, tenantId, 'E2E Test Brand', JSON.stringify({
        primary_color: '#007e84',
        accent_color:  '#e070be',
        font_body:     'sans-serif',
        font_heading:  'sans-serif',
      })],
    );

    await client.query(
      `INSERT INTO v2_reports (id, tenant_id, brand_id, title, status, document_type)
       VALUES ($1, $2, $3, $4, 'draft', 'report')`,
      [reportId, tenantId, brandId, 'Smyra Cloud Run E2E Test'],
    );

    await client.query(
      `INSERT INTO v2_report_pages (id, report_id, page_number, page_type)
       VALUES ($1, $2, 1, 'content')`,
      [pageId, reportId],
    );

    await client.query(
      `INSERT INTO v2_report_modules (id, report_id, page_id, module_type, order_index, content, style)
       VALUES ($1, $2, $3, 'layout', 0, $4::jsonb, '{}'::jsonb)`,
      [moduleId, reportId, pageId, JSON.stringify({
        columns: 'full',
        slots: [{
          category: 'text',
          content: {
            heading: 'Smyra Report Engine v2',
            body: 'Första E2E-PDF genererad genom hela kedjan: Netlify → Google Cloud Run → Neon → Netlify Blobs. Med å, ä, ö för encoding-verifiering.',
          },
        }],
      })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log('  ✓ Seeded');

  // 2. Mint Hub JWT
  console.log('\n[2/4] Minting Hub JWT (aud=report-ai)...');
  const token = mintHubJwt({
    aud: 'report-ai',
    sub: `e2e-test:${tenantId}`,
    claims: { hub_user_id: `e2e-test:${tenantId}`, tenant_id: tenantId },
  });
  console.log('  ✓ Token:', token.slice(0, 40) + '...');

  // 3. Call /api/v2-render
  console.log('\n[3/4] POST /api/v2-render { report_id, mode: draft }...');
  const res = await fetch(`${REPORT_AI_URL}/api/v2-render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ report_id: reportId, mode: 'draft' }),
  });
  console.log('  Status:', res.status);
  const text = await res.text();
  if (!res.ok) {
    console.error('  ✗ Body:', text.slice(0, 800));
    process.exit(1);
  }
  const data = JSON.parse(text);
  console.log('  pdf_url:', data.pdf_url);
  console.log('  page_count:', data.page_count);
  console.log('  size_bytes:', data.size_bytes);

  // 4. Download and verify
  console.log('\n[4/4] Downloading PDF...');
  const pdfRes = await fetch(data.pdf_url);
  if (!pdfRes.ok) {
    console.error('  ✗ PDF fetch failed:', pdfRes.status);
    process.exit(1);
  }
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  const magic = pdfBuf.slice(0, 8).toString('ascii');
  console.log('  bytes:', pdfBuf.length);
  console.log('  magic:', magic);
  if (!magic.startsWith('%PDF')) {
    console.error('  ✗ Not a valid PDF');
    process.exit(1);
  }
  console.log('  ✓ Valid PDF');
  console.log('\n=== E2E TEST PASSED ===');
  await pool.end();
}

main().catch((err) => {
  console.error('E2E failed:', err);
  process.exit(1);
});
