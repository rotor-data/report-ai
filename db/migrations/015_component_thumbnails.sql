-- 015_component_thumbnails.sql
-- Cache PNG thumbnail URLs per brand component so design_components and
-- page_assignment steps can show visual previews to the user without
-- re-rendering on every request.

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_generated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_brand_components_has_thumb
  ON brand_components (brand_id, component_type)
  WHERE thumbnail_url IS NOT NULL;
