// Keep the existing loopback backend and origin translation. Client disconnects
// must cancel their upstream transfer; a completed GET request is NOT a closed SSE.
'use strict';
const http=require('node:http');
const {TransferBudget}=require('./transfer-limit.cjs');
const {createReleaseHandler}=require('./mobile-updates.cjs');
function createProxy({backendHost='127.0.0.1',backendPort=3210,releaseDirectory,publicOrigin='',uploadMbps=20,downloadMbps=40}={}){
  const origin=`http://${backendHost}:${backendPort}`;
  if(publicOrigin){const u=new URL(publicOrigin);if(u.protocol!=='https:'||u.origin!==publicOrigin||u.username||u.password)throw Error('Invalid public HTTPS origin');}
  const upload=new TransferBudget(uploadMbps*1000000/8),download=new TransferBudget(downloadMbps*1000000/8);
  const releases=releaseDirectory?createReleaseHandler(releaseDirectory,{downloadBudget:download}):null;
  const server=http.createServer(async(req,res)=>{
    if(publicOrigin){res.setHeader('Strict-Transport-Security','max-age=31536000');if(req.headers.origin&&req.headers.origin!==publicOrigin||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({data:{code:'ORIGIN_DENIED'}}));return;}}
    if(releases&&await releases(req,res))return;
    if(publicOrigin&&req.headers.host==='v4.daodao.eqad.fun:26103'){if(['GET','HEAD'].includes(req.method)&&!req.url.startsWith('/api/')){res.writeHead(308,{Location:publicOrigin+req.url,'Cache-Control':'no-store'});res.end();}else{res.writeHead(426,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({data:{code:'TLS_REQUIRED',message:'请使用 '+publicOrigin}}));}return;}
    const headers={...req.headers,host:`${backendHost}:${backendPort}`};
    if(headers.origin)headers.origin=publicOrigin||origin;
    if(headers.referer)headers.referer=(publicOrigin||origin)+'/';
    const pathname=(req.url||'').split('?')[0];let upstream,receive,send;
    const cancel=()=>{receive?.destroy();send?.destroy();if(upstream){upstream.unpipe(res);upstream.destroy();}preq.destroy();};
    const fail=()=>{
      if(upstream)upstream.destroy();
      if(res.destroyed)return;
      if(res.headersSent){res.destroy();return;}
      res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});res.end('Bad gateway');
    };
    const preq=http.request({host:backendHost,port:backendPort,path:req.url,method:req.method,headers},pres=>{
      upstream=pres;
      if(res.destroyed||req.aborted){cancel();return;}
      pres.once('error',fail);
      pres.once('aborted',()=>{cancel();if(!res.destroyed)res.destroy();});
      const responseHeaders={...pres.headers};if(pathname.startsWith('/api/'))responseHeaders['cache-control']='no-store';
      res.writeHead(pres.statusCode||502,responseHeaders);
      if(/^\/api\/codex\/files\/(content|image|generated-image)$/.test(pathname)&&req.method!=='HEAD'){send=download.stream();send.once('error',fail);pres.pipe(send).pipe(res);}else pres.pipe(res);
    });
    preq.once('error',fail);
    res.once('close',()=>{if(!res.writableFinished)cancel();});
    req.once('aborted',cancel);req.once('error',cancel);
    if(req.method==='PUT'&&/^\/api\/codex\/uploads\/[^/]+$/.test(pathname)){receive=upload.stream();receive.once('error',fail);req.pipe(receive).pipe(preq);}else req.pipe(preq);
  });
  server.headersTimeout=0;server.requestTimeout=0;server.keepAliveTimeout=185000;
  return server;
}
module.exports={createProxy};
if(require.main===module){
  // Match the currently observed production listener; do not expose a new port
  // by replaying the old script's two listen() calls on a single Server instance.
  const host=process.env.CODEX_PROXY_LISTEN_HOST||'192.168.1.101';
  const port=Number(process.env.CODEX_PROXY_LISTEN_PORT||3210);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid proxy listen port');
  const server=createProxy({backendPort:Number(process.env.CODEX_PROXY_BACKEND_PORT||3210),publicOrigin:process.env.CODEX_PROXY_PUBLIC_ORIGIN||'',uploadMbps:Number(process.env.CODEX_PROXY_UPLOAD_MBPS||20),downloadMbps:Number(process.env.CODEX_PROXY_DOWNLOAD_MBPS||40),releaseDirectory:process.env.CODEX_MOBILE_RELEASE_DIR||require('node:path').join(__dirname,'releases')});server.listen(port,host,()=>console.log(`codex-webui proxy listening on ${host}:${port}`));
  if(process.env.CODEX_PROXY_LOOPBACK_ALIAS==='1'&&host!=='127.0.0.1'){const alias=http.createServer(server.listeners('request')[0]);alias.headersTimeout=0;alias.requestTimeout=0;alias.keepAliveTimeout=185000;alias.listen(port,'127.0.0.1');}
}
