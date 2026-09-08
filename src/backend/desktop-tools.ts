import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ConsoleError } from './config';
export interface DesktopToolContext {threadId:string;turnId:string}
export interface DesktopTaskTools {
  discover():Promise<boolean>;
  listProjects():Promise<any>;
  listThreads():Promise<any>;
  readThread(threadId:string):Promise<any>;
  createTask(args:any,requestId:string):Promise<any>;
  close():void;
}
/** Client of the already-running desktop task-management endpoint. No process launch or credential lookup. */
export class DesktopTools implements DesktopTaskTools {
  private socket?:net.Socket;private connecting?:Promise<void>;private buffer=Buffer.alloc(0);
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private available=new Set<string>();
  constructor(private endpoint:string,private context:()=>DesktopToolContext){}
  private async connect(){
    if(this.socket?.writable)return;if(this.connecting)return this.connecting;
    const socket=net.connect(this.endpoint);this.socket=socket;this.buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{if(socket!==this.socket)return;this.buffer=Buffer.concat([this.buffer,chunk]);try{while(this.buffer.length>=4){const size=this.buffer.readUInt32LE(0);if(size<=0||size>8*1024*1024)throw new Error('Invalid desktop tools frame');if(this.buffer.length<size+4)return;const message=JSON.parse(this.buffer.subarray(4,size+4).toString('utf8'));this.buffer=this.buffer.subarray(size+4);const item=this.pending.get(String(message.id));if(!item)continue;clearTimeout(item.timer);this.pending.delete(String(message.id));if(message.error)item.reject(new ConsoleError(502,'DESKTOP_TOOLS_ERROR','桌面任务接口拒绝了请求，请在桌面查看详情。'));else item.resolve(message.result);}}catch{this.close();}});
    socket.on('error',()=>this.disconnect(socket));socket.on('close',()=>this.disconnect(socket));
    const connecting=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(new Error('Desktop tools connection timed out'));},5000);socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.once('error',e=>{clearTimeout(timer);reject(e);});});
    this.connecting=connecting;try{await connecting;}finally{if(this.connecting===connecting)this.connecting=undefined;}
  }
  private disconnect(socket:net.Socket){if(socket!==this.socket)return;this.socket=undefined;this.buffer=Buffer.alloc(0);for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new ConsoleError(503,'DESKTOP_TOOLS_OFFLINE','桌面任务接口已断开；创建结果需重新检查，不能自动重发。'));}this.pending.clear();socket.destroy();}
  private async request(method:string,params?:any,timeout=15000){
    await this.connect();const id=randomUUID();const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})}));if(body.length>2*1024*1024)throw new Error('Desktop tools request too large');const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
    return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new ConsoleError(504,'DESKTOP_TOOLS_TIMEOUT','桌面操作尚未确认，请检查创建状态，不要重复提交。'));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.socket!.write(Buffer.concat([header,body]));}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
  }
  async discover(){const result=await this.request('tools/list');this.available=new Set((result?.tools||[]).filter((t:any)=>t.namespace==='codex_app').map((t:any)=>t.name));return ['create_thread','list_projects','list_threads','read_thread'].every(name=>this.available.has(name));}
  private async call(tool:string,args:any,callId:string=randomUUID()){
    if(!this.available.has(tool))throw new ConsoleError(501,'DESKTOP_TOOL_UNAVAILABLE','当前桌面未开放此任务管理操作。');
    const context=this.context();if(!context.threadId||!context.turnId)throw new ConsoleError(409,'DESKTOP_CONTEXT_UNAVAILABLE','桌面任务上下文尚未就绪。');
    const response=await this.request('tools/call',{namespace:'codex_app',tool,arguments:args,...context,callId:'webui-'+callId},tool==='create_thread'?90000:15000);
    if(response?.success!==true)throw new ConsoleError(502,'DESKTOP_TOOL_REJECTED','桌面未能完成任务操作，请在桌面查看详情。');
    const item=response.contentItems?.find((v:any)=>v.type==='inputText');try{return JSON.parse(item.text);}catch{throw new ConsoleError(502,'DESKTOP_TOOL_FORMAT','桌面返回了无法识别的任务结果。');}
  }
  listProjects(){return this.call('list_projects',{});}
  listThreads(){return this.call('list_threads',{limit:100});}
  readThread(threadId:string){if(threadId.startsWith('client-new-thread:'))throw new Error('A pending desktop ID is not a task ID');return this.call('read_thread',{threadId,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:128});}
  createTask(args:any,requestId:string){return this.call('create_thread',args,requestId);}
  close(){if(this.socket)this.disconnect(this.socket);}
}
