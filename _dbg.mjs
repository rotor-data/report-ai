import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

const sql = neon(process.env.REPORT_DB);
const reportId = '914e1c98-cc3d-4695-aed7-b7fe1af73fd8';
const report = await sql`SELECT * FROM v2_reports WHERE id = ${reportId}`;
const r = report[0];
const tenantId = r.tenant_id;
const brandId = r.brand_id;
const tokensRow = await sql`SELECT tokens FROM brands WHERE id = ${brandId}`;
const fonts = await sql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brandId}`;
const logos = await sql`SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id = ${brandId}`;
const units = await sql`SELECT unit_id, type, level, text, metadata, order_index FROM v2_content_units WHERE report_id = ${reportId} ORDER BY order_index`;
const pages = await sql`SELECT id, page_number, page_type FROM v2_report_pages WHERE report_id = ${reportId} ORDER BY page_number`;
const modules = await sql`SELECT id, page_id, html_cache FROM v2_report_modules WHERE report_id = ${reportId}`;

const tenant_id = tenantId;
const syntheticPages = pages.map(p => {
  const mods = modules.filter(m => m.page_id === p.id);
  return {
    id: randomUUID(),
    page_number: p.page_number,
    page_type: p.page_type,
    modules: mods.map(m => ({
      module_type: 'freeform',
      order_index: p.page_number,
      html_content: m.html_cache,
      html_cache: m.html_cache,
      content: {},
      style: {},
      background: null,
    })),
  };
});

const JWT_SECRET = process.env.JWT_SECRET;
const header = Buffer.from(JSON.stringify({alg:'HS256', typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  tenant_id, sub: 'dbg', exp: Math.floor(Date.now()/1000) + 300,
})).toString('base64url');
const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
const token = `${header}.${payload}.${sig}`;

const body = {
  report_id: reportId,
  title: 'Debug',
  mode: 'draft',
  page_format: 'a4_portrait',
  pages: syntheticPages,
  brand_tokens: tokensRow[0]?.tokens || {},
  brand_fonts: fonts,
  brand_logos: logos,
  document_css: r.document_css || '',
  document_css_overrides: '',
  style_overrides: {},
  units,
  debug_dump_html: true,
};
console.error('units passed:', units.length, 'pages:', syntheticPages.length);
const res = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/pdf', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
  body: JSON.stringify(body),
});
console.error('status:', res.status);
const text = await res.text();
console.log(text);
