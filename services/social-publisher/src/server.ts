import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import * as z from "zod";
import { approveContentItem,createClient,listClients,upsertInstagramAccount,listAccounts,getAccount,getDefaultAccount,registerAsset,listAssets,getPost,getContentItem,saveContentItem,updateContentItemCaption,listContentItems,getContentItemPostId,listScheduled,cancelScheduled,listPublishLogs,scheduleExistingPost,registerAuditReceipt,registerOwnerOverride } from "./repository.js";
import { getProfile } from "./instagram.js";
import { publishPost } from "./publisher.js";
import { startScheduler,stopScheduler } from "./scheduler.js";
import { completeInstagramOAuth, createInstagramConnectUrl, refreshExpiringOAuthTokens, refreshInstagramAccountToken } from "./oauth.js";
import { createAssetUpload, finalizeAssetUpload, importAssetFromUrl, registerLegacyChatAsset, uploadChatGPTFiles } from "./storage.js";
import { checkDatabaseReady, pool } from "./db.js";
import { createWatchdog } from "./watchdog.js";

const VERSION="0.8.0";
const FEATURES=['multi-client','explicit-account-routing','oauth','r2','chatgpt-file-upload','chatgpt-file-idempotency','jpeg-normalization','legacy-chat-migration','persistent-content-items','versioned-approval','authenticated-audit-receipts','owner-override','audit-execution-timeout','legacy-audit-grandfathering','durable-publish-operations','duplicate-publication-guard','ambiguous-outcome-reconciliation','structured-publish-results','actor-header','handoff-protocol-v1','automatic-handoff-continuation','specialist-boundaries','complete-post-publish-handoff','carousel-image-media-type','scheduler','scheduler-failure-recovery','database-readiness','database-timeouts','database-watchdog'];

function txt(v:any){
  const outcome=v?.workflow_outcome||(v?.status==='PUBLISH_FAILED'?'BLOCKED':'DONE');
  return {content:[{type:"text" as const,text:`🚀 PUBLISH · SOCIAL PUBLISHER\n\n${outcome}\n${JSON.stringify(v)}`}]} ;
}
function handoff(v:any, requestedAction:string, expectedOutput:string, returnTo="🚀 PUBLISH · @Oneforall Social Publisher"){
  return txt({...v,workflow_outcome:"HANDOFF",handoff:{
    source_plugin:"🚀 PUBLISH · @Oneforall Social Publisher",
    target_plugin:"📊 SOCIAL · @Oneforall Social Manager",
    requested_action:requestedAction,
    current_status:v?.status||null,
    client_slug:v?.client_slug||null,
    item_id:v?.item_id||null,
    content_version:v?.content_version||null,
    destination_account:v?.instagram_username||v?.username||null,
    context:"Publisher completed its current operation. The host must invoke the target actor in the same turn when it is available and the next action is already authorized.",
    expected_output:expectedOutput,
    return_to:returnTo,
    blockers:[]
  }});
}
function mustConfirm(confirm:boolean){if(!confirm) throw new Error("External publication requires explicit approval. Call again with confirm=true only after the user approves exact client, @account, format, ordered assets, caption and timing.");}
function mustApprove(confirm:boolean){if(!confirm) throw new Error("Content approval requires explicit user approval of the exact ITEM_ID, version, destination, format, ordered assets and caption.");}

