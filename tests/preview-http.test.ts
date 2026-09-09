import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server';
import {UserStore} from '../src/auth';
import {ProtectedConfigStore} from '../src/protected-config';
test('preview/upload HTTP boundary preserves ownership, CSRF, range/cache headers and safe MIME',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webui-feature-http-')),data=path.join(dir,'data'),root=path.join(dir,'project');await fs.mkdir(data);await fs.mkdir(root);const users=new UserStore(path.join(data,'users.json'));const admin=await users.upsert({username:'admin',password:'http-test-admin-password',admin:true});await users.upsert({username:'member',password:'http-test-member-password',admin:false});
 const config=new ProtectedConfigStore(path.join(data,'config.json'));await config.save({...config.value,enabled:true,transport:{type:'unix',endpoint:path.join(dir,'mock.sock')},defaultOwnerId:admin.id,projects:[{id:'demo',name:'Demo',root,ownerId:admin.id,grants:[{userId:admin.id,permissions:['view','send','approve','files']}]}]});
 await fs.writeFile(path.join(root,'note.txt'),'0123456789');await fs.writeFile(path.join(root,'active.html'),'<script>bad()</script>');await fs.writeFile(path.join(root,'doc.pdf'),'%PDF-1.4 fixture');await fs.writeFile(path.join(root,'clip.mp4'),'fixture video');
 const runtime=await createApp({host:'127.0.0.1',port:3210,origin:'http://127.0.0.1:3210',dataDir:data,secureCookies:false});const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(async()=>{runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const base='http://127.0.0.1:'+(server.address() as any).port;
 let cookie='',csrf='';const call=(route:string,body?:any,method=body===undefined?'GET':'POST',headers:Record<string,string>={})=>fetch(base+route,{method,headers:{cookie,'x-csrf-token':csrf,...(body===undefined?{}:{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}),...headers},...(body===undefined?{}:{body:Buffer.isBuffer(body)?new Uint8Array(body).buffer:JSON.stringify(body)})});
 for(const route of ['/api/codex/files/preview?projectId=demo&path=note.txt','/api/codex/files/image?projectId=demo&path=x.png'])assert.equal((await call(route)).status,401);
 async function login(name:string){const response=await call('/api/login',{username:name,password:'http-test-'+name+'-password'});assert.equal(response.status,200);const json:any=await response.json();cookie=response.headers.get('set-cookie')!.split(';')[0];csrf=json.csrf;}
 await login('member');for(const endpoint of ['preview','content','image','options'])assert.equal((await call('/api/codex/files/'+endpoint+'?projectId=demo&path=note.txt')).status,403);
 await login('admin');const view=await call('/api/codex/files/preview?projectId=demo&path=note.txt');assert.equal(view.status,200);assert.equal((await view.json() as any).text,'0123456789');
 const range=await call('/api/codex/files/content?projectId=demo&path=note.txt',undefined,'GET',{range:'bytes=2-4'});assert.equal(range.status,206);assert.equal(range.headers.get('accept-ranges'),'bytes');assert.equal(range.headers.get('content-range'),'bytes 2-4/10');assert.equal(await range.text(),'234');
 const etag=range.headers.get('etag')!;assert.equal((await call('/api/codex/files/content?projectId=demo&path=note.txt',undefined,'GET',{'if-none-match':etag})).status,304);
 const head=await call('/api/codex/files/content?projectId=demo&path=note.txt',undefined,'HEAD');assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
 const active=await call('/api/codex/files/content?projectId=demo&path=active.html&inline=1');assert.match(active.headers.get('content-type')!,/octet-stream/);assert.match(active.headers.get('content-disposition')!,/attachment/);assert.match(active.headers.get('content-security-policy')!,/sandbox/);await active.arrayBuffer();
 for(const [file,mime]of [['doc.pdf','application/pdf'],['clip.mp4','video/mp4']]){const response=await call('/api/codex/files/content?projectId=demo&inline=1&path='+file,undefined,'GET',{range:'bytes=0-2'});assert.equal(response.status,206);assert.match(response.headers.get('content-type')!,new RegExp(mime));await response.arrayBuffer();}
 const content=Buffer.from('binary chunk upload'),hash=createHash('sha256').update(content).digest('hex');const begin=await call('/api/codex/uploads',{projectId:'demo',name:'binary.txt',size:content.length,hash});assert.equal(begin.status,200);const upload:any=await begin.json(),url='/api/codex/uploads/'+upload.id+'?projectId=demo&offset=0';
 assert.equal((await call(url,content,'PUT',{'x-csrf-token':''})).status,403);assert.equal((await call(url,content,'PUT',{origin:'https://evil.test'})).status,403);assert.equal((await call(url,Buffer.alloc(256*1024+1),'PUT')).status,413);
 assert.equal((await call(url,content,'PUT')).status,200);assert.equal((await call(url,content,'PUT')).status,200);let uploaded='';for(let i=0;i<2;i++){const done:any=await (await call('/api/codex/uploads/'+upload.id+'/commit',{projectId:'demo'})).json();if(uploaded)assert.equal(done.path,uploaded);uploaded=done.path;}assert.equal(await fs.readFile(path.join(root,uploaded),'utf8'),content.toString());
 await login('member');assert.equal((await call('/api/codex/uploads/'+upload.id+'?projectId=demo')).status,403);
 await login('admin');assert.equal((await call('/api/codex/files/external',{projectId:'demo',url:'https://example.com/a',name:'a.txt'})).status,403);
 const asset=await call('/features.js');assert.equal(asset.status,200);assert.match(await asset.text(),/CodexFeatures/);const page=await call('/');const html=await page.text();assert.match(html,/features\.js\?v=[a-f0-9]+/);assert.match(html,/id="file-dialog"/);assert.match(html,/id="image-dialog"/);assert.doesNotMatch(html,/无需审批/);
});
