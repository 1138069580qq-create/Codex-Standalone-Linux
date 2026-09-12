'use strict';
(() => {
  const projectId='account-storage';let folder='.',sequence=0;
  const scope=()=>JSON.stringify([location.origin,S.user?.id,S.authRevision]);
  const url=(route,path)=>'/api/codex/'+route+'?'+q({projectId,path});
  const active=()=>$('file-scope').value===projectId;
  function assert(){if(!S.user)throw Error('请先登录');}
  function reference(entry){assert();if(S.references.length>=12)throw Error('最多引用 12 个文件或目录');const ref='@account/'+entry.path;if(!S.references.includes(ref))S.references.push(ref);renderAttachments();toast('已引用服务器原文件');}
  async function preview(entry){
    assert();if(globalThis.CodexFiles?.openAccountFile)return CodexFiles.openAccountFile(entry);
    const ticket=++sequence,account=scope(),info=await api(url('files/preview',entry.path));if(ticket!==sequence||account!==scope())return;
    const body=$('preview-body');body.replaceChildren();$('preview-title').textContent=entry.path;$('file-preview').hidden=false;
    const download=el('a','下载原始文件','small');download.href=url('files/content',entry.path);download.download=entry.name;body.append(el('p',bytes(info.size)+(info.truncated?' · 预览已截断，引用仍读取原文件':''),'footnote'),download);
    if(info.kind==='text'||info.kind==='archive')body.append(el('pre',info.text||'(无文本内容)','file-text'));
    else if(info.kind==='image'){const img=el('img');img.alt=entry.name;img.style.maxWidth='100%';img.src=url('files/image',entry.path);body.append(img);}
    else if(info.kind==='pdf'){const button=el('button','加载 PDF 预览','small');button.onclick=()=>{if(account!==scope())return;const frame=el('iframe');frame.title=entry.name;frame.className='document-preview';frame.setAttribute('sandbox','');frame.referrerPolicy='no-referrer';frame.src=url('files/content',entry.path)+'&inline=1';button.replaceWith(frame);};body.append(button);}
    else body.append(el('p','请下载原文件查看。','footnote'));
  }
  async function refresh(){
    assert();if(!active())return CodexFeatures.loadFiles();const ticket=++sequence,account=scope(),path=folder,result=await api(url('files',path));if(ticket!==sequence||account!==scope()||path!==folder||!active())return;
    $('file-path').textContent=folder;const list=$('file-list');list.replaceChildren();
    for(const value of result.entries){const entry={...value,projectId},row=el('div',undefined,'file-row'),open=el('button',(entry.type==='directory'?'▸ ':'')+entry.name,'file-entry');open.type='button';open.onclick=action(async()=>{if(account!==scope())return;if(entry.type==='directory'){folder=entry.path;await refresh();}else await preview(entry);});row.append(open);
      const attach=el('button','引用','small');attach.type='button';attach.onclick=action(()=>{if(account===scope())reference(entry);});row.append(attach);
      if(entry.type==='file'){const link=el('a','↓','file-download');link.href=url('files/content',entry.path);link.download=entry.name;link.setAttribute('aria-label','下载 '+entry.name);row.append(el('span',bytes(entry.size),'footnote'),link);}list.append(row);
    }if(!result.entries.length)list.append(el('p','此目录为空，可上传原文件或新建目录。','footnote'));
  }
  async function open(){assert();$('file-scope').value=projectId;updateTools();S.panel='files';for(const name of ['quota','files','diff','browser'])$('panel-'+name).hidden=name!=='files';for(const b of document.querySelectorAll('[data-panel]')){b.classList.toggle('active',b.dataset.panel==='files');b.setAttribute('aria-selected',String(b.dataset.panel==='files'));}$('inspector').classList.add('inspect-open');await refresh();}
  async function upload(files,{path='.',attachToComposer=false}={}){
    assert();const account=scope(),epoch=S.epoch,entries=[];files=Array.from(files);
    if(attachToComposer&&S.references.length+files.length>12)throw Error('最多引用 12 个文件或目录');
    for(const file of files){if(account!==scope()||epoch!==S.epoch)throw Error('账号或对话已切换，上传已停止');const value=await CodexFeatures.upload(file,projectId,epoch,path);if(account!==scope()||epoch!==S.epoch)throw Error('账号或对话已切换，上传已停止');const entry={...value,projectId,name:file.name,size:file.size,type:'file'};entries.push(entry);if(attachToComposer)reference(entry);}
    if(S.panel==='files'&&active())await refresh();return entries;
  }
  function reset(){sequence++;folder='.';$('file-scope').value=projectId;$('account-folder-name').value='';$('account-upload-input').value='';updateTools();}
  function updateTools(){$('account-file-tools').hidden=!active();$('external-open').hidden=active();}
  $('file-scope').onchange=action(async()=>{sequence++;$('file-preview').hidden=true;$('preview-body').replaceChildren();updateTools();await refresh();});
  $('refresh-files').onclick=action(refresh);$('files-up').onclick=action(async()=>{if(active())folder=folder.includes('/')?folder.slice(0,folder.lastIndexOf('/')):'.';else S.filePath=S.filePath.includes('/')?S.filePath.slice(0,S.filePath.lastIndexOf('/')):'.';await refresh();});
  $('account-mkdir').onclick=action(async()=>{assert();const account=scope(),path=folder,name=$('account-folder-name').value.trim();if(!name)throw Error('请输入文件夹名称');await api('/api/codex/files/directory',{projectId,path,name});if(account!==scope())return;$('account-folder-name').value='';await refresh();});
  $('account-upload').onclick=()=>$('account-upload-input').click();$('account-upload-input').onchange=action(async()=>{try{await upload($('account-upload-input').files,{path:folder});}finally{$('account-upload-input').value='';}});
  globalThis.CodexAccountFiles={upload,open,refresh,reference,preview,reset};updateTools();
})();
