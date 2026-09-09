import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context:any={module:{exports:{}}};vm.runInNewContext(fs.readFileSync('public/state.js','utf8'),context);const state=context.module.exports;
test('context window uses latest context, not cumulative billed tokens; compaction updates immediately',()=>{
 let info=state.contextWindow({total:900000,last:25000,contextWindow:100000});assert.equal(info.used,25000);assert.equal(info.percent,25);assert.equal(info.remaining,75000);
 info=state.contextWindow({total:1000000,last:5000,contextWindow:100000});assert.equal(info.percent,5);
 assert.equal(state.contextWindow({last:0,contextWindow:100000}).percent,0);assert.equal(state.contextWindow({last:110000,contextWindow:100000}).remaining,0);
});
test('context missing, malformed and invalid capacity never invent a window or percentage',()=>{
 for(const usage of [null,{}, {last:null,contextWindow:100},{last:10},{last:10,contextWindow:0},{last:-1,contextWindow:100},{last:Infinity,contextWindow:100},{last:1.5,contextWindow:100},{last:'10',contextWindow:100}])assert.equal(state.contextWindow(usage).percent,null);
});
test('context status event updates remain account/conversation local and explicit missing data replaces stale values',()=>{
 const s={items:new Map(),pending:new Map(),status:'idle',tokenUsage:{last:90,contextWindow:100}};
 state.applyEvent(s,{type:'status',payload:{tokenUsage:{total:1000,last:25,contextWindow:100}}});assert.equal(state.contextWindow(s.tokenUsage).percent,25);
 state.applyEvent(s,{type:'status',payload:{tokenUsage:{total:null,last:null}}});assert.equal(state.contextWindow(s.tokenUsage).percent,null);
});