const MCP_INSTRUCTIONS=`
ONEFORALL HANDOFF PROTOCOL v1 — PUBLISHER ACTOR

Every operational response produced from this server's tools must begin with the exact Actor Header:
🚀 PUBLISH · SOCIAL PUBLISHER
Optionally follow it with ITEM_ID · ACTION. Do not use another actor's nickname. If the host is only explaining behavior and no Publisher tool actually ran, it must use ◆ ONE · SYSTEM instead.

ROLE AND SPECIALIST BOUNDARY
Publisher owns persistent assets/content items and real scheduling/publication actions. Publisher is not a creative or orchestration actor. It must never choose concepts, candidate generations, copy, CTA, hashtags, lore/canon, visual direction, replacement assets, carousel order, destination account, campaign strategy or cadence. Those belong to 🎬 CREATIVE @Oneforall Director, 🛡️ CHECK @Oneforall Auditor, 📊 SOCIAL @Oneforall Social Manager or 🧭 OPS @Oneforall Agency OS. Store and execute only the exact verified package handed to Publisher. If the package is ambiguous or incomplete, return BLOCKED; never silently repair it.

SOURCE OF TRUTH AND VERSIONING
Persist and retrieve verified state by CLIENT + ITEM_ID. Persisted Content Items, asset registry, approval receipts and publication logs outrank conversational assumptions. A Content Item binds the exact account, format, ordered asset IDs, final caption including approved hashtags, feed/cover settings, content version, approved version/hash, status, schedule/publication timestamps, platform media ID and real error. Any material change to assets, order, caption/CTA/hashtags, format or account advances the content version and invalidates stale approval. Never invent asset IDs, approvals, media IDs, copy or state.

ORDER, APPROVAL AND IDEMPOTENCY
Preserve Publish Manifest order exactly; never sort by filename, upload time, URL or UUID. Publish or schedule only when content_version equals approved_version and the approval hash is current. Before an external action retrieve and verify ITEM_ID, client, exact @account, format, asset count/order, caption, version, approval/hash and status. If already PUBLISHED, return the existing record without republishing. If already publishing and platform state is unresolved, return BLOCKED. Repeated commands must not repeat irreversible actions; retries preserve ITEM_ID and advance ATTEMPT when represented.

INDEPENDENT AUDITOR GATE
New content and every materially changed content version require a cryptographically authenticated PASS receipt from an allowed Oneforall Auditor issuer. The receipt must bind exact client, ITEM_ID, content version and current SHA-256 content fingerprint. register_audit_receipt only verifies and stores a signed receipt; it cannot mint or sign one. Missing, expired, unauthorized, replay-mismatched or stale receipts return AUDIT_REQUIRED/BLOCKED. Rows that existed before migration are explicitly grandfathered with audit_required=false so their historic status, schedule and publication evidence remain unchanged; any later material edit opts that row into the gate.

OWNER_OVERRIDE is a separate owner authorization, never an Auditor PASS. register_owner_override requires an explicit confirmation for the exact current ITEM_ID, version, content hash, destination account and action. Scheduling additionally binds the exact timestamp and timezone. Any content, order, caption, account, version or schedule change makes the override unusable. Without a matching PASS or OWNER_OVERRIDE, return AUDIT_PENDING or AUDITOR_NOT_EXECUTED and block.

RESULTS, TERMINAL STATES AND HANDOFF
Only report PUBLISHED after the platform confirms it; include ITEM_ID, version, post/platform media ID, account and published_at. Persist and return the exact error on failure. Operational work must end conceptually in exactly one of HANDOFF, USER_APPROVAL_REQUIRED, BLOCKED, DONE or DONE_AND_VERIFIED. Never use DONE_AND_VERIFIED by inference. A textual @mention is a routing request, not evidence that another plugin ran.

AUTOMATIC CONTINUATION — HARD RULE
Do not stop after reporting a successful intermediate operation when an authorized executable next step exists. Never end with only "the next step is...". Return HANDOFF with a structured target/action payload. The host/orchestrator must invoke that target in the same turn and continue until a real gate, verified terminal state or unavailable capability is reached. After exact-version approval, hand off immediately to Social Manager for slot selection and scheduling orchestration. If Social Manager has already provided an exact approved timestamp/timezone, the host should call Publisher scheduling immediately. Publisher never invents cadence or timing; it requests that decision from Social Manager and expects the real handoff chain to continue.

After confirmed publication, return a structured handoff envelope to 📊 SOCIAL @Oneforall Social Manager, or to 🧭 OPS @Oneforall Agency OS when Social Manager is UNHEALTHY/DISABLED. Include CLIENT_ID/SLUG, ITEM_ID, CONTENT_VERSION, CURRENT_STATUS=PUBLISHED, REQUESTED_ACTION, CONTEXT, EXPECTED_OUTPUT, SOURCE_PLUGIN, TARGET_PLUGIN, RETURN_TO, ATTEMPT, APPROVAL_RECEIPT, DEPENDENCIES, BLOCKERS, DESTINATION_ACCOUNT, MEDIA_ID and PUBLISHED_AT. Never claim the target executed unless it actually acknowledged the handoff. If unavailable, return BLOCKED: TARGET_PLUGIN_UNAVAILABLE and preserve the pending handoff.

Use upload_chatgpt_files for new ChatGPT attachments and register_legacy_chat_asset for historical attachments. OAuth credentials and R2 secrets stay server-side.
`.trim();

