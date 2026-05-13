-- 037_brand_audit_log.sql
--
-- Forensic audit trail for brand-data writes. Every brand-scoped mutation
-- (token merge, font upload, logo upload, profile patch) writes one row
-- here in addition to the parent change. Lets us answer "who overwrote
-- Rotor's tokens on 2026-05-13 08:31?" after-the-fact.
--
-- Best-effort: the writer in mcp-v2.js wraps the INSERT in try/catch and
-- logs a warning on failure — a missing audit row never fails the parent
-- write. before/after are JSONB snapshots; binary payloads (font/logo
-- data_base64) are NEVER logged, only the metadata.

CREATE TABLE IF NOT EXISTS brand_audit_log (
  id BIGSERIAL PRIMARY KEY,
  brand_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  actor TEXT NOT NULL,   -- 'hub:workflow_id' or 'user:clerk_id' or JWT sub
  action TEXT NOT NULL,  -- 'tokens_update' | 'font_upload' | 'logo_upload' | 'profile_patch'
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_audit_log_brand
  ON brand_audit_log(brand_id, created_at DESC);
