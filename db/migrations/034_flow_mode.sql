-- Migration 034: flow_mode for cross-page text reflow
--
-- Reflow plan (2026-05-08), Job 5. Adds two columns:
--   1. document_type_templates.flow_mode_default — doctype-level preference
--      for prose-flowing pagination. CEO letters / narrative chapters
--      default TRUE; quarterly reports / KPI dashboards default FALSE.
--   2. v2_report_pages.block_type, .block_index, .flow_pdf_pages — per-row
--      metadata for flow-mode reports. block_type='chapter' rows render as
--      `<section class="chapter">` with Chromium-driven pagination;
--      block_type='page' (default) keeps the existing fixed-canvas behaviour.
--
-- Both modes coexist. Existing reports get block_type='page' automatically
-- via the column default and behave exactly as before.

ALTER TABLE document_type_templates
  ADD COLUMN IF NOT EXISTS flow_mode_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: prose-heavy doctypes opt in.
UPDATE document_type_templates
SET flow_mode_default = TRUE
WHERE document_type IN ('ceo_letter', 'press_release', 'newsletter');

ALTER TABLE v2_report_pages
  ADD COLUMN IF NOT EXISTS block_type TEXT NOT NULL DEFAULT 'page',
  ADD COLUMN IF NOT EXISTS block_index INT,
  ADD COLUMN IF NOT EXISTS flow_pdf_pages INT[];

COMMENT ON COLUMN v2_report_pages.block_type IS
  'page = fixed 297mm canvas (original behaviour). chapter = flowing column, paginates over flow_pdf_pages via Chromium. Reflow plan 2026-05-08, Job 4.';
COMMENT ON COLUMN v2_report_pages.block_index IS
  'Author-order index of the block (1-based). For chapter blocks this is the canonical position; flow_pdf_pages records the post-render PDF page numbers the chapter occupies.';
COMMENT ON COLUMN v2_report_pages.flow_pdf_pages IS
  'PDF page numbers a chapter occupies after the most recent render. Null for fixed page rows. Recomputed every render — informational, not a hard contract.';
