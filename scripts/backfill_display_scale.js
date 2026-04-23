#!/usr/bin/env node
/**
 * backfill_display_scale.js
 *
 * Retrofits existing brand_components.css_template rows so every display-size
 * `font-size` declaration is wrapped in `calc(X * var(--display-scale, 1))`.
 * Smart Theming (theme_reconcile) uses --display-scale to scale typography
 * per-module, but it only affects rules that are already wrapped. This script
 * finds unwrapped rules using a selector/value heuristic and rewrites them.
 *
 * Usage:
 *   node scripts/backfill_display_scale.js              # dry-run (default)
 *   node scripts/backfill_display_scale.js --dry-run    # explicit dry-run
 *   node scripts/backfill_display_scale.js --apply      # actually UPDATE
 *
 * DATABASE_URL resolution:
 *   1. process.env.DATABASE_URL
 *   2. process.env.NEON_DATABASE_URL
 *   3. /Users/danielpettersson/Local sites.nosync/report-ai/.env
 *   4. /Users/danielpettersson/Local sites.nosync/report-ai/.env.local
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRAND_ID = '6d6f0f84-ce38-4f06-961f-45d6bdd640bb';
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const DEBUG_SAMPLE = 5;

/* ---------- env ---------- */

function loadEnvFromFile(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
  return true;
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.NEON_DATABASE_URL) return process.env.NEON_DATABASE_URL;
  const candidates = [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '.env.local'),
  ];
  for (const f of candidates) {
    if (loadEnvFromFile(f)) {
      if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
      if (process.env.NEON_DATABASE_URL) return process.env.NEON_DATABASE_URL;
    }
  }
  return null;
}

/* ---------- CSS parsing ---------- */

/**
 * Split a css_template into top-level rules {selector, body}. Uses a
 * brace-depth parser so nested blocks (@media, @supports) are kept as a
 * single rule (we do not descend into them here — good enough for
 * backfill because component templates rarely nest, and nested rules are
 * forwarded verbatim).
 */
function splitRules(css) {
  const rules = [];
  let depth = 0;
  let selStart = 0;
  let bodyStart = -1;
  let inStr = null;

  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (inStr) {
      if (c === inStr && css[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const selector = css.slice(selStart, bodyStart).trim();
        const body = css.slice(bodyStart + 1, i);
        rules.push({
          selector,
          body,
          start: selStart,
          end: i + 1,
          bodyStart: bodyStart + 1,
          bodyEnd: i,
        });
        selStart = i + 1;
        bodyStart = -1;
      }
    }
  }
  return rules;
}

/* ---------- decision logic ---------- */

const DISPLAY_SELECTOR_RE =
  /__(title|heading|value|display|big|hero|lead|main|head|kicker|sub|h\d|num|company|headline|org|statement|caption|intro|body)\b|\b(h1|h2|h3)\b/i;

/** Returns numeric magnitude in rough px-equivalents, or null if not numeric. */
function valueMagnitude(val) {
  const m = val.match(/(-?\d+(?:\.\d+)?)\s*(px|pt|rem|em|cqw|cqh|cqi|vw|vh|%)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return { n, unit };
}

function isLargeEnough(val) {
  const mag = valueMagnitude(val);
  if (!mag) return false;
  const { n, unit } = mag;
  switch (unit) {
    case 'px':
      return n >= 18;
    case 'pt':
      return n >= 14;
    case 'rem':
    case 'em':
      return n >= 1.2;
    case 'cqw':
    case 'cqh':
    case 'cqi':
      return n >= 4;
    default:
      return false;
  }
}

function isPlainCssVar(val) {
  // Treat a trimmed value that is exactly `var(--something)` (no calc, no
  // arithmetic) as already scalable — the consuming variable can be
  // redefined per-module.
  const t = val.trim();
  return /^var\(\s*--[a-z0-9-]+(?:\s*,\s*[^)]+)?\s*\)$/i.test(t);
}

