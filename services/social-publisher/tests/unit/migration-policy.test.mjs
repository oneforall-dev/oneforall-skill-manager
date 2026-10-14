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
  assert.match(sql,/owner_identity text NOT NULL/);
  assert.match(sql,/authorized_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(sql,/content_snapshot jsonb NOT NULL/);
  assert.match(sql,/action IN \('publish_now','schedule'\)/);
  assert.doesNotMatch(sql,/UPDATE posts SET audit_required=true/);
});

