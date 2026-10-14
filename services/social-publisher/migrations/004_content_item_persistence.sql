ALTER TABLE posts ADD COLUMN IF NOT EXISTS item_id text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS content_version integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_version integer;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_content_hash text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS approval_required boolean;

-- Grandfather posts created before ITEM_ID persistence. Every row created after
-- this migration requires an approved, content-addressed snapshot.
UPDATE posts SET content_version = 1 WHERE content_version IS NULL;
UPDATE posts SET approval_required = false WHERE approval_required IS NULL;

ALTER TABLE posts ALTER COLUMN content_version SET DEFAULT 1;
ALTER TABLE posts ALTER COLUMN content_version SET NOT NULL;
ALTER TABLE posts ALTER COLUMN approval_required SET DEFAULT true;
ALTER TABLE posts ALTER COLUMN approval_required SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_client_item
  ON posts(client_id, item_id)
  WHERE item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_posts_content_readiness
  ON posts(client_id, status, approved_at, created_at DESC)
  WHERE item_id IS NOT NULL;
