-- Agent Skills base schema (spec §5). Excludes run_pins / shortcuts / sync_sessions (011/012).

CREATE TABLE app_skill_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_skill_audiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL UNIQUE,
  owner_user_id UUID NOT NULL REFERENCES app_users(id),
  group_id UUID REFERENCES app_skill_groups(id),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'global', 'restricted')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  published_version INTEGER,
  /** Monotonic high-water mark; allocateNextVersion increments; deleted versions are not reused. */
  version_seq INTEGER NOT NULL DEFAULT 0 CHECK (version_seq >= 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    published_version IS NULL OR published_version >= 1
  )
);

CREATE INDEX app_skills_owner_updated_idx
  ON app_skills (owner_user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX app_skills_group_name_idx
  ON app_skills (group_id, canonical_name)
  WHERE deleted_at IS NULL;

CREATE INDEX app_skills_available_idx
  ON app_skills (canonical_name)
  WHERE deleted_at IS NULL AND enabled AND published_version IS NOT NULL;

CREATE TABLE app_skill_aliases (
  alias TEXT NOT NULL PRIMARY KEY,
  skill_id UUID NOT NULL REFERENCES app_skills(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_skill_aliases_skill_idx ON app_skill_aliases (skill_id);

CREATE TABLE app_skill_versions (
  skill_id UUID NOT NULL REFERENCES app_skills(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('draft', 'published')),
  description TEXT NOT NULL,
  skill_md TEXT NOT NULL,
  manifest_hash TEXT,
  runtime_manifest JSONB,
  created_by UUID NOT NULL REFERENCES app_users(id),
  published_by UUID REFERENCES app_users(id),
  published_at TIMESTAMPTZ,
  published_remark TEXT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version),
  CHECK (
    (state = 'draft' AND published_by IS NULL AND published_at IS NULL)
    OR (state = 'published' AND published_by IS NOT NULL AND published_at IS NOT NULL)
  ),
  CHECK (published_remark IS NULL OR char_length(published_remark) <= 500)
);

CREATE UNIQUE INDEX app_skill_versions_one_draft_idx
  ON app_skill_versions (skill_id)
  WHERE state = 'draft';

CREATE INDEX app_skill_versions_state_idx
  ON app_skill_versions (skill_id, state);

ALTER TABLE app_skills
  ADD CONSTRAINT app_skills_published_version_fk
  FOREIGN KEY (id, published_version)
  REFERENCES app_skill_versions (skill_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app_skill_files (
  skill_id UUID NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  size BIGINT NOT NULL CHECK (size >= 0),
  mime_type TEXT,
  is_text BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version, path),
  FOREIGN KEY (skill_id, version)
    REFERENCES app_skill_versions (skill_id, version)
    ON DELETE CASCADE,
  CHECK (char_length(path) >= 1 AND char_length(path) <= 512),
  CHECK (path NOT LIKE '/%' AND path NOT LIKE '%\\%' AND path NOT LIKE '%\0%')
);

CREATE INDEX app_skill_files_blob_idx ON app_skill_files (blob_hash);

CREATE TABLE app_skill_grants (
  skill_id UUID NOT NULL REFERENCES app_skills(id),
  user_id UUID NOT NULL REFERENCES app_users(id),
  permission TEXT NOT NULL CHECK (permission IN ('use', 'edit', 'publish')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id, permission)
);

CREATE INDEX app_skill_grants_user_idx
  ON app_skill_grants (user_id, permission);

CREATE TABLE app_skill_audience_members (
  audience_id UUID NOT NULL REFERENCES app_skill_audiences(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (audience_id, user_id)
);

CREATE INDEX app_skill_audience_members_user_idx
  ON app_skill_audience_members (user_id);

CREATE TABLE app_skill_audience_grants (
  skill_id UUID NOT NULL REFERENCES app_skills(id),
  audience_id UUID NOT NULL REFERENCES app_skill_audiences(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, audience_id)
);

CREATE INDEX app_skill_audience_grants_audience_idx
  ON app_skill_audience_grants (audience_id);

CREATE TABLE app_skill_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES app_skills(id),
  version INTEGER,
  actor_user_id UUID NOT NULL REFERENCES app_users(id),
  event TEXT NOT NULL,
  server_execution_id TEXT,
  result TEXT,
  error_code TEXT,
  safe_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_skill_events_skill_created_idx
  ON app_skill_events (skill_id, created_at DESC);

CREATE INDEX app_skill_events_actor_created_idx
  ON app_skill_events (actor_user_id, created_at DESC);
