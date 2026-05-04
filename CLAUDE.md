# Report AI — CLAUDE.md

## What this is

Report AI is the Rotor Platform module that creates branded PDF reports. It exposes MCP tools to the Hub (mounted under the `report__` / `report2__` prefixes), runs the v2 editor as a Vite + React SPA, and orchestrates the persistence + rendering pipeline against Neon Postgres + the smyra-render service.

## Tech stack

- **Runtime**: Node.js 20 (JavaScript, ESM)
- **Frontend**: React 18 + Vite 5, Zustand for state, dnd-kit for reordering
- **Hosting**: Netlify Functions (serverless) + Netlify static hosting for the editor SPA
- **Database**: Neon Postgres via `@neondatabase/serverless`
- **PDF rendering**: smyra-render (Python Flask + Puppeteer subprocess) called over HTTPS with RS256 JWT
- **Auth**: hub-minted JWTs (RS256, audience = `report-ai-v2` or legacy `report-ai`)
- **Storage**: Netlify Blobs for assets, fonts, rendered PDFs and thumbnails

## Project shape

```
netlify/functions/
  mcp.js              # Legacy v1 MCP entrypoint (decommissioned, kept for routing)
  mcp-v2.js           # Active v2 MCP entrypoint — alpha-v3 freeform pipeline
  hub-provision.js    # Receives provisioning callback from hub
  v2-*.js             # REST endpoints for the editor
  unsplash-direct.js  # Keyword-matched Unsplash redirect (cached per q+w+h)
  preview.js, export-pdf.js, ...
src/
  components/v2/      # Editor UI — pages, modules, units side panel, preview
  lib/                # Shared utilities
    units-substitute.js   # JS port of smyra-render's substitute_units (used by HtmlPreview)
    validate-units-only.js # Server-side validator (gated on units mode)
    inline-md.js           # Strict markdown subset matching smyra-render
db/migrations/        # Postgres schema migrations (001 → 031)
                      #   030 v2_content_units (alpha-v3 content store)
                      #   031 legacy column comments (html_content, html_cache)
public/               # Static assets served from /
scripts/              # Ad-hoc maintenance scripts (run-migration, backfills, …)
```

## Critical rules

1. **JavaScript only** — not TypeScript. Smyra-core is the TS layer; this repo stays JS.
2. **All MCP traffic is hub-fronted** — direct calls to `/api/mcp-v2` require a valid hub JWT (`audience` ∈ `{report-ai, report-ai-v2}`).
3. **Never write text directly into module HTML** — use the units pipeline (see below).
4. **DB writes are idempotent** — `persist_freeform_pages` runs as one atomic DELETE + bulk INSERT so a retry never half-writes.

## Alpha-v3 content units

Alpha-v3 reports store content in the `v2_content_units` table (one row per typed text fragment) and compose pages from `data-unit="<id>"` references. The renderer substitutes refs → text right before rasterise. Inline body text on a page is a bug — caught by the server-side validator.

### Where the units flow lives in this repo

- **`netlify/functions/mcp-v2.js`** — the three tool handlers that touch units:
  - `persist_freeform_pages` — atomic write of pages + units to DB.
  - `render_freeform_pdf` — SELECTs units for the report, ships them to smyra-render in the payload.
  - `render_freeform_thumbnails` — accepts an `units` array from the caller, includes a units fingerprint in the cache key so identical HTML with different units produces a fresh thumb.
- **`src/lib/validate-units-only.js`** — rejects pages where `<p>`, `<h*>`, `<blockquote>`, `<li>`, `<dt>`, `<dd>`, `<caption>`, `<figcaption>` carry inline body text instead of a `data-unit` attribute. Wired into all three handlers above.
- **`src/lib/units-substitute.js`** — JS mirror of `smyra-render/units_substitute.py`. Used by the editor's `HtmlPreview` so the live preview renders exactly what the PDF will. Pure, idempotent.
- **`src/lib/inline-md.js`** — strict markdown subset (`**bold**`, `*italic*`, `[text](url)`, `<br>`). HTML-escapes everything else. URL allowlist: https / http / mailto / root-relative.
- **`src/components/v2/HtmlPreview.jsx`** — short-circuits when `units.length === 0` so legacy reports render their inline HTML untouched.
- **`src/components/v2/UnitsPanel.jsx`** + `PATCH /api/v2/content_units/:id` — side-panel editor. Writes through to the `v2_content_units` row; preview re-substitutes on change.

### Validator gating (legacy compatibility)

The validator is **gated** so legacy reports keep working:

| Handler | Gate condition |
|---------|----------------|
| `persist_freeform_pages` | `incoming units.length > 0` OR existing `v2_content_units` rows for the report |
| `render_freeform_pdf` | `units rows for the report > 0` OR pages reference `data-unit` |
| `render_freeform_thumbnails` | `incoming units.length > 0` OR pages reference `data-unit` |

Reports created before migration 030 have zero units rows and HTML that pre-dates `data-unit`. The validator never fires for them; `units-substitute` is a no-op on an empty units array; `HtmlPreview` short-circuits. Editor opens cleanly.

### Migration 031 — legacy column comments

`v2_report_modules.html_content` and `v2_report_modules.html_cache` are now annotated with deprecation comments. They are kept for legacy reports but new alpha-v3 content goes through units. See `db/migrations/031_legacy_module_html_comments.sql`.

## smyra-render integration

`render_freeform_pdf` posts page HTML + units + brand assets to smyra-render's `/render/pdf` endpoint with a short-lived RS256 JWT. The Python service runs `substitute_units` on incoming HTML (Python mirror of `units-substitute.js`), then hands off to Puppeteer for rasterisation. WeasyPrint is dropped — render.py docstrings still mention it but the actual rendering pipeline is Puppeteer-only as of Layer J.

## Migration workflow

```bash
# Run a migration against the live DB
node scripts/run-migration.mjs db/migrations/NNN_<name>.sql
```

`scripts/run-migration.mjs` reads `DATABASE_URL` (or `NEON_DATABASE_URL`) from `.env`, opens a Neon Pool, and runs the file as a single multi-statement query — works for PL/pgSQL blocks and `COMMENT ON COLUMN` alike.

## Editor SPA (Vite)

```bash
npm run dev      # localhost dev server
npm run build    # production build to dist/
```

The SPA boots with a hub-issued editor JWT (read from a query param), then talks to the v2 REST endpoints + the hub for MCP calls. State is in Zustand stores under `src/stores/`.

## Running tests

```bash
npx vitest run                      # all tests
npx vitest run validate-units-only  # one file
```

Tests live in `src/lib/__tests__/` and `tests/`. JSDOM environment for DOM-heavy code (`HtmlPreview`, `units-substitute`).

## Environment variables (Netlify)

- `DATABASE_URL` — Neon Postgres connection
- `HUB_JWT_PUBLIC_KEY_PEM` — RS256 public key from hub for incoming JWT verification
- `SMYRA_RENDER_URL` — base URL for the smyra-render service
- `SMYRA_RENDER_JWT_PRIVATE_KEY` — RS256 key used to sign outbound render calls
- `UNSPLASH_ACCESS_KEY` — drives the cache-miss path in `unsplash-direct.js`
- `NETLIFY_BLOBS_TOKEN` (auto-injected on Netlify) — backs `@netlify/blobs` for asset + render storage

See `rotor-platform-hub/CLAUDE.md` for the full platform context (workflow engine, OAuth flow, hub routing).
