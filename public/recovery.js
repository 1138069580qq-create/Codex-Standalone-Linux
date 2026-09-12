/* Recovery UI and read-only history. A cached task never authorizes a write. */
(function(scope){
  'use strict';
  let timer=null,dirty=false;
  const current=(epoch,project,id)=>epoch===S.epoch&&S.project?.id===project&&S.thread?.id===id;
  function cacheError(error){S.cacheError='历史缓存未保存：'+(error?.message||'安全存储不可用');render();}
  function cacheCurrent(){
    clearTimeout(timer);timer=null;
    if(!dirty||!S.user||!S.project||!S.thread||S.historyState!=='ready')return;
    dirty=false;const epoch=S.epoch,project=S.project.id,id=S.thread.id;
    const snapshot=scope.CodexHistoryCore.snapshot({items:[...S.items.values()],turns:S.turns,truncated:S.truncated});
    return scope.CodexHistory.write(project,id,snapshot).then(()=>{if(current(epoch,project,id)){S.historySavedAt=snapshot.savedAt;S.cacheError='';render();}}).catch(error=>{if(current(epoch,project,id))cacheError(error);});
  }
  function changed(){dirty=true;if(!timer)timer=setTimeout(cacheCurrent,2000);}
  function reset(){cacheCurrent();clearTimeout(timer);timer=null;dirty=false;S.historyDenied=false;S.historyState='none';S.historyError='';S.historySavedAt=0;S.cacheError='';S.streamDiagnostic='';}
  async function restore(epoch,project,id){
    try{
      const row=await scope.CodexHistory.read(project,id);
      if(!row||S.historyDenied||!current(epoch,project,id)||!['loading','error'].includes(S.historyState)||S.items.size)return;
      if(!Array.isArray(row.items)||!Array.isArray(row.turns))return;
      // Re-sanitize rather than trust a stored payload or regain live controls from it.
      const cached=scope.CodexHistoryCore.snapshot(row,row.savedAt);
      S.items=new Map(cached.items.map(item=>[item.id,item]));S.turns=cached.turns;S.historySavedAt=row.savedAt;
      S.historyState='cached';S.status='notLoaded';S.truncated=cached.truncated;
      S.pending.clear();S.turnId=null;S.cursor='';S.tokenUsage=null;S.queueCount=0;
      scope.CodexUsage?.metrics(null);scope.CodexQueue?.reset();renderTimeline();renderApprovals();controls();
    }catch(error){if(current(epoch,project,id))cacheError(error);}
  }
  function failed(error){
    const denied=[401,403,404].includes(error.status);S.historyDenied=denied;
    if(denied){
      dirty=false;clearTimeout(timer);timer=null;
      scope.CodexHistory.remove(S.project?.id,S.thread?.id).catch(cacheError);
      scope.CodexFeatures?.reset();S.items.clear();S.turns=[];S.nodes.clear();$('timeline').replaceChildren($('empty'));
    }
    S.historyState=S.items.size?'cached':'error';S.historyError=error.message;
    S.status='notLoaded';S.pending.clear();S.turnId=null;S.queueCount=0;scope.CodexQueue?.reset();renderApprovals();
    if(['CODEX_DISCONNECTED','CODEX_OFFLINE','DESKTOP_BRIDGE_OFFLINE'].includes(error.code)||error.status===503)S.connected=false;
    controls();
  }
  function disconnected(){cacheCurrent();S.streamLost=true;if(S.thread){S.historyState=S.items.size?'cached':'error';S.historyError='连接已中断';S.pending.clear();S.turnId=null;S.queueCount=0;scope.CodexQueue?.reset();renderApprovals();}controls();}
  function render(){
    const connection=$('connection-recovery');if(!connection)return;
    connection.hidden=!S.user||!!S.connected&&!S.contextError&&!S.streamLost&&!S.listError;
    $('connection').className='connection-label';$('connection').textContent=S.contextError?'服务器状态未同步':S.listError?'任务列表未同步':S.streamLost&&S.connected?(S.timer||S.realtimeRecovery?'正在恢复实时连接':'实时连接中断'):S.connected?'Codex 已连接':'Codex 暂未连接';
    $('connect').hidden=!S.user;$('connect').disabled=!!S.reconnecting||!!S.sending;
    $('connect').textContent=S.reconnecting?'连接中…':S.user?.admin&&!S.connected?'连接 Codex':'重新连接';
    const streamReason={READ_TIMEOUT:'实时连接读取超时',NETWORK_UNREACHABLE:'网络暂时不可达',TLS_ERROR:'安全连接校验失败',AUTH_EXPIRED:'登录已过期',HISTORY_TOO_LARGE:'历史记录超过读取上限',STREAM_LIMIT:'实时连接数量达到限制',STREAM_CONTENT_TYPE:'服务器未返回实时数据流',BACKEND_OFFLINE:'服务器连接暂不可用',STREAM_EOF:'实时连接已结束，正在重新同步',NETWORK_IO:'实时数据流读取失败'}[S.streamDiagnostic]||'';
    $('connection-message').textContent=S.contextError||(S.streamLost?streamReason:'')||(!S.connected&&!S.user?.admin?'管理员断开后需由管理员恢复':'');
    scope.document?.body?.classList?.toggle('history-readonly',!!S.thread&&S.historyState!=='ready');
    const state=S.historyState,hasTask=!!S.thread,visible=hasTask&&state!=='ready'||!!S.cacheError;
    $('history-status').hidden=!visible;
    $('history-message').textContent=S.cacheError||(state==='loading'?'正在读取任务记录…':state==='cached'?'已读文字缓存 · 尚未同步'+(S.historyError?' · '+S.historyError:''):state==='error'?'记录未读取成功 · '+S.historyError:'');
    $('history-message').title=S.historyError||S.cacheError||'';
    $('history-retry').hidden=!hasTask||state==='ready';$('history-retry').disabled=!!S.syncing||!!S.reconnecting;
    const empty=$('empty');empty.hidden=S.items.size>0;
    const title=empty.querySelector('h2'),body=empty.querySelector('p');
    if(title)title.textContent=hasTask?(state==='loading'?'读取中':state==='error'?'暂未读取到记录':state==='cached'?'尚未同步':state==='ready'?'暂无消息':'读取中'):S.newTask?'新任务':'暂无任务';
    if(body)body.textContent=hasTask?(state==='ready'?'可以发送第一条消息。':state==='loading'?'':state==='cached'?'连接后刷新完整记录。':'请重试读取，读取失败不代表记录已删除。'):S.newTask?'输入首条消息后创建任务':'选择一个任务，或新建任务。';
  }
  async function retry(){
    if(S.reconnecting)return S.reconnecting;if(!S.user||S.sending)return;
    const account=S.user.id,epoch=S.epoch;
    const work=(async()=>{
      try{
        if(S.user.admin&&!S.connected)await api('/api/codex/admin/connect',{});
        if(account!==S.user?.id||epoch!==S.epoch)return;
        await refreshContext({restoreAttached:false});
        if(account!==S.user?.id||S.contextError)return;
        if(S.thread)await syncSnapshot();else {await restoreSelectedTask();if(!S.thread&&S.connected)await restoreAttachedThread();}
      }finally{if(account===S.user?.id)controls();}
    })();
    S.reconnecting=work;controls();try{return await work;}finally{if(S.reconnecting===work)S.reconnecting=null;controls();}
  }
  scope.CodexRecovery={render,reset,restore,changed,cacheCurrent,failed,disconnected,retry,cacheError};
})(globalThis);
