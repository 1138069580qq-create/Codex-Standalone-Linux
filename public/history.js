/* Permanent account-scoped local records. No TTL, quota pruning or logout deletion. */
(function(scope){
 'use strict';
 const MAX_BYTES=8*1024*1024,TTL=Infinity,CHUNK=192*1024;
 const encoder=new TextEncoder(),decoder=new TextDecoder();
 const canonical=v=>JSON.stringify(normal(v));
 function normal(v){if(Array.isArray(v))return v.map(normal);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,normal(v[k])]));return v;}
 async function hash(value){const bytes=encoder.encode(value),crypto=scope.crypto||(typeof require==='function'?require('node:crypto').webcrypto:null);if(!crypto?.subtle)throw Error('安全摘要不可用');return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
 async function manifest(items){const known=await Promise.all(items.map(async i=>[i.id,await hash(canonical(i))]));return {known,digest:await hash(canonical(known))};}
 function snapshot(input,now=Date.now()){
  const result={version:2,savedAt:now,items:(input.items||[]).map(i=>Object.fromEntries(['id','type','text','role','phase','turnId','status','startedAt','finishedAt','durationMs','images','files','truncated'].filter(k=>i[k]!==undefined).map(k=>[k,JSON.parse(JSON.stringify(i[k]))]))),turns:(input.turns||[]).map(t=>Object.fromEntries(['id','status','startedAt','finishedAt','durationMs'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]]))),truncated:!!input.truncated};
  if(!result.items.every(i=>i&&typeof i.id==='string'&&typeof i.text==='string'))throw Error('本地记录格式错误');
  if(encoder.encode(JSON.stringify(result)).length>MAX_BYTES)throw Error('本次记录过大，未保存；已有本地记录保持不变');return result;
 }
 function threads(rows,now=Date.now()){return {version:2,savedAt:now,data:(rows||[]).map(v=>({id:v.id,title:v.title,status:v.status,updatedAt:Number(v.updatedAt)||0,pinned:!!v.pinned}))};}
 function browserStore(){
  let opening;
  function db(){return opening||=(new Promise((resolve,reject)=>{if(!scope.indexedDB){reject(Error('浏览器持久存储不可用，未保存本地记录'));return;}const r=scope.indexedDB.open('codex-local-history-v2',1);r.onupgradeneeded=()=>r.result.createObjectStore('records');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('请关闭旧页面后重试本地记录'));}));}
  async function operation(key,value){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('records',value===undefined?'readonly':'readwrite',{durability:'strict'}),r=value===undefined?tx.objectStore('records').get(key):tx.objectStore('records').put(value,key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('本地记录未写入'));});}
  return {get:key=>operation(key),put:(key,value)=>operation(key,value)};
 }
 function memoryStore(){const values=new Map();return {get:async k=>values.get(k),put:async(k,v)=>{values.set(k,v);}};}
 function base64(bytes){if(typeof Buffer!=='undefined')return Buffer.from(bytes).toString('base64');let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
 function unbase64(s){if(typeof Buffer!=='undefined')return new Uint8Array(Buffer.from(s,'base64'));return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
 function create({plugin=null,origin='https://localhost',now=Date.now,storage}={}){
  let account='',server=origin,revision=0,pending=Promise.resolve();
  const kv=storage||(plugin?{get:async key=>(await plugin.historyCache({key})).value,put:async(key,value)=>{await plugin.historyCache({key,value});}}:browserStore());
  function reset(){revision++;account='';}
  async function init(user,baseUrl){reset();const ticket=revision;if(!user?.id)return;const profile=baseUrl?{baseUrl}:plugin?await plugin.profile():{baseUrl:origin};if(ticket!==revision)return;server=new URL(profile.baseUrl).origin;account=String(user.id);if(!plugin)void scope.navigator?.storage?.persist?.().catch(()=>{});}
  function key(project,id){return account&&project&&id?JSON.stringify([server,account,String(project),String(id)]):null;}
  function part(k,name){const a=JSON.parse(k);a[3]+='@local-'+name;return JSON.stringify(a);}
  async function decode(k,head){
   if(!head)return null;const h=JSON.parse(head);if(h.version===1||h.version===2&&!h.archive)return {value:h,recordId:null,previousId:null};
   if(h.archive!==1||!/^[-a-f0-9]{64}$/.test(h.recordId))throw Error('本地记录索引损坏，原文件已保留');
   const meta=JSON.parse(await kv.get(part(k,h.recordId+'-meta')));if(!Number.isInteger(meta.chunks)||meta.chunks<1||meta.chunks>64)throw Error('本地记录分片索引损坏');
   const pieces=[];let length=0;for(let i=0;i<meta.chunks;i++){const raw=await kv.get(part(k,h.recordId+'-'+i));if(typeof raw!=='string')throw Error('本地记录分片缺失');const b=unbase64(raw);pieces.push(b);length+=b.length;}
   if(length>MAX_BYTES)throw Error('本地记录过大，原记录已保留');const bytes=new Uint8Array(length);let offset=0;for(const b of pieces){bytes.set(b,offset);offset+=b.length;}const value=decoder.decode(bytes);if(await hash(value)!==meta.hash)throw Error('本地记录校验失败，原记录已保留');return {value:JSON.parse(value),recordId:h.recordId,previousId:meta.previousId||null};
  }
  async function read(project,id){const k=key(project,id),ticket=revision;if(!k)return null;await pending.catch(()=>{});const row=await decode(k,await kv.get(k));return ticket===revision?(row?.value??null):null;}
  async function record(project,id,recordId){const k=key(project,id),ticket=revision;if(!k)return null;await pending.catch(()=>{});const row=await decode(k,recordId?JSON.stringify({archive:1,recordId}):await kv.get(k));return ticket===revision?row:null;}
  async function commit(k,value){
   const old=await kv.get(k),head=old?JSON.parse(old):null;
   // Keep a legacy record in the immutable chain before replacing its latest pointer.
   if(head&&!head.archive){await append(k,JSON.stringify(head),null);}
   const current=await kv.get(k),h=current?JSON.parse(current):null,data=JSON.stringify(value),bytes=encoder.encode(data);if(bytes.length>MAX_BYTES)throw Error('本次记录过大，已有记录未删除');
   const content=canonical({...value,savedAt:0});const contentHash=await hash(content);if(h?.archive===1&&h.contentHash===contentHash)return;
   await append(k,data,h?.archive===1?h.recordId:null,contentHash);
  }
  async function append(k,data,previousId,contentHash){
   const bytes=encoder.encode(data),digest=await hash(data),recordId=await hash((previousId||'')+digest),chunks=Math.ceil(bytes.length/CHUNK)||1;
   for(let i=0;i<chunks;i++)await kv.put(part(k,recordId+'-'+i),base64(bytes.slice(i*CHUNK,(i+1)*CHUNK)));
   await kv.put(part(k,recordId+'-meta'),JSON.stringify({hash:digest,chunks,previousId}));
   await kv.put(k,JSON.stringify({archive:1,recordId,contentHash:contentHash||await hash(canonical({...JSON.parse(data),savedAt:0}))}));
  }
  function write(project,id,value){const k=key(project,id);if(!k)return Promise.resolve();const captured=JSON.parse(JSON.stringify(value));const work=pending.catch(()=>{}).then(()=>commit(k,captured));pending=work;return work;}
  // Kept for old callers that invalidate a remote view; invalidation never deletes local records.
  function remove(){return Promise.resolve();}
  return {init,reset,read,write,record,remove,flush:()=>pending,get namespace(){return server;},selected:(projectId,threadId)=>write('@account','selected',{version:2,savedAt:now(),projectId,threadId})};
 }
 async function sync(request,url,projectId,items){
  const m=await manifest(items),body=items.length?{projectId,digest:m.digest}:{projectId,known:[]};let r;try{r=await request(url,body);}catch(e){if(![404,405,501].includes(e.status)&&!['NOT_FOUND','UNSUPPORTED_ROUTE'].includes(e.code))throw e;return request(url.replace(/\/sync$/,'')+'?projectId='+encodeURIComponent(projectId));}
  if(r.needsManifest)r=await request(url,{projectId,...m});
  if(r.sync!==1)return r;
  if(r.unchanged)return {...r,items};
  if(!Array.isArray(r.items)||!Array.isArray(r.order))throw Error('增量历史响应不完整');
  const values=new Map(items.map(i=>[i.id,i]));for(const i of r.items)values.set(i.id,i);
  if(r.order.some(id=>!values.has(id)))throw Error('本地记录缺少所需片段');const merged=r.order.map(id=>values.get(id));
  if((await manifest(merged)).digest!==r.digest)throw Error('增量历史校验失败');return {...r,items:merged};
 }
 const core={sync,snapshot,threads,create,TTL,MAX_BYTES,canonical,hash,manifest,memoryStore};scope.CodexHistoryCore=core;
 scope.CodexHistory=create({plugin:scope.CodexPlatform?.plugin,origin:scope.location?.origin||'https://localhost'});
 if(typeof module==='object'&&module.exports)module.exports=core;
})(globalThis);
