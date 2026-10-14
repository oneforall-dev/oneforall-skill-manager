import { createHash } from "node:crypto";

export type PublicationAction="publish_now"|"schedule";

export type OwnerOverrideScope={
  postId:string;
  clientId:string;
  itemId:string;
  contentVersion:number;
  contentHash:string;
  accountId:string;
  action:PublicationAction;
  scheduledAt?:string|null;
  scheduledTimezone?:string|null;
};

function normalizedTime(value?:string|null){
  if(!value) return null;
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)) throw new Error("OWNER_OVERRIDE_INVALID: scheduled_at must be ISO-8601");
  return new Date(parsed).toISOString();
}

export function ownerOverrideKey(scope:OwnerOverrideScope){
  return createHash("sha256").update(JSON.stringify({
    post_id:scope.postId,
    client_id:scope.clientId,
    item_id:scope.itemId,
    content_version:scope.contentVersion,
    content_hash:scope.contentHash,
    instagram_account_id:scope.accountId,
    action:scope.action,
    scheduled_at:scope.action==="schedule"?normalizedTime(scope.scheduledAt):null,
    scheduled_timezone:scope.action==="schedule"?(scope.scheduledTimezone||null):null
  })).digest("hex");
}

export function ownerOverrideMatches(row:any,scope:OwnerOverrideScope){
  if(!row) return false;
  if(row.post_id!==scope.postId||row.client_id!==scope.clientId||row.item_id!==scope.itemId) return false;
  if(Number(row.content_version)!==scope.contentVersion||row.content_hash!==scope.contentHash) return false;
  if(row.instagram_account_id!==scope.accountId||row.action!==scope.action) return false;
  if(scope.action==="schedule"){
    if(normalizedTime(row.scheduled_at)!==normalizedTime(scope.scheduledAt)) return false;
    if((row.scheduled_timezone||null)!==(scope.scheduledTimezone||null)) return false;
  }
  return row.authorization_key===ownerOverrideKey(scope);
}

export function auditExecutionState(requiredAt:string|Date|null|undefined,nowMs=Date.now(),timeoutMs=Number(process.env.AUDITOR_EXECUTION_TIMEOUT_MS||15*60*1000)){
  if(!requiredAt) return "AUDITOR_NOT_EXECUTED" as const;
  const started=new Date(requiredAt).getTime();
  if(!Number.isFinite(started)||nowMs-started>=timeoutMs) return "AUDITOR_NOT_EXECUTED" as const;
  return "AUDIT_PENDING" as const;
}
