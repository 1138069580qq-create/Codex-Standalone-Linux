'use strict';
(function(){
  let rows=[],pending=null,timer=null;const drafts=new Map(),busy=new Set();
  const current=()=>S.thread&&S.project?{epoch:S.epoch,thread:S.thread.id,project:S.project.id}:null;
  const matches=c=>c&&c.epoch===S.epoch&&c.thread===S.thread?.id&&c.project===S.project?.id;
  const url=c=>'/api/codex/threads/'+encodeURIComponent(c.thread)+'/queue';
  function show(data){rows=data;S.queueCount=rows.length;render();controls();}
  function reset(){clearTimeout(timer);timer=null;pending=null;rows=[];drafts.clear();busy.clear();S.queueCount=0;$('message-queue').replaceChildren();$('message-queue').hidden=true;}
  async function refreshNow(){
    const c=current();if(!c)return;if(pending)return pending;
    const work=(async()=>{const result=await api(url(c)+'?'+q({projectId:c.project}));if(matches(c))show(result.data);})();pending=work;
    try{await work;}finally{if(pending===work)pending=null;}
  }
  function refresh(){clearTimeout(timer);timer=setTimeout(()=>{timer=null;refreshNow().catch(e=>notice('队列刷新失败：'+e.message));},120);}
  async function change(row,action,text){
    const c=current();if(!c||busy.has(row.id))return;busy.add(row.id);render();
    try{
      const result=await api(url(c)+'/'+encodeURIComponent(row.id),{projectId:c.project,version:row.version,action,...(text!==undefined?{text}:{})},'PATCH');
      if(!matches(c))return;
      if(result.state==='unknown'||result.state==='paused')notice(result.error);
      if(action!=='edit')drafts.delete(row.id);
      await refreshNow();
    }catch(e){if(matches(c)){notice(e.message);await refreshNow().catch(()=>{});}}
    finally{busy.delete(row.id);if(matches(c))render();}
  }
  function render(){
    const root=$('message-queue');root.hidden=!rows.length;root.replaceChildren();if(!rows.length)return;
    root.append(el('strong','排队消息 · '+rows.length),el('p','当前轮结束后依次发送；立即发送会补充当前轮，不会中断。','footnote'));
    for(const row of rows){
      const card=el('div',undefined,'queued-message');card.dataset.queueId=row.id;
      const state={queued:'等待发送',editing:'编辑中（已暂停）',paused:'已暂停',sending:'正在提交',unknown:'发送结果待核对'}[row.state]||row.state;
      card.append(el('span',state,'queue-state'));
      let editor;
      if(row.state==='editing'){
        editor=el('textarea');editor.value=drafts.get(row.id)??row.text;editor.maxLength=64000;editor.rows=3;editor.setAttribute('aria-label','编辑排队消息');editor.oninput=()=>drafts.set(row.id,editor.value);card.append(editor);
      }else card.append(el('p',row.text,'queued-text'));
      if(row.attachments.length||row.references.length)card.append(el('p','附件 '+row.attachments.length+' · 引用 '+row.references.length,'footnote'));
      if(row.error)card.append(el('p',row.error,'queue-error'));
      const actions=el('div',undefined,'queue-actions');
      const button=(label,action,fn)=>{const b=el('button',label,'small');b.type='button';b.disabled=busy.has(row.id)||row.state==='sending';b.onclick=()=>change(row,action,fn?.());actions.append(b);};
      if(row.state==='editing'){button('保存并排队','save',()=>editor.value);button('取消编辑','resume');}
      else if(row.state!=='unknown'){
        button('立即发送','send');button('编辑','edit');if(row.state==='paused')button('继续排队','resume');
      }
      button(row.state==='unknown'?'移除记录':'删除','delete');card.append(actions);root.append(card);
    }
  }
  globalThis.CodexQueue={show,reset,refresh,refreshNow};
})();
