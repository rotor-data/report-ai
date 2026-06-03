#!/usr/bin/env node
/**
 * Layer 2 — outputSchema integrity.
 *
 * Loads the TOOLS array from mcp-v2.js (no HTTP, no DB) and for every tool
 * that defines an outputSchema, asserts the schema is a structurally valid
 * JSON Schema fragment: object with `type` or `properties` or `oneOf`/
 * `anyOf`. Catches accidental typos like `outputSchema: { type: "string" }`
 * with no `properties` field on object-returning tools.
 *
 * Today the top-5 tools (list_blueprints, get_blueprint, list_components,
 * list_brands, get_brand_tokens) are the planned recipients of outputSchema
 * additions per the 2026-06-03 audit. When that lands, this script enforces
 * shape going forward. Until then it's a no-op pass (0 tools with
 * outputSchema → nothing to check), reported clearly.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// mcp-v2 needs HUB_JWT_PUBLIC_KEY_PEM at module-load time? Check — actually,
// it only reads env vars inside the handler, not at import time. Still safe
// to set a placeholder to avoid surprise side-effects from any future
// module-scope reads.
if (!process.env.HUB_JWT_ISSUER) process.env.HUB_JWT_ISSUER = 'hub.rotor-platform.com';
if (!process.env.HUB_JWT_PUBLIC_KEY_PEM && (process.env.TEST_JWT_PRIVATE_KEY_PEM ?? process.env.HUB_JWT_PRIVATE_KEY_PEM)) {
  try {
    const pem = (process.env.TEST_JWT_PRIVATE_KEY_PEM ?? process.env.HUB_JWT_PRIVATE_KEY_PEM).replace(/\\n/g, '\n');
    process.env.HUB_JWT_PUBLIC_KEY_PEM = createPublicKey(pem).export({ format: 'pem', type: 'spki' });
  } catch { /* ignore */ }
}

// Import handler to fish out the TOOLS array. TOOLS isn't exported, so we
// invoke tools/list with a stub event that bypasses auth — wait, auth is
// required. Easier: re-parse the source file to extract TOOLS via a tiny
// AST-aware scan. But the simpler path is to just import the file and
// re-execute the tools/list path with a minted token if available — see
// test-mcp-handshake.mjs. Here we want auth-less access so we read source.
import { readFileSync } from 'node:fs';

const src = readFileSync(join(repoRoot, 'netlify/functions/mcp-v2.js'), 'utf8');
// Match the TOOLS array between `const TOOLS = [` and the closing `];`
const startMarker = 'const TOOLS = [';
const start = src.indexOf(startMarker);
if (start < 0) {
  console.error('[output-schemas] could not find `const TOOLS = [` in mcp-v2.js');
  process.exit(1);
}
// Walk brackets to find the matching closing `];` — accounts for nested
// brackets inside JSON Schema objects.
let depth = 0;
let i = start + startMarker.length - 1; // start at the `[`
let end = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (c === '[' || c === '{') depth++;
  else if (c === ']' || c === '}') {
    depth--;
    if (depth === 0 && c === ']') { end = i + 1; break; }
  }
  // Skip strings — naive but works for our source (no `[` `]` inside strings
  // in this file's TOOLS array as of 2026-06-03).
  else if (c === '"' || c === "'") {
    const quote = c;
    i++;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') i++;
      i++;
    }
  }
}

if (end < 0) {
  console.error('[output-schemas] failed to locate end of TOOLS array');
  process.exit(1);
}

// Strip the `const TOOLS = ` prefix → just `[ ... ]` literal — eval as JS.
const arrayLiteral = src.slice(start + 'const TOOLS = '.length, end);

// Stub constants referenced from inside TOOLS bodies. Keep in sync with
// any module-scope identifiers used in tool registration (currently only
// VALID_MODULE_TYPES).
const STUB_PRELUDE = `
  const VALID_MODULE_TYPES = ["cover","chapter_break","back_cover","layout","freeform"];
`;

let tools;
try {
  // eslint-disable-next-line no-new-func
  tools = new Function(`${STUB_PRELUDE} return ${arrayLiteral};`)();
} catch (err) {
  console.error('[output-schemas] failed to eval TOOLS array:', err.message);
  process.exit(1);
}

if (!Array.isArray(tools)) {
  console.error('[output-schemas] TOOLS is not an array');
  process.exit(1);
}

console.log(`[output-schemas] parsed ${tools.length} tools from source`);

const withOutput = tools.filter((t) => t && t.outputSchema);
console.log(`[output-schemas] ${withOutput.length} tools declare outputSchema`);

let failures = 0;
for (const t of withOutput) {
  const s = t.outputSchema;
  const ok =
    s && typeof s === 'object' &&
    (typeof s.type === 'string' || s.properties || s.oneOf || s.anyOf || s.allOf || s.$ref);
  if (!ok) {
    console.error(`  ✗ ${t.name}: outputSchema missing type/properties/oneOf/anyOf/allOf/$ref`);
    failures++;
    continue;
  }
  // For object schemas, require properties to be present (catches stub
  // `{ type: "object" }` with no actual shape).
  if (s.type === 'object' && (!s.properties || typeof s.properties !== 'object')) {
    console.error(`  ✗ ${t.name}: outputSchema type=object but no properties`);
    failures++;
    continue;
  }
  console.log(`  ✓ ${t.name}: outputSchema OK`);
}

if (failures > 0) {
  console.error(`[output-schemas] ${failures} tool(s) FAILED schema integrity`);
  process.exit(1);
}

if (withOutput.length === 0) {
  console.log('[output-schemas] no outputSchemas declared yet — pass (will enforce shape once added per 2026-06-03 audit).');
}

console.log('[output-schemas] OK');
