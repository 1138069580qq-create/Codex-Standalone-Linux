import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { ConsoleError } from './config';
import { DesktopAppSession } from './desktop-app-session';
export interface DesktopBridgeApi {
  available:boolean;
  connect():Promise<void>;
  rpc(method:string,params:any):Promise<any>;
  host(route:string,params:any):Promise<any>;
  app?(method:string,params:any):Promise<any>;
  watch?(threadId:string,listener:(event:any)=>void):Promise<()=>void>;
  close():void;
}
const rpcMethods=new Set(['skills/list','plugin/installed','mcpServerStatus/list','account/rateLimits/read','account/rateLimitResetCredit/consume','project/list','thread/metadata/update','turn/start','turn/interrupt','thread/compact/start','thread/start','thread/resume','thread/read','thread/list','thread/turns/list','thread/goal/get','thread/goal/set','thread/name/set','thread/archive','thread/fork','review/start','feedback/upload']);
const hostRoutes=new Set(['get-global-state','projectless-thread-cwd','projectless-workspace-root','set-thread-pinned','list-pinned-threads']);
/** Opt-in attachment to the existing desktop's local debug endpoint. No browser/Codex process launch.
 * The HTTP service never accepts JavaScript, CDP methods, or arbitrary host routes from a client.
 */
