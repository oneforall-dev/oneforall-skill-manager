import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("audit migration grandfathers existing rows before enabling the default",async()=>{
  const sql=await readFile(new URL("../../migrations/007_audit_receipts_and_publish_operations.sql",import.meta.url),"utf8");
  const grandfather=sql.indexOf("UPDATE posts SET audit_required=false WHERE audit_required IS NULL");
  const defaultTrue=sql.indexOf("ALTER TABLE posts ALTER COLUMN audit_required SET DEFAULT true");
  assert.ok(grandfather>=0);
  assert.ok(defaultTrue>grandfather);
  assert.match(sql,/publish_operations[\s\S]+idempotency_key text NOT NULL UNIQUE/);
  assert.match(sql,/status IN \('claimed','platform_pending','succeeded','failed','unknown'\)/);
});

test("owner override migration preserves history and binds an immutable action scope",async()=>{
  const sql=await readFile(new URL("../../migrations/008_owner_overrides.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE TABLE IF NOT EXISTS owner_overrides/);
  assert.match(sql,/authorization_key text NOT NULL UNIQUE/);
  assert.match(sql,/content_version integer NOT NULL/);
  assert.match(sql,/content_hash text NOT NULL/);
  assert.match(sql,/instagram_account_id uuid NOT NULL/);
  assert.match(sql,/content_snapshot jsonb NOT NULL/);
  assert.match(sql,/action IN \('publish_now','schedule'\)/);
  assert.doesNotMatch(sql,/UPDATE posts SET audit_required=true/);
});

test("Trial Reel migration is additive and constrains strategy to Reel content",async()=>{
  const sql=await readFile(new URL("../../migrations/009_trial_reels.sql",import.meta.url),"utf8");
  assert.match(sql,/ADD COLUMN IF NOT EXISTS trial_reel boolean NOT NULL DEFAULT false/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS trial_graduation_strategy text/);
  assert.match(sql,/trial_reel=true AND format='reel'/);
  assert.match(sql,/trial_graduation_strategy IN \('MANUAL','SS_PERFORMANCE'\)/);
  assert.doesNotMatch(sql,/UPDATE posts SET/);
});

test("Story migration expands only the post format constraint",async()=>{
  const sql=await readFile(new URL("../../migrations/010_instagram_stories.sql",import.meta.url),"utf8");
  assert.match(sql,/DROP CONSTRAINT IF EXISTS posts_format_check/);
  assert.match(sql,/format IN \('image','carousel','reel','story'\)/);
  assert.doesNotMatch(sql,/UPDATE posts SET/);
  assert.doesNotMatch(sql,/DROP TABLE|DELETE FROM|TRUNCATE/i);
});

