import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { publishImage } from "../../dist/instagram.js";

async function listen(handler){const server=createServer(handler);server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();return {server,url:`http://127.0.0.1:${address.port}`};}

test("S3Client.send performs typed PUT and HEAD operations against an R2-compatible endpoint",async t=>{
  const seen=[];
  const mock=await listen((req,res)=>{seen.push(req.method);if(req.method==="HEAD"){res.writeHead(200,{"content-type":"image/jpeg","content-length":"3","etag":"\"abc\""});res.end();return;}req.resume();req.on("end",()=>{res.writeHead(200,{etag:"\"abc\"","content-type":"application/xml"});res.end("");});});
  t.after(()=>mock.server.close());
  process.env.DATABASE_URL="postgresql://unused:unused@127.0.0.1:1/unused";process.env.R2_ACCOUNT_ID="test";process.env.R2_ACCESS_KEY_ID="key";process.env.R2_SECRET_ACCESS_KEY="secret";
  const {createR2Client}=await import("../../dist/r2-client.js");
  const client=createR2Client({endpoint:mock.url,region:"auto",forcePathStyle:true,credentials:{accessKeyId:"key",secretAccessKey:"secret"}});
  await client.send(new PutObjectCommand({Bucket:"bucket",Key:"asset.jpg",Body:Buffer.from("abc"),ContentType:"image/jpeg"}));
  const head=await client.send(new HeadObjectCommand({Bucket:"bucket",Key:"asset.jpg"}));
  assert.deepEqual(seen,["PUT","HEAD"]);
  assert.equal(head.ContentType,"image/jpeg");
  client.destroy();
});

test("Instagram mock publishes once and marks platform_pending before media_publish",async t=>{
  let publishCalls=0;let pending=false;
  const mock=await listen((req,res)=>{const url=new URL(req.url,"http://localhost");res.setHeader("content-type","application/json");if(url.pathname.endsWith("/media_publish")){publishCalls++;assert.equal(pending,true);res.end(JSON.stringify({id:"media-123"}));return;}if(req.method==="GET"){res.end(JSON.stringify({id:"container-1",status_code:"FINISHED"}));return;}res.end(JSON.stringify({id:"container-1"}));});
  t.after(()=>mock.server.close());
  process.env.META_GRAPH_BASE=mock.url;process.env.META_GRAPH_VERSION="v24.0";
  const result=await publishImage({instagramUserId:"ig-user",accessToken:"token"},"https://example.invalid/image.jpg","caption",{beforePublish:()=>{pending=true;}});
  assert.equal(result.id,"media-123");
  assert.equal(publishCalls,1);
});

test("ambiguous media_publish failures are marked unknown",async t=>{
  const mock=await listen((req,res)=>{const url=new URL(req.url,"http://localhost");res.setHeader("content-type","application/json");if(url.pathname.endsWith("/media_publish")){res.writeHead(500);res.end(JSON.stringify({error:{message:"upstream timeout"}}));return;}if(req.method==="GET"){res.end(JSON.stringify({id:"container-1",status_code:"FINISHED"}));return;}res.end(JSON.stringify({id:"container-1"}));});
  t.after(()=>mock.server.close());
  process.env.META_GRAPH_BASE=mock.url;process.env.META_GRAPH_VERSION="v24.0";
  await assert.rejects(()=>publishImage({instagramUserId:"ig-user",accessToken:"token"},"https://example.invalid/image.jpg",undefined,{beforePublish:()=>undefined}),error=>error.publicationOutcome==="unknown");
});

