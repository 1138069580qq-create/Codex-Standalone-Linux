import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UsageLedger,calculateCost,tokenCounters,validatePrices,type Price} from '../src/backend/usage';
import {normalizeRateLimits} from '../src/backend/limits';
const a={uuid:'alice',elevated:false},b={uuid:'bob',elevated:true},admin={uuid:'administrator',elevated:true};
const price:Price={model:'mock-priced',input:2,cachedInput:.5,output:8,source:'https://openai.com/api/pricing/',verifiedAt:'2026-09-09'};
async function fixture(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webui-usage-'));let now=Date.UTC(2026,8,9);const file=path.join(dir,'usage.sqlite'),ledger=new UsageLedger(file,()=>now);t.after(()=>ledger.close());ledger.configure(admin,{prices:[price],cycle:{start:now,end:null}});return {ledger,file,at:()=>now,tick:(ms:number)=>now+=ms};}
const counters=(input:number,cached=0,output=0)=>({inputTokens:input,cachedInputTokens:cached,outputTokens:output,reasoningOutputTokens:999});
function sample(ledger:UsageLedger,at:number,used:number,reset=2000000000){ledger.sample(normalizeRateLimits({rateLimits:{secondary:{windowDurationMins:10080,usedPercent:used,resetsAt:reset}}},at));}
test('pricing counts cached input once, includes reasoning in output once, and handles long context',()=>{
 assert.equal(calculateCost({input:1000000,cached:600000,output:100000},price),1.9);
 assert.equal(calculateCost({input:1000000,cached:600000,output:100000},undefined),null);
 assert.equal(calculateCost({input:1000000,cached:600000,output:100000},{...price,longContext:{threshold:100,input:4,cachedInput:1,output:16}}),3.8);
 assert.deepEqual(tokenCounters(counters(50,20,10)),{input:50,cached:20,output:10});assert.equal(tokenCounters(counters(5,20,10)),null);assert.equal(tokenCounters({totalTokens:500}),null);
 assert.equal(validatePrices([price]).length,1);assert.throws(()=>validatePrices([price,price]));assert.throws(()=>validatePrices([{...price,input:-1}]));assert.throws(()=>validatePrices([{...price,source:'https://example.com/'}]));
});
test('incremental records survive restarts; duplicated or replayed totals do not rebill; other users cannot inspect',async t=>{
 const {ledger,file,at}=await fixture(t);ledger.bind('task-a',a,'pa',price.model,'provider-a',true);
 ledger.observe('task-a','turn/started',{turn:{id:'turn1'}},at());ledger.usage('task-a',counters(1000,600,100),at()+10);ledger.usage('task-a',counters(1000,600,100),at()+11);ledger.usage('task-a',counters(500,300,50),at()+12);
 let details=ledger.details(a,{range:'all'});assert.equal(details.summary.requests,1);assert.equal(details.summary.input,1000);assert.equal(details.summary.cached,600);assert.equal(details.summary.output,100);assert.ok(Math.abs(details.summary.cost-.0019)<1e-10);
 assert.equal(ledger.details(b,{range:'all'}).rows.length,0);assert.throws(()=>ledger.detail(b,(details.rows[0] as any).id));assert.throws(()=>ledger.bind('task-a',b,'pa'));assert.throws(()=>ledger.settings(a));
 ledger.close();const reopened=new UsageLedger(file,at);t.after(()=>reopened.close());reopened.usage('task-a',counters(1000,600,100),at()+20);assert.equal(reopened.details(a,{range:'all'}).summary.requests,1);reopened.usage('task-a',counters(2000,1200,200),at()+30);assert.equal(reopened.details(a,{range:'all'}).summary.requests,2);
});
test('old history is only a baseline; unknown model stays unpriced instead of zero dollars',async t=>{
 const {ledger,at}=await fixture(t);ledger.bind('old',a,'pa','gpt-unverified');ledger.usage('old',counters(900000,500000,50000),at());assert.equal(ledger.details(a,{range:'all'}).summary.requests,0);
 ledger.usage('old',counters(901000,500600,50100),at()+10);const d=ledger.details(a,{range:'all'});assert.equal(d.summary.unpriced,1);assert.equal((d.rows[0] as any).cost,null);assert.equal(d.summary.input,1000);assert.equal(ledger.overview(a).subscriptionPercent,null);
});
test('five-week accounting uses matching observation periods, independent user costs, resets, and shared cached snapshots',async t=>{
 const {ledger,at,tick}=await fixture(t);sample(ledger,at(),40);ledger.bind('a',a,'pa',price.model,'Codex',true);ledger.bind('b',b,'pb',price.model,'Codex',true);
 tick(1000);ledger.usage('a',counters(1000000),at());ledger.usage('b',counters(3000000),at());tick(300000);sample(ledger,at(),60);
 const x=ledger.overview(a),y=ledger.overview(b);assert.equal(x.weekUsd,40);assert.equal(x.weeklyPercent,5);assert.equal(y.weeklyPercent,15);assert.equal(x.subscriptionPercent,1);assert.equal(x.cycleUsd,200);
 tick(1000);ledger.usage('a',counters(2000000),at());assert.strictEqual(ledger.overview(a),x);
 tick(300000);sample(ledger,at(),10,2000100000);const z=ledger.overview(a);assert.equal(z.quotaGap,true);assert.ok(Number.isFinite(z.subscriptionPercent));assert.equal(z.weeksPerCycle,5);
});
test('ambiguous buckets, zero denominator and missing prices never produce infinity or fake subscription percentages',async t=>{
 const {ledger,at,tick}=await fixture(t);sample(ledger,at(),10);ledger.bind('a',a,'pa','not-priced','Codex',true);tick(1);ledger.usage('a',counters(1000),at());tick(300000);sample(ledger,at(),20);assert.equal(ledger.overview(a).weekUsd,null);
 ledger.sample(normalizeRateLimits({rateLimitsByLimitId:{a:{secondary:{usedPercent:2,windowDurationMins:10080}},b:{secondary:{usedPercent:2,windowDurationMins:10080}}}},at()+1));tick(300000);assert.equal(ledger.overview(a).quotaUnavailable,'multiple-weekly-buckets');
});
test('metrics count real usage steps, one observed turn and overlapping tool intervals once',async t=>{
 const {ledger,at,tick}=await fixture(t);ledger.bind('a',a,'pa',price.model,'Codex',true);ledger.observe('a','turn/started',{turn:{id:'turn'}},at());tick(100);ledger.observe('a','item/agentMessage/delta',{delta:'x'},at());
 tick(100);ledger.observe('a','item/started',{item:{id:'tool-a',type:'commandExecution'}},at());tick(100);ledger.observe('a','item/started',{item:{id:'tool-b',type:'mcpToolCall'}},at());tick(100);ledger.observe('a','item/completed',{item:{id:'tool-a',type:'commandExecution'}},at());tick(100);ledger.observe('a','item/completed',{item:{id:'tool-b',type:'mcpToolCall'}},at());
 ledger.usage('a',counters(1000,500,100),at());tick(500);ledger.observe('a','turn/completed',{turn:{id:'turn',status:'completed'}},at());const m=ledger.metrics(a,'a');assert.equal(m.rounds,1);assert.equal(m.steps,1);assert.equal(m.toolMs,300);assert.equal(m.llmMs,700);assert.equal(m.ttftMs,100);assert.equal(m.cacheHitPercent,50);assert.throws(()=>ledger.metrics(b,'a'));
});
test('request pagination and model/provider grouping remain confined to the signed-in account',async t=>{
 const {ledger,at,tick}=await fixture(t);ledger.bind('a',a,'pa',price.model,'a-provider',true);ledger.bind('b',b,'pb',price.model,'b-secret-provider',true);
 for(let i=1;i<=55;i++){tick(1);ledger.usage('a',counters(i*100),at());}ledger.usage('b',counters(999999),at());
 const d=ledger.details(a,{range:'all'});assert.equal(d.rows.length,50);assert.ok(d.next);assert.equal(ledger.details(a,{range:'all',before:d.next!}).rows.length,5);assert.equal(d.summary.requests,55);assert.equal(d.providers.length,1);assert.ok(!JSON.stringify(d).includes('b-secret-provider'));assert.equal(ledger.details(a,{range:'all',provider:'b-secret-provider'}).rows.length,0);
});

test('verified Codex defaults use Sol list price, separate input/output long-context multipliers, and Astra exemption',async t=>{
 const {defaultCodexPrices}=await import('../src/backend/pricing');const prices=defaultCodexPrices(),sol=prices.find(p=>p.model==='gpt-5.6-sol')!,luna=prices.find(p=>p.model==='gpt-5.6-luna')!,astra=prices.find(p=>p.model==='gpt-6-astra')!;
 assert.deepEqual([sol.input,sol.cachedInput,sol.output],[5,.5,30]);assert.equal(sol.longContext?.input,10);assert.equal(sol.longContext?.output,45);assert.equal(luna.longContext?.cachedInput,.04);assert.equal(astra.longContext,undefined);assert.equal(prices.find(p=>p.model==='gpt-5.4')!.fastMultiplier,2);
 const tkn={input:300000,cached:100000,output:10000};assert.equal(calculateCost(tkn,sol),2.55);assert.equal(calculateCost(tkn,sol,272000),1.35);assert.equal(calculateCost(tkn,sol,300000,'fast'),6.375);assert.equal(calculateCost(tkn,astra),2.6);assert.equal(prices.find(p=>p.model==='gpt-5.3-codex-spark'),undefined);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webui-price-defaults-')),db=new UsageLedger(path.join(dir,'usage.sqlite'));t.after(()=>db.close());assert.equal(db.settings(admin).prices.find(p=>p.model===sol.model)?.input,5);
});

test('minor reset timestamp drift does not count the already-used percentage again',async t=>{
 const {ledger,at,tick}=await fixture(t);const reset=Math.floor(at()/1000)+604800;sample(ledger,at(),20,reset);ledger.bind('a',a,'pa',price.model,'Codex',true);tick(1000);ledger.usage('a',counters(1000000),at());tick(300000);sample(ledger,at(),22,reset+1);const stats=ledger.overview(a);assert.equal(stats.weeklyPercent,2);assert.equal(stats.subscriptionPercent,.4);assert.equal(stats.weekUsd,100);
});
