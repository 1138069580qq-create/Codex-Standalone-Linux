import test from 'node:test';
import assert from 'node:assert/strict';
import {MainTurnGate, MAIN_TURN_LIMIT, readMainThreads} from '../src/backend/concurrency';
const full = (e:any) => e.code === 'CONCURRENCY_LIMIT' && e.message === '并行满了请稍后再试';

test('five pending main sends across accounts; sixth can retry after a rejected reservation',async()=>{
  const gate=new MainTurnGate(async()=>[]);const slots=await Promise.all(Array.from({length:5},(_,i)=>gate.acquire('user-'+i)));
  assert.equal(gate.count,MAIN_TURN_LIMIT);await assert.rejects(gate.acquire('sixth'),full);
  slots[0].finish('rejected');const sixth=await gate.acquire('sixth');assert.equal(gate.count,5);sixth.finish('rejected');slots.slice(1).forEach(s=>s.finish('rejected'));assert.equal(gate.count,0);
});
test('simultaneous admissions coalesce reads but never oversubscribe',async()=>{
  let reads=0;const gate=new MainTurnGate(async()=>{reads++;await new Promise(r=>setTimeout(r,10));return [];});
  const result=await Promise.allSettled(Array.from({length:18},()=>gate.acquire()));assert.equal(result.filter(r=>r.status==='fulfilled').length,5);assert.equal(reads,1);assert.equal(gate.count,5);
});
test('existing desktop main work counts globally, not nested agent threads',async()=>{
  const rows=[...Array.from({length:4},(_,i)=>({id:'desktop-'+i,status:{type:'active'},source:'vscode'})),...Array.from({length:40},(_,i)=>({id:'agent-'+i,status:'inProgress',source:{subAgent:{thread_spawn:{parent_thread_id:'desktop-0'}}}}))];
  const gate=new MainTurnGate(async()=>rows);const slot=await gate.acquire('web');assert.equal(gate.count,5);await assert.rejects(gate.acquire('other'),full);slot.finish('rejected');
});
test('completion before start acknowledgement never resurrects a finished turn',async()=>{
  const gate=new MainTurnGate(async()=>[]),slot=await gate.acquire('fast');slot.submit();gate.observe('fast','running','turn');gate.observe('fast','completed','turn');slot.finish('running','turn');assert.equal(gate.count,0);
});
test('a different turn completion cannot release a newly accepted turn',async()=>{
  const gate=new MainTurnGate(async()=>[]),slot=await gate.acquire('fast');slot.submit();gate.observe('fast','completed','old');slot.finish('running','new');assert.equal(gate.count,1);gate.observe('fast','completed','new');assert.equal(gate.count,0);
});
test('unknown submitted outcomes hold a slot; definitive server idle later reconciles it',async()=>{
  let now=10000;const gate=new MainTurnGate(async()=>[],()=>now),slot=await gate.acquire('uncertain');slot.submit();slot.finish('unknown');assert.equal(gate.count,1);now+=3000;const other=await gate.acquire('other');assert.equal(gate.count,1);other.finish('rejected');assert.equal(gate.count,0);
});
test('unknown creation with no thread ID conservatively retains its pending slot',async()=>{
  const gate=new MainTurnGate(async()=>[]),slot=await gate.acquire();slot.submit();slot.finish('unknown');assert.equal(gate.count,1);slot.finish('rejected');assert.equal(gate.count,1);
});
test('duplicate thread sends are busy; binding a new task never double-counts it',async()=>{
  const gate=new MainTurnGate(async()=>[]),slot=await gate.acquire();slot.bind('created');slot.submit();gate.observe('created','running','t');assert.equal(gate.count,1);await assert.rejects(gate.acquire('created'),(e:any)=>e.code==='THREAD_BUSY');slot.finish('running','t');assert.equal(gate.count,1);
});
test('complete backend snapshots paginate; malformed or cyclic lists fail closed',async()=>{
  const seen:any[]=[];const rows=await readMainThreads(async p=>{seen.push(p);return p.cursor?{data:[{id:'second',status:'running'}]}:{data:[{id:'first',status:'running'}],nextCursor:'next'};});assert.equal(rows.length,2);assert.equal(seen[1].cursor,'next');
  await assert.rejects(readMainThreads(async()=>({data:[],nextCursor:'repeat'})),(e:any)=>e.code==='CONCURRENCY_UNAVAILABLE');await assert.rejects(readMainThreads(async()=>({})));let attempts=0;const gate=new MainTurnGate(async()=>{if(++attempts===1)throw Error('offline');return [];});await assert.rejects(gate.acquire());const slot=await gate.acquire();assert.equal(gate.count,1);slot.finish('rejected');
});
test('an in-flight stale list cannot overwrite a newer completion notification',async()=>{
  let resolve!:(v:any[])=>void;const gate=new MainTurnGate(()=>new Promise(r=>resolve=r));const pending=gate.acquire('new');gate.observe('old','completed','t');resolve([{id:'old',status:'running'}]);const slot=await pending;assert.equal(gate.count,1);slot.finish('rejected');
});

test('late completion of a prior turn cannot release the current running slot',async()=>{
 const gate=new MainTurnGate(async()=>[]),slot=await gate.acquire('thread');slot.submit();slot.finish('running','new');gate.observe('thread','completed','old');assert.equal(gate.count,1);gate.observe('thread','completed','new');assert.equal(gate.count,0);
});

test('fresh administrative activity checks release completed external tasks without requiring another send',async()=>{
 let rows:any[]=[{id:'external',status:'running'}],now=10000;const gate=new MainTurnGate(async()=>rows,()=>now);await gate.synchronize();assert.equal(gate.count,1);rows=[];now+=3000;await gate.synchronize();assert.equal(gate.count,0);
});
