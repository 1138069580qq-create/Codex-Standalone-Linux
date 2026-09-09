'use strict';
(() => {
  const U={account:null,summary:null,details:null,tab:'requests',loading:null,timer:null,last:0,sequence:0,before:null,rows:[],detailSequence:0,recordSequence:0,memberSequence:0,adminSequence:0,interval:5};
  const number=v=>Number.isFinite(v)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(v):'—';
  const compact=v=>!Number.isFinite(v)?'—':v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(v<10000?1:0)+'K':String(Math.round(v));
  const money=v=>Number.isFinite(v)?'$'+v.toFixed(4):'未定价';
  const duration=v=>!Number.isFinite(v)?'—':v<1000?Math.round(v)+'ms':v<60000?(v/1000).toFixed(1)+'s':Math.floor(v/60000)+'m'+Math.round(v%60000/1000)+'s';
  const cost=s=>s.unpriced?(s.cost>0?money(s.cost)+' + 未定价':'未定价'):money(s.cost);
  const error=message=>{if(message){const layer=messageLayer();layerMessage(message,true,layer?.id==='usage-record-dialog'?layer:$('usage-dialog'));}else{for(const id of ['usage-dialog','usage-record-dialog']){const node=$(id).querySelector('[data-layer-message]');if(node){node.hidden=true;node.textContent='';}}}$('usage-error').hidden=true;};
  function reset(){++U.sequence;++U.detailSequence;++U.recordSequence;++U.memberSequence;++U.adminSequence;U.tab='requests';clearTimeout(U.timer);U.timer=null;U.summary=null;U.details=null;U.loading=null;U.account=null;U.last=0;U.rows=[];$('quota-content').textContent='尚未读取';$('run-metrics').hidden=true;for(const id of ['usage-dialog','usage-record-dialog'])if($(id).open)$(id).close();for(const id of ['usage-hero','usage-table','usage-chart','usage-estimates','quota-detail-content','usage-record-content','usage-subscription','usage-members','admin-members'])$(id).replaceChildren();$('usage-prices').value='';}
  function schedule(){clearTimeout(U.timer);if(!S.user||document.hidden)return;const delay=Math.max(1000,U.interval*60000-(Date.now()-U.last));U.timer=setTimeout(()=>load().catch(()=>{}),delay);}
  async function load(force=false){
    if(!S.user)return;const account=S.user.id;if(U.account!==account){reset();U.account=account;try{U.interval=localStorage.getItem('codex-usage-refresh')==='30'?30:5;}catch{}$('usage-interval').value=String(U.interval);}
    if(U.loading)return U.loading;
    if(!force&&U.summary&&Date.now()-U.last<U.interval*60000){schedule();return U.summary;}
    const sequence=U.sequence;
    const work=(async()=>{try{const summary=await api('/api/codex/account/usage');if(sequence!==U.sequence||S.user?.id!==account)return;U.summary=summary;U.last=Date.now();renderSummary();if($('usage-dialog').open&&U.tab==='quota')renderEstimates();return summary;}catch(e){if(sequence===U.sequence){U.last=Date.now();if(!U.summary)$('quota-content').textContent='统计暂不可用';else $('quota-content').title='保留上次数据：'+e.message;}throw e;}finally{if(sequence===U.sequence){U.loading=null;schedule();}}})();U.loading=work;return work;
  }
  function cycleMessage(cycle){return cycle.status==='expired'?'等待账户返回新周期':cycle.reason==='read-failed'?'套餐信息暂不可用':'未获取套餐日期';}
  function renderSubscription(cycle){const node=$('usage-subscription');node.replaceChildren();node.append(metric('账户套餐',cycle.planType||'未提供'));if(cycle.start&&cycle.end){node.append(metric('周期开始',date(cycle.start)),metric('周期结束',date(cycle.end)));}else node.append(metric('套餐日期',cycleMessage(cycle)));node.append(el('p','自动读取账户信息 · 每周期 5 个周额度','footnote'));}
  function metric(label,value,title){const cell=el('div',undefined,'usage-metric');cell.append(el('span',label,'muted'),el('strong',value));if(title)cell.title=title;return cell;}
  function renderSummary(){
    const s=U.summary;if(!s)return;const node=$('quota-content');node.replaceChildren();node.className='';
    const weeks=(s.limits?.windows||[]).filter(w=>w.windowDurationMins===10080),codex=weeks.filter(w=>!w.bucketId||w.bucketId==='codex');
    const visible=codex.length?codex:weeks;
    if(!visible.length)node.append(metric('周额度剩余','未获取周额度'));
    for(const window of visible){const remaining=Math.max(0,100-window.usedPercent),box=metric('周额度剩余'+(visible.length>1?' · '+(window.bucketId||window.name||'Codex'):''),remaining.toFixed(1)+'%','共享 Codex 账户当前周窗口，不是单个网页账户的额度。');const bar=el('progress');bar.max=100;bar.value=remaining;bar.setAttribute('aria-label','周额度剩余');box.append(bar,el('p',window.resetsAt?shortDate(window.resetsAt)+' 重置':'未提供重置时间','footnote'));node.append(box);}
    node.append(metric('累计折算额度',cost(s.total),'按记录时的 API 单价折算，不是订阅实际账单。'));
    const p=s.cycle.configured&&Number.isFinite(s.weeklyPercent)?s.weeklyPercent/5:null,box=metric('本账户占周期总额度',Number.isFinite(p)?p.toFixed(2)+'%':'待估算','总周期固定为 5 个周额度（100%）；本账户累计已用周额度百分比 ÷ 5。每个采样区间按美元费用占比分摊实际减少的周额度，再累加（估算）。');
    const bar=el('progress');bar.max=100;bar.value=Number.isFinite(p)?Math.min(100,p):0;bar.setAttribute('aria-label','订阅周期已用百分比');box.append(bar);node.append(box);
    if(!s.cycle.configured&&s.cycle.reason==='period-not-provided'&&Number.isFinite(s.weeklyPercent))node.append(metric('已观测占五周额度',(s.weeklyPercent/5).toFixed(2)+'%','套餐起止日期未提供；仅含已观测区间，不代表已核实的完整账期。'));
    const button=el('button','使用统计 ›','small wide');button.id='open-usage';button.onclick=action(open);node.append(button);
    if(S.user?.admin){const members=el('button','成员用量与总计 ›','small wide');members.id='open-member-usage';members.onclick=action(()=>open('members'));node.append(members);}
    const quota=el('button',S.user?.admin?'额度与重置卡 ›':'查看额度详情 ›','small wide');quota.id='open-quota-detail';quota.onclick=action(()=>open('quota'));node.append(quota);
    node.append(el('p',s.total.unpriced?'有模型未定价':s.cycle.configured?'每周期 5 个周额度':cycleMessage(s.cycle),'footnote'));
    node.title='费用与额度更新：'+date(s.generatedAt)+' · '+U.interval+' 分钟刷新';
  }
  function metrics(m){
    const row=$('run-metrics');row.replaceChildren();row.hidden=!m;if(!m)return;
    const values=[m.rounds+' 轮 · '+m.steps+' 步','LLM '+duration(m.llmMs)+' · 工具调用 '+duration(m.toolMs),'首 token 平均 '+duration(m.ttftMs)+' · '+(Number.isFinite(m.tokensPerSecond)?Math.round(m.tokensPerSecond)+' tok/s':'— tok/s'),'缓存命中 '+(Number.isFinite(m.cacheHitPercent)?Math.round(m.cacheHitPercent)+'%':'—'),'输入 '+compact(m.input)+' tok · 输出 '+compact(m.output)+' tok'];
    for(const value of values)row.append(el('span',value));
    row.title='启用统计后观察到的轮数与非重复用量事件。LLM 为轮次耗时扣除工具占用时间，首 token 为本轮首个可见输出延迟；网络、等待审批会影响观测值。缓存创建数据不可用时不补零。';
  }
  async function open(tab){error('');if(typeof tab==='string')U.tab=tab;$('usage-settings-tab').hidden=!S.user?.admin;$('usage-members-tab').hidden=!S.user?.admin;$('usage-dialog').showModal();
    if(U.tab==='members'&&S.user?.admin){await selectTab('members');return;}
    if(U.tab==='quota'){await load();await selectTab('quota');return;}
    await Promise.all([load(),loadDetails()]);
  }
  async function loadDetails(more=false){
    const sequence=++U.detailSequence,account=S.user?.id;error('');
    const query=new URLSearchParams({range:$('usage-range').value,offset:String(-new Date().getTimezoneOffset())});
    for(const name of ['model','provider'])if($('usage-'+name).value)query.set(name,$('usage-'+name).value);
    if(more&&U.before)query.set('before',String(U.before));
    $('usage-more').disabled=true;$('usage-refresh').disabled=true;
    try{const d=await api('/api/codex/account/usage/details?'+query);if(sequence!==U.detailSequence||account!==S.user?.id)return;
      U.details=d;U.rows=more?U.rows.concat(d.rows):d.rows;U.before=d.next;
      for(const [name,rows,key]of [['model',d.models,'model'],['provider',d.providers,'provider']]){const select=$('usage-'+name);if(!select.value){select.replaceChildren(new Option(name==='model'?'全部模型':'全部供应商',''));for(const item of rows)select.append(new Option(item[key],item[key]));}}
      renderHero();chart(d);await selectTab(U.tab,false);
    }catch(e){if(sequence===U.detailSequence)error(e.message);}finally{if(sequence===U.detailSequence){$('usage-more').disabled=false;$('usage-refresh').disabled=false;}}
  }
  function renderHero(){
    const s=U.details.summary,node=$('usage-hero');node.replaceChildren();const header=el('div',undefined,'usage-hero-header'),total=metric('实际消耗 Tokens',number(s.input+s.output));header.append(total,metric('用量记录',number(s.requests)),metric('总折算费用',cost(s)));node.append(header);
    const grid=el('div',undefined,'usage-grid');grid.append(metric('新增输入',compact(s.input-s.cached)),metric('输出',compact(s.output)),metric('缓存创建','N/A'),metric('缓存命中',compact(s.cached)));const hit=metric('缓存命中率',s.input?(s.cached/s.input*100).toFixed(1)+'%':'—');const bar=el('progress');bar.max=100;bar.value=s.input?s.cached/s.input*100:0;hit.append(bar);grid.append(hit);node.append(grid);
  }
  function chart(d){
    const host=$('usage-chart');host.replaceChildren();if(!d.trend.length){host.append(el('p','这个时间范围暂无用量','muted'));return;}
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 1040 245');svg.setAttribute('role','img');svg.setAttribute('aria-label','用量和美元费用趋势图');
    const add=(tag,attrs,text)=>{const node=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))node.setAttribute(k,String(v));if(text!==undefined)node.textContent=text;svg.append(node);return node;};
    const step=$('usage-range').value==='today'?3600000:86400000,begin=Math.max(d.since,d.generatedAt-step*365),first=Math.floor((begin+new Date().getTimezoneOffset()*-60000)/step)*step-new Date().getTimezoneOffset()*-60000;
    const found=new Map(d.trend.map(p=>[p.at,p])),points=[];for(let at=first;at<=d.generatedAt&&points.length<366;at+=step)points.push(found.get(at)||{at,input:0,cached:0,output:0,cost:0});
    if(points.length===1)points.push({...points[0],at:points[0].at+step});
    const tokenMax=Math.max(1,...points.flatMap(p=>[p.input,p.cached,p.output])),costMax=Math.max(.01,...points.map(p=>p.cost||0));
    for(let i=0;i<=4;i++){const y=12+i*45;add('line',{x1:54,x2:975,y1:y,y2:y,stroke:'#344247','stroke-dasharray':'3 5'});add('text',{x:47,y:y+4,fill:'#8d9e9f','text-anchor':'end','font-size':11},compact(tokenMax*(1-i/4)));add('text',{x:985,y:y+4,fill:'#8d9e9f','font-size':11},'$'+(costMax*(1-i/4)).toFixed(2));}
    const series=[['cached','缓存命中','#b988ff'],['input','新增输入','#5596ff'],['output','输出','#2bd59a'],['cost','费用','#ff6987']];
    for(const [key,label,color]of series){const max=key==='cost'?costMax:tokenMax,path=points.map((p,i)=>(i?'L':'M')+(54+i*921/(points.length-1)).toFixed(2)+' '+(192-Math.max(0,p[key]||0)/max*180).toFixed(2)).join(' ');const line=add('path',{d:path,stroke:color,fill:'none','stroke-width':2});const title=document.createElementNS(ns,'title');title.textContent=label;line.append(title);}
    for(const i of [...new Set([0,Math.floor((points.length-1)/2),points.length-1])]){const dt=new Date(points[i].at),label=String(dt.getMonth()+1).padStart(2,'0')+'/'+String(dt.getDate()).padStart(2,'0')+($('usage-range').value==='today'?' '+String(dt.getHours()).padStart(2,'0')+':00':'');add('text',{x:54+i*921/(points.length-1),y:218,fill:'#8d9e9f','font-size':11,'text-anchor':i===0?'start':i===points.length-1?'end':'middle'},label);}
    host.append(svg);const legend=el('div',undefined,'usage-legend');for(const [key,label]of series)legend.append(el('span',label,'series-'+key));host.append(legend);
  }
  async function selectTab(tab,fetchSettings=true){
    if((tab==='members'||tab==='settings')&&!S.user?.admin)tab='requests';
    U.tab=tab;for(const button of document.querySelectorAll('[data-usage-tab]')){const active=button.dataset.usageTab===tab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));}
    $('usage-quota').hidden=tab!=='quota';$('usage-settings').hidden=tab!=='settings';$('usage-table').hidden=tab==='quota'||tab==='settings'||tab==='members';$('usage-more').hidden=tab!=='requests'||!U.before;
    $('usage-members').hidden=tab!=='members';$('usage-hero').hidden=tab==='members';$('usage-chart').hidden=tab==='members';
    for(const id of ['usage-range','usage-model','usage-provider'])$(id).disabled=tab==='members';
    if(tab==='members'){await loadMembers();return;}
    if(tab==='quota'){renderEstimates();if(U.summary?.limits)renderQuota(U.summary.limits);else $('quota-detail-content').textContent='Codex 尚未返回额度窗口。';return;}
    if(tab==='settings'){if(!S.user?.admin)return;if(fetchSettings||!$('usage-prices').value){const settings=await api('/api/codex/account/usage/settings');$('usage-prices').value=JSON.stringify(settings.prices,null,2);renderSubscription(settings.cycle);}return;}
    renderTable();
  }
  async function loadMembers(){
    if(!S.user?.admin)return;
    const sequence=++U.memberSequence,account=S.user.id,node=$('usage-members');
    node.replaceChildren(el('p','正在读取成员用量…','muted'));
    try{
      const data=await api('/api/codex/account/usage/members');
      if(sequence!==U.memberSequence||account!==S.user?.id||!S.user?.admin||U.tab!=='members')return;
      renderMembers(data);
    }catch(e){if(sequence===U.memberSequence&&account===S.user?.id&&S.user?.admin&&U.tab==='members'){node.replaceChildren(el('p','成员用量读取失败，请点击刷新重试。','muted'));error(e.message);}}
  }
  async function loadAdminMembers(){
    if(!S.user?.admin)return;const sequence=++U.adminSequence,account=S.user.id,node=$('admin-members');node.hidden=false;
    node.replaceChildren(el('p','正在读取成员用量…','muted'));
    try{const data=await api('/api/codex/account/usage/members');if(sequence!==U.adminSequence||account!==S.user?.id||!S.user?.admin)return;renderMembers(data,node);}
    catch(e){if(sequence===U.adminSequence&&account===S.user?.id&&S.user?.admin)node.replaceChildren(el('p','成员用量读取失败：'+e.message+'；可点击“刷新用量”重试。','error'));}
  }
  function renderMembers(data,node=$('usage-members')){
    node.replaceChildren();
    node.append(el('p',data.cycle.configured?'当前套餐周期：'+date(data.cycle.start)+' — '+date(data.cycle.end):cycleMessage(data.cycle),'footnote'));
    node.append(metric('总周期额度','100%（固定 5 个周额度）'));
    node.append(metric('总消耗美元（估算）',cost(data.total.cycleUsage)));
    const wrap=el('div',undefined,'usage-table-wrap'),table=el('table'),head=el('thead'),titles=el('tr');
    for(const title of ['成员','已用美元（估算）','已用周额度（累计）','占总周期额度'])titles.append(el('th',title));head.append(titles);table.append(head);
    const body=el('tbody');
    const percent=(verified,observed)=>Number.isFinite(verified)?verified.toFixed(2)+'%':Number.isFinite(observed)?observed.toFixed(2)+'%（已观测）':'待获取';
    const row=(name,value)=>{const tr=el('tr');tr.append(el('th',name),el('td',cost(value.cycleUsage)),el('td',percent(value.weeklyPercent,value.observedWeeklyPercent)),el('td',percent(value.subscriptionPercent,value.observedSubscriptionPercent)));return tr;};
    for(const member of data.members)body.append(row(member.username,member));table.append(body);
    const footer=el('tfoot');footer.append(row('合计（全部成员，含管理员）',data.total));table.append(footer);wrap.append(table);node.append(wrap);
    node.append(el('p','总周期固定为 5 个周额度。成员占周期百分比 = 累计已用周额度百分比 ÷ 5；用满一个周额度即 20%。每个采样区间：成员周用量 = 该区间实际消耗的周额度 × 成员美元消耗 ÷ 全员美元消耗，再累加。共享账户没有逐成员读数，分摊为估算；未观测区间不补算。','footnote'));
    if(!data.cycle.configured)node.append(el('p','套餐起止日期未提供或已过期；美元消耗仍保留。有有效采样时单独显示“已观测”百分比（周用量 ÷ 5），不冒充完整账期；无有效采样则显示待获取。'+(data.calibration?' 观测区间：'+date(data.calibration.from)+' — '+date(data.calibration.to):''),'footnote'));
    if(!data.pricingComplete)node.append(el('p','存在未定价用量，额度百分比暂不估算。','footnote'));
    if(data.quotaGap)node.append(el('p','检测到额度采样缺口，百分比可能不完整。','footnote'));
    node.append(el('p','统计更新：'+date(data.generatedAt)+' · 与共享额度相同，最多 5 分钟更新一次','footnote'));
  }
  function renderEstimates(){const node=$('usage-estimates');node.replaceChildren();const s=U.summary;if(!s)return;const grid=el('div',undefined,'usage-grid');grid.append(metric('本周期折算用量',cost(s.cycleUsage)),metric('一个周额度','100% 周额度'),metric('周期总额度','100%（固定 5 个周额度）'),metric('本账户累计周用量',Number.isFinite(s.weeklyPercent)?s.weeklyPercent.toFixed(2)+'%':'待估算'));node.append(grid);node.append(el('p','本账户占周期比例 = 本账户累计已用周额度百分比 ÷ 5。总周期容量固定为 5 个周额度，不使用美元估算预算作为分母；已消耗美元折算保留。逐采样区间按成员美元费用占比分摊实际消耗的周额度后累加（估算）。','footnote'));if(!s.pricingComplete)node.append(el('p','存在未定价用量，暂不推算订阅额度。','error'));if(s.quotaGap)node.append(el('p','检测到周窗口或重置卡变化，未观测的区间不补算。','footnote'));node.append(el('p',s.cycle.configured?'套餐周期：'+date(s.cycle.start)+' — '+date(s.cycle.end):cycleMessage(s.cycle),'footnote'));if(s.limits)node.append(el('p','额度采样：'+date(s.limits.fetchedAt),'footnote'));}
  function renderTable(){
    const host=$('usage-table');host.replaceChildren();const d=U.details;if(!d)return;
    const table=el('table'),thead=el('thead'),head=el('tr'),request=U.tab==='requests';
    const headers=request?['时间','供应商','计费模型','输入 / 缓存','输出','总费用','本轮用时 / 首字','状态','来源']:['名称','记录数','输入','缓存命中','输出','折算费用'];for(const title of headers)head.append(el('th',title));thead.append(head);table.append(thead);const body=el('tbody');
    const rows=request?U.rows:d[U.tab];
    for(const row of rows||[]){const tr=el('tr');if(request){const time=el('td'),button=el('button',date(row.at),'usage-row-button');button.onclick=action(()=>record(row.id));time.append(button);tr.append(time,el('td',row.provider),el('td',row.model),el('td',compact(row.input)+' / '+compact(row.cached)),el('td',compact(row.output)),el('td',money(row.cost)),el('td',duration(row.durationMs)+' / '+duration(row.ttftMs)),el('td',row.status==='observed'?'已观测':stateName(row.status)),el('td','Codex 会话'));}else{const name=row[U.tab==='models'?'model':'provider'],cell=el('td'),button=el('button',name,'usage-row-button');button.onclick=action(async()=>{const select=$('usage-'+(U.tab==='models'?'model':'provider'));if(!Array.from(select.options).some(o=>o.value===name))select.append(new Option(name,name));select.value=name;U.tab='requests';await loadDetails();});cell.append(button);tr.append(cell,el('td',number(row.requests)),el('td',compact(row.input)),el('td',compact(row.cached)),el('td',compact(row.output)),el('td',cost(row)));}body.append(tr);}
    if(!rows?.length){const tr=el('tr'),cell=el('td','暂无记录','muted');cell.colSpan=headers.length;tr.append(cell);body.append(tr);}table.append(body);host.append(table);
  }
  async function record(id){
    const account=S.user?.id,sequence=++U.recordSequence,dialog=$('usage-record-dialog'),node=$('usage-record-content');
    node.replaceChildren(el('p','正在读取用量记录…','muted'));dialog.showModal();
    try {
      const row=await api('/api/codex/account/usage/records/'+id);
      if(account!==S.user?.id||sequence!==U.recordSequence||!dialog.open)return;
      node.replaceChildren();for(const [label,value]of [['时间',date(row.at)],['模型',row.model],['供应商',row.provider],['新增输入',number(row.input-row.cached)],['缓存命中',number(row.cached)],['输出',number(row.output)],['折算费用',money(row.cost)],['记录来源','Codex 累计用量差值']])node.append(metric(label,value));if(row.price){node.append(el('h3','本条计价快照'));node.append(el('pre',JSON.stringify(row.price,null,2),'usage-price-snapshot'));}else node.append(el('p','没有这个模型的已核验单价，未计为免费。','footnote'));
    }catch(error){if(account===S.user?.id&&sequence===U.recordSequence&&dialog.open){node.replaceChildren();layerMessage(error.message,true,dialog);}}
  }
  $('close-usage').onclick=()=>$('usage-dialog').close();$('close-usage-record').onclick=()=>{++U.recordSequence;$('usage-record-dialog').close();};
  for(const id of ['usage-range','usage-model','usage-provider'])$(id).onchange=()=>loadDetails();
  $('usage-more').onclick=action(()=>loadDetails(true));$('usage-refresh').onclick=action(()=>Promise.all([load(true),loadDetails()]));
  for(const button of document.querySelectorAll('[data-usage-tab]'))button.onclick=action(()=>selectTab(button.dataset.usageTab));
  $('usage-interval').onchange=()=>{U.interval=$('usage-interval').value==='30'?30:5;try{localStorage.setItem('codex-usage-refresh',String(U.interval));}catch{}schedule();renderSummary();};
  $('usage-settings').onsubmit=action(async()=>{const prices=JSON.parse($('usage-prices').value);await api('/api/codex/account/usage/settings',{prices},'PUT');await load(true);toast('已保存；单价适用于后续用量。');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(U.timer);U.timer=null;}else if(S.user)load().catch(()=>{});});
  $('admin-usage-refresh').onclick=action(loadAdminMembers);
  window.CodexUsage={load,reset,metrics,open,loadAdminMembers};
})();
