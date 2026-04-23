// Clone the canonical Editorial blueprint (ad3dbc8a, document_type=quarterly)
// across the main document_types so Editorial isn't welded to quarterly in
// the setup picker. Idempotent — re-runs skip doctypes that already have
// an Editorial blueprint.
//
// Usage:
//   node scripts/seed_editorial_blueprints.mjs           # dry-run
//   node scripts/seed_editorial_blueprints.mjs --apply   # insert rows
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const sql = neon(env.DATABASE_URL || env.NEON_DATABASE_URL);

const SOURCE_ID = 'ad3dbc8a-309e-46ab-b9c4-600c298db32f';
const apply = process.argv.includes('--apply');

// Target document types. Keep labels short — they're concatenated with
// "Editorial" in the name (e.g. "Editorial — Annual report").
// IDs below must match DOC_TYPES in smyra-core/src/steps/report2/setup.ts
// so the blueprint is visible when the user picks that doctype from the
// category → type picker.
const TARGETS = [
  { doctype: 'annual_report', label: 'Annual report' },
  { doctype: 'pitch', label: 'Pitch Deck' },
  { doctype: 'case_study', label: 'Case study' },
  { doctype: 'white_paper', label: 'White Paper' },
  { doctype: 'sustainability_report', label: 'Sustainability report' },
  { doctype: 'board_report', label: 'Board briefing' },
];

const source = await sql`
  SELECT id, brand_id, visibility, name, tagline, chat_summary,
         document_type, style_direction, tags, slots, modules,
         thumbnail_small_base64, thumbnail_url,
         pages_estimate, page_format, narrative_guidance
  FROM report_blueprints
  WHERE id = ${SOURCE_ID}
  LIMIT 1
`;
if (!source.length) {
  console.error(`Source blueprint ${SOURCE_ID} not found.`);
  process.exit(1);
}
const src = source[0];
console.log(`Source: ${src.name} (doc=${src.document_type}, style=${src.style_direction})`);
console.log(`Apply: ${apply ? 'YES' : 'no (dry run)'}\n`);

let inserted = 0;
let skipped = 0;

for (const t of TARGETS) {
  // Skip if an Editorial blueprint already exists for this doctype.
  const existing = await sql`
    SELECT id, name FROM report_blueprints
    WHERE visibility = 'smyra'
      AND document_type = ${t.doctype}
      AND style_direction = 'Editorial'
    LIMIT 1
  `;
  if (existing.length) {
    console.log(`SKIP  ${t.doctype.padEnd(24)} — already has ${existing[0].id.slice(0, 8)} "${existing[0].name}"`);
    skipped++;
    continue;
  }

  const newId = randomUUID();
  const newName = `Editorial — ${t.label}`;
  const newTags = Array.isArray(src.tags)
    ? [...new Set([...src.tags.filter((x) => x !== 'quarterly'), t.doctype])]
    : [t.doctype, 'editorial'];

  console.log(`INSERT ${t.doctype.padEnd(24)} → ${newId.slice(0, 8)} "${newName}"`);

  if (apply) {
    await sql`
      INSERT INTO report_blueprints (
        id, brand_id, visibility, name, tagline, chat_summary,
        document_type, style_direction, tags, slots, modules,
        thumbnail_small_base64, thumbnail_url,
        pages_estimate, page_format, narrative_guidance,
        source_report_id, owner_tenant_id, created_at, updated_at
      ) VALUES (
        ${newId}, NULL, 'smyra',
        ${newName},
        ${src.tagline},
        ${src.chat_summary},
        ${t.doctype},
        'Editorial',
        ${newTags},
        ${JSON.stringify(src.slots || null)}::jsonb,
        ${JSON.stringify(src.modules || null)}::jsonb,
        ${src.thumbnail_small_base64},
        ${src.thumbnail_url},
        ${src.pages_estimate},
        ${src.page_format},
        ${JSON.stringify(src.narrative_guidance || null)}::jsonb,
        NULL, NULL, now(), now()
      )
    `;
    inserted++;
  }
}

console.log(`\n${inserted} inserted, ${skipped} skipped, ${TARGETS.length - inserted - skipped} would-insert (dry-run).`);
