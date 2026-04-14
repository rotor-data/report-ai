-- 011_relax_component_type.sql
-- Remove rigid CHECK constraint on component_type.
-- Component types are validated in application code (with alias resolution).
-- The DB should not block saves for new/custom types.

ALTER TABLE brand_components DROP CONSTRAINT IF EXISTS brand_components_component_type_check;
