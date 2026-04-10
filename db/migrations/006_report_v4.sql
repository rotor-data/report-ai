CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS report_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_user_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('url', 'upload')),
  source_url TEXT,
  blob_key TEXT NOT NULL,
  page_count INTEGER,
  component_inventory JSONB,
  design_tokens_extracted JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_content_schema (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES report_manifests(id) ON DELETE CASCADE,
  content_schema JSONB NOT NULL,
  page_type_map JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES report_manifests(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  page_type TEXT NOT NULL,
  layout_name TEXT NOT NULL,
  instance_id TEXT,
  template_html TEXT,
  tokens JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manifest_id, page_number)
);

CREATE TABLE IF NOT EXISTS report_generated_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES report_pages(id) ON DELETE CASCADE,
  html_output TEXT NOT NULL,
  svg_fragments JSONB,
  render_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (page_id)
);

CREATE TABLE IF NOT EXISTS report_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES report_manifests(id) ON DELETE CASCADE,
  hub_user_id TEXT NOT NULL,
  company_name TEXT,
  schema_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manifest_id, hub_user_id)
);

CREATE INDEX IF NOT EXISTS idx_report_manifests_hub_user_id
  ON report_manifests (hub_user_id);

CREATE INDEX IF NOT EXISTS idx_report_content_schema_manifest_id
  ON report_content_schema (manifest_id);

CREATE INDEX IF NOT EXISTS idx_report_pages_manifest_id
  ON report_pages (manifest_id, page_number);

CREATE INDEX IF NOT EXISTS idx_report_generated_pages_page_id
  ON report_generated_pages (page_id);

CREATE INDEX IF NOT EXISTS idx_report_schemas_manifest_id
  ON report_schemas (manifest_id);
