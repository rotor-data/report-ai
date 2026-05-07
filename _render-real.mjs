import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const hubSql = neon(process.env.HUB_DB);
const reportSql = neon(process.env.REPORT_DB);

const id = 'd62bab47-cd16-4cfd-888a-a5b28a7e1e2a';
const r = (await hubSql`
  SELECT context->'state'->'_design_language_state' as dls,
         context->'state'->'_units' as units_ref
  FROM workflow_runs WHERE id = ${id}
`)[0];
const dls = r.dls;

// Materialise units MaterialRef
const ref = r.units_ref;
let units = [];
if (Array.isArray(ref)) {
  units = ref;
} else if (ref?.__material && ref.id) {
  const mat = await hubSql`SELECT content FROM workflow_materials WHERE id = ${ref.id}`;
  units = JSON.parse(mat[0].content);
}
console.error('materialised', units.length, 'real units');
console.error('first 3:', units.slice(0, 3).map(u => `${u.unit_id}[${u.type}]: "${(u.text||'').slice(0,40)}"`));

// Build sample-to-real mapping
const sampleHtmls = dls.sample_pages_html;
const allRefs = [];
for (const html of sampleHtmls) {
  const re = /<([a-z][a-z0-9]*)\b([^>]*?)\bdata-unit\s*=\s*(["'])([^"']+)\3([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = (m[2]||'') + ' ' + (m[5]||'');
    const cls = (attrs.match(/\bclass\s*=\s*(["'])([^"']*)\1/i)?.[2] || '').toLowerCase();
    const id = m[4];
    const HEAD = ['h1','h2','h3','h4','h5','h6'].includes(tag);
    const SHORT = /\b(byline|meta|kicker|label|attribution|caption|sig|footer|wm|url|cont)\b/i.test(cls);
    const PULL = /\b(pullquote|pull-?quote|quote)\b/i.test(cls);
    let preferred = HEAD ? 'heading' : PULL ? 'pull_quote' : SHORT ? 'short' : (tag==='p'||tag==='li'||tag==='blockquote') ? 'paragraph' : 'any';
    allRefs.push({ unit_id: id, preferred, level: HEAD ? +tag.slice(1) : undefined });
  }
}

// Simple sequential mapping
const used = new Set();
const seenIds = new Set();
const synth = [];
let order = 0;
for (const slot of allRefs) {
  if (seenIds.has(slot.unit_id)) continue;
  seenIds.add(slot.unit_id);
  // Match preferred type; fallback to next unused; finally cycle
  let pick = null;
  if (slot.preferred === 'heading') {
    pick = units.find((u, i) => !used.has(i) && u.type === 'heading' && (u.level || 0) === (slot.level || 0));
    if (!pick) pick = units.find((u, i) => !used.has(i) && u.type === 'heading');
  } else if (slot.preferred === 'paragraph') {
    pick = units.find((u, i) => !used.has(i) && u.type === 'paragraph');
  } else if (slot.preferred === 'short') {
    pick = units.find((u, i) => !used.has(i) && (u.text || '').length < 80);
  } else if (slot.preferred === 'pull_quote') {
    pick = units.find((u, i) => !used.has(i) && (u.type === 'pull_quote' || u.type === 'blockquote'));
  }
  if (!pick) pick = units.find((u, i) => !used.has(i) && u.text);
  if (!pick) pick = units[0];
  if (pick) {
    const idx = units.indexOf(pick);
    used.add(idx);
    synth.push({
      unit_id: slot.unit_id,
      type: slot.preferred === 'heading' ? 'heading' : slot.preferred === 'pull_quote' ? 'pull_quote' : 'paragraph',
      ...(slot.level ? { level: slot.level } : {}),
      text: pick.text || '',
      order_index: order++,
    });
  }
}
console.error('synth mapping count:', synth.length);
console.error('first 5:', synth.slice(0,5).map(u => `${u.unit_id}→"${u.text.slice(0,40)}"`));

const tenant_id = 'd74603ff-a69d-4f14-a412-b99375eee699';
const brand_id = '38db875d-4dbd-4327-9b78-47a36682e5ca';
const tokensRow = (await reportSql`SELECT tokens FROM brands WHERE id = ${brand_id}`)[0];
const fonts = await reportSql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brand_id}`;
const logos = await reportSql`SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id = ${brand_id}`;

const synthPages = sampleHtmls.map((html, i) => ({
  id: randomUUID(),
  page_number: i + 1,
  page_type: i === 0 ? 'cover' : 'content',
  modules: [{ module_type: 'freeform', order_index: i+1, html_content: html, html_cache: html, content: {}, style: {}, background: null }],
}));

const JWT_SECRET = process.env.JWT_SECRET;
const h = Buffer.from(JSON.stringify({alg:'HS256', typ:'JWT'})).toString('base64url');
const pp = Buffer.from(JSON.stringify({tenant_id, sub:'r', exp: Math.floor(Date.now()/1000) + 300})).toString('base64url');
const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${pp}`).digest('base64url');
const token = `${h}.${pp}.${sig}`;

const body = {
  report_id: 'debug', title: "Daniel's real-content", mode: 'draft', page_format: 'a4_portrait',
  pages: synthPages, brand_tokens: tokensRow?.tokens || {}, brand_fonts: fonts, brand_logos: logos,
  document_css: dls.design_system_css, document_css_overrides: '', style_overrides: {},
  units: synth,  // synthetic mapping
  keep_placeholders: false,
};
const res = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/pdf', {
  method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
  body: JSON.stringify(body),
});
console.error('render:', res.status);
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/tmp/real.pdf', buf);
console.error('saved /tmp/real.pdf', buf.length);

// Rasterize
const rast = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/rasterize', {
  method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
  body: JSON.stringify({pdf_base64: buf.toString('base64'), dpi: 100}),
});
const json = await rast.json();
for (const pg of json.pages || []) writeFileSync(`/tmp/real-${pg.page}.png`, Buffer.from(pg.png_base64, 'base64'));
console.error('rasterized', (json.pages||[]).length);
