// Insert parsed editorial-library rows into report-ai DB.
// Usage: node insert.mjs [--pilot]    (--pilot = only 1 row for smoke test)

import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';
import { join } from 'path';

const REPORT_AI_DIR = '/Users/danielpettersson/Local sites.nosync/report-ai';
const ROWS_JSON = '/tmp/editorial-import/dry-run.json';
const env = readFileSync(join(REPORT_AI_DIR, '.env'), 'utf8');
const DB_URL = env.match(/NEON_DATABASE_URL\s*=\s*"?([^"\n]+)"?/)?.[1];
if (!DB_URL) { console.error('No NEON_DATABASE_URL'); process.exit(1); }
const sql = neon(DB_URL);

const rows = JSON.parse(readFileSync(ROWS_JSON, 'utf8'));
const pilot = process.argv.includes('--pilot');
const toInsert = pilot
  ? rows.filter(r => r.component_type === 'cover' && r.variant_name === 'Colossus')
  : rows;

console.log(`Inserting ${toInsert.length} component${toInsert.length===1?'':'s'}...`);

let inserted = 0, updated = 0, errored = 0;
for (const r of toInsert) {
  try {
    const result = await sql`
      INSERT INTO brand_components (
        brand_id, component_type, variant_name, label,
        html_template, css_template, placeholder_schema,
        design_notes, source, status, is_public,
        page_format, splittable
      ) VALUES (
        ${r.brand_id}, ${r.component_type}, ${r.variant_name}, ${r.label},
        ${r.html_template}, ${r.css_template}, ${JSON.stringify(r.placeholder_schema)}::jsonb,
        ${r.design_notes}, ${r.source}, ${r.status}, ${r.is_public},
        ${r.page_format}, ${r.splittable}
      )
      ON CONFLICT (brand_id, component_type, variant_name)
      DO UPDATE SET
        label               = EXCLUDED.label,
        html_template       = EXCLUDED.html_template,
        css_template        = EXCLUDED.css_template,
        placeholder_schema  = EXCLUDED.placeholder_schema,
        design_notes        = EXCLUDED.design_notes,
        source              = EXCLUDED.source,
        status              = EXCLUDED.status,
        is_public           = EXCLUDED.is_public,
        page_format         = EXCLUDED.page_format,
        splittable          = EXCLUDED.splittable,
        updated_at          = NOW()
      RETURNING id, xmax = 0 AS inserted
    `;
    if (result[0].inserted) { inserted++; }
    else                    { updated++; }
    if (toInsert.length <= 5) console.log(`  ${result[0].inserted?'INS':'UPD'} ${r.label} → ${result[0].id}`);
  } catch (err) {
    errored++;
    console.error(`  ERR ${r.label}:`, err.message);
  }
}

console.log(`\nDone. Inserted=${inserted}  Updated=${updated}  Errors=${errored}`);
