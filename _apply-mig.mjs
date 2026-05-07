import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.REPORT_DB);
await sql`ALTER TABLE document_type_templates ADD COLUMN IF NOT EXISTS flow_mode_default BOOLEAN NOT NULL DEFAULT FALSE`;
await sql`UPDATE document_type_templates SET flow_mode_default = TRUE WHERE document_type IN ('ceo_letter', 'press_release', 'newsletter')`;
console.log('done');
const dt = await sql`SELECT column_name FROM information_schema.columns WHERE table_name='document_type_templates' AND column_name='flow_mode_default'`;
console.log('col:', dt);
const fl = await sql`SELECT document_type, flow_mode_default FROM document_type_templates WHERE flow_mode_default = TRUE`;
console.log('flow-mode doctypes:', fl);
