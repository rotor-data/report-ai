#!/usr/bin/env node
/**
 * E2E MCP test: Hub JWT → mcp-v2 JSON-RPC → report2__create + add_module + render_pdf.
 *
 * Exercises the SAME path the Hub Gateway's ReportV2ApiAdapter takes:
 *   POST https://rotor-report-ai.netlify.app/.netlify/functions/mcp-v2
 *   { jsonrpc, method: "tools/call", params: { name: "report2__<tool>", arguments } }
 *
 * 1. Seed a brand in Neon (report-ai DB) — mcp-v2 create expects brand_id.
 * 2. Mint Hub RS256 JWT with aud=report-ai.
 * 3. Call report2__create → report_id
 * 4. Call report2__add_module (layout with text slot)
 * 5. Call report2__build_pages
 * 6. Call report2__render_pdf { mode: "draft" } → pdf_url
 * 7. Download and verify %PDF magic.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { randomUUID, createSign, createPrivateKey } from 'node:crypto';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

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

function mintHubJwt({ aud, sub, claims, ttlSec = 300 }) {
  const pem = normalizePem(process.env.HUB_JWT_PRIVATE_KEY_PEM);
  if (!pem) throw new Error('HUB_JWT_PRIVATE_KEY_PEM missing');
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    ...(claims || {}),
    iss: process.env.HUB_JWT_ISSUER || 'hub.rotor-platform.com',
    aud, sub, iat: now, exp: now + ttlSec,
  };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signInput = `${encHeader}.${encPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signInput);
  const sig = signer.sign(key);
  return `${signInput}.${base64url(sig)}`;
}

const REPORT_AI_DB_URL = process.argv[2] ||
  'postgresql://neondb_owner:npg_X6yR4QdIOEro@ep-autumn-surf-als85l95-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const MCP_URL = process.env.MCP_V2_URL ||
  'https://rotor-report-ai.netlify.app/.netlify/functions/mcp-v2';

async function mcpCall(name, args, token) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: `report2__${name}`, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 400)}`);
  const rpc = JSON.parse(text);
  if (rpc.error) throw new Error(`${name} rpc error: ${rpc.error.message}`);
  const content = rpc.result?.content?.[0];
  if (content?.type === 'text' && content.text) {
    try { return JSON.parse(content.text); } catch { return { text: content.text }; }
  }
  return rpc.result ?? {};
}

async function main() {
  console.log('=== E2E MCP v2 smoke test ===');
  console.log('mcp-v2 URL:', MCP_URL);

  const pool = new Pool({ connectionString: REPORT_AI_DB_URL });
  const tenantId = randomUUID();
  const brandId = randomUUID();

  console.log('\n[1/6] Seeding brand...');
  console.log('  tenant_id:', tenantId);
  console.log('  brand_id: ', brandId);
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO brands (id, tenant_id, name, tokens) VALUES ($1, $2, $3, $4::jsonb)`,
      [brandId, tenantId, 'E2E MCP Brand', JSON.stringify({
        primary_color: '#0f766e',
        accent_color: '#f97316',
        font_body: 'sans-serif',
        font_heading: 'sans-serif',
      })],
    );
  } finally {
    client.release();
  }
  await pool.end();
  console.log('  ✓ Seeded');

  console.log('\n[2/6] Minting Hub JWT...');
  const token = mintHubJwt({
    aud: 'report-ai',
    sub: `e2e-mcp:${tenantId}`,
    claims: { hub_user_id: `e2e-mcp:${tenantId}`, tenant_id: tenantId },
  });
  console.log('  ✓ Token');

  console.log('\n[3/6] report2__create...');
  const createRes = await mcpCall('create', {
    tenant_id: tenantId,
    brand_id: brandId,
    title: 'E2E MCP v2 Test Report',
    document_type: 'report',
  }, token);
  const reportId = createRes.report_id;
  console.log('  ✓ report_id:', reportId);

  console.log('\n[4/6] report2__add_module (layout)...');
  const addRes = await mcpCall('add_module', {
    report_id: reportId,
    module_type: 'layout',
    content: {
      columns: 'full',
      slots: [{
        category: 'text',
        content: {
          heading: 'MCP v2 End-to-End',
          body: 'Rapporten skapades via Hub MCP JSON-RPC, renderades i Cloud Run (WeasyPrint) och levererades som PDF via Netlify Blobs. Med å, ä, ö.',
        },
      }],
    },
  }, token);
  console.log('  ✓ module_id:', addRes.module_id, 'height_mm:', addRes.height_mm);

  console.log('\n[5/6] report2__build_pages...');
  const buildRes = await mcpCall('build_pages', { report_id: reportId }, token);
  console.log('  ✓', JSON.stringify(buildRes).slice(0, 200));

  console.log('\n[6/6] report2__render_pdf (draft)...');
  const renderRes = await mcpCall('render_pdf', { report_id: reportId, mode: 'draft' }, token);
  console.log('  ✓ pdf_url:', renderRes.pdf_url);
  console.log('    page_count:', renderRes.page_count, 'size_bytes:', renderRes.size_bytes);

  console.log('\n[+] Downloading PDF...');
  const pdfRes = await fetch(renderRes.pdf_url);
  if (!pdfRes.ok) throw new Error(`PDF fetch HTTP ${pdfRes.status}`);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  const magic = pdfBuf.slice(0, 8).toString('ascii');
  console.log('  bytes:', pdfBuf.length, 'magic:', magic);
  if (!magic.startsWith('%PDF')) throw new Error('Not a valid PDF');
  console.log('\n=== E2E MCP v2 TEST PASSED ===');
}

main().catch((err) => {
  console.error('E2E MCP failed:', err);
  process.exit(1);
});
