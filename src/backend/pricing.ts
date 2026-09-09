import type { Price } from './usage';
/** Verified 2026-09-09. Sol intentionally uses the undiscounted list price requested by the owner.
 * These are Codex/API-equivalent estimates, not subscription invoices. Codex has no cache-write charge.
 * Unknown models (including research previews) must remain unpriced, never silently aliased.
 */
export const PRICING_SOURCE='https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing';
export function defaultCodexPrices():Price[]{
  const make=(model:string,input:number,cachedInput:number,output:number,long=false,fast=false):Price=>({
    model,input,cachedInput,output,source:PRICING_SOURCE,verifiedAt:'2026-09-09',
    ...(long?{longContext:{threshold:272000,input:input*2,cachedInput:cachedInput*2,output:output*1.5}}:{}),
    ...(fast?{fastMultiplier:2.5}:{})
  });
  return [
    make('gpt-6-astra',10,1,50,false,true),
    make('gpt-5.6-sol',5,.5,30,true,true),
    make('gpt-5.6-terra',2,.2,12,true,true),
    make('gpt-5.6-luna',.2,.02,1.2,true,true),
    make('gpt-5.5',5,.5,30,true,true),
    {...make('gpt-5.4',2.5,.25,15,true),fastMultiplier:2},
    make('gpt-5.4-mini',.75,.075,4.5),
    make('gpt-5.3-codex',1.75,.175,14),
    make('gpt-5.2',1.75,.175,14)
  ];
}
