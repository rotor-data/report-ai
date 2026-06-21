-- 043_rls_policies.sql
--
-- RLS · (c) POLICIES + ENABLE (NOT FORCE) on report.*
--
-- HELD / SAFE TO APPLY (shadow). Creates one `tenant_isolation` policy per
-- protected report.* table and ENABLEs RLS — but does NOT FORCE it. While
-- the app connects as the table owner (neondb_owner), the owner BYPASSES
-- non-forced RLS → ZERO runtime effect. Enforcement is the separate
-- 044_rls_ENFORCEMENT.sql, applied last per the runbook.
--
-- Prereqs: smyra-studio migrations/rls/100_app_current_tenant.sql (the
-- app.current_tenant() helper, shared across all schemas) AND
-- 042_rls_tenant_backfill.sql MUST be applied first.
--
-- SCHEMA NOTE: tables referenced UNQUALIFIED, search_path → report (the 041
-- convention). app.current_tenant() is schema-qualified (lives in `app`).
--
-- IDEMPOTENT: DROP POLICY IF EXISTS before CREATE; ENABLE is idempotent.

DO $$
DECLARE
  t text;
  -- every protected report.* table now carries tenant_id (002/008/030 +
  -- the 042 denormalise). All use the cheap column predicate.
  tenant_col_tables text[] := ARRAY[
    'v2_reports', 'v2_report_modules', 'v2_report_pages', 'v2_content_units',
    'report_templates', 'report_blueprints', 'brand_fonts', 'brand_logos',
    'brand_components', 'design_extractions', 'extract_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_col_tables LOOP
    IF to_regclass('report.' || t) IS NULL THEN
      RAISE NOTICE 'report.% absent — skipping policy.', t;
      CONTINUE;
    END IF;
    -- Column guard: 042 only denormalised tenant_id onto the LIVE v2_* / brand_*
    -- set. Legacy tables (e.g. report_templates) + any 042 missed (brand_logos)
    -- have no tenant_id → cannot carry the column predicate. Skip + flag as a
    -- §6a residual rather than abort the whole shadow run. (Shadow = ENABLE not
    -- FORCE → owner bypasses → zero runtime effect regardless.)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='report' AND table_name=t
                      AND column_name='tenant_id') THEN
      RAISE NOTICE 'report.% has NO tenant_id — policy SKIPPED (residual for §6a audit / 042 follow-up).', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = app.current_tenant()) '
      'WITH CHECK (tenant_id = app.current_tenant())', t);
    RAISE NOTICE 'report.%: tenant_isolation policy created.', t;
  END LOOP;
END $$;

-- document_type_templates: audit whether it is per-tenant or a GLOBAL shared
-- catalog. If global (no tenant_id), it is INTENTIONALLY left un-RLS'd (read
-- shared by all tenants) and documented as an exception in the runbook.
-- The §6a audit (smyra-studio migrations/rls/090_AUDIT_column_confidence.sql)
-- decides this before enforcement.
DO $$
BEGIN
  IF to_regclass('report.document_type_templates') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='report' AND table_name='document_type_templates'
                    AND column_name='tenant_id') THEN
    ALTER TABLE document_type_templates ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON document_type_templates;
    CREATE POLICY tenant_isolation ON document_type_templates
      USING (tenant_id = app.current_tenant())
      WITH CHECK (tenant_id = app.current_tenant());
    RAISE NOTICE 'report.document_type_templates: tenant_isolation policy created.';
  ELSE
    RAISE NOTICE 'report.document_type_templates: no tenant_id → treated as GLOBAL shared catalog (no policy). Confirm in §6a audit.';
  END IF;
END $$;
