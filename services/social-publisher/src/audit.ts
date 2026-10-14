import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type AuditReceiptPayload = {
  audit_id:string;
  issuer:string;
  auditor_identity:string;
  verdict:"PASS";
  client_id:string;
  item_id:string;
  content_version:number;
  content_hash:string;
  audited_at:string;
};

export type AuditVerifierConfig = {
  secret:string;
  allowedIssuers:Set<string>;
  maxAgeMs:number;
  futureSkewMs:number;
};

export function canonicalAuditReceipt(payload:AuditReceiptPayload) {
  return JSON.stringify({
    audit_id:payload.audit_id,
    issuer:payload.issuer,
    auditor_identity:payload.auditor_identity,
    verdict:payload.verdict,
    client_id:payload.client_id,
    item_id:payload.item_id,
    content_version:payload.content_version,
    content_hash:payload.content_hash,
    audited_at:payload.audited_at
  });
}

export function signAuditReceipt(payload:AuditReceiptPayload, secret:string) {
  return `v1=${createHmac("sha256",secret).update(canonicalAuditReceipt(payload)).digest("hex")}`;
}

export function signatureDigest(signature:string) {
  return createHash("sha256").update(signature).digest("hex");
}

export function loadAuditVerifierConfig(env:NodeJS.ProcessEnv=process.env):AuditVerifierConfig {
  const secret=env.AUDITOR_RECEIPT_HMAC_SECRET?.trim();
  if(!secret) throw new Error("AUDITOR_RECEIPT_HMAC_SECRET is required to verify Auditor receipts");
  if(secret.length<32) throw new Error("AUDITOR_RECEIPT_HMAC_SECRET must contain at least 32 characters");
  const allowedIssuers=new Set((env.AUDITOR_ALLOWED_ISSUERS||"oneforall-auditor").split(",").map(v=>v.trim()).filter(Boolean));
  if(!allowedIssuers.size) throw new Error("AUDITOR_ALLOWED_ISSUERS must include at least one trusted issuer");
  const maxAgeMs=Number(env.AUDITOR_RECEIPT_MAX_AGE_MS||7*24*60*60*1000);
  const futureSkewMs=Number(env.AUDITOR_RECEIPT_FUTURE_SKEW_MS||5*60*1000);
  if(!Number.isFinite(maxAgeMs)||maxAgeMs<=0) throw new Error("AUDITOR_RECEIPT_MAX_AGE_MS must be positive");
  if(!Number.isFinite(futureSkewMs)||futureSkewMs<0) throw new Error("AUDITOR_RECEIPT_FUTURE_SKEW_MS must be non-negative");
  return {secret,allowedIssuers,maxAgeMs,futureSkewMs};
}

export function verifyAuditReceipt(
  payload:AuditReceiptPayload,
  signature:string,
  config:AuditVerifierConfig,
  nowMs=Date.now()
) {
  if(payload.verdict!=="PASS") throw new Error("AUDIT_RECEIPT_INVALID: verdict must be PASS");
  if(!config.allowedIssuers.has(payload.issuer)) throw new Error(`AUDIT_RECEIPT_UNAUTHORIZED_ISSUER: ${payload.issuer}`);
  if(!/^[a-f0-9]{64}$/i.test(payload.content_hash)) throw new Error("AUDIT_RECEIPT_INVALID: content_hash must be SHA-256 hex");
  if(!Number.isInteger(payload.content_version)||payload.content_version<1) throw new Error("AUDIT_RECEIPT_INVALID: content_version must be positive");
  const auditedAt=Date.parse(payload.audited_at);
  if(!Number.isFinite(auditedAt)) throw new Error("AUDIT_RECEIPT_INVALID: audited_at must be ISO-8601");
  if(auditedAt>nowMs+config.futureSkewMs) throw new Error("AUDIT_RECEIPT_INVALID: audited_at is in the future");
  if(nowMs-auditedAt>config.maxAgeMs) throw new Error("AUDIT_RECEIPT_EXPIRED");
  const expected=signAuditReceipt(payload,config.secret);
  const supplied=Buffer.from(signature);
  const wanted=Buffer.from(expected);
  if(supplied.length!==wanted.length||!timingSafeEqual(supplied,wanted)) throw new Error("AUDIT_RECEIPT_BAD_SIGNATURE");
  return {verified:true as const,signature_digest:signatureDigest(signature),audited_at:new Date(auditedAt).toISOString()};
}

