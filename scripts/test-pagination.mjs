#!/usr/bin/env node
/**
 * Layer 2 — pagination audit.
 *
 * For every list-style tool, verify the handler implements the
 * LIMIT 50 + has_more pagination pattern (per brand-os audit template).
 * Without this, large tenants drown Claude in 10k+ row responses or
 * silently truncate — both are bad.
 *
 * Today (2026-06-03), report-ai handlers return `{ items, count }` with no
 * LIMIT/has_more. Like the annotations check, this is **baseline-aware**:
 *   - `evals/pagination-baseline.json` lists handlers that already paginate.
 *   - Test fails ONLY if a previously-paginated handler regresses.
 *   - Run with --update-baseline to recapture state after adding pagination.
 *
 * The check is static — it greps each handler function body for the
 * `LIMIT 50` SQL clause AND a `has_more` key in the response — both must
 * be present to count as paginated.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const baselinePath = join(repoRoot, 'evals/pagination-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

// (tool-name, handler-function-name) pairs — handler names are how they're
// declared in mcp-v2.js (`async function handleListBlueprints(...)`).
const LIST_TOOLS = [
  ['list_blueprints', 'handleListBlueprints'],
  ['list_components', 'handleListComponents'],
  ['list_brands', 'handleListBrands'],
  ['list_reports', 'handleListReports'],
  ['list_assets', 'handleListAssets'],
  ['list_templates', 'handleListTemplates'],
  ['list_design_extractions', 'handleListDesignExtractions'],
  ['list_smyra_templates', 'handleListSmyraTemplates'],
];

function extractFunctionBody(src, fnName) {
  // Match `async function <fnName>(...)` or `function <fnName>(...)`.
  const decl = src.match(new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`));
  if (!decl) return null;
  const start = src.indexOf('{', decl.index);
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    else if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          let bd = 1; i += 2;
          while (i < src.length && bd > 0) {
            if (src[i] === '{') bd++; else if (src[i] === '}') bd--;
            i++;
          }
          continue;
        }
        i++;
      }
    }
  }
  return null;
}

function isPaginated(body) {
  if (!body) return false;
  const hasLimit = /\bLIMIT\s+\d+/i.test(body);
  const hasHasMore = /has_more\s*[:,]/i.test(body);
  return hasLimit && hasHasMore;
}

const src = readFileSync(join(repoRoot, 'netlify/functions/mcp-v2.js'), 'utf8');

let baseline = [];
if (existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (!Array.isArray(baseline)) baseline = [];
  } catch { /* empty */ }
}

const paginated = [];
const notPaginated = [];
const missing = [];

for (const [tool, fn] of LIST_TOOLS) {
  const body = extractFunctionBody(src, fn);
  if (body == null) {
    missing.push({ tool, fn });
    continue;
  }
  if (isPaginated(body)) paginated.push(tool);
  else notPaginated.push(tool);
}

console.log(`[pagination] paginated: ${paginated.length}/${LIST_TOOLS.length}`);
console.log(`[pagination]   ${paginated.length ? paginated.join(', ') : '(none yet)'}`);

if (missing.length) {
  console.warn('[pagination] handler not found for:');
  for (const m of missing) console.warn(`    - ${m.tool} (looked for ${m.fn})`);
}

const paginatedSet = new Set(paginated);
const regressed = baseline.filter((t) => !paginatedSet.has(t));

if (UPDATE) {
  writeFileSync(baselinePath, JSON.stringify(paginated.sort(), null, 2) + '\n');
  console.log(`[pagination] wrote baseline (${paginated.length} entries) → ${baselinePath}`);
  process.exit(0);
}

if (regressed.length) {
  console.error(`[pagination] ✗ regression: previously-paginated handlers no longer paginate: ${regressed.join(', ')}`);
  process.exit(1);
}

if (notPaginated.length) {
  console.log(`[pagination] ${notPaginated.length} list-tools still unpaginated (informational, not failing until added to baseline):`);
  for (const t of notPaginated) console.log(`    - ${t}`);
}

console.log('[pagination] OK');
