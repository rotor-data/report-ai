-- 016_component_status.sql
-- Distinguish "ready" components (validated + ready for production use in
-- reports) from "draft" (work-in-progress, shouldn't be offered as library
-- options) and "deprecated" (kept for history but hidden from pickers).

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';

-- Backfill: existing rows with non-empty html_template that look valid
-- are treated as 'ready'. Empty templates stay 'draft' so they're
-- filtered out of library offers until someone fixes them.
UPDATE brand_components
  SET status = 'ready'
  WHERE html_template IS NOT NULL
    AND LENGTH(TRIM(html_template)) > 20
    AND status = 'draft';

-- Deprecate obvious placeholder/fallback rows that shouldn't be offered
-- (very short templates, or ones whose label starts with "fallback").
UPDATE brand_components
  SET status = 'deprecated'
  WHERE (html_template IS NULL OR LENGTH(TRIM(html_template)) < 20)
    AND status != 'deprecated';

CREATE INDEX IF NOT EXISTS idx_brand_components_status
  ON brand_components (brand_id, status, component_type)
  WHERE status = 'ready';
