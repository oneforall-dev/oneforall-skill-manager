import test from "node:test";
import assert from "node:assert/strict";
import { createWatchdog } from "../../dist/watchdog.js";
import { publicationIdempotencyKey, publishErrorDisposition, sanitizedError } from "../../dist/publication-safety.js";

test("publication key is stable and destination/version bound",()=>{
  const post={id:"post",content_version:1,instagram_account_id:"account-a"};
  assert.equal(publicationIdempotencyKey(post),publicationIdempotencyKey({...post}));
  assert.notEqual(publicationIdempotencyKey(post),publicationIdempotencyKey({...post,content_version:2}));
  assert.notEqual(publicationIdempotencyKey(post),publicationIdempotencyKey({...post,instagram_account_id:"account-b"}));
});

test("unknown platform outcomes are never classified as safe retries",()=>{
  assert.equal(publishErrorDisposition({publicationOutcome:"unknown"}),"unknown_outcome");
  assert.equal(publishErrorDisposition(new Error("validation")),"safe_failure");
  assert.doesNotMatch(sanitizedError(new Error("access_token=secret-value")),/secret-value/);
});

test("watchdog triggers once and resets after recovery",async()=>{
  const results=[{ok:false,error:"down"},{ok:true},{ok:false,error:"down"},{ok:false,error:"down"}];
  let triggered=0;let recovered=0;
  const watchdog=createWatchdog({check:async()=>results.shift()||{ok:true},failureLimit:2,onRecovered:n=>{recovered=n;},onFailureLimit:()=>{triggered++;}});
  await watchdog.probe();
  await watchdog.probe();
  assert.equal(recovered,1);
  await watchdog.probe();
  await watchdog.probe();
  await watchdog.probe();
  assert.equal(triggered,1);
  assert.equal(watchdog.getState().consecutiveFailures,2);
});

