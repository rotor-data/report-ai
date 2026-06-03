#!/usr/bin/env node
/**
 * Layer 3 — eval runner.
 *
 * Reads evals/*.xml, for each <qa_pair> calls the Anthropic Messages API
 * with the question + the live tools/list from mcp-v2 as `tools`. Scores
 * precision@1 — the FIRST `tool_use` block in Claude's response must
 * match expected_tools[].
 *
 * Auth: needs ANTHROPIC_API_KEY. Tools are extracted by importing the
 * mcp-v2 handler and calling tools/list with a minted Hub JWT (same
 * trick as test-mcp-handshake.mjs). If HUB_JWT_PRIVATE_KEY_PEM is unset,
 * falls back to source-extracted TOOLS array via static parse — slightly
 * less faithful (won't catch dynamic shape changes) but still useful.
 *
 * Baseline: evals/baseline.json holds the last green pass-rate per file.
 * If current pass-rate < baseline - tolerance, exit nonzero.
 *   { "report-ai.xml": { passed: 9, total: 10, tolerance: 1 } }
 * Tolerance lets one-off LLM stochasticity slide without flapping CI.
 *
 * Skips with warning (exit 0) if ANTHROPIC_API_KEY is unset.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createSign, createPrivateKey, createPublicKey } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const evalsDir = join(repoRoot, 'evals');
const baselinePath = join(evalsDir, 'baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.warn('[evals] ANTHROPIC_API_KEY not set — skipping eval suite.');
  process.exit(0);
}

const model = process.env.EVAL_MODEL || 'claude-haiku-4-5';

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function normalizePem(raw) {
  if (!raw) return raw;
  let s = raw.replace(/\\n/g, '\n');
  if (/-----\n[A-Za-z0-9+/]/.test(s)) return s.trim();
  const hM = s.match(/(-----BEGIN [A-Z ]+-----)/), fM = s.match(/(-----END [A-Z ]+-----)/);
  if (!hM || !fM) return s.trim();
  const h = hM[1], f = fM[1];
  const b = s.slice(s.indexOf(h) + h.length, s.indexOf(f)).replace(/\s+/g, '');
  return [h, ...(b.match(/.{1,64}/g) || []), f].join('\n');
}
function mintJwt({ privatePem, aud, sub, tenantId, ttlSec = 300 }) {
  const key = createPrivateKey(privatePem);
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: process.env.HUB_JWT_ISSUER || 'hub.rotor-platform.com', aud, sub, iat: now, exp: now + ttlSec, tenant_id: tenantId };
  const eh = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const ep = base64url(JSON.stringify(payload));
  const si = `${eh}.${ep}`;
  const signer = createSign('RSA-SHA256'); signer.update(si);
  return `${si}.${base64url(signer.sign(key))}`;
}

// ─── Load tools ────────────────────────────────────────────────────────────
async function loadToolsViaHandler() {
  const privatePemRaw = process.env.HUB_JWT_PRIVATE_KEY_PEM;
  if (!privatePemRaw) return null;
  const privatePem = normalizePem(privatePemRaw);
  if (!process.env.HUB_JWT_PUBLIC_KEY_PEM) {
    process.env.HUB_JWT_PUBLIC_KEY_PEM = createPublicKey(privatePem).export({ format: 'pem', type: 'spki' });
  }
  const mod = await import('file://' + join(repoRoot, 'netlify/functions/mcp-v2.js'));
  const token = mintJwt({ privatePem, aud: 'report-ai-v2', sub: randomUUID(), tenantId: randomUUID() });
  const resp = await mod.handler({
    httpMethod: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (resp.statusCode !== 200) throw new Error(`tools/list returned ${resp.statusCode}`);
  return JSON.parse(resp.body).result.tools;
}

function loadToolsFromSource() {
  const src = readFileSync(join(repoRoot, 'netlify/functions/mcp-v2.js'), 'utf8');
  const start = src.indexOf('const TOOLS = [');
  if (start < 0) throw new Error('TOOLS not found');
  let depth = 0, end = -1;
  for (let i = start + 'const TOOLS = ['.length - 1; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0 && c === ']') { end = i + 1; break; } }
    else if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } }
  }
  const STUB = `const VALID_MODULE_TYPES = ["cover","chapter_break","back_cover","layout","freeform"];`;
  return new Function(`${STUB} return ${src.slice(start + 'const TOOLS = '.length, end)};`)();
}

let mcpTools;
try {
  mcpTools = await loadToolsViaHandler();
  if (mcpTools) console.log(`[evals] loaded ${mcpTools.length} tools via handler (live shape)`);
} catch (err) {
  console.warn('[evals] handler load failed, falling back to source parse:', err.message);
}
if (!mcpTools) {
  mcpTools = loadToolsFromSource();
  console.log(`[evals] loaded ${mcpTools.length} tools via source parse`);
}

// MCP tool names need to be prefixed `report2__` AND `smyra_report_create`
// added (it's hub-side, not in mcp-v2's TOOLS array). Reflect what Claude
// sees in production via Claude.ai's tool list.
const HUB_TOOLS = [
  {
    name: 'smyra_report_create',
    description: 'Start eller fortsätt en multi-step rapportskapande-workflow (alpha-v3 freeform HTML pipeline). Användarvänligt entry-point för "skriv en rapport"-requests. Förvald över report2__create för end-to-end-flöden.',
    input_schema: { type: 'object', properties: { run_id: { type: 'string' }, doc_title: { type: 'string' } } },
  },
];

const anthropicTools = [
  ...HUB_TOOLS,
  ...mcpTools.map((t) => ({
    name: `report2__${t.name}`,
    description: t.description,
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  })),
];

// ─── Parse evals ───────────────────────────────────────────────────────────
function parseEvalFile(xml) {
  const pairs = [];
  const re = /<qa_pair>\s*<question>([\s\S]*?)<\/question>\s*<expected_tools>([\s\S]*?)<\/expected_tools>\s*<\/qa_pair>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    pairs.push({
      question: m[1].trim(),
      expected: m[2].split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return pairs;
}

// ─── Call Claude ───────────────────────────────────────────────────────────
async function callClaude(question) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      tools: anthropicTools,
      messages: [{ role: 'user', content: question }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = await res.json();
  // Find first tool_use block
  const block = (body.content || []).find((b) => b.type === 'tool_use');
  return block?.name || null;
}

// ─── Run ───────────────────────────────────────────────────────────────────
const files = readdirSync(evalsDir).filter((f) => f.endsWith('.xml'));
if (files.length === 0) {
  console.warn('[evals] no *.xml files in evals/ — nothing to run.');
  process.exit(0);
}

let baseline = {};
if (existsSync(baselinePath)) {
  try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch { baseline = {}; }
}
const newBaseline = {};
let anyRegression = false;

for (const file of files) {
  const xml = readFileSync(join(evalsDir, file), 'utf8');
  const pairs = parseEvalFile(xml);
  console.log(`\n[evals] ${file} — ${pairs.length} questions`);
  let passed = 0;
  for (let i = 0; i < pairs.length; i++) {
    const { question, expected } = pairs[i];
    let called;
    try {
      called = await callClaude(question);
    } catch (err) {
      console.error(`  Q${i + 1} ERROR: ${err.message}`);
      continue;
    }
    const ok = called && expected.includes(called);
    if (ok) passed++;
    const tag = ok ? '✓' : '✗';
    console.log(`  ${tag} Q${i + 1}: "${question.slice(0, 70)}${question.length > 70 ? '…' : ''}"`);
    console.log(`     got=${called ?? '(no tool_use)'}  expected one of ${expected.join(' | ')}`);
  }
  const rate = pairs.length > 0 ? passed / pairs.length : 0;
  console.log(`[evals] ${file}: precision@1 = ${passed}/${pairs.length} (${(rate * 100).toFixed(0)}%)`);
  newBaseline[file] = { passed, total: pairs.length, tolerance: 1 };

  const prev = baseline[file];
  if (prev && !UPDATE) {
    const threshold = Math.max(0, prev.passed - (prev.tolerance ?? 1));
    if (passed < threshold) {
      console.error(`[evals] ✗ regression in ${file}: ${passed} < ${threshold} (baseline ${prev.passed}, tolerance ${prev.tolerance ?? 1})`);
      anyRegression = true;
    } else {
      console.log(`[evals] baseline ok (≥ ${threshold})`);
    }
  }
}

if (UPDATE) {
  writeFileSync(baselinePath, JSON.stringify(newBaseline, null, 2) + '\n');
  console.log(`\n[evals] wrote baseline → ${baselinePath}`);
  process.exit(0);
}

if (anyRegression) {
  console.error('\n[evals] one or more files regressed against baseline');
  process.exit(1);
}

console.log('\n[evals] OK');
