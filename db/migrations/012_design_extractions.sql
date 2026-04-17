-- 012_design_extractions.sql
--
-- Design extraction sessions — when Claude analyzes a reference PDF and designs
-- components inspired by it, the extracted design tokens (colors, fonts, spacing)
-- and the list of identified component types are stored here — NOT on the brand.
--
-- The brand keeps its real tokens untouched. Each extraction becomes a
-- "design suggestion" that can be applied to a brand later (explicit user action),
-- or used as an overlay when rendering previews.
--
-- Components designed during an extraction reference their extraction_id so you
-- can trace which PDF a given component came from, and so you can fork a whole
-- extraction into another brand in one go.

CREATE TABLE IF NOT EXISTS design_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The brand whose library receives components from this extraction.
  -- Multiple extractions per brand are allowed (try a few references).
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  -- tenant_id is a plain UUID (no tenants table in this schema — it is tracked
  -- per-brand and per-report as a free-form identifier).
  tenant_id UUID,

  -- Human-readable label, e.g. "McKinsey Global AI Report".
  label TEXT NOT NULL,
  -- Free-form description of the reference (source URL, filename, etc.).
  source_description TEXT,

  -- Suggested tokens extracted from the reference. Same shape as brands.tokens
  -- (primary_color, accent_color, font_display, etc.). NOT copied onto the brand
  -- unless the user explicitly promotes them.
  suggested_tokens JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Inventory of component types Claude identified in the reference, together
  -- with which pages each appears on and a short visual description.
  -- Shape: [{ "type": "pullquote", "pages": [12, 34], "notes": "round photo + bold serif" }]
  inventory JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Rasterized reference pages — Netlify Blob keys or external URLs.
  -- Shape: [{ "page": 1, "url": "...", "key": "..." }]
  reference_pages JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 'draft' while editing, 'ready' after review, 'applied' if tokens were
  -- promoted onto the brand.
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'applied', 'archived')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_design_extractions_brand
  ON design_extractions (brand_id);
CREATE INDEX IF NOT EXISTS idx_design_extractions_status
  ON design_extractions (status);

-- ── brand_components extensions ────────────────────────────────────────────

-- Link components to the extraction that produced them (optional).
ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS extraction_id UUID
    REFERENCES design_extractions(id) ON DELETE SET NULL;

-- Mark a component as publicly shareable. Public components can be forked
-- into any brand's library even if originally designed for another brand.
ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

-- Optional semantic hint for image placeholders — lets compose-pages pick a
-- matching Unsplash image automatically. E.g. "corporate team meeting, blue".
ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS unsplash_query TEXT;

-- The reference pages this component was derived from (array of page numbers
-- within the extraction's `reference_pages`). Helps the observation phase
-- show the exact source for a given component type.
ALTER TABLE brand_components
  ADD COLUMN IF NOT EXISTS reference_page_numbers JSONB
    NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_brand_components_extraction
  ON brand_components (extraction_id);
CREATE INDEX IF NOT EXISTS idx_brand_components_public
  ON brand_components (is_public) WHERE is_public = true;
