-- 017_component_page_format.sql
-- Tag each brand component with the page format it was designed for
-- (a4_portrait, a4_landscape, presentation, us_letter, square, digital,
-- or 'universal' for format-agnostic components like inline text).
-- list_components can then filter to variants that fit the current
-- report's page format, avoiding landscape-cover / portrait-layout
-- mismatches.

ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS page_format TEXT NOT NULL DEFAULT 'universal';

-- Heuristic backfill: infer from the html_template if possible.
-- Components that explicitly set 297mm × 210mm (landscape dims) get
-- 'a4_landscape'. 210mm × 297mm → 'a4_portrait'. Others stay 'universal'.
UPDATE brand_components SET page_format = 'a4_landscape'
  WHERE html_template LIKE '%width:297mm%height:210mm%'
     OR html_template LIKE '%width: 297mm%height: 210mm%';

UPDATE brand_components SET page_format = 'a4_portrait'
  WHERE html_template LIKE '%width:210mm%height:297mm%'
     OR html_template LIKE '%width: 210mm%height: 297mm%';

CREATE INDEX IF NOT EXISTS idx_brand_components_page_format
  ON brand_components (brand_id, page_format, component_type);
