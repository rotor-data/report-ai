-- 030_v2_content_units.sql
--
-- Canonical content model for alpha-v3 reports.
--
-- WHAT THIS IS
--   `v2_content_units` stores the structured, semantic units that make up an
--   alpha-v3 report's content (Layer A.1 of the resilient-dazzling-koala plan).
--   A "unit" is the smallest reusable piece of report content — a paragraph,
--   a heading, a KPI, a list, a table row, a callout, etc. Pages/modules
--   compose units into layouts; units themselves are layout-agnostic.
--
--   This replaces the old pattern of stuffing freeform HTML into
--   `v2_report_modules.html_cache` for new (alpha-v3) reports. Legacy reports
--   continue to use the inline-HTML model — see the COMMENT on `v2_reports`
--   added at the bottom of this migration.
--
-- WHY CASCADE DELETE ON report_id
--   Units are wholly owned by their report. There is no cross-report sharing
--   of unit rows (component reuse happens at the design-system / blueprint
--   level, not at the unit level). When a report is deleted, its units are
--   garbage by definition, so ON DELETE CASCADE keeps cleanup atomic and
--   avoids orphan rows.
--
-- WHY UNIQUE (report_id, unit_id)
--   `unit_id` is a stable, human-readable identifier assigned by the workflow
--   (e.g. "intro-lead", "kpi-revenue-2025", "page-3-callout"). It is stable
--   per-report (so revisions and patches can target the same unit by id),
--   but it is NOT globally unique — two different reports may both have a
--   unit called "intro-lead". The composite UNIQUE captures that exactly.
--
-- IDEMPOTENT
--   Safe to re-run: uses IF NOT EXISTS on table, index, and the v2_reports
--   table comment (the comment overwrite is naturally idempotent).

CREATE TABLE IF NOT EXISTS v2_content_units (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    UUID NOT NULL REFERENCES v2_reports(id) ON DELETE CASCADE,
  unit_id      TEXT NOT NULL,
  type         TEXT NOT NULL,
  level        INTEGER,
  text         TEXT,
  metadata     JSONB DEFAULT '{}'::jsonb,
  order_index  INTEGER NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (report_id, unit_id)
);

CREATE INDEX IF NOT EXISTS idx_v2_content_units_report
  ON v2_content_units(report_id, order_index);

COMMENT ON COLUMN v2_content_units.type IS
  'Semantic unit type. Allowed values (alpha-v3 catalogue): '
  'paragraph, lead, kicker, attribution, heading, eyebrow, blockquote, '
  'pull_quote, callout, info_box, warning_box, success_box, highlight, '
  'caption, footnote, sidenote, citation, bullet_list, numbered_list, '
  'check_list, definition_list, kpi, kpi_group, stat_hero, table, '
  'comparison, timeline_event, step, testimonial, glossary_item, divider, '
  'spacer, page_break, bibliography_entry, toc_entry.';

COMMENT ON TABLE v2_reports IS
  'Reports for the v2/alpha pipeline. Alpha-v3 reports use v2_content_units '
  'as their canonical content store. Legacy reports keep inline HTML in '
  'v2_report_modules.html_cache.';
