import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
const {createProxy}=require('../deploy/http-proxy.cjs');
const pause=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(fn:()=>boolean){for(let i=0;i<200&&!fn();i++)await pause(10);assert.ok(fn(),'expected network cleanup');}
async function setup(t:any,handler:(req:http.IncomingMessage,res:http.ServerResponse)=>void,options:any={}){
 const backend=http.createServer(handler);backend.listen(0,'127.0.0.1');await once(backend,'listening');const a=backend.address();assert.ok(a&&typeof a!=='string');
 const proxy:http.Server=createProxy({backendHost:'127.0.0.1',backendPort:a.port,...options});proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const p=proxy.address();assert.ok(p&&typeof p!=='string');
 const requests:http.ClientRequest[]=[];
 t.after(async()=>{for(const r of requests)r.destroy();proxy.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>backend.close(()=>r()))]);});
 const open=(path='/',options:any={})=>new Promise<any>((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:p.port,path,agent:false,...options},res=>{const h={res,req,status:res.statusCode,body:'',closed:false,ended:false};res.on('data',c=>h.body+=c);res.on('error',()=>{});res.once('close',()=>h.closed=true);res.once('end',()=>h.ended=true);resolve(h);});requests.push(req);req.once('error',reject);req.end(options.body);});
 return {open,port:p.port,requests};
}
test('proxy releases repeated mobile SSEs without closing the stable desktop stream',async t=>{
 const active=new Set<http.ServerResponse>();const f=await setup(t,(_req,res)=>{active.add(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': start\n\n');const heartbeat=setInterval(()=>res.write(': beat\n\n'),20);res.once('close',()=>{clearInterval(heartbeat);active.delete(res);});});
 const desktop=await f.open('/events');for(let i=0;i<9;i++){const mobile=await f.open('/events');mobile.res.destroy();mobile.req.destroy();await until(()=>active.size===1);}
 const old=desktop.body.length;await pause(50);assert.ok(desktop.body.length>old);assert.equal(desktop.closed,false);assert.equal(active.size,1);
});
test('client cancellation before upstream headers closes the pending upstream',async t=>{
 let received=false,closed=false;const f=await setup(t,(_req,res)=>{received=true;res.once('close',()=>closed=true);});
 const req=http.get({host:'127.0.0.1',port:f.port,path:'/delayed',agent:false});req.on('error',()=>{});f.requests.push(req);await until(()=>received);req.destroy();await until(()=>closed);
});
test('upstream failure before headers returns 502, not a hung request',async t=>{
 const f=await setup(t,(req,_res)=>req.socket.destroy());const h=await f.open();await until(()=>h.ended);assert.equal(h.status,502);assert.equal(h.body,'Bad gateway');
});
test('upstream interruption after headers never appends an error string to file bytes',async t=>{
 const f=await setup(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write('FILE_PREFIX');setTimeout(()=>res.destroy(),15);});const h=await f.open();await until(()=>h.closed);assert.equal(h.body,'FILE_PREFIX');assert.equal(h.ended,false);
});
test('normal writes preserve body, session headers and existing origin translation',async t=>{
 const f=await setup(t,(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({method:req.method,body,origin:req.headers.origin,host:req.headers.host,cookie:req.headers.cookie,csrf:req.headers['x-csrf-token']}));});});
 const h=await f.open('/api/example',{method:'POST',headers:{Origin:'http://example.test',Cookie:'fixture=only','X-CSRF-Token':'fixture-csrf'},body:'fixture-body'});await until(()=>h.ended);const body=JSON.parse(h.body);assert.equal(h.status,201);assert.equal(body.body,'fixture-body');assert.equal(body.method,'POST');assert.equal(body.cookie,'fixture=only');assert.equal(body.csrf,'fixture-csrf');assert.equal(body.origin,'http://'+body.host);
});
test('upstream rate-limit status and JSON are passed through unchanged',async t=>{
 const f=await setup(t,(_req,res)=>{res.writeHead(429,{'Content-Type':'application/json','Retry-After':'60'});res.end('{"data":{"code":"STREAM_LIMIT"}}');});const h=await f.open();await until(()=>h.ended);assert.equal(h.status,429);assert.equal(h.res.headers['retry-after'],'60');assert.equal(JSON.parse(h.body).data.code,'STREAM_LIMIT');
});

test('HTTPS proxy keeps expected origin, rejects foreign origins and prevents private caching',async t=>{
 let requests=0;const f=await setup(t,(req,res)=>{requests++;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public'});res.end(JSON.stringify({origin:req.headers.origin}));},{publicOrigin:'https://xf.csituka.top'});
 const foreign=await f.open('/api/example',{method:'POST',headers:{Origin:'https://foreign.invalid'}});await until(()=>foreign.ended);assert.equal(foreign.status,403);assert.equal(requests,0);
 const good=await f.open('/api/example',{method:'POST',headers:{Origin:'https://xf.csituka.top'}});await until(()=>good.ended);assert.equal(JSON.parse(good.body).origin,'https://xf.csituka.top');assert.equal(good.res.headers['cache-control'],'no-store');assert.equal(good.res.headers['strict-transport-security'],'max-age=31536000');
 const old=await f.open('/api/login',{method:'POST',headers:{Host:'v4.daodao.eqad.fun:26103'}});await until(()=>old.ended);assert.equal(old.status,426);assert.equal(requests,1);
});
test('concurrent file downloads share bandwidth while chat events remain responsive',async t=>{
 const f=await setup(t,(_req,res)=>{if(_req.url==='/api/codex/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(': ready\n\n');}else{res.writeHead(200,{'Content-Type':'application/octet-stream'});res.end(Buffer.alloc(65536,65));}},{downloadMbps:1});
 const began=Date.now();const [a,b,event]=await Promise.all([f.open('/api/codex/files/content'),f.open('/api/codex/files/content'),f.open('/api/codex/events')]);await until(()=>event.ended);assert.ok(!a.ended||!b.ended);await until(()=>a.ended&&b.ended);assert.equal(a.body.length+b.body.length,131072);assert.ok(Date.now()-began>=900,'aggregate downloads must take about one second at 1 Mbps');
});
test('upload byte throttling preserves content and forwards completion',async t=>{
 const f=await setup(t,(req,res)=>{let bytes=0;req.on('data',b=>bytes+=b.length);req.on('end',()=>res.end(String(bytes)));},{uploadMbps:1});const began=Date.now();const h=await f.open('/api/codex/uploads/test',{method:'PUT',body:Buffer.alloc(65536)});await until(()=>h.ended);assert.equal(h.body,'65536');assert.ok(Date.now()-began>=450);
});
