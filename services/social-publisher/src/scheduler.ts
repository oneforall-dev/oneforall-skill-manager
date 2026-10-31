import { pool } from "./db.js";
import { publishPost } from "./publisher.js";
import { runSchedulerPass } from "./scheduler-core.js";
export { runSchedulerPass } from "./scheduler-core.js";

let timer:NodeJS.Timeout|undefined;
let running=false;
let activeTick:Promise<void>|undefined;

async function claimDuePost():Promise<string|null>{
  const q=await pool.query(`SELECT id FROM posts WHERE status='scheduled' AND scheduled_at<=now() ORDER BY scheduled_at ASC LIMIT 1`);
  return q.rows[0]?.id||null;
}

const schedulerDependencies={claim:claimDuePost,publish:publishPost,onError:async(id:string,error:unknown)=>{
  const message=String((error as any)?.message||error);
  const reconciliationBlocked=message.startsWith('BLOCKED_PENDING_RECONCILIATION');
  const policyBlocked=message.startsWith('AUDIT_')||message.startsWith('AUDITOR_');
  const blocked=reconciliationBlocked||policyBlocked;
  await pool.query(`INSERT INTO publish_logs(post_id,instagram_account_id,event,detail) SELECT id,instagram_account_id,$2,$3::jsonb FROM posts WHERE id=$1`,[id,blocked?'blocked':'failed',JSON.stringify({error:message,source:'scheduler-preflight'})]).catch(()=>undefined);
  if(!reconciliationBlocked) await pool.query(`UPDATE posts SET status='failed',last_error=$2,updated_at=now() WHERE id=$1 AND status IN ('scheduled','publishing')`,[id,message]).catch(()=>undefined);
  console.error('scheduled publish blocked',id,message);
}};

async function tick(){
  if(running) return;
  running=true;
  activeTick=runSchedulerPass(schedulerDependencies);
  try{await activeTick;}finally{activeTick=undefined;running=false;}
}
export function startScheduler(){ const ms=Number(process.env.SCHEDULER_INTERVAL_MS||30000); if(!Number.isFinite(ms)||ms<1000) throw new Error('SCHEDULER_INTERVAL_MS must be at least 1000'); timer=setInterval(()=>void tick(),ms);timer.unref();void tick();console.log(`Scheduler enabled every ${ms}ms`); }
export async function stopScheduler(){ if(timer) clearInterval(timer);timer=undefined;await activeTick?.catch(()=>undefined); }
