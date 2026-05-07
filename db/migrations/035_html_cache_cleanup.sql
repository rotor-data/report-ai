-- 035_html_cache_cleanup.sql
--
-- DATA cleanup for v2_report_modules.html_cache. No schema changes.
--
-- Background — two historic bugs polluted html_cache:
--
-- Bug 1: editor wrapped <section class="chapter"> in an extra <div class="chapter">
--        on every save, producing nested wrappers like
--        <div class="chapter"><div class="chapter"><section class="chapter">…
--        HtmlPreview.jsx now detects alreadyChapterRooted, but old rows are still polluted.
--
-- Bug 2: renderer replaced <img data-logo="primary"> with a placeholder
--        <img src="" style="background: var(--bg-light); border: 1px dashed …;
--        aspect-ratio: 4/1;" alt="…">. Editor saved that placeholder back, losing
--        the data-logo binding permanently. smyra-render now preserves the attribute.
--
-- Strategy:
--   1. Prefer html_content → html_cache copy when html_content is intact and
--      html_cache is polluted. mcp-v2.js writes both columns identically at INSERT
--      so html_content is the cleanest source of truth.
--   2. For rows where html_content is also polluted (or NULL), apply targeted
--      regex fixes on html_cache directly.
--
-- IDEMPOTENT: safe to run multiple times. Re-runs find 0 rows after first pass.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step A: html_content → html_cache fallback
-- When html_content has clean markup (data-logo or single chapter wrapper)
-- but html_cache is polluted, copy html_content over html_cache.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  copied_count INTEGER := 0;
BEGIN
  -- A1: html_content has data-logo, html_cache has the placeholder src="" style
  WITH updated AS (
    UPDATE v2_report_modules
    SET html_cache = html_content
    WHERE html_content IS NOT NULL
      AND length(html_content) > 0
      AND html_content ~ 'data-logo='
      AND html_cache ~ '<img[^>]*src=""[^>]*style="[^"]*aspect-ratio:\s*4/1'
    RETURNING id
  )
  SELECT count(*) INTO copied_count FROM updated;
  RAISE NOTICE 'A1 (html_content data-logo → html_cache): copied % row(s)', copied_count;

  -- A2: html_content has a single chapter wrapper, html_cache has nested wrappers
  WITH updated AS (
    UPDATE v2_report_modules
    SET html_cache = html_content
    WHERE html_content IS NOT NULL
      AND length(html_content) > 0
      AND html_content !~ '<div\s+class="chapter">\s*<(?:div|section)\s+class="chapter">'
      AND html_cache ~ '<div\s+class="chapter">\s*<(?:div|section)\s+class="chapter">'
    RETURNING id
  )
  SELECT count(*) INTO copied_count FROM updated;
  RAISE NOTICE 'A2 (html_content clean chapter → html_cache): copied % row(s)', copied_count;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step B: Bug 1 — collapse nested <div class="chapter"> wrappers in html_cache
-- Loop until no more matches (typically 1–2 iterations). Cap at 5 for safety.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  iter INTEGER := 0;
  affected INTEGER;
  total_affected INTEGER := 0;
BEGIN
  LOOP
    iter := iter + 1;
    EXIT WHEN iter > 5;

    WITH updated AS (
      UPDATE v2_report_modules
      SET html_cache = regexp_replace(
        html_cache,
        '<div\s+class="chapter">\s*(<(?:div|section)\s+class="chapter">)',
        '\1',
        'g'
      )
      WHERE html_cache ~ '<div\s+class="chapter">\s*<(?:div|section)\s+class="chapter">'
      RETURNING id
    )
    SELECT count(*) INTO affected FROM updated;

    total_affected := total_affected + affected;
    RAISE NOTICE 'B (chapter unwrap) iteration %: % row(s)', iter, affected;
    EXIT WHEN affected = 0;
  END LOOP;

  RAISE NOTICE 'B (chapter unwrap) total: % row-iteration(s)', total_affected;

  -- Symmetric tail cleanup: if we collapsed an opening wrapper but a stray
  -- closing </div> remains right after the chapter section's closing tag,
  -- HtmlPreview tolerates it. We do not blindly strip </div>s — risk of
  -- breaking sibling structure. Leave as-is.
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step C: Bug 2 — restore data-logo on rows that still carry the placeholder.
-- Only touches the WITH-aspect-ratio variant (logo). Asset-ref placeholders
-- without aspect-ratio are left alone (we can't recover the asset id).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  affected INTEGER;
BEGIN
  WITH updated AS (
    UPDATE v2_report_modules
    SET html_cache = regexp_replace(
      html_cache,
      '<img[^>]*src=""[^>]*style="[^"]*background:\s*var\(--bg-light\)[^"]*border:\s*1px dashed[^"]*aspect-ratio:\s*4/1[^"]*"[^>]*>',
      '<img data-logo="primary">',
      'g'
    )
    WHERE html_cache ~ '<img[^>]*src=""[^>]*style="[^"]*aspect-ratio:\s*4/1[^"]*"'
    RETURNING id
  )
  SELECT count(*) INTO affected FROM updated;
  RAISE NOTICE 'C (logo placeholder → data-logo="primary"): % row(s)', affected;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step D: Sanity report — count any remaining pollution after cleanup
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  nested_chapter INTEGER;
  logo_placeholder INTEGER;
  asset_ref_placeholder INTEGER;
BEGIN
  SELECT count(*) INTO nested_chapter
  FROM v2_report_modules
  WHERE html_cache ~ '<div\s+class="chapter">\s*<(?:div|section)\s+class="chapter">';

  SELECT count(*) INTO logo_placeholder
  FROM v2_report_modules
  WHERE html_cache ~ '<img[^>]*src=""[^>]*style="[^"]*aspect-ratio:\s*4/1[^"]*"';

  SELECT count(*) INTO asset_ref_placeholder
  FROM v2_report_modules
  WHERE html_cache ~ '<img[^>]*src=""[^>]*style="[^"]*background:\s*var\(--bg-light\)[^"]*border:\s*1px dashed[^"]*"[^>]*>'
    AND html_cache !~ 'aspect-ratio:\s*4/1';

  RAISE NOTICE '── Post-cleanup residue ──';
  RAISE NOTICE '  Nested chapter wrappers remaining:        %', nested_chapter;
  RAISE NOTICE '  Logo placeholder (4/1) remaining:         %', logo_placeholder;
  RAISE NOTICE '  Asset-ref placeholder (no aspect-ratio):  % (left intact — unknown asset id)', asset_ref_placeholder;
END $$;

COMMIT;
