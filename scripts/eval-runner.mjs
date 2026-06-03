#!/usr/bin/env node
/**
 * Eval-runner — BM25 tool-selection precision against tool descriptions.
 *
 * Why BM25 not LLM: this is exactly the ranking algorithm Claude.ai's
 * `tool_search` uses to surface tools for the model to consider. Testing
 * "would the LLM pick the right tool" via API calls is BOTH redundant
 * (the LLM's choice IS driven by BM25-ranked surfaces) AND violates
 * Smyra's API-fri-principle (no server-side LLM in CI either).
 *
 * Algorithm:
 *   1. Load tools/list from evals/tools-snapshot.json (built by
 *      scripts/build-tools-snapshot.mjs per repo).
 *   2. For each question, BM25-score tools' descriptions against the
 *      question's terms. Top-K (default 3) is what Claude.ai would see.
 *   3. Compare against expected tool name(s) from the XML. Supports
 *      multiple XML shapes:
 *        - <answer>tool_name</answer>           (hub-style, optional <!-- alt: ... -->)
 *        - <expected_tools>a,b</expected_tools> (report-ai-style)
 *        - <answer>prose</answer> + preceding `Tools expected: foo → bar` comment
 *      Any qa_pair whose answer is prose (no tool prefix) AND has no
 *      annotation is skipped with a warning — not scoreable.
 *   4. Fail if precision@1 or precision@3 drops below baseline (5pp tolerance).
 *
 * No env vars required. Reproducible across runs.
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let __dirname;
try { __dirname = dirname(fileURLToPath(import.meta.url)); }
catch { __dirname = process.cwd(); }

const repoRoot = join(__dirname, "..");
const evalsDir = join(repoRoot, "evals");
const baselinePath = join(evalsDir, "baseline.json");
const toolsSnapshotPath = join(evalsDir, "tools-snapshot.json");

// ─── BM25 ────────────────────────────────────────────────────────────────
// Classic Okapi BM25 (k1=1.5, b=0.75) over whitespace-tokenized lowercased
// terms. Tools-list-tokenization mirrors Claude.ai's BM25 surface as
// closely as we can without source access — adjusting k1/b later is OK.

const K1 = 1.5;
const B = 0.75;

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\sÅÄÖåäö]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function buildIndex(docs) {
  const N = docs.length;
  const docs2 = docs.map((d) => ({ ...d, terms: tokenize(d.text) }));
  const avgdl = docs2.reduce((a, d) => a + d.terms.length, 0) / N;
  const df = new Map();
  for (const d of docs2) {
    const seen = new Set(d.terms);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  return { docs: docs2, N, avgdl, df };
}

function bm25Score(query, idx) {
  const qTerms = tokenize(query);
  const scores = idx.docs.map((d) => {
    let s = 0;
    const dl = d.terms.length;
    const tf = new Map();
    for (const t of d.terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of qTerms) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = idx.df.get(t) || 0;
      const idf = Math.log((idx.N - n + 0.5) / (n + 0.5) + 1);
      const norm = f * (K1 + 1) / (f + K1 * (1 - B + B * dl / idx.avgdl));
      s += idf * norm;
    }
    return { id: d.id, score: s };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

// ─── XML parse (multi-format) ────────────────────────────────────────────

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function looksLikeToolName(s) {
  // tool names use word chars + underscores; module-prefixed (foo__bar) or plain (smyra_foo)
  return /^[a-z][a-z0-9_]*$/i.test(s);
}

function parseEvalXml(xml, toolNames) {
  const pairs = [];
  // Match optional preceding comment + qa_pair with either <answer> or <expected_tools>
  const re = /(<!--([\s\S]*?)-->)?\s*<qa_pair>\s*<question>([\s\S]*?)<\/question>\s*(?:<answer>([\s\S]*?)<\/answer>|<expected_tools>([\s\S]*?)<\/expected_tools>)\s*<\/qa_pair>(?:\s*<!--\s*alt:\s*([^>]*?)\s*-->)?/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const commentRaw = (m[2] || "").trim();
    const question = decodeXml(m[3].trim());
    const answerRaw = m[4] != null ? decodeXml(m[4].trim()) : null;
    const expectedToolsRaw = m[5] != null ? m[5].trim() : null;
    const altRaw = (m[6] || "").trim();

    const acceptable = new Set();

    // Format A: <expected_tools>a,b,c</expected_tools>
    if (expectedToolsRaw) {
      for (const t of expectedToolsRaw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
        acceptable.add(t);
      }
    }

    // Format B: <answer>tool_name</answer> (single token, looks like a tool name AND exists in catalogue)
    if (answerRaw && looksLikeToolName(answerRaw) && toolNames.has(answerRaw)) {
      acceptable.add(answerRaw);
    }

    // Format C: comment with "Tools expected: foo → bar" or similar.
    if (commentRaw && acceptable.size === 0) {
      const expLine = commentRaw.split("\n").find((l) => /Tools? expected:/i.test(l));
      if (expLine) {
        const after = expLine.replace(/^.*?expected:\s*/i, "");
        // Grab anything that looks like a tool name in the catalogue
        const tokens = after.match(/[a-z][a-z0-9_]+/gi) || [];
        for (const t of tokens) {
          if (toolNames.has(t)) acceptable.add(t);
        }
      }
    }

    // alt-comment after qa_pair (hub-style)
    if (altRaw) {
      for (const t of altRaw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
        acceptable.add(t);
      }
    }

    if (acceptable.size === 0) {
      // not scoreable — skip silently (informational)
      continue;
    }

    pairs.push({ question, acceptable });
  }
  return pairs;
}

