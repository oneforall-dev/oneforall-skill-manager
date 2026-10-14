export type WatchdogState={running:boolean;stopped:boolean;consecutiveFailures:number};

export function createWatchdog(args:{
  check:()=>Promise<{ok:boolean;error?:string}>;
  failureLimit:number;
  onFailureLimit:(state:WatchdogState)=>Promise<void>|void;
  onRecovered?:(failures:number)=>void;
  onFailure?:(failures:number,error?:string)=>void;
}) {
  if(!Number.isInteger(args.failureLimit)||args.failureLimit<1) throw new Error("Watchdog failureLimit must be a positive integer");
  let state:WatchdogState={running:false,stopped:false,consecutiveFailures:0};
  let timer:NodeJS.Timeout|undefined;
  let limitTriggered=false;
  async function probe(){
    if(state.running||state.stopped||limitTriggered) return state;
    state={...state,running:true};
    try{
      const result=await args.check();
      if(result.ok){
        if(state.consecutiveFailures) args.onRecovered?.(state.consecutiveFailures);
        state={...state,consecutiveFailures:0};
      }else{
        const consecutiveFailures=state.consecutiveFailures+1;
        state={...state,consecutiveFailures};
        args.onFailure?.(consecutiveFailures,result.error);
        if(consecutiveFailures>=args.failureLimit){
          limitTriggered=true;
          await args.onFailureLimit({...state,running:false});
        }
      }
    }finally{state={...state,running:false};}
    return state;
  }
  function start(intervalMs:number){
    if(!Number.isFinite(intervalMs)||intervalMs<100) throw new Error("Watchdog interval must be at least 100ms");
    if(timer) return;
    timer=setInterval(()=>void probe(),intervalMs);
    timer.unref();
  }
  function stop(){state={...state,stopped:true};if(timer) clearInterval(timer);timer=undefined;}
  return {probe,start,stop,getState:()=>({...state})};
}

