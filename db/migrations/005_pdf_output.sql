-- Add pdf_output column to store generated PDF bytes
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pdf_output BYTEA;
