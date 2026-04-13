-- 009_freeform_modules.sql
-- Add html_content column for Claude-authored HTML modules
-- and extend module_type to include 'freeform'.

-- Add html_content column (nullable TEXT for Claude-authored HTML)
ALTER TABLE v2_report_modules ADD COLUMN IF NOT EXISTS html_content TEXT;

-- Drop the old check constraint and add updated one with 'freeform'
ALTER TABLE v2_report_modules DROP CONSTRAINT IF EXISTS v2_report_modules_module_type_check;
ALTER TABLE v2_report_modules ADD CONSTRAINT v2_report_modules_module_type_check
  CHECK (module_type IN ('cover', 'chapter_break', 'back_cover', 'layout', 'freeform'));
