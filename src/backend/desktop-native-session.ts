import {DesktopIpc} from './desktop-ipc';
import type {DesktopBridgeApi} from './desktop-bridge';
import {ConsoleError} from './config';
import {restoredTokenUsage} from './context';
import {textPrefix} from './text';
/** Same running desktop backend for tasks without a view-owner; event-driven, never polling or spawning. */
export class DesktopNativeSession extends DesktopIpc {
  private unwatch?:()=>void;private queued:any[]=[];private loading=false;
  constructor(endpoint:string,id:string,private bridge:DesktopBridgeApi){super(endpoint,id);}
  override async connect(){
    if(this.connected)return;if(!this.bridge.watch)throw new Error('Desktop event bridge unavailable');
    this.loading=true;
    this.unwatch=await this.bridge.watch(this.threadId,event=>{if(event.method==='disconnect'){this.connected=false;this.emit('disconnect');return;}if(this.loading){if(this.queued.length<1000)this.queued.push(event);return;}this.reduce(event);});
    try{const resumed=await this.bridge.rpc('thread/resume',{threadId:this.threadId,excludeTurns:true});const thread=resumed.thread;
      this.state={latestTokenUsageInfo:await restoredTokenUsage(thread),cwd:thread.cwd,title:thread.name||thread.preview||thread.id,threadRuntimeStatus:thread.status,modelProvider:resumed.modelProvider,latestThreadSettings:{model:resumed.model,effort:resumed.reasoningEffort},currentPermissions:{sandboxPolicy:resumed.sandbox,approvalPolicy:resumed.approvalPolicy},turns:[]};
      await this.refresh();this.connected=true;this.ownerId='existing-desktop-backend';this.loading=false;for(const event of this.queued)this.reduce(event);this.queued=[];this.emit('state',this.state);
    }catch(error){this.loading=false;this.close();throw error;}
  }
  override async refresh(){const history=await this.bridge.rpc('thread/turns/list',{threadId:this.threadId,limit:20,sortDirection:'desc',itemsView:'full'});this.state.turns=[...(history.data||[])].reverse().map((t:any)=>({...t,turnId:t.id,items:(t.items||[]).filter((i:any)=>i.type!=='reasoning')}));this.trim();this.emit('state',this.state);}
  private trim(){let chars=0,count=0;this.state.turns=this.state.turns.slice(-20);for(const t of [...this.state.turns].reverse()){const kept=[];for(const item of [...(t.items||[])].reverse()){const size=JSON.stringify(item).length;if(count>=200||chars+size>600*1024)continue;count++;chars+=size;kept.unshift(item);}t.items=kept;}}
  private reduce(event:any){const p=event.params||{},state=this.state;if(!state)return;const turns=state.turns;
    const turn=(id:string)=>{let t=turns.find((t:any)=>t.id===id);if(!t){t={id,turnId:id,status:'inProgress',items:[]};turns.push(t);}return t;};
    switch(event.method){
      case 'thread/status/changed':state.threadRuntimeStatus=p.status;break;
      case 'thread/settings/updated':state.latestThreadSettings=p.threadSettings;state.currentPermissions=p.threadSettings;if(p.threadSettings?.cwd)state.cwd=p.threadSettings.cwd;break;
      case 'thread/name/updated':state.title=p.threadName;break;
      case 'thread/tokenUsage/updated':state.latestTokenUsageInfo=p.tokenUsage;break;
      case 'thread/goal/updated':state.threadGoal=p.goal;break;
      case 'turn/started':case 'turn/completed':Object.assign(turn(p.turn.id),p.turn);state.threadRuntimeStatus={type:event.method==='turn/started'?'active':'idle'};break;
      case 'item/started':case 'item/completed':{const t=turn(p.turnId||turns.at(-1)?.id||'live'),index=t.items.findIndex((i:any)=>i.id===p.item.id);if(index<0)t.items.push(p.item);else t.items[index]=p.item;break;}
      case 'item/agentMessage/delta':case 'item/commandExecution/outputDelta':case 'item/plan/delta':{const t=turn(p.turnId||turns.at(-1)?.id||'live');let item=t.items.find((i:any)=>i.id===p.itemId);if(!item){item={id:p.itemId,type:event.method.includes('agentMessage')?'agentMessage':event.method.includes('plan')?'plan':'commandExecution',text:''};t.items.push(item);}const field=item.type==='commandExecution'?'aggregatedOutput':'text';if(!item.truncated){const text=(item[field]||'').concat(p.delta);item[field]=textPrefix(text,65536);item.truncated=text.length>65536;}break;}
      case 'error':turn(turns.at(-1)?.id||'live').items.push({id:'error-'+Date.now(),type:'other',text:p.error?.message,status:'failed'});break;
    }
    this.trim();this.emit('state',state);
  }
  override async request(method:string,params:any,_version:number):Promise<any>{
    if(params.conversationId!==this.threadId)throw new ConsoleError(403,'THREAD_FORBIDDEN','任务不匹配。');
    if(method==='thread-follower-start-turn'){const result=await this.bridge.rpc('turn/start',params.turnStart.request);return {result:{result}};}
    if(method==='thread-follower-compact-thread'){await this.bridge.rpc('thread/compact/start',{threadId:this.threadId});return {result:{ok:true}};}
    if(method==='thread-follower-interrupt-turn'){const turnId=params.expectedTurnId||this.state.turns.at(-1)?.id;if(!turnId)throw new ConsoleError(409,'NO_ACTIVE_TURN','没有运行中的消息。');await this.bridge.rpc('turn/interrupt',{threadId:this.threadId,turnId});return {result:{ok:true}};}
    throw new ConsoleError(400,'DESKTOP_METHOD_DENIED','不支持此任务操作。');
  }
  override close(){this.unwatch?.();this.unwatch=undefined;this.connected=false;this.queued=[];}
}
