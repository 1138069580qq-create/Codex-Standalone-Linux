import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export interface TokenUsage {total:number|null;last:number|null;contextWindow:number|null;source?:string}
const count=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
/** Public API, desktop and persisted token_count use different field names. Missing is not zero. */
export function normalizeTokenUsage(value:any):TokenUsage|null {
  if(!value||typeof value!=='object')return null;
  const info=value.info??value;
  const total=info.total??info.total_token_usage;
  const last=info.last??info.last_token_usage;
  const result={total:count(typeof total==='number'?total:total?.totalTokens??total?.total_tokens),last:count(typeof last==='number'?last:last?.totalTokens??last?.total_tokens),contextWindow:count(info.contextWindow??info.modelContextWindow??info.model_context_window)};
  if(result.contextWindow===0)result.contextWindow=null;
  return result.total===null&&result.last===null&&result.contextWindow===null?null:result;
}
/** Read ONLY the verified thread's bounded public token_count record; never scan history or auth files. */
export async function restoredTokenUsage(thread:any,home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')):Promise<TokenUsage|null> {
  const supplied=normalizeTokenUsage(thread?.tokenUsage??thread?.latestTokenUsageInfo);
  if(supplied?.last!==null&&supplied)return supplied;
  if(typeof thread?.path!=='string'||!thread.path.endsWith('.jsonl'))return supplied;
  try {
    const file=await fs.realpath(thread.path),root=await fs.realpath(home);
    const rel=path.relative(root,file).split(path.sep);
    if(!['sessions','archived_sessions'].includes(rel[0])||rel.includes('..'))return supplied;
    const handle=await fs.open(file,'r');
    try {
      const stat=await handle.stat();if(!stat.isFile())return supplied;
      const start=Math.max(0,stat.size-512*1024),buffer=Buffer.alloc(stat.size-start);
      const {bytesRead}=await handle.read(buffer,0,buffer.length,start);
      const tail=buffer.subarray(0,bytesRead),first=start>0?tail.indexOf(10)+1:0;
      if(start>0&&first===0)return supplied;
      const lines=tail.subarray(first).toString('utf8').split('\n');
      for(let i=lines.length-1;i>=0;i--){
        if(!lines[i].includes('token_count'))continue;
        try{const row=JSON.parse(lines[i]);if(row.type!=='event_msg'||row.payload?.type!=='token_count')continue;
          const usage=normalizeTokenUsage(row.payload.info);if(usage?.last!==null&&usage)return {...usage,source:'rollout'};
        }catch{/* A partially written final line must not hide the preceding complete sample. */}
      }
    }finally{await handle.close();}
  }catch{/* Remote/unavailable rollout: keep explicit unknowns; never infer tokens from text. */}
  return supplied;
}
