#!/usr/bin/env node
/**
 * Ad-hoc migration runner using @neondatabase/serverless Pool (WebSocket).
 * Runs the entire SQL file as a single multi-statement query via pg simple
 * query protocol, so PL/pgSQL blocks and DO statements work as-is.
 *
 * Usage: node scripts/run-migration.mjs <path-to-sql>
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

// Minimal .env loader (no dotenv dep)
try {
  const env = readFileSync(resolve('.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-migration.mjs <path-to-sql>');
  process.exit(1);
}

const url = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('NEON_DATABASE_URL or DATABASE_URL must be set');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const content = readFileSync(resolve(file), 'utf8');

console.log(`Running ${file} (${content.length} bytes)`);

try {
  const client = await pool.connect();
  try {
    await client.query(content);
    console.log('Migration complete.');
  } finally {
    client.release();
  }
} catch (err) {
  console.error('Migration failed:', err.message);
  if (err.position) console.error('  at position', err.position);
  process.exit(1);
} finally {
  await pool.end();
}
