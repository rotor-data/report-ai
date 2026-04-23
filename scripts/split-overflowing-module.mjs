// Split the overflowing freeform on report bdfd6e8e's page 2 into 4 separate
// DB modules at heading boundaries.
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'crypto';

const DBURL = process.argv[2];
const sql = neon(DBURL);
const REPORT = 'bdfd6e8e-5dba-452e-a02b-645ff2d6c338';
const OLD_MODULE = '9a90ed31-9bdf-4fc6-a288-8dab92353091';

const r = await sql`SELECT html_content, style FROM v2_report_modules WHERE id=${OLD_MODULE}::uuid`;
const srcHtml = r[0].html_content;
const srcStyle = r[0].style ?? {};

// Strip outer <div lang="sv">...</div>
const inner = srcHtml.replace(/^<div lang="sv">/, '').replace(/<\/div>\s*$/, '');

// Split at each <div data-module-type="heading">
const headingRe = /<div data-module-type="heading"/g;
const splits = [];
let m;
while ((m = headingRe.exec(inner)) !== null) splits.push(m.index);
console.log('heading offsets:', splits);

const chunks = [];
for (let i = 0; i < splits.length; i++) {
  const start = splits[i];
  const end = i + 1 < splits.length ? splits[i + 1] : inner.length;
  chunks.push(inner.slice(start, end));
}
console.log('chunks:', chunks.length, 'sizes:', chunks.map(c => c.length));

// Get the old module's page id + order
const mRow = await sql`SELECT page_id, order_index, report_id FROM v2_report_modules WHERE id=${OLD_MODULE}::uuid`;
const { page_id: oldPageId, order_index: oldOrder, report_id: reportId } = mRow[0];
console.log('was on page_id', oldPageId, 'order', oldOrder);

// Delete old module
await sql`DELETE FROM v2_report_modules WHERE id=${OLD_MODULE}::uuid`;
// Bump subsequent modules' order_index by (chunks.length - 1)
await sql`UPDATE v2_report_modules SET order_index = order_index + ${chunks.length - 1} WHERE report_id=${reportId} AND order_index > ${oldOrder}`;

// Insert new freeform modules
const newIds = [];
for (let i = 0; i < chunks.length; i++) {
  const id = randomUUID();
  newIds.push(id);
  const wrapped = '<div lang="sv">' + chunks[i] + '</div>';
  await sql`
    INSERT INTO v2_report_modules (id, report_id, module_type, order_index, content, style, html_content, html_cache, height_mm)
    VALUES (${id}, ${reportId}, 'freeform', ${oldOrder + i}, '{"title":"Section"}'::jsonb, ${JSON.stringify(srcStyle)}::jsonb, ${wrapped}, ${wrapped}, NULL)
  `;
}
console.log('created', newIds.length, 'new modules');
