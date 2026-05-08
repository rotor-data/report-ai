-- 036_blueprint_gallery.sql
-- Pre-rendered gallery image for blueprints — 2x2 PNG grid of the first
-- four sample pages, generated ONCE at save_blueprint time and cached on
-- the row. Replaces the ad-hoc multi-page renderFreeformThumbnails call
-- that the blueprint_preview pause used to make on every visit (which
-- timed out Lambda on cold start when blueprints had >4 samples).
--
-- Filled by a fire-and-forget job in handleSaveBlueprint, parallel to the
-- existing renderBlueprintCover. Setup's blueprint_preview phase reads
-- gallery_url first; if missing, falls back to a 4-page-capped thumbnail
-- render plus a backfill kick.

ALTER TABLE report_blueprints
  ADD COLUMN IF NOT EXISTS gallery_url TEXT,
  ADD COLUMN IF NOT EXISTS gallery_generated_at TIMESTAMPTZ;

COMMENT ON COLUMN report_blueprints.gallery_url IS '2x2 PNG grid of first 4 samples, generated at save time. Replaces ad-hoc thumbnail rendering in blueprint_preview pause.';
COMMENT ON COLUMN report_blueprints.gallery_generated_at IS 'When gallery_url was last written. NULL = needs (re)generation.';
