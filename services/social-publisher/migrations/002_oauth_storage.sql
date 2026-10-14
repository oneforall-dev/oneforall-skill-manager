CREATE TABLE IF NOT EXISTS instagram_oauth_states (
  state_hash text PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instagram_oauth_states_expiry ON instagram_oauth_states(expires_at);

ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS connection_method text NOT NULL DEFAULT 'manual';
ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS last_token_refresh_at timestamptz;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage_provider text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS size_bytes bigint;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_storage_key ON assets(storage_provider, storage_key) WHERE storage_key IS NOT NULL;
