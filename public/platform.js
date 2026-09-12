/* Browsers keep same-origin fetch/SSE. APK credentials never enter the WebView. */
(function(scope){
  'use strict';
  const native=!!scope.Capacitor?.isNativePlatform?.();
  const plugin=native?scope.Capacitor.registerPlugin('CodexNative'):null;
  const streams=new Map(),images=new Map(),transfers=new Map();let serial=0,generation=0,foreground=true,sessionBarrier=Promise.resolve();
  const id=()=>Date.now().toString(36)+'-'+(++serial);
  function route(value){
    if(typeof value!=='string'||value.length>32768||!value.startsWith('/api/')||/[\\\r\n#]/.test(value))throw new Error('Invalid API route');
    const url=new URL(value,'https://localhost'),raw=value.split('?')[0];
    if(url.origin!=='https://localhost'||url.pathname!==raw||!/^\/api\/(?:login|logout|session|register|admin(?:\/.*)?|codex(?:\/.*)?)$/.test(raw)||/%(?:2e|2f|5c|25|00|0a|0d)/i.test(raw))throw new Error('Invalid API route');
    return url.pathname+url.search;
  }
  const ready=plugin?Promise.all([Promise.resolve(plugin.addListener('stream',event=>{
    const stream=streams.get(event.id);if(!stream||stream.closed)return;
    if(event.type==='open')stream.onopen?.(event);
    else if(event.type==='error')stream.fail(event);
    else for(const fn of stream.listeners.get(event.type)||[])fn({data:event.data,lastEventId:event.cursor||''});
  })),Promise.resolve(plugin.addListener('lifecycle',event=>{foreground=!!event.active;if(!foreground)for(const stream of [...streams.values()])stream.close();}))]):Promise.resolve();
  async function request(url,options={}){
    if(!native)return scope.fetch(url,options);
    const relative=route(url),requestId=id(),signal=options.signal;
    await sessionBarrier;if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    const headers={};new Headers(options.headers||{}).forEach((value,key)=>{if(['content-type','x-csrf-token','range','if-range'].includes(key))headers[key]=value;});
    let body=options.body,encoding='text';
    if(body instanceof ArrayBuffer||ArrayBuffer.isView(body)){
      const bytes=body instanceof ArrayBuffer?new Uint8Array(body):new Uint8Array(body.buffer,body.byteOffset,body.byteLength);
      if(bytes.length>262144)throw new Error('Binary chunk exceeds 256 KiB');
      let text='';for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
      body=btoa(text);encoding='base64';
    }else if(body!=null&&typeof body!=='string')throw new Error('Native requests accept text or bounded binary chunks only');
    const abort=()=>{plugin.cancel({id:requestId}).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{
      const result=await plugin.request({id:requestId,route:relative,method:options.method||'GET',headers,body:body??null,encoding});
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      return new Response([204,205,304].includes(result.status)?null:result.body||'',{status:result.status,headers:{'Content-Type':'application/json'}});
    }catch(error){if(signal?.aborted)throw new DOMException('Aborted','AbortError');throw error;}
    finally{signal?.removeEventListener('abort',abort);}
  }
  function events(url){
    if(!native)return new scope.EventSource(url);
    const relative=route(url),stream={id:id(),listeners:new Map(),closed:false,failed:false,onopen:null,onerror:null,
      fail(error){if(this.closed||this.failed||!foreground)return;this.failed=true;this.onerror?.(error);},
      addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);},
      close(){if(this.closed)return;this.closed=true;streams.delete(this.id);plugin.stopStream({id:this.id}).catch(()=>{});}};
    streams.set(stream.id,stream);
    Promise.all([ready,sessionBarrier]).then(()=>{if(!stream.closed&&foreground)return plugin.startStream({id:stream.id,route:relative});}).catch(error=>stream.fail(error));return stream;
  }
  function releaseImage(element){const entry=images.get(element);if(!entry)return;images.delete(element);entry.closed=true;lazy?.unobserve(element);plugin.cancel({id:entry.id}).catch(()=>{});if(entry.token)plugin.releaseMedia({token:entry.token}).catch(()=>{});element.removeAttribute('src');}
  let lazy=native&&scope.IntersectionObserver?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){lazy.unobserve(entry.target);loadImage(entry.target);}}, {rootMargin:'160px'}):null;
  async function loadImage(element){const entry=images.get(element);if(!entry||entry.started)return;entry.started=true;
    try{await sessionBarrier;if(entry.closed)return;const result=await plugin.media({id:entry.id,route:entry.route});if(entry.closed||entry.generation!==generation){plugin.releaseMedia({token:result.token}).catch(()=>{});return;}entry.token=result.token;element.src=scope.Capacitor.convertFileSrc(result.path);}
    catch(error){if(!entry.closed)element.onerror?.(error);}
  }
  function image(element,url){if(!native){element.src=url;return;}releaseImage(element);const relative=route(url);element.dataset.nativeRoute=relative;images.set(element,{id:id(),route:relative,generation,closed:false,started:false});if(element.loading==='lazy'&&lazy)lazy.observe(element);else loadImage(element);}
  function resetMedia(){generation++;for(const element of images.keys())releaseImage(element);for(const controller of transfers.values())controller.abort();transfers.clear();if(plugin)sessionBarrier=sessionBarrier.then(()=>plugin.resetMedia());return sessionBarrier;}
  if(native&&scope.document){new MutationObserver(()=>{for(const [element,entry] of images)if(element.isConnected)entry.attached=true;else if(entry.attached)releaseImage(element);}).observe(document.documentElement,{subtree:true,childList:true});}
  async function pickedFiles(kind){const ticket=generation,result=await plugin.pick({kind}),files=[];
    try{for(const entry of result.files||[]){if(ticket!==generation)throw new Error('聊天已切换，附件选择已取消');const response=await scope.fetch(scope.Capacitor.convertFileSrc(entry.path));if(!response.ok)throw new Error('无法读取已选择附件');const blob=await response.blob();if(blob.size>4194304)throw new Error('附件最多 4 MiB');files.push(new File([blob],entry.name,{type:entry.type}));}if(ticket!==generation)throw new Error('聊天已切换，附件选择已取消');return files;}
    finally{for(const entry of result.files||[])plugin.releaseMedia({token:entry.token}).catch(()=>{});}
  }
  async function download(url,name,mode='save'){
    const requestId=id(),controller=new AbortController(),ticket=generation;transfers.set(requestId,controller);controller.signal.addEventListener('abort',()=>plugin.cancel({id:requestId}).catch(()=>{}),{once:true});
    scope.dispatchEvent?.(new CustomEvent('codex-transfer',{detail:{id:requestId,active:true,name}}));
    try{await sessionBarrier;const result=await plugin.download({id:requestId,route:route(url),name,mode});if(controller.signal.aborted||ticket!==generation)throw new DOMException('Aborted','AbortError');return await plugin.fileAction({token:result.token,mode});}
    finally{transfers.delete(requestId);scope.dispatchEvent?.(new CustomEvent('codex-transfer',{detail:{id:requestId,active:false,name}}));}
  }
  const api={native,plugin,request,events,route,image,releaseImage,resetMedia,pickedFiles,download,
    clearSession(){for(const stream of streams.values())stream.close();resetMedia();if(plugin)sessionBarrier=sessionBarrier.catch(()=>{}).then(()=>plugin.clearSession());return sessionBarrier;},
    cancelTransfers(){for(const controller of transfers.values())controller.abort();},
    previewPdf(url,name){return download(url,name,'pdf');},external(url){return plugin.external({url});}
  };
  scope.CodexPlatform=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
