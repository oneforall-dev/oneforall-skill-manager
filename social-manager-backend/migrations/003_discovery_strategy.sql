CREATE TABLE IF NOT EXISTS discovery_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','selected','published','evaluated','retired')),
  language text NOT NULL DEFAULT 'en',
  layers jsonb NOT NULL,
  terms jsonb NOT NULL,
  rationale text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  hypothesis text,
  researched_at timestamptz NOT NULL,
  selected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, version)
);

CREATE INDEX IF NOT EXISTS idx_discovery_sets_content
  ON discovery_sets (content_id, status, version DESC);

CREATE TABLE IF NOT EXISTS discovery_metrics (
  id bigserial PRIMARY KEY,
  discovery_set_id uuid NOT NULL REFERENCES discovery_sets(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_record_id text NOT NULL,
  measured_at timestamptz NOT NULL,
  window_hours integer NOT NULL CHECK (window_hours > 0),
  metrics jsonb NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discovery_set_id, source, source_record_id, window_hours, measured_at)
);

CREATE INDEX IF NOT EXISTS idx_discovery_metrics_set
  ON discovery_metrics (discovery_set_id, measured_at DESC);
