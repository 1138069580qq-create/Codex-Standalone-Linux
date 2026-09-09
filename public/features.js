/* Incremental features for the standalone UI. No framework/build step or GitHub integration. */
'use strict';
(() => {
  const groups=new Map();let fileSequence=0,registrationSequence=0,imageSequence=0;
  const endpoint=(route,projectId,extra={})=>`/api/codex/${route}?${q({projectId,...extra})}`;
  const same=(epoch,projectId)=>epoch===S.epoch&&projectId===S.project?.id&&!!S.user;
  function reset(){fileSequence++;registrationSequence++;imageSequence++;groups.clear();$('preview-body').replaceChildren();$('file-list').replaceChildren();$('file-preview').hidden=true;$('file-dialog').close();$('image-dialog').close();$('full-image').removeAttribute('src');$('browser-surface').replaceChildren();$('browser-external').hidden=true;$('transfer-status').textContent='';}
  const duration=n=>n<1000?`${Math.round(n)} 毫秒`:n<60000?`${(n/1000).toFixed(1)} 秒`:`${Math.floor(n/60000)} 分 ${Math.floor(n%60000/1000)} 秒`;
  function fileUrl(path,full=false,projectId=S.project?.id){return endpoint('files/image',projectId,{path,...(full?{full:'1'}:{})});}
  function thumbnail(image,itemId){
    if(image.path&&permission('files')){
      const button=el('button',undefined,'thumbnail-button');button.type='button';button.setAttribute('aria-label',`查看全图 ${image.alt||image.path}`);
      const img=el('img');img.src=fileUrl(image.path);img.alt=image.alt||image.path;img.loading='lazy';img.decoding='async';img.width=160;img.height=120;img.dataset.preview='thumbnail';
      img.onerror=()=>{img.removeAttribute('src');button.classList.add('image-unavailable');button.title='缩略图暂不可用，点击重试全图';};button.append(img);button.onclick=()=>openImage(image.path,image.alt||image.path);return button;
    }
    // Never auto-fetch an arbitrary remote image from model output.
    if(image.src){try{const url=new URL(image.src);if(url.protocol==='https:'&&!url.username&&!url.password){const link=el('a','外部图片（点击打开）');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';return link;}}catch{}}
    return null;
  }
  function renderTimeline(){
    const timeline=$('timeline'),follow=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<120,usedGroups=new Set();
    $('empty').hidden=!!S.thread;
    for(const [id,node] of S.nodes)if(!S.items.has(id)){node.root.remove();S.nodes.delete(id);}
    let previousGroup=null;
    for(const item of S.items.values()){
      const tool=!['userMessage','agentMessage','plan'].includes(item.type);let node=S.nodes.get(item.id);if(node&&!node.media){node.root.remove();S.nodes.delete(item.id);node=null;}
      if(!node){const root=el('article',undefined,`message ${item.type}`),pre=el('pre'),head=el(tool?'summary':'div',undefined,'message-head'),media=el('div',undefined,'message-images');
        if(tool){const details=el('details');details.append(head,pre,media);root.append(details);}else{root.append(head,pre,media);if(item.type==='agentMessage'){const raw=el('button','原文','text-source');raw.type='button';raw.onclick=()=>showOriginalText(item.id);head.append(raw);}}
        node={root,pre,head,media,label:el('span'),imageKey:''};node.head.prepend(node.label);S.nodes.set(item.id,node);
      }
      const text=item.text+(item.truncated?String.fromCharCode(10)+'[内容已截断]':'');if(node.pre.textContent!==text)node.pre.textContent=text;
      node.label.textContent=labelType(item.type)+(item.status?` · ${stateName(item.status)}`:'')+(Number.isFinite(item.durationMs)?` · ${duration(item.durationMs)}`:'');
      const imageKey=JSON.stringify(item.images||[]);if(imageKey!==node.imageKey){node.imageKey=imageKey;node.media.replaceChildren();for(const image of (item.images||[]).slice(0,8)){const view=thumbnail(image,item.id);if(view)node.media.append(view);}}
      if(tool){const family=(item.turnId||'')+':'+item.type;let group=previousGroup?.family===family?previousGroup:null;
        if(!group){const key=family+':'+item.id;group=groups.get(key);if(!group){const root=el('details',undefined,'tool-group'),summary=el('summary'),body=el('div');root.append(summary,body);group={key,family,root,summary,body};groups.set(key,group);}group.count=0;group.ms=0;group.timed=0;timeline.append(group.root);usedGroups.add(group.key);}
        group.count++;if(Number.isFinite(item.durationMs)){group.ms+=item.durationMs;group.timed++;}group.summary.textContent=`${labelType(item.type)} · ${group.count} 次调用${group.timed?' · 累计 '+duration(group.ms):''}`;group.body.append(node.root);previousGroup=group;
      }else{timeline.append(node.root);previousGroup=null;}
    }
    for(const [key,g] of groups)if(!usedGroups.has(key)){g.root.remove();groups.delete(key);}
    if(follow)timeline.scrollTop=timeline.scrollHeight;
  }
  async function openImage(path,title){
    const id=++imageSequence,epoch=S.epoch,projectId=S.project?.id,img=$('full-image');$('image-title').textContent=title;$('image-state').textContent='按需加载全图…';$('image-canvas').classList.remove('actual-size');$('image-zoom').textContent='原始尺寸';
    img.onload=()=>{if(id===imageSequence&&same(epoch,projectId))$('image-state').textContent=`${img.naturalWidth} × ${img.naturalHeight} · 全分辨率安全预览`;};
    img.onerror=()=>{if(id===imageSequence)$('image-state').textContent='全图无法加载或权限已失效；可在文件面板下载原始文件。';};img.src=fileUrl(path,true,projectId);$('image-dialog').showModal();
  }
  function openInspector(){ $('inspector').classList.add('inspect-open'); }
  async function previewFile(path){
    const sequence=++fileSequence,epoch=S.epoch,projectId=S.project?.id;const info=await api(endpoint('files/preview',projectId,{path}));if(sequence!==fileSequence||!same(epoch,projectId))return;
    $('file-dialog').close();$('preview-title').textContent=path;$('preview-body').replaceChildren();$('file-preview').hidden=false;openInspector();
    const body=$('preview-body'),meta=el('p',`${bytes(info.size)}${info.truncated?' · 仅显示前 64 KiB / 受限提取内容':''}`,'footnote'),download=el('a','下载原始文件','small');download.href=endpoint('files/content',projectId,{path});download.download=path.split('/').pop();body.append(meta,download);
    if(info.kind==='image'){const view=thumbnail({path,alt:path},path);if(view)body.append(view);body.append(el('p','点击小图查看全分辨率图片。','footnote'));}
    else if(info.kind==='text'||info.kind==='archive')body.append(el('pre',info.text||'(无可提取内容)','file-text'));
    else if(info.kind==='pdf'){const load=el('button','加载 PDF 预览（按需请求文件）','small');load.type='button';load.onclick=()=>{const frame=el('iframe');frame.title=path;frame.className='document-preview';frame.setAttribute('sandbox','');frame.referrerPolicy='no-referrer';frame.src=endpoint('files/content',projectId,{path,inline:'1'});load.replaceWith(frame);};body.append(load);}
    else if(info.kind==='media'){const media=el(info.contentType.startsWith('audio/')?'audio':'video');media.controls=true;media.preload='none';media.src=endpoint('files/content',projectId,{path,inline:'1'});media.className='media-preview';body.append(media);}
    else body.append(el('p','此格式只显示文件信息，不会自动下载完整内容。','footnote'));
  }
  async function loadFiles(){
    if(!permission('files'))throw new Error('没有文件权限。');const epoch=S.epoch,projectId=S.project.id,requested=S.filePath;const result=await api(endpoint('files',projectId,{path:requested}));if(!same(epoch,projectId)||requested!==S.filePath)return;
    $('file-path').textContent=S.filePath;$('file-list').replaceChildren();for(const entry of result.entries){const row=el('div',undefined,'file-row'),open=el('button',(entry.type==='directory'?'▸ ':'')+entry.name,'file-entry');open.type='button';open.title=entry.type==='directory'?'打开目录':'预览文件';open.onclick=action(async()=>{if(entry.type==='directory'){S.filePath=entry.path;await loadFiles();}else await previewFile(entry.path);});row.append(open);
      if(entry.type==='file'){const download=el('a','↓','file-download');download.href=endpoint('files/content',projectId,{path:entry.path});download.download=entry.name;download.title='下载 '+entry.name;download.setAttribute('aria-label','下载 '+entry.name);row.append(el('span',bytes(entry.size),'footnote'),download);}$('file-list').append(row);
    }if(!result.entries.length)$('file-list').append(el('p','空目录或没有可展示的文件。','footnote'));
  }
  async function retry(fn){for(let attempt=0;;attempt++){try{return await fn();}catch(error){if(attempt>=2||error.status&&![408,429,502,503,504].includes(error.status))throw error;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}}}
  async function upload(file,projectId,epoch){
    if(file.size>4*1024*1024)throw new Error('附件最多 4 MiB。');if(!crypto.subtle)throw new Error('安全分块上传需要 HTTPS。');const buffer=await file.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(n=>n.toString(16).padStart(2,'0')).join('');
    const ensure=()=>{if(!same(epoch,projectId))throw new Error('项目已切换，上传已停止。');};ensure();
    let state=await retry(()=>api('/api/codex/uploads',{projectId,name:file.name,size:file.size,hash}));
    while(state.offset<file.size){ensure();const offset=state.offset,chunk=buffer.slice(offset,offset+state.chunkBytes);state=await retry(async()=>{ensure();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);try{const response=await fetch(endpoint(`uploads/${encodeURIComponent(state.id)}`,projectId,{offset:String(offset)}),{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':S.csrf},body:chunk,signal:controller.signal});const data=await response.json();if(!response.ok){const e=new Error(data.data?.message||'上传失败');e.status=response.status;throw e;}return data;}finally{clearTimeout(timer);}});if(same(epoch,projectId))$('transfer-status').textContent=`${file.name} · ${Math.round(state.offset/file.size*100)}%`;}
    ensure();const result=await retry(()=>api(`/api/codex/uploads/${encodeURIComponent(state.id)}/commit`,{projectId}));if(same(epoch,projectId))$('transfer-status').textContent=`${file.name} · 校验完成`;return result;
  }
  async function loadRegistrations(){
    if(!S.user?.admin)return;const account=S.user.id,sequence=++registrationSequence,rows=await api('/api/admin/registrations');if(account!==S.user?.id||sequence!==registrationSequence||!S.user?.admin)return;
    const list=$('registration-list');list.replaceChildren();if(!rows.length)list.append(el('p','暂无待审批申请。','footnote'));
    for(const entry of rows){const row=el('div',undefined,'registration-row');row.append(el('span',entry.username),el('small',new Date(entry.createdAt).toLocaleString(),'footnote'));
      for(const [decision,title] of [['approve','同意'],['reject','拒绝']]){const button=el('button',title,'small');button.type='button';button.setAttribute('aria-label',title+' '+entry.username);button.onclick=action(async()=>{await api('/api/admin/registrations/'+encodeURIComponent(entry.id),{decision});await loadUsers();});row.append(button);}list.append(row);
    }
  }
  $('image-close').onclick=()=>$('image-dialog').close();$('image-dialog').addEventListener('close',()=>{imageSequence++;$('full-image').removeAttribute('src');});
  $('image-zoom').onclick=()=>{const actual=$('image-canvas').classList.toggle('actual-size');$('image-zoom').textContent=actual?'适应窗口':'原始尺寸';};
  $('preview-close').onclick=()=>{fileSequence++;$('file-preview').hidden=true;$('preview-body').replaceChildren();};
  $('preview-fullscreen').onclick=()=>{$('file-dialog-title').textContent=$('preview-title').textContent;$('file-dialog-body').append($('preview-body'));$('file-dialog').showModal();};
  $('file-dialog-close').onclick=()=>$('file-dialog').close();$('file-dialog').addEventListener('close',()=>{$('file-preview').append($('preview-body'));});
  $('registrations-refresh').onclick=action(loadRegistrations);
  $('browser-form').onsubmit=action(()=>{const url=new URL($('browser-url').value);if(url.protocol!=='https:'||url.username||url.password||url.origin===location.origin||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||/^[\d.]+$/.test(url.hostname)||url.hostname.includes(':'))throw new Error('请输入公共 HTTPS 网页地址，不能打开本应用或本机地址。');const frame=el('iframe');frame.title='隔离网页预览';frame.className='mini-browser';frame.setAttribute('sandbox','allow-scripts allow-forms');frame.referrerPolicy='no-referrer';frame.src=url.href;$('browser-surface').replaceChildren(frame);$('browser-external').href=url.href;$('browser-external').hidden=false;});
  $('browser-clear').onclick=()=>{$('browser-surface').replaceChildren();$('browser-external').hidden=true;};
  $('external-open').onclick=action(async()=>{if(!permission('files'))throw new Error('没有文件权限。');const epoch=S.epoch,projectId=S.project.id,options=await api(endpoint('files/options',projectId));if(!same(epoch,projectId))return;$('external-hosts').textContent=options.downloadHosts.length?'允许域名：'+options.downloadHosts.join('、'):'当前没有允许的域名；管理员可在项目配置中设置 downloadHosts。';$('external-dialog').showModal();});
  $('external-close').onclick=()=>$('external-dialog').close();$('external-form').onsubmit=action(async()=>{const epoch=S.epoch,projectId=S.project?.id;await api('/api/codex/files/external',{projectId,name:$('external-name').value,url:$('external-url').value});if(!same(epoch,projectId))return;$('external-dialog').close();S.filePath='.codex-uploads';await loadFiles();toast('外部文件已下载到项目。');});
  globalThis.CodexFeatures={reset,renderTimeline,loadFiles,previewFile,openImage,upload,loadRegistrations};
})();
