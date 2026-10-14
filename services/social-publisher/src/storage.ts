import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type DeleteObjectCommandInput, type HeadObjectCommandInput, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { createR2Client } from "./r2-client.js";
export { createR2Client } from "./r2-client.js";
// The dependency is installed in the production image. The local audit checkout
// can still type-check before native Sharp binaries are present.
// @ts-ignore
import sharp from "sharp";

function env(name:string){const v=process.env[name];if(!v) throw new Error(`${name} is required`);return v;}
function bucket(){return env('R2_BUCKET');}
function publicBase(){return env('R2_PUBLIC_BASE_URL').replace(/\/$/,'');}
let r2Client:S3Client|undefined;
function s3(){return r2Client||(r2Client=createR2Client());}
async function headObject(input:HeadObjectCommandInput){return s3().send(new HeadObjectCommand(input));}
async function putObject(input:PutObjectCommandInput){return s3().send(new PutObjectCommand(input));}
async function deleteObject(input:DeleteObjectCommandInput){return s3().send(new DeleteObjectCommand(input));}
function extFrom(filename:string,mime:string){
  const clean=filename.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0];
  if(clean) return clean;
  const map:Record<string,string>={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov'};
  return map[mime]||'';
}
function assertMime(kind:'image'|'video',mime:string){if(kind==='image'&&!mime.startsWith('image/')) throw new Error('Image asset requires image/* MIME type');if(kind==='video'&&!mime.startsWith('video/')) throw new Error('Video asset requires video/* MIME type');}
function assertDirectUploadMime(kind:'image'|'video',mime:string){
  assertMime(kind,mime);
  if(kind==='image'&&mime.toLowerCase()!=='image/jpeg') throw new Error('Direct Instagram image uploads must be JPEG. Use upload_chatgpt_files or import_asset_from_url to normalize PNG/WebP images automatically.');
}
async function normalizeBytes(kind:'image'|'video',bytes:Buffer,mime:string){
  if(kind==='video') return {bytes,mime};
  const normalized=await sharp(bytes).rotate().flatten({background:'#ffffff'}).jpeg({quality:95,mozjpeg:true}).toBuffer();
  return {bytes:normalized,mime:'image/jpeg'};
}
async function clientId(slug:string){const q=await pool.query(`SELECT id FROM clients WHERE slug=$1 AND status='active'`,[slug]);if(!q.rows[0]) throw new Error(`Unknown active client: ${slug}`);return q.rows[0].id;}
function urlFor(key:string){return `${publicBase()}/${key.split('/').map(encodeURIComponent).join('/')}`;}

export async function createAssetUpload(args:{clientSlug:string;kind:'image'|'video';filename:string;mimeType:string;label?:string;sizeBytes?:number}){
  assertDirectUploadMime(args.kind,args.mimeType);
  await clientId(args.clientSlug);
  const key=`clients/${args.clientSlug}/${new Date().toISOString().slice(0,10)}/${randomUUID()}${extFrom(args.filename,args.mimeType)}`;
  const expires=900;
  const uploadUrl=await getSignedUrl(s3(),new PutObjectCommand({Bucket:bucket(),Key:key,ContentType:args.mimeType}),{expiresIn:expires});
  return {storage_key:key,upload_url:uploadUrl,public_url:urlFor(key),content_type:args.mimeType,expires_in_seconds:expires,label:args.label||null,size_bytes:args.sizeBytes||null};
}

export async function finalizeAssetUpload(args:{clientSlug:string;storageKey:string;kind:'image'|'video';mimeType:string;label?:string}){
  assertDirectUploadMime(args.kind,args.mimeType);
  const cid=await clientId(args.clientSlug);
  const head=await headObject({Bucket:bucket(),Key:args.storageKey});
  const actual=head.ContentType||args.mimeType;
  assertDirectUploadMime(args.kind,actual);
  const pub=urlFor(args.storageKey);
  const q=await pool.query(`INSERT INTO assets(client_id,kind,public_url,mime_type,label,storage_provider,storage_key,size_bytes) VALUES($1,$2,$3,$4,$5,'r2',$6,$7) ON CONFLICT(storage_provider,storage_key) WHERE storage_key IS NOT NULL DO UPDATE SET label=COALESCE(EXCLUDED.label,assets.label),mime_type=EXCLUDED.mime_type,size_bytes=EXCLUDED.size_bytes RETURNING *`,[cid,args.kind,pub,actual,args.label||null,args.storageKey,head.ContentLength||null]);
  return q.rows[0];
}

