ALTER TABLE app_public_models
  ADD COLUMN IF NOT EXISTS catalog_metadata JSONB;
