-- 045_onboarding_status_constraint.sql
--
-- FIX a stale CHECK constraint that silently broke onboarding-session dedup.
--
-- brand.onboarding_sessions.status had a CHECK allowing only
--   collecting | crawled | reviewing | ready_for_review | confirmed | abandoned
-- but the application archives superseded/duplicate sessions with status='archived'
-- (and 'superseded') — see src/handlers/brand/onboard.js INACTIVE_SESSION_STATUSES
-- = ['archived','superseded','abandoned'] and archivePriorActiveSessions(). So every
-- archive UPDATE violated the constraint and FAILED, leaving multiple "active"
-- sessions per brand → the "exactly one canonical session" invariant never held and
-- "continue onboarding" picked a stale/ambiguous session (Rotor had 8 active).
--
-- Add the two missing terminal statuses the code already uses. Idempotent.

ALTER TABLE brand.onboarding_sessions
  DROP CONSTRAINT IF EXISTS onboarding_sessions_status_check;

ALTER TABLE brand.onboarding_sessions
  ADD CONSTRAINT onboarding_sessions_status_check
  CHECK (status = ANY (ARRAY[
    'collecting', 'crawled', 'reviewing', 'ready_for_review',
    'confirmed', 'abandoned', 'archived', 'superseded'
  ]));
