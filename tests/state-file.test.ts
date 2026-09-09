import test from 'node:test';
import assert from 'node:assert/strict';
import {renameStateFile} from '../src/backend/state-file';
test('Windows transient replacement failures retry the rename only, then succeed',async()=>{
 for(const code of ['EPERM','EACCES','EBUSY']){let calls=0;const waits:number[]=[];await renameStateFile('source','target',{platform:'win32',rename:async(a,b)=>{assert.equal(a,'source');assert.equal(b,'target');if(++calls<3)throw Object.assign(new Error('busy'),{code});},wait:async ms=>{waits.push(ms);}});assert.equal(calls,3);assert.deepEqual(waits,[15,30]);}
});
test('non-Windows and non-transient errors are never retried',async()=>{
 for(const [platform,code]of [['linux','EPERM'],['win32','ENOENT']] as const){let calls=0;await assert.rejects(renameStateFile('a','b',{platform,rename:async()=>{calls++;throw Object.assign(new Error('failure'),{code});},wait:async()=>assert.fail('must not wait')}),{code});assert.equal(calls,1);}
});
test('persistent Windows replacement failures remain bounded and surface the original error',async()=>{
 let calls=0;const waits:number[]=[];const error=Object.assign(new Error('locked'),{code:'EPERM'});await assert.rejects(renameStateFile('a','b',{platform:'win32',rename:async()=>{calls++;throw error;},wait:async ms=>{waits.push(ms);}}),e=>e===error);assert.equal(calls,6);assert.equal(waits.reduce((a,b)=>a+b,0),465);
});
test('successful replacement does not wait or repeat',async()=>{let calls=0;await renameStateFile('a','b',{platform:'win32',rename:async()=>{calls++;},wait:async()=>assert.fail('must not wait')});assert.equal(calls,1);});
