/* Pure turn model. One wall-clock duration, never a sum of tool timings. */
(function(scope){
  const active=s=>['running','inProgress','active'].includes(s);
  function duration(ms){
    if(!Number.isFinite(ms)||ms<0)return '';
    const seconds=Math.floor(ms/1000);if(seconds<1)return '不到 1 秒';
    if(seconds<60)return seconds+' 秒';
    const minutes=Math.floor(seconds/60),rest=seconds%60;
    return (minutes>=60?Math.floor(minutes/60)+' 小时 '+(minutes%60?minutes%60+' 分钟':''):minutes+' 分钟')+(rest?' '+rest+' 秒':'');
  }
  function group(items,state={},now=Date.now()){
    const rows=[],byId=new Map();let current;
    for(const item of items){
      let id=item.turnId;
      if(!id)id=item.type==='userMessage'?'legacy:'+item.id:current?.id||'legacy:'+item.id;
      let row=byId.get(id);if(!row){row={id,items:[]};rows.push(row);byId.set(id,row);}row.items.push(item);current=row;
    }
    const timings=new Map((state.turns||[]).map(t=>[t.id,t]));
    return rows.map((row,index)=>{
      const timing=timings.get(row.id),isCurrent=state.turnId?state.turnId===row.id:index===rows.length-1;
      const running=timing?active(timing.status):isCurrent&&active(state.status);
      const status=timing?.status||(running?'inProgress':isCurrent&&state.status==='failed'?'failed':'completed');
      const users=row.items.filter(i=>i.type==='userMessage'),others=row.items.filter(i=>i.type!=='userMessage');
      let finals=others.filter(i=>i.type==='agentMessage'&&i.phase==='final_answer');
      if(!finals.length&&!running){const last=others.filter(i=>i.type==='agentMessage').at(-1);if(last&&!last.phase)finals=[last];}
      const finalIds=new Set(finals.map(i=>i.id)),process=others.filter(i=>!finalIds.has(i.id));
      const images=[],files=[],seenImages=new Set(),seenFiles=new Set();
      for(const item of others){
        for(const [imageIndex,image]of (item.images||[]).entries()){
          const key=image.path||image.generated||image.src;if(!key||seenImages.has(key))continue;
          seenImages.add(key);images.push({...image,itemId:item.id,imageIndex});
        }
        // Deliver explicit assistant links and created files, not every edited source file.
        for(const file of item.files||[]){
          if(item.type!=='agentMessage'&&file.kind!=='add')continue;
          if(!file.path||file.kind==='delete'||seenFiles.has(file.path)||seenImages.has(file.path))continue;
          seenFiles.add(file.path);files.push(file);
        }
      }
      let elapsed=timing?.durationMs;
      if(!Number.isFinite(elapsed)&&Number.isFinite(timing?.startedAt)){
        const end=running?now:timing.finishedAt;if(Number.isFinite(end))elapsed=Math.max(0,end-timing.startedAt);
      }
      // Legacy history may have item timestamps but not turn metadata. Only a span is meaningful.
      if(!Number.isFinite(elapsed)){
        const starts=others.map(i=>i.startedAt).filter(Number.isFinite),ends=others.map(i=>i.finishedAt).filter(Number.isFinite);
        if(starts.length&&(running||ends.length))elapsed=Math.max(0,(running?now:Math.max(...ends))-Math.min(...starts));
      }
      const failed=['failed','interrupted','cancelled','canceled'].includes(status);
      return {...row,users,process,finals,images,files,running,status,elapsed,
        collapsible:!running&&!failed&&(finals.length>0||images.length>0||files.length>0),
        label:(running?'正在处理':failed?(status==='failed'?'执行失败':'已停止'):'用时')+(duration(elapsed)?' '+duration(elapsed):running?'…':failed?'':' · 查看过程')};
    });
  }
  const api={group,duration};if(typeof module!=='undefined')module.exports=api;else scope.CodexTurns=api;
})(globalThis);
