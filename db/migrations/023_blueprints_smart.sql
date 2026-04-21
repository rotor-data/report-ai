-- 023_blueprints_smart.sql
-- Evolve report_blueprints from literal module-lists to smart,
-- intent-driven templates that Claude can adapt to content.
--
-- Legacy blueprints keep working: their data lives in `modules` JSONB,
-- and the endpoint's existing "clone to report" flow stays intact.
-- New blueprints use `slots` + `narrative_guidance` + metadata, and are
-- rendered by Claude at report-creation time using the content hints.
--
-- Visibility model:
--   private — only the tenant sees it (default for user-created bps)
--   brand   — all reports under a brand see it
--   smyra   — shown to every tenant as "by Smyra" platform templates

ALTER TABLE report_blueprints
  -- Allow Smyra-wide blueprints with no owning brand
  ALTER COLUMN brand_id DROP NOT NULL,

  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'brand', 'smyra')),
  ADD COLUMN IF NOT EXISTS owner_tenant_id UUID,

  -- Classification for filtering + chat surfacing
  ADD COLUMN IF NOT EXISTS document_type TEXT,
  ADD COLUMN IF NOT EXISTS style_direction TEXT,
  ADD COLUMN IF NOT EXISTS tagline TEXT,
  ADD COLUMN IF NOT EXISTS chat_summary TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}',

  -- Intent-driven slot structure (see design-spec in CLAUDE.md)
  ADD COLUMN IF NOT EXISTS slots JSONB,
  ADD COLUMN IF NOT EXISTS narrative_guidance JSONB,

  -- Preview assets — small inline, large as URL
  ADD COLUMN IF NOT EXISTS thumbnail_small_base64 TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,

  -- Rendering hints
  ADD COLUMN IF NOT EXISTS pages_estimate INT,
  ADD COLUMN IF NOT EXISTS page_format TEXT NOT NULL DEFAULT 'a4_portrait',

  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_blueprints_visibility_type
  ON report_blueprints(visibility, document_type);

CREATE INDEX IF NOT EXISTS idx_blueprints_smyra
  ON report_blueprints(visibility) WHERE visibility = 'smyra';

-- Auto-update updated_at on modifications
CREATE OR REPLACE FUNCTION update_blueprint_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blueprints_updated_at ON report_blueprints;
CREATE TRIGGER blueprints_updated_at
  BEFORE UPDATE ON report_blueprints
  FOR EACH ROW
  EXECUTE FUNCTION update_blueprint_timestamp();
