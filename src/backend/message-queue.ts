import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ConsoleError,type Identity} from './config';
import type {CodexConsoleService} from './service';
type State='queued'|'editing'|'paused'|'sending'|'unknown'|'sent'|'deleted';
type Entry={id:string;owner:string;projectId:string;threadId:string;createdAt:number;version:number;state:State;fingerprint:string;input?:any;error?:string};
const terminal=(e:Entry)=>e.state==='sent'||e.state==='deleted';
const busyCodes=new Set(['THREAD_BUSY','PROJECT_BUSY','MAIN_TURN_LIMIT','CONCURRENCY_LIMIT','TURN_LIMIT','CODEX_OFFLINE','DESKTOP_OFFLINE','NOT_CONNECTED']);
/** Durable per-owner FIFO. Only public message input is stored, with private file permissions.
 * Unknown outcomes are NEVER replayed. Restarted queues require explicit confirmation. */
export class MessageQueue {
  private entries:Entry[]=[];
  private writing:Promise<unknown>=Promise.resolve();
  private active=new Set<string>();
  private wake?:NodeJS.Timeout;
  private interval?:NodeJS.Timeout;
  private unsubscribe:()=>void;
  private stopped=false;
  private identities=new Map<string,Identity>();
  constructor(readonly file:string,private service:CodexConsoleService,private resolveUser?:(id:string)=>Identity|null,private auto=true){
    this.unsubscribe=service.hub.subscribe(e=>{if(['status','connection'].includes(e.type))this.schedule();});
    if(auto){this.interval=setInterval(()=>this.schedule(),15000);this.interval.unref();}
  }
  async load(){
    try{const rows=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(rows)||rows.length>10000)throw Error('Invalid queue store');
      for(const row of rows){if(!row||typeof row.id!=='string'||typeof row.owner!=='string'||typeof row.threadId!=='string'||typeof row.projectId!=='string'||!Number.isSafeInteger(row.version)||!['queued','editing','paused','sending','unknown','sent','deleted'].includes(row.state))throw Error('Invalid queue record');
        if(row.state==='sending'){row.state='unknown';row.version++;row.error='服务重启前的发送结果未知，请先核对聊天，不能自动重发。';}
        else if(row.state==='queued'){row.state='paused';row.version++;row.error='服务已重启，请确认后继续排队。';}
      }this.entries=rows;
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  private lock<T>(action:()=>T|Promise<T>):Promise<T>{const work=this.writing.then(action);this.writing=work.catch(()=>{});return work;}
  private async save(){await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});await fs.writeFile(this.file+'.tmp',JSON.stringify(this.entries),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}
  private changed(row:Entry){this.service.hub.publish({type:'queue',projectId:row.projectId,threadId:row.threadId,payload:{changed:true}});}
  private public(row:Entry){return {id:row.id,version:row.version,state:row.state,text:row.input?.text||'',createdAt:row.createdAt,error:row.error,attachments:row.input?.attachments||[],references:row.input?.references||[]};}
  rows(who:Identity,projectId:string,threadId:string){return this.entries.filter(e=>e.owner===who.uuid&&e.projectId===projectId&&e.threadId===threadId&&!terminal(e)).map(e=>this.public(e));}
  private async authorize(who:Identity,projectId:string,threadId:string){this.service.project(who,projectId,'send');await this.service.snapshot(who,projectId,threadId);this.identities.set(who.uuid,{...who});}
  async list(who:Identity,projectId:string,threadId:string){await this.authorize(who,projectId,threadId);return {data:this.rows(who,projectId,threadId)};}
  private validate(input:any){
    if(!input||typeof input.text!=='string'||!input.text.trim()||input.text.length>64000||typeof input.requestId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId))throw new ConsoleError(400,'INVALID_MESSAGE','消息内容或请求 ID 无效。');
    for(const [name,max] of [['attachments',5],['references',12],['extensions',12]] as const){const v=input[name];if(v!==undefined&&(!Array.isArray(v)||v.length>max||v.some((s:any)=>typeof s!=='string'||s.length>4096)))throw new ConsoleError(400,'INVALID_MESSAGE','附件或引用无效。');}
    if(Buffer.byteLength(JSON.stringify(input))>300000)throw new ConsoleError(400,'MESSAGE_TOO_LARGE','排队消息过大。');
  }
  async enqueue(who:Identity,projectId:string,threadId:string,input:any){
    this.validate(input);await this.authorize(who,projectId,threadId);
    // Explicit fields only: never persist identity, credentials, arbitrary body fields, or a steer target.
    const content=Object.fromEntries(['text','model','effort','mode','access','confirmFullAccess','attachments','references','extensions','settingsOverrides'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
    const fingerprint=createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const result=await this.lock(async()=>{
      const old=this.entries.find(e=>e.id===input.requestId&&e.owner===who.uuid&&e.threadId===threadId&&e.projectId===projectId);
      if(old){if(old.fingerprint!==fingerprint)throw new ConsoleError(409,'REQUEST_ID_REUSED','同一个请求 ID 不能用于不同消息。');return this.public(old);}
      if(this.entries.length>=10000||this.entries.filter(e=>e.owner===who.uuid&&!terminal(e)).length>=100)throw new ConsoleError(429,'QUEUE_FULL','排队消息已达上限，请先处理现有队列。');
      const row:Entry={id:input.requestId,owner:who.uuid,projectId,threadId,createdAt:Date.now(),version:1,state:'queued',fingerprint,input:{...content,requestId:randomUUID()}};
      this.entries.push(row);try{await this.save();}catch(e){this.entries.pop();throw e;}this.changed(row);return this.public(row);
    });this.schedule();return result;
  }
  async change(who:Identity,projectId:string,threadId:string,id:string,input:any){
    await this.authorize(who,projectId,threadId);
    if(!['edit','save','resume','delete','send'].includes(input?.action))throw new ConsoleError(400,'INVALID_QUEUE_ACTION','无效的队列操作。');
    let immediate:Entry|undefined;
    const result=await this.lock(async()=>{
      const row=this.entries.find(e=>e.owner===who.uuid&&e.projectId===projectId&&e.threadId===threadId&&e.id===id&&!terminal(e));
      if(!row)throw new ConsoleError(404,'QUEUE_NOT_FOUND','排队消息不存在或已经发送。');
      if(row.version!==input.version)throw new ConsoleError(409,'QUEUE_CHANGED','队列已改变，请刷新后重试。');
      if(row.state==='sending')throw new ConsoleError(409,'QUEUE_SENDING','消息正在提交，不能编辑或删除。');
      if(row.state==='unknown'&&input.action!=='delete')throw new ConsoleError(409,'OUTCOME_UNKNOWN','发送结果未知，请先核对聊天；不能直接重发。');
      if(input.action==='save'&&(row.state!=='editing'||typeof input.text!=='string'||!input.text.trim()||input.text.length>64000))throw new ConsoleError(400,'INVALID_MESSAGE','编辑内容无效或消息不在编辑状态。');
      if(input.action==='send'&&(row.state==='editing'||this.active.has(threadId)))throw new ConsoleError(409,'QUEUE_SENDING','请先保存编辑或等待正在提交的消息。');
      const before=structuredClone(row);
      row.version++;row.error=undefined;
      if(input.action==='delete'){row.state='deleted';delete row.input;}
      else if(input.action==='edit')row.state='editing';
      else if(input.action==='send'){row.state='sending';immediate=row;this.active.add(threadId);}
      else{if(input.action==='save')row.input.text=input.text;row.state='queued';}
      try{await this.save();}catch(e){Object.assign(row,before);if(immediate)this.active.delete(threadId);throw e;}
      this.changed(row);return this.public(row);
    });
    if(immediate){try{await this.dispatch(immediate,true);}finally{this.active.delete(threadId);}return this.public(immediate);}
    this.schedule();return result;
  }
  private schedule(){if(!this.auto||this.stopped||this.wake||!this.entries.some(e=>e.state==='queued'))return;this.wake=setTimeout(()=>{this.wake=undefined;void this.pump().catch(()=>{});},100);this.wake.unref();}
  private who(row:Entry){const who=this.resolveUser?this.resolveUser(row.owner):this.identities.get(row.owner);if(!who)throw new ConsoleError(403,'QUEUE_OWNER_UNAVAILABLE','发送账户已失效，队列已暂停。');return who;}
  async pump(){
    if(this.stopped)return;
    const heads=new Map<string,Entry>();for(const e of this.entries)if(!terminal(e)&&!heads.has(e.threadId))heads.set(e.threadId,e);
    await Promise.all([...heads.values()].filter(e=>e.state==='queued'&&!this.active.has(e.threadId)).map(async row=>{
      this.active.add(row.threadId);
      try{
        const snapshot=await this.service.snapshot(this.who(row),row.projectId,row.threadId);
        if(snapshot.status==='running')return;
        const claimed=await this.lock(async()=>{if(row.state!=='queued'||this.stopped)return false;row.state='sending';row.version++;await this.save();this.changed(row);return true;});
        if(claimed)await this.dispatch(row,false);
      }catch(e){await this.fail(row,e,false);}
      finally{this.active.delete(row.threadId);}
    }));
  }
  private async dispatch(row:Entry,immediate:boolean){
    let attempted=false;
    try{
      const who=this.who(row);this.service.project(who,row.projectId,'send');
      const snapshot=await this.service.snapshot(who,row.projectId,row.threadId);
      if(!immediate&&snapshot.status==='running'){await this.lock(async()=>{row.state='queued';row.version++;await this.save();this.changed(row);});return;}
      const input={...row.input,...(immediate&&snapshot.status==='running'?{delivery:'steer',expectedTurnId:snapshot.turnId}:{})};
      attempted=true;await this.service.send(who,row.projectId,row.threadId,input);
      await this.lock(async()=>{row.state='sent';row.version++;delete row.input;delete row.error;await this.save();this.changed(row);});
    }catch(e){await this.fail(row,e,attempted);}
  }
  private async fail(row:Entry,error:any,attempted:boolean){
    await this.lock(async()=>{
      if(terminal(row)||row.state==='editing')return;
      row.version++;
      const retry=error instanceof ConsoleError&&busyCodes.has(error.code);
      const uncertain=attempted&&(!(error instanceof ConsoleError)||error.status>=500||['OUTCOME_UNKNOWN','DESKTOP_OUTCOME_UNKNOWN'].includes(error.code));
      row.state=retry?'queued':uncertain?'unknown':'paused';
      row.error=uncertain?'发送结果未知，请先核对聊天；系统不会自动重发。':error instanceof ConsoleError?error.message:'读取任务状态失败，队列已暂停。';
      await this.save();this.changed(row);
    });
  }
  async close(){this.stopped=true;clearTimeout(this.wake);clearInterval(this.interval);this.unsubscribe();await this.writing;}
}
