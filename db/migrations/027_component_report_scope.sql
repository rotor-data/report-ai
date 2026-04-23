-- Report-scoped brand_components (Level 3 of the smart-templates plan).
--
-- Background: Claude's art-direct step picks from the brand's library of
-- named variants (heading/Overline, heading/Bottom-rule etc.). When the
-- library doesn't have a variant that fits a specific content shape —
-- e.g. a KPI strip that needs 4 values but no existing variant renders
-- 4 without overflow — the workflow currently has no way to design a
-- one-off variant without polluting the brand's library.
--
-- This migration adds a nullable `report_id` column. When set, the
-- variant is scoped to that report only: listComponents merges brand-
-- library components with report-scoped ones (report-scoped last wins
-- on the same component_type+variant_name), and the editor shows them
-- separately.
--
-- NULL = brand-level (default, unchanged).
-- Non-NULL = one-off variant designed during the module-review redesign
--            loop in report2.review step.
--
-- Cascade delete: if the report is deleted, its scoped variants go too
-- — they're not reusable elsewhere anyway.

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS report_id UUID NULL
    REFERENCES v2_reports(id) ON DELETE CASCADE;

-- Queries that load a report's components always filter by (brand_id,
-- component_type) and optionally by (report_id IS NULL OR report_id = $1).
-- A partial index keeps the hot path cheap: every report-scoped variant
-- tagged + indexed, brand-library rows skip the index.
CREATE INDEX IF NOT EXISTS brand_components_report_id_idx
  ON brand_components(report_id)
  WHERE report_id IS NOT NULL;

COMMENT ON COLUMN brand_components.report_id IS
  'Non-NULL for variants designed during a single report''s review loop — not visible outside that report. NULL for brand-library variants.';
