-- 019_document_css.sql
-- Single-stylesheet-per-document architecture.
--
-- brand_components now carries css_template alongside html_template, so a
-- saved component brings its classes with it. v2_reports snapshots the
-- assembled stylesheet (brand vars + fonts + layout + render-helpers +
-- component CSS, in that order) at compose time. v2_report_modules gets
-- content_mapping so structured/repeating placeholders are stored
-- explicitly instead of being reconstructed from slots every time.

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS css_template TEXT;

ALTER TABLE v2_reports
  ADD COLUMN IF NOT EXISTS document_css TEXT;

ALTER TABLE v2_report_modules
  ADD COLUMN IF NOT EXISTS content_mapping JSONB;
