-- 041_editor_updated_at.sql
--
-- Fully-safe clobber guard for editor edits (editor-rebuild-PLAN Phase 1; completes
-- the Phase 0 TODO in smyra-studio src/handlers/report/structure.js).
--
-- WHY
--   report2__persist_freeform_pages (a Claude re-compose) DELETEs every page/module
--   and re-INSERTs the composed HTML. A user's later MANUAL editor edits — which write
--   report.v2_report_modules.html_cache directly via the editor (v2-modules PATCH) or
--   via report2__apply_page_patch — were silently destroyed. Phase 0 added detection
--   only; it could not SKIP the overwrite because there was no per-page marker telling
--   a manual edit apart from a Claude compose.
--
--   editor_updated_at IS that marker: set to NOW() on every authoritative editor write,
--   left NULL on a Claude compose. persist_freeform_pages KEEPS the DB html_cache for any
--   page whose module has editor_updated_at set (unless the caller passes force:true),
--   so a re-compose never clobbers a manual edit.
--
-- NOTE: report.v2 tables are referenced unqualified here (search_path → report) to match
-- the existing v2 migration convention (see 002_report_v2.sql, 038_v2_reports_created_by.sql).
-- Idempotent. RUN THIS BEFORE deploying the studio/report-ai code that writes the column.

ALTER TABLE v2_report_modules
  ADD COLUMN IF NOT EXISTS editor_updated_at timestamptz;

COMMENT ON COLUMN v2_report_modules.editor_updated_at IS
  'Set to NOW() on an authoritative manual editor edit (report2__apply_page_patch / v2-modules PATCH). NULL on a Claude compose (persist_freeform_pages). persist_freeform_pages preserves the DB html_cache for pages where this is non-null instead of overwriting them with the re-compose (skip-if-edited clobber guard). Opt out with force:true.';
