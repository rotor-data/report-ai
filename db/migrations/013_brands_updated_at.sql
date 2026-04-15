-- Add updated_at to brands so save_brand_tokens / apply_design_extraction
-- can persist without failing on "column updated_at of relation brands does not exist".
--
-- The handlers in mcp-v2.js (handleSaveBrandTokens, handleApplyDesignExtraction)
-- have always set `updated_at = NOW()`, but the original migration 008 only
-- created `created_at`. This migration adds the missing column and back-fills
-- existing rows to created_at.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Back-fill: existing rows get updated_at = created_at so the audit trail
-- is truthful for pre-migration data.
UPDATE brands
  SET updated_at = created_at
  WHERE updated_at = created_at
     OR updated_at IS NULL;
