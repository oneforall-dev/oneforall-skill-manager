import { createHash, randomBytes } from "node:crypto";
import { pool, withTx } from "./db.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { getProfile, type IgCredentials } from "./instagram.js";

const authBase=()=>process.env.INSTAGRAM_OAUTH_AUTHORIZE_URL || "https://www.instagram.com/oauth/authorize";
const tokenUrl=()=>process.env.INSTAGRAM_OAUTH_TOKEN_URL || "https://api.instagram.com/oauth/access_token";
const longTokenUrl=()=>process.env.INSTAGRAM_LONG_TOKEN_URL || "https://graph.instagram.com/access_token";
const refreshUrl=()=>process.env.INSTAGRAM_REFRESH_TOKEN_URL || "https://graph.instagram.com/refresh_access_token";
function appId(){const v=process.env.INSTAGRAM_APP_ID;if(!v) throw new Error("INSTAGRAM_APP_ID is required");return v;}
function appSecret(){const v=process.env.INSTAGRAM_APP_SECRET;if(!v) throw new Error("INSTAGRAM_APP_SECRET is required");return v;}
function redirectUri(){const v=process.env.INSTAGRAM_REDIRECT_URI;if(!v) throw new Error("INSTAGRAM_REDIRECT_URI is required");return v;}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');

export async function createInstagramConnectUrl(clientSlug:string,isDefault=false){
  const c=await pool.query(`SELECT id,slug,name FROM clients WHERE slug=$1 AND status='active'`,[clientSlug]);
  if(!c.rows[0]) throw new Error(`Unknown active client: ${clientSlug}`);
  const rawState=randomBytes(32).toString('base64url');
  await pool.query(`DELETE FROM instagram_oauth_states WHERE expires_at < now()`);
  await pool.query(`INSERT INTO instagram_oauth_states(state_hash,client_id,is_default,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`,[hash(rawState),c.rows[0].id,isDefault]);
  const u=new URL(authBase());
  u.searchParams.set('client_id',appId());
  u.searchParams.set('redirect_uri',redirectUri());
  u.searchParams.set('response_type','code');
  u.searchParams.set('scope','instagram_business_basic,instagram_business_content_publish');
  u.searchParams.set('state',rawState);
  u.searchParams.set('enable_fb_login','0');
  u.searchParams.set('force_authentication','1');
  return {client:c.rows[0],authorize_url:u.toString(),expires_in_seconds:600};
}

async function exchangeCode(code:string){
  const body=new URLSearchParams({client_id:appId(),client_secret:appSecret(),grant_type:'authorization_code',redirect_uri:redirectUri(),code});
  const r=await fetch(tokenUrl(),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const data=await r.json() as any;
  if(!r.ok||!data.access_token) throw new Error(data.error_message||data.error?.message||`Instagram code exchange failed (${r.status})`);
  return {shortToken:String(data.access_token),userId:String(data.user_id||'')};
}

async function exchangeLongToken(shortToken:string){
  const u=new URL(longTokenUrl());
  u.searchParams.set('grant_type','ig_exchange_token');
  u.searchParams.set('client_secret',appSecret());
  u.searchParams.set('access_token',shortToken);
  const r=await fetch(u);
  const data=await r.json() as any;
  if(!r.ok||!data.access_token) throw new Error(data.error?.message||`Instagram long-lived token exchange failed (${r.status})`);
  return {accessToken:String(data.access_token),expiresIn:Number(data.expires_in||5184000)};
}

export async function completeInstagramOAuth(code:string,state:string){
  const stateHash=hash(state);
  const saved=await withTx(async c=>{
    const q=await c.query(`DELETE FROM instagram_oauth_states s USING clients c WHERE s.state_hash=$1 AND s.client_id=c.id AND s.expires_at>now() RETURNING s.client_id,s.is_default,c.slug,c.name`,[stateHash]);
    if(!q.rows[0]) throw new Error("OAuth state is invalid, expired, or already used");
    return q.rows[0];
  });
  const short=await exchangeCode(code.replace(/#_$/,''));
  const long=await exchangeLongToken(short.shortToken);
  if(!short.userId) throw new Error("Instagram did not return a user_id");
  const creds:IgCredentials={instagramUserId:short.userId,accessToken:long.accessToken};
  const profile=await getProfile(creds);
  const expiresAt=new Date(Date.now()+long.expiresIn*1000).toISOString();
  const enc=encryptSecret(long.accessToken);
  return withTx(async c=>{
    if(saved.is_default) await c.query(`UPDATE instagram_accounts SET is_default=false WHERE client_id=$1`,[saved.client_id]);
    const q=await c.query(`INSERT INTO instagram_accounts(client_id,instagram_user_id,username,account_type,access_token_enc,token_expires_at,is_default,status,connection_method,last_token_refresh_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active','oauth',now())
      ON CONFLICT(client_id,instagram_user_id) DO UPDATE SET username=EXCLUDED.username,account_type=EXCLUDED.account_type,access_token_enc=EXCLUDED.access_token_enc,token_expires_at=EXCLUDED.token_expires_at,is_default=EXCLUDED.is_default,status='active',connection_method='oauth',last_token_refresh_at=now(),updated_at=now()
      RETURNING id,instagram_user_id,username,account_type,token_expires_at,is_default,status`,[saved.client_id,profile.id,profile.username||profile.id,profile.account_type||null,enc,expiresAt,saved.is_default]);
    return {client:{slug:saved.slug,name:saved.name},account:q.rows[0]};
  });
}

export async function refreshInstagramAccountToken(accountId:string){
  const q=await pool.query(`SELECT id,instagram_user_id,access_token_enc,connection_method FROM instagram_accounts WHERE id=$1 AND status='active'`,[accountId]);
  if(!q.rows[0]) throw new Error("Instagram account not found");
  if(q.rows[0].connection_method!=='oauth') throw new Error("Automatic refresh is available only for OAuth-connected accounts");
  const oldToken=decryptSecret(q.rows[0].access_token_enc);
  const u=new URL(refreshUrl());
  u.searchParams.set('grant_type','ig_refresh_token');
  u.searchParams.set('access_token',oldToken);
  const r=await fetch(u);
  const data=await r.json() as any;
  if(!r.ok||!data.access_token) throw new Error(data.error?.message||`Instagram token refresh failed (${r.status})`);
  const expiresIn=Number(data.expires_in||5184000);
  const expiresAt=new Date(Date.now()+expiresIn*1000).toISOString();
  await pool.query(`UPDATE instagram_accounts SET access_token_enc=$2,token_expires_at=$3,last_token_refresh_at=now(),updated_at=now() WHERE id=$1`,[accountId,encryptSecret(String(data.access_token)),expiresAt]);
  return {account_id:accountId,token_expires_at:expiresAt};
}

export async function refreshExpiringOAuthTokens(days=10){
  const q=await pool.query(`SELECT id FROM instagram_accounts WHERE status='active' AND connection_method='oauth' AND token_expires_at IS NOT NULL AND token_expires_at < now()+($1::text||' days')::interval AND (last_token_refresh_at IS NULL OR last_token_refresh_at < now()-interval '1 day')`,[days]);
  const results=[] as any[];
  for(const row of q.rows){try{results.push({ok:true,...await refreshInstagramAccountToken(row.id)});}catch(e:any){results.push({ok:false,account_id:row.id,error:e.message});}}
  return results;
}