export async function importAssetFromUrl(args:{clientSlug:string;kind:'image'|'video';sourceUrl:string;filename?:string;label?:string;maxBytes?:number;mimeTypeHint?:string}){
  const cid=await clientId(args.clientSlug);
  const r=await fetch(args.sourceUrl,{redirect:'follow'});
  if(!r.ok) throw new Error(`Could not fetch source asset (${r.status})`);
  const responseMime=(r.headers.get('content-type')||'application/octet-stream').split(';')[0].trim();
  const hintedMime=(args.mimeTypeHint||'').split(';')[0].trim();
  const mime=(responseMime.startsWith('image/')||responseMime.startsWith('video/'))?responseMime:hintedMime||responseMime;
  assertMime(args.kind,mime);
  const max=args.maxBytes||100*1024*1024;
  const declared=Number(r.headers.get('content-length')||0);
  if(declared>max) throw new Error(`Asset exceeds maximum size of ${max} bytes`);
  const sourceBytes=Buffer.from(await r.arrayBuffer());
  if(sourceBytes.byteLength>max) throw new Error(`Asset exceeds maximum size of ${max} bytes`);
  const normalized=await normalizeBytes(args.kind,sourceBytes,mime);
  const bytes=normalized.bytes;
  const storedMime=normalized.mime;
  if(bytes.byteLength>max) throw new Error(`Asset exceeds maximum size of ${max} bytes`);
  const filename=args.filename||new URL(args.sourceUrl).pathname.split('/').pop()||'asset';
  const key=`clients/${args.clientSlug}/${new Date().toISOString().slice(0,10)}/${randomUUID()}${args.kind==='image'?'.jpg':extFrom(filename,storedMime)}`;
  await putObject({Bucket:bucket(),Key:key,Body:bytes,ContentType:storedMime});
  const pub=urlFor(key);
  const q=await pool.query(`INSERT INTO assets(client_id,kind,public_url,mime_type,label,storage_provider,storage_key,size_bytes) VALUES($1,$2,$3,$4,$5,'r2',$6,$7) RETURNING *`,[cid,args.kind,pub,storedMime,args.label||null,key,bytes.byteLength]);
  return q.rows[0];
}

export async function ensureInstagramImageAsset(asset:{id:string;kind:string;public_url:string;mime_type?:string|null;storage_key?:string|null}){
  if(asset.kind!=='image'||asset.mime_type==='image/jpeg') return asset;
  const response=await fetch(asset.public_url,{redirect:'follow'});
  if(!response.ok) throw new Error(`Could not fetch image asset ${asset.id} for JPEG normalization (${response.status})`);
  const source=Buffer.from(await response.arrayBuffer());
  const normalized=await normalizeBytes('image',source,(response.headers.get('content-type')||asset.mime_type||'image/*').split(';')[0]);
  const oldKey=asset.storage_key||null;
  const key=`normalized/${asset.id}/${randomUUID()}.jpg`;
  await putObject({Bucket:bucket(),Key:key,Body:normalized.bytes,ContentType:'image/jpeg'});
  const publicUrl=urlFor(key);
  await pool.query(`UPDATE assets SET public_url=$2,mime_type='image/jpeg',storage_provider='r2',storage_key=$3,size_bytes=$4 WHERE id=$1`,[asset.id,publicUrl,key,normalized.bytes.byteLength]);
  if(oldKey&&oldKey!==key) await deleteObject({Bucket:bucket(),Key:oldKey}).catch(()=>undefined);
  return {...asset,public_url:publicUrl,mime_type:'image/jpeg',storage_key:key,size_bytes:normalized.bytes.byteLength};
}

export type ChatGPTFileInput = {
  download_url:string;
  file_id:string;
  mime_type?:string;
  file_name?:string;
};

