import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
import {RpcTarget,newMessagePortRpcSession} from 'capnweb';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {DesktopBridge} from '../src/backend/desktop-bridge';
import {DesktopNativeSession} from '../src/backend/desktop-native-session';
test('desktop bridge batch: local-only transport, structured RPC, public events, no reflection or private-reasoning export, cleanup',async()=>{
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{type:'page',url:'app://-/index.html',webSocketDebuggerUrl:`ws://127.0.0.1:${(server.address() as any).port}/bridge`}]))});
  const wss=new WebSocketServer({server});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const listeners=new Set<(event:any)=>void>();let socket:any;const sent:any[]=[];
  const window:any={addEventListener:(_name:string,fn:any)=>listeners.add(fn),removeEventListener:(_name:string,fn:any)=>listeners.delete(fn)};
  function notify(data:any){for(const fn of [...listeners])fn({source:null,data});}
  window.electronBridge={async sendMessageFromView(m:any){sent.push(m);if(m.type==='mcp-request'){const {method,id}=m.request;notify({type:'mcp-response',hostId:'local',message:{id,...(method==='feedback/upload'?{error:{message:'SECRET'}}:{result:{data:[],ok:true}})}});}else notify({type:'fetch-response',requestId:m.requestId,responseType:'success',status:200,body:{threadIds:[]}});}};
  const appCalls:any[]=[];let hostStub:any;
  const projects=new class extends RpcTarget {getLocalProjectsForRenderer(){return {saved:{id:'saved',name:'Native project',rootPaths:['/project']}};}createLocal(p:any){appCalls.push(p);if(p.name==='reject')throw new Error('SECRET_NATIVE_PROJECT_ERROR');return {projectId:'saved',rootPaths:p.sources};}};
  const assignments=new class extends RpcTarget {setAssignment(p:any){appCalls.push(p);}};
  window.location={origin:'app://-'};window.postMessage=(m:any)=>{assert.equal(m.type,'connect-app-host');hostStub=newMessagePortRpcSession(m.port as any,{services:{projects,threadProjectAssignments:assignments}});};
  const context=vm.createContext({window,Set,JSON,Promise,MessageChannel,Error,setTimeout,clearTimeout});
  wss.on('connection',ws=>{socket=ws;ws.on('message',async raw=>{const m=JSON.parse(raw.toString());try{let result:any={};if(m.method==='Runtime.addBinding')window[m.params.name]=(payload:string)=>ws.send(JSON.stringify({method:'Runtime.bindingCalled',params:{name:m.params.name,payload}}));if(m.method==='Runtime.evaluate')result={result:{value:await vm.runInContext(m.params.expression,context)}};ws.send(JSON.stringify({id:m.id,result}));}catch{ws.send(JSON.stringify({id:m.id,result:{exceptionDetails:{text:'failed'}}}));}});});
  const bridge=new DesktopBridge((server.address() as any).port);
  try{await bridge.connect();assert.equal(bridge.available,true);await bridge.rpc('skills/list',{cwds:['test']});await bridge.host('list-pinned-threads',{});await assert.rejects(bridge.rpc('config/read',{}),/不允许/);await assert.rejects(bridge.host('set-global-state',{}),/不允许/);await assert.rejects(bridge.rpc('feedback/upload',{}),e=>!String(e).includes('SECRET'));
    const native=await bridge.app('projects.list',{});assert.equal(native.saved.name,'Native project');
    const created=await bridge.app('projects.create',{name:'New',root:'/project'});assert.equal(created.projectId,'saved');assert.deepEqual(appCalls[0],{appearance:null,initializeDefaultWorkspaceGitRepository:false,name:'New',sources:['/project']});
    await bridge.app('threads.assignProject',{threadId:'task',projectId:'saved'});assert.deepEqual(appCalls[1],{threadId:'task',assignment:{projectKind:'local',projectId:'saved'}});
    await assert.rejects(bridge.app('projects.removeLocal',{}),/不允许/);await assert.rejects(bridge.rpc('project/create',{}),/不允许/);await assert.rejects(bridge.host('get-global-state',{key:'unrelated-secret'}),/不允许/);
    await assert.rejects(bridge.app('projects.create',{name:'reject',root:'/project'}),e=>!String(e).includes('SECRET'));
    const events:any[]=[];const unwatch=await bridge.watch('task',e=>events.push(e));
    for(const [threadId,type] of [['other','agentMessage'],['task','reasoning'],['task','agentMessage']])notify({type:'mcp-notification',hostId:'local',method:'item/started',params:{threadId,turnId:'turn',item:{id:'item',type,text:'public',secret:'private',encrypted_content:'NEVER_FORWARD'}}});
    await new Promise(r=>setTimeout(r,30));assert.equal(events.length,1);assert.equal(events[0].params.item.text,'public');assert.ok(!JSON.stringify(events).includes('private'));assert.ok(!JSON.stringify(events).includes('NEVER_FORWARD'));unwatch();assert.ok(sent.every(m=>m.type==='mcp-request'||m.type==='fetch'));
  }finally{bridge.close();hostStub?.[Symbol.dispose]();socket?.terminate();wss.close();await new Promise<void>(r=>server.close(()=>r()));}
});
test('ownerless desktop task batch: attach/resume without sending, delta/status/settings, follower input, disconnect',async()=>{
  const calls:any[]=[];let listener:(e:any)=>void=()=>{};let unwatched=false;
  const bridge:any={available:true,async watch(_id:string,fn:any){listener=fn;return()=>{unwatched=true;};},async rpc(method:string,params:any){calls.push({method,params});if(method==='thread/resume')return {thread:{id:'task',cwd:'/project',name:'Test',status:{type:'idle'}},model:'test',reasoningEffort:'max',sandbox:{type:'readOnly'},approvalPolicy:'on-request'};if(method==='thread/turns/list')return {data:[{id:'prior',status:'completed',items:[{type:'agentMessage',id:'history',text:'past'},{type:'reasoning',id:'secret',text:'not public'}]}]};return {turn:{id:'turn',status:'inProgress'}};}};
  const session=new DesktopNativeSession('mock','task',bridge);try{await session.connect();assert.equal(calls.length,2);assert.ok(!JSON.stringify(session.state).includes('not public'));
    for(const e of [{method:'turn/started',params:{turn:{id:'turn',status:'inProgress'}}},{method:'item/agentMessage/delta',params:{turnId:'turn',itemId:'item',delta:'hello'}},{method:'item/agentMessage/delta',params:{turnId:'turn',itemId:'item',delta:' world'}},{method:'thread/settings/updated',params:{threadSettings:{model:'changed',effort:'low',cwd:'/project'}}}])listener(e);
    assert.equal(session.state.turns.at(-1).items[0].text,'hello world');assert.equal(session.state.latestThreadSettings.model,'changed');assert.equal(session.state.threadRuntimeStatus.type,'active');await session.request('thread-follower-start-turn',{conversationId:'task',turnStart:{request:{threadId:'task',input:[{type:'skill',name:'sample',path:'/skill'}]}}},2);assert.equal(calls.at(-1).method,'turn/start');assert.equal(calls.at(-1).params.input[0].type,'skill');listener({method:'disconnect'});assert.equal(session.connected,false);
  }finally{session.close();assert.equal(unwatched,true);}
});
