import {promises as fs} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
/** Windows scanners/readers can briefly deny atomic replacement. Retry only the
 * file rename, never the surrounding task creation or model submission. */
export async function renameStateFile(source:string,target:string,options:{platform?:NodeJS.Platform;rename?:(a:string,b:string)=>Promise<void>;wait?:(ms:number)=>Promise<unknown>}={}){
  const rename=options.rename||fs.rename,platform=options.platform||process.platform,wait=options.wait||delay;
  const waits=[15,30,60,120,240];
  for(let attempt=0;;attempt++){
    try{await rename(source,target);return;}
    catch(error){const code=(error as NodeJS.ErrnoException).code;
      if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(code||'')||attempt>=waits.length)throw error;
      await wait(waits[attempt]);
    }
  }
}
