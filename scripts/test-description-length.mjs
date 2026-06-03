#!/usr/bin/env node
/**
 * Layer 1 gate — tool description length (BM25 band).
 *
 * < 50  → fail (too thin for BM25 disambiguation)
 * > 1000 → fail (BM25 noise floor; see hub CLAUDE.md)
 * > 800 → warn (danger zone)
 *
 * Ratchet via evals/desc-length-allowlist.json so existing pre-trim
 * violations don't block this gate from landing — but any growth in a
 * known-bloated tool, OR any NEW thin/bloated tool, still fails.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SNAPSHOT_PATH = fileURLToPath(new URL('../evals/tools-snapshot.json', import.meta.url));
const ALLOWLIST_PATH = fileURLToPath(new URL('../evals/desc-length-allowlist.json', import.meta.url));
const MIN = 50;
const WARN = 800;
const MAX = 1000;

const allowlist = existsSync(ALLOWLIST_PATH)
  ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  : {};

function log(...a) { console.log('[desc-length]', ...a); }

if (!existsSync(SNAPSHOT_PATH)) {
  console.error('[desc-length] FAIL: missing evals/tools-snapshot.json');
  process.exit(1);
}
const tools = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

const fails = [];
const warns = [];
for (const t of tools) {
  const len = (t.description || '').length;
  const allowed = allowlist[t.name];
  if (len < MIN) {
    if (allowed && typeof allowed.min === 'number' && len >= allowed.min) {
      warns.push(`${t.name}: ${len} chars < ${MIN} (grandfathered, ratchet=${allowed.min})`);
    } else {
      fails.push(`${t.name}: ${len} chars < ${MIN} (BM25-too-thin)`);
    }
  } else if (len > MAX) {
    if (allowed && typeof allowed.max === 'number' && len <= allowed.max) {
      warns.push(`${t.name}: ${len} chars > ${MAX} (grandfathered, ratchet=${allowed.max})`);
    } else {
      fails.push(`${t.name}: ${len} chars > ${MAX} (BM25-bloat)`);
    }
  } else if (len > WARN) {
    warns.push(`${t.name}: ${len} chars > ${WARN} (danger zone)`);
  }
}

for (const w of warns) console.warn('[desc-length] WARN:', w);
if (fails.length) {
  for (const f of fails) console.error('[desc-length] FAIL:', f);
  process.exit(1);
}
log(`${tools.length} tools, all descriptions within [${MIN}..${MAX}]`);
log('OK');
