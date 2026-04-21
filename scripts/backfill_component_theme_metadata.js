// backfill_component_theme_metadata.js
// One-off script: sets intensity / accent_usage / content_tolerance / chart_schema /
// chart_color_mode defaults on Rotor's 94 brand_component rows by inferring from variant_name.
//
// Run from the report-ai repo root:
//   node scripts/backfill_component_theme_metadata.js
//
// Requires NEON_DATABASE_URL in .env (same var as the Netlify function uses).

import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';

// ── Load env from .env file ──────────────────────────────────────────────────
// Resolve path relative to process.cwd() to avoid URL-encoding issues with spaces
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

// Data-category component types — set KPI_COUNT tolerance in addition to intensity
const DATA_TYPES = new Set(['kpi_group', 'fact_strip', 'timeline', 'metric_change']);

// Chart component type
const CHART_TYPE = 'chart';

// ── Scoring rules (case-insensitive match on variant_name) ───────────────────
function classifyVariant(variant_name, component_type) {
  const name = (variant_name || '').toLowerCase();

  let intensity = 'medium';
  let accent_usage = 'tint';
  let content_tolerance = {};

  if (/colossus|loud|hero|bold|manifest/.test(name)) {
    intensity = 'loud';
    accent_usage = 'strong';
    content_tolerance = { TITLE: { ideal_chars: [6, 18], max_chars: 30 } };
  } else if (/plate|single|overline|masthead|band/.test(name)) {
    intensity = 'medium';
    accent_usage = 'tint';
    content_tolerance = { TITLE: { ideal_chars: [10, 30], max_chars: 50 } };
  } else if (/quiet|minimal|muted|creative|trio|cols/.test(name)) {
    intensity = 'quiet';
    accent_usage = 'none';
    content_tolerance = { TITLE: { ideal_chars: [12, 40], max_chars: 60 } };
  }

  // Data-category types: add KPI_COUNT tolerance regardless of intensity bucket
  if (DATA_TYPES.has(component_type)) {
    content_tolerance = { ...content_tolerance, KPI_COUNT: { ideal: [3, 4], max: 6 } };
  }

  // Chart-specific fields
  let chart_color_mode = null;
  let chart_schema = null;
  if (component_type === CHART_TYPE) {
    chart_color_mode = 'brand';
    chart_schema = {
      chart_type: ['bar', 'line', 'donut'],
      labels: 'text[]',
      values: 'number[]',
      caption: 'text',
    };
  }

  return { intensity, accent_usage, content_tolerance, chart_color_mode, chart_schema };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const components = await sql`
    SELECT id, variant_name, component_type
    FROM brand_components
    WHERE brand_id = ${ROTOR_BRAND_ID}
    ORDER BY component_type, variant_name
  `;

  console.log(`Found ${components.length} components for brand ${ROTOR_BRAND_ID}`);

  const buckets = { loud: [], medium: [], quiet: [] };
  let chartUpdates = 0;

  for (const comp of components) {
    const { intensity, accent_usage, content_tolerance, chart_color_mode, chart_schema } =
      classifyVariant(comp.variant_name, comp.component_type);

    buckets[intensity].push(comp.id);

    await sql`
      UPDATE brand_components
      SET
        intensity         = ${intensity},
        accent_usage      = ${accent_usage},
        content_tolerance = ${JSON.stringify(content_tolerance)}::jsonb,
        chart_color_mode  = COALESCE(${chart_color_mode}::text, chart_color_mode),
        chart_schema      = COALESCE(${chart_schema ? JSON.stringify(chart_schema) : null}::jsonb, chart_schema)
      WHERE id = ${comp.id}
    `;

    if (comp.component_type === CHART_TYPE) chartUpdates++;
  }

  console.log('\n── Backfill summary ─────────────────────────────────────');
  console.log(`  loud   (intensity=loud,   accent_usage=strong): ${buckets.loud.length} rows`);
  console.log(`  medium (intensity=medium, accent_usage=tint):   ${buckets.medium.length} rows`);
  console.log(`  quiet  (intensity=quiet,  accent_usage=none):   ${buckets.quiet.length} rows`);
  console.log(`  chart_schema + chart_color_mode set:            ${chartUpdates} rows`);
  console.log(`  total updated: ${components.length} rows`);
  console.log('─────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
