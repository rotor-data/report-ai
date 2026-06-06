#!/usr/bin/env node
/**
 * One-shot resave script: add data-unit slot IDs to text-bearing elements
 * in blueprint sample_pages_html so fill-mode can bind user content.
 *
 * Strategy:
 *  - Use node-html-parser (already in report-ai deps) for HTML manipulation.
 *  - For each element in TEXT_TAGS (h1-h6, p, blockquote, li, caption,
 *    figcaption, dt, dd):
 *      - skip if already has data-unit
 *      - skip if has decorative class (eyebrow, byline, etc.)
 *      - skip if no text content
 *      - else assign data-unit="sample_<seq>" where seq is globally
 *        unique across all 6 samples (so substitute_units can map
 *        N user units to N slots in order).
 *  - Keep inline text as placeholder. mode='sample' validator allows it.
 *  - At fill-time, page-design.ts's buildSampleToRealMapping reads these
 *    slots and substitute_units replaces the placeholder with user content.
 */
import { neon } from '@neondatabase/serverless';
import { parse } from 'node-html-parser';
import { readFileSync } from 'fs';

const BLUEPRINT_ID = '81ed41d7-469e-4964-9fe0-fcfa3f6326ce';
const DB_URL = process.env.NETLIFY_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error('NETLIFY_DB_URL not set'); process.exit(1); }
const sql = neon(DB_URL);

const TEXT_TAGS = new Set(['h1','h2','h3','h4','h5','h6','p','blockquote','li','caption','figcaption','dt','dd']);
const DECORATIVE_CLASSES = new Set([
  'caption','photo-caption','figure-caption','figcaption',
  'footnote','sidenote','annotation',
  'disclaimer','small-print','fine-print','legal',
  'attribution','eyebrow','kicker','overline',
  'meta','byline','page-number','pagenum',
  'breadcrumb','badge','label',
]);

function hasDecorativeClass(el) {
  const cls = (el.getAttribute && el.getAttribute('class')) || '';
  if (!cls) return false;
  for (const c of cls.toLowerCase().split(/\s+/)) {
    if (DECORATIVE_CLASSES.has(c)) return true;
  }
  return false;
}

let slotCounter = 0;
function nextSlotId() {
  slotCounter += 1;
  return `sample_${slotCounter}`;
}

function injectDataUnits(html) {
  const root = parse(html, { lowerCaseTagName: false });
  let changes = 0;
  const slots = [];
  const all = root.querySelectorAll('*');
  for (const el of all) {
    const tag = (el.rawTagName || el.tagName || '').toLowerCase();
    if (!TEXT_TAGS.has(tag)) continue;
    if (el.getAttribute('data-unit')) continue;
    if (hasDecorativeClass(el)) continue;
    const text = (el.text || '').trim();
    if (!text) continue;
    const slotId = nextSlotId();
    el.setAttribute('data-unit', slotId);
    slots.push({ slot_id: slotId, tag, text_preview: text.slice(0, 60) });
    changes += 1;
  }
  return { html: root.toString(), changes, slots };
}

async function main() {
  const rows = await sql`
    SELECT id, name, sample_pages_html
    FROM report_blueprints
    WHERE id = ${BLUEPRINT_ID}
  `;
  if (!rows.length) { console.error('blueprint not found'); process.exit(1); }
  const bp = rows[0];
  console.log(`Processing blueprint: ${bp.name} (${bp.id})`);

  const samples = Array.isArray(bp.sample_pages_html) ? bp.sample_pages_html : [];
  console.log(`Found ${samples.length} sample pages`);

  const updated = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const original = typeof s === 'string' ? s : (s?.html ?? '');
    const blockType = typeof s === 'object' ? s?.block_type : undefined;
    const before = slotCounter;
    const { html: rewritten, changes, slots } = injectDataUnits(original);
    console.log(`\n--- Sample ${i + 1} (block_type=${blockType ?? 'page'}) ---`);
    console.log(`  ${changes} text-bearing elements got data-unit refs (slots ${before + 1}..${slotCounter})`);
    for (const s of slots) {
      console.log(`    ${s.slot_id} <${s.tag}> "${s.text_preview}"`);
    }
    updated.push(typeof s === 'object' ? { ...s, html: rewritten } : rewritten);
  }

  console.log(`\nTotal slots injected: ${slotCounter}`);
  console.log('\n=== Dry-run preview ===');
  console.log('First 500 chars of sample 3 (the problematic chap-break):');
  console.log(updated[2]?.html?.slice(0, 500) ?? updated[2]?.slice?.(0, 500) ?? 'n/a');

  if (process.argv.includes('--apply')) {
    await sql`
      UPDATE report_blueprints
      SET sample_pages_html = ${JSON.stringify(updated)}::jsonb,
          updated_at = NOW()
      WHERE id = ${BLUEPRINT_ID}
    `;
    console.log('\n✓ Applied to DB');
  } else {
    console.log('\n(dry-run — pass --apply to write)');
  }
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
