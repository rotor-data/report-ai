#!/usr/bin/env node
/**
 * split-display-variants.mjs
 *
 * Creates "Compact" twins of oversized heading + pullquote variants in
 * the Rotor brand component library so they fit inline alongside body/KPI
 * content on the same page.
 *
 * Usage:
 *   node scripts/split-display-variants.mjs              # dry-run
 *   node scripts/split-display-variants.mjs --apply      # write changes
 *
 * Rules:
 *   - Only touches component_type IN ('heading','pullquote') for Rotor brand.
 *   - A variant qualifies if its css_template contains a font-size >= 60px
 *     or >= 36pt (wrapped in calc(... * var(--display-scale, 1)) or bare).
 *   - Special case: pullquote/Marks 180px quote-glyph -> 80px.
 *   - Scales qualifying font-sizes by 0.42 (px) or 0.45 (pt).
 *   - Shrinks .tx / .tx-* outer padding 72px 64px -> 24px 32px.
 *   - Bumps tight line-heights (0.88 / 0.92 -> 1.0, 0.95 -> 1.05).
 *   - Inserts a new row with variant_name = '<original> — Compact',
 *     status=ready, is_default=true; demotes the original to is_default=false.
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

const BRAND_ID = '6d6f0f84-ce38-4f06-961f-45d6bdd640bb'; // Rotor
const APPLY = process.argv.includes('--apply');

function loadDbUrl() {
  const envText = readFileSync(ENV_PATH, 'utf8');
  const line = envText.split('\n').find(l => l.startsWith('NEON_DATABASE_URL='));
  if (!line) throw new Error('NEON_DATABASE_URL not found in .env');
  return line.slice('NEON_DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
}

/** Transform a single css_template string. Returns { css, changes[] }. */
function transformCss(css, { componentType, variantName }) {
  let out = css;
  const changes = [];

  // 1. calc(Npx * var(--display-scale...)) where N >= 60
  out = out.replace(
    /calc\(\s*(\d+(?:\.\d+)?)px\s*\*\s*var\(\s*--display-scale[^)]*\)\s*\)/g,
    (match, nStr) => {
      const n = parseFloat(nStr);
      if (n < 60) return match;
      const next = Math.round(n * 0.42);
      changes.push(`calc(${n}px * --display-scale) -> calc(${next}px * --display-scale)`);
      return `calc(${next}px * var(--display-scale, 1))`;
    }
  );

  // 2. calc(Npt * var(--display-scale...)) where N >= 36
  out = out.replace(
    /calc\(\s*(\d+(?:\.\d+)?)pt\s*\*\s*var\(\s*--display-scale[^)]*\)\s*\)/g,
    (match, nStr) => {
      const n = parseFloat(nStr);
      if (n < 36) return match;
      const next = Math.round(n * 0.45);
      changes.push(`calc(${n}pt * --display-scale) -> calc(${next}pt * --display-scale)`);
      return `calc(${next}pt * var(--display-scale, 1))`;
    }
  );

  // 3. Bare `Npx` in a font-size declaration where N >= 60
  //    Special: pullquote/Marks uses 180px on a ::before glyph -> 80px explicitly.
  out = out.replace(
    /font-size:\s*(\d+(?:\.\d+)?)px/g,
    (match, nStr) => {
      const n = parseFloat(nStr);
      if (n < 60) return match;
      let next;
      if (n === 180) {
        next = 80;
      } else {
        next = Math.round(n * 0.42);
      }
      changes.push(`font-size: ${n}px -> ${next}px`);
      return `font-size: ${next}px`;
    }
  );

  // 4. Bare `Npt` in font-size where N >= 36
  out = out.replace(
    /font-size:\s*(\d+(?:\.\d+)?)pt/g,
    (match, nStr) => {
      const n = parseFloat(nStr);
      if (n < 36) return match;
      const next = Math.round(n * 0.45);
      changes.push(`font-size: ${n}pt -> ${next}pt`);
      return `font-size: ${next}pt`;
    }
  );

  // 5. Outer padding on `.tx { padding: 72px 64px ... }` and `.tx-* { padding: 72px 64px ... }`.
  //    Match `.tx` or `.tx-<word>` at the START of a selector (optionally followed
  //    by descendant combinators / pseudo) that directly contains the 72px 64px rule.
  //    Conservative: only touch exact 72px 64px pair in the first padding decl.
  const paddingRegex = /(\.tx[\w-]*\s*\{\s*(?:[^{}]*?))padding:\s*72px\s+64px\s*;?/g;
  out = out.replace(paddingRegex, (match, prefix) => {
    changes.push(`padding: 72px 64px -> padding: 24px 32px`);
    return `${prefix}padding: 24px 32px;`;
  });

  // 6. Tight line-heights near scaled-down font-sizes.
  //    Safe global replace — these tight values only exist on the big display types.
  out = out.replace(/line-height:\s*0\.88\b/g, () => {
    changes.push(`line-height: 0.88 -> 1.0`);
    return `line-height: 1.0`;
  });
  out = out.replace(/line-height:\s*0\.92\b/g, () => {
    changes.push(`line-height: 0.92 -> 1.0`);
    return `line-height: 1.0`;
  });
  out = out.replace(/line-height:\s*0\.95\b/g, () => {
    changes.push(`line-height: 0.95 -> 1.05`);
    return `line-height: 1.05`;
  });

  return { css: out, changes };
}

