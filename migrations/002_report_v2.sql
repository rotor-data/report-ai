-- Migration 002: Report Engine v2 tables
-- Creates all tables for the v2 modular report system.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Trigger function ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Brands ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  tokens JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brands_tenant_id
  ON brands (tenant_id);

-- ─── Brand Fonts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_fonts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  weight INTEGER NOT NULL,
  style TEXT NOT NULL DEFAULT 'normal',
  format TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_fonts_brand_id
  ON brand_fonts (brand_id);

-- ─── Brand Logos ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand_logos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  format TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_logos_brand_id
  ON brand_logos (brand_id);

-- ─── Tenant Assets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_url TEXT NOT NULL,
  width_px INTEGER,
  height_px INTEGER,
  size_bytes INTEGER,
  dpi INTEGER,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('photo', 'icon', 'svg')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_assets_tenant_id
  ON tenant_assets (tenant_id);

-- ─── Report Templates ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  document_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  css_base TEXT NOT NULL,
  schema JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── V2 Reports ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE SET NULL,
  template_id TEXT REFERENCES report_templates(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  document_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v2_reports_tenant_id
  ON v2_reports (tenant_id);

CREATE INDEX IF NOT EXISTS idx_v2_reports_brand_id
  ON v2_reports (brand_id);

DROP TRIGGER IF EXISTS trg_v2_reports_updated_at ON v2_reports;
CREATE TRIGGER trg_v2_reports_updated_at
  BEFORE UPDATE ON v2_reports
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ─── V2 Report Pages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2_report_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES v2_reports(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  page_type TEXT NOT NULL DEFAULT 'content',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_v2_report_pages_report_id
  ON v2_report_pages (report_id, page_number);

-- ─── V2 Report Modules ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS v2_report_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES v2_reports(id) ON DELETE CASCADE,
  page_id UUID REFERENCES v2_report_pages(id) ON DELETE SET NULL,
  module_type TEXT NOT NULL CHECK (module_type IN ('cover', 'chapter_break', 'back_cover', 'layout')),
  order_index INTEGER NOT NULL,
  content JSONB NOT NULL,
  style JSONB NOT NULL DEFAULT '{}'::jsonb,
  html_cache TEXT,
  height_mm DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v2_report_modules_report_order
  ON v2_report_modules (report_id, order_index);

CREATE INDEX IF NOT EXISTS idx_v2_report_modules_page_id
  ON v2_report_modules (page_id);

DROP TRIGGER IF EXISTS trg_v2_report_modules_updated_at ON v2_report_modules;
CREATE TRIGGER trg_v2_report_modules_updated_at
  BEFORE UPDATE ON v2_report_modules
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ─── Report Blueprints ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_blueprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_report_id UUID REFERENCES v2_reports(id) ON DELETE SET NULL,
  modules JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_blueprints_brand_id
  ON report_blueprints (brand_id);
