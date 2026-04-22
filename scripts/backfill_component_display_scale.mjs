#!/usr/bin/env node
/**
 * backfill_component_display_scale.mjs
 *
 * Wraps display-size font-size declarations inside display-type CSS selectors
 * with `calc(VALUE * var(--display-scale, 1))` so that the art-direct
 * `--display-scale` tweak actually scales display type in rendered output.
 *
 * Only touches brand_components rows for the Rotor brand.
 * Idempotent — already-wrapped rules are skipped.
 *
 * Usage:
 *   node scripts/backfill_component_display_scale.mjs           # dry-run
 *   node scripts/backfill_component_display_scale.mjs --apply   # commit changes
 *
 * Pattern:
 *   Selectors matching /__title|__heading|__hdg|__value|__display|__quote|__kicker|__hero/
 *   are treated as display-type. Within those selector blocks, any
 *   `font-size: VALUE` that isn't already wrapped is rewritten to
 *   `font-size: calc(VALUE * var(--display-scale, 1))`.
 *
 *   Preserves !important flags and all other declarations on the same line.
 *   Does not touch selectors that don't match the display-type regex.
 *
 * NOTE on single-line multi-declaration CSS:
 *   Many blocks use compact style: `.foo { font-size: 36px; line-height: 1; }`
 *   The font-size value is extracted by matching from "font-size:" up to the
 *   first ";", "}" or end-of-string — not end-of-line.
 */

import { neon } from '/Users/danielpettersson/Local sites.nosync/rotor-platform-hub/node_modules/@neondatabase/serverless/index.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── .env loader ────────────────────────────────────────────────────────────

