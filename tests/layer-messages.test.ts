import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync('public/app.js','utf8');
function fixture(){
 const nodes:any={};const make=(id='')=>({id,open:false,hidden:true,textContent:'',dataset:{},children:[] as any[],listeners:{} as any,scrolls:0,querySelector(selector:string){return selector==='[data-layer-message]'?this.children.find((n:any)=>n.dataset.layerMessage):null;},prepend(n:any){this.children.unshift(n);},setAttribute(k:string,v:string){(this as any)[k]=v;},scrollIntoView(){this.scrolls++;},addEventListener(k:string,fn:any){this.listeners[k]=fn;},showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();}});
 for(const id of ['notice','toast','login-form','login-error','parent','child','unrelated'])nodes[id]=make(id);const dialogs=[nodes.child,nodes.unrelated,nodes.parent];
 const context:any=vm.createContext({console,setTimeout,clearTimeout,S:{user:{id:'user'}},document:{querySelectorAll:()=>dialogs},$: (id:string)=>nodes[id],el:()=>make(),controls:()=>{}});
 vm.runInContext(source.slice(source.indexOf('let toastTimer;'),source.indexOf('async function api(')),context);return {nodes,context,run:(s:string)=>vm.runInContext(s,context)};
}
test('errors follow actual modal opening order instead of document order or homepage',()=>{
 const f=fixture();f.nodes.parent.showModal();f.nodes.child.showModal();f.run("toast('child failure',true)");assert.equal(f.nodes.child.children[0].textContent,'child failure');assert.equal(f.nodes.notice.textContent,'');assert.equal(f.nodes.toast.hidden,true);f.nodes.child.close();f.run("toast('parent failure',true)");assert.equal(f.nodes.parent.children[0].textContent,'parent failure');f.nodes.parent.close();f.run("toast('page failure',true)");assert.equal(f.nodes.notice.textContent,'page failure');
});
test('async errors stay with their initiating dialog rather than an unrelated newer dialog',async()=>{
 const f=fixture();f.nodes.parent.showModal();f.context.target={tagName:'BUTTON',disabled:false,closest:()=>f.nodes.parent};let reject!:(e:any)=>void;f.context.work=new Promise((_,r)=>reject=r);const p=f.run("action(async()=>await work)({currentTarget:target,preventDefault(){}})");f.nodes.unrelated.showModal();reject(Error('source failure'));await p;assert.equal(f.nodes.parent.children[0].textContent,'source failure');assert.equal(f.nodes.unrelated.children.length,0);assert.equal(f.context.target.disabled,false);
});
test('closing and reopening a modal clears stale errors; login failures stay on login',()=>{
 const f=fixture();f.nodes.parent.showModal();f.run("toast('old',true)");f.nodes.parent.close();f.nodes.parent.showModal();assert.equal(f.nodes.parent.children[0].hidden,true);f.nodes.parent.close();f.context.S.user=null;f.run("toast('login failure',true)");assert.equal(f.nodes['login-error'].textContent,'login failure');assert.equal(f.nodes.notice.textContent,'');
});
test('background homepage notices never surface in an unrelated modal',()=>{
 const f=fixture();f.nodes.child.showModal();f.run("notice('connection lost')");assert.equal(f.nodes.notice.textContent,'connection lost');assert.equal(f.nodes.child.children.length,0);
});

const usage=readFileSync('public/usage.js','utf8');
function recordFixture(){
 const dialog={open:false,showModal(){this.open=true;}},content={children:[] as any[],replaceChildren(...nodes:any[]){this.children=nodes;},append(...nodes:any[]){this.children.push(...nodes);}},messages:any[]=[],pending:any[]=[];
 const context:any=vm.createContext({S:{user:{id:'alice'}},U:{recordSequence:0},$: (id:string)=>id==='usage-record-dialog'?dialog:content,api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),el:(tag:string,text:string)=>({tag,text}),metric:(label:string,value:any)=>({label,value}),number:String,date:String,money:String,layerMessage:(message:string,_bad:boolean,layer:any)=>messages.push({message,layer})});
 vm.runInContext(usage.slice(usage.indexOf('  async function record(id){'),usage.indexOf("  $('close-usage').onclick")),context);return {dialog,content,messages,pending,context,run:(id:number)=>vm.runInContext('record('+id+')',context)};
}
test('record layer opens before fetching; failures are visible inside the child layer',async()=>{
 const f=recordFixture(),p=f.run(1);assert.equal(f.dialog.open,true);f.pending[0].reject(Error('record unavailable'));await p;assert.equal(f.messages[0].layer,f.dialog);assert.equal(f.messages[0].message,'record unavailable');
});
test('closed or logged-out record requests cannot reopen or leak stale content',async()=>{
 const f=recordFixture(),p=f.run(1);f.dialog.open=false;f.pending[0].reject(Error('late failure'));await p;assert.equal(f.messages.length,0);assert.equal(f.dialog.open,false);const p2=f.run(2);f.context.S.user={id:'bob'};f.pending[1].resolve({model:'alice-private'});await p2;assert.ok(!JSON.stringify(f.content.children).includes('alice-private'));
});
test('only the newest record request can render into a reopened detail layer',async()=>{
 const f=recordFixture(),old=f.run(1),latest=f.run(2);f.pending[1].resolve({model:'newest',at:1,input:2,cached:1,output:1,cost:1});await latest;f.pending[0].resolve({model:'old-private'});await old;assert.match(JSON.stringify(f.content.children),/newest/);assert.doesNotMatch(JSON.stringify(f.content.children),/old-private/);
});
