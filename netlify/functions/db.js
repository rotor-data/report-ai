/**
 * Database connection for Netlify Functions.
 *
 * Phase 3b migration: report-ai moved onto Netlify Database.
 *
 * Driver: `neon()` HTTP client from `@neondatabase/serverless` v1 — the
 * exact same driver `@netlify/database` wraps internally for its
 * `serverless` path (`getDatabase().httpClient`). We call `neon()`
 * directly rather than going through `getDatabase()` because:
 *
 *   - `@netlify/database`'s entry eagerly imports `pg` + `waddler`
 *     (node-postgres path) at module load. Netlify's esbuild then
 *     externalizes the whole tree, and its file-tracer ships only the
 *     ESM `dist/main.js` of each package — not the `dist/main.cjs` the
 *     CJS-bundled function actually `require()`s. Result: runtime
 *     "Cannot find module .../main.cjs" 502s (seen across
 *     @netlify/database, waddler, …). Verified Phase 3b.
 *   - report-ai only ever uses the HTTP/serverless path (tagged-template
 *     `sql` + `sql.transaction([...])`) — it never needs the pg.Pool
 *     `server` driver. `@neondatabase/serverless` is pure JS and esbuild
 *     bundles it inline cleanly.
 *
 * So this IS the Netlify Database driver — minus the wrapper package
 * that doesn't survive report-ai's JS/esbuild bundling.
 *
 * The httpClient API (`sql`SELECT …`` and `sql.transaction([sql`…`, …])`)
 * is identical to the legacy v0.9 driver — no query callsite changes.
 *
 * Connection string resolution order:
 *   NETLIFY_DATABASE_URL — injected by Netlify when a managed DB is linked
 *   NEON_DATABASE_URL    — legacy source Neon (still serves prod until 3c)
 *   DATABASE_URL         — generic fallback
 */
import { neon } from "@neondatabase/serverless";

let sql;

export function getSql() {
  if (!sql) {
    const url =
      process.env.NETLIFY_DATABASE_URL ||
      process.env.NEON_DATABASE_URL ||
      process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "NETLIFY_DATABASE_URL (or NEON_DATABASE_URL) is required"
      );
    }
    sql = neon(url);
  }
  return sql;
}
