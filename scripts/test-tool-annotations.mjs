#!/usr/bin/env node
/**
 * Layer 2 — tool annotations audit.
 *
 * MCP best-practice (per brand-os 5d555a4 2026-05-27 template): every tool
 * carries `annotations: { readOnlyHint, destructiveHint, idempotentHint,
 * openWorldHint }`. Annotations let Claude reason about safety (e.g. when
 * to speculatively parallel-call read-only tools).
 *
 * Today (2026-06-03) report-ai's 51 tools have **zero** annotations — the
 * planned addition is tracked in the resilient-dazzling-koala plan as
 * "Report-ai-PR — BIGGEST impact — annotations + parallelism unblock".
 * We therefore enforce annotations against a **baseline file**:
 *   - `evals/annotations-baseline.json` holds the set of tool names that
 *     ALREADY have annotations.
 *   - Test fails ONLY if a tool in the baseline regresses (loses
 *     annotations) or if annotations have wrong shape.
 *   - As tools gain annotations, they should be added to the baseline in
 *     the same PR — `--update-baseline` regenerates it.
 *
 * This catches the regression class without requiring the production
 * annotations PR to land first.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const baselinePath = join(repoRoot, 'evals/annotations-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

function loadTools() {
  const src = readFileSync(join(repoRoot, 'netlify/functions/mcp-v2.js'), 'utf8');
  const start = src.indexOf('const TOOLS = [');
  if (start < 0) throw new Error('TOOLS array not found');
  let depth = 0;
  let i = start + 'const TOOLS = ['.length - 1;
  let end = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0 && c === ']') { end = i + 1; break; } }
    else if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    }
  }
  if (end < 0) throw new Error('failed to find end of TOOLS array');
  const STUB_PRELUDE = `const VALID_MODULE_TYPES = ["cover","chapter_break","back_cover","layout","freeform"];`;
  return new Function(`${STUB_PRELUDE} return ${src.slice(start + 'const TOOLS = '.length, end)};`)();
}

const REQUIRED_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

function annotationsOk(a) {
  if (!a || typeof a !== 'object') return false;
  for (const k of REQUIRED_KEYS) {
    if (typeof a[k] !== 'boolean') return false;
  }
  return true;
}

const tools = loadTools();
console.log(`[annotations] parsed ${tools.length} tools from source`);

const withAnno = tools.filter((t) => t && t.annotations);
const withoutAnno = tools.filter((t) => t && !t.annotations);

console.log(`[annotations] ${withAnno.length}/${tools.length} tools have annotations`);

let failures = 0;

// Shape check on every present annotations block
for (const t of withAnno) {
  if (!annotationsOk(t.annotations)) {
    console.error(`  ✗ ${t.name}: annotations present but missing/wrong-type keys (need ${REQUIRED_KEYS.join(', ')})`);
    failures++;
  }
}

// Baseline regression check
let baseline = [];
if (existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (!Array.isArray(baseline)) baseline = [];
  } catch {
    console.warn('[annotations] baseline file unparseable, treating as empty');
  }
}

const currentAnnotatedNames = new Set(withAnno.map((t) => t.name));
const regressed = baseline.filter((n) => !currentAnnotatedNames.has(n));
if (regressed.length) {
  console.error(`  ✗ regression: tools that lost annotations: ${regressed.join(', ')}`);
  failures += regressed.length;
}

if (UPDATE) {
  const sorted = [...currentAnnotatedNames].sort();
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[annotations] wrote baseline with ${sorted.length} annotated tool name(s) → ${baselinePath}`);
  process.exit(0);
}

if (withoutAnno.length > 0) {
  console.log(`[annotations] ${withoutAnno.length} tools still missing annotations (informational — not a failure until tracked in baseline):`);
  for (const t of withoutAnno.slice(0, 10)) console.log(`    - ${t.name}`);
  if (withoutAnno.length > 10) console.log(`    ... and ${withoutAnno.length - 10} more`);
  console.log('[annotations] add them in the report-ai annotations PR; run with --update-baseline once added.');
}

if (failures > 0) {
  console.error(`[annotations] ${failures} failure(s)`);
  process.exit(1);
}

console.log('[annotations] OK');
