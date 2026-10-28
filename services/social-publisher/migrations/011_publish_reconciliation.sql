ALTER TABLE publish_operations ADD COLUMN IF NOT EXISTS container_id text;
ALTER TABLE publish_operations ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE publish_operations ADD COLUMN IF NOT EXISTS reconciliation_note text;

ALTER TABLE publish_operations DROP CONSTRAINT IF EXISTS publish_operations_status_check;
ALTER TABLE publish_operations ADD CONSTRAINT publish_operations_status_check
  CHECK (status IN ('claimed','platform_pending','succeeded','failed','unknown','retry_authorized'));
