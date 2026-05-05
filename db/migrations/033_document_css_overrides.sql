-- Migration 033: add v2_reports.document_css_overrides
--
-- The Rapport-stil panel writes late-cascade CSS overrides per report.
-- Both persist_freeform_pages (mcp-v2.js:~4087) and render_freeform_pdf
-- (mcp-v2.js:~4311) UPDATE the column; handleRenderPdf (~1133) reads
-- it. Migration 019 added v2_reports.document_css but the partner
-- overrides column was never schema'd — code referenced a column that
-- didn't exist, so persist_freeform_pages threw:
--
--   column "document_css_overrides" of relation "v2_reports" does not exist
--
-- The render path's UPDATE is wrapped in try/catch (non-fatal — a
-- warning logs and the rendered PDF still returns), but persist's
-- UPDATE is fatal. First production hit: report
-- 73b15cfa-8c06-4ea7-8f57-2397e247eda6 (Freebo ceo_letter, 2026-05-05).

ALTER TABLE v2_reports
  ADD COLUMN IF NOT EXISTS document_css_overrides TEXT;
