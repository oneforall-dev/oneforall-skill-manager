CREATE TABLE IF NOT EXISTS client_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL UNIQUE,
  google_calendar_id text NOT NULL,
  calendar_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Bogota',
  source text NOT NULL DEFAULT 'google-calendar',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS google_calendar_id text,
  ADD COLUMN IF NOT EXISTS google_calendar_event_id text,
  ADD COLUMN IF NOT EXISTS calendar_sync_status text;

CREATE INDEX IF NOT EXISTS idx_content_google_calendar_event
  ON content_items (google_calendar_id, google_calendar_event_id);
