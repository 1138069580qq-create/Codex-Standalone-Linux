import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const source=readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
// Load only the recovery functions under test. A broad slice also declares controls,
// syncSnapshot and loggedOut, silently replacing the harness's explicit dependencies.
const closeStart=source.indexOf('function closeStream()'),closeEnd=source.indexOf('function clearConversation()');
const recoveryStart=source.indexOf('function scheduleReconnect('),recoveryEnd=source.indexOf('function scheduleRender(');
assert.ok(closeStart>=0&&closeEnd>closeStart&&recoveryStart>closeEnd&&recoveryEnd>recoveryStart);
const code=source.slice(closeStart,closeEnd)+source.slice(recoveryStart,recoveryEnd);
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function harness(){
 const timers=new Map<number,{fn:()=>any,delay:number}>();let serial=0,reads=0;
 const S:any={epoch:1,user:{id:'u'},project:{id:'p'},thread:{id:'t'},nativeForeground:true,csrf:'old',retry:0,connected:true,stream:null};
 const nodes=new Map<string,any>();const $=(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',scrollTop:17,scrollHeight:500,clientHeight:100});return nodes.get(id);};
 const calls:any[]=[];const c:any={S,$,document:{hidden:false},Math,Promise,controls(){},notice(){},loggedOut(){S.epoch++;S.user=null;},
  setTimeout(fn:()=>any,delay:number){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout(id:number){timers.delete(id);},
  api:async(route:string)=>{calls.push({route});return {user:{id:'u'},csrf:'renewed'};},
  syncSnapshot:async()=>{reads++;c.closeStream();if(c.failSnapshot)throw Object.assign(Error('offline'),c.failSnapshot===true?{}:c.failSnapshot);S.stream={close(){}};}
 };vm.createContext(c);vm.runInContext(code,c);
 async function fire(){const entry=[...timers.entries()][0];assert.ok(entry,'retry must be scheduled');timers.delete(entry[0]);await entry[1].fn();}
 return {c,S,timers,fire,calls,reads:()=>reads,$};
}
test('native foreground failure continues retry after snapshot clears the previous timer',async()=>{
 const t=harness();t.S.nativeForeground=false;t.c.closeStream();t.S.nativeForeground=true;t.c.failSnapshot=true;
 t.c.resumeRealtime();t.c.resumeRealtime();assert.equal(t.timers.size,1);await t.fire();assert.equal(t.timers.size,1);assert.ok([...t.timers.values()][0].delay>=800);assert.equal(t.S.csrf,'renewed');
 t.c.failSnapshot=false;await t.fire();assert.ok(t.S.stream);assert.equal(t.timers.size,0);assert.equal(t.reads(),2);assert.ok(t.calls.every(x=>x.route==='/api/session'));
});
test('native pause prevents late visibility and online callbacks from opening realtime',async()=>{
 const t=harness();t.S.nativeForeground=false;t.c.resumeRealtime();t.c.scheduleReconnect(1);assert.equal(t.timers.size,0);
 t.S.nativeForeground=true;t.c.document.hidden=true;t.c.resumeRealtime();assert.equal(t.timers.size,0);
 t.c.document.hidden=false;t.c.resumeRealtime();await t.fire();assert.ok(t.S.stream);
});
test('resume events share the same in-flight authentication and snapshot',async()=>{
 const t=harness(),d=deferred();let calls=0;t.c.api=()=>{calls++;return d.promise;};t.c.resumeRealtime();const running=t.fire();
 t.c.resumeRealtime();t.c.resumeRealtime();assert.equal(calls,1);assert.equal(t.timers.size,0);d.resolve({user:{id:'u'},csrf:'new'});await running;
 assert.equal(t.reads(),1);assert.equal(t.timers.size,0);
});
test('an immediate SSE failure during recovery keeps exponential backoff',async()=>{
 const t=harness();t.c.syncSnapshot=async()=>{t.c.closeStream();t.c.scheduleReconnect(t.S.epoch);};
 t.c.resumeRealtime();await t.fire();assert.ok([...t.timers.values()][0].delay>=800);await t.fire();assert.ok([...t.timers.values()][0].delay>=1600);
});
test('temporary authentication failures retry without clearing the account',async()=>{
 const t=harness();t.c.api=async()=>{throw Error('network');};t.c.resumeRealtime();await t.fire();assert.equal(t.S.user.id,'u');assert.equal(t.timers.size,1);
});
test('permission denial and explicit administrator disconnect do not retry forever',async()=>{
 for(const failure of [{status:401},{status:403},{status:404},{status:413,code:'HISTORY_TOO_LARGE'},{code:'CODEX_DISCONNECTED'}]){const t=harness();t.c.failSnapshot=failure;t.c.resumeRealtime();await t.fire();assert.equal(t.timers.size,0);}
});
test('old task/account authentication cannot overwrite the current selection',async()=>{
 const t=harness(),d=deferred();t.c.api=()=>d.promise;t.c.resumeRealtime();const running=t.fire();t.S.epoch++;t.S.user={id:'other'};t.S.thread={id:'other-task'};
 d.resolve({user:{id:'u'},csrf:'stale'});await running;assert.equal(t.S.csrf,'old');assert.equal(t.reads(),0);assert.equal(t.timers.size,0);
});
test('mismatched or malformed session is not treated as a successful recovery',async()=>{
 const t=harness();t.c.api=async()=>({user:{id:'other'},csrf:'x'});t.c.resumeRealtime();await t.fire();assert.equal(t.S.user,null);assert.equal(t.reads(),0);
 const u=harness();u.c.api=async()=>({});u.c.resumeRealtime();await u.fire();assert.equal(u.timers.size,1);assert.equal(u.reads(),0);
});
test('background transition during authentication opens no new stream until next foreground',async()=>{
 const t=harness(),d=deferred();t.c.api=()=>d.promise;t.c.resumeRealtime();const running=t.fire();t.S.nativeForeground=false;
 d.resolve({user:{id:'u'},csrf:'new'});await running;assert.equal(t.reads(),0);assert.equal(t.timers.size,0);
 t.S.nativeForeground=true;t.c.resumeRealtime();await t.fire();assert.equal(t.reads(),1);
});
test('online and visibility recovery remain wired',()=>{
 assert.match(source,/window.addEventListener\('online',\(\)=>resumeRealtime\(\)\)/);assert.match(source,/document.addEventListener\('visibilitychange'/);
});
