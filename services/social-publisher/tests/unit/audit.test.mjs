import test from "node:test";
import assert from "node:assert/strict";
import { signAuditReceipt, verifyAuditReceipt } from "../../dist/audit.js";

const secret="test-secret-that-is-longer-than-thirty-two-characters";
const now=Date.parse("2026-10-13T12:00:00Z");
const payload={audit_id:"audit-123456",issuer:"oneforall-auditor",auditor_identity:"auditor-service:key-1",verdict:"PASS",client_id:"00000000-0000-4000-8000-000000000001",item_id:"ITEM-001",content_version:2,content_hash:"a".repeat(64),audited_at:"2026-10-13T11:59:00Z"};
const config={secret,allowedIssuers:new Set(["oneforall-auditor"]),maxAgeMs:86_400_000,futureSkewMs:300_000};

test("accepts a correctly scoped authenticated receipt",()=>{
  const result=verifyAuditReceipt(payload,signAuditReceipt(payload,secret),config,now);
  assert.equal(result.verified,true);
  assert.match(result.signature_digest,/^[0-9a-f]{64}$/);
});

test("rejects tampering and unauthorized issuers",()=>{
  const signature=signAuditReceipt(payload,secret);
  assert.throws(()=>verifyAuditReceipt({...payload,content_hash:"b".repeat(64)},signature,config,now),/BAD_SIGNATURE/);
  const unauthorized={...payload,issuer:"publisher"};
  assert.throws(()=>verifyAuditReceipt(unauthorized,signAuditReceipt(unauthorized,secret),config,now),/UNAUTHORIZED_ISSUER/);
});

test("rejects expired receipts",()=>{
  const expired={...payload,audited_at:"2026-10-10T11:59:00Z"};
  assert.throws(()=>verifyAuditReceipt(expired,signAuditReceipt(expired,secret),config,now),/EXPIRED/);
});