export class DesktopBridge implements DesktopBridgeApi {
  private appSession?:DesktopAppSession;private appBindings=new Map<string,(payload:string)=>void>();
  available=false;private socket?:WebSocket;private next=0;
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private listeners=new Map<string,Set<(event:any)=>void>>();
  private binding='webuiEvents_'+randomUUID().replaceAll('-','');private watching=false;
  constructor(private port:number){if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid desktop bridge port');}
  async connect(){
    if(this.available)return;
    const targets=await fetch(`http://127.0.0.1:${this.port}/json/list`,{signal:AbortSignal.timeout(5000)}).then(r=>r.json()) as any[];
    const target=targets.find(t=>t.type==='page'&&t.url==='app://-/index.html');
    if(!target)throw new Error('Existing Codex main view is unavailable');
    const url=new URL(target.webSocketDebuggerUrl);
    if(url.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.port!==String(this.port))throw new Error('Non-local desktop bridge rejected');
    const socket=this.socket=new WebSocket(url,{maxPayload:8*1024*1024});
    socket.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.method==='Runtime.bindingCalled'&&this.appBindings.has(m.params?.name)){this.appBindings.get(m.params.name)!(m.params.payload);return;}if(m.method==='Runtime.bindingCalled'&&m.params?.name===this.binding){const event=JSON.parse(m.params.payload);for(const fn of this.listeners.get(event.threadId)||[])fn(event);return;}const entry=this.pending.get(m.id);if(!entry)return;clearTimeout(entry.timer);this.pending.delete(m.id);m.error?entry.reject(new Error('Desktop bridge request failed')):entry.resolve(m.result);}catch{this.close();}});
    socket.on('close',()=>this.close());socket.on('error',()=>this.close());
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error('Desktop bridge timed out'));},5000);socket.once('open',()=>{clearTimeout(timer);resolve();});socket.once('error',()=>{clearTimeout(timer);reject(new Error('Desktop bridge unavailable'));});});
    const probe=await this.evaluate('Boolean(window.electronBridge?.sendMessageFromView)');
    if(!probe){this.close();throw new Error('Desktop host bridge is unavailable');}this.available=true;
  }
  private async cdp(method:string,params:any){
    const socket=this.socket;if(!socket||socket.readyState!==WebSocket.OPEN)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面功能连接已断开，请刷新连接。');
    const id=++this.next;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new ConsoleError(504,'DESKTOP_OUTCOME_UNKNOWN','桌面操作超时，结果未知；请检查桌面，不要重复提交。'));},35000);this.pending.set(id,{resolve,reject,timer});try{socket.send(JSON.stringify({id,method,params}));}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
  }
  private async evaluate(expression:string){
    if(expression.length>256*1024)throw new ConsoleError(400,'DESKTOP_REQUEST_LARGE','请求过大。');
    const reply=await this.cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(reply.exceptionDetails)throw new ConsoleError(502,'DESKTOP_BRIDGE_REJECTED','桌面拒绝此操作；请查看桌面状态。');return reply.result?.value;
  }
  async watch(threadId:string,listener:(event:any)=>void){
    if(!/^[-a-zA-Z0-9_]{1,128}$/.test(threadId))throw new Error('Invalid task ID');
    if(!this.watching){await this.cdp('Runtime.enable',{});await this.cdp('Runtime.addBinding',{name:this.binding});
      await this.evaluate('(()=>{const __name=(value)=>value;return ('+installDesktopEventListener.toString()+')('+JSON.stringify(this.binding)+')})()');this.watching=true;}
    const listeners=this.listeners.get(threadId)||new Set();listeners.add(listener);this.listeners.set(threadId,listeners);
    await this.evaluate('window['+JSON.stringify(this.binding+'_state')+'].ids.add('+JSON.stringify(threadId)+')');
    return ()=>{listeners.delete(listener);if(!listeners.size){this.listeners.delete(threadId);if(this.available)void this.evaluate('window['+JSON.stringify(this.binding+'_state')+']?.ids.delete('+JSON.stringify(threadId)+')').catch(()=>{});}};
  }
  async rpc(method:string,params:any){if(!rpcMethods.has(method))throw new ConsoleError(400,'DESKTOP_METHOD_DENIED','不允许的桌面操作。');return this.exchange('rpc',method,params);}
  async host(route:string,params:any){if(route==='get-global-state'&&!['app-server-project-id-by-legacy-project-id-by-host','thread-project-assignments'].includes(params?.key))throw new ConsoleError(400,'DESKTOP_METHOD_DENIED','不允许读取此桌面状态。');if(!hostRoutes.has(route))throw new ConsoleError(400,'DESKTOP_METHOD_DENIED','不允许的桌面操作。');return this.exchange('host',route,params);}
  async app(method:string,params:any){
    if(!this.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面功能接口未连接。');
    this.appSession ||= new DesktopAppSession(expression=>this.evaluate(expression),async(name,listener)=>{this.appBindings.set(name,listener);await this.cdp('Runtime.addBinding',{name});},name=>{this.appBindings.delete(name);if(this.socket?.readyState===WebSocket.OPEN)void this.cdp('Runtime.removeBinding',{name}).catch(()=>{});});
    return this.appSession.call(method,params);
  }
  private async exchange(kind:'rpc'|'host',method:string,params:any){
    if(!this.available)throw new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面功能接口未连接。');
    const request={kind,method,params,id:'webui-'+randomUUID()};
    // Listen only for this request's public response, never inspect unrelated messages or credentials.
    const reply=await this.evaluate(`(async()=>{const r=${JSON.stringify(request)};return await new Promise((resolve)=>{let timer;const finish=value=>{clearTimeout(timer);window.removeEventListener('message',receive);resolve(value)};const receive=event=>{if(event.source!==window&&event.source!==null)return;const m=event.data;if(r.kind==='rpc'&&m?.type==='mcp-response'&&m.hostId==='local'&&m.message?.id===r.id)finish(m.message.error?{ok:false}:{ok:true,value:m.message.result});if(r.kind==='host'&&m?.type==='fetch-response'&&m.requestId===r.id){if(m.responseType!=='success'||m.status<200||m.status>=300)return finish({ok:false});try{finish({ok:true,value:'body' in m?m.body:JSON.parse(m.bodyJsonString)})}catch{finish({ok:false})}}};window.addEventListener('message',receive);timer=setTimeout(()=>finish({ok:false,unknown:true}),30000);const message=r.kind==='rpc'?{type:'mcp-request',hostId:'local',request:{id:r.id,method:r.method,params:r.params}}:{type:'fetch',requestId:r.id,method:'POST',url:'vscode://codex/'+r.method,body:JSON.stringify(r.params)};Promise.resolve(window.electronBridge.sendMessageFromView(message)).catch(()=>finish({ok:false}));});})()`);
    if(!reply?.ok)throw new ConsoleError(reply?.unknown?504:502,reply?.unknown?'DESKTOP_OUTCOME_UNKNOWN':'DESKTOP_BRIDGE_REJECTED',reply?.unknown?'桌面操作超时，结果未知；请检查桌面，不要重复提交。':'桌面未能完成此操作。');
    return reply.value;
  }
  close(){this.appSession?.close();this.appSession=undefined;this.appBindings.clear();if(this.watching&&this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({id:++this.next,method:'Runtime.evaluate',params:{expression:'window['+JSON.stringify(this.binding+'_state')+']?.close()'}}));this.watching=false;for(const [id,listeners] of this.listeners)for(const fn of listeners)fn({threadId:id,method:'disconnect'});this.listeners.clear();this.available=false;const socket=this.socket;this.socket=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new ConsoleError(503,'DESKTOP_BRIDGE_OFFLINE','桌面功能连接已断开；写入结果可能未知。'));}this.pending.clear();if(socket){socket.removeAllListeners();socket.on('error',()=>{});socket.close();}}
}

