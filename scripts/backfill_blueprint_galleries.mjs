#!/usr/bin/env node
/**
 * Backfill report_blueprints.gallery_url for any rows where it's NULL.
 *
 * Posts to the LIVE report-ai save-blueprint-gallery hot path indirectly:
 * we re-trigger the same render flow used by the runtime save handler by
 * issuing a one-shot HTTP call to the on-site `/api/v2-blueprint-gallery-backfill`
 * endpoint per row. To keep this script self-contained (no new endpoint
 * required), it instead writes nothing and just prints a list of row IDs
 * that need refresh.
 *
 * Usage:
 *   node scripts/backfill_blueprint_galleries.mjs                # dry run, list ids
 *   node scripts/backfill_blueprint_galleries.mjs --apply        # actually call render
 *   node scripts/backfill_blueprint_galleries.mjs --id <uuid>    # single row
 *
 * --apply path: imports the same renderBlueprintGallery code path used by
 * mcp-v2.js. To do that we need a deployed report-ai site URL and a smyra-
 * render JWT secret. We re-use NEON_DATABASE_URL + the env vars the live
 * function relies on (URL, JWT_SECRET, RENDER_SERVICE_URL, etc.) — they
 * are already in .env locally.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

try {
  const env = readFileSync(resolve('.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const dbUrl = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('NEON_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const idIdx = args.indexOf('--id');
const onlyId = idIdx >= 0 ? args[idIdx + 1] : null;

const pool = new Pool({ connectionString: dbUrl });

async function fetchBrandContext(client, brandId) {
  if (!brandId) return { tokens: {}, fonts: [], logos: [] };
  const tokens = (await client.query('SELECT tokens FROM brands WHERE id=$1', [brandId])).rows[0]?.tokens || {};
  const fonts  = (await client.query('SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id=$1', [brandId])).rows;
  const logos  = (await client.query('SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id=$1', [brandId])).rows;
  return { tokens, fonts, logos };
}

function b64url(x) {
  return Buffer.from(x).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Mirrors netlify/functions/smyra-render-jwt.js exactly so the same secret
// works in both places without surprises.
function mintToken(tenantId) {
  const secret = process.env.SMYRA_RENDER_JWT_SECRET;
  if (!secret) throw new Error('SMYRA_RENDER_JWT_SECRET required to mint render-service tokens');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: tenantId, tenant_id: tenantId, iat: now, exp: now + 120, iss: 'report-ai' };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

async function renderGrid({ samples, design_system_css, brand, tenantId }) {
  const renderUrl = process.env.RENDER_SERVICE_URL;
  if (!renderUrl) throw new Error('RENDER_SERVICE_URL required');
  const pages = samples.slice(0, 4).map((s, i) => ({
    page_num: i + 1,
    html: typeof s === 'string' ? s : (s?.html ?? ''),
  })).filter((p) => p.html.length > 0);
  if (pages.length === 0) throw new Error('no usable samples');
  const token = mintToken(tenantId);
  const res = await fetch(`${renderUrl}/render/sample-grid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      pages,
      design_system_css,
      brand_tokens: brand.tokens,
      brand_fonts: brand.fonts,
      brand_logos: brand.logos,
      keep_placeholders: true,
    }),
  });
  if (!res.ok) throw new Error(`render returned ${res.status}: ${await res.text()}`);
  return res.json();
}

async function uploadAndPersist(client, blueprintId, pngBase64) {
  // Re-use the in-process @netlify/blobs binding requires SITE_ID + token.
  // Easier to call the existing /api/v2-asset upload-via-PUT path? We don't
  // have one — the production runtime writes directly via getStore. For
  // the backfill, set the blob via the same SDK.
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) throw new Error('NETLIFY_SITE_ID + NETLIFY_API_TOKEN required to write blobs from outside Netlify');
  const store = getStore({ name: 'report-ai-assets', siteID, token });
  const blobKey = `blueprint-galleries/${blueprintId}.png`;
  await store.set(blobKey, Buffer.from(pngBase64, 'base64'), { contentType: 'image/png' });
  const siteUrl = process.env.URL || 'https://rotor-report-ai.netlify.app';
  const url = `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`;
  await client.query(
    `UPDATE report_blueprints SET gallery_url=$1, gallery_generated_at=NOW() WHERE id=$2`,
    [url, blueprintId],
  );
  return url;
}

const client = await pool.connect();
try {
  let rows;
  if (onlyId) {
    rows = (await client.query(
      `SELECT id, brand_id, owner_tenant_id, design_system_css, sample_pages_html, name
         FROM report_blueprints
        WHERE id=$1 AND design_system_css IS NOT NULL`,
      [onlyId],
    )).rows;
  } else {
    rows = (await client.query(
      `SELECT id, brand_id, owner_tenant_id, design_system_css, sample_pages_html, name
         FROM report_blueprints
        WHERE gallery_url IS NULL AND design_system_css IS NOT NULL
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 100`,
    )).rows;
  }

  console.log(`Found ${rows.length} blueprint(s) needing gallery`);

  for (const r of rows) {
    const samples = typeof r.sample_pages_html === 'string'
      ? JSON.parse(r.sample_pages_html)
      : (r.sample_pages_html || []);
    console.log(`- ${r.id} ${r.name} (${samples.length} samples)`);
    if (!apply) continue;

    try {
      // Resolve tenant for JWT.
      let tenantId = r.owner_tenant_id;
      if (!tenantId && r.brand_id) {
        tenantId = (await client.query('SELECT tenant_id FROM brands WHERE id=$1', [r.brand_id])).rows[0]?.tenant_id;
      }
      if (!tenantId) tenantId = 'smyra-platform';

      const brand = await fetchBrandContext(client, r.brand_id);
      const grid = await renderGrid({
        samples,
        design_system_css: r.design_system_css,
        brand,
        tenantId,
      });
      const url = await uploadAndPersist(client, r.id, grid.png_base64);
      console.log(`  -> ${url} (${grid.page_count} pages, ${grid.width}x${grid.height})`);
    } catch (err) {
      console.error(`  !! ${r.id} failed: ${err.message}`);
    }
  }
} finally {
  client.release();
  await pool.end();
}