export async function uploadChatGPTFiles(args:{clientSlug:string;kind:'image'|'video';files:ChatGPTFileInput[];labels?:string[];maxBytes?:number}){
  if(args.files.length<1||args.files.length>10) throw new Error('Upload requires 1 to 10 files');
  if(args.labels&&args.labels.length!==args.files.length) throw new Error('labels must match files length');
  const assets=[];
  for(let i=0;i<args.files.length;i++){
    const file=args.files[i];
    const source=new URL(file.download_url);
    if(source.protocol!=='https:') throw new Error('ChatGPT file download URL must use HTTPS');
    const db=await pool.connect();
    let createdAsset:any;
    try{
      await db.query('BEGIN');
      await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${args.clientSlug}:chatgpt-file:${file.file_id}`]);
      const existing=await db.query(`SELECT a.* FROM chatgpt_file_assets f JOIN clients c ON c.id=f.client_id JOIN assets a ON a.id=f.asset_id WHERE c.slug=$1 AND f.source_file_id=$2`,[args.clientSlug,file.file_id]);
      if(existing.rows[0]){
        await db.query('COMMIT');
        assets.push({...existing.rows[0],position:i,source_file_id:file.file_id,already_registered:true});
        continue;
      }
      createdAsset=await importAssetFromUrl({
        clientSlug:args.clientSlug,
        kind:args.kind,
        sourceUrl:file.download_url,
        filename:file.file_name||`${file.file_id}.${args.kind==='image'?'jpg':'mp4'}`,
        label:args.labels?.[i]||file.file_name||`ChatGPT file ${i+1}`,
        maxBytes:args.maxBytes,
        mimeTypeHint:file.mime_type
      });
      await db.query(`INSERT INTO chatgpt_file_assets(client_id,source_file_id,asset_id) SELECT id,$2,$3 FROM clients WHERE slug=$1`,[args.clientSlug,file.file_id,createdAsset.id]);
      await db.query('COMMIT');
      assets.push({...createdAsset,position:i,source_file_id:file.file_id,already_registered:false});
    }catch(error){
      await db.query('ROLLBACK').catch(()=>undefined);
      if(createdAsset?.storage_key){
        await deleteObject({Bucket:bucket(),Key:createdAsset.storage_key}).catch(()=>undefined);
        await pool.query(`DELETE FROM assets WHERE id=$1`,[createdAsset.id]).catch(()=>undefined);
      }
      throw error;
    }finally{db.release();}
  }
  return {client_slug:args.clientSlug,count:assets.length,assets};
}

export async function registerLegacyChatAsset(args:{clientSlug:string;itemId:string;slidePosition:number;fileReference:ChatGPTFileInput;kind:'image'|'video';label?:string;maxBytes?:number}){
  const file=args.fileReference;
  const source=new URL(file.download_url);
  if(source.protocol!=='https:') throw new Error('Legacy ChatGPT file download URL must use HTTPS');
  const db=await pool.connect();
  let createdAsset:any;
  try{
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${args.clientSlug}:${args.itemId}:${args.slidePosition}`]);
    const existing=await db.query(`SELECT l.item_id,l.slide_position,l.source_file_id,a.* FROM legacy_chat_assets l JOIN clients c ON c.id=l.client_id JOIN assets a ON a.id=l.asset_id WHERE c.slug=$1 AND l.item_id=$2 AND l.slide_position=$3`,[args.clientSlug,args.itemId,args.slidePosition]);
    if(existing.rows[0]){
      await db.query('COMMIT');
      return {client_slug:args.clientSlug,item_id:args.itemId,slide_position:args.slidePosition,asset_id:existing.rows[0].id,source_file_id:existing.rows[0].source_file_id,asset:existing.rows[0],already_registered:true};
    }
    createdAsset=await importAssetFromUrl({
      clientSlug:args.clientSlug,
      kind:args.kind,
      sourceUrl:file.download_url,
      filename:file.file_name||`${args.itemId}-S${args.slidePosition}.${args.kind==='image'?'png':'mp4'}`,
      label:args.label||`${args.itemId}:S${args.slidePosition}`,
      maxBytes:args.maxBytes,
      mimeTypeHint:file.mime_type
    });
    await db.query(`INSERT INTO legacy_chat_assets(client_id,item_id,slide_position,source_file_id,asset_id) SELECT id,$2,$3,$4,$5 FROM clients WHERE slug=$1`,[args.clientSlug,args.itemId,args.slidePosition,file.file_id,createdAsset.id]);
    await db.query('COMMIT');
    return {client_slug:args.clientSlug,item_id:args.itemId,slide_position:args.slidePosition,asset_id:createdAsset.id,source_file_id:file.file_id,asset:createdAsset,already_registered:false};
  }catch(error){
    await db.query('ROLLBACK').catch(()=>undefined);
    if(createdAsset?.storage_key){
      await deleteObject({Bucket:bucket(),Key:createdAsset.storage_key}).catch(()=>undefined);
      await pool.query(`DELETE FROM assets WHERE id=$1`,[createdAsset.id]).catch(()=>undefined);
    }
    throw error;
  }finally{db.release();}
}
