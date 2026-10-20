-- Agent Skills run pins + scheduled-task selected skill intents (spec §5 / §7).

CREATE TABLE app_skill_run_pins (
  server_execution_id TEXT NOT NULL,
  skill_id UUID NOT NULL REFERENCES app_skills(id),
  user_id UUID NOT NULL REFERENCES app_users(id),
  thread_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  manifest_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_execution_id, skill_id)
);

CREATE INDEX app_skill_run_pins_user_thread_idx
  ON app_skill_run_pins (user_id, thread_id);

CREATE INDEX app_skill_run_pins_skill_version_idx
  ON app_skill_run_pins (skill_id, version, expires_at);

CREATE INDEX app_skill_run_pins_expires_idx
  ON app_skill_run_pins (expires_at);

ALTER TABLE agent_scheduled_tasks
  ADD COLUMN IF NOT EXISTS selected_skill_ids UUID[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_scheduled_tasks_selected_skill_ids_card'
  ) THEN
    ALTER TABLE agent_scheduled_tasks
      ADD CONSTRAINT agent_scheduled_tasks_selected_skill_ids_card
      CHECK (cardinality(selected_skill_ids) <= 5);
  END IF;
END $$;
