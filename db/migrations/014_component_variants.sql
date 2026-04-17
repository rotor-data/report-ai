-- 014_component_variants.sql
-- Add variant_name support to brand_components so a brand can have multiple
-- named variants of the same component_type (e.g. "Bold", "Minimal",
-- "Editorial" headings) that can be chosen per report module.
--
-- Mirrors the `variant` pattern already established in brand_logos.

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS variant_name TEXT NOT NULL DEFAULT 'Default';

-- Index for fast lookups per (brand, type, variant)
CREATE INDEX IF NOT EXISTS idx_brand_components_variant
  ON brand_components (brand_id, component_type, variant_name);

-- Backfill: existing is_default=true rows already indicate the canonical
-- variant. Label them 'Default' explicitly (the column default above
-- already set them to 'Default'; this is idempotent).
UPDATE brand_components
  SET variant_name = 'Default'
  WHERE variant_name IS NULL OR variant_name = '';
