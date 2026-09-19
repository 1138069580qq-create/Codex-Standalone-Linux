import test from 'node:test';
import assert from 'node:assert/strict';
import {failureLocations,publicBackendError} from '../src/backend/errors';
import {CodexRpcError} from '../src/backend/transport';
test('failure diagnostics exclude credentials, messages and absolute paths',()=>{
 const e=new CodexRpcError(-32602,'Authorization: Bearer secret');
 e.stack='Error: secret\n    at pair (/private/account/src/server.ts:123:4)\n    at other (/private/secret.ts:1:1)\n    at send (D:\\secret\\src\\service.ts:23:9)';
 assert.deepEqual(failureLocations(e),['server.ts:123:4','service.ts:23:9']);
 const result=JSON.stringify({info:publicBackendError(e),locations:failureLocations(e)});
 for(const forbidden of ['secret','Bearer','/private','D:'])assert.ok(!result.includes(forbidden));
 assert.equal(publicBackendError(e).code,'CODEX_PROTOCOL_MISMATCH');
 assert.deepEqual(failureLocations(null),[]);
});

test('device pairing returns stable RPC diagnostics through the global HTTP handler',async t=>{
 const {mkdtemp}=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {UserStore}=await import('../src/auth'),{createApp}=await import('../src/server'),{CodexConsoleService}=await import('../src/backend/service');
 const directory=await mkdtemp(path.join(os.tmpdir(),'pair-diagnostics-'));
 const users=new UserStore(path.join(directory,'users.json'));await users.upsert({username:'admin',password:'diagnostic-test-password',admin:true});
 const logs:string[]=[];t.mock.method(console,'warn',(...args:any[])=>logs.push(JSON.stringify(args)));
 const runtime=await createApp({host:'127.0.0.1',port:3210,origin:'http://127.0.0.1:3210',dataDir:directory,secureCookies:false},(c,r)=>{
  const service=new CodexConsoleService(c,r);service.snapshot=async()=>{throw new CodexRpcError(-32602,'private-token-and-path');};return service;
 });
 const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 t.after(()=>{runtime.close();server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'diagnostic-test-password'})});
 const cookie=login.headers.get('set-cookie')!.split(';')[0],auth=await login.json() as any;
 const response=await fetch(base+'/api/codex/local-devices',{method:'POST',headers:{'content-type':'application/json',cookie,'x-csrf-token':auth.csrf},body:JSON.stringify({projectId:'demo',threadId:'test',deviceId:'test',tools:[]})});
 const body=await response.json() as any;assert.equal(response.status,502);assert.equal(body.data.code,'CODEX_PROTOCOL_MISMATCH');assert.match(body.data.requestId,/^[0-9a-f-]{36}$/);
 assert.ok(logs.some(v=>v.includes('local-device-pairing')));assert.ok(!JSON.stringify([body,logs]).includes('private-token-and-path'));
});
