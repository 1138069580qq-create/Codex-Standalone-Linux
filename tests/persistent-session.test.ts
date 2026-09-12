import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';import {Sessions,UserStore,SESSION_LIFETIME_MS} from '../src/auth';
test('idle login survives restart for 30 days; token is hashed; logout and account revision still revoke',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'persistent-session-'));const users=new UserStore(path.join(dir,'users.json'));const account=await users.upsert({username:'admin',password:'session-test-password',admin:true});let now=Date.now();const file=path.join(dir,'sessions.json');const s=new Sessions(file,()=>now),user=users.users[0],created=s.create(user);await s.persist();assert.equal(created.expires-now,SESSION_LIFETIME_MS);assert.ok(!(await fs.readFile(file,'utf8')).includes(created.token));
 now+=2*24*3600_000;const reopened=new Sessions(file,()=>now);await reopened.load();assert.equal(reopened.get(created.token,users)?.user.id,account.id);
 reopened.revoke(created.token);await reopened.persist();const loggedOut=new Sessions(file,()=>now);await loggedOut.load();assert.equal(loggedOut.get(created.token,users),null);
 const next=loggedOut.create(user);await loggedOut.persist();await users.upsert({id:user.id,username:user.username,password:'changed-test-password',admin:true});const changed=new Sessions(file,()=>now);await changed.load();assert.equal(changed.get(next.token,users),null);
 const current=changed.create(users.users[0]);await changed.persist();now=current.expires;const expired=new Sessions(file,()=>now);await expired.load();assert.equal(expired.get(current.token,users),null);
});

import {createApp} from '../src/server';
test('real HTTP cookie and CSRF survive Web runtime reconstruction; logout survives another restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'http-login-'));const users=new UserStore(path.join(dir,'users.json'));await users.upsert({username:'admin',password:'http-session-test-password',admin:true});
 const open=async()=>{const runtime=await createApp({host:'127.0.0.1',port:3211,origin:'http://127.0.0.1:3211',dataDir:dir,secureCookies:false});const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));return {runtime,server,base:'http://127.0.0.1:'+(server.address() as any).port};};
 const close=async(r:Awaited<ReturnType<typeof open>>)=>{r.runtime.close();r.server.closeAllConnections();await new Promise<void>(resolve=>r.server.close(()=>resolve()));};
 let r=await open();const login=await fetch(r.base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'http-session-test-password'})});const cookie=login.headers.get('set-cookie')!.split(';')[0],data:any=await login.json();assert.equal(login.status,200);await close(r);
 r=await open();assert.equal((await fetch(r.base+'/api/session',{headers:{cookie}})).status,200);assert.equal((await fetch(r.base+'/api/logout',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':data.csrf},body:'{}'})).status,200);await close(r);
 r=await open();assert.equal((await fetch(r.base+'/api/session',{headers:{cookie}})).status,401);await close(r);
});