function hasDisplayScale(val) {
  return /var\(\s*--display-scale\b/.test(val);
}

function isClamp(val) {
  return /^\s*clamp\s*\(/i.test(val);
}

function shouldWrap(selector, val) {
  if (hasDisplayScale(val)) return false;
  if (isPlainCssVar(val)) return false;
  if (isClamp(val)) return true;
  if (DISPLAY_SELECTOR_RE.test(selector)) return true;
  if (isLargeEnough(val)) return true;
  return false;
}

function wrapValue(orig) {
  const trimmed = orig.trim();
  if (/\bcalc\s*\(/i.test(trimmed)) {
    return `calc((${trimmed}) * var(--display-scale, 1))`;
  }
  return `calc(${trimmed} * var(--display-scale, 1))`;
}

/* ---------- rewrite a single rule body ---------- */

const FONT_SIZE_RE = /(^|[\s;])font-size\s*:\s*([^;]+?)\s*;/gi;

function retrofitRuleBody(selector, body) {
  let changed = 0;
  const diffs = [];
  const out = body.replace(FONT_SIZE_RE, (match, lead, value) => {
    if (!shouldWrap(selector, value)) return match;
    const wrapped = wrapValue(value);
    changed++;
    diffs.push({ before: value.trim(), after: wrapped });
    return `${lead}font-size: ${wrapped};`;
  });
  return { body: out, changed, diffs };
}

function retrofitCssTemplate(css) {
  const rules = splitRules(css);
  if (!rules.length) {
    // Not a simple rule list; fall back to single-pass replace with a
    // synthetic selector ("") so only magnitude/clamp heuristics apply.
    const { body, changed, diffs } = retrofitRuleBody('', css);
    return { css: body, changed, diffs };
  }

  let out = '';
  let cursor = 0;
  let totalChanged = 0;
  const allDiffs = [];

  for (const rule of rules) {
    out += css.slice(cursor, rule.bodyStart);
    const { body, changed, diffs } = retrofitRuleBody(rule.selector, rule.body);
    out += body;
    out += css.slice(rule.bodyEnd, rule.end);
    cursor = rule.end;
    totalChanged += changed;
    for (const d of diffs) allDiffs.push({ selector: rule.selector, ...d });
  }
  out += css.slice(cursor);

  return { css: out, changed: totalChanged, diffs: allDiffs };
}

/* ---------- main ---------- */

async function main() {
  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    console.error(
      '[backfill_display_scale] No database URL found.\n' +
        '  Set DATABASE_URL or NEON_DATABASE_URL, or add one to .env / .env.local\n' +
        '  in /Users/danielpettersson/Local sites.nosync/report-ai/.'
    );
    process.exit(1);
  }

  const sql = neon(dbUrl);

  console.log(
    `[backfill_display_scale] Mode: ${APPLY ? 'APPLY (writes will run)' : 'DRY-RUN (no writes)'}`
  );
  console.log(`[backfill_display_scale] Brand: ${BRAND_ID}`);

  const rows = await sql`
    SELECT id, component_type, variant_name, label, css_template, version
    FROM brand_components
    WHERE brand_id = ${BRAND_ID}
      AND css_template IS NOT NULL
  `;

  console.log(`[backfill_display_scale] Loaded ${rows.length} components.`);

  let componentsChanged = 0;
  let rulesRetrofitted = 0;
  const samples = [];

  for (const row of rows) {
    const css = row.css_template || '';
    const { css: newCss, changed, diffs } = retrofitCssTemplate(css);
    if (changed === 0) continue;

    componentsChanged++;
    rulesRetrofitted += changed;

    if (samples.length < DEBUG_SAMPLE) {
      samples.push({
        id: row.id,
        type: row.component_type,
        variant: row.variant_name,
        label: row.label,
        changed,
        diffs,
        before: css,
        after: newCss,
      });
    }

    if (APPLY) {
      await sql`
        UPDATE brand_components
        SET css_template = ${newCss},
            version = version + 1,
            updated_at = now()
        WHERE id = ${row.id}
      `;
    }
  }

  console.log('');
  console.log('==== Summary ====');
  console.log(`Components seen:         ${rows.length}`);
  console.log(`Components changed:      ${componentsChanged}`);
  console.log(`font-size rules wrapped: ${rulesRetrofitted}`);
  console.log(`Mode:                    ${APPLY ? 'APPLIED' : 'DRY-RUN (no writes)'}`);

  if (samples.length) {
    console.log('');
    console.log(`==== Sample diffs (first ${samples.length}) ====`);
    for (const s of samples) {
      console.log('');
      console.log(
        `- [${s.type} / ${s.variant}] ${s.label || ''}  (${s.changed} change${s.changed === 1 ? '' : 's'})`
      );
      for (const d of s.diffs.slice(0, 6)) {
        console.log(`    selector: ${d.selector}`);
        console.log(`      before: font-size: ${d.before};`);
        console.log(`      after:  font-size: ${d.after};`);
      }
      if (s.diffs.length > 6) {
        console.log(`    ... (${s.diffs.length - 6} more in this component)`);
      }
    }
  }

  if (DRY_RUN && rulesRetrofitted > 0) {
    console.log('');
    console.log('Re-run with --apply to persist these changes.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill_display_scale] Error:', err);
  process.exit(1);
});