function createMcp(){
  const mcp=new McpServer({name:"Oneforall Social Publisher",version:VERSION},{capabilities:{tools:{}},instructions:MCP_INSTRUCTIONS});
  mcp.registerTool("list_clients",{description:"List Oneforall social clients.",inputSchema:z.object({})},async()=>txt(await listClients()));
  mcp.registerTool("create_client",{description:"Create or update a client workspace.",inputSchema:z.object({slug:z.string().regex(/^[a-z0-9-]+$/),name:z.string().min(1).max(120)})},async a=>txt(await createClient(a.slug,a.name)));

  mcp.registerTool("get_instagram_connect_url",{description:"Create a short-lived Instagram OAuth connection URL for one client. The user must open it and authorize Instagram. No token is exposed to ChatGPT.",inputSchema:z.object({client_slug:z.string(),is_default:z.boolean().default(false)})},async a=>txt(await createInstagramConnectUrl(a.client_slug,a.is_default)));
  mcp.registerTool("list_instagram_accounts",{description:"List connected Instagram accounts, optionally for one client. Use before choosing a publishing destination.",inputSchema:z.object({client_slug:z.string().optional()})},async a=>txt(await listAccounts(a.client_slug)));
  mcp.registerTool("configure_instagram_account",{description:"Administrative fallback for manually storing or rotating an Instagram token. Prefer get_instagram_connect_url for normal onboarding.",inputSchema:z.object({client_slug:z.string(),instagram_user_id:z.string(),username:z.string(),account_type:z.string().optional(),access_token:z.string().min(10),token_expires_at:z.string().optional(),is_default:z.boolean().default(false)})},async a=>txt(await upsertInstagramAccount({clientSlug:a.client_slug,instagramUserId:a.instagram_user_id,username:a.username,accountType:a.account_type,accessToken:a.access_token,tokenExpiresAt:a.token_expires_at,isDefault:a.is_default})));
  mcp.registerTool("verify_instagram_account",{description:"Verify an account against Instagram and return current profile metadata.",inputSchema:z.object({account_id:z.string().uuid().optional(),client_slug:z.string().optional()}).refine(v=>v.account_id||v.client_slug,"account_id or client_slug required")},async a=>{const ac=a.account_id?await getAccount(a.account_id):await getDefaultAccount(a.client_slug!);return txt({configured:{id:ac.id,client:ac.client_slug,username:ac.username},instagram:await getProfile(ac.credentials)});});
  mcp.registerTool("refresh_instagram_token",{description:"Refresh one OAuth-connected Instagram long-lived token without exposing it.",inputSchema:z.object({account_id:z.string().uuid()})},async a=>txt(await refreshInstagramAccountToken(a.account_id)));

  mcp.registerTool("create_asset_upload",{description:"Create a 15-minute presigned R2 upload URL for an image or video. Use this when a caller can PUT bytes directly. After upload, call finalize_asset_upload.",inputSchema:z.object({client_slug:z.string(),kind:z.enum(['image','video']),filename:z.string().min(1).max(255),mime_type:z.string().min(3).max(120),label:z.string().max(180).optional(),size_bytes:z.number().int().positive().optional()})},async a=>txt(await createAssetUpload({clientSlug:a.client_slug,kind:a.kind,filename:a.filename,mimeType:a.mime_type,label:a.label,sizeBytes:a.size_bytes})));
  mcp.registerTool("finalize_asset_upload",{description:"Verify an R2 object uploaded with create_asset_upload and register it in the client's asset library.",inputSchema:z.object({client_slug:z.string(),storage_key:z.string().min(1),kind:z.enum(['image','video']),mime_type:z.string().min(3).max(120),label:z.string().max(180).optional()})},async a=>txt(await finalizeAssetUpload({clientSlug:a.client_slug,storageKey:a.storage_key,kind:a.kind,mimeType:a.mime_type,label:a.label})));
  mcp.registerTool("import_asset_from_url",{description:"Fetch an HTTPS image/video URL server-side, copy it into Oneforall R2, and register it as a client asset. Useful for generated or externally hosted media that has a retrievable URL.",inputSchema:z.object({client_slug:z.string(),kind:z.enum(['image','video']),source_url:z.url(),filename:z.string().max(255).optional(),label:z.string().max(180).optional(),max_bytes:z.number().int().positive().max(500_000_000).optional()})},async a=>txt(await importAssetFromUrl({clientSlug:a.client_slug,kind:a.kind,sourceUrl:a.source_url,filename:a.filename,label:a.label,maxBytes:a.max_bytes})));
  const chatGPTFile=z.object({download_url:z.url(),file_id:z.string().min(1),mime_type:z.string().optional(),file_name:z.string().optional()}).strict();
  mcp.registerTool("upload_chatgpt_files",{description:"Upload 1 to 10 files attached in ChatGPT directly to Oneforall R2 from the server, preserving input order. Prefer this for ChatGPT attachments and carousel media; no client-side presigned PUT is required.",inputSchema:z.object({client_slug:z.string(),kind:z.enum(['image','video']),files:z.array(chatGPTFile).min(1).max(10),labels:z.array(z.string().max(180)).min(1).max(10).optional(),max_bytes:z.number().int().positive().max(500_000_000).optional()}),_meta:{"openai/fileParams":["files"]}},async a=>txt(await uploadChatGPTFiles({clientSlug:a.client_slug,kind:a.kind,files:a.files,labels:a.labels,maxBytes:a.max_bytes})));
  mcp.registerTool("register_legacy_chat_asset",{description:"Migrate one historical ChatGPT attachment into permanent R2 storage and associate it idempotently with a legacy ITEM_ID and 1-based slide position. Returns the permanent asset_id; repeat for S1-S7 in order before building an Auditor Publish Manifest.",inputSchema:z.object({client_slug:z.string(),item_id:z.string().min(1).max(180),slide_position:z.number().int().min(1).max(10),file_reference:chatGPTFile,kind:z.enum(['image','video']).default('image'),label:z.string().max(180).optional(),max_bytes:z.number().int().positive().max(500_000_000).optional()}),_meta:{"openai/fileParams":["file_reference"]}},async a=>txt(await registerLegacyChatAsset({clientSlug:a.client_slug,itemId:a.item_id,slidePosition:a.slide_position,fileReference:a.file_reference,kind:a.kind,label:a.label,maxBytes:a.max_bytes})));
  mcp.registerTool("register_asset",{description:"Register an already-public HTTPS image/video URL without copying it to R2.",inputSchema:z.object({client_slug:z.string(),kind:z.enum(['image','video']),public_url:z.url(),label:z.string().max(180).optional(),mime_type:z.string().max(120).optional()})},async a=>txt(await registerAsset(a.client_slug,a.kind,a.public_url,a.label,a.mime_type)));
  mcp.registerTool("list_assets",{description:"List recent registered assets for a client.",inputSchema:z.object({client_slug:z.string(),limit:z.number().int().min(1).max(100).default(50)})},async a=>txt(await listAssets(a.client_slug,a.limit)));

  const contentInput=z.object({client_slug:z.string(),item_id:z.string().min(1).max(180),account_id:z.string().uuid(),format:z.enum(['image','carousel','reel']),caption:z.string().max(2200).optional(),asset_ids:z.array(z.string().uuid()).min(1).max(10),share_to_feed:z.boolean().default(true),cover_url:z.url().optional()});
  mcp.registerTool("save_content_item",{description:"Create or update the persistent source of truth for one ITEM_ID: exact client/account, format, ordered assets and copy. Changes increment content_version and invalidate prior approval. This does not publish.",inputSchema:contentInput},async a=>txt(await saveContentItem({clientSlug:a.client_slug,itemId:a.item_id,accountId:a.account_id,format:a.format,caption:a.caption,assetIds:a.asset_ids,shareToFeed:a.share_to_feed,coverUrl:a.cover_url})));
  mcp.registerTool("create_post_draft",{description:"Compatibility alias for save_content_item. ITEM_ID is mandatory and the complete draft is persisted as one versioned content unit. This does not publish.",inputSchema:contentInput},async a=>txt(await saveContentItem({clientSlug:a.client_slug,itemId:a.item_id,accountId:a.account_id,format:a.format,caption:a.caption,assetIds:a.asset_ids,shareToFeed:a.share_to_feed,coverUrl:a.cover_url})));
  mcp.registerTool("get_content_item",{description:"Retrieve one ITEM_ID with exact copy, client/account, format, ordered assets, version, approval and publication state. client_slug may be omitted only when ITEM_ID is globally unambiguous.",inputSchema:z.object({item_id:z.string().min(1).max(180),client_slug:z.string().optional()})},async a=>txt(await getContentItem(a.item_id,a.client_slug)));
  mcp.registerTool("update_content_item_caption",{description:"Replace the complete caption/copy for an ITEM_ID. Increments its version and invalidates approval; fetch the existing copy first when making a targeted CTA edit.",inputSchema:z.object({item_id:z.string().min(1).max(180),client_slug:z.string().optional(),caption:z.string().max(2200)})},async a=>txt(await updateContentItemCaption({itemId:a.item_id,clientSlug:a.client_slug,caption:a.caption})));
  const auditReceiptPayload=z.object({audit_id:z.string().min(8).max(180),issuer:z.string().min(1).max(180),auditor_identity:z.string().min(1).max(240),verdict:z.literal('PASS'),client_id:z.string().uuid(),item_id:z.string().min(1).max(180),content_version:z.number().int().positive(),content_hash:z.string().regex(/^[0-9a-f]{64}$/i),audited_at:z.string().datetime({offset:true})}).strict();
  mcp.registerTool("register_audit_receipt",{description:"Verify and persist an independently signed Oneforall Auditor PASS receipt. The HMAC secret and issuer allowlist remain server-side; this tool cannot generate a valid signature. The receipt must match the current immutable content fingerprint exactly.",inputSchema:z.object({receipt:auditReceiptPayload,signature:z.string().regex(/^v1=[0-9a-f]{64}$/i)})},async a=>txt(await registerAuditReceipt({payload:a.receipt,signature:a.signature})));
  mcp.registerTool("register_owner_override",{description:"Persist an explicit OWNER_OVERRIDE as an independent authorization route for one exact current payload. This never creates or impersonates an Auditor PASS. Before confirm=true, show the owner the complete ITEM_ID, version, account, format, ordered assets, caption, content hash and action; schedules also require the exact timestamp/timezone. Any material change invalidates this authorization.",inputSchema:z.object({item_id:z.string().min(1).max(180),client_slug:z.string().optional(),expected_version:z.number().int().positive(),expected_content_hash:z.string().regex(/^[0-9a-f]{64}$/i),account_id:z.string().uuid(),owner_identity:z.string().min(1).max(180),action:z.enum(['publish_now','schedule']),scheduled_at:z.string().datetime({offset:true}).optional(),time_zone:z.string().max(80).optional(),confirm:z.boolean().default(false)}).superRefine((v,ctx)=>{if(v.action==='schedule'&&!v.scheduled_at)ctx.addIssue({code:'custom',message:'scheduled_at is required for schedule'});if(v.action==='publish_now'&&v.scheduled_at)ctx.addIssue({code:'custom',message:'scheduled_at is only valid for schedule'});})},async a=>{mustConfirm(a.confirm);return txt(await registerOwnerOverride({itemId:a.item_id,clientSlug:a.client_slug,expectedVersion:a.expected_version,expectedContentHash:a.expected_content_hash,accountId:a.account_id,ownerIdentity:a.owner_identity,action:a.action,scheduledAt:a.scheduled_at,scheduledTimezone:a.time_zone}));});
  mcp.registerTool("approve_content_item",{description:"Approve one exact persisted content version after showing its complete summary. New or materially changed content requires either a matching authenticated Auditor PASS receipt or a valid exact OWNER_OVERRIDE. Approval binds ITEM_ID, client/account, format, ordered asset IDs and copy by hash. Any later change invalidates it. On success this returns a real HANDOFF to Social Manager for automatic slot selection and scheduling orchestration; the host must continue that handoff in the same turn instead of merely announcing the next step.",inputSchema:z.object({item_id:z.string().min(1).max(180),client_slug:z.string().optional(),expected_version:z.number().int().positive(),approved_by:z.string().max(120).optional(),confirm:z.boolean().default(false)})},async a=>{mustApprove(a.confirm);return handoff(await approveContentItem({itemId:a.item_id,clientSlug:a.client_slug,expectedVersion:a.expected_version,approvedBy:a.approved_by}),"PLACE_IN_CALENDAR_AND_SCHEDULE","Select the first valid slot under the persisted cadence/format rules, then return an exact offset-aware timestamp and timezone for Publisher scheduling.");});
  mcp.registerTool("list_content_items",{description:"List persistent ITEM_ID records. Use readiness=approved_unpublished for content that is ready but has not been published.",inputSchema:z.object({client_slug:z.string().optional(),readiness:z.enum(['all','approved_unpublished','unapproved','published']).default('all'),limit:z.number().int().min(1).max(100).default(50)})},async a=>txt(await listContentItems({clientSlug:a.client_slug,readiness:a.readiness,limit:a.limit})));
  mcp.registerTool("get_post",{description:"Get a post with destination account and ordered assets. Use this to prepare the approval summary.",inputSchema:z.object({post_id:z.string().uuid()})},async a=>txt(await getPost(a.post_id)));
  mcp.registerTool("publish_post_now",{description:"Idempotently publish an existing approved post. First inspect persisted state. If already PUBLISHED, returns the existing platform result without republishing and does not require a new confirmation. External side effect only for unpublished content; confirm=true requires exact approval of client, @account, format, ordered assets, caption and version.",inputSchema:z.object({post_id:z.string().uuid(),confirm:z.boolean().default(false)})},async a=>{const post=await getPost(a.post_id);if(post.status!=='published') mustConfirm(a.confirm);return txt(await publishPost(a.post_id));});
  mcp.registerTool("publish_content_item_now",{description:"Idempotently publish the approved current version of an ITEM_ID. First call get_content_item and show exact persisted client, @account, format, ordered assets/count, caption, version, approval and status. If already PUBLISHED, returns the existing result without republishing or requiring a new confirmation. External side effect only for unpublished content.",inputSchema:z.object({item_id:z.string().min(1).max(180),client_slug:z.string().optional(),expected_version:z.number().int().positive(),confirm:z.boolean().default(false)})},async a=>{const item=await getContentItem(a.item_id,a.client_slug);if(item.content_version!==a.expected_version) throw new Error(`Version mismatch: expected ${a.expected_version}, current ${item.content_version}`);if(item.status!=='published') mustConfirm(a.confirm);return txt(await publishPost(item.id));});
  mcp.registerTool("schedule_post",{description:"Persist, approve and schedule a complete ITEM_ID payload after explicit approval of destination, ordered assets, caption, exact offset-aware timestamp and timezone when available. Any later content change invalidates approval.",inputSchema:contentInput.extend({scheduled_at:z.string().datetime({offset:true}),time_zone:z.string().max(80).optional(),approved_by:z.string().max(120).optional(),confirm:z.boolean().default(false)})},async a=>{mustConfirm(a.confirm);const item=await saveContentItem({clientSlug:a.client_slug,itemId:a.item_id,accountId:a.account_id,format:a.format,caption:a.caption,assetIds:a.asset_ids,shareToFeed:a.share_to_feed,coverUrl:a.cover_url});await approveContentItem({itemId:a.item_id,clientSlug:a.client_slug,expectedVersion:item.content_version,approvedBy:a.approved_by});return txt(await scheduleExistingPost(item.id,a.scheduled_at,a.time_zone));});
  mcp.registerTool("schedule_content_item",{description:"Schedule the current approved ITEM_ID version. External future side effect; first inspect the item and confirm exact version, destination, content, offset-aware timestamp and timezone when available. On success, return a HANDOFF for ledger/calendar reconciliation and continue it in the same turn when Social Manager is available.",inputSchema:z.object({item_id:z.string().min(1).max(180),client_slug:z.string().optional(),expected_version:z.number().int().positive(),scheduled_at:z.string().datetime({offset:true}),time_zone:z.string().max(80).optional(),confirm:z.boolean().default(false)})},async a=>{mustConfirm(a.confirm);const item=await getContentItem(a.item_id,a.client_slug);if(item.content_version!==a.expected_version) throw new Error(`Version mismatch: expected ${a.expected_version}, current ${item.content_version}`);return handoff({...await scheduleExistingPost(item.id,a.scheduled_at,a.time_zone),client_slug:item.client_slug,item_id:item.item_id,content_version:item.content_version,instagram_username:item.instagram_username},"RECONCILE_SCHEDULED_STATE","Persist Publisher schedule evidence in the Social Manager ledger and synchronize the mapped editorial calendar if available.","DONE");});
  mcp.registerTool("schedule_existing_post",{description:"Schedule an existing draft/failed post. External future side effect. confirm=true only after explicit approval of exact destination, ordered assets, caption, offset-aware timestamp and timezone when available.",inputSchema:z.object({post_id:z.string().uuid(),scheduled_at:z.string().datetime({offset:true}),time_zone:z.string().max(80).optional(),confirm:z.boolean().default(false)})},async a=>{mustConfirm(a.confirm);return txt(await scheduleExistingPost(a.post_id,a.scheduled_at,a.time_zone));});
  mcp.registerTool("list_scheduled_posts",{description:"List scheduled posts, optionally filtered by client.",inputSchema:z.object({client_slug:z.string().optional(),limit:z.number().int().min(1).max(100).default(50)})},async a=>txt(await listScheduled(a.client_slug,a.limit)));
  mcp.registerTool("cancel_scheduled_post",{description:"Cancel a draft or scheduled post before publication. Requires explicit confirmation because it changes persisted execution state.",inputSchema:z.object({post_id:z.string().uuid(),confirm:z.boolean().default(false)})},async a=>{mustConfirm(a.confirm);return txt(await cancelScheduled(a.post_id));});
  mcp.registerTool("get_publish_logs",{description:"Get audit logs for a post.",inputSchema:z.object({post_id:z.string().uuid(),limit:z.number().int().min(1).max(200).default(100)})},async a=>txt(await listPublishLogs(a.post_id,a.limit)));
  return mcp;
}

