import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.HUB_DB);
const jobs = await sql`
  SELECT id, status, created_at, started_at, finished_at, error_message
  FROM render_jobs WHERE report_id = '914e1c98-cc3d-4695-aed7-b7fe1af73fd8'
  ORDER BY created_at DESC LIMIT 5
`;
for (const j of jobs) console.log(j);