/** Decide whether a variant qualifies (has a >=60px/>=36pt font-size). */
function qualifies(css) {
  if (!css) return false;
  // >=60 px in calc(...) or bare font-size
  const calcPx = /calc\(\s*(\d+(?:\.\d+)?)px\s*\*\s*var\(\s*--display-scale/g;
  const barePx = /font-size:\s*(\d+(?:\.\d+)?)px/g;
  const calcPt = /calc\(\s*(\d+(?:\.\d+)?)pt\s*\*\s*var\(\s*--display-scale/g;
  const barePt = /font-size:\s*(\d+(?:\.\d+)?)pt/g;
  for (const re of [calcPx, barePx]) {
    for (const m of css.matchAll(re)) {
      if (parseFloat(m[1]) >= 60) return true;
    }
  }
  for (const re of [calcPt, barePt]) {
    for (const m of css.matchAll(re)) {
      if (parseFloat(m[1]) >= 36) return true;
    }
  }
  return false;
}

async function main() {
  const dbUrl = loadDbUrl();
  const sql = neon(dbUrl);

  const rows = await sql`
    SELECT id, component_type, variant_name, is_default, status, splittable,
           html_template, css_template, placeholder_schema, design_notes,
           source, extraction_id, is_public, unsplash_query,
           reference_page_numbers, page_format,
           harmony, intensity, accent_usage, content_tolerance,
           chart_schema, chart_color_mode, style_family
      FROM brand_components
     WHERE brand_id = ${BRAND_ID}
       AND component_type IN ('heading','pullquote')
     ORDER BY component_type, variant_name
  `;

  // Guard: skip variants whose name already includes 'Compact' (idempotency).
  const existingCompactKeys = new Set(
    rows
      .filter(r => /Compact/i.test(r.variant_name || ''))
      .map(r => `${r.component_type}::${r.variant_name}`)
  );

  const toCreate = [];
  const toSkip = [];

  for (const r of rows) {
    const name = r.variant_name || 'Default';
    if (/Compact/i.test(name)) {
      toSkip.push({ row: r, reason: 'already a Compact variant' });
      continue;
    }
    const compactName = `${name} — Compact`;
    const compactKey = `${r.component_type}::${compactName}`;
    if (existingCompactKeys.has(compactKey)) {
      toSkip.push({ row: r, reason: 'Compact twin already exists' });
      continue;
    }
    if (!qualifies(r.css_template)) {
      toSkip.push({ row: r, reason: 'no font-size above threshold' });
      continue;
    }
    const { css: newCss, changes } = transformCss(r.css_template, {
      componentType: r.component_type,
      variantName: name,
    });
    if (!changes.length) {
      toSkip.push({ row: r, reason: 'transformation produced no changes' });
      continue;
    }
    toCreate.push({ row: r, compactName, newCss, changes });
  }

  // ---- Summary ----
  console.log('');
  console.log(`Brand: ${BRAND_ID} (Rotor)`);
  console.log(`Scanned: ${rows.length} heading/pullquote variants`);
  console.log(`Will create Compact twins: ${toCreate.length}`);
  console.log(`Will demote originals to is_default=false: ${toCreate.length}`);
  console.log(`Skipped: ${toSkip.length}`);
  console.log(APPLY ? '[APPLY] — WRITING CHANGES' : '[DRY-RUN] — no database writes');
  console.log('');

  for (const { row, compactName, changes } of toCreate) {
    console.log(`+ ${row.component_type} / ${row.variant_name}`);
    console.log(`    id=${row.id}  is_default(old)=${row.is_default}  splittable=${row.splittable}`);
    console.log(`    new variant: "${compactName}"  is_default=true`);
    for (const c of changes) console.log(`      · ${c}`);
  }
  console.log('');
  for (const { row, reason } of toSkip) {
    console.log(`- skip ${row.component_type} / ${row.variant_name}  (${reason})`);
  }
  console.log('');

  if (!APPLY) {
    console.log('Dry-run complete. Re-run with --apply to perform changes.');
    return;
  }

  // ---- Apply ----
  // neon HTTP client doesn't support interactive transactions; we use a
  // transaction-style batch: each INSERT + matching UPDATE runs sequentially.
  // If any INSERT fails, we abort before any further writes.
  let created = 0;
  let demoted = 0;

  // jsonb columns need a JSON-encoded string; real Postgres ARRAY columns (harmony)
  // stay as JS arrays. neon's HTTP driver sends typed JS values as Postgres text —
  // arrays would be encoded as `{a,b}` which jsonb rejects, hence JSON.stringify.
  const toJsonb = v => (v == null ? null : JSON.stringify(v));

  for (const { row, compactName, newCss } of toCreate) {
    try {
      const placeholderSchema = toJsonb(row.placeholder_schema);
      const referencePageNumbers = toJsonb(row.reference_page_numbers);
      const contentTolerance = toJsonb(row.content_tolerance);
      const chartSchema = toJsonb(row.chart_schema);
      const harmony = Array.isArray(row.harmony) ? row.harmony : null;
      const [inserted] = await sql`
        INSERT INTO brand_components (
          brand_id, component_type, label, html_template, placeholder_schema,
          design_notes, source, version, is_default, extraction_id, is_public,
          unsplash_query, reference_page_numbers, variant_name, status,
          page_format, css_template, splittable,
          harmony, intensity, accent_usage, content_tolerance,
          chart_schema, chart_color_mode, style_family
        )
        VALUES (
          ${BRAND_ID}, ${row.component_type}, ${row.label || compactName},
          ${row.html_template}, ${placeholderSchema}::jsonb,
          ${(row.design_notes ? row.design_notes + ' ' : '') + '[Compact twin for inline layout use.]'},
          ${row.source || 'manual'}, 1, TRUE, ${row.extraction_id},
          ${row.is_public || false}, ${row.unsplash_query},
          ${referencePageNumbers}::jsonb, ${compactName}, 'ready',
          ${row.page_format}, ${newCss}, ${row.splittable},
          ${harmony}, ${row.intensity}, ${row.accent_usage},
          ${contentTolerance}::jsonb, ${chartSchema}::jsonb,
          ${row.chart_color_mode}, ${row.style_family}
        )
        RETURNING id
      `;
      created++;
      console.log(`  ✓ inserted ${row.component_type}/${compactName} -> ${inserted.id}`);

      // Demote original
      await sql`
        UPDATE brand_components
           SET is_default = FALSE, updated_at = NOW()
         WHERE id = ${row.id}
      `;
      demoted++;
      console.log(`  ✓ demoted original ${row.component_type}/${row.variant_name} (${row.id})`);
    } catch (err) {
      console.error(`  ✗ FAILED for ${row.component_type}/${row.variant_name}: ${err.message}`);
      console.error('  Aborting further writes.');
      process.exit(1);
    }
  }

  console.log('');
  console.log(`Apply complete: created=${created}, demoted=${demoted}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
