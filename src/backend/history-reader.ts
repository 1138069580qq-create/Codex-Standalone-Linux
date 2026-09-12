import { CodexRpcClient, type TransportOptions } from './transport';
import { ConsoleError } from './config';
import { readThreadHistory, type HistoryResult } from './history';

/** History is read-only and may contain large tool output. Its bounded sockets
 * must never share the command/event channel or restart/stop the Codex process. */
export class IsolatedHistoryReader {
  private active=new Set<CodexRpcClient>();
  private generation=0;
  constructor(private makePeer=(options:TransportOptions)=>new CodexRpcClient(options),private maxActive=4,private deadlineMs=12000){}
  cancelAll(){this.generation++;for(const peer of this.active)peer.close();this.active.clear();}
  async read(options:TransportOptions,threadId:string,current:()=>boolean=()=>true):Promise<HistoryResult>{
    if(this.active.size>=this.maxActive)throw new ConsoleError(429,'HISTORY_BUSY','正在读取其他任务记录，请稍后重试。');
    const generation=this.generation;let expired=false;
    const valid=()=>{if(generation!==this.generation||!current())throw new ConsoleError(409,'CONNECTION_CHANGED','连接已切换，已取消旧任务的读取。');if(expired)throw new ConsoleError(504,'HISTORY_TIMEOUT','读取历史记录超时，请重试。');};
    valid();
    const peer=this.makePeer({...options,maxFrameBytes:4*1024*1024,connectTimeoutMs:4000,requestTimeoutMs:4000});this.active.add(peer);
    const timer=setTimeout(()=>{expired=true;peer.close();},this.deadlineMs);
    try{
      await peer.connect();valid();
      const result=await readThreadHistory(async(method,params)=>{
        valid();if(method!=='thread/read'&&method!=='thread/turns/list')throw new Error('History reader is read-only');
        const response=await peer.request(method,params);valid();return response;
      },threadId);
      valid();return result;
    }catch(error){valid();throw error;}
    finally{clearTimeout(timer);this.active.delete(peer);peer.close();}
  }
}
