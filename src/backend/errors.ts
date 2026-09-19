import {ConsoleError} from './config';
import {CodexRpcError} from './transport';
/** Stable diagnostics only: never disclose raw RPC messages, bodies, paths or credentials. */
export function publicBackendError(error:unknown){
  if(error instanceof ConsoleError)return {status:error.status,code:error.code,message:error.message};
  if(error instanceof CodexRpcError){
    if(error.code===-32601)return {status:502,code:'CODEX_PROTOCOL_UNSUPPORTED',message:'当前 Codex 接口不支持此操作，请更新服务器端连接组件。',rpcCode:error.code};
    if(error.code===-32602)return {status:502,code:'CODEX_PROTOCOL_MISMATCH',message:'Codex 接口参数不兼容，请检查服务器端连接组件版本。',rpcCode:error.code};
    return {status:502,code:'CODEX_RPC_REJECTED',message:'Codex 拒绝了本次请求；请检查任务访问权限或服务器状态。',rpcCode:error.code};
  }
  return {status:502,code:'BACKEND_ERROR',message:'服务器未能完成此操作，请重试；持续失败请提供诊断编号。'};
}

/** Only fixed source names and line numbers; no error messages, request paths or bodies. */
export function failureLocations(error:unknown):string[]{
 const stack=error instanceof Error?error.stack:'';
 return [...new Set((stack||'').split('\n').slice(1).flatMap(line=>{
  const match=line.match(/(?:[/\\])(server|local-devices|thread-resume|service|transport|routes)\.ts:(\d+):(\d+)\)?$/);
  return match?[`${match[1]}.ts:${match[2]}:${match[3]}`]:[];
 }))].slice(0,6);
}
