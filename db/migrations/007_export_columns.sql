-- Add export output columns for IDML, DOCX, PPTX
ALTER TABLE documents ADD COLUMN IF NOT EXISTS idml_output BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS docx_output BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pptx_output BYTEA;
