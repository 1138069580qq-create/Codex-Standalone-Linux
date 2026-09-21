import path from 'node:path';
import os from 'node:os';
import {resumeThread} from './thread-resume';
import {createHash} from 'node:crypto';
import {ConsoleError,type ConfigStore,type Identity} from './config';
import {ensureStorage} from './account-storage';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const locality=new WeakMap<ConfigStore,Set<string>>();
function localThreads(store:ConfigStore){let set=locality.get(store);if(!set){let rows:string[]=[];try{rows=JSON.parse(readFileSync(path.join(path.dirname(store.file),'local-workspace-threads.json'),'utf8'));if(!Array.isArray(rows)||rows.some(r=>typeof r!=='string'))throw new Error('Invalid local workspace registry');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}set=new Set(rows);locality.set(store,set);}return set;}
export function isLocalThread(store:ConfigStore,who:Identity,id:string){return localThreads(store).has(JSON.stringify([who.uuid,id]));}
const localTools=new WeakMap<ConfigStore,Map<string,any>>();
export function setLocalTools(store:ConfigStore,who:Identity,id:string,config:any){let map=localTools.get(store);if(!map)localTools.set(store,map=new Map());const key=JSON.stringify([who.uuid,id]);if(config){const set=localThreads(store);if(!set.has(key)){set.add(key);const file=path.join(path.dirname(store.file),'local-workspace-threads.json');writeFileSync(file+'.next',JSON.stringify([...set]),{mode:0o600});renameSync(file+'.next',file);}map.set(key,config);}else map.delete(key);}
export function getLocalTools(store:ConfigStore,who:Identity,id:string){return localTools.get(store)?.get(JSON.stringify([who.uuid,id]));}
type Rpc=(method:string,params:any)=>Promise<any>;
export async function accountProfile(store:ConfigStore,who:Identity,root:string,mode:unknown,_rpc:Rpc){
 if(!who.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');
 if(!['default','read-only','full',undefined].includes(mode as any))throw new ConsoleError(400,'INVALID_ACCESS','无效的访问权限。');
 const library=await ensureStorage(store.file,who),access=mode==='read-only'?'read':'write';
 const id='webui_'+createHash('sha256').update(JSON.stringify([who.uuid,root,library,access])).digest('hex').slice(0,32);
 return {id,root:path.resolve(root),config:{default_permissions:id,permissions:{[id]:{filesystem:{':minimal':'read',[path.join(os.homedir(),'.codex/skills/.system')]:'read',[path.resolve(root)]:access,[library]:access},network:{enabled:false}}}}};
}
export function verifyAccountProfile(value:any,profile:{id:string;root:string}){
 if(value?.activePermissionProfile?.id!==profile.id||value?.approvalPolicy!=='never'||path.resolve(value?.thread?.cwd||'')!==profile.root)throw new ConsoleError(503,'ISOLATION_UNAVAILABLE','服务器未确认账号文件隔离，未发送消息。');
}
export async function isolateAccountThread(store:ConfigStore,who:Identity,root:string,threadId:string,mode:unknown,rpc:Rpc){
 const local=isLocalThread(store,who,threadId),tools=getLocalTools(store,who,threadId);if(local&&!tools)throw new ConsoleError(409,'LOCAL_DEVICE_OFFLINE','请重新连接本机项目，消息未发送。');
 const profile=await accountProfile(store,who,root,local?'read-only':mode,rpc);
 const result=await resumeThread(rpc,{threadId,cwd:profile.root,excludeTurns:true,approvalPolicy:'never',config:{...profile.config,...(getLocalTools(store,who,threadId)||{})}});verifyAccountProfile(result,profile);return profile;
}
