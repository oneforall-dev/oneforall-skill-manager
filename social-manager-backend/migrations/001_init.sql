CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS social_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  campaign text NOT NULL DEFAULT 'default',
  platform text NOT NULL DEFAULT 'instagram',
  posts_per_week integer NOT NULL CHECK (posts_per_week > 0),
  buffer_min integer NOT NULL CHECK (buffer_min >= 0),
  buffer_target integer NOT NULL CHECK (buffer_target >= buffer_min),
  format_mix jsonb NOT NULL DEFAULT '{}'::jsonb,
  pillar_mix jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferred_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_slug, campaign, platform)
);

CREATE TABLE IF NOT EXISTS content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  campaign text NOT NULL DEFAULT 'default',
  platform text NOT NULL DEFAULT 'instagram',
  format text NOT NULL CHECK (format IN ('image','carousel','reel','story','other')),
  pillar text,
  title text NOT NULL,
  idea text,
  hook text,
  objective text,
  cta text,
  status text NOT NULL DEFAULT 'idea' CHECK (status IN (
    'idea','generated','in_production','produced','audit','needs_revision',
    'approved','scheduled','published','blocked','failed'
  )),
  priority integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  scheduled_at timestamptz,
  published_at timestamptz,
  publisher_post_id text,
  published_url text,
  asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  caption text,
  source_idea_id text,
  director_project_id text,
  approval_receipt jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_client_status
  ON content_items (client_slug, campaign, platform, status);
CREATE INDEX IF NOT EXISTS idx_content_schedule
  ON content_items (client_slug, scheduled_at);

CREATE TABLE IF NOT EXISTS content_events (
  id bigserial PRIMARY KEY,
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_events_item
  ON content_events (content_id, created_at DESC);
