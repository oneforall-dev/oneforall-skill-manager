CREATE TABLE IF NOT EXISTS chatgpt_file_assets (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_file_id text NOT NULL,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, source_file_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS chatgpt_file_assets_asset_id_idx
  ON chatgpt_file_assets(asset_id);
