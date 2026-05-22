-- v2_reports: user-scoped documents.
--
-- Until now v2_reports was tenant + brand_id scoped only — every member of a
-- tenant saw every report. With shared organisations (multiple Daniels in
-- the same tenant), that means each member sees the other's drafts. The
-- model we want: brands/personas/examples/brand-book are shared at the
-- tenant level, but each user's documents are their own by default;
-- explicit sharing across users comes later.
--
-- Backfill: every existing row is set to daniel.pettersson@rrrotor.com's
-- user_id since all 200 current reports were made by him (Hultborn had 0).
-- Future inserts in handleCreate include created_by from the JWT.

ALTER TABLE v2_reports
  ADD COLUMN IF NOT EXISTS created_by uuid;

UPDATE v2_reports
   SET created_by = 'd74603ff-a69d-4f14-a412-b99375eee699'
 WHERE created_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_v2_reports_created_by ON v2_reports(created_by);

COMMENT ON COLUMN v2_reports.created_by IS
  'Hub user_id of the report''s creator. handleListReports filters by this so users see only their own reports. NULL = legacy/unowned (shouldn''t occur post-migration).';
