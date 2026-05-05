#!/usr/bin/env node
/**
 * run-template-haiku-pass.mjs
 *
 * Job 1 from /Users/danielpettersson/.claude/plans/resilient-dazzling-koala.md.
 *
 * For every doctype in DOC_TYPE_CATEGORIES (smyra-core setup.ts), call Haiku
 * once with the current FALLBACK_TEMPLATES entry + module/role catalog +
 * user's gold-standard quarterly description as a calibration target. Haiku
 * returns a refined template (required_sections, default_stub_plan,
 * recommended_pages, tone_hints, disclosures, proposed_module_types).
 *
 * Output is collected and written to:
 *   - scripts/template-haiku-pass.dryrun.json (when --doctypes=... is set)
 *   - scripts/template-haiku-pass.output.json (full 33-doctype run)
 *
 * USAGE
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/run-template-haiku-pass.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/run-template-haiku-pass.mjs \
 *     --doctypes=quarterly,ceo_letter,pitch
 *
 * The script does NOT touch document-type-templates.js. It writes only the
 * JSON artefact for human review.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Paths (absolute, no cwd assumptions) ───────────────────────────────────
const REPORT_AI_ROOT = path.resolve(__dirname, "..");
const SETUP_TS_PATH =
  "/Users/danielpettersson/Local sites.nosync/smyra-core/src/steps/report2/setup.ts";
const TEMPLATES_JS_PATH = path.join(
  REPORT_AI_ROOT,
  "netlify/functions/document-type-templates.js"
);
const OUTPUT_DIR = path.join(REPORT_AI_ROOT, "scripts");

// ─── Constants from the plan ────────────────────────────────────────────────
const MODULE_TYPE_CATALOG = [
  "cover",
  "text_spread",
  "kpi_grid",
  "financial_summary",
  "table",
  "back_cover",
  "ceo_letter_body",
];

const SEMANTIC_ROLE_CATALOG = [
  "executive_summary",
  "outlook",
  "challenge",
  "solution",
  "offer",
  "ceo_letter_body",
];

// User's gold-standard quarterly prose. Verbatim.
const QUARTERLY_GOLD_STANDARD = `KPI-strip 4-6 nyckeltal i rad. Highlight-sektion med bullets för viktigaste affärshändelserna. Kommentarsida med VD-bild, citat, narrativ text. Grafsektion (omsättning/resultat/kassaflöde/orderingång). Tidslinje för väsentliga händelser. Informationsrutor för formella uppgifter (MAR, revisorsgranskning, närstående, händelser efter periodens slut). Tabellsystem för finansiella rapporter med konsekvent kolumnbredd, decimalhantering, jämförelsetal. Investerarrapport med redaktionell tydlighet, inte broschyr.`;

const HAIKU_MODEL = "claude-haiku-4-5";
const TEMPERATURE = 0.3;
const MAX_TOKENS = 4096;
const CONCURRENCY = 5;

// ─── Argv parsing ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { doctypes: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--doctypes=")) {
      const v = a.slice("--doctypes=".length).trim();
      out.doctypes = v.length ? v.split(",").map((s) => s.trim()).filter(Boolean) : null;
    }
  }
  return out;
}

// ─── Parse DOC_TYPE_CATEGORIES out of setup.ts ──────────────────────────────
//
// Strategy: regex out each `{ id: '...', label: '...', description: '...' }`
// inside `const DOC_TYPE_CATEGORIES`. This is brittle but the file's shape is
// stable and we don't want to import smyra-core (TS, ESM, build dep).
async function loadDoctypeCatalog() {
  const src = await readFile(SETUP_TS_PATH, "utf8");
  const start = src.indexOf("const DOC_TYPE_CATEGORIES");
  if (start === -1) throw new Error("DOC_TYPE_CATEGORIES not found in setup.ts");
  // Find the assignment `=` then the first `[` after it. We can't just take
  // the first `[` after `start` because the type annotation `: DocCategory[]`
  // would match first.
  const eqIdx = src.indexOf("=", start);
  if (eqIdx === -1) throw new Error("Could not find `=` after DOC_TYPE_CATEGORIES");
  const arrayStart = src.indexOf("[", eqIdx);
  let depth = 0;
  let end = -1;
  for (let i = arrayStart; i < src.length; i++) {
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("Could not find end of DOC_TYPE_CATEGORIES array");
  const block = src.slice(arrayStart, end + 1);

  // Each type entry looks like:
  //   { id: 'quarterly', label: 'Quarterly report', description: 'Quarterly ...' },
  // Quotes can be ' or ". Description may contain escaped apostrophes (\').
  const entries = [];
  const re =
    /\{\s*id:\s*(['"])([^'"]+)\1\s*,\s*label:\s*(['"])((?:\\.|(?!\3).)*)\3\s*,\s*description:\s*(['"])((?:\\.|(?!\5).)*)\5\s*\}/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    entries.push({
      id: m[2],
      label: m[4].replace(/\\'/g, "'").replace(/\\"/g, '"'),
      description: m[6].replace(/\\'/g, "'").replace(/\\"/g, '"'),
    });
  }
  if (!entries.length) throw new Error("Failed to parse any doctypes from setup.ts");
  return entries;
}

// ─── Parse FALLBACK_TEMPLATES out of document-type-templates.js ─────────────
//
// We need the current required_sections + default_stub_plan per doctype.
// Approach: dynamic import of a shim module that re-exports the constant.
// The file imports from "./db.js" + "node:crypto" and only uses them in
// functions, so importing the module just to read FALLBACK_TEMPLATES is
// safe — but the file does not export it. So we do a regex-bounded slice
// + Function() eval of just the object literal.
async function loadFallbackTemplates() {
  const src = await readFile(TEMPLATES_JS_PATH, "utf8");
  const marker = "const FALLBACK_TEMPLATES =";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("FALLBACK_TEMPLATES not found");
  const objStart = src.indexOf("{", start);
  // Find matching closing brace at same depth.
  let depth = 0;
  let inStr = false;
  let strCh = "";
  let inLine = false;
  let inBlock = false;
  let end = -1;
  for (let i = objStart; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = true;
      strCh = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("Could not find end of FALLBACK_TEMPLATES object");
  const literal = src.slice(objStart, end + 1);
  // Eval as a JS expression. The literal is plain JS object syntax.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${literal});`);
  return fn();
}

// ─── Build the prompt for one doctype ───────────────────────────────────────
function buildPrompt({ doctype, fallback }) {
  const fallbackJson = JSON.stringify(
    {
      required_sections: fallback?.required_sections ?? [],
      default_stub_plan: fallback?.default_stub_plan ?? [],
    },
    null,
    2
  );

  return `You are refining a document-type template for an AI report generator.

# Doctype to refine

- id: ${doctype.id}
- label: ${doctype.label}
- description: ${doctype.description}

# Current template (the thing we want to make richer)

${fallbackJson}

# Module-type catalog (existing types you can reference)

${MODULE_TYPE_CATALOG.map((t) => `- ${t}`).join("\n")}

# Semantic-role catalog (existing roles you can reference)

${SEMANTIC_ROLE_CATALOG.map((r) => `- ${r}`).join("\n")}

# Calibration target — the level of specificity we want

The user wrote this gold-standard description for the \`quarterly\` doctype:

> ${QUARTERLY_GOLD_STANDARD}

This is the level of specificity we want for every doctype. Notice the
concrete element list: KPI-strip with 4-6 numbers, highlight bullets,
commentary spread with CEO photo+quote+narrative, graph spread (revenue/
result/cashflow/orders), event timeline, formal info-boxes (MAR, auditor
review, related parties, post-period events), tabular financial reports
with consistent column widths and comparison figures, editorial investor-
report tone (not brochure-y).

Your refinement for THIS doctype must reach a similar specificity bar for
this doctype's intent. Generic "cover + body + back_cover" is unacceptable.

# Output schema (return ONLY this JSON, no prose, no markdown fences)

{
  "document_type": "<id — must equal "${doctype.id}">",
  "required_sections": [
    {
      "module_type": "<one of the module-type catalog OR a proposed new id>",
      "label": "<Swedish label, short>",
      "required": true,
      "semantic_role": "<optional — one of the semantic-role catalog>",
      "description": "<one sentence in English: what content lives here, what shape, what tone>"
    }
  ],
  "default_stub_plan": [
    {
      "order": 1,
      "module_type": "<...>",
      "title": "<Swedish title>",
      "semantic_role": "<optional>",
      "data": {},
      "stub": true
    }
  ],
  "recommended_pages": "<one of: '1-2', '2-4', '4-6', '6-10', '8-12', '12-20'>",
  "tone_hints": "<single sentence stylistic stance>",
  "disclosures": ["<formal info block — empty array if none mandated>"],
  "proposed_module_types": ["<new module_type id you felt was needed — empty array if none>"]
}

# Rules

1. Return ONLY the JSON object. No prose, no markdown, no \`\`\` fences.
2. \`document_type\` MUST equal "${doctype.id}".
3. Every entry in \`required_sections\` should have a non-empty \`description\`.
4. \`default_stub_plan\` should reference the same set of sections (plus any
   doctype-natural extras), in the order the doctype reads top-to-bottom.
   Use \`order: 1\` for cover (when applicable) and \`order: 99\` for back_cover.
5. Prefer existing module-types + semantic_roles. Only add to
   \`proposed_module_types\` when the doctype genuinely needs a shape the
   existing catalog can't carry (e.g. \`kpi_strip\`, \`commentary\`, \`timeline\`,
   \`info_box\`, \`financial_table\`).
6. \`disclosures\` is for formal regulatory/legal info-blocks the doctype
   typically mandates (e.g. quarterly: MAR, auditor review, related parties,
   post-period events). Empty array if the doctype has none.
7. Labels and titles in Swedish (matches the existing template style).
   Descriptions in English (these are prompts read by Claude at planning time).
8. Be opinionated. A pitch deck is not the same shape as a quarterly report.
   A CEO letter is one continuous body (no cover sleeve, no back_cover). An
   onboarding guide has a different rhythm than a press release.
`;
}

// ─── Anthropic API call ─────────────────────────────────────────────────────
async function callHaiku({ apiKey, prompt, doctypeId }) {
  const body = {
    model: HAIKU_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    messages: [{ role: "user", content: prompt }],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Haiku API ${res.status} for ${doctypeId}: ${text.slice(0, 500)}`
    );
  }
  const json = await res.json();
  const text = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, usage: json.usage ?? null };
}

// Strip optional ```json fences and parse.
function parseJsonResponse(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  // First brace through last brace — defensive against trailing prose.
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    t = t.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(t);
}

// ─── Concurrency-limited batch ──────────────────────────────────────────────
async function processInBatches(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, runOne));
  return results;
}

// ─── Sanity summary line ────────────────────────────────────────────────────
function summarize(doctypeId, refined) {
  if (!refined) return `${doctypeId} → (no output)`;
  const sections = Array.isArray(refined.required_sections)
    ? refined.required_sections.length
    : 0;
  const stubs = Array.isArray(refined.default_stub_plan)
    ? refined.default_stub_plan.length
    : 0;
  const pages = refined.recommended_pages ?? "?";
  const disclosures = Array.isArray(refined.disclosures)
    ? refined.disclosures.length
    : 0;
  const proposed = Array.isArray(refined.proposed_module_types)
    ? refined.proposed_module_types.length
    : 0;
  return `${doctypeId} → ${sections} sections, ${stubs} stubs, recommended ${pages} pages, ${disclosures} disclosures, ${proposed} proposed new module_types`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "ERROR: ANTHROPIC_API_KEY is not set. Export it and re-run, e.g.\n" +
        "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "  node scripts/run-template-haiku-pass.mjs --doctypes=quarterly,ceo_letter,pitch"
    );
    process.exit(1);
  }

  const [catalog, fallbacks] = await Promise.all([
    loadDoctypeCatalog(),
    loadFallbackTemplates(),
  ]);

  let doctypes = catalog;
  if (args.doctypes && args.doctypes.length) {
    const wanted = new Set(args.doctypes);
    doctypes = catalog.filter((d) => wanted.has(d.id));
    const missing = [...wanted].filter(
      (id) => !catalog.some((d) => d.id === id)
    );
    if (missing.length) {
      console.error(
        `WARN: --doctypes contains unknown ids: ${missing.join(", ")}`
      );
    }
  }

  const isDryRun = args.doctypes !== null;
  const outputFile = path.join(
    OUTPUT_DIR,
    isDryRun ? "template-haiku-pass.dryrun.json" : "template-haiku-pass.output.json"
  );

  console.error(
    `[run-template-haiku-pass] mode=${isDryRun ? "dryrun" : "full"} ` +
      `doctypes=${doctypes.length} model=${HAIKU_MODEL} concurrency=${CONCURRENCY}`
  );

  const startedAt = Date.now();
  const results = await processInBatches(doctypes, CONCURRENCY, async (doctype) => {
    const fallback = fallbacks[doctype.id] ?? null;
    const prompt = buildPrompt({ doctype, fallback });
    const { text, usage } = await callHaiku({ apiKey, prompt, doctypeId: doctype.id });
    let refined;
    try {
      refined = parseJsonResponse(text);
    } catch (err) {
      throw new Error(
        `JSON parse failed for ${doctype.id}: ${err.message}\n` +
          `--- raw ---\n${text.slice(0, 800)}\n--- /raw ---`
      );
    }
    return { doctype, refined, usage, raw: text };
  });

  // Assemble output map keyed by doctype id; collect errors.
  const output = {};
  const errors = [];
  results.forEach((r, i) => {
    const dtId = doctypes[i].id;
    if (r.ok) {
      output[dtId] = r.value.refined;
    } else {
      errors.push({ doctype: dtId, error: r.error.message });
    }
  });

  const elapsedMs = Date.now() - startedAt;

  await writeFile(
    outputFile,
    JSON.stringify(
      {
        meta: {
          model: HAIKU_MODEL,
          temperature: TEMPERATURE,
          run_at: new Date().toISOString(),
          elapsed_ms: elapsedMs,
          mode: isDryRun ? "dryrun" : "full",
          doctype_count: doctypes.length,
          errors,
        },
        templates: output,
      },
      null,
      2
    ) + "\n"
  );

  // Stdout sanity summary.
  console.log("");
  console.log(`Wrote ${outputFile}`);
  console.log("");
  console.log("Per-doctype summary:");
  for (const dt of doctypes) {
    console.log("  " + summarize(dt.id, output[dt.id]));
  }
  if (errors.length) {
    console.log("");
    console.log("Errors:");
    for (const e of errors) console.log(`  ${e.doctype}: ${e.error}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
