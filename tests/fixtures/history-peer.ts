import {IsolatedHistoryReader} from '../../src/backend/history-reader';
import type {CodexRpcClient} from '../../src/backend/transport';
/** Independent fake history channels delegate to the fixture protocol, never
 * closing/reusing its main peer. Real socket isolation is covered separately. */
export function fakeHistoryReader(request:(method:string,params:any)=>Promise<any>){
  return new IsolatedHistoryReader(()=>{let connected=false;return {
    async connect(){connected=true;},close(){connected=false;},
    async request(method:string,params:any){if(!connected)throw Error('Fake history channel closed');return request(method,params);}
  } as unknown as CodexRpcClient;});
}
