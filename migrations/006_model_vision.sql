ALTER TABLE app_public_models
  ADD COLUMN IF NOT EXISTS supports_vision BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE app_private_models
  ADD COLUMN IF NOT EXISTS supports_vision BOOLEAN NOT NULL DEFAULT false;
