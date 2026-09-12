import { CodexRpcError } from './transport';
import { ConsoleError } from './config';

export const HISTORY_MAX_BYTES=2*1024*1024;
export const HISTORY_MAX_TURNS=20;
export const historyTooLarge=()=>new ConsoleError(413,'HISTORY_TOO_LARGE','这段历史记录超过读取上限，请在桌面端查看。其他任务仍可使用。');
export const isHistoryPayloadError=(error:unknown)=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
const warning={code:'HISTORY_PARTIAL',message:'仅显示已读取的最近记录，较早内容超过读取上限。'};
export interface HistoryResult {data:any[];nextCursor:string|null;warning?:typeof warning;}

/** One turn per RPC, with an aggregate bound. Never retry a mutation or fetch an
 * unbounded full history merely because a connection/permission check failed. */
export async function readThreadHistory(rpc:(method:string,params:any)=>Promise<any>,threadId:string,limit=HISTORY_MAX_TURNS):Promise<HistoryResult>{
  if(!Number.isInteger(limit)||limit<1||limit>HISTORY_MAX_TURNS)throw new Error('Invalid history limit');
  const data:any[]=[],seen=new Set<string>(),turns=new Set<string>();let cursor:string|undefined,bytes=0;
  const partial=():HistoryResult=>({data,nextCursor:cursor||'history-truncated',warning});
  for(let page=0;page<limit;page++){
    let result:any;
    try{result=await rpc('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'full',...(cursor?{cursor}:{})});}
    catch(error){
      if(isHistoryPayloadError(error)){if(data.length)return partial();throw historyTooLarge();}
      if(page===0&&error instanceof CodexRpcError&&error.code===-32601){
        // Legacy fallback stays on the isolated/bounded reader; it cannot tear
        // down the shared command/event connection if a full result is too big.
        let legacy:any;try{legacy=await rpc('thread/read',{threadId,includeTurns:true});}
        catch(failure){if(isHistoryPayloadError(failure))throw historyTooLarge();throw failure;}
        const thread=legacy?.thread;
        if(thread?.id!==threadId||!Array.isArray(thread.turns))throw new Error('Invalid historical thread response');
        const selected:any[]=[];let size=0;
        for(const turn of [...thread.turns].reverse().slice(0,limit)){
          size+=Buffer.byteLength(JSON.stringify(turn));
          if(size>HISTORY_MAX_BYTES){if(!selected.length)throw historyTooLarge();return {data:selected,nextCursor:'legacy-truncated',warning};}
          selected.push(turn);
        }
        return {data:selected,nextCursor:thread.turns.length>limit?'legacy-truncated':null};
      }
      throw error;
    }
    if(!Array.isArray(result?.data)||result.data.length>1||result.nextCursor!=null&&typeof result.nextCursor!=='string')throw new Error('Invalid paged historical thread response');
    for(const turn of result.data){
      if(!turn||typeof turn.id!=='string'||turns.has(turn.id))throw new Error('Invalid paged historical thread response');
      bytes+=Buffer.byteLength(JSON.stringify(turn));
      if(bytes>HISTORY_MAX_BYTES){if(data.length)return partial();throw historyTooLarge();}
      turns.add(turn.id);data.push(turn);
    }
    const next=result.nextCursor||null;
    if(!next)return {data,nextCursor:null};
    if(next.length>32768||seen.has(next))throw new Error('Invalid historical pagination cursor');
    seen.add(next);cursor=next;
  }
  return {data,nextCursor:cursor||null};
}
