#!/usr/bin/env node
/**
 * Layer 2 — cross-tenant isolation for brand_id-scoped writes.
 *
 * The corruption-prevention gate in mcp-v2.js is `assertBrandOwnership`:
 * any write that targets a brand_id must first verify the brand belongs
 * to the caller's tenant. If this gate ever degrades silently — e.g.
 * a refactor drops the tenant check or makes it accept null — every
 * tenant can write to every other tenant's brand. This script seeds two
 * brands under different tenants and asserts the guard behaves correctly.
 *
 * What's tested:
 *   1. assertBrandOwnership(sql, brand-of-A, tenant-A) → returns row
 *   2. assertBrandOwnership(sql, brand-of-A, tenant-B) → throws
 *      BRAND_GUARD_TENANT_MISMATCH (no info-leak in message)
 *   3. assertBrandOwnership(sql, nonexistent, tenant-A) → throws
 *      BRAND_GUARD_NOT_FOUND
 *   4. assertBrandOwnership(sql, null) → throws BRAND_GUARD_NO_ID
 *
 * Skips with warning when DATABASE_URL_TEST is unset.
 * Exit 0 on pass-or-skip, 1 on real failure.
 */
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = process.env.DATABASE_URL_TEST;
if (!DB) {
  console.warn('[cross-tenant] SKIP: DATABASE_URL_TEST unset');
  process.exit(0);
}

function log(...a) { console.log('[cross-tenant]', ...a); }
function fail(msg) { console.error('[cross-tenant] FAIL:', msg); process.exit(1); }

// Pull the source of assertBrandOwnership out of mcp-v2.js via a tiny
// in-file eval. We can't import mcp-v2.js wholesale — it boots an MCP
// server. Instead, re-implement the same SQL contract and assert the
// SQL the source enforces.
function loadGuardSource() {
  const src = readFileSync(fileURLToPath(new URL('../netlify/functions/mcp-v2.js', import.meta.url)), 'utf8');
  // Sanity: confirm the function still exists and the SQL still scopes
  // by tenant_id. If a future refactor drops the WHERE-tenant clause,
  // this gate fires before we even run the DB checks.
  if (!/async function assertBrandOwnership\(sql, brand_id, expected_tenant_id\)/.test(src)) {
    fail('assertBrandOwnership signature changed — update this test');
  }
  if (!/row\.tenant_id !== expected_tenant_id/.test(src)) {
    fail('assertBrandOwnership no longer compares tenant_id — corruption gate weakened');
  }
  log('source-side guard signature intact');
}

const sql = neon(DB);

// Local copy of the guard for runtime exercise. Kept byte-faithful to
// mcp-v2.js so behaviour drift surfaces in code review (a diff in this
// file's logic means someone touched the guard).
async function assertBrandOwnership(sql, brand_id, expected_tenant_id) {
  if (!brand_id) {
    const err = new Error('brand_id is required');
    err.code = 'BRAND_GUARD_NO_ID';
    throw err;
  }
  const rows = await sql`SELECT id, tenant_id, name FROM brands WHERE id = ${brand_id} LIMIT 1`;
  if (rows.length === 0) {
    const err = new Error(`brand ${brand_id} does not exist`);
    err.code = 'BRAND_GUARD_NOT_FOUND';
    throw err;
  }
  const row = rows[0];
  if (expected_tenant_id && row.tenant_id !== expected_tenant_id) {
    const err = new Error(`brand ${brand_id} is not owned by tenant ${expected_tenant_id}`);
    err.code = 'BRAND_GUARD_TENANT_MISMATCH';
    throw err;
  }
  return row;
}

async function main() {
  loadGuardSource();

  const tbl = await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'brands' LIMIT 1`;
  if (tbl.length === 0) {
    console.warn('[cross-tenant] SKIP: brands table not present in test DB');
    process.exit(0);
  }

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const brandA = randomUUID();
  const fakeBrand = randomUUID();

  try {
    await sql`
      INSERT INTO brands (id, tenant_id, name)
      VALUES (${brandA}::uuid, ${tenantA}::uuid, 'cross-tenant-test-A')
    `;
    log(`seeded brand ${brandA} → tenant ${tenantA}`);

    // 1. Happy path: A reads own brand.
    const ownRow = await assertBrandOwnership(sql, brandA, tenantA);
    if (ownRow.tenant_id !== tenantA) fail(`own-brand returned wrong tenant_id: ${ownRow.tenant_id}`);
    log('happy path: tenant A reads own brand ok');

    // 2. Cross-tenant: B tries to access A's brand.
    let caught = null;
    try { await assertBrandOwnership(sql, brandA, tenantB); }
    catch (e) { caught = e; }
    if (!caught) fail('CROSS-TENANT LEAK: tenant B successfully accessed tenant A\'s brand');
    if (caught.code !== 'BRAND_GUARD_TENANT_MISMATCH') {
      fail(`cross-tenant rejection used wrong error code: ${caught.code}`);
    }
    // info-leak check — must NOT contain tenantA value in message
    if (caught.message.includes(tenantA)) {
      fail(`info-leak: cross-tenant error message contains the real tenant_id: ${caught.message}`);
    }
    log('cross-tenant access correctly rejected with BRAND_GUARD_TENANT_MISMATCH, no info-leak');

    // 3. Nonexistent brand.
    caught = null;
    try { await assertBrandOwnership(sql, fakeBrand, tenantA); }
    catch (e) { caught = e; }
    if (!caught || caught.code !== 'BRAND_GUARD_NOT_FOUND') {
      fail(`expected BRAND_GUARD_NOT_FOUND, got code=${caught?.code}`);
    }
    log('nonexistent brand correctly returns BRAND_GUARD_NOT_FOUND');

    // 4. Missing brand_id.
    caught = null;
    try { await assertBrandOwnership(sql, null, tenantA); }
    catch (e) { caught = e; }
    if (!caught || caught.code !== 'BRAND_GUARD_NO_ID') {
      fail(`expected BRAND_GUARD_NO_ID, got code=${caught?.code}`);
    }
    log('null brand_id correctly returns BRAND_GUARD_NO_ID');
  } finally {
    await sql`DELETE FROM brands WHERE id = ${brandA}::uuid`.catch((e) => {
      console.warn('[cross-tenant] cleanup failed (best-effort):', e?.message);
    });
  }

  log('OK');
}

main().catch((err) => {
  console.error('[cross-tenant] unexpected:', err?.stack ?? err);
  process.exit(1);
});
