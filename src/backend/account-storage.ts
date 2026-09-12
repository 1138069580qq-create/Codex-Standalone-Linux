import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ConsoleError,type Identity} from './config';
import {projectReference,parseRelativePath} from './files';
export const STORAGE_ID='account-storage';
export function storagePath(configFile:string,who:Identity){if(!who.uuid)throw new ConsoleError(401,'LOGIN_REQUIRED','请登录。');return path.join(path.dirname(configFile),'account-files',createHash('sha256').update(who.uuid).digest('hex'));}
export async function ensureStorage(configFile:string,who:Identity){
 const root=storagePath(configFile,who),base=path.dirname(root);
 for(const dir of [base,root]){await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await fs.lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(dir)!==dir)throw new ConsoleError(403,'STORAGE_ROOT_CHANGED','文件库目录不安全。');}
 return root;
}
export async function storageDirectory(root:string,relative:unknown='.'){
 const rel=await projectReference(root,String(relative)),target=path.join(root,rel);if(!(await fs.stat(target)).isDirectory())throw new ConsoleError(400,'NOT_DIRECTORY','请选择文件夹。');return target;
}
async function inDirectory<T>(root:string,relative:unknown,operation:(directory:string)=>Promise<T>):Promise<T>{
 const directory=await storageDirectory(root,relative);
 if(process.platform!=='linux')return operation(directory);
 const handles:Awaited<ReturnType<typeof fs.open>>[]=[];
 try{let handle=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(handle);
  for(const part of path.relative(root,directory).split(path.sep).filter(Boolean)){handle=await fs.open('/proc/self/fd/'+handle.fd+'/'+part,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(handle);}
  const result=await operation('/proc/self/fd/'+handle.fd);
  const after=await storageDirectory(root,relative),current=await fs.stat(after),opened=await handle.stat();if(current.ino!==opened.ino||current.dev!==opened.dev)throw new ConsoleError(409,'PATH_CHANGED','目录在操作期间变化，请刷新。');return result;
 }finally{for(const handle of handles.reverse())await handle.close();}
}
export async function makeStorageDirectory(root:string,relative:unknown,name:unknown){
 if(typeof name!=='string'||!name.trim()||name!==name.trim()||name.includes('/')||name.includes('\\')||name==='.'||name==='..')throw new ConsoleError(400,'INVALID_NAME','请输入文件夹名称。');
 parseRelativePath(name,false);const parent=await storageDirectory(root,relative),target=path.join(parent,name);
 try{await inDirectory(root,relative,dir=>fs.mkdir(path.join(dir,name),{mode:0o700}));}catch(e){if((e as any).code==='EEXIST')throw new ConsoleError(409,'FILE_EXISTS','同名文件或文件夹已存在。');throw e;}
 return {path:path.relative(root,target).split(path.sep).join('/')};
}
export async function saveStorageFile(root:string,name:string,data:Buffer,relative:unknown='.'){
 if(!name||name.includes('/')||name.includes('\\')||name==='.'||name==='..')throw new ConsoleError(400,'INVALID_NAME','无效文件名。');parseRelativePath(name,false);await storageDirectory(root,'.');
 try{await inDirectory(root,relative,dir=>fs.writeFile(path.join(dir,name),data,{flag:constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),mode:0o600}));}catch(e){if((e as any).code==='EEXIST')throw new ConsoleError(409,'FILE_EXISTS','同名文件已存在，请更改名称。');throw e;}
 return {path:name};
}
