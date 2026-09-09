import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../src/server';
import {UserStore} from '../src/auth';
async function fixture(t:any,bootstrap=true){
 const data=await mkdtemp(path.join(os.tmpdir(),'webui-registration-'));if(bootstrap)await new UserStore(path.join(data,'users.json')).upsert({username:'admin',password:'test-password-admin',admin:true});
 const runtime=await createApp({host:'127.0.0.1',port:3210,origin:'http://127.0.0.1:3210',dataDir:data,secureCookies:false});const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(async()=>{runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const base='http://127.0.0.1:'+(server.address() as any).port;return {data,call:(route:string,body?:any,headers:any={},method=body===undefined?'GET':'POST')=>fetch(base+route,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})};
}
test('public registration signs in only as a normal user, hides admin data, enforces CSRF and permits login',async t=>{
 const f=await fixture(t);const response=await f.call('/api/register',{username:'alice',password:'test-password-alice'});assert.equal(response.status,201);const result:any=await response.json();assert.equal(result.user.admin,false);assert.ok(result.csrf);assert.equal(result.user.passwordHash,undefined);const cookie=response.headers.get('set-cookie')!.split(';')[0];assert.match(response.headers.get('set-cookie')!,/httponly/i);assert.match(response.headers.get('set-cookie')!,/samesite=strict/i);
 for(const route of ['/api/admin/users','/api/codex/admin/config','/api/codex/account/usage/settings'])assert.equal((await f.call(route,undefined,{cookie})).status,403,route);
 for(const route of ['/api/admin/users','/api/codex/admin/config','/api/codex/account/usage/settings'])assert.equal((await f.call(route,{}, {cookie,'x-csrf-token':result.csrf},'PUT')).status,403,route);
 assert.equal((await f.call('/api/logout',{}, {cookie})).status,403);assert.equal((await f.call('/api/session',undefined,{cookie})).status,200);
 assert.equal((await f.call('/api/logout',{}, {cookie,'x-csrf-token':result.csrf})).status,200);assert.equal((await f.call('/api/session',undefined,{cookie})).status,401);
 assert.equal((await f.call('/api/login',{username:'alice',password:'test-password-alice'})).status,200);const stored=JSON.parse(await readFile(path.join(f.data,'users.json'),'utf8'));assert.equal(stored.filter((u:any)=>u.admin).length,1);assert.doesNotMatch(JSON.stringify(stored),/test-password-alice/);
});
test('registration cannot set privileges, update another user, or bootstrap an administrator',async t=>{
 const f=await fixture(t);for(const extra of [{admin:true},{role:'admin'},{id:'admin'},{permissions:['admin']}])assert.equal((await f.call('/api/register',{username:'attacker',password:'test-password-attacker',...extra})).status,400);
 const db=JSON.parse(await readFile(path.join(f.data,'users.json'),'utf8'));assert.equal(db.length,1);assert.equal(db[0].username,'admin');
 await assert.rejects(fixture(t,false),/No administrator/);
});
test('registration rejects cross-origin, short passwords, duplicates and rate-limits attempts',async t=>{
 const f=await fixture(t),body={username:'alice',password:'test-password-alice'};assert.equal((await f.call('/api/register',body,{origin:'https://evil.test'})).status,403);assert.equal((await f.call('/api/register',body,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.call('/api/register',{...body,password:'short'})).status,400);assert.equal((await f.call('/api/register',body)).status,201);assert.equal((await f.call('/api/register',{...body,username:'ALICE'})).status,400);
 await f.call('/api/register',{...body,password:'short'});await f.call('/api/register',{...body,password:'short'});assert.equal((await f.call('/api/register',{...body,username:'sixth'})).status,429);
});
test('concurrent duplicate registrations create exactly one non-admin account',async t=>{
 const f=await fixture(t),responses=await Promise.all([f.call('/api/register',{username:'same',password:'test-password-same'}),f.call('/api/register',{username:'SAME',password:'test-password-same'})]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,400]);const rows=JSON.parse(await readFile(path.join(f.data,'users.json'),'utf8'));assert.equal(rows.length,2);assert.equal(rows.filter((u:any)=>u.admin).length,1);
});
