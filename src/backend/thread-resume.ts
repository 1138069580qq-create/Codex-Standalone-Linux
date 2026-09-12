type Rpc=(method:string,params:any)=>Promise<any>;
/** New empty threads in some app-server versions have no rollout backing paginated history.
 * Retry only this explicit pre-turn rejection, never a submitted model turn or uncertain write. */
export async function resumeThread(rpc:Rpc,params:any){
 try{return await rpc('thread/resume',params);}
 catch(error){const e=error as any;if(e.code!==-32600||typeof e.message!=='string'||!e.message.includes('invalid paginated history lineage')||!e.message.includes('missing source rollout')||params.excludeTurns!==true)throw error;
  return rpc('thread/resume',{...params,excludeTurns:false});
 }
}
