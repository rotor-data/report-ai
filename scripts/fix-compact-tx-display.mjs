// Compact variants retain .tx { padding: ...; display: flex; } where only padding
// should be kept. display belongs in the shared base CSS (injected by
// buildStyleBlock in smyra-core). Removes 'display: flex' so compact's .tx rule
// becomes padding-only override.
import { neon } from '@neondatabase/serverless';

const DBURL = process.argv[2];
if (!DBURL) { console.error('pass DATABASE_URL as argv[2]'); process.exit(1); }
const sql = neon(DBURL);
const apply = process.argv.includes('--apply');
const BRAND = '6d6f0f84-ce38-4f06-961f-45d6bdd640bb';

const rows = await sql`SELECT id, component_type, variant_name, css_template FROM brand_components WHERE brand_id=${BRAND} AND variant_name ILIKE '%Compact%'`;

console.log(`[${apply ? 'APPLY' : 'DRY'}] scanning ${rows.length} Compact variants`);

// Match .tx { padding: ...; display: flex; } (or flex on own line)
const RE = /(\.tx\s*\{\s*padding:\s*[^;]+;)\s*\n?\s*display:\s*flex;\s*(\})/g;

let changed = 0;
for (const r of rows) {
  const after = r.css_template.replace(RE, (_m, head, tail) => `${head} ${tail}`);
  if (after === r.css_template) { console.log(`  SKIP ${r.component_type}/${r.variant_name}`); continue; }
  changed++;
  console.log(`  ${apply ? 'FIX ' : 'WOULD'} ${r.component_type}/${r.variant_name}`);
  if (apply) await sql`UPDATE brand_components SET css_template = ${after} WHERE id = ${r.id}`;
}
console.log(`[${apply ? 'DONE' : 'DRY'}] ${changed}/${rows.length}`);
