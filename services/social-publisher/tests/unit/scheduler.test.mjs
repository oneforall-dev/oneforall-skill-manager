import test from "node:test";
import assert from "node:assert/strict";

const {runSchedulerPass}=await import("../../dist/scheduler-core.js");

test("scheduler processes each due post once per pass",async()=>{
  const queue=["post-1","post-2",null];const published=[];
  await runSchedulerPass({claim:async()=>queue.shift(),publish:async id=>{published.push(id);return {status:"PUBLISHED"};},onError:async()=>assert.fail("unexpected")});
  assert.deepEqual(published,["post-1","post-2"]);
});

test("scheduler does not spin on the same blocked row",async()=>{
  let claims=0;let errors=0;
  await runSchedulerPass({claim:async()=>{claims++;return "blocked-post";},publish:async()=>{throw new Error("AUDIT_REQUIRED");},onError:async()=>{errors++;}});
  assert.equal(errors,1);
  assert.equal(claims,2);
});

test("scheduler continues after onError removes a blocked row",async()=>{
  const queue=["blocked-post","next-post"];const published=[];const errors=[];
  await runSchedulerPass({
    claim:async()=>queue[0]||null,
    publish:async id=>{
      if(id==="blocked-post") throw new Error("AUDITOR_NOT_EXECUTED");
      published.push(id);
      queue.shift();
      return {status:"PUBLISHED"};
    },
    onError:async(id,error)=>{
      errors.push([id,String(error.message)]);
      queue.shift();
    }
  });
  assert.deepEqual(errors,[["blocked-post","AUDITOR_NOT_EXECUTED"]]);
  assert.deepEqual(published,["next-post"]);
});
