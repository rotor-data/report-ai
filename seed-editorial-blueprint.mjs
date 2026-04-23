// Seed "Editorial Quarterly" blueprint — references the 94-component
// Editorial library we just imported. visibility='smyra' so all tenants see it.

import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';

const env = readFileSync('.env', 'utf8');
const DB_URL = env.match(/NEON_DATABASE_URL\s*=\s*"?([^"\n]+)"?/)?.[1];
const sql = neon(DB_URL);

const slots = [
  { slot_id: 'cover',            role: 'cover',         page: 1, required: true,
    intent: 'Main cover with report title, subtitle, date, volume/issue, author, organization.',
    variant_preferences: ['Colossus', 'Manifest', 'Plate', 'Ledger'] },

  { slot_id: 'exec_heading',     role: 'heading',       page: 2, required: true,
    intent: 'Executive summary section heading — one line, editorial tone.',
    variant_preferences: ['Leftbar', 'Overline', 'Toprule'] },
  { slot_id: 'exec_body',        role: 'body_text',     page: 2, required: true,
    intent: '2-3 paragraphs setting up the quarter: context, headline numbers, direction.',
    variant_preferences: ['Dropcap', 'Single'] },
  { slot_id: 'exec_kpis',        role: 'kpi_group',     page: 2, required: true,
    intent: '3-6 headline KPIs summarising the quarter (revenue, growth, margin, etc.).',
    variant_preferences: ['Trio', 'Strip', 'Tiles', 'Grid2'] },

  { slot_id: 'fin_heading',      role: 'heading',       page: 3, required: true,
    intent: 'Financial snapshot heading.',
    variant_preferences: ['Deck', 'Bottomrule'] },
  { slot_id: 'fin_chart',        role: 'chart',         page: 3, required: true,
    intent: 'One chart (bar/line/donut) showing the quarter\'s primary financial metric over time.',
    variant_preferences: [] },
  { slot_id: 'fin_facts',        role: 'fact_strip',    page: 3, required: false,
    intent: '3-5 quick supporting facts under the chart.',
    variant_preferences: ['Band', 'Cols', 'Ticker'] },

  { slot_id: 'narr_heading',     role: 'heading',       page: 4, required: true,
    intent: 'Leadership / narrative section heading (e.g. CEO\'s word).',
    variant_preferences: ['Deck', 'Rotated'] },
  { slot_id: 'narr_body',        role: 'body_text',     page: 4, required: true,
    intent: 'Longer-form narrative: context, reflections, strategic themes. 3-5 paragraphs.',
    variant_preferences: ['Two-column', 'Sidenote'] },
  { slot_id: 'narr_quote',       role: 'pullquote',     page: 4, required: false,
    intent: 'Pull quote from leadership reinforcing a key point in the narrative.',
    variant_preferences: ['Portrait', 'Centered', 'Bar'] },

  { slot_id: 'change_heading',   role: 'heading',       page: 5, required: false,
    intent: 'What changed this quarter — heading.',
    variant_preferences: ['Bottomrule', 'Overline'] },
  { slot_id: 'change_metrics',   role: 'metric_change', page: 5, required: false,
    intent: '3-5 metrics shown as before/after or delta visualisations.',
    variant_preferences: ['Bars', 'Delta', 'Ba'] },

  { slot_id: 'outlook_heading',  role: 'heading',       page: 6, required: false,
    intent: 'Outlook / next quarter heading.',
    variant_preferences: ['Overline', 'Leftbar'] },
  { slot_id: 'outlook_timeline', role: 'timeline',      page: 6, required: false,
    intent: 'Timeline of upcoming milestones / events in the next quarter.',
    variant_preferences: ['Ruled', 'Vert'] },
  { slot_id: 'outlook_body',     role: 'body_text',     page: 6, required: false,
    intent: '1-2 short paragraphs of forward-looking commentary.',
    variant_preferences: ['Single'] },

  { slot_id: 'back',             role: 'back_cover',    page: 7, required: true,
    intent: 'Back cover with organization contact, tagline, and sign-off.',
    variant_preferences: ['Emblem', 'Contact', 'CTA', 'Gratitude'] },
];

const narrative_guidance = {
  flow: 'cover → executive summary + KPIs → financial snapshot → narrative (leadership voice) → change highlights → outlook → back cover',
  tone: 'Editorial, confident, restrained. Headline numbers do the heavy lifting; narrative supports, never oversells.',
  density: 'Airy. One primary idea per page. Use whitespace as a design element.',
  voice_markers: [
    'avoid corporate fluff ("committed to excellence", "synergies")',
    'prefer concrete numbers over adjectives',
    'leadership quotes should sound personal, not press-release'
  ],
  auto_pick_hints: {
    cover: 'Colossus works when the title is short and emphatic. Manifest for more formal/ceremonial tone. Plate when you have a strong hero image. Ledger for data-heavy/archive aesthetic.',
    narr_quote: 'Portrait variant needs a portrait image URL; only pick if one is available.',
    fin_chart: 'Pick chart variant based on data shape — bar for comparison, line for time series, donut for composition.',
  },
};

// Blueprint is NAMED by style only. document_type column carries the
// doctype so the UI can show it separately ("Editorial · For Quarterly
// report"). Avoids baking "Editorial Quarterly" into the label and
// making the style appear doctype-locked.
const name = 'Editorial';
const tagline = 'Condensed editorial quarterly — 6-7 pages, leadership-led narrative, data-rich but restrained.';
const chat_summary = 'Quarterly report in magazine-like editorial style. Cover, executive summary with KPIs, financial snapshot with chart, leadership narrative with pull quote, change highlights, outlook, and branded back cover. Designed for companies that want gravitas over flash.';

const tags = ['quarterly', 'editorial', 'leadership', 'condensed', 'narrative'];

// Upsert on (name, visibility) — only one Smyra blueprint per name
const existing = await sql`
  SELECT id FROM report_blueprints
  WHERE visibility='smyra' AND name = ${name}
  LIMIT 1
`;

let id;
if (existing.length) {
  await sql`
    UPDATE report_blueprints SET
      tagline = ${tagline},
      chat_summary = ${chat_summary},
      document_type = 'quarterly',
      style_direction = 'Editorial',
      tags = ${tags}::text[],
      slots = ${JSON.stringify(slots)}::jsonb,
      narrative_guidance = ${JSON.stringify(narrative_guidance)}::jsonb,
      pages_estimate = 7,
      page_format = 'a4_portrait',
      visibility = 'smyra',
      updated_at = NOW()
    WHERE id = ${existing[0].id}
  `;
  id = existing[0].id;
  console.log(`UPDATED ${id}`);
} else {
  const inserted = await sql`
    INSERT INTO report_blueprints (
      name, tagline, chat_summary, document_type, style_direction, tags,
      slots, narrative_guidance, pages_estimate, page_format,
      visibility, brand_id, modules
    ) VALUES (
      ${name}, ${tagline}, ${chat_summary}, 'quarterly', 'Editorial', ${tags}::text[],
      ${JSON.stringify(slots)}::jsonb, ${JSON.stringify(narrative_guidance)}::jsonb,
      7, 'a4_portrait',
      'smyra', NULL, NULL
    )
    RETURNING id
  `;
  id = inserted[0].id;
  console.log(`INSERTED ${id}`);
}

// Verify by reading back
const row = await sql`
  SELECT name, tagline, visibility, document_type, style_direction,
         jsonb_array_length(slots) AS slot_count, pages_estimate, tags
  FROM report_blueprints WHERE id = ${id}
`;
console.log('\nVerified:', JSON.stringify(row[0], null, 2));
