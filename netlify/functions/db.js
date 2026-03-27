import { neon } from "@neondatabase/serverless";

let sql;

export function getSql() {
  if (!sql) {
    const url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("NEON_DATABASE_URL is required");
    sql = neon(url);
  }
  return sql;
}
