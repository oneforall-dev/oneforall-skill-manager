CREATE TABLE IF NOT EXISTS legacy_chat_assets (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  slide_position integer NOT NULL CHECK (slide_position >= 1 AND slide_position <= 10),
  source_file_id text NOT NULL,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(client_id, item_id, slide_position)
);

CREATE INDEX IF NOT EXISTS idx_legacy_chat_assets_asset
ON legacy_chat_assets(asset_id);
