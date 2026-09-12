/* Read-only task cache. Native persistence is encrypted; browsers retain only memory. */
(function(scope){
  'use strict';
  const MAX_BYTES=360*1024,TTL=7*24*60*60*1000;
  const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
  const text=(value,n)=>typeof value==='string'?value.slice(0,n):'';
  function snapshot(input,now=Date.now()){
    const items=[];let bytes=0,cut=false;
    for(const raw of [...(input.items||[])].slice(-200).reverse()){
      if(!raw||typeof raw.id!=='string'||typeof raw.text!=='string')continue;
      // Do not persist approvals, queue commands, cursor, credentials or native file tokens.
      const item={id:text(raw.id,256),type:text(raw.type,64),text:text(raw.text,65536)};
      for(const key of ['role','phase','turnId','status'])if(typeof raw[key]==='string')item[key]=text(raw[key],256);
      for(const key of ['startedAt','finishedAt','durationMs'])if(Number.isFinite(raw[key]))item[key]=raw[key];
      if(raw.truncated||raw.text.length>item.text.length)item.truncated=true;
      const n=size(item);if(bytes+n>MAX_BYTES-16384){cut=true;break;}bytes+=n;items.unshift(item);
    }
    const ids=new Set(items.map(i=>i.turnId));
    const turns=(input.turns||[]).filter(t=>t&&ids.has(t.id)).slice(-200).map(t=>{const row={id:text(t.id,256),status:text(t.status,64)};for(const k of ['startedAt','finishedAt','durationMs'])if(Number.isFinite(t[k]))row[k]=t[k];return row;});
    const result={version:1,savedAt:now,items,turns,truncated:!!input.truncated||cut||(input.items||[]).length>items.length};
    while(size(result)>MAX_BYTES&&result.turns.length)result.turns.shift();return result;
  }
  function threads(rows,now=Date.now()){
    return {version:1,savedAt:now,data:(rows||[]).slice(0,120).filter(v=>v&&typeof v.id==='string').map(v=>({id:text(v.id,256),title:text(v.title,240),status:text(v.status,64),updatedAt:Number(v.updatedAt)||0,pinned:!!v.pinned}))};
  }
  function create({plugin=null,origin='https://localhost',now=Date.now}={}){
    let account='',server=origin,revision=0,pending=Promise.resolve();const memory=new Map();
    function reset(){revision++;account='';}
    async function init(user){reset();const ticket=revision;if(!user?.id)return;const profile=plugin?await plugin.profile():{baseUrl:origin};if(ticket!==revision)return;server=new URL(profile.baseUrl).origin;account=String(user.id);}
    function key(project,id){if(!account||!project||!id)return null;return JSON.stringify([server,account,String(project),String(id)]);}
    async function read(project,id){
      const k=key(project,id),ticket=revision;if(!k)return null;
      await pending.catch(()=>{});if(ticket!==revision)return null;let value;if(plugin)value=(await plugin.historyCache({key:k})).value;else value=memory.get(k);
      if(ticket!==revision||!value)return null;
      try{const row=JSON.parse(value);if(row.version!==1||!Number.isFinite(row.savedAt)||row.savedAt>now()+60000||now()-row.savedAt>TTL)return null;return row;}catch{return null;}
    }
    function mutate(project,id,value){
      const k=key(project,id),ticket=revision;if(!k)return Promise.resolve();
      const work=pending.catch(()=>{}).then(async()=>{
        if(ticket!==revision)return;
        if(plugin)await plugin.historyCache({key:k,value});
        else {memory.delete(k);if(value)memory.set(k,value);while(memory.size>32||[...memory.values()].reduce((n,v)=>n+new TextEncoder().encode(v).length,0)>2*1024*1024)memory.delete(memory.keys().next().value);}
      });pending=work;return work;
    }
    async function write(project,id,value){const data=JSON.stringify(value);if(new TextEncoder().encode(data).length>MAX_BYTES)throw Error('历史缓存超过单项上限');return mutate(project,id,data);}
    function remove(project,id){return mutate(project,id,'');}
    return {init,reset,read,write,remove,get namespace(){return server;},selected:(projectId,threadId)=>write('@account','selected',{version:1,savedAt:now(),projectId,threadId})};
  }
  scope.CodexHistoryCore={snapshot,threads,create,TTL,MAX_BYTES};
  scope.CodexHistory=create({plugin:scope.CodexPlatform?.plugin,origin:scope.location?.origin||'https://localhost'});
  if(typeof module==='object'&&module.exports)module.exports=scope.CodexHistoryCore;
})(globalThis);
