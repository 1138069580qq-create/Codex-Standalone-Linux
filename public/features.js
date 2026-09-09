/* Incremental features for the standalone UI. No framework/build step or GitHub integration. */
'use strict';
(() => {
  const groups=new Map();let fileSequence=0,registrationSequence=0,imageSequence=0,timingTimer=null;
  const endpoint=(route,projectId,extra={})=>'/api/codex/'+route+'?'+q({projectId,...extra});
  const same=(epoch,projectId)=>epoch===S.epoch&&projectId===S.project?.id&&!!S.user;
  function reset(){fileSequence++;registrationSequence++;imageSequence++;groups.clear();clearInterval(timingTimer);timingTimer=null;$('preview-body').replaceChildren();$('file-list').replaceChildren();$('file-preview').hidden=true;$('file-dialog').close();$('image-dialog').close();$('full-image').removeAttribute('src');$('browser-surface').replaceChildren();$('browser-external').hidden=true;$('transfer-status').textContent='';}
  function fileUrl(value,full=false,projectId=S.project?.id){
    const image=typeof value==='string'?{path:value}:value;
    return image.generated?endpoint('files/generated-image',projectId,{threadId:S.thread?.id,itemId:image.itemId,index:String(image.imageIndex||0),...(full?{full:'1'}:{})}):endpoint('files/image',projectId,{path:image.path,...(full?{full:'1'}:{})});
  }
  function thumbnail(image,itemId){
    if((image.path||image.generated)&&permission('files')){
      const ref={...image,itemId:image.itemId||itemId},title=image.alt||(image.path||image.generated).split('/').pop();
      const button=el('button',undefined,'thumbnail-button');button.type='button';button.setAttribute('aria-label','查看全图 '+title);
      const img=el('img');img.src=fileUrl(ref);img.alt=title;img.loading='lazy';img.decoding='async';img.width=160;img.height=120;img.dataset.preview='thumbnail';
      img.onerror=()=>{img.removeAttribute('src');button.classList.add('image-unavailable');button.title='缩略图暂不可用，点击重试全图';};button.append(img);button.onclick=()=>openImage(ref,title);return button;
    }
    // Never auto-fetch arbitrary remote URLs from model output.
    if(image.src){try{const url=new URL(image.src);if(url.protocol==='https:'&&!url.username&&!url.password){const link=el('a','外部图片（点击打开）');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';return link;}}catch{}}
    return el('span','图片需要文件访问权限','unavailable-attachment');
  }
  function fileLink(target,label,item){
    const file=(item.files||[]).find(f=>f.source===target||f.path===target);
    if(file){
      if(!permission('files'))return el('span',label+'（无文件权限）','unavailable-attachment');
      const button=el('button',label||file.path.split('/').pop(),'inline-file');button.type='button';button.title='预览 '+file.path;button.onclick=action(()=>previewFile(file.path));return button;
    }
    try{const url=new URL(target);if(['http:','https:','mailto:'].includes(url.protocol)&&!url.username&&!url.password){const a=el('a',label||target);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';return a;}}catch{}
    const span=el('span',label||target,'unavailable-attachment');span.title='此链接不在当前项目的可预览范围内';return span;
  }
  function markdown(item){return CodexMarkdown.render(item.text+(item.truncated?'\n[内容已截断]':''),{
    link:(target,label)=>fileLink(target,label,item),
    image:(target,label)=>{if((item.images||[]).some(i=>i.source===target||i.path===target||i.src===target))return el('span');return el('span','[图片：'+(label||'无法预览')+']','unavailable-attachment');}
  });}
  function itemNode(item){
    const tool=!['userMessage','agentMessage','plan'].includes(item.type);let node=S.nodes.get(item.id);
    if(!node){
      const root=el('article',undefined,'message '+item.type),body=el('div'),media=el('div',undefined,'message-images');let summary;
      if(tool){const details=el('details',undefined,'process-tool');summary=el('summary');details.append(summary,body);root.append(details);}
      else root.append(body);
      root.append(media);
      if(item.type==='agentMessage'){const source=el('button','原文','text-source');source.type='button';source.setAttribute('aria-label','查看答复原文');source.onclick=()=>showOriginalText(item.id);root.append(source);}
      node={root,body,media,summary,key:''};S.nodes.set(item.id,node);
    }
    const key=JSON.stringify([item.text,item.truncated,item.status,item.images,item.files]);
    if(key!==node.key){node.key=key;
      if(tool){const names={reasoning:'思考摘要',commandExecution:'运行命令',fileChange:'更新文件',imageGeneration:'生成图片',imageGenerationCall:'生成图片',imageView:'查看图片',webSearch:'搜索网页',mcpToolCall:'调用工具'};
        const title=names[item.type]||labelType(item.type),detail=item.type==='commandExecution'?item.text.split('\n')[0]:item.type==='fileChange'?(item.files||[]).map(f=>f.path.split('/').pop()).join('、'):'';
        node.summary.replaceChildren(el('span',title,'tool-label'));if(detail)node.summary.append(el('span',detail,'tool-detail'));if(item.status==='failed')node.summary.append(el('span','失败','tool-failed'));
        node.body.replaceChildren(el('pre',item.text+(item.truncated?'\n[内容已截断]':'')));
      }else node.body.replaceChildren(item.type==='userMessage'?el('div',item.text,'user-text'):markdown(item));
      node.media.replaceChildren();if(item.type==='userMessage')for(const [imageIndex,image]of(item.images||[]).entries())node.media.append(thumbnail({...image,imageIndex},item.id));
    }
    return node.root;
  }
  function updateTiming(){
    if(document.hidden)return;
    for(const row of CodexTurns.group(S.items.values(),S)){const node=groups.get(row.id);if(node)node.label.textContent=row.label;}
  }
  function renderTimeline(){
    const timeline=$('timeline'),scroll=timeline.scrollTop,follow=timeline.scrollHeight-scroll-timeline.clientHeight<120,used=new Set();$('empty').hidden=!!S.thread;
    for(const [id,node]of S.nodes)if(!S.items.has(id)){node.root.remove();S.nodes.delete(id);}
    const rows=CodexTurns.group(S.items.values(),S);
    for(const row of rows){
      used.add(row.id);let node=groups.get(row.id);
      if(!node){const root=el('section',undefined,'conversation-turn'),users=el('div',undefined,'turn-users'),details=el('details',undefined,'turn-process'),summary=el('summary'),label=el('span'),process=el('div',undefined,'turn-process-body'),finals=el('div',undefined,'turn-final'),delivery=el('div',undefined,'turn-deliveries');
        root.dataset.turnId=row.id;summary.append(label);details.append(summary,process);root.append(users,details,finals,delivery);node={root,users,details,summary,label,process,finals,delivery,mode:null,deliveryKey:''};groups.set(row.id,node);
      }
      const mode=row.collapsible?'complete':row.running?'running':'open';
      if(mode!==node.mode){node.details.open=mode!=='complete';node.mode=mode;}
      node.root.classList.toggle('turn-running',row.running);node.root.classList.toggle('turn-failed',['failed','interrupted','cancelled','canceled'].includes(row.status));
      node.details.classList.toggle('empty-process',!row.process.length);node.summary.setAttribute('aria-label',row.label+'，展开或收起过程');node.label.textContent=row.label;
      // Move existing nodes without recreating active <details> or reloading media on every delta.
      const place=(container,items)=>{const roots=items.map(itemNode),keep=new Set(roots);for(const child of [...container.children])if(!keep.has(child))child.remove();for(let i=0;i<roots.length;i++)if(container.children[i]!==roots[i])container.insertBefore(roots[i],container.children[i]||null);};
      place(node.users,row.users);place(node.process,row.process);place(node.finals,row.finals);
      const deliveryKey=JSON.stringify([row.images,row.files,permission('files')]);
      if(deliveryKey!==node.deliveryKey){node.deliveryKey=deliveryKey;node.delivery.replaceChildren();
        if(row.images.length){const media=el('div',undefined,'message-images delivered-images');for(const image of row.images)media.append(thumbnail(image,image.itemId));node.delivery.append(media);}
        if(row.files.length){const list=el('div',undefined,'delivered-files');for(const file of row.files){const card=el('div',undefined,'delivery-file'),button=el('button',undefined,'delivery-open');button.type='button';button.disabled=!permission('files');button.title='预览 '+file.path;button.setAttribute('aria-label','预览 '+file.path);button.append(el('span','▤','delivery-icon'),el('span',file.path.split('/').pop(),'delivery-name'),el('span','预览','delivery-hint'));button.onclick=action(()=>previewFile(file.path));card.append(button);
          if(permission('files')){const download=el('a','↓','delivery-download');download.href=endpoint('files/content',S.project.id,{path:file.path});download.download=file.path.split('/').pop();download.setAttribute('aria-label','下载 '+file.path);card.append(download);}list.append(card);}node.delivery.append(list);}
      }
      timeline.append(node.root);
    }
    for(const [id,node]of groups)if(!used.has(id)){node.root.remove();groups.delete(id);}
    if(rows.some(row=>row.running)){if(!timingTimer)timingTimer=setInterval(updateTiming,1000);}else{clearInterval(timingTimer);timingTimer=null;}
    if(follow)timeline.scrollTop=timeline.scrollHeight;else timeline.scrollTop=scroll;
  }
  async function openImage(path,title){
    const id=++imageSequence,epoch=S.epoch,projectId=S.project?.id,img=$('full-image');$('image-title').textContent=title;$('image-state').textContent='按需加载全图…';$('image-canvas').classList.remove('actual-size');$('image-zoom').textContent='原始尺寸';
    img.onload=()=>{if(id===imageSequence&&same(epoch,projectId))$('image-state').textContent=`${img.naturalWidth} × ${img.naturalHeight} · 全分辨率安全预览`;};
    img.onerror=()=>{if(id===imageSequence)$('image-state').textContent='全图无法加载或权限已失效；可在文件面板下载原始文件。';};img.src=fileUrl(path,true,projectId);$('image-dialog').showModal();
  }
  function openInspector(){ S.panel='files';for(const name of ['quota','files','diff','browser'])$('panel-'+name).hidden=name!=='files';for(const button of document.querySelectorAll('[data-panel]')){const active=button.dataset.panel==='files';button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));}$('inspector').classList.add('inspect-open'); }
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
