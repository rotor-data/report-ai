// Strip shared .tx { padding: 72px 64px; display: flex } block from component css_template
// and inject it into the document-level stylesheet ONCE. Also flip display:flex to block
// because .tx as flex container without flex-direction:column stretches children awkwardly.
import { neon } from '@neondatabase/serverless';

const DBURL = process.argv[2];
if (!DBURL) { console.error('pass DATABASE_URL as argv[2]'); process.exit(1); }
const sql = neon(DBURL);

const BRAND = '6d6f0f84-ce38-4f06-961f-45d6bdd640bb';
const apply = process.argv.includes('--apply');

const rows = await sql`SELECT id, component_type, variant_name, css_template FROM brand_components WHERE brand_id=${BRAND} AND css_template LIKE '%.tx { padding%' ORDER BY component_type, variant_name`;

console.log(`[${apply ? 'APPLY' : 'DRY'}] found ${rows.length} variants with shared .tx rule`);

// Match the opening comment block through the shared .tx rule + its children (.tx > *, .tx h1 h2 ...)
// These are shared across every text-component template.
const SHARED_RE = /\/\* ===+\s*\n\s*TEXT COMPONENTS[\s\S]*?===+\s*\*\/\s*\n+\/\* Shared text-page padding[\s\S]*?\n\.tx \{ padding: 72px 64px;\s*\n\s*display: flex; \}\s*\n+\.tx > \* \{ width: 100%; \}\s*\n+\.tx h1,[^}]*\}\s*\n+/;

let changed = 0;
for (const r of rows) {
  const before = r.css_template;
  const after = before.replace(SHARED_RE, '');
  if (before === after) {
    console.log(`  SKIP ${r.component_type}/${r.variant_name} — regex no match`);
    continue;
  }
  const savedBytes = before.length - after.length;
  changed++;
  console.log(`  ${apply ? 'FIX ' : 'WOULD'} ${r.component_type}/${r.variant_name} (-${savedBytes} bytes)`);
  if (apply) {
    await sql`UPDATE brand_components SET css_template = ${after} WHERE id = ${r.id}`;
  }
}

console.log(`[${apply ? 'DONE' : 'DRY'}] ${changed}/${rows.length} variants would change`);
if (!apply) console.log('\nRe-run with --apply to commit.');
