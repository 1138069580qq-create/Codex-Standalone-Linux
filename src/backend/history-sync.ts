import {createHash} from 'node:crypto';import {ConsoleError} from './config';
const {canonical}=require('../../public/history.js');
const hash=(v:any)=>createHash('sha256').update(canonical(v)).digest('hex');
/** Authorization is performed by snapshot before any equality response. Hashes grant no access. */
export function historySync(snapshot:any,input:any){
 if(!input||typeof input!=='object'||Array.isArray(input)||input.digest!==undefined&&!/^[a-f0-9]{64}$/.test(input.digest))throw new ConsoleError(400,'INVALID_HISTORY_SYNC','Invalid local history digest.');
 const {items,...live}=snapshot,known=items.map((i:any)=>[i.id,hash(i)]),digest=hash(known);
 if(input.digest===digest)return {sync:1,unchanged:true,digest,...live};
 if(input.known===undefined)return {sync:1,needsManifest:true};
 if(!Array.isArray(input.known)||input.known.length>2000||!input.known.every((p:any)=>Array.isArray(p)&&p.length===2&&typeof p[0]==='string'&&p[0].length<=256&&/^[a-f0-9]{64}$/.test(p[1]))||new Set(input.known.map((p:any)=>p[0])).size!==input.known.length)throw new ConsoleError(400,'INVALID_HISTORY_SYNC','Invalid local history manifest.');
 const prior=new Map(input.known);return {sync:1,digest,...live,items:items.filter((i:any,index:number)=>prior.get(i.id)!==known[index][1]),order:items.map((i:any)=>i.id)};
}
