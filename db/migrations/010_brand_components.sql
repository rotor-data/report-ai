-- 010_brand_components.sql
-- Reusable component library: small HTML templates stored per brand.
-- Each component is ~10-30 lines of HTML with {{PLACEHOLDER}} tokens.
-- Components compose into pages via CSS Grid in the compose_pages step.

CREATE TABLE IF NOT EXISTS brand_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL CHECK (component_type IN (
    'heading', 'body_text', 'pullquote', 'callout', 'list', 'comparison',
    'kpi_group', 'kpi_hero', 'data_table', 'chart', 'fact_strip', 'timeline', 'metric_change',
    'image', 'icon_grid', 'team_grid', 'logo_grid', 'full_bleed_image',
    'two_column', 'sidebar_box',
    'cover', 'chapter_break', 'back_cover', 'divider', 'toc', 'colophon'
  )),
  label TEXT NOT NULL,
  html_template TEXT NOT NULL,
  placeholder_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  design_notes TEXT,
  source TEXT CHECK (source IN ('extraction', 'report', 'manual')),
  version INTEGER NOT NULL DEFAULT 1,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_components_brand_type
  ON brand_components (brand_id, component_type);

CREATE INDEX IF NOT EXISTS idx_brand_components_brand_default
  ON brand_components (brand_id, is_default) WHERE is_default = true;
