CREATE TABLE app_attachment_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  size BIGINT NOT NULL,
  mime_type TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_attachment_refs_source_check CHECK (source IN ('personal', 'agent')),
  CONSTRAINT app_attachment_refs_size_check CHECK (size >= 0),
  CONSTRAINT app_attachment_refs_unique UNIQUE (owner_id, thread_id, client_message_id, source, path)
);

CREATE INDEX app_attachment_refs_thread_idx
  ON app_attachment_refs (owner_id, thread_id, client_message_id);

CREATE INDEX app_attachment_refs_created_idx
  ON app_attachment_refs (created_at);
