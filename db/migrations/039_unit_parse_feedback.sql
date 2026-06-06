-- 039_unit_parse_feedback.sql
--
-- Feedback loop for alpha-v3 unit parsing.
--
-- WHY
--   The alpha-v3 pipeline parses raw text into ContentUnit[] via heuristics
--   (see input.collect step). Misclassifications happen: a short paragraph
--   that should have been a heading, a fragment marked paragraph that is
--   really an attribution, etc. Today, when a user edits the unit in the
--   editor, the parse model never learns from it.
--
--   This table records the (old, new) deltas per unit edit so we can:
--     - mine common patterns for heuristic improvements (offline, batch),
--     - surface "heavy edit" indicators in the editor UI, and
--     - feed a future ML classifier with labelled before/after pairs.
--
-- WHY UNIQUE (report_id, unit_id, created_at)
--   Multiple edits to the same unit produce multiple rows (one per PATCH).
--   The created_at tiebreaker makes the constraint effectively "one row per
--   edit event" while still preventing accidental duplicate inserts from a
--   misbehaving client retrying the same write within the same microsecond.
--
-- IDEMPOTENT
--   Safe to re-run: IF NOT EXISTS on table + index.

CREATE TABLE IF NOT EXISTS unit_parse_feedback (
  id              BIGSERIAL PRIMARY KEY,
  report_id       UUID NOT NULL REFERENCES v2_reports(id) ON DELETE CASCADE,
  unit_id         TEXT NOT NULL,
  original_text   TEXT,
  original_type   TEXT,
  edited_text     TEXT,
  edited_type     TEXT,
  edit_distance   INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_id, unit_id, created_at)
);

CREATE INDEX IF NOT EXISTS idx_unit_parse_feedback_report
  ON unit_parse_feedback(report_id, created_at DESC);

COMMENT ON TABLE unit_parse_feedback IS
  'Audit trail of user edits to parsed content units. Drives heuristic '
  'improvements and the editor "heavy edit" indicator. Rows are wholly '
  'owned by the report (CASCADE on delete).';
