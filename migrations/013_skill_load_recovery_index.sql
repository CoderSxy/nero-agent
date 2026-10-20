-- Recovery distinguishes successfully loaded instructions from discovery-only pins.
CREATE INDEX app_skill_events_load_recovery_idx
  ON app_skill_events (server_execution_id, actor_user_id, skill_id, version)
  WHERE event = 'load' AND result = 'ok';
