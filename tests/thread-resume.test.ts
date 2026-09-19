import {taskConfig,TASK_EFFICIENCY_INSTRUCTIONS} from '../src/backend/task-instructions';
import test from 'node:test';import assert from 'node:assert/strict';import {resumeThread,reconfigureThreadTools} from '../src/backend/thread-resume';
test('empty rollout fallback changes only history mode and preserves account isolation and MCP overrides',async()=>{const calls:any[]=[];const params={threadId:'new',excludeTurns:true,approvalPolicy:'never',config:{default_permissions:'account-a','mcp_servers.local_files':{url:'http://127.0.0.1:3211/api/local-tools/mcp'}}};const result=await resumeThread(async(method,p)=>{calls.push({method,p});if(calls.length===1)throw Object.assign(new Error('invalid paginated history lineage for new: missing source rollout'),{code:-32600});return{ok:true};},params);assert.equal(result.ok,true);assert.equal(calls.length,2);assert.deepEqual(calls[1],{method:'thread/resume',p:{...params,excludeTurns:false,config:taskConfig(params.config)}});assert.equal(params.excludeTurns,true);});
test('other rejections and timeouts are never replayed',async()=>{for(const error of [Object.assign(Error('permission denied'),{code:-32600}),Error('timeout')]){let calls=0;await assert.rejects(resumeThread(async()=>{calls++;throw error;},{threadId:'t',excludeTurns:true}));assert.equal(calls,1);}});

test('task MCP reload releases the subscription and confirms actual tools',async()=>{
 const calls:string[]=[];const params={threadId:'t',config:{'mcp_servers.local_device_files':{enabled_tools:['local_pdf_ocr']}}};
 const rpc=async(m:string,p:any)=>{calls.push(m);if(m==='thread/turns/list')return {data:[{id:'turn'}]};if(m==='thread/resume'){assert.deepEqual(p,{...params,config:taskConfig(params.config)});return {ok:true};}return m==='mcpServerStatus/list'?{data:[{name:'local_device_files',tools:{local_pdf_ocr:{}}}]}:{};};
 assert.deepEqual(await reconfigureThreadTools(rpc,params),{ok:true});assert.deepEqual(calls,['thread/turns/list','thread/unsubscribe','thread/resume','mcpServerStatus/list']);
 await assert.rejects(()=>reconfigureThreadTools(async m=>m==='thread/turns/list'?{data:[{id:'turn'}]}:m==='mcpServerStatus/list'?{data:[{name:'local_files',tools:{}}]}:{},params),{code:'LOCAL_MCP_NOT_LOADED'});
});

test('session task policy is stable, additive and preserves caller settings',()=>{const input={developer_instructions:'Preserve custom project rules.',model:'chosen'};const once=taskConfig(input);assert.ok(once.developer_instructions.startsWith(input.developer_instructions));assert.equal(once.model,'chosen');assert.deepEqual(taskConfig(once),once);assert.equal(once.developer_instructions.split(TASK_EFFICIENCY_INSTRUCTIONS).length,2);assert.equal(input.developer_instructions,'Preserve custom project rules.');});

test('pairing never unloads an empty unsaved conversation',async()=>{
 for(const outcome of [{data:[]},Object.assign(new Error('invalid paginated history lineage: missing source rollout'),{code:-32600})]){
  const calls:string[]=[];await assert.rejects(reconfigureThreadTools(async m=>{calls.push(m);if(outcome instanceof Error)throw outcome;return outcome;},{threadId:'empty'}),{code:'LOCAL_PAIR_ON_CREATE_REQUIRED'});
  assert.deepEqual(calls,['thread/turns/list']);
 }
});
