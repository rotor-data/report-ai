import { neon } from '@neondatabase/serverless';
const hubSql = neon(process.env.HUB_DB);
const id = 'd62bab47-cd16-4cfd-888a-a5b28a7e1e2a';
const r = await hubSql`
  SELECT context->'state'->'_design_language_state' as dls,
         context->'state'->'_units' as units
  FROM workflow_runs WHERE id = ${id}
`;
const dls = r[0].dls;
const u = r[0].units;
console.log('typeof units:', typeof u, Array.isArray(u) ? 'array' : 'not array');
console.log('units value:', JSON.stringify(u).slice(0, 200));
console.log('design state mode:', dls?.mode, 'self_check:', dls?.self_check_count);
console.log('css len:', dls?.design_system_css?.length, 'samples:', dls?.sample_pages_html?.length);

console.log('\n=== SAMPLE 0 ===');
console.log(dls?.sample_pages_html?.[0]?.slice(0, 3000));
