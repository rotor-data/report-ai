#!/usr/bin/env node
/**
 * Dry-run + apply tool for cleaning up legacy brand_components.
 *
 * Problem: components designed before the design-components validator
 * was strengthened may carry:
 *   - <div class="hdg-*" | "title-*" | "heading-*"> where <hN> belongs
 *   - hex / rgb colors in inline style= or css_template
 *   - fill="#xxx" / stroke="#xxx" on SVG shapes
 *   - hardcoded font-size in px/pt/% instead of .t-* classes
 *
 * What this tool does:
 *   DRY-RUN (default): scans brand_components, prints every component
 *     that fails each rule, proposes a rewrite (where automatable),
 *     writes the report to stdout. No DB writes.
 *   APPLY (--apply): rewrites the rows that have an automatable fix.
 *     Prints a summary of changes + which rows were skipped.
 *
 * Usage:
 *   node scripts/cleanup-legacy-components.mjs              # dry-run
 *   node scripts/cleanup-legacy-components.mjs --apply      # commit changes
 *   node scripts/cleanup-legacy-components.mjs --brand <uuid>   # limit to one brand
 *   node scripts/cleanup-legacy-components.mjs --type heading   # limit to one component_type
 *
 * Safe to re-run. Idempotent — each rewrite checks the pre-condition.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

// Minimal .env loader
try {
  const env = readFileSync(resolve('.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const url = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('NEON_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const brandFilter = (() => {
  const i = args.indexOf('--brand');
  return i >= 0 ? args[i + 1] : null;
})();
const typeFilter = (() => {
  const i = args.indexOf('--type');
  return i >= 0 ? args[i + 1] : null;
})();

// ─── Rule registry ──────────────────────────────────────────────────

/**
 * Rewrite <div|span|p class="hdg-… | headline-… | title-… | chapter-title | cov-title" …>
 * into <hN>. Picks the level from component_type + class hints:
 *   cover / back_cover / chapter_break title class → h1
 *   section titles → h2
 *   sub-headings / overline → h3
 */
function rewriteHeadingTags(html, componentType) {
  if (!html) return { html, changed: 0 };
  const HEADING_CLASS_RE =
    /<(div|span|p)\b([^>]*class="[^"]*\b(?:hdg|heading|headline|title-big|title-text|section-title|cov-title|chap-title|chapter-title)\b[^"]*"[^>]*)>([\s\S]*?)<\/\1>/gi;
  let changed = 0;
  const nextHtml = html.replace(HEADING_CLASS_RE, (_match, tag, attrs, inner) => {
    const classMatch = attrs.match(/class="([^"]*)"/);
    const cls = classMatch ? classMatch[1] : '';
    let level = 2;
    if (/cov-title|title-big|headline/.test(cls)) level = 1;
    else if (/chap-title|chapter-title|section-title/.test(cls)) level = 2;
    else if (/hdg/.test(cls) || /overline|eyebrow/.test(cls)) level = 3;
    // Component role can promote
    if (componentType === 'cover' || componentType === 'back_cover') level = 1;
    else if (componentType === 'chapter_break') level = 2;
    changed++;
    return `<h${level}${attrs}>${inner}</h${level}>`;
  });
  return { html: nextHtml, changed };
}

/**
 * Find non-neutral hex/rgb values in style="…" attributes + css body.
 * Reports them but does NOT automatically rewrite — remapping color →
 * token requires knowing brand intent, which is author territory.
 */
function findHardcodedColors(text) {
  if (!text) return [];
  const hits = [];
  const styleHits = Array.from(text.matchAll(/style="([^"]*)"/g)).map((m) => m[1]);
  for (const style of styleHits) {
    const hexes = style.match(/#[0-9a-fA-F]{3,8}/g) || [];
    const rgbs = style.match(/rgba?\([^)]+\)/g) || [];
    for (const v of [...hexes, ...rgbs]) if (!isNeutralColor(v)) hits.push(v);
  }
  // SVG fill/stroke
  const fillHits = Array.from(text.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))"/gi)).map((m) => m[1]);
  for (const v of fillHits) if (!isNeutralColor(v)) hits.push(v);
  return [...new Set(hits)];
}

function isNeutralColor(value) {
  const v = value.toLowerCase().replace(/\s+/g, '');
  if (v === '#fff' || v === '#ffffff' || v === '#000' || v === '#000000') return true;
  if (/^rgba?\(0,0,0,0(?:\.\d+)?\)$/.test(v)) return true;
  const g3 = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (g3 && g3[1] === g3[2] && g3[2] === g3[3]) return true;
  const g6 = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (g6 && g6[1] === g6[2] && g6[2] === g6[3]) return true;
  return false;
}

/**
 * Rewrite obvious SVG fill/stroke = hex → currentColor. Safe because
 * the container SVG can then be colored via a wrapper `style="color: var(--primary)"`.
 * Keeps multi-color SVGs untouched (we only swap when at most one
 * non-neutral color exists — otherwise we risk flattening a 2-tone icon).
 */
