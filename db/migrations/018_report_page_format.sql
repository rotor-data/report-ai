-- 018_report_page_format.sql
-- Per-report page format so the render pipeline and preview can size
-- pages correctly (A4 portrait vs A4 landscape vs presentation 16:9, etc).
-- Without this the PDF defaulted to A4 portrait regardless of what the
-- user picked during setup.

ALTER TABLE v2_reports
  ADD COLUMN IF NOT EXISTS page_format TEXT NOT NULL DEFAULT 'a4_portrait';
