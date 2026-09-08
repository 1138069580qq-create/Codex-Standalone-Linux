import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { UserStore } from '../src/auth';
import { ProtectedConfigStore } from '../src/protected-config';
import { createApp } from '../src/server';
import { DesktopIpc } from '../src/backend/desktop-ipc';
import { DesktopSessionService } from '../src/backend/desktop-session';

// Explicit user-driven local attachment. No spawn/exec, no model invocation, no new thread.
async function main(){
  const threadId=process.env.CODEX_DESKTOP_THREAD_ID;
  if(!threadId||!/^[-a-zA-Z0-9_]{1,128}$/.test(threadId))throw new Error('Set CODEX_DESKTOP_THREAD_ID to the existing desktop task to attach.');
  const endpoint=process.platform==='win32'?'\\\\.\\pipe\\codex-ipc':path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'ipc','ipc.sock');
  const desktop=new DesktopIpc(endpoint,threadId);await desktop.connect();
  const root=await fs.realpath(desktop.state.cwd);
  const dataDir=path.resolve(process.env.CODEX_DESKTOP_WEBUI_DATA||path.join(os.homedir(),'.local/share/codex-webui-desktop-test'));
  const users=new UserStore(path.join(dataDir,'users.json'));await users.load();
  let password=process.env.CODEX_DESKTOP_WEBUI_PASSWORD;
  if(!users.users.length){password ||= randomBytes(14).toString('base64url');await users.upsert({username:'desktop-test',password,admin:true});}
  const config=new ProtectedConfigStore(path.join(dataDir,'config.json'));
  await config.save({enabled:true,transport:{type:'unix',endpoint},maxConcurrentTurns:1,projects:[{id:'desktop',name:'桌面当前任务',root,grants:[]}]});
  const port=Number(process.env.CODEX_WEBUI_PORT||3210);
  const runtime=await createApp({host:'127.0.0.1',port,dataDir,origin:`http://127.0.0.1:${port}`,secureCookies:false},(c,r)=>new DesktopSessionService(c,r,desktop));
  await runtime.service.connect();
  const server=runtime.app.listen(port,'127.0.0.1');
  server.on('error',()=>{runtime.close();console.error('Could not listen on the requested port.');process.exitCode=1;});
  const stop=()=>{runtime.close();server.closeAllConnections();server.close();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  server.once('listening',()=>console.log(JSON.stringify({ready:true,url:`http://127.0.0.1:${port}`,threadId,ownerClientId:desktop.ownerId,username:'desktop-test',...(password?{initialPassword:password}:{}),pid:process.pid,codexProcessesStarted:0,modelMessagesSent:0})));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
