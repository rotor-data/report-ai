#!/usr/bin/env node
/**
 * Layer 1 — migration idempotency check (report-ai).
 *
 * Requires DATABASE_URL_TEST. Connects to an ephemeral Neon test
 * branch, applies every migration in db/migrations/ twice, captures the
 * schema after each run, and fails if the schema changes between
 * runs (i.e. a migration is not idempotent).
 *
 * If DATABASE_URL_TEST is not set we log a warning and exit 0 — the
 * regex audit in sql-syntax-check.mjs is the primary safety net; this
 * check is the second line of defence and runs in CI only.
 */
import { neon } from '@neondatabase/serverless';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const DB_URL = process.env.DATABASE_URL_TEST;
if (!DB_URL) {
  console.warn('[migrate-check] DATABASE_URL_TEST not set — skipping (CI-only check)');
  process.exit(0);
}

const MIGRATION_DIR = join(repoRoot, 'db/migrations');
if (!existsSync(MIGRATION_DIR)) {
  console.error('[migrate-check] db/migrations not found at', MIGRATION_DIR);
  process.exit(1);
}

const files = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => join(MIGRATION_DIR, f));

console.log(`[migrate-check] applying ${files.length} migrations against ephemeral DB`);

const sql = neon(DB_URL);

async function captureSchema() {
  // Capture column shape + constraints. Skip system schemas.
  const cols = await sql`
    SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  `;
  const indexes = await sql`
    SELECT schemaname, tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schemaname, tablename, indexname
  `;
  return JSON.stringify({ cols, indexes }, null, 2);
}

async function applyAll(label) {
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    try {
      await sql.unsafe ? await sql.unsafe(text) : await sql(text);
    } catch (err) {
      console.error(`[migrate-check] ${label}: FAILED at ${relative(repoRoot, f)}`);
      console.error(err?.message ?? err);
      throw err;
    }
  }
}

try {
  await applyAll('run-1');
  const schema1 = await captureSchema();
  console.log('[migrate-check] run-1 complete, capturing schema');
  await applyAll('run-2');
  const schema2 = await captureSchema();
  console.log('[migrate-check] run-2 complete, capturing schema');

  if (schema1 !== schema2) {
    console.error('[migrate-check] SCHEMA DRIFT between run-1 and run-2 — a migration is not idempotent');
    // Print a short diff hint
    const lines1 = schema1.split('\n');
    const lines2 = schema2.split('\n');
    const max = Math.min(lines1.length, lines2.length);
    let diffs = 0;
    for (let i = 0; i < max && diffs < 20; i++) {
      if (lines1[i] !== lines2[i]) {
        console.error(`  line ${i}: - ${lines1[i]}`);
        console.error(`  line ${i}: + ${lines2[i]}`);
        diffs++;
      }
    }
    process.exit(1);
  }

  console.log('[migrate-check] OK — migrations are idempotent (2x apply, identical schema)');
} catch (err) {
  console.error('[migrate-check] failed:', err?.message ?? err);
  process.exit(1);
}
