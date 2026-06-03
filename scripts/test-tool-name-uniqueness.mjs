#!/usr/bin/env node
/**
 * Layer 1 gate — tool-name uniqueness + prefix discipline.
 *
 * Reads evals/tools-snapshot.json and asserts:
 *
 *   1. No duplicate tool names. Two tools with the same name in tools/list
 *      makes routing non-deterministic.
 *   2. Every tool starts with one of our known prefixes. report-ai exposes
 *      report2__* + smyra_* (the latter is the hub-facing alias for one
 *      tool; kept for transitional cache compatibility).
 *
 * (No count baseline for report-ai — the surface is larger and changes
 * more often than hub/brand-os. The desc-length gate carries more weight
 * here.)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SNAPSHOT_PATH = fileURLToPath(new URL('../evals/tools-snapshot.json', import.meta.url));
const ALLOWED_PREFIXES = ['report2__', 'smyra_', 'platform__'];

function log(...a) { console.log('[tool-uniqueness]', ...a); }
function fail(msg) { console.error('[tool-uniqueness] FAIL:', msg); process.exit(1); }

if (!existsSync(SNAPSHOT_PATH)) fail('missing evals/tools-snapshot.json — run `npm run build:tools-snapshot`');
const tools = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

const seen = new Map();
const dups = [];
for (const t of tools) {
  if (seen.has(t.name)) dups.push(t.name);
  else seen.set(t.name, true);
}
if (dups.length) fail(`duplicate tool name(s): ${[...new Set(dups)].join(', ')}`);
log(`${tools.length} tools, all unique names`);

const bad = tools.filter(t => !ALLOWED_PREFIXES.some(p => t.name.startsWith(p)));
if (bad.length) {
  fail(`tools with unexpected prefix:\n  - ${bad.map(t => t.name).join('\n  - ')}\nAllowed: ${ALLOWED_PREFIXES.join(', ')}`);
}
log(`all ${tools.length} tools match an allowed prefix`);
log('OK');
