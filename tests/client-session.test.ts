import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const source=readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function setup(){let resolve!:(r:any)=>void,logouts=0;const S:any={epoch:1,user:{id:'first'}};const c:any={S,AbortController,setTimeout,clearTimeout,loggedOut:()=>logouts++,CodexPlatform:{request:()=>new Promise(r=>resolve=r)}};c.globalThis=c;vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('const q =')),c);return {c,S,respond:()=>resolve({status:401,ok:false,json:async()=>({})}),logouts:()=>logouts};}
test('current authenticated 401 still logs out',async()=>{const t=setup(),pending=t.c.api('/api/session');t.respond();await assert.rejects(pending);assert.equal(t.logouts(),1);});
test('old 401 cannot log out a new account or task epoch',async()=>{for(const mode of ['user','epoch','startup']){const t=setup();if(mode==='startup')t.S.user=null;const pending=t.c.api('/api/session');if(mode==='epoch')t.S.epoch++;else t.S.user={id:'new'};t.respond();await assert.rejects(pending);assert.equal(t.logouts(),0,mode);}});
