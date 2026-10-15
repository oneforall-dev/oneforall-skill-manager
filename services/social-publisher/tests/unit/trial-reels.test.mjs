import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { reelContainerParams } from "../../dist/instagram.js";

process.env.DATABASE_URL="postgresql://unused:unused@127.0.0.1:1/unused";
const { contentHash }=await import("../../dist/repository.js");

const legacy={
  clientId:"00000000-0000-4000-8000-000000000001",
  accountId:"00000000-0000-4000-8000-000000000002",
  format:"reel",
  caption:"caption",
  assetIds:["00000000-0000-4000-8000-000000000003"],
  shareToFeed:true,
  coverUrl:null
};

test("serializes Meta Trial Reel parameters exactly once",()=>{
  const params=reelContainerParams("https://media.example/video.mp4","caption",false,undefined,"MANUAL");
  assert.equal(params.media_type,"REELS");
  assert.equal(params.share_to_feed,false);
  assert.equal(params.trial_params,JSON.stringify({graduation_strategy:"MANUAL"}));
});

test("ordinary Reels do not send trial_params",()=>{
  const params=reelContainerParams("https://media.example/video.mp4","caption",true);
  assert.equal(params.trial_params,undefined);
});

test("legacy non-trial content hashes remain byte-for-byte compatible",()=>{
  const before=contentHash({...legacy,trialReel:false,trialGraduationStrategy:null});
  const canonical=JSON.stringify({client_id:legacy.clientId,instagram_account_id:legacy.accountId,format:legacy.format,caption:legacy.caption,asset_ids:legacy.assetIds,share_to_feed:legacy.shareToFeed,cover_url:legacy.coverUrl});
  assert.equal(before,createHash("sha256").update(canonical).digest("hex"));
});

test("Trial Reel strategy participates in the approval hash",()=>{
  const manual=contentHash({...legacy,trialReel:true,trialGraduationStrategy:"MANUAL"});
  const automatic=contentHash({...legacy,trialReel:true,trialGraduationStrategy:"SS_PERFORMANCE"});
  assert.notEqual(manual,automatic);
});
