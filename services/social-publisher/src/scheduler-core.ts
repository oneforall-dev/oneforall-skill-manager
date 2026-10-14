export async function runSchedulerPass(deps:{claim:()=>Promise<string|null>;publish:(id:string)=>Promise<any>;onError:(id:string,error:unknown)=>Promise<void>}){
  const seen=new Set<string>();
  for(let i=0;i<10;i++){
    const id=await deps.claim();
    if(!id||seen.has(id)) break;
    seen.add(id);
    try{
      const result=await deps.publish(id);
      if(result.status==='PUBLISH_FAILED'||result.status==='BLOCKED_PENDING_RECONCILIATION') console.error('scheduled publish did not complete',id,result.error||result.status);
    }catch(error){await deps.onError(id,error);}
  }
}

