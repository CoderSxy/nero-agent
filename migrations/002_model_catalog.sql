CREATE TABLE app_public_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_mode TEXT NOT NULL DEFAULT 'chat',
  api_key_ciphertext TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_public_models_display_name_check
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  CONSTRAINT app_public_models_provider_id_check
    CHECK (provider_id ~ '^[a-zA-Z0-9._-]+$'),
  CONSTRAINT app_public_models_model_id_check
    CHECK (length(model_id) BETWEEN 1 AND 200 AND model_id ~ '^[a-zA-Z0-9._:/-]+$'),
  CONSTRAINT app_public_models_api_mode_check
    CHECK (api_mode IN ('chat', 'responses'))
);

CREATE TABLE app_private_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_mode TEXT NOT NULL DEFAULT 'chat',
  api_key_ciphertext TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_private_models_display_name_check
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  CONSTRAINT app_private_models_provider_id_check
    CHECK (provider_id ~ '^[a-zA-Z0-9._-]+$'),
  CONSTRAINT app_private_models_model_id_check
    CHECK (length(model_id) BETWEEN 1 AND 200 AND model_id ~ '^[a-zA-Z0-9._:/-]+$'),
  CONSTRAINT app_private_models_api_mode_check
    CHECK (api_mode IN ('chat', 'responses'))
);

CREATE INDEX app_public_models_enabled_idx ON app_public_models(enabled);
CREATE UNIQUE INDEX app_public_models_default_unique_idx
  ON app_public_models ((true)) WHERE is_default;
CREATE INDEX app_private_models_user_id_enabled_idx
  ON app_private_models(user_id, enabled);
