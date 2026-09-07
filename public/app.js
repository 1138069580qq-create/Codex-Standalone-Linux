'use strict';
const $ = id => document.getElementById(id);
const S = { user:null, csrf:'', projects:[], models:[], project:null, thread:null, threads:[], next:null,
  items:new Map(), pending:new Map(), status:'idle', cursor:'', stream:null, epoch:0, retry:0,
  timer:null, hiddenTimer:null, renderTimer:null, nodes:new Map(), attachments:[], bytes:0, truncated:false,
  connected:false, panel:'quota', filePath:'.', syncing:null, sending:false, attempt:null };
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KiB` : `${(n/1048576).toFixed(1)} MiB`;
const date = v => v ? new Date(v < 1e12 ? v*1000 : v).toLocaleString('zh-CN', { hour12:false }) : '未知';
const stateName = v => ({idle:'待命',running:'运行中',inProgress:'运行中',completed:'已完成',interrupted:'已停止',failed:'失败',notLoaded:'未加载',active:'运行中',systemError:'错误'})[v] || v;
const labelType = v => ({userMessage:'你',agentMessage:'Codex',commandExecution:'命令',fileChange:'文件变更',reasoning:'公开摘要',plan:'计划'})[v] || v;
function el(tag, text, className) { const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(className) node.className=className; return node; }
let toastTimer;
function toast(message, bad=false) { $('toast').textContent=message; $('toast').className=`toast${bad?' error':''}`; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,6000); }
function notice(message='') { $('notice').textContent=message; $('notice').hidden=!message; }
function action(fn) { return async event => { event?.preventDefault(); const target=event?.currentTarget; const isButton=target?.tagName==='BUTTON'; if(isButton) target.disabled=true; try { await fn(event); } catch(error) { toast(error.message,true); } finally { if(isButton) target.disabled=false; controls(); } }; }
async function api(url, body, method=body===undefined?'GET':'POST') {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),45000);
  try {
    const response=await fetch(url, {method, credentials:'same-origin', signal:controller.signal,
      headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':S.csrf}, body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) {
      if(response.status===401 && S.user) loggedOut();
      const error=new Error(data.data?.message || `请求失败 (${response.status})`); error.status=response.status; throw error;
    }
    return data;
  } catch(error) {
    if(error.name==='AbortError') throw new Error('请求超时。写入结果可能未知，请刷新检查；消息重试会复用同一请求 ID。');
    throw error;
  } finally { clearTimeout(timer); }
}
const q = params => new URLSearchParams(params).toString();
const apiProject = (route, extra={}) => `/api/codex/${route}?${q({projectId:S.project?.id||'',...extra})}`;
function permission(name) { return !!S.project?.permissions?.[name]; }
function closeStream() { clearTimeout(S.timer); S.timer=null; S.stream?.close(); S.stream=null; }
function clearConversation() { S.epoch++; closeStream(); clearTimeout(S.renderTimer); S.renderTimer=null; S.thread=null; S.items.clear(); S.pending.clear(); S.nodes.clear(); S.cursor=''; S.status='idle'; S.attachments=[]; S.attempt=null; S.syncing=null; S.truncated=false; $('timeline').replaceChildren($('empty')); $('empty').hidden=false; $('approvals').replaceChildren(); $('thread-title').textContent='准备好，开始你的下一步。'; $('prompt').value=''; renderAttachments(); controls(); }
function loggedOut() { clearConversation(); S.user=null; S.csrf=''; S.connected=false; S.projects=[]; S.threads=[]; S.project=null; S.models=[]; S.items.clear(); $('workspace').hidden=true; $('login-view').hidden=false; $('settings-dialog').close(); $('new-thread-dialog').close(); $('password').value=''; }
function controls() {
  const ready=!!S.thread && S.connected && permission('send');
  $('send').disabled=!ready || S.status==='running' || S.sending;
  $('prompt').disabled=!ready || S.sending;
  $('stop').hidden=S.status!=='running'; $('stop').disabled=!ready;
  $('attach').disabled=!ready || !permission('files') || S.sending;
  $('new-thread').disabled=!S.connected || !permission('send') || S.sending;
  $('project-select').disabled=S.sending; $('settings').disabled=S.sending;
  $('refresh-threads').disabled=!S.connected || !S.project;
  $('task-status').textContent=stateName(S.status); $('task-status').className=`badge${S.status==='running'?' running':''}`;
  $('connection').textContent=S.connected?'Codex 已连接':'未连接'; $('connection').className=`badge${S.connected?' online':''}`;
  $('connect').hidden=!S.user?.admin || S.connected; $('settings').hidden=!S.user?.admin;
  $('refresh-files').disabled=!permission('files'); $('refresh-diff').disabled=!permission('files');
}
async function signedIn(data) { S.user=data.user; S.csrf=data.csrf; $('login-view').hidden=true; $('workspace').hidden=false; $('password').value=''; $('user-name').textContent=S.user.username; await refreshContext(); }
async function refreshContext() {
  const [status, projects]=await Promise.all([api('/api/codex/status'),api('/api/codex/projects')]);
  S.connected=status.connected; S.projects=projects; $('project-count').textContent=String(projects.length);
  $('project-select').replaceChildren();
  if(!projects.length) $('project-select').append(el('option','尚未分配项目'));
  for(const project of projects) { const option=el('option',project.name); option.value=project.id; $('project-select').append(option); }
  const selected=projects.find(p=>p.id===S.project?.id)||projects[0];
  if(!selected || selected.id!==S.project?.id) await chooseProject(selected?.id); else { S.project=selected; $('project-select').value=selected.id; if(S.connected) await loadThreads(); }
  notice(!S.connected ? 'Codex 尚未连接。管理员可在设置中扫描已有接口并保存配置，再点击「连接 Codex」。应用不会自动启动 Codex。' : !projects.length ? '暂无授权项目。请让管理员添加项目并为你的账号授权。' : '');
  controls();
  if(S.connected && (S.user.admin || projects.length)) {
    const results=await Promise.allSettled([loadModels(),loadQuota()]);
    for(const r of results) if(r.status==='rejected') toast(r.reason.message,true);
  }
}
async function chooseProject(id) {
  clearConversation(); S.project=S.projects.find(p=>p.id===id)||null; S.threads=[]; S.next=null; S.filePath='.';
  if(S.project) $('project-select').value=S.project.id;
  $('project-root').textContent=S.project?.root||'项目目录不会自动创建'; $('breadcrumb').textContent=`WORKSPACE / ${S.project?.name||'OVERVIEW'}`;
  $('thread-filter').value=''; $('file-list').replaceChildren(); $('diff-content').textContent='点击刷新读取 Git Diff。'; renderThreads(); controls();
  if(S.connected && S.project) await loadThreads();
}
async function loadThreads(more=false) {
  if(!S.project || !S.connected) return;
  const epoch=S.epoch, project=S.project.id;
  const result=await api(apiProject('threads',more&&S.next?{cursor:S.next}:{}));
  if(epoch!==S.epoch || S.project?.id!==project) return;
  S.threads=more?[...new Map([...S.threads,...result.data].map(v=>[v.id,v])).values()]:result.data;
  S.next=result.nextCursor; renderThreads();
}
function renderThreads() {
  const filter=$('thread-filter').value.toLowerCase(); $('thread-list').replaceChildren();
  for(const thread of S.threads.filter(t=>t.title.toLowerCase().includes(filter))) {
    const button=el('button',undefined,`task-link${S.thread?.id===thread.id?' active':''}`);
    button.append(el('strong',thread.title),el('span',`${stateName(thread.status)} · ${date(thread.updatedAt)}`));
    button.onclick=action(()=>selectThread(thread)); $('thread-list').append(button);
  }
  if(!S.threads.length) $('thread-list').append(el('p',S.connected?'这个项目还没有任务。':'连接后显示任务。','footnote'));
  $('more-threads').hidden=!S.next;
}
async function selectThread(thread) {
  if(S.sending) throw new Error('消息正在提交，请稍后切换。');
  clearConversation(); S.thread=thread; $('thread-title').textContent=thread.title; $('sidebar').classList.remove('mobile-open'); renderThreads(); await syncSnapshot();
}
async function syncSnapshot() {
  if(!S.thread || !S.project) return;
  if(S.syncing) return S.syncing;
  closeStream(); const epoch=S.epoch, id=S.thread.id;
  const pending=(async()=>{
    $('stream-state').textContent='读取任务快照…';
    const result=await api(apiProject(`threads/${encodeURIComponent(id)}`));
    if(epoch!==S.epoch) return;
    S.items=new Map(result.items.map(v=>[v.id,v])); S.pending=new Map(result.pending.map(v=>[v.id,v]));
    S.cursor=result.cursor; S.status=result.status; S.truncated=result.truncated; S.nodes.clear(); $('timeline').replaceChildren($('empty')); $('empty').hidden=true;
    renderTimeline(); renderApprovals(); controls(); openStream();
    if(result.truncated) notice('仅显示最近的部分记录；较旧内容仍保存在 Codex。');
  })();
  S.syncing=pending;
  try { await pending; } finally { if(S.syncing===pending) S.syncing=null; }
}
function openStream() {
  closeStream(); if(!S.thread || !S.project || document.hidden) return;
  const epoch=S.epoch;
  const stream=new EventSource(apiProject('events',{threadId:S.thread.id,cursor:S.cursor})); S.stream=stream;
  stream.onopen=()=>{ if(epoch!==S.epoch)return; S.retry=0; $('stream-state').textContent='增量文本流 · 已连接'; };
  stream.addEventListener('codex',event=>{
    if(epoch!==S.epoch || S.stream!==stream) return;
    try {
      const data=JSON.parse(event.data); S.bytes+=new TextEncoder().encode(event.data).length;
      $('network-stats').textContent=`本页 SSE ${bytes(S.bytes)}`;
      if(data.type==='reset') { syncSnapshot().catch(e=>toast(e.message,true)); return; }
      if(data.type==='connection') { S.connected=!!data.payload.connected; controls(); if(!S.connected) { closeStream(); notice('Codex 连接已断开。请由管理员手动重连；未确认的命令不会自动重发。'); } }
      if(data.type==='limits') { if(S.panel==='quota'&&!document.hidden) loadQuota().catch(()=>{}); }
      if(!CodexState.applyEvent(S,data)) { syncSnapshot().catch(e=>toast(e.message,true)); return; }
      S.cursor=data.cursor;
      if(data.type==='approval'||data.type==='approvalResolved') renderApprovals();
      if(data.type==='status') { controls(); const row=S.threads.find(t=>t.id===S.thread?.id); if(row){row.status=S.status;renderThreads();} }
      if(data.type==='item'||data.type==='delta') scheduleRender();
    } catch { syncSnapshot().catch(e=>toast(e.message,true)); }
  });
  stream.onerror=()=>{
    if(epoch!==S.epoch||S.stream!==stream)return;
    closeStream(); $('stream-state').textContent='连接中断 · 等待重连';
    scheduleReconnect(epoch);
  };
}
function scheduleReconnect(epoch){
  if(epoch!==S.epoch || document.hidden || !S.thread) return;
  const delay=Math.min(30000,1000*2**Math.min(S.retry++,5))*(.8+Math.random()*.4);
  S.timer=setTimeout(async()=>{
    if(epoch!==S.epoch || document.hidden)return;
    try { await api('/api/session'); if(epoch===S.epoch)openStream(); }
    catch(error){ if(error.status!==401 && epoch===S.epoch){$('stream-state').textContent='网络不可用 · 退避重连中';scheduleReconnect(epoch);} }
  },delay);
}
function scheduleRender(){ if(!S.renderTimer) S.renderTimer=setTimeout(()=>{S.renderTimer=null;renderTimeline();},80); }
function renderTimeline(){
  const timeline=$('timeline'); const follow=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<120;
  $('empty').hidden=!!S.thread;
  for(const [id,node] of S.nodes) if(!S.items.has(id)){node.root.remove();S.nodes.delete(id);}
  for(const item of S.items.values()){
    let node=S.nodes.get(item.id);
    if(!node){
      const root=el('article',undefined,`message ${item.type}`); let pre=el('pre');
      if(['userMessage','agentMessage','plan'].includes(item.type)) root.append(el('div',labelType(item.type),'message-head'),pre);
      else { const details=el('details'); details.append(el('summary',labelType(item.type)+(item.status?` · ${item.status}`:'')),pre); root.append(details); }
      timeline.append(root); node={root,pre}; S.nodes.set(item.id,node);
    }
    const text=item.text+(item.truncated?'\n[内容已截断]':''); if(node.pre.textContent!==text) node.pre.textContent=text;
    const summary=node.root.querySelector('summary'); if(summary) summary.textContent=labelType(item.type)+(item.status?` · ${item.status}`:'');
  }
  if(follow) timeline.scrollTop=timeline.scrollHeight;
}
function renderApprovals(){
  $('approvals').replaceChildren();
  for(const pending of S.pending.values()){
    const card=el('section',undefined,'approval'); card.append(el('strong',pending.kind==='question'?'Codex 需要你的回答':'等待操作审批'),el('p',pending.description));
    if(pending.kind==='question'){
      const form=el('form');
      for(const question of pending.questions||[]){ const label=el('label',question.question||question.header||question.id); const input=el('input'); input.name=question.id; input.required=true; input.maxLength=8192;
        if(question.options?.length) label.append(el('span',question.options.map(o=>`${o.label}: ${o.description||''}`).join(' / '),'footnote'));
        label.append(input); form.append(label); }
      const send=el('button','提交回答','primary');send.disabled=!permission('send');form.append(send);
      form.onsubmit=action(async()=>{const answers={};for(const field of form.querySelectorAll('input'))answers[field.name]={answers:[field.value]};await answerApproval(pending.id,{answers});});card.append(form);
    } else if(pending.kind==='unsupported') card.append(el('p','此请求须在兼容的 Codex 客户端中处理。','footnote'));
    else for(const decision of pending.decisions||[]){const button=el('button',({accept:'允许本次',decline:'拒绝',cancel:'取消'})[decision]||decision,decision==='accept'?'primary':'small');button.disabled=!permission('approve');button.onclick=action(()=>answerApproval(pending.id,{decision}));card.append(button);}
    $('approvals').append(card);
  }
}
async function answerApproval(id,answer){ const thread=S.thread?.id, epoch=S.epoch; if(!thread)return; await api(`/api/codex/threads/${encodeURIComponent(thread)}/approvals/${encodeURIComponent(id)}`,{projectId:S.project.id,...answer});if(epoch===S.epoch){S.pending.delete(id);renderApprovals();} }
async function loadModels(){ const {data}=await api('/api/codex/models');S.models=data;$('model').replaceChildren();for(const model of data){const option=el('option',model.displayName||model.model||model.id);option.value=model.model||model.id;option.selected=!!model.isDefault;$('model').append(option);}loadEfforts(); }
function loadEfforts(){ const model=S.models.find(m=>(m.model||m.id)===$('model').value);$('effort').replaceChildren(el('option','默认强度'));$('effort').firstChild.value='';for(const e of model?.supportedReasoningEfforts||[]){const option=el('option',e.reasoningEffort);option.value=e.reasoningEffort;option.selected=e.reasoningEffort===model.defaultReasoningEffort;$('effort').append(option);} }
async function sendMessage(){
  if(S.sending||!S.thread||!S.project||!$('prompt').value.trim())return;
  S.sending=true;controls();const epoch=S.epoch;
  const content={text:$('prompt').value,projectId:S.project.id,model:$('model').value,effort:$('effort').value,mode:$('mode').value,attachments:[...S.attachments]};
  const fingerprint=JSON.stringify({thread:S.thread.id,...content});
  if(S.attempt?.fingerprint!==fingerprint) S.attempt={fingerprint,requestId:crypto.randomUUID()};
  try {
    await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/messages`,{...content,requestId:S.attempt.requestId});
    if(epoch===S.epoch){$('prompt').value='';S.attachments=[];S.attempt=null;renderAttachments();await syncSnapshot();}
  } catch(error){notice('发送未确认：先检查任务状态。对同一内容再次发送将复用请求 ID，不自动重复提交。');throw error;}
  finally{S.sending=false;controls();}
}
function renderAttachments(){ $('attachments').replaceChildren();for(const file of S.attachments){const button=el('button',`${file.split('/').pop()} ×`);button.type='button';button.onclick=()=>{S.attachments=S.attachments.filter(v=>v!==file);renderAttachments();};$('attachments').append(button);} }
async function uploadFile(){const file=$('upload').files[0];if(!file)return;const epoch=S.epoch, projectId=S.project?.id;try{if(S.attachments.length>=5)throw new Error('最多 5 个附件。');if(file.size>4*1024*1024)throw new Error('上传文件不能超过 4 MiB。');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});if(epoch!==S.epoch || !projectId)throw new Error('项目已切换，已取消上传。');const result=await api('/api/codex/files',{projectId,name:file.name,base64:data});if(epoch===S.epoch){S.attachments.push(result.path);renderAttachments();toast('已上传到项目内的独立附件目录。');}}finally{$('upload').value='';} }
let quotaLoading=null;
async function loadQuota(){if(!S.connected)return;if(quotaLoading)return quotaLoading;quotaLoading=(async()=>{try{const limits=await api('/api/codex/account/limits');renderQuota(limits);}catch(error){$('quota-content').textContent=`额度不可用：${error.message}`;throw error;}})();try{await quotaLoading;}finally{quotaLoading=null;} }
function renderQuota(limits){
  const container=$('quota-content');container.replaceChildren();
  if(!limits.windows.length)container.append(el('p','Codex 未提供额度窗口（部分 API-key / 自定义供应商账号不支持）。','footnote'));
  for(const window of limits.windows){const box=el('div',undefined,'quota-window'),head=el('div',undefined,'panel-title');const minutes=window.windowDurationMins;const label=minutes===10080?'周限额':minutes===300?'5 小时限额':minutes?`${minutes} 分钟窗口`:(window.name||window.id);head.append(el('span',label),el('strong',`${Math.round(window.usedPercent)}%`));const bar=el('progress');bar.max=100;bar.value=window.usedPercent;bar.setAttribute('aria-label',`${label} 已用 ${window.usedPercent}%`);box.append(head,bar,el('p',`已用 · 重置 ${date(window.resetsAt)}`,'footnote'));if(window.planType)box.append(el('p',window.planType,'footnote'));container.append(box);}
  const credits=limits.resetCredits;
  if(credits){container.append(el('p',`可用重置卡：${credits.availableCount}`,'footnote'));for(const credit of credits.details){const card=el('div',undefined,'credit');card.append(el('strong',credit.title||'重置卡'));if(credit.description)card.append(el('p',credit.description));card.append(el('p',`到期 ${date(credit.expiresAt)}`,'footnote'));if(S.user?.admin&&credits.availableCount>0){const button=el('button','使用此卡','small');button.onclick=action(async()=>{if(!confirm('此操作会消耗共享 Codex 账号的重置卡，影响所有用户。确认使用？'))return;const result=await api('/api/codex/account/limits/reset',{requestId:crypto.randomUUID(),creditId:credit.id});renderQuota(result.rateLimits);toast('已请求使用，并重新读取实际额度。');});card.append(button);}container.append(card);}}
  container.append(el('p',`读取于 ${date(limits.fetchedAt)}`,'footnote'));
}
async function loadFiles(){if(!permission('files'))throw new Error('没有文件权限。');const epoch=S.epoch;const requested=S.filePath;const result=await api(apiProject('files',{path:requested}));if(epoch!==S.epoch||requested!==S.filePath)return;$('file-path').textContent=`/${requested==='.'?'':requested}`;$('file-list').replaceChildren();for(const entry of result.entries){if(entry.type==='directory'){const button=el('button',`▸ ${entry.name}`,'file-entry');button.onclick=action(async()=>{S.filePath=entry.path;await loadFiles();});$('file-list').append(button);}else{const link=el('a',entry.name,'file-entry');link.href=apiProject('files/content',{path:entry.path});link.download=entry.name;link.append(el('span',bytes(entry.size)));$('file-list').append(link);}}if(!result.entries.length)$('file-list').append(el('p','空目录或没有可展示的文件。','footnote')); }
async function loadDiff(){if(!permission('files'))throw new Error('没有文件权限。');const epoch=S.epoch;const result=await api(apiProject('diff'));if(epoch===S.epoch)$('diff-content').textContent=(result.text||'没有未提交的差异。')+(result.truncated?'\n[已截断到 256 KiB]':''); }
async function switchPanel(panel){S.panel=panel;for(const name of ['quota','files','diff'])$('panel-'+name).hidden=name!==panel;for(const b of document.querySelectorAll('[data-panel]')){const active=b.dataset.panel===panel;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));}if(panel==='files')await loadFiles();if(panel==='quota')await loadQuota();}
async function openSettings(){const config=await api('/api/codex/admin/config');$('transport').value=config.transport.type;$('endpoint').value=config.transport.endpoint;$('token-env').value=config.transport.bearerTokenEnv||'';$('concurrency').value=config.maxConcurrentTurns;$('enabled').checked=config.enabled;$('projects-json').value=JSON.stringify(config.projects,null,2);$('candidates').replaceChildren();await loadUsers();$('settings-dialog').showModal();}
async function loadUsers(){const users=await api('/api/admin/users');$('users-list').replaceChildren();for(const user of users){const row=el('div',undefined,'user-record'),info=el('div');info.append(el('strong',`${user.username}${user.admin?' · 管理员':''}`),el('code',user.id));const edit=el('button','编辑','small');edit.type='button';edit.onclick=()=>{$('edit-user-id').value=user.id;$('new-username').value=user.username;$('new-admin').checked=user.admin;$('new-password').value='';$('new-username').focus();};row.append(info,edit);$('users-list').append(row);} }
$('login-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;$('login-error').textContent='';try{const result=await api('/api/login',{username:$('username').value,password:$('password').value});await signedIn(result);}catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}};
$('logout').onclick=action(async()=>{await api('/api/logout',{});loggedOut();});
$('project-select').onchange=action(()=>chooseProject($('project-select').value));
$('thread-filter').oninput=renderThreads;$('refresh-threads').onclick=action(()=>loadThreads());$('more-threads').onclick=action(()=>loadThreads(true));
$('new-thread').onclick=()=>{$('new-thread-title').value='';$('new-thread-dialog').showModal();};
$('cancel-new-thread').onclick=()=>$('new-thread-dialog').close();
$('new-thread-form').onsubmit=action(async()=>{const title=$('new-thread-title').value;const epoch=S.epoch;const submit=document.querySelector('#new-thread-form button[type=submit]');if(submit.disabled)return;submit.disabled=true;try{const thread=await api('/api/codex/threads',{projectId:S.project.id,title});$('new-thread-dialog').close();if(epoch===S.epoch){S.threads.unshift(thread);await selectThread(thread);}}finally{submit.disabled=false;}});
$('composer').onsubmit=action(sendMessage);$('prompt').onkeydown=event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();if(!$('send').disabled)$('composer').requestSubmit();}};
$('model').onchange=loadEfforts;$('stop').onclick=action(async()=>{await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/interrupt`,{projectId:S.project.id});});
$('attach').onclick=()=>$('upload').click();$('upload').onchange=action(uploadFile);
$('connect').onclick=action(async()=>{await api('/api/codex/admin/connect',{});await refreshContext();if(S.thread)await syncSnapshot();toast('已连接已有 Codex。');});
$('settings').onclick=action(openSettings);$('close-settings').onclick=()=>$('settings-dialog').close();
$('config-form').onsubmit=action(async()=>{const transport={type:$('transport').value,endpoint:$('endpoint').value.trim()};if($('token-env').value.trim())transport.bearerTokenEnv=$('token-env').value.trim();await api('/api/codex/admin/config',{enabled:$('enabled').checked,transport,maxConcurrentTurns:Number($('concurrency').value),projects:JSON.parse($('projects-json').value)},'PUT');clearConversation();await refreshContext();toast('配置已保存。请手动连接 Codex。');$('settings-dialog').close();});
$('disconnect').onclick=action(async()=>{await api('/api/codex/admin/disconnect',{});clearConversation();await refreshContext();});
$('discover').onclick=action(async()=>{const candidates=await api('/api/codex/admin/discover');$('candidates').replaceChildren();if(!candidates.length)$('candidates').append(el('p','没有找到已有接口。请确认 Codex 以同一 Linux 用户运行，并确实暴露可附加端点。','footnote'));for(const c of candidates){const card=el('div',undefined,'candidate');card.append(el('strong',`${c.verified?'已验证':'未验证'} · ${c.type}`),el('p',c.endpoint));if(c.error)card.append(el('p',c.error));const use=el('button','使用此接口','small');use.type='button';use.onclick=()=>{$('transport').value=c.type;$('endpoint').value=c.endpoint;$('enabled').checked=true;toast('已填入，保存配置后再连接。');};card.append(use);$('candidates').append(card);}});
$('user-form').onsubmit=action(async()=>{const id=$('edit-user-id').value;await api('/api/admin/users',{...(id?{id}:{}),username:$('new-username').value,password:$('new-password').value,admin:$('new-admin').checked},'PUT');$('user-form').reset();$('edit-user-id').value='';if(id===S.user?.id){loggedOut();toast('当前账号已更新，请重新登录。');}else{await loadUsers();toast('账号已保存，旧会话已失效。');}});
$('cancel-edit-user').onclick=()=>{$('user-form').reset();$('edit-user-id').value='';};
for(const button of document.querySelectorAll('[data-panel]'))button.onclick=action(()=>switchPanel(button.dataset.panel));
$('refresh-quota').onclick=action(loadQuota);$('refresh-files').onclick=action(loadFiles);$('refresh-diff').onclick=action(loadDiff);$('files-up').onclick=action(async()=>{S.filePath=S.filePath.includes('/')?S.filePath.slice(0,S.filePath.lastIndexOf('/')):'.';await loadFiles();});
$('menu-toggle').onclick=()=>$('sidebar').classList.toggle('mobile-open');$('inspect-toggle').onclick=()=>$('inspector').classList.toggle('inspect-open');$('close-inspector').onclick=()=>$('inspector').classList.remove('inspect-open');
document.addEventListener('visibilitychange',()=>{clearTimeout(S.hiddenTimer);if(document.hidden)S.hiddenTimer=setTimeout(()=>{closeStream();$('stream-state').textContent='后台标签页已暂停；返回后续传';},15000);else if(!S.stream&&S.thread&&S.connected)openStream();});
window.addEventListener('pagehide',closeStream);
api('/api/session').then(signedIn).catch(error=>{if(error.status!==401)toast(error.message,true);});
