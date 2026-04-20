-- 021_report_style_overrides.sql
-- Per-report overrides for brand tokens so authors can tweak
-- colours + fonts for a single report without touching the shared
-- brand_tokens row (which is used by every report on the brand).
--
-- Stored as a JSONB document with the same keys we already use in
-- brand_tokens (primary, accent, text, bg, surface, heading_font,
-- body_font, ...). v2-brand-css merges this on top of the brand row
-- at read time. Empty / null values fall through to the brand defaults.
ALTER TABLE v2_reports
  ADD COLUMN IF NOT EXISTS style_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
