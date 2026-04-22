-- 026_component_style_family.sql
-- Tag each brand_components variant with its visual family so the
-- library picker can maintain style coherence across a single report.
--
-- Previously (before 025 + scoreVariant) the picker chose the highest-
-- scored variant per type in isolation → Colossus cover + Creative body
-- + Bottom-rule heading ended up in the same report. That's style
-- schizophrenia. Adding a family tag lets the picker prefer variants
-- that share a family with the cover (the lead component).

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS style_family TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_brand_components_family
  ON brand_components(brand_id, style_family, component_type)
  WHERE style_family IS NOT NULL;
