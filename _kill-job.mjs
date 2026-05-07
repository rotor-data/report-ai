import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.HUB_DB);
await sql`UPDATE render_jobs SET status = 'failed', error_message = 'manually killed for retry' WHERE id = '6cc451e6-dc9c-426c-a6d5-a137ef1740ce'`;
console.log('killed');
