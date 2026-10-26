ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS scheduled_recorded_at timestamptz;

CREATE TABLE IF NOT EXISTS content_supply_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  campaign text NOT NULL DEFAULT 'default',
  platform text NOT NULL DEFAULT 'instagram',
  automation_enabled boolean NOT NULL DEFAULT false,
  manual_enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'America/Bogota',
  daily_trigger_time time NOT NULL DEFAULT '09:00',
  lead_days integer NOT NULL DEFAULT 3 CHECK(lead_days >= 0),
  minimum_ready_items integer NOT NULL DEFAULT 6 CHECK(minimum_ready_items >= 0),
  target_ready_items integer NOT NULL DEFAULT 10 CHECK(target_ready_items >= minimum_ready_items),
  minimum_scheduled_items integer NOT NULL DEFAULT 3 CHECK(minimum_scheduled_items >= 0),
  publication_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  production_instructions jsonb NOT NULL DEFAULT '{}'::jsonb,
  research_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_approval_required boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_slug,campaign,platform)
);

CREATE TABLE IF NOT EXISTS content_supply_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES content_supply_policies(id) ON DELETE CASCADE,
  client_slug text NOT NULL,
  campaign text NOT NULL,
  platform text NOT NULL,
  trigger_source text NOT NULL CHECK(trigger_source IN ('daily','manual')),
  idempotency_key text,
  local_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','NO_ACTION','ORDERS_PENDING','COMPLETE','BLOCKED')),
  inventory_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  shown_at timestamptz,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_daily_once
  ON content_supply_runs(policy_id,local_date)
  WHERE trigger_source='daily';

CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_manual_idempotency
  ON content_supply_runs(policy_id,idempotency_key)
  WHERE trigger_source='manual' AND idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_supply_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES content_supply_runs(id) ON DELETE CASCADE,
  actor text NOT NULL CHECK(actor IN ('autopilot','director','social-manager')),
  action_type text NOT NULL,
  sequence integer NOT NULL CHECK(sequence > 0),
  depends_on uuid REFERENCES content_supply_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CLAIMED','COMPLETED','BLOCKED','CANCELLED')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,sequence)
);

CREATE INDEX IF NOT EXISTS idx_supply_orders_pending
  ON content_supply_orders(actor,status,created_at);

