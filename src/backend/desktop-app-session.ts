import {RpcSession,type RpcTransportWithCustomEncoding} from 'capnweb';
import {randomUUID} from 'node:crypto';
import {ConsoleError} from './config';

const methods=new Set(['projects.list','projects.create','threads.assignProject']);
/** A separate connection to the existing desktop's own app-host services, not an agent/session. */
export class DesktopAppSession {
  private binding='__codex_webui_projects_'+randomUUID().replaceAll('-','');
  private queue:unknown[]=[];
  private waiting?:{resolve:(value:unknown)=>void;reject:(error:Error)=>void};
  private failed?:Error;private opening?:Promise<void>;private remote:any;
  constructor(private evaluate:(expression:string)=>Promise<any>,private addBinding:(name:string,listener:(payload:string)=>void)=>Promise<void>,private removeBinding:(name:string)=>void){}
  private receive(payload:string){
    try{
      if(payload.length>1024*1024)throw new Error('Oversized desktop app response');
      const value=JSON.parse(payload,(_key,v)=>v?.__webuiNativeError===true?new Error('Desktop app operation failed'):v);
      if(value===null)throw new Error('Desktop app connection closed');
      if(this.failed)return;
      if(this.waiting){const {resolve}=this.waiting;this.waiting=undefined;resolve(value);}
      else {if(this.queue.length>=128)throw new Error('Desktop app response queue full');this.queue.push(value);}
    }catch{this.close();}
  }
  private async open(){
    if(this.failed)throw this.failed;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      await this.addBinding(this.binding,payload=>this.receive(payload));
      await this.evaluate(`(()=>{const name=${JSON.stringify(this.binding)};const {port1,port2}=new MessageChannel();window[name+'_port']=port1;port1.onmessage=event=>{const data=JSON.stringify(event.data,(_key,value)=>value instanceof Error?{__webuiNativeError:true}:value);window[name](data)};port1.onmessageerror=()=>window[name]('null');port1.start();window.postMessage({type:'connect-app-host',port:port2},window.location.origin,[port2]);return true;})()`);
      const transport:RpcTransportWithCustomEncoding={encodingLevel:'structuredClonable',send:message=>{
        if(this.failed)throw this.failed;const data=JSON.stringify(message);if(data.length>128*1024){this.close();throw new Error('Desktop app request too large');}
        void this.evaluate(`window[${JSON.stringify(this.binding+'_port')}].postMessage(${data})`).catch(()=>this.close());
      },receive:()=>{if(this.failed)return Promise.reject(this.failed);if(this.queue.length)return Promise.resolve(this.queue.shift());return new Promise((resolve,reject)=>{this.waiting={resolve,reject};});},abort:()=>this.close()};
      this.remote=new RpcSession<any>(transport).getRemoteMain();
    })();return this.opening;
  }
  async call(method:string,params:any){
    if(!methods.has(method))throw new ConsoleError(400,'DESKTOP_METHOD_DENIED','不允许的桌面项目操作。');
    await this.open();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const result=(async()=>{
        const services=this.remote.services;
        if(method==='projects.list')return await services.projects.getLocalProjectsForRenderer();
        if(method==='projects.create')return await services.projects.createLocal({appearance:null,initializeDefaultWorkspaceGitRepository:false,name:params.name,sources:[params.root]});
        return await services.threadProjectAssignments.setAssignment({threadId:params.threadId,assignment:{projectKind:'local',projectId:params.projectId}});
      })();
      return await Promise.race([result,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ConsoleError(504,'DESKTOP_OUTCOME_UNKNOWN','桌面项目操作超时，结果未知；请刷新项目列表，不要重复提交。')),30000);})]);
    }catch(e){if(e instanceof ConsoleError)throw e;throw new ConsoleError(502,'DESKTOP_PROJECT_REJECTED','桌面未能保存项目或任务归属，未发送消息。');}
    finally{if(timer)clearTimeout(timer);}
  }
  close(){
    if(this.failed)return;this.failed=new Error('Desktop app project connection closed');this.waiting?.reject(this.failed);this.waiting=undefined;this.queue=[];
    if(this.opening)void this.evaluate(`(()=>{const key=${JSON.stringify(this.binding+'_port')};const port=window[key];if(port){port.postMessage(null);port.close();delete window[key]}})()`).catch(()=>{});
    this.removeBinding(this.binding);
  }
}
