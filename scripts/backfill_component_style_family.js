// backfill_component_style_family.js
// One-off script: classifies brand_components variants by visual family
// (Creative, Editorial, Minimal) based on html_template class patterns
// and variant_name heuristics.
//
// Run from the report-ai repo root:
//   node --input-type=module scripts/backfill_component_style_family.js
//
// Requires NEON_DATABASE_URL in .env (same var as the Netlify function uses).

import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';

// ── Load env from .env file ──────────────────────────────────────────────────
const envPath = process.cwd() + '/.env';
const envLines = readFileSync(envPath, 'utf8').split('\n');
for (const line of envLines) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ROTOR_BRAND_ID = '6d6f0f84-ce38-4f06-961f-45d6bdd640bb';

const DB_URL = process.env.NEON_DATABASE_URL;
if (!DB_URL) {
  console.error('NEON_DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const sql = neon(DB_URL);

// ── Classification logic ──────────────────────────────────────────────────
function classifyFamily(html_template, variant_name) {
  // Check for Creative family: -ir suffix (integrated-renderer styled)
  // Word boundary: followed by space, quote, >, or end of class name
  // Examples: 'pq-ir', 'bc-ir', 'bt-ir', 'co-ir', 'cv-ir', 'dt-ir', 'fs-ir', 'md-ir'
  const hasCreativeClass = /\b[a-z]+-ir\b/.test(html_template);

  if (hasCreativeClass) {
    return 'Creative';
  }

  // Check for Minimal family: variant_name contains Minimal, Quiet, or Muted
  const name = (variant_name || '').toLowerCase();
  if (/\b(minimal|quiet|muted)\b/.test(name)) {
    return 'Minimal';
  }

  // Check for Editorial family: .ed-page wrapper or specific Editorial class prefixes
  // Examples: cv-colossus, tx-hd-overline, dt-kpi-trio, dt-fs-band, md-tg-portraits
  const hasEditorialWrapper = /\.ed-page/.test(html_template);
  const hasEditorialClasses = /\b(cv-colossus|tx-hd-|dt-kpi-|dt-fs-|md-tg-)\b/.test(html_template);

  if (hasEditorialWrapper || hasEditorialClasses) {
    return 'Editorial';
  }

  // Default to Editorial if no pattern matched
  return 'Editorial';
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const components = await sql`
    SELECT id, variant_name, html_template, component_type
    FROM brand_components
    WHERE brand_id = ${ROTOR_BRAND_ID}
    ORDER BY component_type, variant_name
  `;

  console.log(`\nFound ${components.length} components for brand ${ROTOR_BRAND_ID}`);

  const buckets = { Creative: [], Editorial: [], Minimal: [] };
  const surprises = [];

  for (const comp of components) {
    const family = classifyFamily(comp.html_template, comp.variant_name);
    buckets[family].push(comp.id);

    // Track if multiple patterns matched (would only apply -ir wins)
    const hasCreative = /\b[a-z]+-ir\b/.test(comp.html_template);
    const hasMinimal = /\b(minimal|quiet|muted)\b/i.test(comp.variant_name);
    const hasEditorial = /\.ed-page/.test(comp.html_template) || /\b(cv-colossus|tx-hd-|dt-kpi-|dt-fs-|md-tg-)\b/.test(comp.html_template);

    if ((hasCreative && hasMinimal) || (hasCreative && hasEditorial) || (hasMinimal && hasEditorial)) {
      surprises.push({
        id: comp.id,
        variant_name: comp.variant_name,
        component_type: comp.component_type,
        classified_as: family,
        patterns: { hasCreative, hasMinimal, hasEditorial }
      });
    }

    await sql`
      UPDATE brand_components
      SET style_family = ${family}
      WHERE id = ${comp.id}
    `;
  }

  console.log('\n── Backfill summary ─────────────────────────────────────');
  console.log(`  Editorial: ${buckets.Editorial.length} rows`);
  console.log(`  Creative:  ${buckets.Creative.length} rows`);
  console.log(`  Minimal:   ${buckets.Minimal.length} rows`);
  console.log(`  total updated: ${components.length} rows`);

  if (surprises.length > 0) {
    console.log('\n── Surprises (matched multiple patterns) ──────────────');
    for (const surprise of surprises) {
      console.log(`\n  ${surprise.variant_name} (${surprise.component_type})`);
      console.log(`    classified as: ${surprise.classified_as}`);
      console.log(`    patterns: Creative=${surprise.patterns.hasCreative}, Minimal=${surprise.patterns.hasMinimal}, Editorial=${surprise.patterns.hasEditorial}`);
    }
  }

  console.log('\n─────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