function rewriteSvgFills(html) {
  if (!html) return { html, changed: 0 };
  let changed = 0;
  const next = html.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => {
    const fills = new Set();
    svg.replace(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/gi, (_m, v) => {
      if (!isNeutralColor(v)) fills.add(v.toLowerCase());
      return _m;
    });
    if (fills.size === 0 || fills.size > 1) return svg; // don't touch multi-color
    const target = fills.values().next().value;
    const rewritten = svg.replace(
      new RegExp(`(fill|stroke)="${target}"`, 'gi'),
      '$1="currentColor"'
    );
    // Seed a color inline so the swap still paints
    const withColor = rewritten.replace(/<svg\b/i, '<svg style="color: var(--primary)" ');
    if (withColor !== svg) changed++;
    return withColor;
  });
  return { html: next, changed };
}

/**
 * Count hardcoded font-size declarations (px/pt/% only — em/rem/calc
 * are fine).
 */
function countHardFontSizes(text) {
  if (!text) return 0;
  const hits = text.match(/font-size\s*:\s*\d+(?:\.\d+)?(?:px|pt|%)/gi) || [];
  return hits.length;
}

// ─── Main ───────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: url });

async function main() {
  const whereClauses = [];
  const params = [];
  let idx = 1;
  if (brandFilter) {
    whereClauses.push(`brand_id = $${idx++}`);
    params.push(brandFilter);
  }
  if (typeFilter) {
    whereClauses.push(`component_type = $${idx++}`);
    params.push(typeFilter);
  }
  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  console.log(`Mode: ${APPLY ? 'APPLY (writing!)' : 'DRY-RUN (no DB writes)'}`);
  console.log(`Scanning brand_components${brandFilter ? ` for brand ${brandFilter}` : ''}${typeFilter ? ` (type: ${typeFilter})` : ''}…\n`);

  const { rows } = await pool.query(
    `SELECT id, brand_id, component_type, variant_name, label, html_template, css_template
     FROM brand_components ${where}
     ORDER BY brand_id, component_type, variant_name`,
    params
  );
  console.log(`Found ${rows.length} components.\n`);

  let totalViolations = 0;
  let totalFixed = 0;
  let totalNeedsManual = 0;
  const summary = { heading_semantics: 0, hardcoded_colors: 0, hardcoded_font_sizes: 0, svg_fills: 0 };

  for (const row of rows) {
    const html = row.html_template || '';
    const css = row.css_template || '';
    const issues = [];
    let nextHtml = html;
    let rewroteHtml = false;

    // Rule 1: heading semantics
    const { html: htmlAfterHeadings, changed: headingChanges } = rewriteHeadingTags(nextHtml, row.component_type);
    if (headingChanges > 0) {
      issues.push(`${headingChanges} heading tag(s) would swap <div|span|p> → <hN>`);
      summary.heading_semantics += headingChanges;
      nextHtml = htmlAfterHeadings;
      rewroteHtml = true;
    }

    // Rule 2: SVG fills
    const { html: htmlAfterSvg, changed: svgChanges } = rewriteSvgFills(nextHtml);
    if (svgChanges > 0) {
      issues.push(`${svgChanges} SVG(s) would have fill/stroke swapped to currentColor`);
      summary.svg_fills += svgChanges;
      nextHtml = htmlAfterSvg;
      rewroteHtml = true;
    }

    // Rule 3: hardcoded colors (informational — manual fix)
    const hardColors = findHardcodedColors(html + '\n' + css);
    if (hardColors.length > 0) {
      issues.push(`${hardColors.length} hardcoded color(s) (needs manual token remap): ${hardColors.slice(0, 3).join(', ')}${hardColors.length > 3 ? '…' : ''}`);
      summary.hardcoded_colors += hardColors.length;
      totalNeedsManual++;
    }

    // Rule 4: hardcoded font-size
    const hardSizes = countHardFontSizes(html + '\n' + css);
    if (hardSizes > 2) {
      issues.push(`${hardSizes} hardcoded font-size values (use .t-* classes instead — manual fix)`);
      summary.hardcoded_font_sizes += hardSizes;
    }

    if (issues.length === 0) continue;

    totalViolations++;
    console.log(`\n── [${row.component_type}/${row.variant_name || 'Default'}] ${row.label || row.id}`);
    console.log(`   brand: ${row.brand_id}`);
    for (const issue of issues) console.log(`   • ${issue}`);

    if (rewroteHtml && APPLY) {
      await pool.query(
        `UPDATE brand_components SET html_template = $1 WHERE id = $2`,
        [nextHtml, row.id]
      );
      totalFixed++;
      console.log(`   ✔ applied automated fixes`);
    }
  }

  console.log('\n');
  console.log('─'.repeat(60));
  console.log('SUMMARY');
  console.log('─'.repeat(60));
  console.log(`Components with issues:    ${totalViolations}`);
  console.log(`Heading tags rewritten:    ${summary.heading_semantics}`);
  console.log(`SVG fills rewritten:       ${summary.svg_fills}`);
  console.log(`Hardcoded colors (manual): ${summary.hardcoded_colors}`);
  console.log(`Hardcoded font-sizes:      ${summary.hardcoded_font_sizes}`);
  if (APPLY) {
    console.log(`\n✔ Applied automated fixes to ${totalFixed} components.`);
  } else {
    console.log(`\nDRY-RUN: no DB writes. Re-run with --apply to commit.`);
  }
  if (summary.hardcoded_colors + summary.hardcoded_font_sizes > 0) {
    console.log(`\n⚠ ${totalNeedsManual} component(s) have hardcoded values that can't be safely automated.`);
    console.log(`  Redesign them in the component-design workflow or edit html_template / css_template directly.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
