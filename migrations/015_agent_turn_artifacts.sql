-- Agent turn artifacts: per-run file mutation ledger (relative paths + fingerprints only).

CREATE TABLE IF NOT EXISTS app_agent_artifact_runs (
  run_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'suspended', 'completed', 'failed', 'cancelled', 'interrupted')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  collection_status TEXT NOT NULL CHECK (collection_status IN ('complete', 'partial')),
  anchor_message_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS app_agent_artifact_runs_user_thread_created_idx
  ON app_agent_artifact_runs (user_id, thread_id, created_at DESC, run_id DESC);

CREATE TABLE IF NOT EXISTS app_agent_run_artifacts (
  run_id TEXT NOT NULL REFERENCES app_agent_artifact_runs(run_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  initial_etag TEXT NULL,
  latest_etag TEXT NULL,
  size BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
  last_operation_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, path)
);

CREATE TABLE IF NOT EXISTS app_agent_artifact_operations (
  run_id TEXT NOT NULL REFERENCES app_agent_artifact_runs(run_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, operation_id)
);