const port=Number(process.env.PORT||8787);
const http=createServer(async(req,res)=>{
  const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(u.pathname==='/live'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,service:'oneforall-social-publisher',version:VERSION}));return;}
  if(u.pathname==='/health'||u.pathname==='/ready'){
    const database=await checkDatabaseReady();
    res.writeHead(database.ok?200:503,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ok:database.ok,service:'oneforall-social-publisher',version:VERSION,database,features:FEATURES}));
    return;
  }
  if(u.pathname==='/oauth/instagram/callback' && req.method==='GET'){
    try{
      const code=u.searchParams.get('code'); const state=u.searchParams.get('state'); const error=u.searchParams.get('error');
      if(error) throw new Error(u.searchParams.get('error_description')||error);
      if(!code||!state) throw new Error('Missing code or state');
      const result=await completeInstagramOAuth(code,state);
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(`<!doctype html><meta charset="utf-8"><title>Instagram connected</title><style>body{font-family:system-ui;background:#0b0b0c;color:#fff;display:grid;place-items:center;height:100vh;margin:0}.c{max-width:560px;padding:40px;border:1px solid #2b2b31;border-radius:24px;background:#151518}h1{font-size:28px}p{color:#b9b9c2}</style><div class="c"><h1>Instagram connected ✓</h1><p>@${String(result.account.username).replace(/[<>&]/g,'')} is now connected to ${String(result.client.name).replace(/[<>&]/g,'')}.</p><p>You can close this window and return to ChatGPT.</p></div>`);return;
    }catch(e:any){res.writeHead(400,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(`<h1>Instagram connection failed</h1><p>${String(e.message).replace(/[<>&]/g,'')}</p>`);return;}
  }
  if(u.pathname!=='/mcp'){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'not_found'}));return;}
  if(req.method==='OPTIONS'){
    res.writeHead(204,{
      'access-control-allow-origin':'*',
      'access-control-allow-methods':'POST, GET, DELETE, OPTIONS',
      'access-control-allow-headers':'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
      'access-control-expose-headers':'mcp-session-id',
      'access-control-max-age':'86400'
    });
    res.end();
    return;
  }
  const mcpMethods=new Set(['POST','GET','DELETE']);
  if(!req.method||!mcpMethods.has(req.method)){res.writeHead(405,{'content-type':'application/json',allow:'POST, GET, DELETE, OPTIONS'});res.end(JSON.stringify({error:'method_not_allowed'}));return;}
  res.setHeader('access-control-allow-origin','*');
  res.setHeader('access-control-expose-headers','mcp-session-id');
  res.setHeader('cache-control','no-cache, no-transform');
  res.setHeader('x-accel-buffering','no');
  const mcp=createMcp(); const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on('close',()=>{transport.close().catch(()=>undefined);mcp.close().catch(()=>undefined);});
  await mcp.connect(transport); await transport.handleRequest(req,res);
});

