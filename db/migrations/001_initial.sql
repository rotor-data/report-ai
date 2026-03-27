CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE document_type AS ENUM ('annual_report','quarterly','pitch','proposal');
CREATE TYPE module_type AS ENUM (
  'cover','chapter_break','kpi_grid','text_spread','table',
  'quote_callout','image_text','data_chart','two_col_text',
  'financial_summary','back_cover'
);
CREATE TYPE doc_status AS ENUM ('draft','generating','ready','error');

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  document_type document_type NOT NULL,
  status doc_status NOT NULL DEFAULT 'draft',
  brand_input JSONB,
  design_system JSONB,
  raw_content TEXT,
  module_plan JSONB,
  html_output TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_documents_user ON documents(hub_user_id) WHERE deleted_at IS NULL;

CREATE TABLE custom_fonts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_user_id TEXT NOT NULL,
  family_name TEXT NOT NULL,
  weight TEXT NOT NULL DEFAULT '400',
  style TEXT NOT NULL DEFAULT 'normal',
  format TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
