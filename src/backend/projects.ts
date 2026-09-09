import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {ConsoleError,isWithin,type ConfigStore,validateConfig} from './config';
function directoryError(error: unknown, root: string): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    throw new ConsoleError(403, 'PROJECT_DIRECTORY_DENIED', '没有目录写入或访问权限：' + root + '。请选择当前服务用户可写的目录。');
  if (code === 'ENOENT')
    throw new ConsoleError(400, 'PROJECT_PARENT_MISSING', '父目录不存在，请先建立父目录：' + path.dirname(root));
  throw error;
}
/** Read-only: use the service account's writable home, never the filesystem root. */
export function accountDirectoryName(userId:string){return createHash("sha256").update(userId).digest("hex").slice(0,24);}
export async function defaultProjectDirectory(userId?:string){
  const requested=os.homedir();
  let root=await fs.realpath(requested).catch(e=>directoryError(e,requested));
  if(root===path.parse(root).root||!(await fs.stat(root)).isDirectory())
    throw new ConsoleError(403,'PROJECT_BASE_UNAVAILABLE','当前服务账号没有可用的默认项目目录，请检查该账号的用户目录。');
  await fs.access(root,constants.W_OK|constants.X_OK).catch(e=>directoryError(e,root));
  if(userId){
    for(const segment of ["CodexProjects",accountDirectoryName(userId)]) {
      const next=path.join(root,segment);
      await fs.mkdir(next,{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")directoryError(e,next);});
      const info=await fs.lstat(next);
      if(info.isSymbolicLink()||!info.isDirectory()||await fs.realpath(next)!==next)throw new ConsoleError(403,"PROJECT_BASE_REDIRECTED","个人项目目录不能是链接。");
      root=next;
    }
    await fs.access(root,constants.W_OK|constants.X_OK).catch(e=>directoryError(e,root));
  }
  return {root,separator:path.sep};
}
/** Filename-only requests are resolved server-side; legacy absolute-path clients remain supported. */
export async function normalizeProjectCreation(input:any,userId?:string){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ConsoleError(400,'INVALID_PROJECT','请填写文件夹名称。');
  if(input.folderName===undefined)return input;
  const name=typeof input.folderName==='string'?input.folderName.trim():'';
  if(!name||name.length>100||Buffer.byteLength(name,'utf8')>240||name==='.'||name==='..'||name.includes('/')||name.includes('\\')||/[<>:"|?*\x00-\x1f\x7f]/.test(name)||/[.]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    throw new ConsoleError(400,'INVALID_FOLDER_NAME','请输入一个有效的文件夹名称，不要填写路径或使用特殊字符。');
  if(input.root!==undefined)throw new ConsoleError(400,'INVALID_PROJECT','固定目录模式不能另外指定完整路径。');
  const directory=await defaultProjectDirectory(userId);
  if(input.baseRoot!==directory.root)throw new ConsoleError(409,'PROJECT_BASE_CHANGED','默认目录已变化，请关闭后重新打开创建窗口。');
  return {...input,folderName:name,name,root:path.join(directory.root,name),createDirectory:true};
}
/** Validate a single directory without creating anything or exposing private roots. */
export async function prepareProjectDirectory(config:ConfigStore,input:any){
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.root!=='string'||!path.isAbsolute(input.root)||input.root.includes('\0')||input.confirmDirectory!==true||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.requestId||''))throw new ConsoleError(400,'INVALID_PROJECT','请填写项目名称、服务器绝对路径并确认目录。');
  const requested=path.resolve(input.root),existing=await fs.realpath(requested).catch(e=>{if(e.code!=='ENOENT')directoryError(e,requested);return null;});
  if(input.folderName!==undefined&&existing&&existing!==requested)throw new ConsoleError(409,'PROJECT_PATH_REDIRECTED','这个文件夹指向其他目录，请换一个文件夹名称。');
  if(!existing&&input.createDirectory!==true)throw new ConsoleError(400,'PROJECT_DIRECTORY_MISSING','目录不存在，请选择新建目录。');
  const root=existing||path.join(await fs.realpath(path.dirname(requested)).catch(e=>directoryError(e,requested)),path.basename(requested));
  const home=await fs.realpath(os.homedir()),codex=await fs.realpath(process.env.CODEX_HOME||path.join(home,'.codex')).catch(()=>path.resolve(process.env.CODEX_HOME||path.join(home,'.codex'))),privateDir=await fs.realpath(path.dirname(config.file));
  if(root===path.parse(root).root||root===home||isWithin(root,codex)||isWithin(codex,root)||isWithin(root,privateDir)||isWithin(privateDir,root)||isWithin(privateDir+'-chats',root)||isWithin(root,privateDir+'-chats'))throw new ConsoleError(400,'PRIVATE_PROJECT_ROOT','不能使用系统根目录、用户主目录或 Codex/WebUI 私有目录。');
  if(config.value.projects.some(p=>p.root!==root&&(isWithin(p.root,root)||isWithin(root,p.root))))throw new ConsoleError(400,'PROJECT_OVERLAP','项目目录不能重叠。');
  if(existing&&!(await fs.stat(root)).isDirectory())throw new ConsoleError(400,'INVALID_PROJECT','项目路径不是目录。');
  return {root,missing:!existing};
}
export async function materializeProjectDirectory(config:ConfigStore,prepared:{root:string;missing:boolean},name:string){
  if(prepared.missing) {
    try { await fs.mkdir(prepared.root,{recursive:false,mode:0o700}); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')directoryError(error,prepared.root); }
  }
  if(!(await fs.stat(prepared.root).catch(e=>directoryError(e,prepared.root))).isDirectory())
    throw new ConsoleError(400,'INVALID_PROJECT','项目路径不是目录。');
  if(await fs.realpath(prepared.root)!==prepared.root)throw new ConsoleError(409,'ROOT_CHANGED','项目目录已改变。');
  await validateConfig({...config.value,projects:[...config.value.projects.filter(p=>p.root!==prepared.root),{id:'validate-project-root',name,root:prepared.root,grants:[]}]});
}
