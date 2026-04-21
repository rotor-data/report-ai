-- 025_component_theme_metadata.sql
-- Theme metadata for smart variant picking and chart color reconciliation.
--
-- These columns are read by theme-reconcile (smyra-core) after design_components
-- to score variants against brand palette and content length, and by compose-pages
-- to drive chart color derivation. All columns are additive with safe defaults so
-- existing saved components are fully functional without a backfill.
--
-- chart_schema / chart_color_mode are only meaningful for component_type='chart' rows;
-- they are nullable / default-safe for all other types.

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS harmony TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS intensity TEXT DEFAULT 'medium'
    CHECK (intensity IN ('quiet', 'medium', 'loud')),
  ADD COLUMN IF NOT EXISTS accent_usage TEXT DEFAULT 'tint'
    CHECK (accent_usage IN ('none', 'tint', 'strong')),
  ADD COLUMN IF NOT EXISTS content_tolerance JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS chart_schema JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS chart_color_mode TEXT DEFAULT 'brand'
    CHECK (chart_color_mode IN ('brand', 'custom', 'brand-locked'));
