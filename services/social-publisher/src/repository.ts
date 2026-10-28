import { pool, withTx } from "./db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { IgCredentials } from "./instagram.js";
import type { TrialReelGraduationStrategy } from "./instagram.js";
import { createHash } from "node:crypto";
import { loadAuditVerifierConfig, verifyAuditReceipt, type AuditReceiptPayload } from "./audit.js";
import { publicationIdempotencyKey } from "./publication-safety.js";
import { auditExecutionState, ownerOverrideKey, ownerOverrideMatches, type PublicationAction } from "./authorization.js";

type ContentFormat = "image"|"carousel"|"reel"|"story";
type ContentSnapshot = {
  clientId:string;
  accountId:string;
  format:ContentFormat;
  caption:string|null;
  assetIds:string[];
  shareToFeed:boolean;
  coverUrl:string|null;
  trialReel:boolean;
  trialGraduationStrategy:TrialReelGraduationStrategy|null;
};

type ContentInput={clientSlug:string;accountId:string;format:ContentFormat;caption?:string;assetIds:string[];shareToFeed?:boolean;coverUrl?:string;trialReel?:boolean;trialGraduationStrategy?:TrialReelGraduationStrategy};

export function contentHash(snapshot:ContentSnapshot) {
  const canonical:any={
    client_id:snapshot.clientId,
    instagram_account_id:snapshot.accountId,
    format:snapshot.format,
    caption:snapshot.caption,
    asset_ids:snapshot.assetIds,
    share_to_feed:snapshot.shareToFeed,
    cover_url:snapshot.coverUrl
  };
  // Preserve every pre-Trial-Reels content hash exactly. Trial settings are
  // appended only when enabled, so historical approvals remain valid.
  if(snapshot.trialReel){
    canonical.trial_reel=true;
    canonical.trial_graduation_strategy=snapshot.trialGraduationStrategy;
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function validateContent(c:any,args:ContentInput) {
  const cr=await c.query(`SELECT id FROM clients WHERE slug=$1 AND status='active'`,[args.clientSlug]);
  if(!cr.rowCount) throw new Error(`Unknown active client: ${args.clientSlug}`);
  const clientId=cr.rows[0].id as string;
  const accountId=args.accountId;
  const check=await c.query(`SELECT 1 FROM instagram_accounts WHERE id=$1 AND client_id=$2 AND status='active'`,[accountId,clientId]);
  if(!check.rowCount) throw new Error("Account does not belong to client or is inactive");
  if(args.format==='image' && args.assetIds.length!==1) throw new Error("Image post requires exactly 1 asset");
  if(args.format==='carousel' && (args.assetIds.length<2||args.assetIds.length>10)) throw new Error("Carousel requires 2-10 assets");
  if(args.format==='reel' && args.assetIds.length!==1) throw new Error("Reel requires exactly 1 video asset");
  if(args.format==='story' && args.assetIds.length!==1) throw new Error("Story requires exactly 1 image or video asset");
  if(args.format==='story' && args.caption?.trim()) throw new Error("Instagram Stories do not support captions; render text into the asset instead");
  if(args.format==='story' && args.coverUrl) throw new Error("cover_url is not valid for Stories");
  if(args.trialReel&&args.format!=='reel') throw new Error("Trial mode is only valid for Reels");
  if(args.trialReel&&!args.trialGraduationStrategy) throw new Error("Trial Reel requires trial_graduation_strategy");
  if(!args.trialReel&&args.trialGraduationStrategy) throw new Error("trial_graduation_strategy requires trial_reel=true");
  const assets=await c.query(`SELECT id,kind FROM assets WHERE client_id=$1 AND id=ANY($2::uuid[])`,[clientId,args.assetIds]);
  if(assets.rowCount!==args.assetIds.length) throw new Error("One or more assets do not belong to this client");
  if(args.format==='reel' && assets.rows[0].kind!=='video') throw new Error("Reel asset must be video");
  if((args.format==='image'||args.format==='carousel') && assets.rows.some((a:any)=>a.kind!=='image')) throw new Error("Image/carousel assets must be images");
  if(args.format==='story' && !['image','video'].includes(assets.rows[0].kind)) throw new Error("Story asset must be an image or video");
  return {
    clientId,
    accountId:accountId!,
    snapshot:{clientId,accountId:accountId!,format:args.format,caption:args.caption||null,assetIds:args.assetIds,shareToFeed:args.shareToFeed??true,coverUrl:args.coverUrl||null,trialReel:args.trialReel??false,trialGraduationStrategy:args.trialReel?(args.trialGraduationStrategy||null):null} as ContentSnapshot
  };
}

async function resolveContentPost(itemId:string,clientSlug?:string) {
  const params:any[]=[itemId];
  let clientFilter="";
  if(clientSlug){params.push(clientSlug);clientFilter=` AND c.slug=$2`;}
  const q=await pool.query(`SELECT p.id,c.slug AS client_slug FROM posts p JOIN clients c ON c.id=p.client_id WHERE p.item_id=$1${clientFilter} ORDER BY p.created_at DESC`,params);
  if(!q.rowCount) throw new Error(`Content item not found: ${itemId}`);
  if(q.rowCount>1) throw new Error(`ITEM_ID ${itemId} exists for multiple clients; provide client_slug`);
  return q.rows[0] as {id:string;client_slug:string};
}

export async function createClient(slug:string, name:string) {
  const { rows } = await pool.query(`INSERT INTO clients(slug,name) VALUES($1,$2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name, updated_at=now() RETURNING *`, [slug,name]);
  return rows[0];
}
export async function listClients() {
  return (await pool.query(`SELECT id,slug,name,status,created_at FROM clients ORDER BY name`)).rows;
}
export async function upsertInstagramAccount(args:{clientSlug:string;instagramUserId:string;username:string;accountType?:string;accessToken:string;tokenExpiresAt?:string;isDefault?:boolean}) {
  return withTx(async c => {
    const cr = await c.query(`SELECT id FROM clients WHERE slug=$1 AND status='active'`, [args.clientSlug]);
    if (!cr.rowCount) throw new Error(`Unknown active client: ${args.clientSlug}`);
    const clientId = cr.rows[0].id;
    if (args.isDefault) await c.query(`UPDATE instagram_accounts SET is_default=false, updated_at=now() WHERE client_id=$1`, [clientId]);
    const enc = encryptSecret(args.accessToken);
    const { rows } = await c.query(`
      INSERT INTO instagram_accounts(client_id,instagram_user_id,username,account_type,access_token_enc,token_expires_at,is_default,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active')
      ON CONFLICT(client_id,instagram_user_id) DO UPDATE SET username=EXCLUDED.username, account_type=EXCLUDED.account_type, access_token_enc=EXCLUDED.access_token_enc, token_expires_at=EXCLUDED.token_expires_at, is_default=EXCLUDED.is_default, status='active', updated_at=now()
      RETURNING id,client_id,instagram_user_id,username,account_type,token_expires_at,is_default,status
    `,[clientId,args.instagramUserId,args.username,args.accountType||null,enc,args.tokenExpiresAt||null,args.isDefault||false]);
    return rows[0];
  });
}
export async function listAccounts(clientSlug?:string) {
  const params:any[]=[]; let where="";
  if (clientSlug) { params.push(clientSlug); where="WHERE c.slug=$1"; }
  return (await pool.query(`SELECT a.id,c.slug AS client_slug,c.name AS client_name,a.instagram_user_id,a.username,a.account_type,a.token_expires_at,a.is_default,a.status FROM instagram_accounts a JOIN clients c ON c.id=a.client_id ${where} ORDER BY c.name,a.is_default DESC,a.username`,params)).rows;
}
export async function getAccount(accountId:string):Promise<any & {credentials:IgCredentials}> {
  const { rows } = await pool.query(`SELECT a.*,c.slug AS client_slug,c.name AS client_name FROM instagram_accounts a JOIN clients c ON c.id=a.client_id WHERE a.id=$1 AND a.status='active'`,[accountId]);
  if (!rows[0]) throw new Error("Instagram account not found or inactive");
  const a=rows[0];
  return {...a,credentials:{instagramUserId:a.instagram_user_id,accessToken:decryptSecret(a.access_token_enc)}};
}
export async function getDefaultAccount(clientSlug:string) {
  const { rows } = await pool.query(`SELECT a.id FROM instagram_accounts a JOIN clients c ON c.id=a.client_id WHERE c.slug=$1 AND a.status='active' ORDER BY a.is_default DESC,a.created_at ASC LIMIT 1`,[clientSlug]);
  if (!rows[0]) throw new Error(`No active Instagram account for ${clientSlug}`);
  return getAccount(rows[0].id);
}
export async function registerAsset(clientSlug:string, kind:"image"|"video", publicUrl:string, label?:string, mimeType?:string) {
  const { rows }=await pool.query(`INSERT INTO assets(client_id,kind,public_url,label,mime_type) SELECT id,$2,$3,$4,$5 FROM clients WHERE slug=$1 RETURNING *`,[clientSlug,kind,publicUrl,label||null,mimeType||null]);
  if(!rows[0]) throw new Error(`Unknown client: ${clientSlug}`); return rows[0];
}
export async function listAssets(clientSlug:string, limit=50) {
  return (await pool.query(`SELECT a.id,a.kind,a.public_url,a.mime_type,a.label,a.storage_provider,a.storage_key,a.size_bytes,a.created_at FROM assets a JOIN clients c ON c.id=a.client_id WHERE c.slug=$1 ORDER BY a.created_at DESC LIMIT $2`,[clientSlug,limit])).rows;
}
export async function createPost(args:ContentInput&{itemId?:string;scheduledAt?:string;status?:"draft"|"scheduled";approved?:boolean;approvedBy?:string}) {
  return withTx(async c=>{
    const {clientId,accountId}=await validateContent(c,args);
    if(args.status==='scheduled'||args.scheduledAt||args.approved) throw new Error("New content must use save_content_item -> authenticated Auditor receipt -> approve_content_item -> schedule_content_item");
    const pr=await c.query(`INSERT INTO posts(client_id,instagram_account_id,item_id,format,caption,share_to_feed,cover_url,trial_reel,trial_graduation_strategy,status,scheduled_at,approved_version,approved_content_hash,approved_at,approved_by,audit_required_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',NULL,NULL,NULL,NULL,NULL,now()) RETURNING *`,[clientId,accountId,args.itemId||null,args.format,args.caption||null,args.shareToFeed??true,args.coverUrl||null,args.trialReel??false,args.trialReel?args.trialGraduationStrategy||null:null]);
    for(let i=0;i<args.assetIds.length;i++) await c.query(`INSERT INTO post_assets(post_id,asset_id,position) VALUES($1,$2,$3)`,[pr.rows[0].id,args.assetIds[i],i]);
    return pr.rows[0];
  });
}
export async function getPost(postId:string) {
  const { rows }=await pool.query(`SELECT p.*,c.slug AS client_slug,c.name AS client_name,a.username AS instagram_username,a.instagram_user_id FROM posts p JOIN clients c ON c.id=p.client_id JOIN instagram_accounts a ON a.id=p.instagram_account_id WHERE p.id=$1`,[postId]);
  if(!rows[0]) throw new Error("Post not found");
  const assets=(await pool.query(`SELECT x.position,a.id,a.kind,a.public_url,a.mime_type,a.storage_provider,a.storage_key,a.size_bytes,a.label FROM post_assets x JOIN assets a ON a.id=x.asset_id WHERE x.post_id=$1 ORDER BY x.position`,[postId])).rows;
  const post=rows[0];
  const currentHash=contentHash({clientId:post.client_id,accountId:post.instagram_account_id,format:post.format,caption:post.caption,assetIds:assets.map((a:any)=>a.id),shareToFeed:post.share_to_feed,coverUrl:post.cover_url,trialReel:post.trial_reel,trialGraduationStrategy:post.trial_graduation_strategy});
  const receipt=(await pool.query(`SELECT audit_id,issuer,auditor_identity,verdict,content_version,content_hash,audited_at,received_at FROM audit_receipts WHERE post_id=$1 AND content_version=$2 AND content_hash=$3 AND verdict='PASS' ORDER BY audited_at DESC LIMIT 1`,[postId,post.content_version,currentHash])).rows[0]||null;
  const ownerOverride=(await pool.query(`SELECT id,authorization_key,post_id,client_id,item_id,content_version,content_hash,instagram_account_id,owner_identity,action,scheduled_at,scheduled_timezone,content_snapshot,authorized_at FROM owner_overrides WHERE post_id=$1 AND content_version=$2 AND content_hash=$3 AND instagram_account_id=$4 ORDER BY authorized_at DESC LIMIT 1`,[postId,post.content_version,currentHash,post.instagram_account_id])).rows[0]||null;
  const auditState=receipt?'PASS':auditExecutionState(post.audit_required_at);
  return {...post,assets,ordered_asset_ids:assets.map((a:any)=>a.id),content_hash:currentHash,audit_receipt:receipt,owner_override:ownerOverride,audit_execution_status:post.audit_required?auditState:'LEGACY_GRANDFATHERED',approval_hash:post.approved_content_hash,platform_media_id:post.instagram_media_id,error:post.last_error};
}

export async function getContentItem(itemId:string,clientSlug?:string) {
  const resolved=await resolveContentPost(itemId,clientSlug);
  return getPost(resolved.id);
}

export async function saveContentItem(args:ContentInput&{itemId:string}) {
  const result=await withTx(async c=>{
    const validated=await validateContent(c,args);
    const targetHash=contentHash(validated.snapshot);
    const existing=await c.query(`SELECT * FROM posts WHERE client_id=$1 AND item_id=$2 FOR UPDATE`,[validated.clientId,args.itemId]);
    if(!existing.rowCount){
      const inserted=await c.query(`INSERT INTO posts(client_id,instagram_account_id,item_id,format,caption,share_to_feed,cover_url,trial_reel,trial_graduation_strategy,status,approval_required,audit_required,audit_required_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',true,true,now()) RETURNING id`,[validated.clientId,validated.accountId,args.itemId,args.format,args.caption||null,args.shareToFeed??true,args.coverUrl||null,args.trialReel??false,args.trialReel?args.trialGraduationStrategy||null:null]);
      for(let i=0;i<args.assetIds.length;i++) await c.query(`INSERT INTO post_assets(post_id,asset_id,position) VALUES($1,$2,$3)`,[inserted.rows[0].id,args.assetIds[i],i]);
      return {id:inserted.rows[0].id,created:true,changed:true};
    }
    const current=existing.rows[0];
    if(['scheduled','publishing','published'].includes(current.status)) throw new Error(`Content ${args.itemId} cannot be edited while status is ${current.status}`);
    const currentAssets=(await c.query(`SELECT asset_id FROM post_assets WHERE post_id=$1 ORDER BY position`,[current.id])).rows.map((r:any)=>r.asset_id);
    const currentHash=contentHash({clientId:current.client_id,accountId:current.instagram_account_id,format:current.format,caption:current.caption,assetIds:currentAssets,shareToFeed:current.share_to_feed,coverUrl:current.cover_url,trialReel:current.trial_reel,trialGraduationStrategy:current.trial_graduation_strategy});
    if(currentHash===targetHash) return {id:current.id,created:false,changed:false};
    await c.query(`UPDATE posts SET instagram_account_id=$2,format=$3,caption=$4,share_to_feed=$5,cover_url=$6,trial_reel=$7,trial_graduation_strategy=$8,status='draft',scheduled_at=NULL,last_error=NULL,content_version=content_version+1,approved_version=NULL,approved_content_hash=NULL,approved_at=NULL,approved_by=NULL,approval_required=true,audit_required=true,audit_required_at=now(),updated_at=now() WHERE id=$1`,[current.id,validated.accountId,args.format,args.caption||null,args.shareToFeed??true,args.coverUrl||null,args.trialReel??false,args.trialReel?args.trialGraduationStrategy||null:null]);
    await c.query(`DELETE FROM post_assets WHERE post_id=$1`,[current.id]);
    for(let i=0;i<args.assetIds.length;i++) await c.query(`INSERT INTO post_assets(post_id,asset_id,position) VALUES($1,$2,$3)`,[current.id,args.assetIds[i],i]);
    return {id:current.id,created:false,changed:true};
  });
  return {...await getPost(result.id),created:result.created,changed:result.changed};
}

export async function updateContentItemCaption(args:{itemId:string;clientSlug?:string;caption:string}) {
  const resolved=await resolveContentPost(args.itemId,args.clientSlug);
  const result=await pool.query(`UPDATE posts SET caption=$2,status='draft',scheduled_at=NULL,last_error=NULL,content_version=content_version+1,approved_version=NULL,approved_content_hash=NULL,approved_at=NULL,approved_by=NULL,approval_required=true,audit_required=true,audit_required_at=now(),updated_at=now() WHERE id=$1 AND status IN ('draft','failed','cancelled') AND caption IS DISTINCT FROM $2 RETURNING id`,[resolved.id,args.caption]);
  if(!result.rowCount){
    const current=await getPost(resolved.id);
    if(current.caption===args.caption) return {...current,changed:false};
    throw new Error(`Content ${args.itemId} cannot be edited while status is ${current.status}`);
  }
  return {...await getPost(resolved.id),changed:true,approval_invalidated:true};
}

async function currentOwnerOverride(c:any,post:any,hash:string,action?:PublicationAction,scheduledAt?:string,scheduledTimezone?:string) {
  const params:any[]=[post.id,post.content_version,hash,post.instagram_account_id];
  let actionFilter="";
  if(action){params.push(action);actionFilter=` AND action=$${params.length}`;}
  const rows=(await c.query(`SELECT * FROM owner_overrides WHERE post_id=$1 AND content_version=$2 AND content_hash=$3 AND instagram_account_id=$4${actionFilter} ORDER BY authorized_at DESC`,params)).rows;
  if(!action) return rows.find((row:any)=>ownerOverrideMatches(row,{postId:post.id,clientId:post.client_id,itemId:post.item_id,contentVersion:post.content_version,contentHash:hash,accountId:post.instagram_account_id,action:row.action,scheduledAt:row.scheduled_at,scheduledTimezone:row.scheduled_timezone}))||null;
  const scope={postId:post.id,clientId:post.client_id,itemId:post.item_id,contentVersion:post.content_version,contentHash:hash,accountId:post.instagram_account_id,action,scheduledAt,scheduledTimezone};
  return rows.find((row:any)=>ownerOverrideMatches(row,scope))||null;
}

async function requirePublicationAuthorizationWithClient(c:any,post:any,hash:string,action?:PublicationAction,scheduledAt?:string,scheduledTimezone?:string) {
  if(!post.audit_required) return {route:"LEGACY_GRANDFATHERED" as const,required:false,legacy_grandfathered:true};
  const receipt=(await c.query(`SELECT audit_id,issuer,auditor_identity,verdict,content_version,content_hash,audited_at,received_at FROM audit_receipts WHERE post_id=$1 AND content_version=$2 AND content_hash=$3 AND verdict='PASS' ORDER BY audited_at DESC LIMIT 1`,[post.id,post.content_version,hash])).rows[0];
  if(receipt){
    try{
      const config=loadAuditVerifierConfig();
      const auditedAt=new Date(receipt.audited_at).getTime();
      if(config.allowedIssuers.has(receipt.issuer)&&Number.isFinite(auditedAt)&&Date.now()-auditedAt<=config.maxAgeMs&&auditedAt<=Date.now()+config.futureSkewMs) return {route:"AUDITOR_PASS" as const,required:true,legacy_grandfathered:false,receipt};
    }catch{
      // OWNER_OVERRIDE is an independent route. Missing Auditor verifier
      // configuration must not disable an otherwise exact owner authorization.
    }
  }
  const override=await currentOwnerOverride(c,post,hash,action,scheduledAt,scheduledTimezone);
  if(override) return {route:"OWNER_OVERRIDE" as const,required:true,legacy_grandfathered:false,owner_override:override};
  const state=auditExecutionState(post.audit_required_at);
  if(state==="AUDITOR_NOT_EXECUTED") throw new Error(`AUDITOR_NOT_EXECUTED: no PASS or valid OWNER_OVERRIDE matches ${post.item_id||post.id} version ${post.content_version}, account ${post.instagram_account_id} and content hash ${hash}`);
  throw new Error(`AUDIT_PENDING: no PASS or valid OWNER_OVERRIDE yet matches ${post.item_id||post.id} version ${post.content_version}, account ${post.instagram_account_id} and content hash ${hash}`);
}

export async function assertCurrentPublicationAuthorization(post:any,action?:PublicationAction,scheduledAt?:string,scheduledTimezone?:string) {
  const hash=post.content_hash||hashPostContent(post);
  return requirePublicationAuthorizationWithClient(pool,post,hash,action,scheduledAt,scheduledTimezone);
}

export async function registerOwnerOverride(args:{itemId:string;clientSlug?:string;expectedVersion:number;expectedContentHash:string;accountId:string;ownerIdentity:string;action:PublicationAction;scheduledAt?:string;scheduledTimezone?:string}) {
  const resolved=await resolveContentPost(args.itemId,args.clientSlug);
  return withTx(async c=>{
    const post=(await c.query(`SELECT * FROM posts WHERE id=$1 FOR UPDATE`,[resolved.id])).rows[0];
    if(!post) throw new Error("Content item not found");
    if(!post.item_id) throw new Error("OWNER_OVERRIDE_INVALID: ITEM_ID is required");
    if(post.content_version!==args.expectedVersion) throw new Error(`OWNER_OVERRIDE_SCOPE_MISMATCH: expected version ${args.expectedVersion}, current ${post.content_version}`);
    if(post.instagram_account_id!==args.accountId) throw new Error("OWNER_OVERRIDE_SCOPE_MISMATCH: destination account");
    if(['publishing','published'].includes(post.status)) throw new Error(`OWNER_OVERRIDE_INVALID: content is ${post.status}`);
    if(args.action==='schedule'&&!args.scheduledAt) throw new Error("OWNER_OVERRIDE_INVALID: schedule action requires scheduled_at");
    if(args.action==='publish_now'&&args.scheduledAt) throw new Error("OWNER_OVERRIDE_INVALID: publish_now cannot include scheduled_at");
    const assets=(await c.query(`SELECT x.position,a.id,a.kind,a.public_url,a.label FROM post_assets x JOIN assets a ON a.id=x.asset_id WHERE x.post_id=$1 ORDER BY x.position`,[post.id])).rows;
    const assetIds=assets.map((asset:any)=>asset.id);
    const hash=contentHash({clientId:post.client_id,accountId:post.instagram_account_id,format:post.format,caption:post.caption,assetIds,shareToFeed:post.share_to_feed,coverUrl:post.cover_url,trialReel:post.trial_reel,trialGraduationStrategy:post.trial_graduation_strategy});
    if(hash!==args.expectedContentHash) throw new Error("OWNER_OVERRIDE_SCOPE_MISMATCH: content hash");
    const scope={postId:post.id,clientId:post.client_id,itemId:post.item_id,contentVersion:post.content_version,contentHash:hash,accountId:post.instagram_account_id,action:args.action,scheduledAt:args.scheduledAt,scheduledTimezone:args.scheduledTimezone};
    const key=ownerOverrideKey(scope);
    const snapshot={client_id:post.client_id,item_id:post.item_id,content_version:post.content_version,content_hash:hash,instagram_account_id:post.instagram_account_id,format:post.format,caption:post.caption,ordered_asset_ids:assetIds,assets,share_to_feed:post.share_to_feed,cover_url:post.cover_url,trial_reel:post.trial_reel,trial_graduation_strategy:post.trial_graduation_strategy,action:args.action,scheduled_at:args.scheduledAt||null,scheduled_timezone:args.scheduledTimezone||null};
    const inserted=await c.query(`INSERT INTO owner_overrides(authorization_key,post_id,client_id,item_id,content_version,content_hash,instagram_account_id,owner_identity,action,scheduled_at,scheduled_timezone,content_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(authorization_key) DO NOTHING RETURNING *`,[key,post.id,post.client_id,post.item_id,post.content_version,hash,post.instagram_account_id,args.ownerIdentity,args.action,args.scheduledAt||null,args.scheduledTimezone||null,snapshot]);
    const override=inserted.rows[0]||(await c.query(`SELECT * FROM owner_overrides WHERE authorization_key=$1`,[key])).rows[0];
    if(!ownerOverrideMatches(override,scope)) throw new Error("OWNER_OVERRIDE_REPLAY_MISMATCH");
    await c.query(`UPDATE posts SET status='draft',approved_version=content_version,approved_content_hash=$2,approved_at=COALESCE(approved_at,now()),approved_by=$3,approval_required=true,last_error=NULL,updated_at=now() WHERE id=$1`,[post.id,hash,`OWNER:${args.ownerIdentity}`]);
    return {...override,content_snapshot:snapshot,authorization_route:'OWNER_OVERRIDE',already_registered:!inserted.rowCount};
  });
}

export async function registerAuditReceipt(args:{payload:AuditReceiptPayload;signature:string}) {
  const config=loadAuditVerifierConfig();
  const verified=verifyAuditReceipt(args.payload,args.signature,config);
  return withTx(async c=>{
    const q=await c.query(`SELECT p.* FROM posts p WHERE p.client_id=$1 AND p.item_id=$2 FOR UPDATE`,[args.payload.client_id,args.payload.item_id]);
    const post=q.rows[0];
    if(!post) throw new Error("Content item not found");
    const assetIds=(await c.query(`SELECT asset_id FROM post_assets WHERE post_id=$1 ORDER BY position`,[post.id])).rows.map((r:any)=>r.asset_id);
    const hash=contentHash({clientId:post.client_id,accountId:post.instagram_account_id,format:post.format,caption:post.caption,assetIds,shareToFeed:post.share_to_feed,coverUrl:post.cover_url,trialReel:post.trial_reel,trialGraduationStrategy:post.trial_graduation_strategy});
    if(args.payload.client_id!==post.client_id) throw new Error("AUDIT_RECEIPT_SCOPE_MISMATCH: client_id");
    if(args.payload.content_version!==post.content_version) throw new Error("AUDIT_RECEIPT_SCOPE_MISMATCH: content_version");
    if(args.payload.content_hash!==hash) throw new Error("AUDIT_RECEIPT_SCOPE_MISMATCH: content_hash");
    const inserted=await c.query(`INSERT INTO audit_receipts(audit_id,post_id,content_version,content_hash,issuer,auditor_identity,verdict,audited_at,signature_digest) VALUES($1,$2,$3,$4,$5,$6,'PASS',$7,$8) ON CONFLICT(audit_id) DO NOTHING RETURNING audit_id,post_id,content_version,content_hash,issuer,auditor_identity,verdict,audited_at,received_at`,[args.payload.audit_id,post.id,args.payload.content_version,args.payload.content_hash,args.payload.issuer,args.payload.auditor_identity,verified.audited_at,verified.signature_digest]);
    if(inserted.rows[0]) return {...inserted.rows[0],authenticated:true,already_registered:false};
    const existing=(await c.query(`SELECT audit_id,post_id,content_version,content_hash,issuer,auditor_identity,verdict,audited_at,received_at,signature_digest FROM audit_receipts WHERE audit_id=$1`,[args.payload.audit_id])).rows[0];
    if(!existing||existing.post_id!==post.id||existing.content_version!==args.payload.content_version||existing.content_hash!==args.payload.content_hash||existing.issuer!==args.payload.issuer||existing.signature_digest!==verified.signature_digest) throw new Error("AUDIT_RECEIPT_REPLAY_MISMATCH");
    return {...existing,signature_digest:undefined,authenticated:true,already_registered:true};
  });
}

export async function approveContentItem(args:{itemId:string;clientSlug?:string;expectedVersion:number;approvedBy?:string}) {
  const resolved=await resolveContentPost(args.itemId,args.clientSlug);
  await withTx(async c=>{
    const q=await c.query(`SELECT * FROM posts WHERE id=$1 FOR UPDATE`,[resolved.id]);
    const post=q.rows[0];
    if(!post) throw new Error("Content item not found");
    if(post.content_version!==args.expectedVersion) throw new Error(`Version mismatch: expected ${args.expectedVersion}, current ${post.content_version}`);
    if(['scheduled','publishing','published'].includes(post.status)) throw new Error(`Content cannot be approved while status is ${post.status}`);
    const assetIds=(await c.query(`SELECT asset_id FROM post_assets WHERE post_id=$1 ORDER BY position`,[post.id])).rows.map((r:any)=>r.asset_id);
    const hash=contentHash({clientId:post.client_id,accountId:post.instagram_account_id,format:post.format,caption:post.caption,assetIds,shareToFeed:post.share_to_feed,coverUrl:post.cover_url,trialReel:post.trial_reel,trialGraduationStrategy:post.trial_graduation_strategy});
    await requirePublicationAuthorizationWithClient(c,post,hash);
    await c.query(`UPDATE posts SET status='draft',approved_version=content_version,approved_content_hash=$2,approved_at=now(),approved_by=$3,approval_required=true,last_error=NULL,updated_at=now() WHERE id=$1`,[post.id,hash,args.approvedBy||null]);
  });
  return getPost(resolved.id);
}

export async function listContentItems(args:{clientSlug?:string;readiness?:"all"|"approved_unpublished"|"unapproved"|"published";limit?:number}) {
  const params:any[]=[];
  const where:string[]=[`p.item_id IS NOT NULL`];
  if(args.clientSlug){params.push(args.clientSlug);where.push(`c.slug=$${params.length}`);}
  const readiness=args.readiness||'all';
  if(readiness==='approved_unpublished') where.push(`p.approved_at IS NOT NULL AND p.approved_version=p.content_version AND p.status IN ('draft','scheduled','failed')`);
  if(readiness==='unapproved') where.push(`(p.approved_at IS NULL OR p.approved_version IS DISTINCT FROM p.content_version) AND p.status<>'published'`);
  if(readiness==='published') where.push(`p.status='published'`);
  params.push(args.limit||50);
  return (await pool.query(`SELECT p.id AS post_id,p.item_id,p.content_version,p.approved_version,p.approved_at,p.approved_by,p.status,p.format,p.trial_reel,p.trial_graduation_strategy,p.caption,p.instagram_media_id,p.published_at,c.slug AS client_slug,a.username AS instagram_username,(SELECT count(*)::int FROM post_assets pa WHERE pa.post_id=p.id) AS asset_count FROM posts p JOIN clients c ON c.id=p.client_id JOIN instagram_accounts a ON a.id=p.instagram_account_id WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC LIMIT $${params.length}`,params)).rows;
}

export async function getContentItemPostId(itemId:string,clientSlug?:string) {
  return (await resolveContentPost(itemId,clientSlug)).id;
}

export function hashPostContent(post:any) {
  return contentHash({clientId:post.client_id,accountId:post.instagram_account_id,format:post.format,caption:post.caption||null,assetIds:post.assets.map((a:any)=>a.id),shareToFeed:post.share_to_feed,coverUrl:post.cover_url||null,trialReel:post.trial_reel,trialGraduationStrategy:post.trial_graduation_strategy||null});
}
export async function listScheduled(clientSlug?:string, limit=50) {
  const p:any[]=[]; let where=`p.status='scheduled'`; if(clientSlug){p.push(clientSlug);where+=` AND c.slug=$1`;}; p.push(limit); const idx=p.length;
  return (await pool.query(`SELECT p.id,p.item_id,p.content_version,c.slug AS client_slug,a.username,p.format,p.trial_reel,p.trial_graduation_strategy,p.caption,p.scheduled_at,p.scheduled_timezone,p.created_at FROM posts p JOIN clients c ON c.id=p.client_id JOIN instagram_accounts a ON a.id=p.instagram_account_id WHERE ${where} ORDER BY p.scheduled_at ASC LIMIT $${idx}`,p)).rows;
}

export async function scheduleExistingPost(postId:string, scheduledAt:string, scheduledTimezone?:string) {
  const post=await getPost(postId);
  if(post.approval_required){
    if(!post.item_id || !post.approved_at || post.approved_version!==post.content_version || post.approved_content_hash!==hashPostContent(post)) throw new Error("Only the current approved content version can be scheduled");
  }
  await assertCurrentPublicationAuthorization(post,'schedule',scheduledAt,scheduledTimezone);
  const { rows }=await pool.query(`UPDATE posts SET status='scheduled',scheduled_at=$2,scheduled_timezone=$3,last_error=NULL,updated_at=now() WHERE id=$1 AND content_version=$4 AND status IN ('draft','failed','scheduled') RETURNING *`,[postId,scheduledAt,scheduledTimezone||null,post.content_version]);
  if(!rows[0]) throw new Error("Post cannot be scheduled from its current state");
  return rows[0];
}

export async function cancelScheduled(postId:string) {
  const { rows }=await pool.query(`UPDATE posts SET status='cancelled',updated_at=now() WHERE id=$1 AND status IN ('draft','scheduled') RETURNING *`,[postId]); if(!rows[0]) throw new Error("Post cannot be cancelled"); return rows[0];
}

export async function claimPublishOperation(post:any) {
  return withTx(async c=>{
    const current=(await c.query(`SELECT id,status,content_version,instagram_account_id,instagram_media_id FROM posts WHERE id=$1 FOR UPDATE`,[post.id])).rows[0];
    if(!current) throw new Error("Post not found");
    if(current.status==='published') return {state:'published' as const,media_id:current.instagram_media_id};
    if(current.content_version!==post.content_version) throw new Error("BLOCKED: content version changed before publication claim");
    const key=publicationIdempotencyKey(post);
    const inserted=await c.query(`INSERT INTO publish_operations(post_id,content_version,instagram_account_id,idempotency_key,status) VALUES($1,$2,$3,$4,'claimed') ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,[post.id,post.content_version,post.instagram_account_id,key]);
    if(!inserted.rowCount){
      const existing=(await c.query(`SELECT * FROM publish_operations WHERE idempotency_key=$1 FOR UPDATE`,[key])).rows[0];
      if(existing?.status==='succeeded') return {state:'published' as const,media_id:existing.external_media_id,operation:existing};
      throw new Error(`BLOCKED_PENDING_RECONCILIATION: publication operation ${key} is ${existing?.status||'unresolved'}; inspect platform evidence before retrying`);
    }
    const claimed=await c.query(`UPDATE posts SET status='publishing',last_error=NULL,updated_at=now() WHERE id=$1 AND content_version=$2 AND status IN ('draft','scheduled','failed') RETURNING id`,[post.id,post.content_version]);
    if(!claimed.rowCount) throw new Error(`BLOCKED_PENDING_RECONCILIATION: post is ${current.status}; publication claim was not executed`);
    return {state:'claimed' as const,operation:inserted.rows[0],idempotency_key:key};
  });
}

export async function markPublishPending(operationId:string) {
  const q=await pool.query(`UPDATE publish_operations SET status='platform_pending',updated_at=now() WHERE id=$1 AND status='claimed' RETURNING *`,[operationId]);
  if(!q.rowCount) throw new Error("Publication operation is not claimable for platform submission");
  return q.rows[0];
}

export async function markPublishSucceeded(args:{operationId:string;postId:string;mediaId:string}) {
  return withTx(async c=>{
    const op=await c.query(`UPDATE publish_operations SET status='succeeded',external_media_id=$2,last_error=NULL,updated_at=now() WHERE id=$1 AND status='platform_pending' RETURNING *`,[args.operationId,args.mediaId]);
    if(!op.rowCount) throw new Error("Publication operation is not pending");
    const post=await c.query(`UPDATE posts SET status='published',instagram_media_id=$2,published_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND status='publishing' RETURNING published_at`,[args.postId,args.mediaId]);
    if(!post.rowCount) throw new Error("Published platform result could not be committed to the expected post state");
    return {operation:op.rows[0],published_at:post.rows[0].published_at};
  });
}

export async function markPublishFailed(args:{operationId:string;postId:string;error:string}) {
  return withTx(async c=>{
    await c.query(`UPDATE publish_operations SET status='failed',last_error=$2,updated_at=now() WHERE id=$1 AND status IN ('claimed','platform_pending')`,[args.operationId,args.error]);
    await c.query(`UPDATE posts SET status='failed',last_error=$2,updated_at=now() WHERE id=$1 AND status='publishing'`,[args.postId,args.error]);
  });
}

export async function markPublishUnknown(args:{operationId:string;postId:string;error:string;mediaId?:string}) {
  await withTx(async c=>{
    await c.query(`UPDATE publish_operations SET status='unknown',external_media_id=COALESCE($3,external_media_id),last_error=$2,updated_at=now() WHERE id=$1 AND status IN ('claimed','platform_pending')`,[args.operationId,args.error,args.mediaId||null]);
    await c.query(`UPDATE posts SET status='publishing',last_error=$2,updated_at=now() WHERE id=$1 AND status='publishing'`,[args.postId,args.error]);
  });
}

export async function logPublish(postId:string, accountId:string, event:string, detail:any={}) { await pool.query(`INSERT INTO publish_logs(post_id,instagram_account_id,event,detail) VALUES($1,$2,$3,$4)`,[postId,accountId,event,detail]); }
export async function listPublishLogs(postId:string,limit=100) { return (await pool.query(`SELECT id,event,detail,created_at FROM publish_logs WHERE post_id=$1 ORDER BY id DESC LIMIT $2`,[postId,limit])).rows; }
