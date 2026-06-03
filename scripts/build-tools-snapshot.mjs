#!/usr/bin/env node
/**
 * Build `evals/tools-snapshot.json` — the static tool catalogue the
 * BM25 eval runner scores against.
 *
 * Source: `netlify/functions/mcp-v2.js` `TOOLS` array. Tools served to
 * Claude.ai are prefixed `report2__<name>` by the hub, so the snapshot
 * applies that prefix here too (matches what Claude.ai's BM25 surface
 * sees in production).
 *
 * Also includes `smyra_report_create` — a hub-side workflow tool that
 * lives in the rotor-platform-hub repo but is part of the same MCP
 * surface Claude.ai sees alongside report2__* tools (the eval XML may
 * reference it for "create a report"-style questions).
 *
 * No live HTTP calls, no DB, no API keys — pure source parse.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outPath = join(repoRoot, 'evals/tools-snapshot.json');

function loadToolsFromSource() {
  const src = readFileSync(join(repoRoot, 'netlify/functions/mcp-v2.js'), 'utf8');
  const start = src.indexOf('const TOOLS = [');
  if (start < 0) throw new Error('TOOLS array not found in mcp-v2.js');
  let depth = 0;
  let end = -1;
  for (let i = start + 'const TOOLS = ['.length - 1; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === ']') { end = i + 1; break; }
    } else if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
  }
  if (end === -1) throw new Error('could not find closing ] for TOOLS array');
  // Inline a stub for any in-scope constants the literal references.
  const STUB = `const VALID_MODULE_TYPES = ["cover","chapter_break","back_cover","layout","freeform"];`;
  // eslint-disable-next-line no-new-func
  return new Function(`${STUB} return ${src.slice(start + 'const TOOLS = '.length, end)};`)();
}

const mcpTools = loadToolsFromSource();

// Hub-side surface that Claude.ai sees alongside report2__* tools.
const HUB_TOOLS = [
  {
    name: 'smyra_report_create',
    description:
      "Skapa en ny rapport från grunden — end-to-end pipeline. " +
      "Use ONLY for new-report creation (skriv en rapport, ny rapport, create report). " +
      "For render / blueprint / asset / list / edit, use the dedicated report2__ tool.",
  },
];

const snapshot = [
  ...HUB_TOOLS,
  ...mcpTools.map((t) => ({
    name: `report2__${t.name}`,
    description: t.description || '',
  })),
];

snapshot.sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`[snapshot] wrote ${snapshot.length} tools to ${outPath}`);
console.log(`  report2: ${mcpTools.length} | hub: ${HUB_TOOLS.length}`);
