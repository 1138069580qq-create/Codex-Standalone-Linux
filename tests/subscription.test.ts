import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {normalizeSubscription,unavailableSubscription} from '../src/backend/subscription';
import {UsageLedger} from '../src/backend/usage';
import {CodexConsoleService} from '../src/backend/service';
import {ConfigStore} from '../src/backend/config';
import {CommandReceipts} from '../src/backend/receipts';
const now=Date.UTC(2026,8,9),start=Date.UTC(2026,8,1),end=Date.UTC(2026,9,1),who={uuid:'admin',elevated:true};
const account=(period:any)=>({account:{type:'chatgpt',planType:'pro',email:'private@example.test',subscription:period}});
test('explicit current subscription periods accept seconds, milliseconds and timezone-qualified ISO only',()=>{
 for(const p of [{currentPeriodStart:start,currentPeriodEnd:end},{current_period_start:start/1000,current_period_end:end/1000},{currentPeriodStart:'2026-09-01T08:00:00+08:00',currentPeriodEnd:'2026-10-01T00:00:00Z'}]){const s=normalizeSubscription(account(p),now);assert.equal(s.status,'active');assert.equal(s.start,start);assert.equal(s.end,end);assert.ok(s.accountKey);assert.ok(!JSON.stringify(s).includes('private@example'));}
 assert.equal(normalizeSubscription(account({currentPeriodStart:start,currentPeriodEnd:end}),end).status,'expired');
});
test('no guessed cycle from plan name, weekly resets, token expiry, renewal date or absent account',()=>{
 assert.equal(normalizeSubscription({account:null,requiresOpenaiAuth:false},now).reason,'account-not-provided');
 assert.equal(normalizeSubscription({account:{type:'chatgpt',planType:'pro',expiresAt:end,renewsAt:end},rateLimits:{secondary:{resetsAt:end}}},now).start,null);
 assert.equal(normalizeSubscription({account:{type:'apiKey',subscription:{currentPeriodStart:start,currentPeriodEnd:end}}},now).reason,'not-subscription');
 for(const p of [{currentPeriodStart:start},{currentPeriodEnd:end},{currentPeriodStart:end,currentPeriodEnd:start},{currentPeriodStart:now+1,currentPeriodEnd:end},{currentPeriodStart:'2026-09-01',currentPeriodEnd:'2026-10-01'},{currentPeriodStart:start,current_period_end:end},{currentPeriodStart:NaN,currentPeriodEnd:end},{currentPeriodStart:'2026-02-30T00:00:00Z',currentPeriodEnd:'2026-10-01T00:00:00Z'},{currentPeriodStart:'2026-09-01T24:00:00Z',currentPeriodEnd:'2026-10-01T00:00:00Z'}])assert.equal(normalizeSubscription(account(p),now).status,'unavailable');
});
test('automatic subscription changes the accounting interval without deleting records or accepting manual dates',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'webui-subscription-'));let clock=now;const ledger=new UsageLedger(path.join(root,'usage.sqlite'),()=>clock);t.after(()=>ledger.close());
 assert.equal(ledger.overview(who).cycle.configured,false);ledger.syncSubscription(normalizeSubscription(account({currentPeriodStart:start,currentPeriodEnd:end}),clock));assert.equal(ledger.overview(who).cycle.start,start);assert.equal(ledger.overview(who).weeksPerCycle,5);
 ledger.bind('t',who,'project','gpt-5.6-luna',undefined,true);ledger.usage('t',{inputTokens:1000,cachedInputTokens:0,outputTokens:100});const cost=ledger.details(who,{range:'all'}).summary.cost;
 assert.throws(()=>ledger.configure(who,{prices:[],cycle:{start:0,end:null}}),/自动/);ledger.configure(who,{prices:ledger.settings(who).prices});assert.equal(ledger.settings(who).cycle.start,start);
 clock=end+100;assert.equal(ledger.overview(who).subscriptionPercent,null);assert.equal(ledger.overview(who).cycle.status,'expired');
 ledger.syncSubscription(normalizeSubscription(account({currentPeriodStart:end,currentPeriodEnd:Date.UTC(2026,10,1)}),clock));assert.equal(ledger.overview(who).cycle.start,end);assert.equal(ledger.overview(who).cycleUsage.cost,0);assert.equal(ledger.overview(who).total.cost,cost);
 ledger.syncSubscription(unavailableSubscription('read-failed',clock));assert.equal(ledger.overview(who).cycle.configured,false);assert.equal(ledger.overview(who).subscriptionPercent,null);assert.ok(!JSON.stringify(ledger.settings(who)).includes('private@example'));
});
test('one shared 30-minute account lookup, no token refresh and cached missing metadata',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webui-account-cache-'));let calls=0,fail=false;const config=new ConfigStore(path.join(dir,'config.json'));
 class Service extends CodexConsoleService {protected override async readAccountMetadata(){calls++;if(fail)throw new Error('do not expose private upstream errors');return {account:null};}}
 const service=new Service(config,new CommandReceipts(path.join(dir,'receipts.json')));t.after(()=>service.disconnect());
 const results=await Promise.all([service.subscription(who),service.subscription({uuid:'user2',elevated:false}),service.subscription(who)]);assert.equal(calls,1);assert.ok(results.every(r=>r.reason==='account-not-provided'));await assert.rejects(service.subscription({uuid:'',elevated:false}));
 service.disconnect();fail=true;assert.equal((await service.subscription(who)).reason,'read-failed');assert.equal(calls,2);await service.subscription(who);assert.equal(calls,2);
});
test('manual v1.4 cycle migration disables guessed dates while preserving usage and pricing',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'webui-auto-cycle-migration-')),file=path.join(root,'usage.sqlite'),old=new UsageLedger(file,()=>now);old.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify({start,end,configured:true}),'cycle');old.close();const db=new UsageLedger(file,()=>now);t.after(()=>db.close());assert.equal(db.settings(who).cycle.configured,false);assert.equal(db.settings(who).cycle.source,'account/read');assert.ok(db.settings(who).prices.length>0);
});
