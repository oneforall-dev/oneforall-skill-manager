import test from "node:test";
import assert from "node:assert/strict";
import { auditExecutionState, ownerOverrideKey, ownerOverrideMatches } from "../../dist/authorization.js";

const base={postId:"00000000-0000-4000-8000-000000000001",clientId:"00000000-0000-4000-8000-000000000002",itemId:"ITEM-001",contentVersion:2,contentHash:"a".repeat(64),accountId:"00000000-0000-4000-8000-000000000003",action:"publish_now"};

test("OWNER_OVERRIDE is bound to exact item version hash account and action",()=>{
  const row={post_id:base.postId,client_id:base.clientId,item_id:base.itemId,content_version:base.contentVersion,content_hash:base.contentHash,instagram_account_id:base.accountId,action:base.action,authorization_key:ownerOverrideKey(base)};
  assert.equal(ownerOverrideMatches(row,base),true);
  assert.equal(ownerOverrideMatches(row,{...base,contentVersion:3}),false);
  assert.equal(ownerOverrideMatches(row,{...base,contentHash:"b".repeat(64)}),false);
  assert.equal(ownerOverrideMatches(row,{...base,accountId:"00000000-0000-4000-8000-000000000004"}),false);
  assert.equal(ownerOverrideMatches(row,{...base,action:"schedule",scheduledAt:"2026-10-15T12:00:00Z"}),false);
});

test("schedule OWNER_OVERRIDE is bound to exact timestamp and timezone",()=>{
  const scope={...base,action:"schedule",scheduledAt:"2026-10-15T12:00:00-05:00",scheduledTimezone:"America/Bogota"};
  const row={post_id:scope.postId,client_id:scope.clientId,item_id:scope.itemId,content_version:scope.contentVersion,content_hash:scope.contentHash,instagram_account_id:scope.accountId,action:scope.action,scheduled_at:"2026-10-15T17:00:00.000Z",scheduled_timezone:scope.scheduledTimezone,authorization_key:ownerOverrideKey(scope)};
  assert.equal(ownerOverrideMatches(row,scope),true);
  assert.equal(ownerOverrideMatches(row,{...scope,scheduledAt:"2026-10-15T12:01:00-05:00"}),false);
  assert.equal(ownerOverrideMatches(row,{...scope,scheduledTimezone:"UTC"}),false);
});

test("missing Auditor execution becomes explicit instead of waiting forever",()=>{
  const now=Date.parse("2026-10-14T12:20:00Z");
  assert.equal(auditExecutionState("2026-10-14T12:10:00Z",now,15*60*1000),"AUDIT_PENDING");
  assert.equal(auditExecutionState("2026-10-14T12:00:00Z",now,15*60*1000),"AUDITOR_NOT_EXECUTED");
  assert.equal(auditExecutionState(null,now,15*60*1000),"AUDITOR_NOT_EXECUTED");
});
