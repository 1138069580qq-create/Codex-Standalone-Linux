import {ConsoleError} from './config';
import {taskConfig} from './task-instructions';
type Rpc=(method:string,params:any)=>Promise<any>;
/** New empty threads in some app-server versions have no rollout backing paginated history.
 * Retry only this explicit pre-turn rejection, never a submitted model turn or uncertain write. */
export async function resumeThread(rpc:Rpc,params:any){
 params={...params,config:taskConfig(params.config)};
 try{return await rpc('thread/resume',params);}
 catch(error){const e=error as any;if(e.code!==-32600||typeof e.message!=='string'||!e.message.includes('invalid paginated history lineage')||!e.message.includes('missing source rollout')||params.excludeTurns!==true)throw error;
  return rpc('thread/resume',{...params,excludeTurns:false});
 }
}

/** A loaded thread keeps its MCP manager on resume. Release this client's idle
 * subscription first; reconnect only this task, without changing global config. */
export async function reconfigureThreadTools(rpc:(method:string,params:any)=>Promise<any>,params:any){
 // An empty live thread may have no durable rollout. Releasing it would destroy it.
 let history:any;
 try{history=await rpc('thread/turns/list',{threadId:params.threadId,limit:1,sortDirection:'desc',itemsView:'full'});}
 catch(e){const error=e as any;if(error.code===-32600&&/missing source rollout|no rollout found/.test(String(error.message)))throw new ConsoleError(409,'LOCAL_PAIR_ON_CREATE_REQUIRED','此空对话尚未保存。请更新客户端并新建对话，本机工具将在创建时连接。');throw e;}
 if(!history?.data?.length)throw new ConsoleError(409,'LOCAL_PAIR_ON_CREATE_REQUIRED','此空对话尚未保存。请更新客户端并新建对话，本机工具将在创建时连接。');
 await rpc('thread/unsubscribe',{threadId:params.threadId});
 const result=await resumeThread(rpc,params);
 const servers=await rpc('mcpServerStatus/list',{threadId:params.threadId,limit:100,detail:'toolsAndAuthOnly'});
 const expected=params.config?.['mcp_servers.local_device_files']?.enabled_tools||[];
 const device=servers?.data?.find((s:any)=>s.name==='local_device_files');
 if(!device||!expected.every((name:string)=>Object.hasOwn(device.tools||{},name)))throw new ConsoleError(503,'LOCAL_MCP_NOT_LOADED','当前对话未加载本地设备工具；请关闭其他客户端中的此对话后重试。');
 return result;
}
