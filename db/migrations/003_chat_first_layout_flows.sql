ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'analyzing';
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'suggesting';
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'patching';
ALTER TYPE doc_status ADD VALUE IF NOT EXISTS 'preflight';

CREATE TABLE IF NOT EXISTS brand_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_brand_profiles_user
  ON brand_profiles (hub_user_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS brand_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id UUID NOT NULL REFERENCES brand_profiles(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  brand_tokens JSONB NOT NULL DEFAULT '{}'::jsonb,
  typography_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  layout_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (brand_profile_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_brand_profile_versions_profile
  ON brand_profile_versions (brand_profile_id, version_no DESC);

CREATE TABLE IF NOT EXISTS design_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_user_id TEXT NOT NULL,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  brand_profile_id UUID REFERENCES brand_profiles(id) ON DELETE SET NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('design_example', 'photo', 'logo', 'pdf_reference')),
  mime_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_design_assets_user
  ON design_assets (hub_user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_design_assets_document
  ON design_assets (document_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_design_assets_profile
  ON design_assets (brand_profile_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS asset_derivatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES design_assets(id) ON DELETE CASCADE,
  variant TEXT NOT NULL CHECK (variant IN ('thumb', 'preview', 'print')),
  blob_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_id, variant)
);

CREATE TABLE IF NOT EXISTS document_layout_patches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_node_id TEXT,
  patch JSONB NOT NULL,
  reason TEXT,
  applied_by TEXT NOT NULL CHECK (applied_by IN ('ai', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_layout_patches_document
  ON document_layout_patches (document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_layout_metrics (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS brand_profile_id UUID REFERENCES brand_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS layout_ast JSONB,
  ADD COLUMN IF NOT EXISTS layout_fingerprint JSONB,
  ADD COLUMN IF NOT EXISTS layout_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS decision_context JSONB;

CREATE INDEX IF NOT EXISTS idx_documents_brand_profile
  ON documents (brand_profile_id)
  WHERE deleted_at IS NULL;
