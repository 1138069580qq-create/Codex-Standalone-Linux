import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// Explicit local desktop attachment. This connects to the existing router; it never creates a router or Codex process.
export class DesktopIpc extends EventEmitter {
  private socket?: net.Socket;
  private buffer=Buffer.alloc(0);
  private refreshing?:Promise<void>;
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  clientId='uninitialized'; ownerId=''; connected=false; state:any; revision=0;
  constructor(readonly endpoint:string,readonly threadId:string){super();}
  async connect(){
    if(this.connected)return;
    this.clientId='uninitialized';this.ownerId='';this.state=undefined;this.revision=0;this.buffer=Buffer.alloc(0);
    try{
    this.socket=net.connect(this.endpoint);
    this.socket.on('data',b=>this.data(b));this.socket.on('error',()=>this.close());this.socket.on('close',()=>{this.close();this.emit('disconnect');});
    await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Desktop IPC connection timed out')),5000);this.socket!.once('connect',()=>{clearTimeout(timeout);resolve();});this.socket!.once('error',e=>{clearTimeout(timeout);reject(e);});});
    const initialized=await this.request('initialize',{clientType:'codex-standalone-webui'},0);
    this.clientId=initialized.result.clientId;
    const owner=await this.request('thread-owner-discovery',{hostId:'local',conversationId:this.threadId},1);
    if(owner.result?.supportsUntrustedAppInput!==true)throw new Error('The desktop owner does not support this input protocol.');
    if(typeof owner.handledByClientId!=='string'||!owner.handledByClientId)throw new Error('Desktop owner was not identified.');
    this.ownerId=owner.handledByClientId;this.connected=true;
    this.broadcast('thread-stream-following-changed',{conversationId:this.threadId,hostId:'local',following:true,targetClientIds:[this.ownerId]},1);
    await this.refresh();
    if(!this.state)throw new Error('Desktop did not provide a thread snapshot.');
    }catch(error){this.close();throw error;}
  }
  private write(message:any){
    if(!this.socket?.writable)throw new Error('Desktop IPC disconnected.');
    const body=Buffer.from(JSON.stringify(message)),header=Buffer.alloc(4);header.writeUInt32LE(body.length);
    if(body.length>2*1024*1024)throw new Error('Desktop IPC outgoing request too large.');
    this.socket.write(Buffer.concat([header,body]));
  }
  request(method:string,params:any,version:number){
    const requestId=randomUUID();
    return new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('Desktop request timed out; not retried.'));},30_000);
      this.pending.set(requestId,{resolve,reject,timer});
      try{this.write({type:'request',requestId,sourceClientId:this.clientId,method,params,version,...(this.ownerId?{targetClientId:this.ownerId}:{}),timeoutMs:30_000});}catch(e){clearTimeout(timer);this.pending.delete(requestId);reject(e as Error);}
    });
  }
  broadcast(method:string,params:any,version:number){this.write({type:'broadcast',sourceClientId:this.clientId,targetClientIds:[this.ownerId],method,params,version});}
  async refresh(){
    if(this.refreshing)return this.refreshing;
    const pending=this.request('thread-follower-load-complete-history',{conversationId:this.threadId},1).then(()=>{});this.refreshing=pending;
    try{await pending;}finally{if(this.refreshing===pending)this.refreshing=undefined;}
  }
  private data(chunk:Buffer){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    try{while(this.buffer.length>=4){const length=this.buffer.readUInt32LE(0);if(length<=0||length>32*1024*1024)throw new Error('Invalid desktop frame');if(this.buffer.length<length+4)return;const message=JSON.parse(this.buffer.subarray(4,length+4).toString());this.buffer=this.buffer.subarray(length+4);this.receive(message);}}catch{this.close();}
  }
  private receive(m:any){
    if(m.type==='client-discovery-request'){this.write({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:false}});return;}
    if(m.type==='response'){const item=this.pending.get(m.requestId);if(!item)return;clearTimeout(item.timer);this.pending.delete(m.requestId);m.resultType==='success'?item.resolve(m):item.reject(new Error(typeof m.error==='string'?m.error:'Desktop rejected the request'));return;}
    if(m.type!=='broadcast'||m.sourceClientId!==this.ownerId||m.method!=='thread-stream-state-changed'||m.params?.conversationId!==this.threadId)return;
    const change=m.params.change;
    if(m.version!==11)return;
    if(change?.type==='snapshot'){this.state=change.conversationState;this.revision=change.revision;}
    else if(change?.type==='patches'&&this.state){if(change.baseRevision!==this.revision){void this.refresh().catch(()=>this.close());return;}for(const patch of change.patches||[])this.patch(patch);this.revision=change.revision;}
    else return;
    this.emit('state',this.state);
  }
  private patch(p:any){
    if(!['add','replace','remove'].includes(p.op)||!Array.isArray(p.path)||p.path.some((s:any)=>['__proto__','constructor','prototype'].includes(String(s))))throw new Error('Invalid desktop patch');
    if(!p.path.length){this.state=p.value;return;}
    let parent=this.state;for(const key of p.path.slice(0,-1)){if(parent==null)throw new Error('Missing desktop patch parent');parent=parent[key];}
    const last=p.path.at(-1);
    if(Array.isArray(parent)&&p.op==='remove')parent.splice(Number(last),1);
    else if(Array.isArray(parent)&&p.op==='add')parent.splice(Number(last),0,p.value);
    else if(p.op==='remove')delete parent[last];else parent[last]=p.value;
  }
  close(){
    if(this.connected&&this.socket?.writable)try{this.broadcast('thread-stream-following-changed',{conversationId:this.threadId,hostId:'local',following:false,targetClientIds:[this.ownerId]},1);}catch{}
    this.connected=false;this.socket?.destroy();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Desktop disconnected'));}this.pending.clear();
  }
}
