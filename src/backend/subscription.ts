import {createHash} from 'node:crypto';
export interface AccountSubscription {
  source:'account/read';fetchedAt:number;planType:string|null;start:number|null;end:number|null;
  status:'active'|'expired'|'unavailable';reason:'period-not-provided'|'account-not-provided'|'not-subscription'|'invalid-period'|'read-failed'|null;
  /** Internal identity fingerprint; never sent to the browser. */
  accountKey?:string;
}
const record=(v:any):Record<string,any>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v:null;
function timestamp(v:any):number|null {
  let n:number;
  if(typeof v==='number'&&Number.isFinite(v)){n=v<1e11?v*1000:v;}
  else if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)){const [year,month,day]=v.slice(0,10).split('-').map(Number);if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||Number(v.slice(11,13))>23||Number(v.slice(14,16))>59||Number(v.slice(17,19))>59)return null;n=Date.parse(v);}
  else return null;
  return Number.isSafeInteger(n)&&n>=Date.UTC(2015,0,1)&&n<Date.UTC(2100,0,1)?n:null;
}
export function unavailableSubscription(reason:AccountSubscription['reason']='read-failed',fetchedAt=Date.now()):AccountSubscription{return {source:'account/read',fetchedAt,planType:null,start:null,end:null,status:'unavailable',reason};}
/** Current official account/read exposes planType, not billing dates. A configured backend may
 * explicitly extend its account.subscription metadata with currentPeriodStart/currentPeriodEnd
 * (or snake_case equivalents). Never infer dates from rate limits, token expiry, plan labels or
 * a lone renewal date. This does not query billing endpoints or read credentials. */
export function normalizeSubscription(raw:any,fetchedAt=Date.now()):AccountSubscription {
  const account=record(raw?.account),base=unavailableSubscription(account?'period-not-provided':'account-not-provided',fetchedAt);
  if(!account)return base;
  base.planType=typeof account.planType==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(account.planType)?account.planType:null;
  const identity=account.accountId??account.id??account.email;
  if(typeof identity==='string'&&identity.length>0&&identity.length<=320)base.accountKey=createHash('sha256').update(String(account.type)+':'+identity).digest('hex');
  if(account.type!=='chatgpt')return {...base,reason:'not-subscription'};
  const subscription=record(account.subscription);if(!subscription)return base;
  const camel=Object.hasOwn(subscription,'currentPeriodStart')||Object.hasOwn(subscription,'currentPeriodEnd');
  const snake=Object.hasOwn(subscription,'current_period_start')||Object.hasOwn(subscription,'current_period_end');
  if(!camel&&!snake)return base;
  if(camel&&snake)return {...base,reason:'invalid-period'};
  const start=timestamp(camel?subscription.currentPeriodStart:subscription.current_period_start),end=timestamp(camel?subscription.currentPeriodEnd:subscription.current_period_end);
  if(start===null||end===null||start>=end||start>fetchedAt||end-start>400*86400000)return {...base,reason:'invalid-period'};
  return {...base,start,end,status:end>fetchedAt?'active':'expired',reason:null};
}
