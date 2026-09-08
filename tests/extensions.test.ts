import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readCatalog,publicCatalog,resolveExtensions,accessPolicy,readMcp } from '../src/backend/extensions';
import { projectReference } from '../src/backend/files';
import { normalizeRateLimits } from '../src/backend/limits';

test('catalog scopes skills to the authorized cwd; installed plugin mentions use server-owned IDs',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'webui-extensions-'));const other=await mkdtemp(path.join(os.tmpdir(),'webui-other-'));
  const rpc=async(method:string,params:any)=>{
    assert.deepEqual(params.cwds,[root]);
    if(method==='skills/list')return {data:[{cwd:root,errors:[],skills:[{name:'review',path:path.join(root,'SKILL.md'),scope:'repo',enabled:true,description:'Review'},{name:'disabled',path:path.join(root,'disabled.md'),enabled:false}]},{cwd:other,skills:[{name:'private',path:path.join(other,'SKILL.md'),enabled:true}]}]};
    if(method==='plugin/installed')return {marketplaces:[{name:'local',plugins:[{id:'docs@local',name:'docs',installed:true,enabled:true,interface:{displayName:'Documents'}},{id:'not-installed',name:'other',installed:false,enabled:true}]}]};
    throw new Error('unexpected');
  };
  const catalog=await readCatalog(rpc,root);
  assert.equal(catalog.entries.length,3);assert.ok(!catalog.entries.some(e=>e.name==='private'));
  const exposed=publicCatalog(catalog);assert.equal(JSON.stringify(exposed).includes('SKILL.md'),false);
  const skill=catalog.entries.find(e=>e.name==='review')!,plugin=catalog.entries.find(e=>e.kind==='plugin')!;
  assert.deepEqual(resolveExtensions(catalog,[skill.id,plugin.id]),[{type:'skill',name:'review',path:path.join(root,'SKILL.md')},{type:'mention',name:'Documents',path:'plugin://docs@local'}]);
  assert.throws(()=>resolveExtensions(catalog,['/etc/passwd']));assert.throws(()=>resolveExtensions(catalog,['a'.repeat(32)]));
  assert.throws(()=>resolveExtensions(catalog,[catalog.entries.find(e=>e.name==='disabled')!.id]));
  const down=await readCatalog(async()=>{throw new Error('auth secret');},root);
  assert.equal(down.pluginsAvailable,false);assert.equal(down.skillsAvailable,false);assert.ok(!JSON.stringify(down).includes('auth secret'));
});
test('access modes translate to actual sandbox policy and full access cannot bypass admin + confirmation',()=>{
  const user={uuid:'user',elevated:false},admin={uuid:'admin',elevated:true};
  assert.deepEqual(accessPolicy(user,'/project','read-only',false),{approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});
  const normal=accessPolicy(user,'/project','default',false);assert.equal(normal.sandboxPolicy.networkAccess,false);
  assert.throws(()=>accessPolicy(user,'/project','full',true));assert.throws(()=>accessPolicy(admin,'/project','full',false));
  assert.deepEqual(accessPolicy(admin,'/project','full',true),{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
  assert.throws(()=>accessPolicy(admin,'/project','danger-arbitrary',true));
});
test('references remain inside project; MCP status strips configs, credentials and tool descriptions',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'webui-ref-'));await mkdir(path.join(root,'folder'));
  assert.equal(await projectReference(root,'folder'),'folder');await assert.rejects(projectReference(root,'../escape'));await assert.rejects(projectReference(root,'.codex/auth.json'));
  const result=await readMcp(async(_method,params)=>{assert.equal(params.detail,'toolsAndAuthOnly');return {data:[{name:'server',authStatus:'notLoggedIn',runtimeStatus:'connected',tools:{safe:{description:'secret'}},env:{token:'secret'},resources:[{uri:'secret'}]}]};});
  assert.deepEqual(result.data[0].tools,['safe']);assert.ok(!JSON.stringify(result).includes('secret'));
});
test('quota by-id snapshot supersedes its legacy mirror, preserves week and does not relabel 30 days',()=>{
  const primary={usedPercent:0,windowDurationMins:43200,resetsAt:1900000000};
  const result=normalizeRateLimits({rateLimits:{primary},rateLimitsByLimitId:{codex:{primary}},rateLimitResetCredits:{availableCount:1,details:[{id:'x',status:'available',expiresAt:1900000000}]}});
  assert.equal(result.windows.length,1);assert.equal(result.windows[0].windowDurationMins,43200);
  const week=normalizeRateLimits({rateLimitsByLimitId:{codex:{secondary:{...primary,windowDurationMins:10080}}}});assert.equal(week.windows[0].windowDurationMins,10080);
});
