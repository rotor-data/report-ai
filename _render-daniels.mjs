import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const hubSql = neon(process.env.HUB_DB);
const reportSql = neon(process.env.REPORT_DB);

const id = 'd62bab47-cd16-4cfd-888a-a5b28a7e1e2a';
const r = (await hubSql`
  SELECT context->'state'->'_design_language_state' as dls,
         context->'state'->'context.tenant_resolve' as tenant
  FROM workflow_runs WHERE id = ${id}
`)[0];
const dls = r.dls;
const tenant_id = r.tenant?.tenant_id || r.tenant;
const brand_id = '38db875d-4dbd-4327-9b78-47a36682e5ca'; // Freebo

const tokensRow = (await reportSql`SELECT tokens FROM brands WHERE id = ${brand_id}`)[0];
const fonts = await reportSql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brand_id}`;
const logos = await reportSql`SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id = ${brand_id}`;

// samples_only path — replicate what renderSampleThumbnails sends
const pages = dls.sample_pages_html.map((html, i) => ({
  page_num: i + 1,
  module_type: 'freeform',
  html,
}));

// Wrap in modules shape that render.py expects
const synth = pages.map(p => ({
  id: randomUUID(),
  page_number: p.page_num,
  page_type: p.page_num === 1 ? 'cover' : 'content',
  modules: [{ module_type: 'freeform', order_index: p.page_num, html_content: p.html, html_cache: p.html, content: {}, style: {}, background: null }],
}));

const JWT_SECRET = process.env.JWT_SECRET;
const h = Buffer.from(JSON.stringify({alg:'HS256', typ:'JWT'})).toString('base64url');
const pp = Buffer.from(JSON.stringify({tenant_id, sub: 'r', exp: Math.floor(Date.now()/1000) + 300})).toString('base64url');
const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${pp}`).digest('base64url');
const token = `${h}.${pp}.${sig}`;

const body = {
  report_id: 'debug',
  title: 'Daniel\'s sample render',
  mode: 'draft',
  page_format: 'a4_portrait',
  pages: synth,
  brand_tokens: tokensRow?.tokens || {},
  brand_fonts: fonts,
  brand_logos: logos,
  document_css: dls.design_system_css,
  document_css_overrides: '',
  style_overrides: {},
  units: [],  // empty — sample-mode keeps inline
  keep_placeholders: true,
};
console.error('rendering Daniel\'s', synth.length, 'samples');
const t0 = Date.now();
const res = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/pdf', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
  body: JSON.stringify(body),
});
console.error('status:', res.status, 'duration:', Date.now()-t0, 'ms');
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/tmp/daniels.pdf', buf);
console.error('saved /tmp/daniels.pdf', buf.length);

// Rasterize too
const h2 = Buffer.from(JSON.stringify({alg:'HS256', typ:'JWT'})).toString('base64url');
const sig2 = crypto.createHmac('sha256', JWT_SECRET).update(`${h2}.${pp}`).digest('base64url');
const tok2 = `${h2}.${pp}.${sig2}`;
const rast = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/rasterize', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${tok2}`},
  body: JSON.stringify({pdf_base64: buf.toString('base64'), dpi: 100}),
});
const json = await rast.json();
for (const pg of json.pages || []) writeFileSync(`/tmp/daniels-${pg.page}.png`, Buffer.from(pg.png_base64, 'base64'));
console.error('rasterized', (json.pages || []).length, 'pages');
