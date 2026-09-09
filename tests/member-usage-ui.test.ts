import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync('public/usage.js','utf8');
function fixture(){
 const nodes:Record<string,any>={},pending:any[]=[],messages:string[]=[];
 const el=(tag:string,text?:string,className?:string):any=>({tag,textContent:text||'',className,children:[],hidden:false,append(...children:any[]){this.children.push(...children);},replaceChildren(...children:any[]){this.children=children;}});
 const context:any=vm.createContext({S:{user:{id:'admin',admin:true}},U:{memberSequence:0,tab:'members'},$: (id:string)=>nodes[id]??=el('div'),el,api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),error:(s:string)=>messages.push(s),metric:(label:string,value:string)=>({label,value}),money:(v:number)=>'$'+v.toFixed(4),cost:(v:any)=>v.unpriced?'未定价':'$'+v.cost.toFixed(4),date:String,cycleMessage:()=> '未获取套餐日期',document:{querySelectorAll:()=>[]},renderTable:()=>{}});
 vm.runInContext(source.slice(source.indexOf('  async function selectTab('),source.indexOf('  function renderEstimates(){')),context);
 return {nodes,pending,messages,context,run:(code:string)=>vm.runInContext(code,context)};
}
const data={cycle:{configured:true,start:1,end:2},weeksPerCycle:5,cycleCapacityPercent:100,pricingComplete:true,generatedAt:2,members:[{username:'Alice',cycleUsage:{cost:2},weeklyPercent:5,subscriptionPercent:1},{username:'Bob',cycleUsage:{cost:6},weeklyPercent:15,subscriptionPercent:3},{username:'Empty',cycleUsage:{cost:0},weeklyPercent:0,subscriptionPercent:0}],total:{cycleUsage:{cost:8},weeklyPercent:20,subscriptionPercent:4}};
test('member usage tab renders separate members and a total, hiding personal-only filters and charts',async()=>{
 const f=fixture(),p=f.run('selectTab("members")');assert.equal(f.nodes['usage-range'].disabled,true);assert.equal(f.nodes['usage-hero'].hidden,true);f.pending[0].resolve(data);await p;
 const text=JSON.stringify(f.nodes['usage-members']);for(const value of ['Alice','Bob','Empty','$2.0000','$6.0000','$8.0000','5.00%','15.00%','20.00%','100%（固定 5 个周额度）','1.00%','3.00%','4.00%','合计（全部成员，含管理员）'])assert.ok(text.includes(value),value);
 const table=f.nodes['usage-members'].children.find((n:any)=>n.className==='usage-table-wrap').children[0];assert.equal(table.children[1].children.length,3);assert.equal(table.children[2].tag,'tfoot');assert.equal(table.children[2].children.length,1);
 await f.run('selectTab("requests")');assert.equal(f.nodes['usage-members'].hidden,true);assert.equal(f.nodes['usage-range'].disabled,false);assert.equal(f.nodes['usage-hero'].hidden,false);
});
test('ordinary users cannot select or fetch member usage',async()=>{
 const f=fixture();f.context.S.user={id:'ordinary',admin:false};await f.run('selectTab("members")');await f.run('loadMembers()');assert.equal(f.context.U.tab,'requests');assert.equal(f.pending.length,0);assert.equal(f.nodes['usage-members'].hidden,true);
 assert.match(readFileSync('public/index.html','utf8'),/id="usage-members-tab"[^>]*hidden/);assert.ok(source.includes("$('usage-members-tab').hidden=!S.user?.admin"));
});
test('member data never renders after account switch, role loss, or a newer request',async()=>{
 const f=fixture(),old=f.run('loadMembers()'),latest=f.run('loadMembers()');f.pending[1].resolve(data);await latest;f.pending[0].resolve({...data,members:[{username:'stale-private',cycleUsage:{cost:1}}]});await old;assert.doesNotMatch(JSON.stringify(f.nodes),/stale-private/);
 const switched=f.run('loadMembers()');f.context.S.user={id:'other',admin:true};f.pending[2].resolve(data);await switched;assert.doesNotMatch(JSON.stringify(f.nodes),/Alice/);
 const demoted=f.run('loadMembers()');f.context.S.user.admin=false;f.pending[3].resolve(data);await demoted;assert.doesNotMatch(JSON.stringify(f.nodes),/Alice/);
});
test('member usage failure stays in its dialog and unknown percentage is not rendered as zero',async()=>{
 const f=fixture(),p=f.run('loadMembers()');f.pending[0].reject(Error('member failure'));await p;assert.deepEqual(f.messages,['member failure']);assert.match(JSON.stringify(f.nodes),/读取失败/);
 f.context.data={...data,cycleUsd:null,total:{cycleUsage:{cost:0,unpriced:1},subscriptionPercent:null},members:[],pricingComplete:false};f.run('renderMembers(data)');const text=JSON.stringify(f.nodes);assert.match(text,/待获取/);assert.match(text,/未定价/);assert.doesNotMatch(text,/\$200|总周期额度（5 周，估算）/);assert.doesNotMatch(text,/0.00%/);
});

test('personal sidebar retains consumed dollars and divides weekly usage by five, not an estimated dollar budget',()=>{
 const nodes:Record<string,any>={};const el=(tag:string,text?:string):any=>({tag,textContent:text||'',children:[],append(...v:any[]){this.children.push(...v);},replaceChildren(){this.children=[];},setAttribute(){}});
 const summary={total:{cost:7.5,unpriced:0},cycle:{configured:true},weeklyPercent:100,subscriptionPercent:999,cycleUsd:999999,limits:{windows:[{windowDurationMins:10080,usedPercent:60}]},generatedAt:1};
 const c:any=vm.createContext({S:{user:{id:'member'}},U:{summary,interval:5},$: (id:string)=>nodes[id]??=el('div'),el,metric:(label:string,value:string)=>Object.assign(el('metric'),{label,value}),cost:(v:any)=>'$'+v.cost.toFixed(4),action:(fn:any)=>fn,open:()=>{},date:String,shortDate:String,cycleMessage:()=> '未获取套餐日期'});
 vm.runInContext(source.slice(source.indexOf('  function renderSummary(){'),source.indexOf('  function metrics(m){')),c);vm.runInContext('renderSummary()',c);
 const text=JSON.stringify(nodes);assert.match(text,/7.5000/);assert.match(text,/20.00%/);assert.match(text,/40.0%/);assert.doesNotMatch(text,/999.00%|999999/);
 summary.cycle.configured=false;vm.runInContext('renderSummary()',c);assert.match(JSON.stringify(nodes),/待估算/);
});