try {
  const env = readFileSync(resolve('/Users/danielpettersson/Local sites.nosync/report-ai/.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const DB_URL = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('NEON_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const BRAND_ID = '6d6f0f84-ce38-4f06-961f-45d6bdd640bb';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

if (!APPLY) {
  console.log('[dry-run] Pass --apply to commit changes to the database.\n');
}

// ─── Regex constants ─────────────────────────────────────────────────────────

/**
 * Selectors that are considered "display-type" — titles, big KPI values,
 * pullquote text, hero text, etc. Rules inside blocks matching these
 * selector patterns will have their font-size wrapped.
 */
const DISPLAY_SELECTOR_RE = /__title|__heading|__hdg|__value|__display|__quote|__kicker|__hero/;

// ─── Core transform ───────────────────────────────────────────────────────────

/**
 * Parse css_template into an array of tokens:
 *   { type: 'block', selector: string, open: string, body: string, close: string, raw: string }
 *   { type: 'gap', text: string }  ← whitespace/comments between blocks
 *
 * The selector includes ALL text between the previous } and the {, verbatim
 * (including inter-block whitespace and comments). This allows us to
 * reconstruct the original CSS exactly when not changing a block.
 *
 * Only parses top-level blocks (depth 0→1). Nested { } (e.g. inside @media)
 * are kept as part of the body string verbatim.
 *
 * Returns array of tokens.
 */
function tokenize(css) {
  const tokens = [];
  let i = 0;
  let blockStart = 0; // start of current block (= end of previous })
  let selectorEnd = -1;
  let depth = 0;

  while (i < css.length) {
    const ch = css[i];

    if (ch === '{') {
      if (depth === 0) {
        selectorEnd = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && selectorEnd >= 0) {
        // Complete top-level block found: [blockStart .. i]
        const selectorRaw = css.slice(blockStart, selectorEnd); // includes preceding gap
        const body = css.slice(selectorEnd + 1, i);
        const raw = css.slice(blockStart, i + 1);
        tokens.push({
          type: 'block',
          selectorRaw,          // everything before the `{` (may include comments/whitespace)
          selector: selectorRaw.trim(), // trimmed, for matching
          body,
          raw,
          start: blockStart,
          end: i + 1,
        });
        blockStart = i + 1;
        selectorEnd = -1;
      }
    }
    i++;
  }

  // Trailing text after last block (e.g. whitespace, comments, malformed CSS)
  const trailing = css.slice(blockStart);
  if (trailing.length > 0) {
    tokens.push({ type: 'trailing', text: trailing });
  }

  return tokens;
}

/**
 * Wrap a single font-size value (already extracted, no leading/trailing spaces)
 * with calc(... * var(--display-scale, 1)).
 *
 * Handles:
 *   - plain values: 36px → calc(36px * var(--display-scale, 1))
 *   - clamp(): clamp(88px, 18cqw, 180px) → calc(clamp(...) * var(--display-scale, 1))
 *   - !important: 36px !important → calc(36px * var(--display-scale, 1)) !important
 *
 * Returns null if value is already wrapped (contains var(--display-scale) or starts with calc(
 * containing var(--display-scale).
 */
function wrapValue(value) {
  // Belt-and-suspenders: skip if already wrapped
  if (value.includes('var(--display-scale')) return null;

  // Extract optional !important suffix
  const importantMatch = value.match(/^([\s\S]*?)\s*(!important)\s*$/i);
  let core, important;
  if (importantMatch) {
    core = importantMatch[1].trim();
    important = ' !important';
  } else {
    core = value.trim();
    important = '';
  }

  if (!core) return null;

  // Already a calc() that doesn't contain display-scale — wrap it too
  // (e.g. calc(var(--base) * 1.2) → calc(calc(...) * var(--display-scale, 1)))
  return `calc(${core} * var(--display-scale, 1))${important}`;
}

/**
 * Given a CSS block body string (text between { and }), find all font-size
 * declarations and wrap the ones in display-type blocks.
 *
 * Key challenge: CSS declarations may be on a single line with multiple props:
 *   `font-size: 36px; line-height: 1; letter-spacing: -0.02em`
 *
 * We use a regex that matches `font-size: VALUE` where VALUE ends at the first
 * semicolon, `}`, or end-of-string.
 *
 * Returns { body: string, wrappedCount: number }.
 */
function wrapFontSizesInBody(body) {
  let wrappedCount = 0;

  // Regex: match font-size: VALUE  where VALUE is everything up to (but not including)
  // the first ; or } (which might be on the same line for compact CSS).
  // Does NOT match if "var(--display-scale" already appears in VALUE.
  // Flags: g (global), captures the value for manipulation.
  const result = body.replace(
    /\bfont-size\s*:\s*((?:(?!var\(--display-scale)[^;{}])+?)\s*(?=;|}|$)/g,
    (match, rawValue) => {
      const value = rawValue.trim();
      if (!value) return match;

      const wrapped = wrapValue(value);
      if (wrapped === null) return match; // already wrapped or empty

      wrappedCount++;
      // Reconstruct: preserve original spacing between "font-size: " and the value
      const propAndSpace = match.slice(0, match.indexOf(rawValue));
      return `${propAndSpace}${wrapped}`;
    }
  );

  return { body: result, wrappedCount };
}

/**
 * Main transform: given a full css_template string, tokenize into blocks,
 * find display-type selector blocks, and wrap their font-size rules.
 *
 * Returns { css: string, totalWrapped: number, rulesPerBlock: {selector, count}[] }.
 */
function transformCssTemplate(css) {
  if (!css || !css.trim()) return { css, totalWrapped: 0, rulesPerBlock: [] };

  const tokens = tokenize(css);
  let totalWrapped = 0;
  const rulesPerBlock = [];
  const parts = [];

  for (const token of tokens) {
    if (token.type === 'trailing') {
      parts.push(token.text);
      continue;
    }

    const { selectorRaw, selector, body, end } = token;
    const isDisplayType = DISPLAY_SELECTOR_RE.test(selector);

    if (isDisplayType) {
      const { body: newBody, wrappedCount } = wrapFontSizesInBody(body);
      if (wrappedCount > 0) {
        totalWrapped += wrappedCount;
        // Use a cleaned selector for reporting (last non-empty token of selectorRaw)
        const cleanSelector = selector.split(/\n/).filter(l => l.trim()).pop()?.trim() ?? selector;
        rulesPerBlock.push({ selector: cleanSelector, count: wrappedCount });
      }
      // Reconstruct block verbatim except for body
      parts.push(`${selectorRaw}{${newBody}}`);
    } else {
      // Preserve verbatim
      parts.push(token.raw);
    }
  }

  return {
    css: parts.join(''),
    totalWrapped,
    rulesPerBlock,
  };
}

/**
 * Count how many font-size declarations exist inside display-type selector blocks.
 * Used for "X/Y rules" reporting.
 */
function countFontSizeRulesInDisplayBlocks(css) {
  if (!css) return 0;
  const tokens = tokenize(css);
  let count = 0;
  for (const token of tokens) {
    if (token.type !== 'block') continue;
    if (!DISPLAY_SELECTOR_RE.test(token.selector)) continue;
    const matches = token.body.match(/\bfont-size\s*:/g);
    if (matches) count += matches.length;
  }
  return count;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const sql = neon(DB_URL);

  console.log(`Fetching brand_components for brand_id=${BRAND_ID}...\n`);

  const rows = await sql`
    SELECT id, component_type, variant_name, css_template
    FROM brand_components
    WHERE brand_id = ${BRAND_ID}
      AND css_template IS NOT NULL
      AND css_template != ''
    ORDER BY component_type, variant_name
  `;

  console.log(`Found ${rows.length} rows with css_template.\n`);

  let rowsUpdated = 0;
  let totalRulesWrapped = 0;
  let rowsWithChanges = 0;

  for (const row of rows) {
    const { id, component_type, variant_name, css_template } = row;
    const label = `${component_type}/${variant_name ?? '(default)'}`;

    const { css: newCss, totalWrapped, rulesPerBlock } = transformCssTemplate(css_template);

    if (totalWrapped === 0) {
      // No changes needed — either no display-type rules or all already wrapped
      continue;
    }

    rowsWithChanges++;
    totalRulesWrapped += totalWrapped;

    // Count total font-size rules in display-type blocks (for "X/Y" reporting)
    const totalFontSizeRules = countFontSizeRulesInDisplayBlocks(css_template);

    console.log(`  Updated ${totalWrapped}/${totalFontSizeRules} rules in ${label}`);
    for (const { selector, count } of rulesPerBlock) {
      console.log(`    selector: ${selector.slice(0, 80).replace(/\n/g, ' ')} → ${count} rule(s)`);
    }

    if (APPLY) {
      await sql`
        UPDATE brand_components
        SET css_template = ${newCss}, updated_at = NOW()
        WHERE id = ${id}
      `;
      rowsUpdated++;
    }
  }

  console.log('\n─────────────────────────────────────────────────────────');
  if (APPLY) {
    console.log(`Done. Rows updated: ${rowsUpdated}. Total rules wrapped: ${totalRulesWrapped}.`);
  } else {
    console.log(`Dry-run complete. Would update ${rowsWithChanges} rows, wrapping ${totalRulesWrapped} rules.`);
    console.log('Re-run with --apply to commit changes.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
