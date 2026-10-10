ALTER TABLE app_workspaces
  ADD COLUMN pending_bytes BIGINT NOT NULL DEFAULT 0 CHECK (pending_bytes >= 0),
  ADD COLUMN pending_files INTEGER NOT NULL DEFAULT 0 CHECK (pending_files >= 0);
