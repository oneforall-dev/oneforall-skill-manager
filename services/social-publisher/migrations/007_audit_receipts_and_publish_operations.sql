-- Existing rows are grandfathered without changing their status, schedule,
-- approval, or publication evidence. Newly created or materially changed
-- content requires an authenticated Auditor receipt.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS audit_required boolean;
UPDATE posts SET audit_required=false WHERE audit_required IS NULL;
ALTER TABLE posts ALTER COLUMN audit_required SET DEFAULT true;
ALTER TABLE posts ALTER COLUMN audit_required SET NOT NULL;

CREATE TABLE IF NOT EXISTS audit_receipts (
  audit_id text PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  content_version integer NOT NULL CHECK (content_version > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  issuer text NOT NULL,
  auditor_identity text NOT NULL,
  verdict text NOT NULL CHECK (verdict = 'PASS'),
  audited_at timestamptz NOT NULL,
  signature_digest text NOT NULL CHECK (signature_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(post_id, content_version, content_hash, issuer)
);

CREATE INDEX IF NOT EXISTS idx_audit_receipts_current
  ON audit_receipts(post_id, content_version, content_hash, audited_at DESC);

CREATE TABLE IF NOT EXISTS publish_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  content_version integer NOT NULL CHECK (content_version > 0),
  instagram_account_id uuid NOT NULL REFERENCES instagram_accounts(id) ON DELETE RESTRICT,
  operation text NOT NULL DEFAULT 'instagram_publish',
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('claimed','platform_pending','succeeded','failed','unknown')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  external_media_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publish_operations_post
  ON publish_operations(post_id, created_at DESC);

