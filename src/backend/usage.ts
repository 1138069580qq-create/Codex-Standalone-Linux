import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { ConsoleError, type Identity, requireAdmin } from './config';
import type { CodexRateLimits } from './limits';
import { defaultCodexPrices } from './pricing';

export interface Price { model:string; input:number; cachedInput:number; output:number; source:string; verifiedAt:string; fastMultiplier?:number; longContext?:{threshold:number;input:number;cachedInput:number;output:number} }
export interface Tokens { input:number; cached:number; output:number }
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
export function tokenCounters(v:any):Tokens|null {
  if(!v||typeof v!=='object')return null;
  const input=num(v.inputTokens??v.input_tokens),cached=num(v.cachedInputTokens??v.cached_input_tokens),output=num(v.outputTokens??v.output_tokens);
  return input===null||cached===null||output===null||cached>input?null:{input,cached,output};
}
/** OpenAI input includes cache hits. Output already includes reasoning; never add it twice. */
export function calculateCost(t:Tokens,p?:Price,contextInput=t.input,serviceTier?:string){
  if(!p)return null;
  const rate=p.longContext&&contextInput>p.longContext.threshold?p.longContext:p;
  const multiplier=["fast","priority"].includes(serviceTier||"")?(p.fastMultiplier??1):1;
  return ((t.input-t.cached)*rate.input+t.cached*rate.cachedInput+t.output*rate.output)/1_000_000*multiplier;
}
export function validatePrices(value:unknown):Price[]{
  if(!Array.isArray(value)||value.length>300)throw new ConsoleError(400,'INVALID_PRICES','价格表最多 300 项。');
  const seen=new Set<string>();
  return value.map((p:any)=>{
    if(!p||typeof p.model!=='string'||!/^[-a-zA-Z0-9._:/]{1,128}$/.test(p.model)||seen.has(p.model))throw new ConsoleError(400,'INVALID_PRICES','模型名称必须唯一，使用完整模型 ID。');
    const check=(r:any)=>['input','cachedInput','output'].every(k=>typeof r?.[k]==='number'&&Number.isFinite(r[k])&&r[k]>=0&&r[k]<=10000);
    let source:URL;try{source=new URL(p.source);}catch{throw new ConsoleError(400,'INVALID_PRICE_SOURCE','请填写 OpenAI 官方定价来源。');}
    if(source.protocol!=='https:'||source.username||source.password||!['openai.com','developers.openai.com','platform.openai.com','help.openai.com'].includes(source.hostname)||!check(p)||!/^\d{4}-\d{2}-\d{2}$/.test(p.verifiedAt)||!Number.isFinite(Date.parse(p.verifiedAt))||Date.parse(p.verifiedAt)>Date.now()+86400000)throw new ConsoleError(400,'INVALID_PRICES','价格、核验日期或官方来源无效。');
    if(p.longContext&&(!check(p.longContext)||!Number.isSafeInteger(p.longContext.threshold)||p.longContext.threshold<1))throw new ConsoleError(400,'INVALID_PRICES','长上下文价格无效。');
    if(p.fastMultiplier!==undefined&&(typeof p.fastMultiplier!=="number"||!Number.isFinite(p.fastMultiplier)||p.fastMultiplier<1||p.fastMultiplier>10))throw new ConsoleError(400,"INVALID_PRICES","快速模式倍率无效。");
    seen.add(p.model);return {...(p.fastMultiplier?{fastMultiplier:p.fastMultiplier}:{}),model:p.model,input:p.input,cachedInput:p.cachedInput,output:p.output,source:source.href,verifiedAt:p.verifiedAt,...(p.longContext?{longContext:{threshold:p.longContext.threshold,input:p.longContext.input,cachedInput:p.longContext.cachedInput,output:p.longContext.output}}:{})};
  });
}
const empty=()=>({requests:0,input:0,cached:0,output:0,cost:0,unpriced:0});
const tools=new Set(['commandExecution','mcpToolCall','dynamicToolCall','webSearch','fileChange','toolCall','computerUse']);
const safeModel=(v:any)=>typeof v==='string'&&v.length<=128?v:'unknown';
export class UsageLedger {
  readonly db:DatabaseSync;
  private prices=new Map<string,Price>();
  private cache=new Map<string,{at:number;value:any}>();
  private activeTools=new Map<string,Set<string>>();
  private closed=false;
  private sharedEstimate?:{at:number;cycleKey:string;all:any;quota:any;from:number;to:number};
  readonly startedAt:number;
  constructor(readonly file:string,private clock=Date.now){
    mkdirSync(path.dirname(file),{recursive:true,mode:0o700});this.db=new DatabaseSync(file);
    chmodSync(file,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,project_id TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL,baseline TEXT,turn_id TEXT,service_tier TEXT);'+
      'CREATE TABLE IF NOT EXISTS turns (id TEXT NOT NULL,thread_id TEXT NOT NULL,user_id TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER,first_token INTEGER,tool_start INTEGER,tool_ms INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,PRIMARY KEY(thread_id,id));'+
      'CREATE INDEX IF NOT EXISTS turns_user ON turns(user_id,thread_id);'+
      'CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT,model TEXT NOT NULL,provider TEXT NOT NULL,at INTEGER NOT NULL,input INTEGER NOT NULL,cached INTEGER NOT NULL,output INTEGER NOT NULL,cost REAL,price TEXT,status TEXT NOT NULL);'+
      'CREATE INDEX IF NOT EXISTS requests_user ON requests(user_id,at,id);'+
      'CREATE INDEX IF NOT EXISTS requests_at ON requests(at);'+
      'CREATE INDEX IF NOT EXISTS requests_thread ON requests(thread_id,user_id);'+
      'CREATE TABLE IF NOT EXISTS totals (user_id TEXT NOT NULL,day INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL,requests INTEGER NOT NULL,input INTEGER NOT NULL,cached INTEGER NOT NULL,output INTEGER NOT NULL,cost REAL NOT NULL,unpriced INTEGER NOT NULL,PRIMARY KEY(user_id,day,model,provider));'+
      'CREATE TABLE IF NOT EXISTS quota (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,bucket TEXT NOT NULL,reset_at INTEGER,used REAL NOT NULL,delta REAL NOT NULL,gap INTEGER NOT NULL);'
    );
    if(!(this.db.prepare('PRAGMA table_info(threads)').all() as any[]).some(c=>c.name==='service_tier'))this.db.exec('ALTER TABLE threads ADD COLUMN service_tier TEXT');
    this.startedAt=this.getMeta('startedAt')??this.clock();this.setMeta('startedAt',this.startedAt);
    if(!this.getMeta('cycle'))this.setMeta('cycle',{start:this.startedAt,end:null,configured:false});
    let stored=this.getMeta('prices');if(stored===null){stored=defaultCodexPrices();this.setMeta('prices',stored);}
    for(const p of validatePrices(stored))this.prices.set(p.model,p);
  }
  close(){if(!this.closed){this.closed=true;this.db.close();}}
  private getMeta(key:string){const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any;return row?JSON.parse(row.value):null;}
  private setMeta(key:string,value:any){this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  owner(threadId:string):string|undefined{return (this.db.prepare('SELECT user_id FROM threads WHERE id=?').get(threadId) as any)?.user_id;}
  bind(threadId:string,who:Identity,projectId:string,model?:string,provider?:string,fresh=false,serviceTier?:string){
    if(!who.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');
    const row=this.db.prepare('SELECT * FROM threads WHERE id=?').get(threadId) as any;
    if(row&&row.user_id!==who.uuid)throw new ConsoleError(403,'THREAD_FORBIDDEN','此聊天属于另一个网页账户。');
    this.db.prepare('INSERT INTO threads(id,user_id,project_id,model,provider,baseline) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id').run(threadId,who.uuid,projectId,safeModel(model),safeModel(provider||'Codex'),fresh?JSON.stringify({input:0,cached:0,output:0}):null);
    if(model)this.model(threadId,model,provider,serviceTier);
  }
  model(threadId:string,model:string,provider?:string,serviceTier?:string){this.db.prepare('UPDATE threads SET model=?,provider=COALESCE(?,provider),service_tier=COALESCE(?,service_tier) WHERE id=?').run(safeModel(model),provider?safeModel(provider):null,serviceTier?safeModel(serviceTier):null,threadId);}
  private thread(id:string){return this.db.prepare('SELECT * FROM threads WHERE id=?').get(id) as any;}
  observe(threadId:string,method:string,p:any,at=this.clock()){
    const thread=this.thread(threadId);if(!thread)return;
    if(typeof (p.model??p.turn?.model)==='string')this.model(threadId,p.model??p.turn.model,p.modelProvider,p.serviceTier??p.turn?.serviceTier);
    if(method==='turn/started'){
      const id=p.turn?.id??p.turnId;if(typeof id!=='string'||id.length>128)return;
      this.db.prepare('INSERT OR IGNORE INTO turns(thread_id,id,user_id,started,status) VALUES (?,?,?,?,?)').run(threadId,id,thread.user_id,at,'running');
      this.db.prepare('UPDATE threads SET turn_id=? WHERE id=?').run(id,threadId);return;
    }
    if(method==='thread/tokenUsage/updated'){this.usage(threadId,p.tokenUsage?.total??p.total,at,num(p.tokenUsage?.last?.inputTokens)??undefined);return;}
    const turn=thread.turn_id&&this.db.prepare('SELECT * FROM turns WHERE thread_id=? AND id=?').get(threadId,thread.turn_id) as any;
    if(!turn||turn.ended!==null)return;
    if(method.endsWith('/delta')&&typeof p.delta==='string'&&p.delta.length&&/agentMessage|reasoning/.test(method)){
      if(turn.first_token===null)this.db.prepare('UPDATE turns SET first_token=? WHERE thread_id=? AND id=?').run(at,threadId,turn.id);return;
    }
    if((method==='item/started'||method==='item/completed')&&tools.has(p.item?.type)){
      const key=threadId+':'+turn.id;let active=this.activeTools.get(key);if(!active){active=new Set();this.activeTools.set(key,active);}
      const id=String(p.item?.id||'');if(!id)return;
      if(method==='item/started'&&!active.has(id)){if(!active.size)this.db.prepare('UPDATE turns SET tool_start=? WHERE thread_id=? AND id=?').run(at,threadId,turn.id);active.add(id);}
      if(method==='item/completed'&&active.delete(id)&&!active.size){this.db.prepare('UPDATE turns SET tool_ms=tool_ms+MAX(0,?-COALESCE(tool_start,?)),tool_start=NULL WHERE thread_id=? AND id=?').run(at,at,threadId,turn.id);}
      return;
    }
    if(method==='turn/completed'){
      if(p.turn?.id&&p.turn.id!==turn.id)return;
      this.db.prepare('UPDATE turns SET ended=?,status=?,tool_ms=tool_ms+CASE WHEN tool_start IS NULL THEN 0 ELSE MAX(0,?-tool_start) END,tool_start=NULL WHERE thread_id=? AND id=?').run(at,p.turn?.status||'completed',at,threadId,turn.id);
      this.db.prepare('UPDATE requests SET status=? WHERE thread_id=? AND turn_id=?').run(p.turn?.status||'completed',threadId,turn.id);
      this.activeTools.delete(threadId+':'+turn.id);
    }
  }
  /** A high-water mark survives reconnect/replay. Old unbound history establishes a baseline only. */
  usage(threadId:string,value:any,at=this.clock(),contextInput?:number){
    const t=tokenCounters(value),thread=this.thread(threadId);if(!t||!thread)return;
    const before:Tokens|null=thread.baseline?JSON.parse(thread.baseline):null;
    if(!before){this.db.prepare('UPDATE threads SET baseline=? WHERE id=?').run(JSON.stringify(t),threadId);return;}
    // A rollback/compaction/replayed snapshot must not create another charge.
    const high={input:Math.max(before.input,t.input),cached:Math.max(before.cached,t.cached),output:Math.max(before.output,t.output)};
    const delta={input:high.input-before.input,cached:Math.min(high.cached-before.cached,high.input-before.input),output:high.output-before.output};
    if(!delta.input&&!delta.output)return;
    const price=this.prices.get(thread.model),cost=calculateCost(delta,price,contextInput??delta.input,thread.service_tier),day=Math.floor(at/86400000)*86400000;
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('UPDATE threads SET baseline=? WHERE id=?').run(JSON.stringify(high),threadId);
      this.db.prepare('INSERT INTO requests(user_id,thread_id,turn_id,model,provider,at,input,cached,output,cost,price,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(thread.user_id,threadId,thread.turn_id,thread.model,thread.provider,at,delta.input,delta.cached,delta.output,cost,price?JSON.stringify({...price,applied:{contextInput:contextInput??delta.input,serviceTier:thread.service_tier||'standard-or-unreported',longContext:Boolean(price.longContext&&(contextInput??delta.input)>price.longContext.threshold)}}):null,'observed');
      this.db.prepare('INSERT INTO totals VALUES (?,?,?,?,1,?,?,?,?,?) ON CONFLICT(user_id,day,model,provider) DO UPDATE SET requests=requests+1,input=input+excluded.input,cached=cached+excluded.cached,output=output+excluded.output,cost=cost+excluded.cost,unpriced=unpriced+excluded.unpriced').run(thread.user_id,day,thread.model,thread.provider,delta.input,delta.cached,delta.output,cost??0,cost===null?1:0);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  metrics(who:Identity,threadId:string){
    if(this.owner(threadId)!==who.uuid)throw new ConsoleError(403,'THREAD_FORBIDDEN','此聊天不属于当前网页账户。');
    const tokens=this.db.prepare('SELECT COUNT(*) steps,COALESCE(SUM(input),0) input,COALESCE(SUM(cached),0) cached,COALESCE(SUM(output),0) output FROM requests WHERE thread_id=? AND user_id=?').get(threadId,who.uuid) as any;
    const times=this.db.prepare('SELECT COUNT(*) rounds,COALESCE(SUM(tool_ms),0) toolMs,SUM(CASE WHEN ended IS NOT NULL THEN MAX(0,ended-started-tool_ms) END) llmMs,AVG(CASE WHEN first_token IS NOT NULL THEN MAX(0,first_token-started) END) ttftMs,SUM(CASE WHEN first_token IS NOT NULL AND ended IS NOT NULL THEN MAX(0,ended-first_token-tool_ms) END) generationMs FROM turns WHERE thread_id=? AND user_id=?').get(threadId,who.uuid) as any;
    const completed=this.db.prepare("SELECT COALESCE(SUM(r.output),0) output FROM requests r JOIN turns t ON t.thread_id=r.thread_id AND t.id=r.turn_id WHERE r.thread_id=? AND r.user_id=? AND t.ended IS NOT NULL").get(threadId,who.uuid) as any;
    return {...tokens,...times,cacheHitPercent:tokens.input?tokens.cached/tokens.input*100:null,tokensPerSecond:times.generationMs>0?completed.output/(times.generationMs/1000):null,timing:'observed-turn-wall-clock',since:this.startedAt};
  }
  sample(limits:CodexRateLimits){
    const candidates=limits.windows.filter(w=>w.windowDurationMins===10080),main=candidates.filter(w=>w.bucketId==='codex');
    const choices=main.length?main:candidates;
    if(choices.length!==1){this.setMeta('quotaUnavailable',choices.length?'multiple-weekly-buckets':'no-weekly-window');return;}
    const w=choices[0],at=limits.fetchedAt,bucket=w.bucketId||w.id;
    const last=this.db.prepare('SELECT * FROM quota ORDER BY id DESC LIMIT 1').get() as any;
    if(last&&at<=last.at)return;
    let delta=0,gap=0;
    if(last){
      if(bucket!==last.bucket)gap=1;
      else if(w.usedPercent<last.used||(last.reset_at&&at>=last.reset_at*1000&&w.resetsAt&&w.resetsAt>last.reset_at+60)){delta=w.usedPercent;gap=1;}
      else {delta=w.usedPercent-last.used;if(last.reset_at&&w.resetsAt&&Math.abs(w.resetsAt-last.reset_at)>60)gap=1;}
    }
    this.db.prepare('INSERT INTO quota(at,bucket,reset_at,used,delta,gap) VALUES (?,?,?,?,?,?)').run(at,bucket,w.resetsAt??null,w.usedPercent,delta,gap);
    this.setMeta('quotaUnavailable',null);this.setMeta('limits',limits);
  }
  settings(who:Identity){requireAdmin(who);return {prices:[...this.prices.values()],cycle:this.getMeta('cycle'),startedAt:this.startedAt};}
  configure(who:Identity,input:any){
    requireAdmin(who);const prices=validatePrices(input.prices),cycle=input.cycle;
    if(!cycle||!Number.isSafeInteger(cycle.start)||cycle.start<0||cycle.start>this.clock()||(cycle.end!==null&&(!Number.isSafeInteger(cycle.end)||cycle.end<=cycle.start)))throw new ConsoleError(400,'INVALID_CYCLE','订阅开始日不能在未来，结束日须晚于开始日。');
    this.setMeta('prices',prices);this.setMeta('cycle',{start:cycle.start,end:cycle.end,configured:true});this.prices=new Map(prices.map(p=>[p.model,p]));this.cache.clear();this.sharedEstimate=undefined;
    // Price changes apply to new events only; immutable historical rates remain auditable.
    return this.settings(who);
  }
  private sum(where:string,args:any[],table='totals'){
    return this.db.prepare('SELECT COALESCE(SUM('+(table==='totals'?'requests':'1')+'),0) requests,COALESCE(SUM(input),0) input,COALESCE(SUM(cached),0) cached,COALESCE(SUM(output),0) output,COALESCE(SUM(cost),0) cost,'+(table==='totals'?'COALESCE(SUM(unpriced),0)':'COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END),0)')+' unpriced FROM '+table+' WHERE '+where).get(...args) as any||empty();
  }
  private period(user:string|null,start:number,end:number){
    const day=86400000,first=Math.ceil(start/day)*day,last=Math.floor(end/day)*day;
    const result=empty(),add=(v:any)=>{for(const key of Object.keys(result) as (keyof typeof result)[])result[key]+=v[key]||0;};
    const who=user===null?'':'user_id=? AND ',args=user===null?[]:[user];
    if(first>=last){add(this.sum(who+'at>=? AND at<=?',[...args,start,end],'requests'));return result;}
    add(this.sum(who+'day>=? AND day<?',[...args,first,last]));
    add(this.sum(who+'at>=? AND at<?',[...args,start,first],'requests'));
    add(this.sum(who+'at>=? AND at<=?',[...args,last,end],'requests'));return result;
  }
  overview(who:Identity){
    const now=this.clock(),cached=this.cache.get(who.uuid);if(cached&&now-cached.at<300000)return cached.value;
    const cycle=this.getMeta('cycle'),end=Math.min(cycle.end===null?now:cycle.end-1,now),self=this.period(who.uuid,cycle.start,end),cycleKey=JSON.stringify(cycle);
    if(!this.sharedEstimate||this.sharedEstimate.cycleKey!==cycleKey||now-this.sharedEstimate.at>=300000){
      const bounds=this.db.prepare('SELECT MIN(at) first,MAX(at) last FROM quota WHERE at>=? AND at<=?').get(cycle.start,end) as any;
      const from=bounds.first??end,to=bounds.last??end;
      const quota=this.db.prepare('SELECT COALESCE(SUM(delta),0) consumed,COALESCE(SUM(gap),0) gaps FROM quota WHERE at>? AND at<=?').get(from,to) as any;
      this.sharedEstimate={at:now,cycleKey,all:this.period(null,from,to),quota,from,to};
    }
    const {all,quota,from,to}=this.sharedEstimate,attributed=this.period(who.uuid,from,to);
    const usable=all.cost>0&&!all.unpriced&&quota.consumed>0&&!this.getMeta('quotaUnavailable');
    const weekUsd=usable?all.cost/(quota.consumed/100):null,weekPercent=usable?attributed.cost/all.cost*quota.consumed:null;
    const value={generatedAt:now,startedAt:this.startedAt,cycle,cycleUsage:self,total:this.sum('user_id=?',[who.uuid]),weekUsd,cycleUsd:weekUsd===null?null:weekUsd*5,weeklyPercent:weekPercent,subscriptionPercent:weekPercent===null||!cycle.configured?null:weekPercent/5,weeksPerCycle:5,estimate:true,quotaGap:Boolean(quota.gaps),quotaUnavailable:this.getMeta('quotaUnavailable'),limits:this.getMeta('limits'),pricingComplete:all.unpriced===0,calibration:{from,to},refreshSeconds:300};
    this.cache.set(who.uuid,{at:now,value});return value;
  }
  details(who:Identity,input:{range?:string;model?:string;provider?:string;before?:number;offsetMinutes?:number}={}){
    const now=this.clock(),offset=Math.max(-840,Math.min(840,input.offsetMinutes||0))*60000;
    const today=Math.floor((now+offset)/86400000)*86400000-offset;
    const since=input.range==='all'?0:input.range==='30d'?today-29*86400000:input.range==='7d'?today-6*86400000:today;
    const args:any[]=[who.uuid,since];let where='user_id=? AND at>=?';
    for(const k of ['model','provider'] as const)if(input[k]){where+=' AND '+k+'=?';args.push(input[k]);}
    const summary=this.sum(where,args,'requests');
    const rows=this.db.prepare('SELECT id,thread_id threadId,turn_id turnId,model,provider,at,input,cached,output,cost,status,(SELECT ended-started FROM turns t WHERE t.thread_id=requests.thread_id AND t.id=requests.turn_id) durationMs,(SELECT first_token-started FROM turns t WHERE t.thread_id=requests.thread_id AND t.id=requests.turn_id) ttftMs FROM requests WHERE '+where+(input.before?' AND id<?':'')+' ORDER BY id DESC LIMIT 51').all(...args,...(input.before?[input.before]:[]));
    const group=(key:string)=>this.db.prepare('SELECT '+key+',COUNT(*) requests,SUM(input) input,SUM(cached) cached,SUM(output) output,SUM(cost) cost,SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) unpriced FROM requests WHERE '+where+' GROUP BY '+key+' ORDER BY COALESCE(SUM(cost),0) DESC LIMIT 300').all(...args);
    const bucket=input.range==='today'||!input.range?3600000:86400000;
    const trend=this.db.prepare('SELECT CAST((at+?)/? AS INTEGER)*?-? at,SUM(input-cached) input,SUM(cached) cached,SUM(output) output,SUM(cost) cost FROM requests WHERE '+where+' GROUP BY 1 ORDER BY 1 DESC LIMIT 366').all(offset,bucket,bucket,offset,...args).reverse();
    return {summary,models:group('model'),providers:group('provider'),trend,rows:rows.slice(0,50),next:rows.length>50?(rows[49] as any).id:null,since,generatedAt:now,cacheCreation:null,source:'Codex usage events'};
  }
  detail(who:Identity,id:number){
    const row=this.db.prepare('SELECT id,thread_id threadId,turn_id turnId,model,provider,at,input,cached,output,cost,price,status FROM requests WHERE id=? AND user_id=?').get(id,who.uuid) as any;
    if(!row)throw new ConsoleError(404,'USAGE_NOT_FOUND','未找到此用量记录。');return {...row,price:row.price?JSON.parse(row.price):null};
  }
}