/** Executed in the already-running desktop. Only bounded public events of explicitly attached tasks leave it. */
function installDesktopEventListener(name:string){
  const w=window as any;const ids=new Set<string>();
  const types=new Set(['thread/status/changed','thread/settings/updated','thread/name/updated','thread/tokenUsage/updated','thread/goal/updated','turn/started','turn/completed','item/started','item/completed','item/agentMessage/delta','item/commandExecution/outputDelta','item/plan/delta','error','thread/compacted']);
  function item(value:any){if(!value||value.type==='reasoning')return null;const result:any={id:value.id,type:value.type,status:value.status};if(value.type==='userMessage')result.content=(value.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>({type:'text',text:String(c.text||'').slice(0,65536)}));else if(value.type==='fileChange')result.changes=(value.changes||[]).slice(0,100).map((c:any)=>({path:c.path,kind:c.kind}));else if(value.type==='commandExecution'){result.command=String(value.command||'').slice(0,8192);result.aggregatedOutput=String(value.aggregatedOutput||'').slice(-65536);}else result.text=String(value.text||'').slice(0,65536);return result;}
  const receive=(event:MessageEvent)=>{if(event.source!==window&&event.source!==null)return;const m=event.data,p=m?.params,id=p?.threadId||p?.thread?.id;if(m?.type!=='mcp-notification'||m.hostId!=='local'||!ids.has(id)||!types.has(m.method))return;const result:any={threadId:id,method:m.method,params:{threadId:id}};const r=result.params;
    if(m.method==='item/started'||m.method==='item/completed'){r.item=item(p.item);if(!r.item)return;r.turnId=p.turnId;}
    else if(m.method.startsWith('item/')){r.delta=String(p.delta||'').slice(0,65536);r.itemId=p.itemId;r.turnId=p.turnId;}
    else if(m.method==='turn/started'||m.method==='turn/completed')r.turn={id:p.turn?.id,status:p.turn?.status};
    else if(m.method==='thread/settings/updated'){const s=p.threadSettings||{};r.threadSettings={model:s.model,modelProvider:s.modelProvider,effort:s.effort,cwd:s.cwd,approvalPolicy:s.approvalPolicy,sandboxPolicy:s.sandboxPolicy,collaborationMode:s.collaborationMode?{mode:s.collaborationMode.mode,settings:{model:s.collaborationMode.settings?.model,reasoning_effort:s.collaborationMode.settings?.reasoning_effort}}:undefined};}
    else if(m.method==='thread/status/changed')r.status=p.status;
    else if(m.method==='thread/name/updated')r.threadName=p.threadName;
    else if(m.method==='thread/tokenUsage/updated')r.tokenUsage=p.tokenUsage;
    else if(m.method==='thread/goal/updated')r.goal=p.goal?{objective:p.goal.objective,status:p.goal.status}:null;
    else if(m.method==='error')r.error={message:String(p.error?.message||'Codex error').slice(0,8192)};
    const text=JSON.stringify(result);if(text.length<262144)w[name](text);
  };
  window.addEventListener('message',receive);w[name+'_state']={ids,close:()=>{window.removeEventListener('message',receive);delete w[name+'_state'];}};return true;
}
