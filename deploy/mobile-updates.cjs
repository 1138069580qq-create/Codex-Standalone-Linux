/* Public, read-only release files. Never serves a project path or private key. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
function createReleaseHandler(directory,{maxActive=6,downloadBudget}={}){
  if(!path.isAbsolute(directory))throw Error('Release directory must be absolute');
  let active=0;
  return async function release(req,res){
    const raw=(req.url||'').split('?')[0];if(!raw.startsWith('/mobile-updates'))return false;
    const reply=(code,body,headers={})=>{if(!res.destroyed){res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store',...headers});res.end(req.method==='HEAD'?'':body);}};
    const name=raw.slice('/mobile-updates/'.length),manifest=name==='latest.json';
    if(raw!='/mobile-updates/'+name||(!manifest&&!/^codex-mobile-[1-9][0-9]{0,9}-[0-9a-f]{16}\.apk$/.test(name))){reply(404,'Not found');return true;}
    if(!['GET','HEAD'].includes(req.method)){reply(405,'Read only',{Allow:'GET, HEAD'});return true;}
    if(active>=maxActive){reply(429,'Too many downloads',{'Retry-After':'10'});return true;}
    active++;let fd,stream,limited,finished=false;
    const releaseSlot=()=>{if(!finished){finished=true;active--;}};
    try{
      const target=path.join(directory,name);const lst=await fs.promises.lstat(target);
      if(lst.isSymbolicLink()||!lst.isFile())throw Object.assign(Error('Not regular'),{code:'ENOENT'});
      fd=await fs.promises.open(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      const stat=await fd.stat();if(!stat.isFile()||stat.size<1||stat.size>(manifest?24*1024:64*1024*1024))throw Object.assign(Error('Invalid size'),{code:'ENOENT'});
      if(res.destroyed||req.aborted){await fd.close();fd=null;releaseSlot();return true;}
      let start=0,end=stat.size-1,code=200;const headers={'Content-Type':manifest?'application/json; charset=utf-8':'application/vnd.android.package-archive','X-Content-Type-Options':'nosniff','Cache-Control':manifest?'no-store, max-age=0':'public, max-age=31536000, immutable','Content-Disposition':manifest?'inline':'attachment; filename="'+name+'"'};
      if(!manifest){headers['Accept-Ranges']='bytes';if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);start=m?Number(m[1]):-1;end=m&&m[2]?Number(m[2]):end;if(!m||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=stat.size||end<start||end>=stat.size){await fd.close();fd=null;releaseSlot();reply(416,'Invalid range',{'Content-Range':'bytes */'+stat.size});return true;}code=206;headers['Content-Range']='bytes '+start+'-'+end+'/'+stat.size;}}
      headers['Content-Length']=String(end-start+1);res.writeHead(code,headers);
      if(req.method==='HEAD'){res.end();await fd.close();fd=null;releaseSlot();return true;}
      stream=fd.createReadStream({start,end,autoClose:true});fd=null;
      const cancel=()=>{stream.destroy();limited?.destroy();};res.once('close',cancel);req.once('aborted',cancel);req.once('error',cancel);
      stream.once('close',()=>{res.off('close',cancel);req.off('aborted',cancel);req.off('error',cancel);releaseSlot();});
      stream.once('error',()=>{limited?.destroy();res.destroy();});if(downloadBudget&&!manifest){limited=downloadBudget.stream();limited.once('error',()=>{stream.destroy();res.destroy();});stream.pipe(limited).pipe(res);}else stream.pipe(res);return true;
    }catch(error){if(fd)await fd.close().catch(()=>{});releaseSlot();if(res.headersSent)res.destroy();else reply(error.code==='ENOENT'?404:500,error.code==='ENOENT'?'Not found':'Release unavailable');return true;}
  };
}
module.exports={createReleaseHandler};
