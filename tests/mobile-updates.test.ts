import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,writeFile,symlink} from 'node:fs/promises';
const {createProxy}=require('../deploy/http-proxy.cjs');
async function fixture(t:any){
 const directory=await mkdtemp(path.join(os.tmpdir(),'codex-release-'));let backendHits=0;
 const upstream=http.createServer((_q,s)=>{backendHits++;s.end('backend');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const proxy=createProxy({backendPort:(upstream.address() as any).port,releaseDirectory:directory});await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(()=>{proxy.closeAllConnections();proxy.close();upstream.closeAllConnections();upstream.close();});
 const name='codex-mobile-6-1234567890abcdef.apk';await writeFile(path.join(directory,name),Buffer.from('PK-TEST-APK'));await writeFile(path.join(directory,'latest.json'),' {"schema":1}');
 const request=(route:string,method='GET',headers:any={})=>new Promise<any>((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:(proxy.address() as any).port,path:route,method,headers,agent:false},s=>{const chunks:Buffer[]=[];s.on('data',d=>chunks.push(d));s.on('end',()=>resolve({status:s.statusCode,headers:s.headers,body:Buffer.concat(chunks).toString()}));s.on('error',reject);});q.on('error',reject);q.end();});
 return {directory,name,request,hits:()=>backendHits};
}
test('release endpoint serves only public manifest and APK; other routes still proxy',async t=>{const f=await fixture(t);const m=await f.request('/mobile-updates/latest.json');assert.equal(m.status,200);assert.match(m.headers['cache-control'],/no-store/);const a=await f.request('/mobile-updates/'+f.name);assert.equal(a.status,200);assert.equal(a.body,'PK-TEST-APK');assert.match(a.headers['content-type'],/android.package/);assert.equal(a.headers['x-content-type-options'],'nosniff');assert.equal(f.hits(),0);assert.equal((await f.request('/healthz')).body,'backend');assert.equal(f.hits(),1);});
test('HEAD and bounded byte ranges have correct sizes and no manifest caching',async t=>{const f=await fixture(t);const head=await f.request('/mobile-updates/'+f.name,'HEAD');assert.equal(head.body,'');assert.equal(head.headers['content-length'],'11');const range=await f.request('/mobile-updates/'+f.name,'GET',{Range:'bytes=3-6'});assert.equal(range.status,206);assert.equal(range.body,'TEST');assert.equal(range.headers['content-range'],'bytes 3-6/11');for(const value of ['bytes=99-','bytes=-4','bytes=0-1,3-4','bytes=5-2'])assert.equal((await f.request('/mobile-updates/'+f.name,'GET',{Range:value})).status,416);});
test('release writes, traversal, private files and missing packages cannot reach the backend',async t=>{const f=await fixture(t);for(const rel of ['../package.json','%2e%2e/package.json','latest.json/other','secret.p12','',f.name+'/x','codex-mobile-6-deadbeefdeadbeef.apk'])assert.equal((await f.request('/mobile-updates/'+rel)).status,404);assert.equal((await f.request('/mobile-updates/latest.json','POST')).status,405);assert.equal(f.hits(),0);});
test('oversized manifest and symlink are rejected',async t=>{const f=await fixture(t);await writeFile(path.join(f.directory,'latest.json'),'a'.repeat(24577));assert.equal((await f.request('/mobile-updates/latest.json')).status,404);if(process.platform!=='win32'){const n='codex-mobile-7-1234567890abcdef.apk';await symlink(path.join(f.directory,f.name),path.join(f.directory,n));assert.equal((await f.request('/mobile-updates/'+n)).status,404);}});
