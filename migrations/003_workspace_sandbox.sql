CREATE TABLE app_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  quota_bytes BIGINT NOT NULL DEFAULT 524288000,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_workspaces_workspace_id_check CHECK (workspace_id ~ '^ws_[0-9a-f-]+$'),
  CONSTRAINT app_workspaces_quota_check CHECK (quota_bytes > 0 AND used_bytes >= 0 AND file_count >= 0)
);
