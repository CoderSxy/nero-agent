-- Additive phase-one task quality storage. No credentials, prompts, or tool bodies.

ALTER TABLE app_public_models
  ADD COLUMN IF NOT EXISTS credential_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE app_private_models
  ADD COLUMN IF NOT EXISTS credential_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE app_public_models
  DROP CONSTRAINT IF EXISTS app_public_models_credential_revision_check;
ALTER TABLE app_public_models
  ADD CONSTRAINT app_public_models_credential_revision_check
  CHECK (credential_revision >= 1);

ALTER TABLE app_private_models
  DROP CONSTRAINT IF EXISTS app_private_models_credential_revision_check;
ALTER TABLE app_private_models
  ADD CONSTRAINT app_private_models_credential_revision_check
  CHECK (credential_revision >= 1);

CREATE TABLE IF NOT EXISTS app_skill_health (
  skill_id UUID NOT NULL,
  version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'healthy', 'repairable', 'unavailable', 'checking')),
  safe_code TEXT,
  resource_count INTEGER NOT NULL DEFAULT 0 CHECK (resource_count >= 0),
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  corrupt_count INTEGER NOT NULL DEFAULT 0 CHECK (corrupt_count >= 0),
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  checking_started_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version, manifest_hash),
  FOREIGN KEY (skill_id, version)
    REFERENCES app_skill_versions (skill_id, version)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_model_capability_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_model_id UUID REFERENCES app_public_models(id) ON DELETE CASCADE,
  private_model_id UUID REFERENCES app_private_models(id) ON DELETE CASCADE,
  connection_fingerprint TEXT NOT NULL,
  probe_version TEXT NOT NULL,
  tool_calling TEXT NOT NULL CHECK (tool_calling IN ('supported', 'unsupported', 'unknown')),
  forced_tool_choice TEXT NOT NULL CHECK (forced_tool_choice IN ('supported', 'unsupported', 'unknown')),
  json_schema TEXT NOT NULL CHECK (json_schema IN ('supported', 'unsupported', 'unknown')),
  safe_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_model_capability_checks_scope_exclusive CHECK (
    (public_model_id IS NOT NULL AND private_model_id IS NULL)
    OR (public_model_id IS NULL AND private_model_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS app_model_capability_checks_public_idx
  ON app_model_capability_checks (public_model_id, checked_at DESC)
  WHERE public_model_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS app_model_capability_checks_private_idx
  ON app_model_capability_checks (private_model_id, checked_at DESC)
  WHERE private_model_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_agent_run_controls (
  run_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id),
  thread_id TEXT NOT NULL,
  contract JSONB NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('simple-chart', 'general', 'complex')),
  mode TEXT NOT NULL CHECK (mode IN ('observe', 'enforce')),
  main_calls INTEGER NOT NULL DEFAULT 0 CHECK (main_calls >= 0),
  repair_calls INTEGER NOT NULL DEFAULT 0 CHECK (repair_calls >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  active_ms BIGINT NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed', 'cancelled', 'interrupted')),
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_agent_run_controls_user_thread_idx
  ON app_agent_run_controls (user_id, thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_agent_run_operations (
  run_id TEXT NOT NULL REFERENCES app_agent_run_controls(run_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main-model', 'repair-model', 'tool')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'unconfirmed')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, operation_id)
);

CREATE OR REPLACE FUNCTION app_agent_run_controls_guard_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'cross-user run update is not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_agent_run_controls_owner_guard ON app_agent_run_controls;
CREATE TRIGGER app_agent_run_controls_owner_guard
  BEFORE UPDATE ON app_agent_run_controls
  FOR EACH ROW
  EXECUTE FUNCTION app_agent_run_controls_guard_owner();

CREATE OR REPLACE FUNCTION app_update_agent_run_status(
  p_run_id TEXT,
  p_actor_user_id UUID,
  p_status TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  updated INTEGER;
BEGIN
  UPDATE app_agent_run_controls
     SET status = p_status,
         revision = revision + 1,
         updated_at = now()
   WHERE run_id = p_run_id
     AND user_id = p_actor_user_id;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated = 0 THEN
    RAISE EXCEPTION 'cross-user run update is not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN updated;
END;
$$;
