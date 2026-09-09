import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {normalizeTokenUsage,restoredTokenUsage} from '../src/backend/context';
import {desktopUsage} from '../src/backend/desktop-settings';
const record=(n:number)=>JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:900000},last_token_usage:{total_tokens:n},model_context_window:100000}}});
test('context normalization accepts real API, desktop and rollout variants; absent never means zero',()=>{
 const expected={total:900000,last:25000,contextWindow:100000};
 for(const info of [expected,{total:{totalTokens:900000},last:{totalTokens:25000},modelContextWindow:100000},{total_token_usage:{total_tokens:900000},last_token_usage:{total_tokens:25000},model_context_window:100000}])assert.deepEqual(normalizeTokenUsage(info),expected);
 assert.equal(desktopUsage({latestTokenUsageInfo:{total:{totalTokens:200},modelContextWindow:100000}})?.last,null);
 assert.equal(normalizeTokenUsage({last:{totalTokens:0},modelContextWindow:100000})?.last,0);
 for(const v of [undefined,{}, {last:-1},{last:Infinity},{last:'200'},{last:{totalTokens:NaN}}])assert.equal(normalizeTokenUsage(v),null);
});
test('existing thread recovers latest completed token_count without emitting any model request',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'webui-context-'));await mkdir(path.join(home,'sessions'));const file=path.join(home,'sessions','thread.jsonl');
 await writeFile(file,record(10000)+'\n'+JSON.stringify({type:'response_item',payload:{text:'PRIVATE TRANSCRIPT'}})+'\n'+record(25000)+'\n'+record(50000).slice(0,35));
 const result=await restoredTokenUsage({path:file},home);assert.equal(result?.last,25000);assert.equal(result?.contextWindow,100000);assert.equal(result?.source,'rollout');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});
test('rollout recovery is bounded, rejects paths outside session stores, and respects authoritative supplied context',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'webui-context-'));await mkdir(path.join(home,'sessions'));const file=path.join(home,'sessions','large.jsonl');await writeFile(file,'中'.repeat(300000)+'\n'+record(7000)+'\n');
 assert.equal((await restoredTokenUsage({path:file},home))?.last,7000);
 const unrelated=path.join(home,'auth.jsonl');await writeFile(unrelated,record(99000));assert.equal(await restoredTokenUsage({path:unrelated},home),null);
 assert.equal(await restoredTokenUsage({path:file+'.missing'},home),null);
 assert.equal((await restoredTokenUsage({path:file,tokenUsage:{last:0,contextWindow:100000}},home))?.last,0);
});
