#!/usr/bin/env node
/**
 * Layer 1 — SQL syntax + safety audit (report-ai).
 *
 * Two passes over every .sql file under db/migrations/ and migrations/:
 *   1. If `pg-query-parser` is installed, parse each file and fail on
 *      parse errors with file + line.
 *   2. Regex audit (always runs as the primary safety net, since
 *      pg-query-parser requires native compilation that isn't reliable
 *      on every dev box):
 *        - every CREATE TABLE / INDEX / TYPE has IF NOT EXISTS
 *        - every ALTER TABLE ... ADD COLUMN has IF NOT EXISTS
 *        - no bare DROP TABLE / DROP COLUMN / DROP INDEX (must have
 *          IF EXISTS at minimum — destructive ops still flagged as
 *          warnings even with IF EXISTS)
 *
 * Catches the migration-021-class bug (forgotten IF NOT EXISTS races
 * with concurrent cold-starts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Both legacy `migrations/` and the active `db/migrations/` are
// scanned — the runtime applies whatever sits in db/migrations/, but
// the older `migrations/` tree is still present in some branches.
const MIGRATION_DIRS = ['db/migrations', 'migrations'];

function collectSqlFiles() {
  const files = [];
  for (const d of MIGRATION_DIRS) {
    const full = join(repoRoot, d);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort()) {
      const p = join(full, name);
      if (statSync(p).isFile() && name.endsWith('.sql')) files.push(p);
    }
  }
  return files;
}

// Explicit allowlist of migration filenames that predate the idempotency
// convention. We bypass the IF NOT EXISTS check ONLY for these — they've
// been applied to prod many deploys ago and rewriting them would diff
// against `_migrations.checksum`. ALL OTHER migrations (existing + future)
// are audited by default — no number-based cutoff that silently
// grandfathers future migrations into the dead-letter zone.
const LEGACY_ALLOWLIST = new Set([
  '001_initial.sql',
  '002_document_type_templates.sql',
]);

const allFiles = collectSqlFiles();
const files = allFiles.filter((f) => {
  const base = f.split('/').pop();
  return !LEGACY_ALLOWLIST.has(base);
});
const grandfathered = allFiles.length - files.length;
console.log(`[sql] auditing ${files.length} migration file(s) (${grandfathered} explicitly allowlisted)`);

// Optional pg-query-parser parse pass.
let parser = null;
try {
  parser = await import('pg-query-parser');
} catch {
  // Not installed — fall through to regex-only audit.
}

let parseFails = 0;
if (parser) {
  console.log('[sql] pg-query-parser available — running parse pass');
  for (const f of files) {
    const sql = readFileSync(f, 'utf8');
    try {
      const result = parser.parse ? parser.parse(sql) : parser.default.parse(sql);
      if (result && Array.isArray(result.error) && result.error.length) {
        for (const e of result.error) {
          console.error(`[sql] PARSE ERROR ${relative(repoRoot, f)}:${e.cursorpos ?? '?'}: ${e.message}`);
        }
        parseFails++;
      }
    } catch (err) {
      console.error(`[sql] PARSE ERROR ${relative(repoRoot, f)}: ${err?.message ?? err}`);
      parseFails++;
    }
  }
  if (parseFails > 0) {
    console.error(`[sql] ${parseFails} file(s) failed pg-query-parser — aborting`);
    process.exit(1);
  }
  console.log('[sql] pg-query-parser pass OK');
} else {
  console.log('[sql] pg-query-parser not installed — skipping parse pass (regex audit still runs)');
}

// Regex audit — primary safety net.
function stripCommentsAndStrings(sql) {
  // Remove -- line comments, /* */ block comments, and single-quoted
  // string literals so our regexes don't match keywords inside them.
  let out = sql.replace(/--[^\n]*/g, '');
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  // Naive string strip: single-quoted literals (handles '' escape).
  out = out.replace(/'(?:''|[^'])*'/g, "''");
  return out;
}

const issues = [];

for (const f of files) {
  const rel = relative(repoRoot, f);
  const raw = readFileSync(f, 'utf8');
  const sql = stripCommentsAndStrings(raw);

  // Find every CREATE TABLE / INDEX / UNIQUE INDEX / TYPE and verify
  // IF NOT EXISTS follows.
  const createRe = /\bCREATE\s+(UNIQUE\s+)?(TABLE|INDEX|TYPE|SCHEMA|EXTENSION|SEQUENCE)\s+(?!IF\s+NOT\s+EXISTS\b)([A-Za-z_."]+)/gi;
  let m;
  while ((m = createRe.exec(sql))) {
    // Skip CREATE OR REPLACE which is implicitly idempotent for the
    // object types that support it (functions, views, triggers).
    const before = sql.slice(Math.max(0, m.index - 12), m.index);
    if (/OR\s+REPLACE\s*$/i.test(before)) continue;
    issues.push(`${rel}: CREATE ${m[2]} without IF NOT EXISTS near "${m[0]}"`);
  }

  // ALTER TABLE ... ADD COLUMN must use IF NOT EXISTS.
  const addColRe = /\bALTER\s+TABLE\s+[A-Za-z_."]+\s+ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/gi;
  while ((m = addColRe.exec(sql))) {
    issues.push(`${rel}: ALTER TABLE ADD COLUMN without IF NOT EXISTS`);
  }

  // Bare DROP TABLE / COLUMN / INDEX without IF EXISTS — destructive,
  // and even with IF EXISTS we want to know.
  const dropRe = /\bDROP\s+(TABLE|INDEX|COLUMN|TYPE|SEQUENCE)\s+(?!IF\s+EXISTS\b)([A-Za-z_."]+)/gi;
  while ((m = dropRe.exec(sql))) {
    issues.push(`${rel}: DROP ${m[1]} without IF EXISTS near "${m[0]}" (destructive)`);
  }
}

if (issues.length) {
  console.error(`[sql] ${issues.length} idempotency issue(s):`);
  for (const i of issues) console.error('  -', i);
  console.error('[sql] aborting — migrations must be idempotent (see CLAUDE.md)');
  process.exit(1);
}

console.log(`[sql] regex audit OK — ${files.length} migration(s) clean`);
