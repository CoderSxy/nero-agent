CREATE TABLE agent_scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_users(id),
  mastra_schedule_id TEXT UNIQUE,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'cron' CHECK (task_type IN ('cron')),
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  prompt TEXT NOT NULL,
  chat_model_ref TEXT NOT NULL,
  memory_model_ref TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX agent_scheduled_tasks_owner_updated_idx
  ON agent_scheduled_tasks (owner_user_id, updated_at DESC)
  WHERE status <> 'deleted';

CREATE INDEX agent_scheduled_tasks_owner_name_idx
  ON agent_scheduled_tasks (owner_user_id, name)
  WHERE status <> 'deleted';

CREATE TABLE agent_scheduled_task_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES agent_scheduled_tasks(id),
  owner_user_id UUID NOT NULL REFERENCES app_users(id),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('cron', 'manual')),
  occurrence_key TEXT NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing', 'running', 'succeeded', 'failed', 'aborted', 'skipped')),
  run_id TEXT,
  error_summary TEXT,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, trigger_kind, occurrence_key)
);

CREATE INDEX agent_scheduled_task_runs_task_fired_idx
  ON agent_scheduled_task_runs (task_id, fired_at DESC);

CREATE INDEX agent_scheduled_task_runs_owner_fired_idx
  ON agent_scheduled_task_runs (owner_user_id, fired_at DESC);

CREATE UNIQUE INDEX agent_scheduled_task_runs_manual_inflight_idx
  ON agent_scheduled_task_runs (task_id)
  WHERE trigger_kind = 'manual' AND status IN ('preparing', 'running');
