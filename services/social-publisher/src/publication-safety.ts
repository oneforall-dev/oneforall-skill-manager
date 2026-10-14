import { createHash } from "node:crypto";

export type PublishErrorDisposition="safe_failure"|"unknown_outcome";

export function publicationIdempotencyKey(post:{id:string;content_version:number;instagram_account_id:string}) {
  return createHash("sha256").update(JSON.stringify({
    operation:"instagram_publish",
    post_id:post.id,
    content_version:post.content_version,
    destination:post.instagram_account_id
  })).digest("hex");
}

export function publishErrorDisposition(error:unknown):PublishErrorDisposition {
  const value=error as {publicationOutcome?:string;status?:number;name?:string};
  if(value?.publicationOutcome==="unknown") return "unknown_outcome";
  return "safe_failure";
}

export function sanitizedError(error:unknown) {
  const raw=String((error as any)?.message||error||"unknown error");
  return raw
    .replace(/access_token=[^&\s]+/gi,"access_token=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,"Bearer [REDACTED]")
    .slice(0,2000);
}

