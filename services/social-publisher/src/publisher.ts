import { pool } from "./db.js";
import { assertCurrentPublicationAuthorization, claimPublishOperation, getAccount, getPost, hashPostContent, logPublish, markPublishFailed, markPublishPending, markPublishSucceeded, markPublishUnknown } from "./repository.js";
import { publishCarousel, publishImage, publishReel, publishStory } from "./instagram.js";
import { ensureInstagramImageAsset } from "./storage.js";
import { publishErrorDisposition, sanitizedError } from "./publication-safety.js";

async function attemptFor(postId:string){
  const q=await pool.query(`SELECT COALESCE(max(attempt),0)::int AS n FROM publish_operations WHERE post_id=$1`,[postId]);
  return Math.max(1,Number(q.rows[0]?.n||0));
}

async function publishedResult(post:any,idempotent:boolean){
  const handoff={
    actor_nick:'🚀 PUBLISH',actor_role:'SOCIAL PUBLISHER',source_plugin:'@Oneforall Social Publisher',
    target_nick:'📊 SOCIAL',target_plugin:'@Oneforall Social Manager',
    fallback_nick:'🧭 OPS',fallback_plugin:'@Oneforall Agency OS',
    client_id:post.client_id,client_slug:post.client_slug,item_id:post.item_id,
    content_version:post.content_version,current_status:'PUBLISHED',requested_action:'POST_PUBLISH_SYNC',
    context:{destination_account:`@${post.instagram_username}`,media_id:post.instagram_media_id,published_at:post.published_at},
    expected_output:'Update the persistent social ledger and post-publication monitoring state.',
    return_to:'@Oneforall Social Publisher',attempt:await attemptFor(post.id),
    approval_receipt:{approved_version:post.approved_version,approval_hash:post.approved_content_hash,approved_at:post.approved_at,approved_by:post.approved_by},
    dependencies:[],blockers:[],destination_account:`@${post.instagram_username}`,
    media_id:post.instagram_media_id,published_at:post.published_at,execution_status:'PENDING'
  };
  return {workflow_outcome:'HANDOFF',status:'PUBLISHED',idempotent,item_id:post.item_id,version:post.content_version,post_id:post.id,platform_media_id:post.instagram_media_id,published_at:post.published_at,account:`@${post.instagram_username}`,handoff};
}

export async function publishPost(postId:string) {
  const post=await getPost(postId);
  if(post.status==='published') return publishedResult(post,true);
  if(post.status==='publishing') throw new Error(`BLOCKED_PENDING_RECONCILIATION: ${post.item_id||postId} is already publishing; verify platform state before retrying`);
  if(!['draft','scheduled','failed'].includes(post.status)) throw new Error(`Post status ${post.status} cannot be published`);
  if(post.approval_required){
    if(!post.item_id) throw new Error("ITEM_ID is required before this content can be published");
    if(!post.approved_at || post.approved_version!==post.content_version) throw new Error(`Content ${post.item_id} version ${post.content_version} is not approved`);
    if(post.approved_content_hash!==hashPostContent(post)) throw new Error(`Approved snapshot mismatch for ${post.item_id}; review and approve the current version again`);
  }
  const action=post.status==='scheduled'?'schedule':'publish_now';
  await assertCurrentPublicationAuthorization(post,action,post.scheduled_at||undefined,post.scheduled_timezone||undefined);
  const account=await getAccount(post.instagram_account_id);
  const claim=await claimPublishOperation(post);
  if(claim.state==='published') return publishedResult(await getPost(postId),true);
  const operationId=claim.operation.id as string;
  await logPublish(postId,account.id,'publishing',{format:post.format,trial_reel:post.trial_reel,trial_graduation_strategy:post.trial_graduation_strategy,username:account.username,operation_id:operationId,idempotency_key:claim.idempotency_key,attempt:claim.operation.attempt});
  let mediaId:string|undefined;
  try {
    let result:{id:string};
    const storyKind=post.format==='story'?post.assets[0]?.kind:undefined;
    const usesVideo=post.format==='reel'||(post.format==='story'&&storyKind==='video');
    const assets=usesVideo?post.assets:await Promise.all(post.assets.map((asset:any)=>ensureInstagramImageAsset(asset)));
    const hooks={beforePublish:()=>markPublishPending(operationId).then(()=>undefined)};
    if(post.format==='image') result=await publishImage(account.credentials,assets[0].public_url,post.caption||undefined,hooks);
    else if(post.format==='carousel') result=await publishCarousel(account.credentials,assets.map((a:any)=>a.public_url),post.caption||undefined,hooks);
    else if(post.format==='reel') result=await publishReel(account.credentials,post.assets[0].public_url,post.caption||undefined,post.share_to_feed,post.cover_url||undefined,post.trial_reel?post.trial_graduation_strategy:undefined,hooks);
    else result=await publishStory(account.credentials,assets[0].public_url,storyKind,hooks);
    mediaId=result.id;
    const committed=await markPublishSucceeded({operationId,postId,mediaId});
    await logPublish(postId,account.id,'published',{media_id:mediaId,operation_id:operationId,idempotency_key:claim.idempotency_key}).catch(error=>console.error('published audit log write failed',postId,error));
    return publishedResult({...post,status:'published',instagram_media_id:mediaId,published_at:committed.published_at},false);
  } catch(e:any) {
    const error=sanitizedError(e);
    const disposition=mediaId?"unknown_outcome":publishErrorDisposition(e);
    if(disposition==='unknown_outcome'){
      await markPublishUnknown({operationId,postId,error,mediaId}).catch(()=>undefined);
      await logPublish(postId,account.id,'unknown',{error,operation_id:operationId,idempotency_key:claim.idempotency_key,media_id:mediaId||null}).catch(()=>undefined);
      return {workflow_outcome:'BLOCKED',status:'BLOCKED_PENDING_RECONCILIATION',item_id:post.item_id,version:post.content_version,post_id:postId,account:`@${account.username}`,operation_id:operationId,error};
    }
    await markPublishFailed({operationId,postId,error});
    await logPublish(postId,account.id,'failed',{error,operation_id:operationId,idempotency_key:claim.idempotency_key});
    return {workflow_outcome:'BLOCKED',status:'PUBLISH_FAILED',item_id:post.item_id,version:post.content_version,post_id:postId,account:`@${account.username}`,operation_id:operationId,error};
  }
}
