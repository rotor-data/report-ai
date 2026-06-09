-- 040_extract_jobs.sql
--
-- Async job queue for long-running design-extraction tools (Fas 3-async).
--
-- WHY
--   Two MCP tools do slow upstream work that regularly exceeds the ~10s
--   client (Claude.ai) timeout while the hub→report-ai call is in flight:
--
--     report2__rasterize_upload      ~8s  (PDF → per-page PNG + pre-analysis)
--     report2__extract_design_from_pdf ~10-30s (/render/analyze-pdf)
--
--   Mirroring the existing render_jobs async pattern (hub's render_jobs +
--   background worker + poll), these tools now ENQUEUE a row here, fire a
--   Netlify Background Function (extract-job-background.js, 15-min budget)
--   that does the slow work and writes the result back, and return
--   { job_id, status:'queued' } immediately — well under the client cap.
--   Callers poll report2__get_job_status (or re-call the same tool with a
--   job_id) until status is 'done' | 'failed'.
--
--   Unlike render_jobs (which lives in the HUB Neon DB and is dispatched by
--   the hub's render-worker), extract_jobs lives in report-ai's own DB and
--   is driven entirely by report-ai's own background-function pattern
--   (x-internal-trigger-secret), so no hub changes are required.
--
-- job_type DISCRIMINATOR
--   'rasterize_upload' | 'extract_design' — the background worker branches
--   on this to run the right slow op. New op types reuse the same table.
--
-- input / result ARE JSONB
--   input  = the sanitised tool args needed to run the job (upload_token,
--            brand_id, dpi, etc.). The slow work reads ONLY from here.
--   result = the full tool result the consumer expects ({pages,...} for
--            rasterize; the meta-program for extract_design). The poll tool
--            returns result verbatim on status='done'.
--
-- IDEMPOTENT
--   Safe to re-run: IF NOT EXISTS on table + indexes.

CREATE TABLE IF NOT EXISTS extract_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type      TEXT NOT NULL CHECK (job_type IN ('rasterize_upload', 'extract_design')),
  status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')) DEFAULT 'queued',
  user_id       TEXT,
  tenant_id     UUID,
  input         JSONB NOT NULL DEFAULT '{}'::jsonb,
  result        JSONB,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER
);

-- Poll lookup (status reads by id are the PK; this helps stuck-job sweeps).
CREATE INDEX IF NOT EXISTS idx_extract_jobs_status_created
  ON extract_jobs(status, created_at DESC);

COMMENT ON TABLE extract_jobs IS
  'Async job queue for slow design-extraction MCP tools (rasterize_upload, extract_design_from_pdf). Mirrors render_jobs but lives in report-ai DB and is driven by report-ai background functions.';
