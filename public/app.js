'use strict';
const $ = id => document.getElementById(id);
const S = { user:null, csrf:'', projects:[], models:[], project:null, thread:null, threads:[], next:null,
  items:new Map(), pending:new Map(), status:'idle', cursor:'', stream:null, epoch:0, retry:0,
  timer:null, hiddenTimer:null, renderTimer:null, nodes:new Map(), attachments:[], bytes:0, truncated:false,
  connected:false, newTask:false, taskCreation:null, creationTimer:null, checkingCreation:false, attachedThreadId:null, capabilities:{}, panel:'quota', filePath:'.', syncing:null, sending:false, attempt:null, creationId:null,
  selected:[], references:[], goalDraft:'', accessConfirmed:false, tokenUsage:null, threadSettings:null, settingsOverrides:{}, modelRequest:null, modelsUnavailable:false,
  catalog:null, catalogProject:null, catalogRequest:null, menuMode:'plus', menuOpen:false, menuItems:[], menuIndex:0, referencePath:'.' };
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
      const message=data.data?.code==='BACKEND_ERROR'?'Codex 请求失败，请检查连接或登录状态。':data.data?.message;
      const error=new Error(message || `请求失败 (${response.status})`); error.status=response.status;error.code=data.data?.code; throw error;
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
function clearConversation() { clearTimeout(S.creationTimer);S.creationTimer=null;S.newTask=false;S.taskCreation=null;S.epoch++; closeStream(); clearTimeout(S.renderTimer); S.renderTimer=null; S.thread=null; S.items.clear(); S.pending.clear(); S.nodes.clear(); S.cursor=''; S.status='idle'; S.attachments=[]; S.attempt=null; S.creationId=null; S.syncing=null; S.truncated=false; $('timeline').replaceChildren($('empty')); $('empty').hidden=false; $('approvals').replaceChildren(); $('thread-title').textContent='新任务'; S.selected=[]; S.references=[]; S.goalDraft=''; S.accessConfirmed=false; S.tokenUsage=null; S.threadSettings=null; S.settingsOverrides={}; $('access').value='default'; closeMenu(); $('prompt').value=''; renderAttachments(); controls(); }
function loggedOut() { clearConversation(); S.user=null; S.csrf=''; S.connected=false; S.attachedThreadId=null; S.capabilities={}; S.projects=[]; S.threads=[]; S.project=null; S.models=[]; S.items.clear(); $('workspace').hidden=true; $('login-view').hidden=false; $('settings-dialog').close(); $('new-thread-dialog').close(); for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close(); $('password').value=''; S.catalog=null; }
function supports(capability) {
  if(capability==='createThread' && S.attachedThreadId)return false;
  return S.capabilities?.[capability]!==false;
}
function canStartTask(){return supports('createThread') || S.capabilities?.createWithMessage===true&&S.project?.canCreateTask!==false;}
function commandAvailable(command) {
  if(command.id==='new')return canStartTask();
  if(S.newTask&&['upload','references','plan','code','permissions','goal'].includes(command.id))return false;
  const capability={new:'createThread',skills:'extensions',plugins:'extensions',mcp:'mcp',goal:'setGoal'}[command.id];
  return (!capability || supports(capability)) && (!command.files || permission('files'));
}
function controls() {
  const ready=!!S.project && S.connected && permission('send');
  $('send').disabled=!ready || S.status==='running' || S.sending || !!S.taskCreation;
  $('check-creation').hidden=!S.taskCreation; $('check-creation').disabled=S.sending||S.checkingCreation;
  $('new-task-note').hidden=!S.newTask;
  $('empty').querySelector('p').textContent=S.newTask?'输入首条消息后创建任务':supports('extensions')?'输入消息，或用 / 选择技能':'输入消息，或用 / 选择功能';
  $('prompt').disabled=!ready || S.sending;
  $('stop').hidden=S.status!=='running'; $('stop').disabled=!ready || !S.thread;
  $('attach').disabled=!ready || S.sending || S.newTask;
  $('access').disabled=!ready || S.sending || S.newTask;
  for(const id of ['model','effort','mode'])$(id).disabled=!ready || S.sending || (id!=='mode'&&S.modelsUnavailable) || (id==='mode'&&S.newTask);
  $('access').querySelector('option[value=full]').disabled=!S.user?.admin;
  $('sidebar-plugins').disabled=!S.connected || !S.project || !supports('extensions');
  $('sidebar-plugins').title=supports('extensions')?'':'此连接暂不支持，请在 Codex 桌面使用。';
  $('new-thread').hidden=!supports('createThread')&&S.capabilities?.createWithMessage!==true;
  $('new-thread').disabled=!S.connected || !permission('send') || S.sending || !canStartTask();
  $('refresh-quota').hidden=!supports('quota');
  $('refresh-quota').disabled=!S.connected || !supports('quota');
  $('project-select').disabled=S.sending; $('settings').disabled=S.sending;
  $('refresh-threads').disabled=!S.connected || !S.project;
  $('task-status').textContent=stateName(S.status); $('task-status').className=`badge${S.status==='running'?' running':''}`;
  $('connection').textContent=S.connected?(S.attachedThreadId?'桌面任务已连接':'Codex 已连接'):'未连接'; $('connection').className=`badge${S.connected?' online':''}`;
  $('connect').hidden=!S.user?.admin || S.connected; $('settings').hidden=!S.user?.admin || !supports('configureTransport');
  $('refresh-files').disabled=!permission('files'); $('refresh-diff').disabled=!permission('files');
}
async function restoreAttachedThread(refresh=false) {
  if(!S.attachedThreadId||S.newTask)return false;
  if(S.thread&&S.capabilities?.switchThreads===true){if(refresh)await syncSnapshot();return true;}
  if(S.thread?.id===S.attachedThreadId){if(refresh)await syncSnapshot();return true;}
  const thread=S.threads.find(t=>t.id===S.attachedThreadId);
  if(!thread)throw new Error('当前桌面任务未加载，请刷新任务列表。');
  // Rebind without clearing the draft, attachments, permissions or idempotency key.
  const epoch=S.epoch;
  S.thread=thread; S.status=thread.status; $('thread-title').textContent=thread.title;
  $('empty').hidden=true; renderThreads(); await syncSnapshot();
  return epoch===S.epoch && S.thread?.id===S.attachedThreadId;
}
async function startNewConversation() {
  if(S.sending)return;
  if(S.capabilities?.createWithMessage===true){
    if(!canStartTask())throw new Error('请先在桌面保存此项目。');
    const warning=S.taskCreation?'上次创建尚未确认，继续会新建另一个任务。\n':'';
    if(!await confirmAction('在当前目录新建任务',warning+'目录：'+S.project.root+'\n不另建 worktree。发送首条消息时才创建，权限和执行模式使用桌面设置。'))return;
    clearConversation();forgetCreation();forgetSelectedTask();S.newTask=true;S.settingsOverrides={};
    const option=el('option','桌面默认模型');option.value='';$('model').prepend(option);$('model').value='';loadEfforts('');
    $('mode').value='code';if(!$('access').querySelector('option[value=desktop-default]')){const option=el('option','桌面设置');option.value='desktop-default';option.disabled=true;$('access').append(option);}$('access').value='desktop-default';renderSettingsSource();renderThreads();controls();notice();
  }else if(S.attachedThreadId){await restoreAttachedThread(true);notice('已连接桌面当前任务。');}
  else {if(!supports('createThread'))throw new Error('此连接不支持新建任务。');clearConversation();renderThreads();}
  $('prompt').focus();
}
function selectedTaskStorageKey(){return 'codex-webui-selected-task:'+S.user?.id;}
function rememberSelectedTask(){if(!S.capabilities?.switchThreads||!S.thread)return;try{sessionStorage.setItem(selectedTaskStorageKey(),JSON.stringify({threadId:S.thread.id,projectId:S.project.id}));}catch{}}
function forgetSelectedTask(){try{sessionStorage.removeItem(selectedTaskStorageKey());}catch{}}
async function restoreSelectedTask(){
  if(!S.capabilities?.switchThreads)return;let saved;try{saved=JSON.parse(sessionStorage.getItem(selectedTaskStorageKey())||'null');}catch{return;}
  if(saved?.projectId!==S.project?.id||!saved?.threadId)return;
  const thread=S.threads.find(t=>t.id===saved.threadId);if(thread)await selectThread(thread);
}
function creationStorageKey(){return 'codex-webui-creation:'+S.user?.id;}
function rememberCreation(record){try{sessionStorage.setItem(creationStorageKey(),JSON.stringify({requestId:record.requestId,projectId:record.projectId}));}catch{}}
function forgetCreation(){try{sessionStorage.removeItem(creationStorageKey());}catch{}}
async function applyCreationResult(result,epoch){
  if(epoch!==S.epoch)return;
  S.taskCreation=result;rememberCreation(result);
  if(result.messageAccepted===true)$('prompt').value='';
  if(result.thread){
    if(S.thread?.id!==result.thread.id){S.epoch++;closeStream();S.syncing=null;}
    S.newTask=false;S.thread=result.thread;S.status=result.thread.status;S.settingsOverrides={};S.attempt=null;
    S.threads=[result.thread,...S.threads.filter(t=>t.id!==result.thread.id)];$('thread-title').textContent=result.thread.title;renderThreads();
    await syncSnapshot();rememberSelectedTask();
    if(result.messageAccepted===true||result.messageAccepted===false){S.taskCreation=null;forgetCreation();}
    notice(result.message||'');renderSettingsSource();controls();return;
  }
  notice(result.message||(result.status==='submitting'?'桌面正在创建任务…':'创建结果尚未确认，请检查状态，不要重复发送。'));controls();
}
function scheduleCreationCheck(epoch,requestId,attempt=0){
  clearTimeout(S.creationTimer);if(attempt>=5||epoch!==S.epoch)return;
  S.creationTimer=setTimeout(async()=>{if(epoch!==S.epoch||S.taskCreation?.requestId!==requestId)return;try{await checkCreation(false);}catch{}if(S.taskCreation?.requestId===requestId&&S.taskCreation.status!=='failed'&&S.taskCreation.status!=='unknown')scheduleCreationCheck(epoch,requestId,attempt+1);},Math.min(8000,1000*2**attempt));
}
async function checkCreation(manual=true){
  if(!S.taskCreation||S.checkingCreation)return;
  const epoch=S.epoch,id=S.taskCreation.requestId;S.checkingCreation=true;controls();
  try{const result=await api('/api/codex/task-creations/'+encodeURIComponent(id));await applyCreationResult(result,epoch);}
  catch(error){if(epoch===S.epoch||S.taskCreation?.requestId===id)notice(error.status===404?'暂未找到创建记录。请求 ID 已保留，请检查桌面后再决定是否新建。':error.message);if(manual)throw error;}
  finally{S.checkingCreation=false;controls();}
}
async function resumeCreation(){
  let saved;try{saved=JSON.parse(sessionStorage.getItem(creationStorageKey())||'null');}catch{return;}
  if(!saved?.requestId||!S.projects.some(p=>p.id===saved.projectId))return;
  if(S.project.id!==saved.projectId)await chooseProject(saved.projectId);
  clearConversation();S.newTask=true;S.taskCreation={...saved,status:'submitting'};renderSettingsSource();await checkCreation(false);
  if(S.taskCreation)scheduleCreationCheck(S.epoch,saved.requestId);
}
async function sendNewDesktopTask(){
  if(S.taskCreation){await checkCreation();return;}
  const epoch=S.epoch,requestId=CodexState.requestId();
  const body={requestId,projectId:S.project.id,text:$('prompt').value,environment:'local',confirmCurrentDirectory:true,model:$('model').value,effort:$('effort').value,settingsOverrides:Object.keys(S.settingsOverrides||{}),attachments:[],extensions:[],references:[]};
  S.taskCreation={requestId,projectId:S.project.id,status:'submitting'};rememberCreation(S.taskCreation);notice('桌面正在创建任务…');
  let responseReceived=false;
  try{const result=await api('/api/codex/task-creations',body);responseReceived=true;await applyCreationResult(result,epoch);if(S.taskCreation?.requestId===requestId)scheduleCreationCheck(S.epoch,requestId);}
  catch(error){
    if(epoch===S.epoch||S.taskCreation?.requestId===requestId){if(!responseReceived&&error.status&&error.status<500&&error.code!=='CREATION_CHANGED'){S.taskCreation=null;forgetCreation();throw error;}
      notice(responseReceived?'桌面已返回创建结果，但输出暂未读取。请检查创建状态，不要重发。':'创建结果尚未确认，正在检查。不会重复发送首条消息。');scheduleCreationCheck(S.epoch,requestId);}
  }
}
async function signedIn(data) { S.user=data.user; S.csrf=data.csrf; $('login-view').hidden=true; $('workspace').hidden=false; $('password').value=''; $('user-name').textContent=S.user.username; await refreshContext();await restoreSelectedTask(); await resumeCreation(); }
async function refreshContext() {
  const [status, projects]=await Promise.all([api('/api/codex/status'),api('/api/codex/projects')]);
  S.connected=status.connected; S.attachedThreadId=status.attachedThreadId||null; S.capabilities=status.capabilities||{}; S.projects=projects; $('project-count').textContent=String(projects.length);
  $('project-select').replaceChildren();
  if(!projects.length) $('project-select').append(el('option','尚未分配项目'));
  for(const project of projects) { const option=el('option',project.name); option.value=project.id; $('project-select').append(option); }
  const selected=projects.find(p=>p.id===S.project?.id)||projects[0];
  if(!selected || selected.id!==S.project?.id) await chooseProject(selected?.id); else { S.project=selected; $('project-select').value=selected.id; if(S.connected) await loadThreads(); }
  if(S.attachedThreadId)await restoreAttachedThread();
  notice(!S.connected ? '未连接 Codex。请在设置中选择接口。' : !projects.length ? '尚无项目权限。' : '');
  controls();
  if(S.connected && (S.user.admin || projects.length)) {
    const results=await Promise.allSettled([loadModels(),loadQuota()]);
    for(const r of results) if(r.status==='rejected') toast(r.reason.message,true);
  }
}
async function chooseProject(id) {
  clearConversation(); S.project=S.projects.find(p=>p.id===id)||null; S.threads=[]; S.next=null; S.filePath='.'; S.catalog=null; S.catalogProject=null; S.catalogRequest=null;
  if(S.project) $('project-select').value=S.project.id;
  $('project-root').textContent=S.project?.root||''; $('breadcrumb').textContent=S.project?.name||'';
  $('thread-filter').value=''; $('file-list').replaceChildren(); $('diff-content').textContent='点击刷新'; renderThreads(); controls();
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
    button.append(el('strong',thread.title),el('span',`${stateName(thread.status)}${thread.updatedAt?' · '+date(thread.updatedAt):''}`));
    button.onclick=action(()=>selectThread(thread)); $('thread-list').append(button);
  }
  if(!S.threads.length) $('thread-list').append(el('p',S.connected?'暂无任务':'未连接','footnote'));
  $('more-threads').hidden=!S.next;
}
async function selectThread(thread) {
  if(S.sending) throw new Error('消息正在提交，请稍后切换。');
  if(S.thread?.id===thread.id){await syncSnapshot();return;}
  if(S.attachedThreadId&&S.capabilities?.switchThreads!==true){if(thread.id!==S.attachedThreadId)throw new Error('此连接仅支持桌面当前任务。');await restoreAttachedThread(true);return;}
  clearConversation(); S.thread=thread; $('thread-title').textContent=thread.title; $('sidebar').classList.remove('mobile-open'); renderThreads(); await syncSnapshot();rememberSelectedTask();
}
async function syncSnapshot() {
  if(!S.thread || !S.project) return;
  if(S.syncing) return S.syncing;
  closeStream(); const epoch=S.epoch, id=S.thread.id;
  const pending=(async()=>{
    $('stream-state').textContent='读取中…';
    const result=await api(apiProject(`threads/${encodeURIComponent(id)}`));
    if(epoch!==S.epoch) return;
    S.items=new Map(result.items.map(v=>[v.id,v])); S.pending=new Map(result.pending.map(v=>[v.id,v]));
    S.cursor=result.cursor; S.tokenUsage=result.tokenUsage||null; if(result.settings)applyThreadSettings(result.settings); S.status=result.status; S.truncated=result.truncated; S.nodes.clear(); $('timeline').replaceChildren($('empty')); $('empty').hidden=true;
    renderTimeline(); renderApprovals(); controls(); openStream();
    if(result.truncated) notice('仅显示最近记录。');
  })();
  S.syncing=pending;
  try { await pending; } finally { if(S.syncing===pending) S.syncing=null; }
}
function openStream() {
  closeStream(); if(!S.thread || !S.project || document.hidden) return;
  const epoch=S.epoch;
  const stream=new EventSource(apiProject('events',{threadId:S.thread.id,cursor:S.cursor})); S.stream=stream;
  stream.onopen=()=>{ if(epoch!==S.epoch)return; S.retry=0; $('stream-state').textContent='已连接'; };
  stream.addEventListener('codex',event=>{
    if(epoch!==S.epoch || S.stream!==stream) return;
    try {
      const data=JSON.parse(event.data); S.bytes+=new TextEncoder().encode(event.data).length;
      $('stream-state').title=`本页接收 ${bytes(S.bytes)}`;
      if(data.type==='reset') { syncSnapshot().catch(e=>toast(e.message,true)); return; }
      if(data.type==='connection') { S.connected=!!data.payload.connected; controls(); if(!S.connected) { closeStream(); notice('Codex 已断开，请重新连接。'); } }
      if(data.type==='limits') { if(S.panel==='quota'&&!document.hidden) loadQuota().catch(()=>{}); }
      if(!CodexState.applyEvent(S,data)) { syncSnapshot().catch(e=>toast(e.message,true)); return; }
      S.cursor=data.cursor;
      if(data.type==='approval'||data.type==='approvalResolved') renderApprovals();
      if(data.type==='status') { if(data.payload.settings)applyThreadSettings(data.payload.settings); if(data.payload.modelsChanged)loadModels().catch(e=>notice(e.message)); controls(); const row=S.threads.find(t=>t.id===S.thread?.id); if(row){row.status=S.status;renderThreads();} }
      if(data.type==='item'||data.type==='delta') scheduleRender();
    } catch { syncSnapshot().catch(e=>toast(e.message,true)); }
  });
  stream.onerror=()=>{
    if(epoch!==S.epoch||S.stream!==stream)return;
    closeStream(); $('stream-state').textContent='重连中…';
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
async function loadModels(){
  if(S.modelRequest)return S.modelRequest;
  const epoch=S.epoch;
  const pending=(async()=>{try{
    const result=await api(S.thread?apiProject('models',{threadId:S.thread.id}):'/api/codex/models');if(epoch!==S.epoch)return;
    const selection=$('model').value,effort=$('effort').value;
    S.models=result.data;S.modelsUnavailable=false;$('model').replaceChildren();
    if(S.newTask){const option=el('option','桌面默认模型');option.value='';$('model').append(option);}
    for(const model of S.models){const option=el('option',model.displayName||model.model||model.id);option.value=model.model||model.id;option.selected=!!model.isDefault;$('model').append(option);}
    if(S.attachedThreadId&&S.settingsOverrides?.model&&selection&&!S.models.some(m=>(m.model||m.id)===selection)){const stale=el('option',selection+' · 已不在目录');stale.value=selection;stale.disabled=true;$('model').append(stale);}
    if(S.newTask&&selection===''||S.models.some(m=>(m.model||m.id)===selection)||S.attachedThreadId&&S.settingsOverrides?.model&&selection){$('model').value=selection;loadEfforts(effort);}else loadEfforts();
    if(S.attachedThreadId){if(result.settings)S.threadSettings=result.settings;renderThreadSettings();}
    $('model').title=result.source||'';controls();
  }catch(error){if(epoch===S.epoch){S.modelsUnavailable=true;S.models=[];$('model').replaceChildren();renderThreadSettings();controls();}throw error;}})();
  S.modelRequest=pending;try{return await pending;}finally{if(S.modelRequest===pending)S.modelRequest=null;}
}
function loadEfforts(preferred){
  const model=S.models.find(m=>(m.model||m.id)===$('model').value);
  $('effort').replaceChildren(el('option','默认强度'));$('effort').firstChild.value='';
  for(const e of model?.supportedReasoningEfforts||[]){const option=el('option',e.reasoningEffort);option.value=e.reasoningEffort;option.selected=e.reasoningEffort===(preferred===undefined?model.defaultReasoningEffort:preferred);$('effort').append(option);}
}
function applyThreadSettings(settings){S.threadSettings=settings;renderThreadSettings();}
function markSettings(...keys){if(S.attachedThreadId){S.settingsOverrides||={};for(const key of keys)S.settingsOverrides[key]=true;renderSettingsSource();}}
function renderSettingsSource(){
  $('settings-source').hidden=!S.attachedThreadId;
  const modified=Object.keys(S.settingsOverrides||{}).length>0;
  $('settings-source').textContent=S.newTask?'桌面新任务设置':modified?'下次发送应用更改':'跟随桌面';
  $('settings-source').title=S.threadSettings?.provider||'';
  $('follow-desktop').hidden=!S.attachedThreadId||!modified||S.newTask;
}
function renderThreadSettings(){
  const settings=S.threadSettings;if(!S.attachedThreadId||!settings||S.newTask){renderSettingsSource();return;}
  const changed=S.settingsOverrides||{},effort=changed.effort?$('effort').value:settings.effort||'';
  if(!changed.model&&settings.model){
    if(!Array.from($('model').options).some(o=>o.value===settings.model)){const option=el('option',settings.model+' · 当前任务');option.value=settings.model;$('model').append(option);}
    $('model').value=settings.model;
  }
  loadEfforts(effort);
  if(effort&&!Array.from($('effort').options).some(o=>o.value===effort)){const option=el('option',effort);option.value=effort;$('effort').append(option);}
  $('effort').value=effort;
  if(!changed.mode)$('mode').value=settings.mode;
  if(!changed.access){
    if(settings.access==='custom'&&!$('access').querySelector('option[value=custom]')){const option=el('option','桌面自定义权限');option.value='custom';option.disabled=true;$('access').append(option);}
    $('access').value=settings.access;S.accessConfirmed=false;
  }
  $('access').title=[settings.sandboxType,settings.approvalPolicy].filter(Boolean).join(' · ');
  renderSettingsSource();
}
async function sendMessage(){
  if(S.sending || !S.project || !S.connected || !permission('send') || !$('prompt').value.trim())return;
  const epoch=S.epoch; let accepted=false;
  S.sending=true;
  try {
    controls();
    if(S.newTask){await sendNewDesktopTask();return;}
    if(S.taskCreation)throw new Error('请先检查首条消息的创建状态。');
    const content={text:$('prompt').value,projectId:S.project.id,model:$('model').value,effort:$('effort').value,mode:$('mode').value,attachments:[...S.attachments],extensions:S.selected.map(e=>e.id),references:[...S.references],access:$('access').value,confirmFullAccess:S.accessConfirmed,...(S.attachedThreadId?{settingsOverrides:Object.keys(S.settingsOverrides||{})}:{})};
    if(S.attachedThreadId && !await restoreAttachedThread())return;
    if(S.status==='running')throw new Error('任务仍在运行，请等待本轮结束。');
    // Only regular app-server mode may create a task on first send.
    if(!S.thread){
      if(!supports('createThread'))throw new Error('此连接不支持新建任务，请先选择已有任务。');
      S.creationId ||= CodexState.requestId();
      const thread=await api('/api/codex/threads',{projectId:content.projectId,title:content.text.trim().slice(0,60),requestId:S.creationId});
      if(epoch!==S.epoch)return;
      S.thread=thread; S.threads.unshift(thread); S.status=thread.status;
      $('thread-title').textContent=thread.title; $('empty').hidden=true; renderThreads();
    }
    if(S.goalDraft){await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/goal`,{projectId:S.project.id,objective:S.goalDraft},'PUT');S.goalDraft='';}
    const fingerprint=JSON.stringify({thread:S.thread.id,...content});
    if(S.attempt?.fingerprint!==fingerprint)S.attempt={fingerprint,requestId:CodexState.requestId()};
    await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/messages`,{...content,requestId:S.attempt.requestId});
    accepted=true;
    if(epoch===S.epoch){$('prompt').value='';S.attachments=[];S.selected=[];S.references=[];S.attempt=null;S.settingsOverrides={};renderSettingsSource();renderAttachments();notice();await syncSnapshot();}
  }catch(error){
    if(epoch===S.epoch)notice(accepted?'消息已发送，输出读取失败。点击任务可重新连接。':'发送失败：'+error.message);
    throw error;
  }finally{S.sending=false;controls();}
}
function renderAttachments(){
  const container=$('attachments'); container.replaceChildren();
  const chip=(label,remove)=>{const button=el('button',label+' ×','context-chip');button.type='button';button.onclick=()=>{if(S.sending)return;remove();renderAttachments();};container.append(button);};
  for(const file of S.attachments)chip(file.split('/').pop(),()=>S.attachments=S.attachments.filter(v=>v!==file));
  for(const entry of S.selected)chip((entry.kind==='plugin'?'◇ ':'$ ')+entry.label,()=>S.selected=S.selected.filter(v=>v.id!==entry.id));
  for(const ref of S.references)chip('▸ '+ref,()=>S.references=S.references.filter(v=>v!==ref));
  if(S.goalDraft)chip('目标：'+S.goalDraft.slice(0,40),()=>S.goalDraft='');
}
async function uploadFile(){
  const files=Array.from($('upload').files); if(!files.length)return;
  const epoch=S.epoch,projectId=S.project?.id;
  try{
    if(S.attachments.length+files.length>5)throw new Error('最多 5 个附件。');
    for(const file of files){
      if(file.size>4*1024*1024)throw new Error(`${file.name} 超过 4 MiB。`);
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取文件'));reader.readAsDataURL(file);});
      if(epoch!==S.epoch || !projectId)throw new Error('项目已切换，已取消上传。');
      const result=await api('/api/codex/files',{projectId,name:file.name,base64:data});
      if(epoch!==S.epoch)return;
      S.attachments.push(result.path);renderAttachments();
    }
  }finally{$('upload').value='';}
}
let quotaLoading=null;
async function loadQuota(){if(!supports('quota')){$('quota-content').textContent='请在 Codex 桌面查看额度和重置卡。';return;}if(!S.connected)return;if(quotaLoading)return quotaLoading;quotaLoading=(async()=>{try{const limits=await api('/api/codex/account/limits');renderQuota(limits);}catch(error){$('quota-content').textContent='暂时无法读取额度';throw error;}})();try{await quotaLoading;}finally{quotaLoading=null;} }
function renderQuota(limits){
  const container=$('quota-content');container.replaceChildren();
  const windows=limits.windows.filter(w=>!w.bucketId||w.bucketId==='codex');
  const visible=windows.length?windows:limits.windows;
  if(!visible.length)container.append(el('p','未提供额度数据','footnote'));
  for(const window of visible){
    const box=el('div',undefined,'quota-window'),head=el('div',undefined,'panel-title');
    const label=CodexState.windowLabel(window.windowDurationMins),remaining=Math.max(0,100-window.usedPercent);
    head.append(el('span',label),el('strong',`${Math.round(remaining)}%`));
    const bar=el('progress');bar.max=100;bar.value=remaining;bar.setAttribute('aria-label',`${label} 剩余 ${remaining}%`);
    box.append(head,bar,el('p',`剩余${window.resetsAt?' · '+shortDate(window.resetsAt)+' 重置':''}`,'footnote'));container.append(box);
  }
  const credits=limits.resetCredits;
  if(!credits){container.append(el('p','未提供重置卡数据','footnote'));return;}
  const rows=(credits.availableCount>0?credits.details:[]).filter(c=>(!c.status||c.status==='available')&&(c.expiresAt==null||c.expiresAt*1000>Date.now()));
  const cards=rows.length?rows:(credits.availableCount>0?[{id:undefined,expiresAt:undefined}]:[]);
  container.append(el('h3',`重置卡 · ${credits.availableCount}`,'quota-card-heading'));
  for(const credit of cards){
    const card=el('div',undefined,'credit');
    card.append(el('p',credit.expiresAt===null?'不过期':credit.expiresAt?shortDate(credit.expiresAt)+' 到期':'未提供到期日'));
    const button=el('button','使用重置卡','small');button.disabled=!S.user?.admin;
    let requestId=null;
    button.onclick=action(async()=>{
      if(!await confirmAction('使用重置卡','确认消耗一张重置卡？此操作不可撤销。'))return;
      requestId ||= CodexState.requestId();
      const result=await api('/api/codex/account/limits/reset',{requestId,...(credit.id?{creditId:credit.id}:{})});
      renderQuota(result.rateLimits);toast('已更新额度');
    });
    card.append(button);container.append(card);
  }
}
function shortDate(value){return new Date(value<1e12?value*1000:value).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});}
async function loadFiles(){if(!permission('files'))throw new Error('没有文件权限。');const epoch=S.epoch;const requested=S.filePath;const result=await api(apiProject('files',{path:requested}));if(epoch!==S.epoch||requested!==S.filePath)return;$('file-path').textContent=`/${requested==='.'?'':requested}`;$('file-list').replaceChildren();for(const entry of result.entries){if(entry.type==='directory'){const button=el('button',`▸ ${entry.name}`,'file-entry');button.onclick=action(async()=>{S.filePath=entry.path;await loadFiles();});$('file-list').append(button);}else{const link=el('a',entry.name,'file-entry');link.href=apiProject('files/content',{path:entry.path});link.download=entry.name;link.append(el('span',bytes(entry.size)));$('file-list').append(link);}}if(!result.entries.length)$('file-list').append(el('p','空目录或没有可展示的文件。','footnote')); }
async function loadDiff(){if(!permission('files'))throw new Error('没有文件权限。');const epoch=S.epoch;const result=await api(apiProject('diff'));if(epoch===S.epoch)$('diff-content').textContent=(result.text||'没有未提交的差异。')+(result.truncated?'\n[已截断到 256 KiB]':''); }
async function switchPanel(panel){S.panel=panel;for(const name of ['quota','files','diff'])$('panel-'+name).hidden=name!==panel;for(const b of document.querySelectorAll('[data-panel]')){const active=b.dataset.panel===panel;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));}if(panel==='files')await loadFiles();if(panel==='quota')await loadQuota();}
async function openSettings(){const config=await api('/api/codex/admin/config');$('transport').value=config.transport.type;$('endpoint').value=config.transport.endpoint;$('token-env').value=config.transport.bearerTokenEnv||'';$('concurrency').value=config.maxConcurrentTurns;$('enabled').checked=config.enabled;$('projects-json').value=JSON.stringify(config.projects,null,2);$('candidates').replaceChildren();await loadUsers();$('settings-dialog').showModal();}
async function loadUsers(){const users=await api('/api/admin/users');$('users-list').replaceChildren();for(const user of users){const row=el('div',undefined,'user-record'),info=el('div');info.append(el('strong',`${user.username}${user.admin?' · 管理员':''}`),el('code',user.id));const edit=el('button','编辑','small');edit.type='button';edit.onclick=()=>{$('edit-user-id').value=user.id;$('new-username').value=user.username;$('new-admin').checked=user.admin;$('new-password').value='';$('new-username').focus();};row.append(info,edit);$('users-list').append(row);} }
$('login-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;$('login-error').textContent='';try{const result=await api('/api/login',{username:$('username').value,password:$('password').value});await signedIn(result);}catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}};
$('logout').onclick=action(async()=>{await api('/api/logout',{});loggedOut();});
$('project-select').onchange=action(()=>chooseProject($('project-select').value));
$('thread-filter').oninput=renderThreads;$('refresh-threads').onclick=action(()=>loadThreads());$('more-threads').onclick=action(()=>loadThreads(true));
$('new-thread').onclick=action(startNewConversation);
$('check-creation').onclick=action(()=>checkCreation());
$('cancel-new-thread').onclick=()=>$('new-thread-dialog').close();
$('new-thread-form').onsubmit=action(async()=>{if(!supports('createThread'))throw new Error('此连接不支持新建任务。');const title=$('new-thread-title').value;const epoch=S.epoch;const submit=document.querySelector('#new-thread-form button[type=submit]');if(submit.disabled)return;submit.disabled=true;try{const thread=await api('/api/codex/threads',{projectId:S.project.id,title});$('new-thread-dialog').close();if(epoch===S.epoch){S.threads.unshift(thread);await selectThread(thread);}}finally{submit.disabled=false;}});
$('composer').onsubmit=action(sendMessage);$('prompt').onkeydown=promptKey;
$('prompt').oninput=()=>{S.menuIndex=0;if(/^\/[^\n]*$/.test($('prompt').value)){openMenu('slash').catch(e=>toast(e.message,true));}else if(S.menuMode==='slash')closeMenu();};
$('model').onchange=()=>{loadEfforts();if(S.newTask&&!$('model').value){delete S.settingsOverrides.model;delete S.settingsOverrides.effort;renderSettingsSource();}else markSettings('model','effort');};$('effort').onchange=()=>markSettings('effort');$('mode').onchange=()=>markSettings('mode');$('follow-desktop').onclick=()=>{if(S.sending)return;S.settingsOverrides={};renderThreadSettings();};$('stop').onclick=action(async()=>{await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/interrupt`,{projectId:S.project.id});});
$('attach').onclick=action(()=>S.menuOpen?closeMenu():openMenu('plus'));$('upload').onchange=action(uploadFile);
$('connect').onclick=action(async()=>{await api('/api/codex/admin/connect',{});await refreshContext();if(S.thread)await syncSnapshot();toast('已连接');});
$('settings').onclick=action(openSettings);$('close-settings').onclick=()=>$('settings-dialog').close();
$('config-form').onsubmit=action(async()=>{const transport={type:$('transport').value,endpoint:$('endpoint').value.trim()};if($('token-env').value.trim())transport.bearerTokenEnv=$('token-env').value.trim();await api('/api/codex/admin/config',{enabled:$('enabled').checked,transport,maxConcurrentTurns:Number($('concurrency').value),projects:JSON.parse($('projects-json').value)},'PUT');clearConversation();await refreshContext();toast('配置已保存。请手动连接 Codex。');$('settings-dialog').close();});
$('disconnect').onclick=action(async()=>{await api('/api/codex/admin/disconnect',{});clearConversation();await refreshContext();});
$('discover').onclick=action(async()=>{const candidates=await api('/api/codex/admin/discover');$('candidates').replaceChildren();if(!candidates.length)$('candidates').append(el('p','没有找到已有接口。请确认 Codex 以同一 Linux 用户运行，并确实暴露可附加端点。','footnote'));for(const c of candidates){const card=el('div',undefined,'candidate');card.append(el('strong',`${c.verified?'已验证':'未验证'} · ${c.type}`),el('p',c.endpoint));if(c.error)card.append(el('p',c.error));const use=el('button','使用此接口','small');use.type='button';use.onclick=()=>{$('transport').value=c.type;$('endpoint').value=c.endpoint;$('enabled').checked=true;toast('已填入，保存配置后再连接。');};card.append(use);$('candidates').append(card);}});
$('user-form').onsubmit=action(async()=>{const id=$('edit-user-id').value;await api('/api/admin/users',{...(id?{id}:{}),username:$('new-username').value,password:$('new-password').value,admin:$('new-admin').checked},'PUT');$('user-form').reset();$('edit-user-id').value='';if(id===S.user?.id){loggedOut();toast('当前账号已更新，请重新登录。');}else{await loadUsers();toast('账号已保存，旧会话已失效。');}});
$('cancel-edit-user').onclick=()=>{$('user-form').reset();$('edit-user-id').value='';};
for(const button of document.querySelectorAll('[data-panel]'))button.onclick=action(()=>switchPanel(button.dataset.panel));
$('refresh-quota').onclick=action(loadQuota);$('refresh-files').onclick=action(loadFiles);$('refresh-diff').onclick=action(loadDiff);$('files-up').onclick=action(async()=>{S.filePath=S.filePath.includes('/')?S.filePath.slice(0,S.filePath.lastIndexOf('/')):'.';await loadFiles();});
$('menu-toggle').onclick=()=>$('sidebar').classList.toggle('mobile-open');$('inspect-toggle').onclick=()=>$('inspector').classList.toggle('inspect-open');$('close-inspector').onclick=()=>$('inspector').classList.remove('inspect-open');
document.addEventListener('visibilitychange',()=>{clearTimeout(S.hiddenTimer);if(document.hidden)S.hiddenTimer=setTimeout(()=>{closeStream();$('stream-state').textContent='已暂停';},15000);else if(!S.stream&&S.thread&&S.connected)openStream();});
window.addEventListener('pagehide',closeStream);
window.addEventListener('focus',()=>{if(S.connected&&S.attachedThreadId)loadModels().catch(e=>notice(e.message));});
api('/api/session').then(signedIn).catch(error=>{if(error.status!==401)toast(error.message,true);});

const commands=[
  {id:'upload',label:'上传文件',description:'从本机添加附件',command:'/upload',files:true},
  {id:'references',label:'项目文件和文件夹',description:'引用当前项目中的路径',command:'/files',files:true},
  {id:'new',label:'新建任务',description:'开始新的对话',command:'/new'},
  {id:'plan',label:'计划模式',description:'先制定计划',command:'/plan'},
  {id:'code',label:'执行模式',description:'执行任务',command:'/code'},
  {id:'model',label:'模型',description:'选择模型与推理强度',command:'/model'},
  {id:'permissions',label:'访问权限',description:'默认、只读或完全访问',command:'/permissions'},
  {id:'skills',label:'技能',description:'选择当前项目可用的技能',command:'/skills'},
  {id:'plugins',label:'插件',description:'选择已安装的插件',command:'/plugins'},
  {id:'mcp',label:'MCP',description:'查看服务器状态',command:'/mcp'},
  {id:'status',label:'状态',description:'任务 ID、上下文用量',command:'/status'},
  {id:'goal',label:'目标',description:'设置任务目标',command:'/goal'},
  {id:'diff',label:'Diff',description:'查看项目变更',command:'/diff',files:true},
  {id:'stop',label:'停止',description:'中断当前任务',command:'/stop'}
];
async function loadCatalog(refresh=false){
  if(!S.project || !S.connected)return null;
  if(!supports('extensions')){S.catalogProject=S.project.id;return S.catalog={entries:[],skillsAvailable:false,pluginsAvailable:false,issues:['技能与插件：请在桌面使用']};}
  const projectId=S.project.id;
  if(!refresh && S.catalog && S.catalogProject===projectId)return S.catalog;
  if(!refresh && S.catalogRequest?.projectId===projectId)return S.catalogRequest.promise;
  const promise=api(apiProject('extensions',refresh?{refresh:'1'}:{}));S.catalogRequest={projectId,promise};
  try{const result=await promise;if(S.project?.id!==projectId)return null;S.catalog=result;S.catalogProject=projectId;return result;}
  finally{if(S.catalogRequest?.promise===promise)S.catalogRequest=null;}
}
async function openMenu(mode='plus',refresh=false){
  if(!S.project || !S.connected)return;
  if((mode==='skills'||mode==='plugins')&&!supports('extensions')){toast('此连接暂不支持，请在 Codex 桌面使用。');return;}
  const changing=!S.menuOpen || S.menuMode!==mode;
  S.menuMode=mode;S.menuOpen=true;
  if(changing){S.menuIndex=0;$('menu-query').value='';}
  $('composer-menu').hidden=false;$('attach').setAttribute('aria-expanded','true');$('prompt').setAttribute('aria-expanded',String(mode==='slash'));
  $('menu-title').textContent=({plus:'添加',slash:'命令与技能',skills:'技能',plugins:'插件'})[mode];
  $('menu-query').hidden=mode==='slash';
  renderMenu();
  if(mode!=='slash' && changing)$('menu-query').focus();
  await loadCatalog(refresh);
  if(S.menuOpen)renderMenu();
}
function closeMenu(){S.menuOpen=false;$('composer-menu').hidden=true;$('attach').setAttribute('aria-expanded','false');$('prompt').setAttribute('aria-expanded','false');$('prompt').removeAttribute('aria-activedescendant');}
function renderMenu(){
  if(!S.menuOpen)return;
  const query=(S.menuMode==='slash'?$('prompt').value.replace(/^\//,''):$('menu-query').value).trim().toLowerCase();
  const entries=(supports('extensions')&&S.catalogProject===S.project?.id?S.catalog?.entries:[])||[];
  const common=S.menuMode==='plus'?['upload','references','goal','plan']:['new','plan','permissions','mcp','status','goal'];
  const basic=['plus','slash'].includes(S.menuMode)?commands.filter(c=>(query||common.includes(c.id))&&commandAvailable(c)).map(c=>({...c,kind:'command',enabled:c.id!=='stop'||S.status==='running'})):[];
  const filtered=entries.filter(e=>S.menuMode!=='skills'&&S.menuMode!=='plugins'||e.kind===(S.menuMode==='skills'?'skill':'plugin'));
  const ordered=S.menuMode==='plus'?[...filtered.filter(e=>e.kind==='plugin'),...filtered.filter(e=>e.kind==='skill')]:filtered;
  const all=[...basic,...ordered];
  S.menuItems=all.filter(e=>`${e.label} ${e.name||''} ${e.description||''} ${e.command||''}`.toLowerCase().includes(query)).slice(0,100);
  if(S.menuIndex>=S.menuItems.length)S.menuIndex=0;
  const container=$('menu-list');container.replaceChildren();let lastGroup='';
  for(const [index,item] of S.menuItems.entries()){
    const group=({command:'功能',skill:'技能',plugin:'插件'})[item.kind];
    if(group!==lastGroup){container.append(el('div',group,'menu-group'));lastGroup=group;}
    const row=el('button',undefined,'menu-option');row.type='button';row.id=`menu-item-${index}`;row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===S.menuIndex));
    row.disabled=!item.enabled;
    const label=el('div',undefined,'menu-option-main');label.append(el('strong',item.label),el('span',item.description||'', 'menu-description'));
    const meta=item.kind==='command'?item.command:item.enabled?(item.kind==='plugin'?'插件':({user:'个人',repo:'项目',system:'系统',admin:'管理'})[item.scope]||'技能'):'已禁用';
    row.append(label,el('span',meta,'menu-meta'));row.onclick=action(()=>chooseMenu(index));container.append(row);
  }
  $('menu-status').textContent=!S.catalog?'读取技能与插件…':S.catalog.issues?.join('；')||(!S.menuItems.length?'没有匹配项':S.menuItems.length===100?'输入名称缩小范围':'');
  $('prompt').setAttribute('aria-activedescendant',`menu-item-${S.menuIndex}`);
}
async function chooseMenu(index){
  const item=S.menuItems[index];if(!item?.enabled)return;
  if(item.kind==='command'&&!commandAvailable(item))return;
  if(item.kind!=='command'&&!supports('extensions'))return;
  const slash=S.menuMode==='slash';if(slash)$('prompt').value='';
  closeMenu();
  if(item.kind!=='command'){
    if(S.selected.length>=12)throw new Error('最多选择 12 个技能或插件。');
    if(!S.selected.some(e=>e.id===item.id))S.selected.push(item);
    renderAttachments();$('prompt').focus();return;
  }
  switch(item.id){
    case 'upload':$('upload').click();break;
    case 'references':await openReferences();break;
    case 'new':await startNewConversation();break;
    case 'plan':$('mode').value='plan';markSettings('mode');$('prompt').focus();break;
    case 'code':$('mode').value='code';markSettings('mode');$('prompt').focus();break;
    case 'model':$('model').focus();if(typeof $('model').showPicker==='function')try{$('model').showPicker();}catch{}break;
    case 'permissions':$('access').focus();if(typeof $('access').showPicker==='function')try{$('access').showPicker();}catch{}break;
    case 'skills':await openMenu('skills');break;
    case 'plugins':await openMenu('plugins');break;
    case 'mcp':await showMcp();break;
    case 'status':await showStatus();break;
    case 'goal':await openGoal();break;
    case 'diff':$('inspector').classList.add('inspect-open');await switchPanel('diff');await loadDiff();break;
    case 'stop':$('stop').click();break;
  }
}
function menuKey(event){
  if(!S.menuOpen)return false;
  if(event.key==='Escape'){event.preventDefault();closeMenu();$('prompt').focus();return true;}
  if(['ArrowDown','ArrowUp'].includes(event.key)){
    event.preventDefault();const length=S.menuItems.length;if(length){S.menuIndex=(S.menuIndex+(event.key==='ArrowDown'?1:-1)+length)%length;renderMenu();document.getElementById(`menu-item-${S.menuIndex}`)?.scrollIntoView({block:'nearest'});}return true;
  }
  if((event.key==='Enter'&&!event.ctrlKey&&!event.metaKey)||event.key==='Tab'){
    if(S.menuItems[S.menuIndex]){event.preventDefault();chooseMenu(S.menuIndex).catch(e=>toast(e.message,true));return true;}
  }
  return false;
}
function promptKey(event){if(menuKey(event))return;if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();closeMenu();if(!$('send').disabled)$('composer').requestSubmit();}}
let confirmResolve=null;
function confirmAction(title,description){
  if(confirmResolve)return Promise.resolve(false);
  $('confirm-title').textContent=title;$('confirm-description').textContent=description;$('confirm-dialog').showModal();
  return new Promise(resolve=>confirmResolve=resolve);
}
function finishConfirm(value){const resolve=confirmResolve;confirmResolve=null;$('confirm-dialog').close();resolve?.(value);}
async function selectAccess(){
  markSettings('access');S.accessConfirmed=false;
  if($('access').value==='full'){
    const confirmed=S.user?.admin&&await confirmAction('完全访问','允许 Codex 访问项目外文件和网络，并跳过操作审批。仅对可信任务启用。');
    if(confirmed)S.accessConfirmed=true;else $('access').value='default';
  }
}
function showInfo(title){$('info-title').textContent=title;$('info-content').replaceChildren();$('info-dialog').showModal();return $('info-content');}
async function showMcp(){const root=showInfo('MCP');root.append(el('p','读取中…','muted'));try{const result=await api(apiProject('mcp',S.thread?{threadId:S.thread.id}:{}));root.replaceChildren();if(!result.data.length)root.append(el('p','未配置 MCP 服务器','muted'));for(const server of result.data){const card=el('section',undefined,'info-row');card.append(el('strong',server.name),el('p',`${server.runtimeStatus||'状态未知'} · ${server.authStatus||'认证状态未知'} · ${server.tools.length} 个工具`,'footnote'));if(server.tools.length){const details=el('details');details.append(el('summary','工具'),el('pre',server.tools.join('\n')));card.append(details);}root.append(card);}if(result.more)root.append(el('p','仅显示前 100 项','footnote'));}catch(error){root.textContent=error.message;}}
async function showStatus(){
  if(S.thread)await syncSnapshot();const root=showInfo('状态');
  const rows=[['项目',S.project?.name||'未选择'],['任务 ID',S.thread?.id||'尚未创建'],['状态',stateName(S.status)],['模型',$('model').value],['权限',$('access').selectedOptions[0].textContent]];
  const usage=S.tokenUsage;if(usage){rows.push(['累计 tokens',String(usage.total)],['最近一轮 tokens',String(usage.last)]);if(usage.contextWindow)rows.push(['上下文窗口',String(usage.contextWindow)]);}else rows.push(['上下文用量','尚未收到 Codex 用量数据']);
  for(const [label,value] of rows){const row=el('div',undefined,'status-row');row.append(el('span',label,'muted'),el('code',value));root.append(row);}
}
async function openGoal(){
  $('goal-objective').value=S.goalDraft;
  if(S.thread){try{const result=await api(apiProject(`threads/${encodeURIComponent(S.thread.id)}/goal`));$('goal-objective').value=result.goal?.objective||'';}catch(error){toast(error.message,true);}}
  $('goal-dialog').showModal();
}
async function openReferences(){S.referencePath='.';$('reference-dialog').showModal();await renderReferences();}
function addReference(value){if(S.references.length>=12)throw new Error('最多引用 12 个文件或文件夹。');if(!S.references.includes(value))S.references.push(value);renderAttachments();$('reference-dialog').close();$('prompt').focus();}
async function renderReferences(){
  const epoch=S.epoch,requested=S.referencePath;const result=await api(apiProject('files',{path:requested}));if(epoch!==S.epoch||requested!==S.referencePath)return;
  $('reference-path').textContent=requested;$('reference-list').replaceChildren();
  for(const entry of result.entries){const row=el('div',undefined,'reference-row'),open=el('button',(entry.type==='directory'?'▸ ':'')+entry.name,'file-entry');open.type='button';open.onclick=action(()=>entry.type==='directory'?(S.referencePath=entry.path,renderReferences()):addReference(entry.path));row.append(open);const add=el('button','引用','small');add.type='button';add.onclick=action(()=>addReference(entry.path));row.append(add);$('reference-list').append(row);}
}
$('menu-query').oninput=()=>{S.menuIndex=0;renderMenu();};$('menu-query').onkeydown=menuKey;
$('refresh-menu').onclick=action(()=>openMenu(S.menuMode,true));$('close-menu').onclick=closeMenu;
$('sidebar-plugins').onclick=action(()=>openMenu('plus'));
$('access').onchange=action(selectAccess);$('cancel-confirm').onclick=()=>finishConfirm(false);
$('confirm-form').onsubmit=event=>{event.preventDefault();finishConfirm(true);};$('confirm-dialog').addEventListener('cancel',()=>finishConfirm(false));
$('confirm-dialog').addEventListener('close',()=>{if(confirmResolve)finishConfirm(false);});
$('close-info').onclick=()=>$('info-dialog').close();$('close-goal').onclick=()=>$('goal-dialog').close();
$('goal-form').onsubmit=action(async()=>{const objective=$('goal-objective').value.trim();if(S.thread){await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/goal`,{projectId:S.project.id,objective},'PUT');}else S.goalDraft=objective;renderAttachments();$('goal-dialog').close();$('prompt').focus();});
$('close-references').onclick=()=>$('reference-dialog').close();$('reference-up').onclick=action(async()=>{S.referencePath=S.referencePath.includes('/')?S.referencePath.slice(0,S.referencePath.lastIndexOf('/')):'.';await renderReferences();});$('reference-current').onclick=action(()=>addReference(S.referencePath));
document.addEventListener('pointerdown',event=>{if(S.menuOpen&&!$('composer-menu').contains(event.target)&&event.target!==$('prompt')&&!$('attach').contains(event.target))closeMenu();});