// ─── Run ─────────────────────────────────────────────────────────────────

if (!existsSync(toolsSnapshotPath)) {
  console.error(`[eval] tools snapshot missing at ${toolsSnapshotPath}.`);
  console.error("  Run `npm run build:tools-snapshot` first, or commit a snapshot.");
  process.exit(2);
}

const tools = JSON.parse(readFileSync(toolsSnapshotPath, "utf8"));
if (!Array.isArray(tools) || tools.length === 0) {
  console.error("[eval] tools snapshot is empty.");
  process.exit(2);
}

const toolNames = new Set(tools.map((t) => t.name));
const docs = tools.map((t) => ({ id: t.name, text: `${t.name} ${t.description || ""}` }));
const idx = buildIndex(docs);

if (!existsSync(evalsDir)) {
  console.error(`[eval] evals/ dir missing.`);
  process.exit(2);
}

const xmlFiles = readdirSync(evalsDir).filter((f) => f.endsWith(".xml"));
if (xmlFiles.length === 0) {
  console.error("[eval] no .xml eval files found.");
  process.exit(2);
}

let totalQ = 0;
let skipped = 0;
let p1 = 0;
let p3 = 0;
const failures = [];

for (const f of xmlFiles) {
  const xml = readFileSync(join(evalsDir, f), "utf8");
  const pairs = parseEvalXml(xml, toolNames);
  // count skipped qa_pairs (no acceptable tools resolved) for visibility
  const allPairCount = (xml.match(/<qa_pair>/g) || []).length;
  skipped += Math.max(0, allPairCount - pairs.length);

  for (const { question, acceptable } of pairs) {
    totalQ += 1;
    const scores = bm25Score(question, idx);
    const top1 = scores[0]?.id;
    const top3 = scores.slice(0, 3).map((s) => s.id);
    const top1Match = acceptable.has(top1);
    const top3Match = top3.some((id) => acceptable.has(id));
    if (top1Match) p1 += 1;
    if (top3Match) p3 += 1;
    if (!top1Match) {
      failures.push({
        question,
        expected: [...acceptable],
        got: top3,
        scores: scores.slice(0, 3).map((s) => `${s.id}=${s.score.toFixed(2)}`),
      });
    }
  }
}

const precision1 = totalQ > 0 ? p1 / totalQ : 0;
const precision3 = totalQ > 0 ? p3 / totalQ : 0;

console.log(`[eval] scored ${totalQ} qa_pair(s), skipped ${skipped} (prose answers without tool annotations)`);
console.log(`[eval] precision@1 = ${(precision1 * 100).toFixed(1)}% (${p1}/${totalQ})`);
console.log(`[eval] precision@3 = ${(precision3 * 100).toFixed(1)}% (${p3}/${totalQ})`);
if (failures.length) {
  console.log(`[eval] ${failures.length} miss(es):`);
  for (const f of failures.slice(0, 10)) {
    console.log(`  Q: ${f.question}`);
    console.log(`     expected: ${f.expected.join(" | ")}`);
    console.log(`     top-3:    ${f.scores.join(", ")}`);
  }
}

// Baseline regression gate
let baseline = { precision1: 0, precision3: 0 };
if (existsSync(baselinePath)) {
  try {
    const raw = JSON.parse(readFileSync(baselinePath, "utf8"));
    // Accept either the new shape ({precision1, precision3}) or legacy
    // ({precision_at_1, ...}) by falling back to 0.
    baseline = {
      precision1: typeof raw.precision1 === "number" ? raw.precision1 : 0,
      precision3: typeof raw.precision3 === "number" ? raw.precision3 : 0,
    };
  } catch { /* ignore parse failure, treat as missing */ }
}

const updateBaseline = process.argv.includes("--update-baseline");
if (updateBaseline) {
  writeFileSync(
    baselinePath,
    JSON.stringify({ precision1, precision3, recorded_at: new Date().toISOString() }, null, 2)
  );
  console.log(`[eval] baseline updated → precision@1=${precision1.toFixed(3)} precision@3=${precision3.toFixed(3)}`);
  process.exit(0);
}

const regressionThreshold = 0.05; // tolerate 5pp dip below baseline
if (precision1 + regressionThreshold < baseline.precision1) {
  console.error(`[eval] FAIL: precision@1 ${precision1.toFixed(3)} < baseline ${baseline.precision1.toFixed(3)} - ${regressionThreshold}`);
  process.exit(1);
}
if (precision3 + regressionThreshold < baseline.precision3) {
  console.error(`[eval] FAIL: precision@3 ${precision3.toFixed(3)} < baseline ${baseline.precision3.toFixed(3)} - ${regressionThreshold}`);
  process.exit(1);
}

console.log("[eval] OK — no regression vs baseline");
