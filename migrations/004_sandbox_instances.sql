CREATE TABLE app_sandbox_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
  sandbox_id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'user',
  scope_id UUID NOT NULL,
  container_id TEXT UNIQUE,
  status TEXT NOT NULL,
  workspace_root TEXT,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_sandbox_instances_scope_check CHECK (scope = 'user'),
  CONSTRAINT app_sandbox_instances_status_check CHECK (status IN ('missing', 'created', 'running', 'stopped')),
  CONSTRAINT app_sandbox_instances_sandbox_id_check CHECK (sandbox_id ~ '^sb_[0-9a-f-]+$')
);
