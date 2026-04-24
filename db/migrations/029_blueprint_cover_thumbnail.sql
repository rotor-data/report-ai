-- 029_blueprint_cover_thumbnail.sql
-- ============================================================
-- Adds a cover_thumbnail_url column to report_blueprints so the
-- setup picker in smyra-core can show a visual preview of each
-- blueprint before the user commits.
--
-- Populated at save_blueprint time by rendering sample_pages_html[0]
-- through the existing freeform-thumbnail render path. The rest of
-- sample_pages_html is still rendered on demand if the user asks to
-- see the full preview (phase='blueprint_preview' in setup.ts).
--
-- NULL is allowed — legacy alpha-v3 blueprints saved before this
-- migration have no cover; the picker falls back to a text-only
-- choice for them. A backfill script can re-render them later.
-- ============================================================

ALTER TABLE report_blueprints
  ADD COLUMN IF NOT EXISTS cover_thumbnail_url TEXT;

COMMENT ON COLUMN report_blueprints.cover_thumbnail_url IS
  'alpha-v3: URL to a PNG render of sample_pages_html[0]. Used by setup picker for at-a-glance preview.';
