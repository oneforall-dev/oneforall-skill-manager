CREATE TABLE IF NOT EXISTS client_profiles (
  client_slug text PRIMARY KEY,
  client_name text NOT NULL,
  summary text,
  business jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  offers jsonb NOT NULL DEFAULT '[]'::jsonb,
  goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  brand jsonb NOT NULL DEFAULT '{}'::jsonb,
  visual_style jsonb NOT NULL DEFAULT '{}'::jsonb,
  copy_style jsonb NOT NULL DEFAULT '{}'::jsonb,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  profile_hash text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS item_id text,
  ADD COLUMN IF NOT EXISTS root_item_id text,
  ADD COLUMN IF NOT EXISTS parent_item_id text,
  ADD COLUMN IF NOT EXISTS variant_key text,
  ADD COLUMN IF NOT EXISTS source_content_version integer,
  ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS client_profile_revision integer,
  ADD COLUMN IF NOT EXISTS council_id uuid,
  ADD COLUMN IF NOT EXISTS stage_owner text,
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS publisher_kind text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_client_item_id
  ON content_items (client_slug, item_id)
  WHERE item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_client_root_item
  ON content_items (client_slug, root_item_id, variant_key);

CREATE TABLE IF NOT EXISTS research_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  content_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
  item_id text,
  mode text NOT NULL CHECK (mode IN ('news','watch','research')),
  source_tool text NOT NULL,
  query text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  deduplication jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('VERIFIED','PARTIAL','NOT_VERIFIED')),
  researched_at timestamptz NOT NULL,
  receipt_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_research_client_item
  ON research_receipts (client_slug, item_id, researched_at DESC);

CREATE TABLE IF NOT EXISTS creative_councils (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  content_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
  item_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version > 0),
  client_profile_revision integer NOT NULL CHECK (client_profile_revision > 0),
  research_receipt_id uuid REFERENCES research_receipts(id) ON DELETE SET NULL,
  concept_package jsonb NOT NULL,
  agency_verdict text,
  agency_receipt jsonb,
  director_verdict text,
  director_receipt jsonb,
  auditor_verdict text,
  auditor_receipt jsonb,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CORRECTIONS','CONCEPT_LOCKED','BLOCKED')),
  package_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_slug, item_id, content_version)
);

CREATE INDEX IF NOT EXISTS idx_council_status
  ON creative_councils (client_slug, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS audit_results (
  audit_id text PRIMARY KEY,
  client_slug text NOT NULL,
  client_id uuid,
  item_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version > 0),
  content_hash text NOT NULL,
  platform text NOT NULL,
  audit_stage text NOT NULL,
  auditor_identity text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('PASS','CORRECTIONS','BLOCKED')),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  council_id uuid REFERENCES creative_councils(id) ON DELETE SET NULL,
  client_profile_revision integer,
  receipt jsonb,
  signature_digest text,
  audited_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_results_item
  ON audit_results (client_slug, item_id, content_version, audited_at DESC);

CREATE TABLE IF NOT EXISTS release_factor_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  item_id text NOT NULL,
  content_version integer NOT NULL CHECK (content_version > 0),
  content_hash text NOT NULL,
  destination_id text NOT NULL,
  factor text NOT NULL CHECK (factor IN ('agency','director','auditor')),
  verdict text NOT NULL CHECK (verdict IN ('PASS','CORRECTIONS','BLOCKED')),
  client_profile_revision integer,
  evidence jsonb NOT NULL,
  actor_receipt jsonb NOT NULL,
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_slug,item_id,content_version,content_hash,destination_id,factor)
);


