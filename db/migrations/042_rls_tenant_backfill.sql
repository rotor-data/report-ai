-- 042_rls_tenant_backfill.sql
--
-- RLS · (a) ADDITIVE — make every protected report.* table tenant-scoped.
--
-- HELD / SAFE TO APPLY EARLY. Additive only: adds/denormalises tenant_id and
-- backfills it. No policy, no RLS enable, no FORCE, no role change, no
-- behaviour a user can observe. Pure groundwork for the report.* RLS policies
-- in 043_rls_policies.sql and the enforcement in 044_rls_ENFORCEMENT.sql.
--
-- SCHEMA NOTE: in the merged smyra-studio DB these tables live in schema
-- `report` and are referenced UNQUALIFIED here, relying on search_path →
-- report (same convention as 041_editor_updated_at.sql). Apply with the
-- report search_path active.
--
-- Carrier audit (report-ai db/migrations source, 2026-06-21):
--   tenant_id already present:
--     v2_reports (NOT NULL), report_templates (NOT NULL),
--     brand_logos (NOT NULL), extract_jobs (NULLABLE),
--     design_extractions (NULLABLE)
--   report_id-only (denormalise tenant_id from v2_reports here):
--     v2_report_modules, v2_report_pages, v2_content_units
--   brand_id-only (denormalise tenant_id from core.brands.org_id here):
--     brand_fonts, brand_components, report_blueprints
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + NULL-guarded backfills.

-- ── 1. report_id-only children → denormalise tenant_id from v2_reports ──
ALTER TABLE v2_report_modules ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE v2_report_pages   ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE v2_content_units  ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE v2_report_modules m SET tenant_id = r.tenant_id
  FROM v2_reports r WHERE m.tenant_id IS NULL AND m.report_id = r.id;
UPDATE v2_report_pages p SET tenant_id = r.tenant_id
  FROM v2_reports r WHERE p.tenant_id IS NULL AND p.report_id = r.id;
UPDATE v2_content_units u SET tenant_id = r.tenant_id
  FROM v2_reports r WHERE u.tenant_id IS NULL AND u.report_id = r.id;

-- ── 2. brand_id-only tables → denormalise tenant_id from core.brands.org_id
-- core.brands is cross-schema in the merged DB; reference it qualified.
ALTER TABLE brand_fonts       ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE brand_components  ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE report_blueprints ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE brand_fonts f SET tenant_id = b.org_id
  FROM core.brands b WHERE f.tenant_id IS NULL AND f.brand_id = b.id;
UPDATE brand_components c SET tenant_id = b.org_id
  FROM core.brands b WHERE c.tenant_id IS NULL AND c.brand_id = b.id;
UPDATE report_blueprints bp SET tenant_id = b.org_id
  FROM core.brands b WHERE bp.tenant_id IS NULL AND bp.brand_id = b.id;

-- ── 3. extract_jobs / design_extractions: tenant_id is NULLABLE → backfill
-- where derivable from brand_id, leave nullable otherwise (worker-scoped;
-- those run under the service role, see runbook §5).
UPDATE design_extractions d SET tenant_id = b.org_id
  FROM core.brands b WHERE d.tenant_id IS NULL AND d.brand_id = b.id;

-- ── 4. Guarded NOT NULL tighten on the denormalised children ────────────
DO $$
DECLARE n bigint; tbl text; tbls text[] := ARRAY[
  'v2_report_modules','v2_report_pages','v2_content_units',
  'brand_fonts','brand_components','report_blueprints'
];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NULL', tbl) INTO n;
    IF n = 0 THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', tbl);
      RAISE NOTICE '%.tenant_id → NOT NULL (clean backfill).', tbl;
    ELSE
      RAISE NOTICE '% : % rows still NULL tenant_id — LEFT NULLABLE, flag in rollout audit.', tbl, n;
    END IF;
  END LOOP;
END $$;

-- indexes for the column-predicate policies on the hot child tables
CREATE INDEX IF NOT EXISTS idx_v2_report_modules_tenant ON v2_report_modules (tenant_id);
CREATE INDEX IF NOT EXISTS idx_v2_report_pages_tenant   ON v2_report_pages (tenant_id);
CREATE INDEX IF NOT EXISTS idx_v2_content_units_tenant  ON v2_content_units (tenant_id);
CREATE INDEX IF NOT EXISTS idx_brand_fonts_tenant       ON brand_fonts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_brand_components_tenant  ON brand_components (tenant_id);
CREATE INDEX IF NOT EXISTS idx_report_blueprints_tenant ON report_blueprints (tenant_id);
