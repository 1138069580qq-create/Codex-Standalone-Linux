'use strict';
const $ = id => document.getElementById(id);
const S = { user:null, csrf:'', projects:[], models:[], project:null, thread:null, threads:[], next:null,
  items:new Map(), turns:[], pending:new Map(), status:'idle', cursor:'', stream:null, epoch:0, retry:0,
  timer:null, streamStableTimer:null, hiddenTimer:null, renderTimer:null, nodes:new Map(), attachments:[], bytes:0, truncated:false,
  historyState:'none', historyError:'', historySavedAt:0, cacheError:'', listError:'', contextError:'', contextSequence:0, authRevision:0, reconnecting:null, streamLost:false, connected:false, newTask:false, taskCreation:null, creationTimer:null, checkingCreation:false, attachedThreadId:null, capabilities:{}, panel:'quota', filePath:'.', syncing:null, sending:false, attempt:null, creationId:null,
  selected:[], references:[], goalDraft:'', accessConfirmed:false, tokenUsage:null, turnId:null, queueCount:0, threadSettings:null, settingsOverrides:{}, modelRequest:null, modelsUnavailable:false,
  catalog:null, catalogProject:null, catalogRequest:null, menuMode:'plus', menuOpen:false, menuItems:[], menuIndex:0, referencePath:'.', sideOrigin:null,actionAttempt:null };
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KiB` : `${(n/1048576).toFixed(1)} MiB`;
const date = v => v ? new Date(v < 1e12 ? v*1000 : v).toLocaleString('zh-CN', { hour12:false }) : '未知';
const stateName = v => ({idle:'待命',running:'运行中',inProgress:'运行中',completed:'已完成',interrupted:'已停止',failed:'失败',notLoaded:'未加载',active:'运行中',systemError:'错误'})[v] || v;
const labelType = v => ({userMessage:'你',agentMessage:'Codex',commandExecution:'命令',fileChange:'文件变更',reasoning:'公开摘要',plan:'计划'})[v] || v;
function el(tag, text, className) { const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(className) node.className=className; return node; }
let toastTimer;
const dialogStack=[];
for(const dialog of document.querySelectorAll('dialog')){
  const show=dialog.showModal.bind(dialog);
  dialog.showModal=function(){if(!this.open){const error=this.querySelector('[data-layer-message]');if(error){error.textContent='';error.hidden=true;}show();}const i=dialogStack.indexOf(this);if(i>=0)dialogStack.splice(i,1);dialogStack.push(this);};
  dialog.addEventListener('close',()=>{if(!dialog.open){const i=dialogStack.indexOf(dialog);if(i>=0)dialogStack.splice(i,1);}});
}
function messageLayer(target){return target?.closest?.('dialog[open]')||dialogStack.findLast(d=>d.open)||(!S.user?$('login-form'):null);}
function layerMessage(message='',bad=true,layer=messageLayer()){
  let node;
  if(layer?.id==='login-form')node=$('login-error');
  else if(layer?.open){node=layer.querySelector('[data-layer-message]');if(!node){node=el('p');node.dataset.layerMessage='true';const header=layer.querySelector('.dialog-header');if(header)header.after(node);else layer.prepend(node);}node.className=bad?'error layer-message':'notice layer-message';node.setAttribute('role',bad?'alert':'status');}
  else node=$('notice');
  node.textContent=message;node.hidden=!message;
  if(message&&layer?.open)layer.scrollTop=0;
}
function toast(message,bad=false,layer=messageLayer()) { if(bad||layer){layerMessage(message,bad,layer);return;} $('toast').textContent=message;$('toast').className='toast';$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000); }
function notice(message='') { layerMessage(message,false,null); }
function action(fn) { return async event => { event?.preventDefault();const target=event?.currentTarget,layer=messageLayer(target),isButton=target?.tagName==='BUTTON';if(isButton)target.disabled=true;try{await fn(event);}catch(error){if(!error.handled)toast(error.message,true,layer?.open||layer?.id==='login-form'?layer:messageLayer());}finally{if(isButton)target.disabled=false;controls();} }; }
async function api(url, body, method=body===undefined?'GET':'POST') {
  const controller=new AbortController(),requestEpoch=S.epoch,requestUser=S.user?.id; const timer=setTimeout(()=>controller.abort(),45000);
  try {
    if(!['GET','HEAD'].includes(method)&&S.thread&&S.historyState!=='ready'&&/^\/api\/codex\/threads\//.test(url)&&!url.split('?')[0].endsWith('/sync'))throw new Error('任务尚未同步，请先重试读取。');
    const response=await (globalThis.CodexPlatform?.request || fetch)(url, {method, credentials:'same-origin', signal:controller.signal,
      headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':S.csrf}, body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) {
      if(response.status===401 && requestEpoch===S.epoch && requestUser && requestUser===S.user?.id) loggedOut();
      const message=data.data?.code==='BACKEND_ERROR'?'服务器处理失败，请重试。':data.data?.message;
      const error=new Error(message || `请求失败 (${response.status})`); error.status=response.status;error.code=data.data?.code;if(/^[a-f0-9-]{36}$/.test(data.data?.requestId||'')){error.requestId=data.data.requestId;error.message+='（诊断 '+error.requestId.slice(0,8)+'）';}throw error;
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
function closeStream() { clearTimeout(S.streamStableTimer);S.streamStableTimer=null; clearTimeout(S.timer); S.timer=null; S.stream?.close(); S.stream=null; }
function clearConversation() { globalThis.CodexRecovery?.reset(); globalThis.CodexFeatures?.reset(); globalThis.CodexQueue?.reset();S.turnId=null;S.turns=[];S.queueCount=0;globalThis.CodexUsage?.metrics(null); clearTimeout(S.creationTimer);S.creationTimer=null;S.newTask=false;S.newTaskConfirmed=false;S.modelRequest=null;S.modelsUnavailable=false;S.taskCreation=null;S.epoch++; closeStream(); if(!S.sideOrigin)$('side-context').hidden=true; clearTimeout(S.renderTimer); S.renderTimer=null; S.thread=null; S.items.clear(); S.pending.clear(); S.nodes.clear(); S.cursor=''; S.status='idle'; S.attachments=[]; S.attempt=null; S.creationId=null; S.syncing=null; S.truncated=false; $('timeline').replaceChildren($('empty')); $('empty').hidden=false; $('approvals').replaceChildren(); $('thread-title').textContent='新任务'; S.selected=[]; S.references=[]; S.goalDraft=''; S.accessConfirmed=false; S.tokenUsage=null; S.threadSettings=null; S.settingsOverrides={}; $('access').value='default'; closeMenu(); $('prompt').value=''; renderAttachments(); controls(); }
function clearAdminView(){
 for(const id of ['users-list','registration-list','admin-members','candidates'])document.getElementById(id)?.replaceChildren();
 for(const id of ['config-form','user-form'])document.getElementById(id)?.reset();
 for(const id of ['projects-json','endpoint','token-env','edit-user-id','new-username','new-password']){const field=document.getElementById(id);if(field)field.value='';}
 const checkbox=document.getElementById('new-admin');if(checkbox)checkbox.checked=false;
}
function loggedOut() { clearAdminView();S.authRevision++;globalThis.CodexAccountFiles?.reset();globalThis.CodexRecovery?.cacheCurrent();globalThis.CodexHistory?.reset();S.contextError='';S.listError='';S.streamLost=false;globalThis.CodexPlatform?.clearSession(); globalThis.CodexUsage?.reset(); S.sideOrigin=null;$('side-context').hidden=true;$('side-history').replaceChildren();clearConversation(); S.user=null; S.csrf=''; S.connected=false; S.attachedThreadId=null; S.capabilities={}; S.projects=[]; S.threads=[]; S.project=null; S.models=[]; S.items.clear(); $('workspace').hidden=true; $('login-view').hidden=false; $('settings-dialog').close(); $('new-thread-dialog').close(); for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close(); setAuthMode('login'); S.catalog=null; }
function supports(capability) {
  if(capability==='createThread' && S.attachedThreadId)return false;
  return S.capabilities?.[capability]!==false;
}
function canStartTask(){return supports('createThread') || S.capabilities?.createWithMessage===true&&S.project?.canCreateTask!==false;}
function commandAvailable(command) {
  if(command.id==='new')return canStartTask();if(command.id==='upload'&&globalThis.CodexAccountFiles)return !!S.user;
  if(S.newTask&&(['references','goal'].includes(command.id)||S.capabilities?.firstMessageExtensions!==true&&['plan','code','permissions','skills','plugins'].includes(command.id)))return false;
  if(['review','side','fork','compact','feedback','archive','pin','rename'].includes(command.id))return S.capabilities?.taskActions===true&&!!S.thread;
  const capability={new:'createThread',skills:'extensions',plugins:'extensions',mcp:'mcp',goal:'setGoal'}[command.id];
  return (!capability || supports(capability)) && (!command.files || permission('files'));
}
function commandDisabledReason(command){
  if(S.thread&&S.historyState!=='ready')return '任务尚未同步，请先重试读取';
  if(['review','side','fork','compact','feedback','archive','pin','rename'].includes(command.id)&&!S.thread)return '先创建或选择聊天';
  if(!commandAvailable(command))return S.newTask?'创建聊天后可用':'当前连接或权限不支持';
  if(command.id==='stop'&&S.status!=='running')return '当前没有运行中的任务';
  if(['review','compact','fork','side','archive'].includes(command.id)&&S.status==='running')return '任务结束后可用';
  return '';
}
function renderContextWindow(){
  const node=$('context-window'),info=CodexState.contextWindow(S.thread?S.tokenUsage:null);
  const model=(S.models||[]).find(m=>(m.model||m.id)===(S.threadSettings?.model||(!Object.keys(S.settingsOverrides||{}).length?$('model').value:null)));
  node.hidden=false;
  const count=v=>new Intl.NumberFormat('zh-CN').format(v),short=v=>v>=1e6?(v/1e6).toFixed(1)+'M':v>=1000?(v/1000).toFixed(1)+'K':String(v);
  node.textContent=info.percent!==null?'上下文 '+info.percent.toFixed(1)+'% · '+short(info.used)+' / '+short(info.capacity):info.used!==null?'上下文 '+short(info.used)+' / 未提供':info.capacity!==null?'上下文 — / '+short(info.capacity):'上下文：待获取';
  node.title=info.percent!==null?'上下文已用 '+count(info.used)+' / '+count(info.capacity)+' tokens（'+info.percent.toFixed(1)+'%），剩余 '+count(info.remaining)+' tokens。按 Codex 最近一次用量计算，不是累计账单；点击查看状态。':S.thread?'等待 Codex 提供完整上下文数据，不推测窗口大小。点击查看状态。':'创建或选择聊天后显示上下文窗口信息。';
  if(info.capacity===null&&model?.contextWindow>0){node.textContent+=' · 模型上限 '+short(model.contextWindow);node.title+=' 模型目录上限 '+count(model.contextWindow)+' tokens；实际可用窗口以 Codex 用量通知为准。';}
  node.className='context-window'+(info.percent!==null&&info.percent>=85?' context-warning':'');node.disabled=!S.thread;
}
function controls() {
  renderContextWindow();
  const ready=!!S.project && S.connected && !S.contextError && (!S.thread||S.historyState==='ready') && permission('send');
  $('send').disabled=!ready || S.sending || !!S.taskCreation;
  $('send').textContent=S.status==='running'||S.queueCount?'排队 ↑':'发送 ↑';
  $('send-now').hidden=S.status!=='running'||S.capabilities?.steer===false;
  $('send-now').disabled=!ready||S.sending||!S.thread||!S.turnId;
  $('send').title=S.status==='running'?'当前轮结束后按顺序发送；可在队列中立即发送、编辑或删除':'发送消息';
  $('check-creation').hidden=!S.taskCreation; $('check-creation').disabled=S.sending||S.checkingCreation;
  $('new-task-note').hidden=!S.newTask;
  $('empty').querySelector('p').textContent=S.newTask?'输入首条消息后创建任务':supports('extensions')?'输入消息，或用 / 选择技能':'输入消息，或用 / 选择功能';
  $('prompt').disabled=!ready || S.sending;
  $('stop').hidden=S.status!=='running'; $('stop').disabled=!ready || !S.thread;
  $('attach').disabled=!ready || S.sending || S.newTask&&S.capabilities?.firstMessageExtensions!==true;
  $('access').disabled=!ready || S.sending || S.newTask&&S.capabilities?.firstMessageExtensions!==true;
  for(const id of ['model','effort','mode'])$(id).disabled=!ready || S.sending || (id!=='mode'&&S.modelsUnavailable) || (id==='mode'&&S.newTask&&S.capabilities?.firstMessageExtensions!==true);
  $('access').querySelector('option[value=full]').disabled=!S.user;
  $('sidebar-plugins').disabled=!S.connected || !S.project || !supports('extensions');
  $('sidebar-plugins').title=supports('extensions')?'':'技能接口未连接。';
  $('new-thread').hidden=!supports('createThread')&&S.capabilities?.createWithMessage!==true;
  $('new-thread').disabled=!S.connected || !!S.contextError || !permission('send') || S.sending || !canStartTask();
  $('refresh-quota').hidden=false;
  $('refresh-quota').disabled=!S.user;
  $('new-project').hidden=S.capabilities?.projects!==true;$('projectless').hidden=S.capabilities?.projectless!==true;$('new-project').disabled=S.sending;$('projectless').disabled=S.sending;
  $('return-main').hidden=!S.sideOrigin;$('return-main').disabled=S.sending;
  $('project-select').disabled=S.sending; $('settings').disabled=S.sending;
  $('refresh-threads').disabled=!S.project || !!S.reconnecting;
  $('task-status').textContent=S.historyState==='cached'?'待同步':stateName(S.status); $('task-status').className=`badge${S.status==='running'?' running':''}`;
  $('connection').textContent=S.connected?(S.attachedThreadId?'桌面任务已连接':'Codex 已连接'):'未连接'; $('connection').className=`badge${S.connected?' online':''}`;
  $('connect').hidden=!S.user; $('settings').hidden=!S.user?.admin || !supports('configureTransport');
  $('refresh-files').disabled=!S.user; $('refresh-diff').disabled=!permission('files');globalThis.CodexMobileMenus?.refresh();globalThis.CodexRecovery?.render();
}
async function restoreAttachedThread(refresh=false) {
  if(!S.attachedThreadId||S.newTask)return false;
  if(S.capabilities?.switchThreads===true&&!S.threads.some(t=>t.id===S.attachedThreadId)&&!S.thread)return false;
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
    const epoch=S.epoch;
    if(!canStartTask())throw new Error('请先在桌面保存此项目。');
    const warning=S.taskCreation?'上次创建尚未确认，继续会新建另一个任务。\n':'';
    if(!await confirmAction(S.project.kind==='projectless'?'新建无项目对话':'在当前项目新建聊天',warning+(S.project.kind==='projectless'?'使用独立聊天目录，不关联项目。':'目录：'+S.project.root+'\n不另建 worktree。')+'\n发送首条消息时才创建。'))return;
    if(epoch!==S.epoch)throw new Error('项目或任务已切换，请重新新建任务。');
    clearConversation();forgetCreation();forgetSelectedTask();S.newTask=true;S.newTaskConfirmed=true;S.settingsOverrides={};
    const option=el('option','桌面默认模型');option.value='';$('model').prepend(option);$('model').value='';loadEfforts('');
    $('mode').value='code';if(!$('access').querySelector('option[value=desktop-default]')){const option=el('option','桌面设置');option.value='desktop-default';option.disabled=true;$('access').append(option);}$('access').value='desktop-default';renderSettingsSource();renderThreads();controls();notice();
  }else if(S.attachedThreadId){await restoreAttachedThread(true);notice('已连接桌面当前任务。');}
  else {if(!supports('createThread'))throw new Error('此连接不支持新建任务。');forgetSelectedTask();clearConversation();renderThreads();}
  $('prompt').focus();
}
function selectedTaskStorageKey(){return 'codex-webui-selected-task:'+(globalThis.CodexHistory?.namespace||'')+':'+S.user?.id;}
function rememberSelectedTask(){if(!S.user?.id||!S.project||!S.thread||S.attachedThreadId&&S.capabilities?.switchThreads!==true)return;globalThis.CodexHistory?.selected(S.project.id,S.thread.id).catch(error=>globalThis.CodexRecovery?.cacheError(error));try{sessionStorage.setItem(selectedTaskStorageKey(),JSON.stringify({threadId:S.thread.id,projectId:S.project.id}));}catch{}}
function forgetSelectedTask(){globalThis.CodexHistory?.remove('@account','selected').catch(()=>{});try{sessionStorage.removeItem(selectedTaskStorageKey());}catch{}}
async function restoreSelectedTask(){
  if(!S.user?.id||S.attachedThreadId&&S.capabilities?.switchThreads!==true)return;
  const epoch=S.epoch,account=S.user.id;let saved;
  try{saved=await globalThis.CodexHistory?.read('@account','selected');if(!saved)saved=JSON.parse(sessionStorage.getItem(selectedTaskStorageKey())||'null');}catch{}
  if(epoch!==S.epoch||account!==S.user?.id||!saved?.threadId||!S.projects.some(p=>p.id===saved.projectId))return;
  if(saved.projectId!==S.project?.id)await chooseProject(saved.projectId);
  if(account!==S.user?.id||S.project?.id!==saved.projectId)return;
  const thread=S.threads.find(t=>t.id===saved.threadId);if(thread)await selectThread(thread);
}
function creationStorageKey(){return 'codex-webui-creation:'+S.user?.id;}
function rememberCreation(record){try{sessionStorage.setItem(creationStorageKey(),JSON.stringify({requestId:record.requestId,projectId:record.projectId}));}catch{}}
function forgetCreation(){try{sessionStorage.removeItem(creationStorageKey());}catch{}}
async function applyCreationResult(result,epoch){
  if(epoch!==S.epoch)return;
  S.taskCreation=result;rememberCreation(result);
  if(result.messageAccepted===true){$('prompt').value='';S.selected=[];renderAttachments();}
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
  if(!S.newTaskConfirmed){if(!await confirmAction('创建聊天',S.project.kind==='projectless'?'使用独立目录，不关联项目。':'工作目录：'+S.project.root))return;S.newTaskConfirmed=true;}
  if(S.taskCreation){await checkCreation();return;}
  const epoch=S.epoch,requestId=CodexState.requestId();
  const body={requestId,projectId:S.project.id,text:$('prompt').value,environment:'local',confirmCurrentDirectory:true,model:$('model').value,effort:$('effort').value,mode:$('mode').value,access:$('access').value,confirmFullAccess:S.accessConfirmed,settingsOverrides:Object.keys(S.settingsOverrides||{}),attachments:[...S.attachments],extensions:S.selected.map(e=>e.id),references:[...S.references]};
  S.taskCreation={requestId,projectId:S.project.id,status:'submitting'};rememberCreation(S.taskCreation);notice('桌面正在创建任务…');
  let responseReceived=false;
  try{const result=await api('/api/codex/task-creations',body);responseReceived=true;await applyCreationResult(result,epoch);if(S.taskCreation?.requestId===requestId)scheduleCreationCheck(S.epoch,requestId);}
  catch(error){
    if(epoch===S.epoch||S.taskCreation?.requestId===requestId){if(!responseReceived&&error.status&&error.status<500&&error.code!=='CREATION_CHANGED'){S.taskCreation=null;forgetCreation();throw error;}
      notice(responseReceived?'桌面已返回创建结果，但输出暂未读取。请检查创建状态，不要重发。':'创建结果尚未确认，正在检查。不会重复发送首条消息。');scheduleCreationCheck(S.epoch,requestId);}
  }
}
async function signedIn(data) {
  const auth=++S.authRevision;globalThis.CodexAccountFiles?.reset();S.user=data.user;S.csrf=data.csrf;S.contextError='';
  $('login-view').hidden=true;$('workspace').hidden=false;$('password').value='';$('user-name').textContent=S.user.username;controls();
  try{await globalThis.CodexHistory?.init(data.user);}catch(error){globalThis.CodexRecovery?.cacheError(error);}
  if(auth!==S.authRevision)return;
  try{await refreshContext();if(auth!==S.authRevision)return;await restoreSelectedTask();if(auth===S.authRevision)await resumeCreation();}
  catch(error){if(auth===S.authRevision&&S.user&&!error.handled)notice(error.message);}
}
async function refreshContext({restoreAttached=true}={}) {
  const account=S.user?.id,epoch=S.epoch,sequence=++S.contextSequence;
  const results=await Promise.allSettled([api('/api/codex/status'),api('/api/codex/projects')]);
  if(account!==S.user?.id||epoch!==S.epoch||sequence!==S.contextSequence)return;
  const [statusResult,projectResult]=results;
  S.contextError=results.find(r=>r.status==='rejected')?.reason?.message||'';
  if(statusResult.status==='fulfilled'){
    const status=statusResult.value;S.connected=!!status.connected;S.attachedThreadId=status.attachedThreadId||null;S.capabilities=status.capabilities||{};
  }
  // Update the connection control before any fallible history/model request.
  controls();
  if(projectResult.status==='rejected')throw projectResult.reason;
  const projects=projectResult.value;S.projects=projects;$('project-count').textContent=String(projects.filter(p=>p.kind!=='projectless').length);
  $('project-select').replaceChildren();if(!projects.length)$('project-select').append(el('option','尚未分配项目'));
  for(const project of projects){const option=el('option',project.kind==='projectless'?'无项目对话':project.name);option.value=project.id;$('project-select').append(option);}
  const selected=projects.find(p=>p.id===S.project?.id)||projects[0];
  try{
    if(!selected||selected.id!==S.project?.id)await chooseProject(selected?.id);
    else {S.project=selected;$('project-select').value=selected.id;await loadThreads();}
    if(account!==S.user?.id||sequence!==S.contextSequence)return;
    if(restoreAttached&&S.attachedThreadId)try{await restoreAttachedThread();}catch(error){if(account===S.user?.id&&!error.handled)notice(error.message);}
    if(S.connected&&(S.user?.admin||projects.length)){
      // These panels report their own state and cannot suppress task restoration.
      await Promise.allSettled([loadModels(),loadQuota()]);
    }
  }finally{if(account===S.user?.id&&sequence===S.contextSequence)controls();}
}
async function chooseProject(id) {
  clearConversation(); S.sideOrigin=null;S.project=S.projects.find(p=>p.id===id)||null; S.threads=[]; S.next=null; S.filePath='.'; S.catalog=null; S.catalogProject=null; S.catalogRequest=null;
  if(S.project) $('project-select').value=S.project.id;
  $('side-context').hidden=true;$('project-root').textContent=S.project?.kind==='projectless'?'不关联项目':S.project?.root||''; $('breadcrumb').textContent=S.project?.name||'';
  $('thread-filter').value=''; $('file-list').replaceChildren(); $('diff-content').textContent='点击刷新'; renderThreads(); controls();
  const epoch=S.epoch;if(S.project){await loadThreads();if(epoch!==S.epoch)return;if(S.connected&&S.capabilities?.createWithMessage===true&&!S.threads.some(t=>t.id===S.attachedThreadId)){S.newTask=true;S.settingsOverrides={};$('model').value='';$('mode').value='code';}if(S.connected)await loadModels().catch(()=>{});controls();}
}
async function loadThreads(more=false) {
  if(!S.project)return;
  const epoch=S.epoch,project=S.project.id;let received=false;S.listError='';
  const cache=globalThis.CodexHistory?.read(project,'@threads').then(row=>{
    if(received||epoch!==S.epoch||project!==S.project?.id||S.threads.length||!Array.isArray(row?.data))return;
    S.threads=globalThis.CodexHistoryCore.threads(row.data).data;renderThreads();
  }).catch(error=>{if(epoch===S.epoch)globalThis.CodexRecovery?.cacheError(error);});
  try{
    const result=await api(apiProject('threads',more&&S.next?{cursor:S.next}:{}));
    if(epoch!==S.epoch||project!==S.project?.id)return;
    received=true;if(result.connection){S.connected=!!result.connection.connected;S.capabilities=result.connection.capabilities||S.capabilities;}S.threads=more?[...new Map([...S.threads,...result.data].map(v=>[v.id,v])).values()]:result.data;S.next=result.nextCursor;
    await globalThis.CodexHistory?.write(project,'@threads',globalThis.CodexHistoryCore.threads(S.threads)).catch(error=>{if(epoch===S.epoch)globalThis.CodexRecovery?.cacheError(error);});
  }catch(error){if(epoch!==S.epoch)return;S.listError='任务列表未同步 · '+error.message;if(error.status===503)S.connected=false;if([401,403,404].includes(error.status)){received=true;S.threads=[];await globalThis.CodexHistory?.remove(project,'@threads').catch(()=>{});if(epoch!==S.epoch)return;if(S.thread)globalThis.CodexRecovery?.failed(error);}else await cache;}
  if(epoch===S.epoch){renderThreads();controls();}
}
function renderThreads() {
  const filter=$('thread-filter').value.toLowerCase(); $('thread-list').replaceChildren();
  for(const thread of [...S.threads].sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)).filter(t=>t.title.toLowerCase().includes(filter))) {
    const button=el('button',undefined,`task-link${S.thread?.id===thread.id?' active':''}`);
    button.append(el('strong',(thread.pinned?'↑ ':'')+thread.title),el('span',`${stateName(thread.status)}${thread.updatedAt?' · '+date(thread.updatedAt):''}`));
    button.onclick=action(()=>selectThread(thread)); $('thread-list').append(button);
  }
  if(S.listError)$('thread-list').append(el('p',S.listError,'footnote'));else if(!S.threads.length)$('thread-list').append(el('p',S.connected?'暂无任务':'未连接','footnote'));
  $('more-threads').hidden=!S.next;
}
async function selectThread(thread) {
  if(S.sending) throw new Error('消息正在提交，请稍后切换。');
  if(S.thread?.id===thread.id){$('sidebar').classList?.remove('mobile-open');await syncSnapshot();return;}
  if(S.attachedThreadId&&S.capabilities?.switchThreads!==true){if(thread.id!==S.attachedThreadId)throw new Error('此连接仅支持桌面当前任务。');await restoreAttachedThread(true);return;}
  clearConversation(); S.sideOrigin=null;$('side-context').hidden=true;S.thread=thread; $('thread-title').textContent=thread.title; $('sidebar').classList.remove('mobile-open'); renderThreads();rememberSelectedTask();const epoch=S.epoch;await syncSnapshot();if(epoch===S.epoch)await loadModels().catch(()=>{});
}
async function syncSnapshot() {
  if(!S.thread||!S.project)return;
  if(S.syncing)return S.syncing;
  globalThis.CodexRecovery?.cacheCurrent();closeStream();const epoch=S.epoch,id=S.thread.id,project=S.project.id;
  S.historyState=S.items.size?'cached':'loading';S.historyDenied=false;S.historyError='';S.pending.clear();S.turnId=null;renderApprovals();controls();
  const cached=globalThis.CodexRecovery?.restore(epoch,project,id);
  const pending=(async()=>{
    $('stream-state').textContent='读取中…';
    try{
      await cached;if(epoch!==S.epoch)return;const result=await globalThis.CodexHistoryCore.sync(api,`/api/codex/threads/${encodeURIComponent(id)}/sync`,project,[...S.items.values()]);
      if(epoch!==S.epoch)return;
      if(!Array.isArray(result.items)||!Array.isArray(result.pending))throw new Error('服务器返回的任务记录格式不完整。');
      if(result.connection){S.connected=!!result.connection.connected;S.capabilities=result.connection.capabilities||S.capabilities;}
      S.items=new Map(result.items.map(v=>[v.id,v]));S.turns=result.turns||[];S.pending=new Map(result.pending.map(v=>[v.id,v]));
      globalThis.CodexUsage?.metrics(result.metrics);S.cursor=result.cursor;S.tokenUsage=result.tokenUsage||null;S.turnId=result.turnId||null;
      globalThis.CodexQueue?.show(result.queue||[]);if(result.settings)applyThreadSettings(result.settings);S.status=result.status;S.truncated=result.truncated;
      S.historyState='ready';S.historyError='';S.streamLost=false;S.nodes.clear();globalThis.CodexFeatures?.resetTimeline();$('timeline').replaceChildren($('empty'));$('empty').hidden=true;
      renderTimeline();renderApprovals();controls();openStream();globalThis.CodexRecovery?.changed();
      notice(result.historyWarning?.code==='HISTORY_PARTIAL'?result.historyWarning.message:result.truncated?'仅显示最近记录。':'');
    }catch(error){
      if(epoch!==S.epoch)return;
      if(![401,403,404].includes(error.status))await cached;
      if(epoch!==S.epoch)return;globalThis.CodexRecovery?.failed(error);error.handled=true;$('stream-state').textContent='读取失败 · 可重试';throw error;
    }
  })();
  S.syncing=pending;controls();try{await pending;}finally{if(S.syncing===pending){S.syncing=null;controls();}}
}
function openStream() {
  closeStream(); if(!S.thread || !S.project || document.hidden || S.nativeForeground===false) return;
  const epoch=S.epoch;
  const stream=(globalThis.CodexPlatform?.events || (url=>new EventSource(url)))(apiProject('events',{threadId:S.thread.id,cursor:S.cursor})); S.stream=stream;
  stream.onopen=()=>{ if(epoch!==S.epoch||S.stream!==stream)return; $('stream-state').textContent='已连接';S.streamDiagnostic='';
    // An immediately failing SSE must not reset the backoff into a tight retry loop.
    S.streamStableTimer=setTimeout(()=>{if(epoch===S.epoch&&S.stream===stream)S.retry=0;},15000);
  };
  stream.addEventListener('codex',event=>{
    if(epoch!==S.epoch || S.stream!==stream) return;
    try {
      const data=JSON.parse(event.data); S.bytes+=new TextEncoder().encode(event.data).length;
      $('stream-state').title=`本页接收 ${bytes(S.bytes)}`;
      if(data.type==='reset') { syncSnapshot().catch(e=>toast(e.message,true)); return; }
      if(data.type==='connection') { S.connected=!!data.payload.connected; controls(); if(!S.connected) { globalThis.CodexRecovery?.disconnected();closeStream(); $('stream-state').textContent='Codex 连接中断 · 等待恢复';scheduleReconnect(epoch);return; } }
      if(data.type==='limits') { if(S.panel==='quota'&&!document.hidden) loadQuota().catch(()=>{}); }
      if(!CodexState.applyEvent(S,data)) { syncSnapshot().catch(e=>toast(e.message,true)); return; }
      S.cursor=data.cursor;
      if(data.type==='queue')globalThis.CodexQueue?.refresh();
      if(data.type==='approval'||data.type==='approvalResolved') renderApprovals();
      if(data.type==='status') { if(data.payload.metrics)globalThis.CodexUsage?.metrics(data.payload.metrics);if(data.payload.settings)applyThreadSettings(data.payload.settings); if(data.payload.modelsChanged)loadModels().catch(e=>notice(e.message)); controls(); const row=S.threads.find(t=>t.id===S.thread?.id); if(row){row.status=S.status;renderThreads();} }
      if(data.type==='item'||data.type==='delta'||data.type==='status'){scheduleRender();globalThis.CodexRecovery?.changed();}
    } catch { syncSnapshot().catch(e=>toast(e.message,true)); }
  });
  stream.onerror=event=>{
    if(epoch!==S.epoch||S.stream!==stream)return;
    if(S.nativeForeground===false||document.hidden){closeStream();return;}
    S.streamDiagnostic=event?.code||'';
    globalThis.CodexRecovery?.disconnected();closeStream(); $('stream-state').textContent=S.retry>=3?'实时连接受阻 · 正在重新同步':'连接中断 · 正在恢复';
    scheduleReconnect(epoch);
  };
}
function scheduleReconnect(epoch, immediate=false){
  if(!realtimeCanRecover(epoch))return;
  if(S.realtimeRecovery?.epoch===epoch){S.realtimeRecovery.resumeRequested=true;S.realtimeRecovery.immediateRequested ||= immediate;return;}
  clearTimeout(S.timer);
  const delay=immediate?0:Math.min(30000,1000*2**Math.min(S.retry++,5))*(.8+Math.random()*.4);
  S.timer=setTimeout(()=>recoverRealtime(epoch),delay);controls();
}
function realtimeCanRecover(epoch) {
  return epoch===S.epoch && !document.hidden && S.nativeForeground!==false && !!S.user && !!S.thread && !!S.project;
}
async function recoverRealtime(epoch){
  S.timer=null;if(!realtimeCanRecover(epoch))return;
  if(S.realtimeRecovery?.epoch===epoch){S.realtimeRecovery.resumeRequested=true;return;}
  const ticket={epoch,account:S.user.id,resumeRequested:false,immediateRequested:false};S.realtimeRecovery=ticket;controls();
  let retry=false,terminal=false;
  const current=()=>epoch===S.epoch&&ticket.account===S.user?.id;
  try{
    const session=await api('/api/session');if(!current())return;
    if(!session?.user?.id||!session.csrf)throw new Error('登录状态未能同步。');
    if(session.user.id!==ticket.account){terminal=true;loggedOut();return;}
    S.csrf=session.csrf;
    if(!realtimeCanRecover(epoch))return;
    const timeline=$('timeline'),top=timeline.scrollTop,atEnd=timeline.scrollHeight-top-timeline.clientHeight<100;
    await syncSnapshot();
    if(current()&&!atEnd)timeline.scrollTop=top;
  }catch(error){
    if(!current())return;
    if(error.status===401){terminal=true;return;}
    if([400,403,404,413].includes(error.status)||['CODEX_DISCONNECTED','DISABLED','PROJECT_FORBIDDEN','THREAD_FORBIDDEN','HISTORY_TOO_LARGE'].includes(error.code)){
      terminal=true;$('stream-state').textContent=error.code==='HISTORY_TOO_LARGE'?'历史记录超过读取上限':error.code==='CODEX_DISCONNECTED'?'Codex 已由管理员断开':'会话不可访问';
      if(!error.handled)notice(error.message);return;
    }
    retry=true;if(error.status===503)S.connected=false;
    $('stream-state').textContent=error.status===503?'Codex 未连接 · 等待恢复':'网络不可用 · 退避重连中';
  }finally{
    if(S.realtimeRecovery===ticket)S.realtimeRecovery=null;
    if(current()){
      if(retry)scheduleReconnect(epoch);
      else if(!terminal&&ticket.resumeRequested&&!S.stream)scheduleReconnect(epoch,ticket.immediateRequested);
      controls();
    }
  }
}
function resumeRealtime(){if(S.user&&S.thread)scheduleReconnect(S.epoch,true);}

function scheduleRender(){ if(!S.renderTimer) S.renderTimer=setTimeout(()=>{S.renderTimer=null;renderTimeline();},80); }
function renderTimeline(){
  if(globalThis.CodexFeatures)return globalThis.CodexFeatures.renderTimeline();
  const timeline=$('timeline'); const follow=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<120;
  $('empty').hidden=!!S.thread;
  for(const [id,node] of S.nodes) if(!S.items.has(id)){node.root.remove();S.nodes.delete(id);}
  for(const item of S.items.values()){
    let node=S.nodes.get(item.id);
    if(!node){
      const root=el('article',undefined,`message ${item.type}`); let pre=el('pre');
      if(['userMessage','agentMessage','plan'].includes(item.type)) {
        const head=el('div',labelType(item.type),'message-head');
        if(item.type==='agentMessage'){const raw=el('button','原文','text-source');raw.type='button';raw.title='查看未改写的原文与 Unicode 字符，区分缺字字体和原始异常内容';raw.onclick=()=>showOriginalText(item.id);head.append(raw);}
        root.append(head,pre);
      }
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
    if(S.settingsOverrides?.model&&selection&&!S.models.some(m=>(m.model||m.id)===selection)){const stale=el('option',selection+' · 已不在目录');stale.value=selection;stale.disabled=true;$('model').append(stale);}
    if(S.newTask&&selection===''||S.models.some(m=>(m.model||m.id)===selection)||S.settingsOverrides?.model&&selection){$('model').value=selection;loadEfforts(effort);}else loadEfforts();
    if(result.settings)S.threadSettings=result.settings;renderThreadSettings();
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
function markSettings(...keys){{S.settingsOverrides||={};for(const key of keys)S.settingsOverrides[key]=true;renderSettingsSource();}}
function renderSettingsSource(){
  $('settings-source').hidden=!S.user;
  const modified=Object.keys(S.settingsOverrides||{}).length>0;
  const current=S.threadSettings?.model||'待获取';const next=$('model').value||'默认模型';$('settings-source').textContent=S.newTask?'新任务模型：'+next:'当前：'+current+(modified?' · 下一条：'+next+' / '+($('effort').value||'默认强度'):'');
  $('settings-source').title=S.threadSettings?.provider||'';
  $('follow-desktop').hidden=!modified||S.newTask;
}
function renderThreadSettings(){
  const settings=S.threadSettings;if(!settings||S.newTask){renderSettingsSource();return;}
  const changed=S.settingsOverrides||{},effort=changed.effort?$('effort').value:settings.effort||'';
  if(!changed.model&&settings.model){
    if(!Array.from($('model').options).some(o=>o.value===settings.model)){const option=el('option',settings.model+' · 当前任务');option.value=settings.model;$('model').append(option);}
    $('model').value=settings.model;
  }
  loadEfforts(effort);
  if(effort&&!Array.from($('effort').options).some(o=>o.value===effort)){const option=el('option',effort);option.value=effort;$('effort').append(option);}
  $('effort').value=effort;
  if(!changed.mode&&settings.mode)$('mode').value=settings.mode;
  if(!changed.access&&settings.access){
    if(settings.access==='custom'&&!$('access').querySelector('option[value=custom]')){const option=el('option','桌面自定义权限');option.value='custom';option.disabled=true;$('access').append(option);}
    $('access').value=settings.access;S.accessConfirmed=false;
  }
  $('access').title=[settings.sandboxType,settings.approvalPolicy].filter(Boolean).join(' · ');
  renderSettingsSource();
}
async function sendMessage(){
  if(S.sending || !S.project || !S.connected || S.contextError || S.thread&&S.historyState!=='ready' || !permission('send') || !$('prompt').value.trim())return;
  const epoch=S.epoch, immediate=arguments[0]==='steer'; let accepted=false;
  S.sending=true;
  try {
    controls();
    if(S.newTask){await sendNewDesktopTask();return;}
    if(S.taskCreation)throw new Error('请先检查首条消息的创建状态。');
    const content={text:$('prompt').value,projectId:S.project.id,model:$('model').value,effort:$('effort').value,mode:$('mode').value,attachments:[...S.attachments],extensions:S.selected.map(e=>e.id),references:[...S.references],access:$('access').value,confirmFullAccess:S.accessConfirmed,...(S.attachedThreadId?{settingsOverrides:Object.keys(S.settingsOverrides||{})}:{})};
    if(S.attachedThreadId && !await restoreAttachedThread()){if(S.capabilities?.createWithMessage===true&&!S.thread){S.sending=false;await startNewConversation();notice('输入首条消息后创建聊天。');}return;}
    const queued=!immediate&&(S.status==='running'||S.queueCount>0);
    if(immediate){if(!S.turnId||S.status!=='running')throw new Error('当前没有可补充的运行轮次，请正常发送。');content.delivery='steer';content.expectedTurnId=S.turnId;}
    if(queued&&S.goalDraft)throw new Error('请先取消待设置的目标；排队消息不会修改正在运行的任务目标。');
    // Only regular app-server mode may create a task on first send.
    if(!S.thread){
      if(!supports('createThread'))throw new Error('此连接不支持新建任务，请先选择已有任务。');
      S.creationId ||= CodexState.requestId();
      const thread=await api('/api/codex/threads',{projectId:content.projectId,title:content.text.trim().slice(0,60),requestId:S.creationId});
      if(epoch!==S.epoch)return;
      S.thread=thread; S.threads.unshift(thread); S.status=thread.status;S.historyState='ready'; // Authenticated creation receipt, not a cached task.
      $('thread-title').textContent=thread.title; $('empty').hidden=true; renderThreads();
    }
    if(S.goalDraft){await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/goal`,{projectId:S.project.id,objective:S.goalDraft},'PUT');S.goalDraft='';}
    const fingerprint=JSON.stringify({thread:S.thread.id,queued,...content});
    if(S.attempt?.fingerprint!==fingerprint)S.attempt={fingerprint,requestId:CodexState.requestId()};
    await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/${queued?'queue':'messages'}`,{...content,requestId:S.attempt.requestId});
    accepted=true;
    if(epoch===S.epoch){$('prompt').value='';S.attachments=[];S.selected=[];S.references=[];S.attempt=null;S.settingsOverrides={};renderSettingsSource();renderAttachments();notice();await syncSnapshot();rememberSelectedTask();}
  }catch(error){
    if(epoch===S.epoch)notice(accepted?'消息已发送，输出读取失败。点击任务可重新连接。':'发送失败：'+error.message);
    throw error;
  }finally{S.sending=false;controls();}
}
function renderAttachments(){
  const container=$('attachments'); container.replaceChildren();
  const chip=(label,remove)=>{const button=el('button',label+' ×','context-chip');button.type='button';button.onclick=()=>{if(S.sending)return;remove();renderAttachments();};container.append(button);};
  for(const file of S.attachments){chip(file.split('/').pop(),()=>S.attachments=S.attachments.filter(v=>v!==file));if(globalThis.CodexPlatform?.native&&/\.(png|jpe?g|webp|gif|avif)$/i.test(file)){const image=el('img');image.className='mobile-attachment-preview';image.alt='附件预览';image.loading='lazy';container.lastElementChild.prepend(image);CodexPlatform.image(image,apiProject('files/image',{path:file}));}}
  for(const entry of S.selected)chip((entry.kind==='plugin'?'◇ ':'$ ')+entry.label,()=>S.selected=S.selected.filter(v=>v.id!==entry.id));
  for(const ref of S.references)chip('▸ '+ref,()=>S.references=S.references.filter(v=>v!==ref));
  if(S.goalDraft)chip('目标：'+S.goalDraft.slice(0,40),()=>S.goalDraft='');
}
async function uploadFile(selectedFiles){
  if(globalThis.CodexAccountFiles){try{return await CodexAccountFiles.upload(Array.from(Array.isArray(selectedFiles)?selectedFiles:$('upload').files),{attachToComposer:true});}finally{$('upload').value='';}}
  const files=Array.from(Array.isArray(selectedFiles)?selectedFiles:$('upload').files); if(!files.length)return;
  const epoch=S.epoch,projectId=S.project?.id;
  try{
    if(S.attachments.length+files.length>5)throw new Error('最多 5 个附件。');
    for(const file of files){
      if(file.size>4*1024*1024)throw new Error(`${file.name} 超过 4 MiB。`);
      if(epoch!==S.epoch || !projectId)throw new Error('项目已切换，已取消上传。');
      const result=await globalThis.CodexFeatures.upload(file,projectId,epoch);
      if(epoch!==S.epoch)return;
      S.attachments.push(result.path);renderAttachments();
    }
  }finally{$('upload').value='';}
}
let quotaLoading=null;
async function loadQuota(){return globalThis.CodexUsage?.load();}
function renderQuota(limits){
  const container=$('quota-detail-content');container.replaceChildren();
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
  if(!S.user?.admin)return;
  const credits=limits.resetCredits;
  if(!credits){container.append(el('p','未提供重置卡数据','footnote'));return;}
  const rows=(credits.availableCount>0?credits.details:[]).filter(c=>(!c.status||c.status==='available')&&(c.expiresAt==null||c.expiresAt*1000>Date.now()));
  const cards=rows.length?rows:(credits.availableCount>0?[{id:undefined,expiresAt:undefined}]:[]);
  container.append(el('h3',`重置卡 · ${credits.availableCount}`,'quota-card-heading'));
  for(const credit of cards){
    const card=el('div',undefined,'credit');
    card.append(el('p',credit.expiresAt===null?'不过期':credit.expiresAt?shortDate(credit.expiresAt)+' 到期':'未提供到期日'));
    if(!S.user?.admin){card.append(el('p','仅管理员可以使用重置卡','footnote'));container.append(card);continue;}
    const button=el('button','使用重置卡','small');button.disabled=!supports('resetQuota');
    if(button.disabled)card.append(el('p','当前 Codex 连接未提供重置卡操作接口','footnote'));
    let requestId=null;
    button.onclick=action(async()=>{
      const account=S.user?.id;
      if(!S.user?.admin||!supports('resetQuota'))throw new Error('仅管理员可以使用重置卡。');
      if(!await confirmAction('使用重置卡','确认消耗一张重置卡？此操作不可撤销。'))return;
      if(account!==S.user?.id||!S.user?.admin||!supports('resetQuota'))throw new Error('管理员权限或账户已改变，请重新打开额度。');
      requestId ||= CodexState.requestId();
      const result=await api('/api/codex/account/limits/reset',{requestId,...(credit.id?{creditId:credit.id}:{})});
      if(account!==S.user?.id||!S.user?.admin)return;
      renderQuota(result.rateLimits);toast(result.outcome==='reset'?'已使用重置卡并更新额度':'操作结果：'+result.outcome+'；请确认额度后再操作。');
      globalThis.CodexUsage?.load(true).catch(()=>{});
    });
    card.append(button);container.append(card);
  }
}
function shortDate(value){return new Date(value<1e12?value*1000:value).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});}
async function loadFiles(){return globalThis.CodexFeatures.loadFiles();}
async function loadDiff(){if(!permission('files'))throw new Error('没有文件权限。');const epoch=S.epoch;const result=await api(apiProject('diff'));if(epoch===S.epoch)$('diff-content').textContent=(result.text||'没有未提交的差异。')+(result.truncated?'\n[已截断到 256 KiB]':''); }
async function switchPanel(panel){if(panel==='files'&&globalThis.CodexAccountFiles)return CodexAccountFiles.open();if(panel==='files'&&globalThis.CodexFiles?.openProjectBrowser){await CodexFiles.openProjectBrowser(S.project?.id);return;}S.panel=panel;for(const name of ['quota','files','diff','browser'])$('panel-'+name).hidden=name!==panel;for(const b of document.querySelectorAll('[data-panel]')){const active=b.dataset.panel===panel;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));}if(panel==='files')await loadFiles();if(panel==='quota')await loadQuota();if(panel==='diff')await loadDiff();}
let settingsSequence=0;
async function openSettings(){if(!S.user?.admin)return;const account=S.user.id,request=++settingsSequence;$('settings-dialog').showModal();const config=await api('/api/codex/admin/config');if(request!==settingsSequence||account!==S.user?.id||!S.user?.admin||!$('settings-dialog').open)return;$('transport').value=config.transport.type;$('endpoint').value=config.transport.endpoint;$('token-env').value=config.transport.bearerTokenEnv||'';$('concurrency').value=5;$('enabled').checked=config.enabled;$('projects-json').value=JSON.stringify(config.projects,null,2);$('candidates').replaceChildren();await loadUsers();}
let usersSequence=0;
async function loadUsers(){if(!S.user?.admin)return;const account=S.user.id,sequence=++usersSequence;const users=await api('/api/admin/users');if(sequence!==usersSequence||account!==S.user?.id||!S.user?.admin)return;$('users-list').replaceChildren();for(const user of users){const row=el('div',undefined,'user-record'),info=el('div');info.append(el('strong',`${user.username}${user.admin?' · 管理员':''}`),el('code',user.id));const edit=el('button','编辑','small');edit.type='button';edit.onclick=()=>{$('edit-user-id').value=user.id;$('new-username').value=user.username;$('new-admin').checked=user.admin;$('new-password').value='';$('new-username').focus();};row.append(info,edit);$('users-list').append(row);} await globalThis.CodexUsage?.loadAdminMembers(); await globalThis.CodexFeatures?.loadRegistrations(); }
let authMode='login';
function setAuthMode(mode){
  authMode=mode;const registering=mode==='register';$('login-title').textContent=registering?'申请普通账户':'登录';$('login-submit').textContent=registering?'提交注册申请':'登录';$('register-note').hidden=!registering;
  $('password').autocomplete=registering?'new-password':'current-password';$('password').minLength=registering?12:0;$('password').value='';$('password-confirm').value='';$('password-confirm-label').hidden=!registering;$('password-confirm').required=registering;
  $('login-error').textContent='';for(const mode of ['login','register']){$('auth-'+mode).classList.toggle('active',authMode===mode);$('auth-'+mode).setAttribute('aria-selected',String(authMode===mode));}
}
$('auth-login').onclick=()=>setAuthMode('login');$('auth-register').onclick=()=>setAuthMode('register');
$('login-form').onsubmit=async event=>{
  event.preventDefault();const button=$('login-submit'),mode=authMode;button.disabled=true;$('auth-login').disabled=true;$('auth-register').disabled=true;$('login-error').textContent='';$('login-error').hidden=false;
  try{if(mode==='register'&&$('password').value!==$('password-confirm').value)throw new Error('两次输入的密码不一致。');const result=await api('/api/'+mode,{username:$('username').value.trim(),password:$('password').value});$('password-confirm').value='';if(mode==='register'){setAuthMode('login');$('login-error').hidden=false;$('login-error').textContent=result.message||'申请已提交，管理员批准后才能登录。';}else await signedIn(result);}
  catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;$('auth-login').disabled=false;$('auth-register').disabled=false;}
};
$('logout').onclick=action(async()=>{await globalThis.CodexRecovery?.cacheCurrent();await api('/api/logout',{});loggedOut();});
$('project-select').onchange=action(()=>chooseProject($('project-select').value));
$('thread-filter').oninput=renderThreads;$('refresh-threads').onclick=action(()=>loadThreads());$('more-threads').onclick=action(()=>loadThreads(true));
$('new-thread').onclick=action(startNewConversation);
$('check-creation').onclick=action(()=>checkCreation());
$('cancel-new-thread').onclick=()=>$('new-thread-dialog').close();
$('new-thread-form').onsubmit=action(async()=>{if(!supports('createThread'))throw new Error('此连接不支持新建任务。');const title=$('new-thread-title').value;const epoch=S.epoch;const submit=document.querySelector('#new-thread-form button[type=submit]');if(submit.disabled)return;submit.disabled=true;try{const thread=await api('/api/codex/threads',{projectId:S.project.id,title});$('new-thread-dialog').close();if(epoch===S.epoch){S.threads.unshift(thread);await selectThread(thread);}}finally{submit.disabled=false;}});
$('composer').onsubmit=action(sendMessage);$('prompt').onkeydown=promptKey;
$('send-now').onclick=action(()=>sendMessage('steer'));
$('context-window').onclick=action(showStatus);
$('prompt').oninput=()=>{S.menuIndex=0;if(/^\/[^\n]*$/.test($('prompt').value)){openMenu('slash').catch(e=>toast(e.message,true));}else if(S.menuMode==='slash')closeMenu();};
$('model').onchange=()=>{loadEfforts();if(S.newTask&&!$('model').value){delete S.settingsOverrides.model;delete S.settingsOverrides.effort;renderSettingsSource();}else markSettings('model','effort');};$('effort').onchange=()=>markSettings('effort');$('mode').onchange=()=>markSettings('mode');$('follow-desktop').onclick=()=>{if(S.sending)return;S.settingsOverrides={};renderThreadSettings();};$('stop').onclick=action(async()=>{await api(`/api/codex/threads/${encodeURIComponent(S.thread.id)}/interrupt`,{projectId:S.project.id});});
$('attach').onclick=action(()=>S.menuOpen?closeMenu():openMenu('plus'));$('upload').onchange=action(uploadFile);
$('connect').onclick=action(()=>globalThis.CodexRecovery.retry());
$('history-retry').onclick=action(()=>syncSnapshot());
$('settings').onclick=action(openSettings);$('close-settings').onclick=()=>$('settings-dialog').close();
$('config-form').onsubmit=action(async()=>{const transport={type:$('transport').value,endpoint:$('endpoint').value.trim()};if($('token-env').value.trim())transport.bearerTokenEnv=$('token-env').value.trim();await api('/api/codex/admin/config',{enabled:$('enabled').checked,transport,maxConcurrentTurns:Number($('concurrency').value),projects:JSON.parse($('projects-json').value)},'PUT');clearConversation();await refreshContext();toast('配置已保存。请手动连接 Codex。');$('settings-dialog').close();});
$('disconnect').onclick=action(async()=>{await api('/api/codex/admin/disconnect',{});S.connected=false;closeStream();globalThis.CodexRecovery?.disconnected();await refreshContext({restoreAttached:false});});
$('discover').onclick=action(async()=>{const candidates=await api('/api/codex/admin/discover');$('candidates').replaceChildren();if(!candidates.length)$('candidates').append(el('p','没有找到已有接口。请确认 Codex 以同一 Linux 用户运行，并确实暴露可附加端点。','footnote'));for(const c of candidates){const card=el('div',undefined,'candidate');card.append(el('strong',`${c.verified?'已验证':'未验证'} · ${c.type}`),el('p',c.endpoint));if(c.error)card.append(el('p',c.error));const use=el('button','使用此接口','small');use.type='button';use.onclick=()=>{$('transport').value=c.type;$('endpoint').value=c.endpoint;$('enabled').checked=true;toast('已填入，保存配置后再连接。');};card.append(use);$('candidates').append(card);}});
$('user-form').onsubmit=action(async()=>{const id=$('edit-user-id').value;await api('/api/admin/users',{...(id?{id}:{}),username:$('new-username').value,password:$('new-password').value,admin:$('new-admin').checked},'PUT');$('user-form').reset();$('edit-user-id').value='';if(id===S.user?.id){loggedOut();toast('当前账号已更新，请重新登录。');}else{await loadUsers();toast('账号已保存，旧会话已失效。');}});
$('cancel-edit-user').onclick=()=>{$('user-form').reset();$('edit-user-id').value='';};
for(const button of document.querySelectorAll('[data-panel]'))button.onclick=action(()=>switchPanel(button.dataset.panel));
$('refresh-quota').onclick=action(()=>globalThis.CodexUsage?.load(true));$('refresh-files').onclick=action(loadFiles);$('refresh-diff').onclick=action(loadDiff);$('files-up').onclick=action(async()=>{S.filePath=S.filePath.includes('/')?S.filePath.slice(0,S.filePath.lastIndexOf('/')):'.';await loadFiles();});
$('menu-toggle').onclick=()=>$('sidebar').classList.toggle('mobile-open');$('inspect-toggle').onclick=()=>$('inspector').classList.toggle('inspect-open');$('close-inspector').onclick=()=>$('inspector').classList.remove('inspect-open');
document.addEventListener('visibilitychange',()=>{clearTimeout(S.hiddenTimer);if(document.hidden){globalThis.CodexRecovery?.cacheCurrent();}if(document.hidden)S.hiddenTimer=setTimeout(()=>{closeStream();$('stream-state').textContent='已暂停';},15000);else if(!S.stream&&S.thread)resumeRealtime();});
window.addEventListener('online',()=>resumeRealtime());
window.addEventListener('pagehide',()=>{globalThis.CodexRecovery?.cacheCurrent();closeStream();});
window.addEventListener('focus',()=>{if(S.connected&&S.attachedThreadId){loadModels().catch(e=>notice(e.message));refreshProjectChoices().catch(()=>{});}});
if(!globalThis.CodexPlatform?.native)api('/api/session').then(signedIn).catch(error=>{if(error.status!==401)toast(error.message,true);});

const commands=[
  {id:'upload',label:'上传文件',description:'从本机添加附件',command:'/upload',files:true},
  {id:'references',label:'项目文件和文件夹',description:'引用当前项目中的路径',command:'/files',files:true},
  {id:'review',label:'代码审查',description:'审查更改或比较分支',command:'/review'},
  {id:'side',label:'侧边',description:'临时侧边聊天',command:'/side'},
  {id:'fork',label:'创建聊天分支',description:'保留当前上下文',command:'/fork'},
  {id:'compact',label:'压缩',description:'压缩聊天上下文',command:'/compact'},
  {id:'feedback',label:'反馈',description:'发送聊天反馈',command:'/feedback'},
  {id:'archive',label:'归档',description:'归档当前聊天',command:'/archive'},
  {id:'new',label:'新聊天',description:'开始空白聊天',command:'/new'},
  {id:'pin',label:'置顶聊天',description:'保留在列表顶部',command:'/pin'},
  {id:'rename',label:'重命名',description:'修改聊天标题',command:'/rename'},
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
  if(!supports('extensions')){S.catalogProject=S.project.id;return S.catalog={entries:[],skillsAvailable:false,pluginsAvailable:false,issues:['技能接口未连接']};}
  const projectId=S.project.id,account=S.user?.id;
  if(!refresh && S.catalog && S.catalogProject===projectId)return S.catalog;
  if(!refresh && S.catalogRequest?.projectId===projectId)return S.catalogRequest.promise;
  const promise=api(apiProject('extensions',refresh?{refresh:'1'}:{}));S.catalogRequest={projectId,promise};
  try{const result=await promise;if(S.project?.id!==projectId||S.user?.id!==account||S.catalogRequest?.promise!==promise)return null;S.catalog=result;S.catalogProject=projectId;return result;}
  finally{if(S.catalogRequest?.promise===promise)S.catalogRequest=null;}
}
async function openMenu(mode='plus',refresh=false){
  if(!S.project || !S.connected)return;
  if((mode==='skills'||mode==='plugins')&&!supports('extensions')){toast('技能接口尚未连接，请刷新连接。');return;}
  const menuRequest=(S.menuRequest||0)+1;S.menuRequest=menuRequest;
  const changing=!S.menuOpen || S.menuMode!==mode;
  S.menuMode=mode;S.menuOpen=true;
  if(changing){S.menuIndex=0;$('menu-query').value='';}
  $('composer-menu').hidden=false;$('attach').setAttribute('aria-expanded','true');$('prompt').setAttribute('aria-expanded',String(mode==='slash'));
  $('menu-title').textContent=({plus:'添加',slash:'命令与技能',skills:'技能',plugins:'插件',commands:'任务操作'})[mode];
  $('menu-query').hidden=mode==='slash';
  globalThis.CodexMobileMenus?.opened(mode,changing);
  S.menuError='';renderMenu();
  if(mode!=='slash' && changing)$('menu-query').focus();
  if(mode!=='commands'){const projectId=S.project.id,account=S.user?.id;try{await loadCatalog(refresh);}catch(error){if(S.menuOpen&&S.menuRequest===menuRequest&&S.project?.id===projectId&&S.user?.id===account)S.menuError=error.message||'扩展加载失败';}}
  if(S.menuOpen&&S.menuRequest===menuRequest)renderMenu();
}
function closeMenu(){S.menuOpen=false;$('composer-menu').hidden=true;$('attach').setAttribute('aria-expanded','false');$('prompt').setAttribute('aria-expanded','false');$('prompt').removeAttribute('aria-activedescendant');globalThis.CodexMobileMenus?.closed();}
function renderMenu(){
  if(!S.menuOpen)return;
  const query=(S.menuMode==='slash'?$('prompt').value.replace(/^\//,''):$('menu-query').value).trim().toLowerCase();
  const entries=((supports('extensions')&&S.catalogProject===S.project?.id?S.catalog?.entries:[])||[]).map(entry=>S.newTask&&S.capabilities?.firstMessageExtensions!==true?{...entry,enabled:false,description:'创建任务后可用'}:entry);
  const common=S.menuMode==='plus'?['upload','references','goal','plan']:['mcp','review','side','fork','compact','feedback','archive','new','status','goal','pin','plan','rename','permissions'];
  // Slash always lists the complete command set. Unsupported actions stay visible with a reason.
  const basic=['plus','slash','commands'].includes(S.menuMode)?commands.filter(c=>['slash','commands'].includes(S.menuMode)||(query||common.includes(c.id))&&commandAvailable(c)).map(c=>{const reason=commandDisabledReason(c);return {...c,kind:'command',enabled:!reason,description:reason?c.description+' · '+reason:c.description};}):[];
  const filtered=(S.menuMode==='commands'?[]:entries).filter(e=>S.menuMode!=='skills'&&S.menuMode!=='plugins'||e.kind===(S.menuMode==='skills'?'skill':'plugin'));
  const ordered=S.menuMode==='plus'?[...filtered.filter(e=>e.kind==='plugin'),...filtered.filter(e=>e.kind==='skill')]:filtered;
  const all=[...basic,...ordered];
  S.menuItems=all.filter(e=>`${e.label} ${e.name||''} ${e.description||''} ${e.command||''}`.toLowerCase().includes(query)).slice(0,100);
  if(S.menuIndex>=S.menuItems.length)S.menuIndex=0;
  const container=$('menu-list');container.replaceChildren();let lastGroup='';
  for(const [index,item] of S.menuItems.entries()){
    const group=({command:'功能',skill:'技能',plugin:'插件'})[item.kind];
    if(group!==lastGroup){container.append(el('div',group,'menu-group'));lastGroup=group;}
    const row=el('button',undefined,'menu-option');row.type='button';row.id=`menu-item-${index}`;row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===S.menuIndex));
    row.disabled=!item.enabled;row.dataset.menuId=item.id;row.dataset.menuKind=item.kind;
    const label=el('div',undefined,'menu-option-main');label.append(el('strong',item.label),el('span',item.description||'', 'menu-description'));
    const meta=item.kind==='command'?item.command:item.enabled?(item.kind==='plugin'?'插件':({user:'个人',repo:'项目',system:'系统',admin:'管理'})[item.scope]||'技能'):'已禁用';
    row.append(label,el('span',item.kind!=='command'&&S.selected.some(e=>e.id===item.id)?'已选择':meta,'menu-meta'));row.onclick=action(()=>chooseMenu(index));container.append(row);
  }
  $('menu-status').textContent=S.menuError||(S.menuMode!=='commands'&&!S.catalog?'读取技能与插件…':(S.menuMode==='commands'?'':S.catalog?.issues?.join('；'))||(!S.menuItems.length?'没有匹配项':S.menuItems.length===100?'输入名称缩小范围':''));
  const search=S.menuMode==='slash'?$('prompt'):$('menu-query');if(S.menuItems.length)search.setAttribute('aria-activedescendant',`menu-item-${S.menuIndex}`);else search.removeAttribute('aria-activedescendant');
}
async function chooseMenu(index){
  const item=S.menuItems[index];if(!item?.enabled)return;
  if(item.kind==='command'&&commandDisabledReason(item))return;
  if(item.kind!=='command'&&(!supports('extensions')||S.sending||S.newTask&&S.capabilities?.firstMessageExtensions!==true))return;
  const slash=S.menuMode==='slash';if(slash)$('prompt').value='';
  closeMenu();
  if(item.kind!=='command'){
    if(!S.selected.some(e=>e.id===item.id)&&S.selected.length>=12)throw new Error('最多选择 12 个技能或插件。');
    if(!S.selected.some(e=>e.id===item.id))S.selected.push(item);
    renderAttachments();$('prompt').focus();return;
  }
  switch(item.id){
    case 'review':case 'side':case 'fork':case 'compact':case 'feedback':case 'archive':case 'pin':case 'rename':await openTaskAction(item.id);break;
    case 'upload':$('upload').click();break;
    case 'references':await openReferences();break;
    case 'new':await startNewConversation();break;
    case 'plan':$('mode').value='plan';markSettings('mode');$('prompt').focus();break;
    case 'code':$('mode').value='code';markSettings('mode');$('prompt').focus();break;
    case 'model':if(globalThis.CodexMobileSelect){CodexMobileSelect.open('model',{trigger:document.querySelector('.mobile-model-pill')});break;}$('model').focus();if(typeof $('model').showPicker==='function')try{$('model').showPicker();}catch{}break;
    case 'permissions':if(globalThis.CodexMobileSelect){CodexMobileSelect.open('access',{trigger:document.querySelector('.mobile-options-button')});break;}$('access').focus();if(typeof $('access').showPicker==='function')try{$('access').showPicker();}catch{}break;
    case 'skills':await openMenu('skills');break;
    case 'plugins':await openMenu('plugins');break;
    case 'mcp':await showMcp();break;
    case 'status':await showStatus();break;
    case 'goal':await openGoal();break;
    case 'diff':$('inspector').classList.add('inspect-open');await switchPanel('diff');break;
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
  const epoch=S.epoch,account=S.user?.id;
  markSettings('access');S.accessConfirmed=false;
  if($('access').value==='full'){
    const confirmed=!!S.user&&await confirmAction('完全访问','允许 Codex 访问项目外文件和网络，并跳过操作审批。仅对可信任务启用。');
    if(epoch!==S.epoch||account!==S.user?.id||$('access').value!=='full')return;
    if(confirmed)S.accessConfirmed=true;else $('access').value='default';
  }
}
function showInfo(title){$('info-title').textContent=title;$('info-content').replaceChildren();$('info-dialog').showModal();return $('info-content');}
async function showMcp(){const root=showInfo('MCP');root.append(el('p','读取中…','muted'));try{const result=await api(apiProject('mcp',S.thread?{threadId:S.thread.id}:{}));root.replaceChildren();if(!result.data.length)root.append(el('p','未配置 MCP 服务器','muted'));for(const server of result.data){const card=el('section',undefined,'info-row');card.append(el('strong',server.name),el('p',`${server.runtimeStatus||'状态未知'} · ${server.authStatus||'认证状态未知'} · ${server.tools.length} 个工具`,'footnote'));if(server.tools.length){const details=el('details');details.append(el('summary','工具'),el('pre',server.tools.join('\n')));card.append(details);}root.append(card);}if(result.more)root.append(el('p','仅显示前 100 项','footnote'));}catch(error){root.textContent=error.message;}}
function showOriginalText(id){
  const item=S.items.get(id);if(!item)return;const text=item.text,info=CodexState.textDiagnostics(text),root=showInfo('原文与字符检查');
  root.append(el('p',info.replacement||info.unpaired?'原始消息中已有 '+info.replacement+' 个替换符、'+info.unpaired+' 个不完整 Unicode 字符；不能靠换字体恢复，请核对上游原始输出。':'原文没有检测到替换符或不完整 Unicode。方框可能是字体缺字；其他语言字符也可能是上游本来输出的内容。','footnote'),el('pre',text,'original-text'));
  const details=el('details');details.append(el('summary','Unicode 字符（前 96 个非 ASCII 字符）'),el('pre',info.samples.join('\n')));root.append(details);
}
async function showStatus(){
  if(S.thread)await syncSnapshot();const root=showInfo('状态');
  const rows=[['类型',S.project?.kind==='projectless'?'无项目对话':'项目对话'],['项目',S.project?.name||'未选择'],['任务 ID',S.thread?.id||'尚未创建'],['状态',stateName(S.status)],['模型',$('model').value],['权限',$('access').selectedOptions[0].textContent]];
  const usage=S.tokenUsage;if(usage){const context=CodexState.contextWindow(usage);rows.push(['累计 tokens',usage.total===null?'未提供':String(usage.total)],['当前上下文 tokens',context.used===null?'未提供':String(context.used)]);if(context.capacity)rows.push(['上下文窗口',String(context.capacity)]);if(context.percent!==null)rows.push(['上下文占用',context.percent.toFixed(1)+'%'],['上下文剩余 tokens',String(context.remaining)]);}else rows.push(['上下文用量','尚未收到 Codex 用量数据']);
  for(const [label,value] of rows){const row=el('div',undefined,'status-row');row.append(el('span',label,'muted'),el('code',value));root.append(row);}
  try{const limits=await api('/api/codex/account/limits');for(const w of limits.windows||[]){const row=el('div',undefined,'status-row');row.append(el('span',w.windowDurationMins===10080?'一周窗口':w.name||'额度窗口','muted'),el('code',w.usedPercent+'% · '+date(w.resetsAt)+' 重置'));root.append(row);}}catch{root.append(el('p','Codex 未提供当前额度数据','footnote'));}
}
let goalTarget=null;
async function openGoal(){
  const target={epoch:S.epoch,account:S.user?.id,projectId:S.project?.id,threadId:S.thread?.id};goalTarget=target;
  const initial=S.goalDraft||'';$('goal-objective').value=initial;
  $('goal-dialog').showModal();
  if(target.threadId){try{const result=await api(apiProject(`threads/${encodeURIComponent(target.threadId)}/goal`));if(goalTarget===target&&S.epoch===target.epoch&&S.user?.id===target.account&&$('goal-dialog').open&&$('goal-objective').value===initial)$('goal-objective').value=result.goal?.objective||'';}catch(error){if(goalTarget===target&&S.epoch===target.epoch&&$('goal-dialog').open)toast(error.message,true);}}
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
$('sidebar-plugins').onclick=action(()=>globalThis.CodexMobileMenus?CodexMobileMenus.open('skills',$('sidebar-plugins')):openMenu('plus'));
$('access').onchange=action(selectAccess);$('cancel-confirm').onclick=()=>finishConfirm(false);
$('confirm-form').onsubmit=event=>{event.preventDefault();finishConfirm(true);};$('confirm-dialog').addEventListener('cancel',()=>finishConfirm(false));
$('confirm-dialog').addEventListener('close',()=>{if(confirmResolve)finishConfirm(false);});
$('close-info').onclick=()=>$('info-dialog').close();$('close-goal').onclick=()=>$('goal-dialog').close();
$('goal-form').onsubmit=action(async()=>{const target=goalTarget,objective=$('goal-objective').value.trim();const current=()=>target&&target===goalTarget&&target.epoch===S.epoch&&target.account===S.user?.id;if(!current())throw new Error('任务已切换，请重新打开目标设置。');if(!await confirmAction('设置持续目标','Codex 将继续追求该目标，可能消耗模型额度。'))return;if(!current())throw new Error('任务已切换，本次设置已取消。');if(target.threadId){await api(`/api/codex/threads/${encodeURIComponent(target.threadId)}/goal`,{projectId:target.projectId,objective},'PUT');}else S.goalDraft=objective;if(!current())return;renderAttachments();$('goal-dialog').close();$('prompt').focus();});
$('close-references').onclick=()=>$('reference-dialog').close();$('reference-up').onclick=action(async()=>{S.referencePath=S.referencePath.includes('/')?S.referencePath.slice(0,S.referencePath.lastIndexOf('/')):'.';await renderReferences();});$('reference-current').onclick=action(()=>addReference(S.referencePath));
document.addEventListener('pointerdown',event=>{if(S.menuOpen&&!$('composer-menu').contains(event.target)&&event.target!==$('prompt')&&!$('attach').contains(event.target))closeMenu();});
// User-initiated project and chat operations. No action runs just by opening its menu.
let projectAttempt=null,projectCreating=false,projectDirectory=null,projectDirectoryRequest=0;
async function openProjectForm(){
  if(projectCreating)return;
  const epoch=S.epoch,request=++projectDirectoryRequest;
  projectAttempt=null;projectDirectory=null;$('project-error').hidden=true;$('project-error').textContent='';$('project-name').value='';
  $('project-submit').disabled=true;$('project-base-prefix').textContent='读取目录中…';$('project-dialog').showModal();$('project-name').focus();
  try {
    const directory=await api('/api/codex/projects/default-directory');
    if(request!==projectDirectoryRequest||epoch!==S.epoch||!$('project-dialog').open)return;
    if(typeof directory.root!=='string'||!directory.root||!['/','\\'].includes(directory.separator))throw new Error('服务器未返回可用的默认目录。');
    projectDirectory=directory;$('project-base-prefix').textContent=directory.root+directory.separator;$('project-base-prefix').title=directory.root;$('project-submit').disabled=false;
  }catch(error){
    if(request===projectDirectoryRequest&&epoch===S.epoch&&$('project-dialog').open){$('project-base-prefix').textContent='目录不可用';$('project-error').textContent=error.message;$('project-error').hidden=false;}
  }
}
$('new-project').onclick=action(openProjectForm);
$('close-project').onclick=()=>{projectDirectoryRequest++;$('project-dialog').close();};
async function createProjectFromForm(){
  if(projectCreating)return;
  const folderName=$('project-name').value.trim();
  if(!projectDirectory){$('project-error').textContent='默认目录尚未就绪，请关闭后重新打开。';$('project-error').hidden=false;return;}
  if(!folderName||folderName==='.'||folderName==='..'||folderName.includes('/')||folderName.includes('\\')){$('project-error').textContent='只需填写文件夹名称，不要填写完整路径。';$('project-error').hidden=false;return;}
  const epoch=S.epoch,body={folderName,baseRoot:projectDirectory.root,confirmDirectory:true};
  const fields=Array.from($('project-form').elements),disabled=fields.map(field=>field.disabled);
  projectCreating=true;fields.forEach(field=>field.disabled=true);$('project-submit').textContent='创建中…';$('project-error').hidden=true;$('project-error').textContent='';
  try {
    // Submitting this form confirms the directory; no nested confirmation dialog.
    const fingerprint=JSON.stringify(body);
    if(projectAttempt?.fingerprint!==fingerprint)projectAttempt={fingerprint,requestId:CodexState.requestId()};
    const result=await api('/api/codex/projects',{...body,requestId:projectAttempt.requestId});
    if(epoch!==S.epoch)return;
    $('project-dialog').close();projectAttempt=null;
    await refreshContext();await chooseProject(result.id);await startNewConversation();
  }catch(error){
    if(epoch===S.epoch){
      $('project-error').textContent=error.message;$('project-error').hidden=false;
      if(!$('project-dialog').open)notice('项目操作失败：'+error.message);
    }
  }finally{
    projectCreating=false;fields.forEach((field,index)=>field.disabled=disabled[index]);$('project-submit').textContent='创建项目';
  }
}
$('project-form').onsubmit=action(createProjectFromForm);
$('projectless').onclick=action(async()=>{
  if(S.sending)return;if($('prompt').value.trim()&&!await confirmAction('切换到无项目对话','当前未发送的草稿将清空。'))return;
  await chooseProject('projectless');await startNewConversation();
});
async function openTaskAction(kind){
  if(!S.thread||S.sending)return;
  const labels={review:'代码审查',side:'侧边聊天',fork:'创建聊天分支',compact:'压缩上下文',feedback:'发送反馈',archive:'归档聊天',pin:S.thread.pinned?'取消置顶':'置顶聊天',rename:'重命名'};
  const notes={review:'启动一次真实 Codex 审查，会消耗模型额度。',side:'保留当前上下文，打开临时聊天；不会自动发送消息。',fork:'在当前目录创建分支；不会自动发送消息。',compact:'由 Codex 压缩当前聊天上下文，可能消耗模型额度。',feedback:'将反馈文字和聊天 ID 发送给 Codex 反馈服务。不附加日志。',archive:'从活动列表移出，可在 Codex 桌面恢复。',pin:'同步到 Codex 的置顶列表。',rename:''};
  S.actionAttempt={kind,threadId:S.thread.id,projectId:S.project.id,requestId:CodexState.requestId(),fingerprint:null};
  $('task-action-title').textContent=globalThis.CodexMobileVisuals?labels[kind].replaceAll('聊天','任务'):labels[kind];$('task-action-note').textContent=globalThis.CodexMobileVisuals?notes[kind].replaceAll('聊天','任务'):notes[kind];
  $('task-action-text-label').hidden=!['rename','feedback'].includes(kind);$('task-action-text').value=kind==='rename'?S.thread.title:'';
  $('task-action-text').maxLength=kind==='rename'?120:4000;$('task-action-text').required=['rename','feedback'].includes(kind);
  $('review-target-label').hidden=kind!=='review';$('review-target').value='uncommittedChanges';$('review-branch-label').hidden=true;$('review-branch').value='';
  $('task-action-submit').textContent=kind==='review'?'开始审查':kind==='feedback'?'发送反馈':'确认';$('task-action-dialog').showModal();
}
$('close-task-action').onclick=()=>$('task-action-dialog').close();
$('review-target').onchange=()=>{$('review-branch-label').hidden=$('review-target').value!=='baseBranch';};
$('task-action-form').onsubmit=action(async()=>{
  const attempt=S.actionAttempt;if(!attempt||attempt.threadId!==S.thread?.id||attempt.projectId!==S.project?.id)throw new Error('当前聊天已改变，请重新选择操作。');
  const kind=attempt.kind,body={projectId:attempt.projectId,confirmed:true};
  if(kind==='rename')body.name=$('task-action-text').value.trim();
  if(kind==='feedback')body.reason=$('task-action-text').value.trim();
  if(kind==='pin')body.pinned=!S.thread.pinned;
  if(kind==='review'){body.target=$('review-target').value;body.branch=$('review-branch').value.trim();}
  if(kind==='fork')body.environment='same-directory';
  const fingerprint=JSON.stringify(body);if(attempt.fingerprint&&attempt.fingerprint!==fingerprint)throw new Error('请求已提交过。请检查桌面结果后重新打开操作。');attempt.fingerprint=fingerprint;
  const origin=kind==='side'?{thread:{...S.thread},projectId:S.project.id,items:[...S.items.values()].filter(i=>['userMessage','agentMessage'].includes(i.type)).slice(-12)}:null;
  const result=await api(`/api/codex/threads/${encodeURIComponent(attempt.threadId)}/actions/${kind}`,{...body,requestId:attempt.requestId});
  $('task-action-dialog').close();S.actionAttempt=null;
  if(result.thread){S.threads.unshift(result.thread);await selectThread(result.thread);if(origin){S.sideOrigin=origin;$('side-context').hidden=false;$('side-history').replaceChildren();for(const item of origin.items){const node=el('article',undefined,'side-item');node.append(el('strong',item.type==='userMessage'?'你':'Codex'),el('p',(item.text||'').slice(-2000)));$('side-history').append(node);}controls();$('thread-title').textContent='侧边 · '+result.thread.title;}return;}
  if(kind==='archive'){clearConversation();await loadThreads();notice('已归档');}
  else if(kind==='rename'){S.thread.title=body.name;$('thread-title').textContent=body.name;await loadThreads();}
  else if(kind==='pin'){S.thread.pinned=result.pinned;const item=S.threads.find(t=>t.id===S.thread.id);if(item)item.pinned=result.pinned;renderThreads();}
  else if(kind==='feedback')toast('反馈已发送');
  else await syncSnapshot();
});
$('return-main').onclick=action(async()=>{if(!S.sideOrigin)return;if(S.status==='running')throw new Error('侧边聊天正在运行，请等待完成或停止。');const origin=S.sideOrigin;S.sideOrigin=null;$('side-context').hidden=true;await selectThread(origin.thread);controls();});
let projectChoicesAt=0;
async function refreshProjectChoices(){
  if(S.capabilities?.projects!==true||Date.now()-projectChoicesAt<10000)return;projectChoicesAt=Date.now();
  const projects=await api('/api/codex/projects');if(!S.user)return;S.projects=projects;
  $('project-count').textContent=String(projects.filter(p=>p.kind!=='projectless').length);$('project-select').replaceChildren();
  for(const project of projects){const option=el('option',project.name);option.value=project.id;$('project-select').append(option);}
  if(S.project){const selected=projects.find(p=>p.id===S.project.id);if(selected)S.project=selected;$('project-select').value=S.project.id;}
}
