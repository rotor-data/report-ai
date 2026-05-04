-- 031_legacy_module_html_comments.sql
--
-- Mark `v2_report_modules.html_content` and `v2_report_modules.html_cache`
-- as legacy. These columns predate the alpha-v3 content-units pipeline
-- (see 030_v2_content_units.sql); new reports compose pages from
-- `data-unit` references against `v2_content_units` and substitute text
-- at render time.
--
-- The columns stay (legacy reports still depend on them) but the comment
-- documents the deprecation so a future engineer reading the schema does
-- not assume they are the canonical write target for new content.

COMMENT ON COLUMN v2_report_modules.html_content IS
  'Legacy: inline HTML for pre-units alpha-v3 reports. New reports compose pages via data-unit refs against v2_content_units; this column is kept read-only for backwards compat and may be removed in a future cleanup pass.';

COMMENT ON COLUMN v2_report_modules.html_cache IS
  'Legacy: rendered HTML cache for pre-units reports. New reports use units substitution at render time so html_cache is recomputed per call. Keep for legacy fallback.';
