-- Agent Skills import/sync sessions and shortcut storage (spec §5).
-- Shortcut behavior is Task 13; this migration only creates the table.

CREATE TABLE IF NOT EXISTS app_skill_shortcuts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES app_skills(id),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  sort INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompts JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_skill_shortcuts_skill_uidx
  ON app_skill_shortcuts (skill_id);

CREATE INDEX IF NOT EXISTS app_skill_shortcuts_skill_sort_idx
  ON app_skill_shortcuts (skill_id, sort, id);

CREATE TABLE IF NOT EXISTS app_skill_sync_sessions (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'sync')),
  skill_id UUID REFERENCES app_skills(id),
  base_revision BIGINT,
  version INTEGER,
  actor_user_id UUID NOT NULL REFERENCES app_users(id),
  payload JSONB NOT NULL,
  temp_root TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'aborted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'sync' OR skill_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS app_skill_sync_sessions_expires_idx
  ON app_skill_sync_sessions (expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS app_skill_sync_sessions_actor_idx
  ON app_skill_sync_sessions (actor_user_id, status);
