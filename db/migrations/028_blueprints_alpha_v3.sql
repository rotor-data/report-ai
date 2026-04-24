-- 028_blueprints_alpha_v3.sql
-- ============================================================
-- Evolve report_blueprints to carry alpha-v3 design-language payloads.
-- Non-destructive: legacy columns (slots, narrative_guidance, modules)
-- stay nullable. alpha-v3 rows populate the new columns; old rows can
-- be filtered out of the picker by requiring design_system_css IS NOT NULL.
--
-- Visibility rename: 'private' → 'tenant'. The hub and smyra-core speak
-- of 'tenant' semantically ("shared within the organisation"); DB had
-- 'private' from an earlier naming. We migrate in place so both layers
-- agree on the enum.
--
-- alpha-v3 pipeline notes:
--   • design_system_css — :root custom-property system + class rules.
--     Cascade-friendly; uses var(--brand-primary, fallback) patterns so
--     the same blueprint adapts across brands without re-authoring.
--   • sample_pages_html — JSONB array of HTML strings demonstrating the
--     design language (cover + 1-3 interior samples).
--   • design_rules — freeform text, Claude's own documentation of how
--     the language should be applied. Read by page_design at compose time.
--   • reference_source — 'starter_pack' | 'extracted_from_pdf' | 'user_created'
--   • module_count — purely a UI hint for the picker.
-- ============================================================

-- ── Add the alpha-v3 payload columns ────────────────────────────────
ALTER TABLE report_blueprints
  ADD COLUMN IF NOT EXISTS design_system_css TEXT,
  ADD COLUMN IF NOT EXISTS sample_pages_html JSONB,
  ADD COLUMN IF NOT EXISTS design_rules     TEXT,
  ADD COLUMN IF NOT EXISTS reference_source TEXT,
  ADD COLUMN IF NOT EXISTS module_count     INT;

-- ── Visibility rename: 'private' → 'tenant' ─────────────────────────
-- The existing CHECK constraint allowed ('private', 'brand', 'smyra').
-- Replace with ('smyra', 'tenant', 'brand') and migrate data.
--
-- The constraint name was set implicitly in migration 023 — safest to
-- drop by searching pg_constraint rather than by a guessed name.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'report_blueprints'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%visibility%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE report_blueprints DROP CONSTRAINT %I', cname);
  END IF;
END $$;

UPDATE report_blueprints SET visibility = 'tenant' WHERE visibility = 'private';

ALTER TABLE report_blueprints
  ADD CONSTRAINT report_blueprints_visibility_check
    CHECK (visibility IN ('smyra', 'tenant', 'brand'));

-- Note: no visibility-ownership CHECK is added. Legacy rows may have
-- visibility='brand' with brand_id=NULL or other inconsistencies that
-- a strict CHECK would reject on migration. The hub/smyra-core always
-- inserts consistent rows; DB-layer enforcement would be defence-in-
-- depth but is not worth breaking the migration for.

-- ── Indexes for the alpha-v3 query paths ────────────────────────────
-- The hub's listBlueprints unions smyra + tenant + brand. Per-tier
-- indexes keep each branch cheap.
CREATE INDEX IF NOT EXISTS idx_blueprints_v3_brand
  ON report_blueprints(brand_id)
  WHERE brand_id IS NOT NULL AND design_system_css IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blueprints_v3_tenant
  ON report_blueprints(owner_tenant_id, visibility)
  WHERE visibility = 'tenant' AND design_system_css IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blueprints_v3_smyra
  ON report_blueprints(visibility)
  WHERE visibility = 'smyra' AND design_system_css IS NOT NULL;

-- ── Comment for operators ───────────────────────────────────────────
COMMENT ON COLUMN report_blueprints.design_system_css IS
  'alpha-v3: :root vars + class rules. Cascades via var(--brand-*) tokens.';
COMMENT ON COLUMN report_blueprints.sample_pages_html IS
  'alpha-v3: JSONB array of HTML strings — cover + interior samples.';
COMMENT ON COLUMN report_blueprints.design_rules IS
  'alpha-v3: Claude-authored usage notes read during page_design.';
COMMENT ON COLUMN report_blueprints.reference_source IS
  'alpha-v3: origin — starter_pack | extracted_from_pdf | user_created.';
