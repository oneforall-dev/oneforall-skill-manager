-- Trial Reel settings are publishable content and therefore participate in
-- content hashing, approval, Auditor receipts and OWNER_OVERRIDE scope.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS trial_reel boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS trial_graduation_strategy text;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_trial_reel_settings_check;
ALTER TABLE posts ADD CONSTRAINT posts_trial_reel_settings_check CHECK (
  (trial_reel=false AND trial_graduation_strategy IS NULL)
  OR
  (trial_reel=true AND format='reel' AND trial_graduation_strategy IN ('MANUAL','SS_PERFORMANCE'))
);
