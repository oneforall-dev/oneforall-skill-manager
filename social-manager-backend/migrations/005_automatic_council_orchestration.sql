CREATE TABLE IF NOT EXISTS automatic_orchestration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug text NOT NULL,
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  content_version integer NOT NULL CHECK(content_version > 0),
  council_id uuid REFERENCES creative_councils(id) ON DELETE SET NULL,
  phase text NOT NULL DEFAULT 'CONCEPT_COUNCIL' CHECK(phase IN (
    'CONCEPT_COUNCIL','CONCEPT_REVISION','PRODUCTION','FINAL_REVIEW','FINAL_CORRECTION','OWNER_DECISION','COMPLETE'
  )),
  status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN (
    'RUNNING','WAITING_ACTOR','CORRECTIONS','BLOCKED','USER_APPROVAL_REQUIRED','COMPLETE'
  )),
  correction_round integer NOT NULL DEFAULT 0 CHECK(correction_round >= 0),
  max_correction_rounds integer NOT NULL DEFAULT 3 CHECK(max_correction_rounds > 0),
  content_hash text,
  destination_id text,
  final_package jsonb,
  exact_blocker jsonb,
  owner_override_allowed boolean NOT NULL DEFAULT true,
  last_transition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_slug,item_id,content_version)
);

CREATE TABLE IF NOT EXISTS automatic_actor_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES automatic_orchestration_runs(id) ON DELETE CASCADE,
  phase text NOT NULL,
  actor text NOT NULL CHECK(actor IN ('agency','director','auditor','social-manager','owner')),
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CLAIMED','COMPLETED','BLOCKED','CANCELLED')),
  attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0),
  package_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,phase,actor,action_type,attempt)
);

CREATE INDEX IF NOT EXISTS idx_automatic_actions_pending
  ON automatic_actor_actions(status,actor,created_at);