startScheduler();
const refreshMs=Number(process.env.TOKEN_REFRESH_INTERVAL_MS||43_200_000);
const tokenTimer=setInterval(()=>void refreshExpiringOAuthTokens(Number(process.env.TOKEN_REFRESH_BEFORE_DAYS||10)).then(r=>{if(r.length) console.log('OAuth token refresh pass',r);}).catch(e=>console.error('OAuth token refresh pass failed',e)),refreshMs);
tokenTimer.unref();
const watchdogMs=Number(process.env.DB_WATCHDOG_INTERVAL_MS||30_000);
const watchdogFailureLimit=Number(process.env.DB_WATCHDOG_FAILURE_LIMIT||6);
let shuttingDown=false;
async function shutdown(exitCode:number,reason:string){
  if(shuttingDown) return;
  shuttingDown=true;
  console.log(`Shutting down (${reason})`);
  clearInterval(tokenTimer);
  watchdog.stop();
  await stopScheduler();
  await new Promise<void>(resolve=>http.close(()=>resolve()));
  await pool.end().catch(error=>console.error('Database pool shutdown failed',error));
  process.exit(exitCode);
}
const watchdog=createWatchdog({
  check:()=>checkDatabaseReady(),
  failureLimit:watchdogFailureLimit,
  onRecovered:failures=>console.log(`PostgreSQL readiness recovered after ${failures} failed checks`),
  onFailure:(failures,error)=>console.error(`PostgreSQL readiness failed (${failures}/${watchdogFailureLimit})`,error),
  onFailureLimit:()=>{console.error('PostgreSQL remained unavailable; requesting a coordinated container restart');void shutdown(1,'database-watchdog');}
});
watchdog.start(watchdogMs);
http.listen(port,'0.0.0.0',()=>console.log(`Oneforall Social Publisher ${VERSION} listening on :${port}`));
process.on('SIGTERM',()=>void shutdown(0,'SIGTERM'));
process.on('SIGINT',()=>void shutdown(0,'SIGINT'));
