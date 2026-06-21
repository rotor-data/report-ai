-- 044_rls_ENFORCEMENT.sql
--
-- RLS · (d) ENFORCEMENT for report.* — the RISKY migration.
--
-- ███████████████████████████████████████████████████████████████████████
-- ██  DO-NOT-APPLY-UNTIL-RUNBOOK-STEP-7 (report.* per-table FORCE wave)  ██
-- ███████████████████████████████████████████████████████████████████████
--
-- Applying FORCE before the GUC-carrier is wired + verified on report.*
-- read/write paths = every report query returns ZERO rows = outage of the
-- report module. Split out deliberately; applied LAST, ONE TABLE AT A TIME,
-- with the kill-switch ready. See docs/rls-rollout-RUNBOOK.md (lives in
-- smyra-studio) for the exact per-table order + verification gate.
--
-- The app role + service role + grants are created ONCE in smyra-studio
-- migrations/rls/200_ENFORCEMENT_role_and_force.sql (STEP 6). report.* only
-- needs (a) its grants extended to the report schema and (b) per-table FORCE.
--
-- Prereqs: 042 + 043 applied; smyra-studio 100/110/120/200 STEP-6 applied;
-- GUC verified non-null on ~100% of authed report requests.

-- ── RUNBOOK STEP 6d — extend grants to the report schema ───────────────
-- (app_runtime / app_service are created in smyra-studio 200_*.)
GRANT USAGE ON SCHEMA report TO app_runtime, app_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA report TO app_runtime, app_service;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA report TO app_runtime, app_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA report
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime, app_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA report
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime, app_service;

-- ══════════════════════════════════════════════════════════════════════
-- RUNBOOK STEP 7 — FORCE ROW LEVEL SECURITY, ONE TABLE AT A TIME
-- ══════════════════════════════════════════════════════════════════════
-- ⚠ DO NOT run this block at once. APPLY ONLY THE LINE for the table you are
--   currently enforcing, in the runbook order (leaf/worker-scoped → crown).
--   Revert any line instantly with the matching NO FORCE in the kill-switch.
--
-- ── Wave 1 (worker-scoped, low read volume) ──
-- ALTER TABLE extract_jobs        FORCE ROW LEVEL SECURITY;
-- ALTER TABLE design_extractions  FORCE ROW LEVEL SECURITY;
--
-- ── Wave 2 (report children) ──
-- ALTER TABLE v2_report_modules   FORCE ROW LEVEL SECURITY;
-- ALTER TABLE v2_report_pages     FORCE ROW LEVEL SECURITY;
-- ALTER TABLE v2_content_units    FORCE ROW LEVEL SECURITY;
--
-- ── Wave 3 (brand-scoped report assets) ──
-- ALTER TABLE brand_fonts         FORCE ROW LEVEL SECURITY;
-- ALTER TABLE brand_logos         FORCE ROW LEVEL SECURITY;
-- ALTER TABLE brand_components    FORCE ROW LEVEL SECURITY;
-- ALTER TABLE report_blueprints   FORCE ROW LEVEL SECURITY;
-- ALTER TABLE report_templates    FORCE ROW LEVEL SECURITY;
--
-- ── Wave 4 (the crown jewel — P0.1 target) ──
-- ALTER TABLE v2_reports          FORCE ROW LEVEL SECURITY;
