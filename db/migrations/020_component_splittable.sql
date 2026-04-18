-- 020_component_splittable.sql
-- Per-variant flag: can this component be split across page boundaries?
--
-- NULL = "use the type default" (SPLIT_DEFAULTS in code — body_text/list
--        are splittable, everything else is not).
-- TRUE  = explicit override: safe to split even if the type is usually atomic.
-- FALSE = explicit override: keep together even though the type is usually
--         splittable (e.g. a decorated list with per-item backgrounds).
--
-- Used by page-compose for overflow handling and by compose-pages to emit
-- break-inside:avoid hints in the document stylesheet so both our grouping
-- algorithm and WeasyPrint respect the same rule.

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS splittable BOOLEAN DEFAULT NULL;
