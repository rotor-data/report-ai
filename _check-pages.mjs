import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.REPORT_DB);
const reportId = '914e1c98-cc3d-4695-aed7-b7fe1af73fd8';
const u = await sql`SELECT unit_id, type, level, length(text) as len FROM v2_content_units WHERE report_id = ${reportId} ORDER BY order_index`;
console.log('Units:');
for (const r of u) console.log(' ', r);
const m = await sql`SELECT id, page_id, html_cache FROM v2_report_modules WHERE report_id = ${reportId}`;
console.log('Module count:', m.length);
if (m[0]) console.log('html_cache snippet:', m[0].html_cache.slice(0, 200));
