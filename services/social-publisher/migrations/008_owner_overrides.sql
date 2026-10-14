-- OWNER_OVERRIDE is an independent, action-specific owner authorization.
-- It never creates or impersonates an Auditor receipt. Existing rows and
-- historical publication evidence remain unchanged.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS audit_required_at timestamptz;
UPDATE posts SET audit_required_at=updated_at WHERE audit_required=true AND audit_required_at IS NULL;

CREATE TABLE IF NOT EXISTS owner_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_key text NOT NULL UNIQUE CHECK (authorization_key ~ '^[0-9a-f]{64}$'),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  item_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  instagram_account_id uuid NOT NULL REFERENCES instagram_accounts(id) ON DELETE RESTRICT,
  owner_identity text NOT NULL,
  action text NOT NULL CHECK (action IN ('publish_now','schedule')),
  scheduled_at timestamptz,
  scheduled_timezone text,
  content_snapshot jsonb NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action='publish_now' AND scheduled_at IS NULL) OR (action='schedule' AND scheduled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_owner_overrides_current
  ON owner_overrides(post_id,content_version,content_hash,instagram_account_id,action,authorized_at DESC);
