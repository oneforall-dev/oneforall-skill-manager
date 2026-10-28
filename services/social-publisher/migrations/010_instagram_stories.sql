-- Stories are versioned content items and use the same approval,
-- authorization, idempotency and publication evidence as other formats.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_format_check;
ALTER TABLE posts ADD CONSTRAINT posts_format_check
  CHECK (format IN ('image','carousel','reel','story'));
