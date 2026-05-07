import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { buildSampleToRealMapping } from '/Users/danielpettersson/Local sites.nosync/smyra-core/dist/lib/sample-content-mapping.js';

const hubSql = neon(process.env.HUB_DB);
const reportSql = neon(process.env.REPORT_DB);

const id = 'd62bab47-cd16-4cfd-888a-a5b28a7e1e2a';
const r = (await hubSql`
  SELECT context->'state'->'_design_language_state' as dls,
         context->'state'->'_units' as units_ref
  FROM workflow_runs WHERE id = ${id}
`)[0];
const dls = r.dls;

// Materialise units
const ref = r.units_ref;
let units = [];
if (Array.isArray(ref)) units = ref;
else if (ref?.__material && ref.id) {
  const mat = await hubSql`SELECT content FROM workflow_materials WHERE id = ${ref.id}`;
  units = JSON.parse(mat[0].content);
}

console.log('REAL UNITS:');
for (const u of units) console.log(`  ${u.unit_id} [${u.type}${u.level?` lvl${u.level}`:''}, ${(u.text||'').length} chars]: "${(u.text||'').slice(0,60)}${(u.text||'').length>60?'…':''}"`);

const synth = buildSampleToRealMapping(dls.sample_pages_html, units);
console.log('\nSYNTHETIC MAPPING (', synth?.length || 0, 'entries):');
for (const u of synth || []) console.log(`  ${u.unit_id} [${u.type}${u.level?` lvl${u.level}`:''}]: "${(u.text||'').slice(0,80)}${(u.text||'').length>80?'…':''}"`);

// Now render
const tenant_id = 'd74603ff-a69d-4f14-a412-b99375eee699';
const brand_id = '38db875d-4dbd-4327-9b78-47a36682e5ca';
const tokensRow = (await reportSql`SELECT tokens FROM brands WHERE id = ${brand_id}`)[0];
const fonts = await reportSql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brand_id}`;
const logos = await reportSql`SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id = ${brand_id}`;

const synthPages = dls.sample_pages_html.map((html, i) => ({
  id: randomUUID(), page_number: i+1, page_type: i===0?'cover':'content',
  modules: [{module_type:'freeform', order_index:i+1, html_content:html, html_cache:html, content:{}, style:{}, background:null}],
}));

const JWT_SECRET = process.env.JWT_SECRET;
const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const pp = Buffer.from(JSON.stringify({tenant_id, sub:'r', exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${pp}`).digest('base64url');
const token = `${h}.${pp}.${sig}`;

const body = {
  report_id:'debug', title:'verify', mode:'draft', page_format:'a4_portrait',
  pages:synthPages, brand_tokens:tokensRow?.tokens||{}, brand_fonts:fonts, brand_logos:logos,
  document_css:dls.design_system_css, document_css_overrides:'', style_overrides:{},
  units:synth || [],
  keep_placeholders:true,  // dropped slots keep Claude's placeholder
};
const res = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/pdf', {
  method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
  body:JSON.stringify(body),
});
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/tmp/verify-mapping.pdf', buf);
console.log('\nPDF saved:', buf.length, 'bytes, status:', res.status);

// Rasterize
const rast = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/rasterize', {
  method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
  body:JSON.stringify({pdf_base64:buf.toString('base64'), dpi:100}),
});
const j = await rast.json();
for (const p of j.pages||[]) writeFileSync(`/tmp/verify-mapping-${p.page}.png`, Buffer.from(p.png_base64, 'base64'));
console.log('rasterized', (j.pages||[]).length, 'pages');
