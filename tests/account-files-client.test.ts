import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const source=readFileSync(path.join(__dirname,'../public/account-files.js'),'utf8');
function fixture(){const nodes=new Map<string,any>(),S:any={user:{id:'a'},authRevision:1,epoch:1,references:[],panel:'quota'};const c:any={q:(value:any)=>new URLSearchParams(value).toString(),S,location:{origin:'https://example.test'},$: (id:string)=>{if(!nodes.has(id))nodes.set(id,{value:id==='file-scope'?'account-storage':'',replaceChildren(){}});return nodes.get(id);},action:(f:any)=>f,renderAttachments(){},toast(){},CodexFeatures:{upload:async(file:any,projectId:string,epoch:number,folder:string)=>({path:folder==='.'?file.name:folder+'/'+file.name})}};vm.runInNewContext(source,c);return {c,S,nodes,api:c.CodexAccountFiles};}
test('account upload preserves original filename and references account path without project attachment',async()=>{const f=fixture(),files=await f.api.upload([{name:'原始资料.txt',size:12}],{path:'一级/二级',attachToComposer:true});assert.equal(files[0].projectId,'account-storage');assert.equal(files[0].path,'一级/二级/原始资料.txt');assert.equal(f.S.references[0],'@account/一级/二级/原始资料.txt');});
test('late upload cannot attach into a different authenticated scope',async()=>{const f=fixture();f.c.CodexFeatures.upload=async()=>{f.S.authRevision++;return{path:'a.txt'};};await assert.rejects(f.api.upload([{name:'a.txt',size:1}],{attachToComposer:true}),/切换/);assert.equal(f.S.references.length,0);});
test('logged out account cannot read or reference server storage',async()=>{const f=fixture();f.S.user=null;assert.throws(()=>f.api.reference({path:'secret'}),/登录/);await assert.rejects(f.api.refresh(),/登录/);});

test("explicit library open resets the previous project scope",async()=>{const f=fixture();f.nodes.set("file-scope",{value:"project"});f.c.document={querySelectorAll:()=>[]};f.c.$("inspector").classList={add(){}};f.c.api=async()=>({entries:[]});f.c.el=()=>({});f.c.$("file-list").append=()=>{};await f.api.open();assert.equal(f.c.$("file-scope").value,"account-storage");assert.equal(f.c.$("account-file-tools").hidden,false);});
