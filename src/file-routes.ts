import {STORAGE_ID,storageDirectory,makeStorageDirectory,saveStorageFile} from './backend/account-storage';
import type Koa from "koa";
import type Router from "@koa/router";
import {ConsoleError,type Identity,type Project} from "./backend/config";
import {openProjectDownload} from "./backend/files";
import {projectPreview,ThumbnailCache} from "./backend/previews";
import {UploadSessions} from "./backend/transfers";
import {downloadExternal} from "./backend/remote-files";
import {generatedImagesRoot} from "./backend/artifacts";
import {contentType,isMediaType} from "./backend/mime";
type Handler=(c:Koa.ParameterizedContext,who:Identity)=>Promise<unknown>|unknown;
type Access={root:(who:Identity,id:string,capability:"files")=>Promise<string>;wrap:(handler:Handler)=>Koa.Middleware;project:(who:Identity,id:string)=>Project;snapshot:(who:Identity,id:string,threadId:string)=>Promise<any>};
export function installFileRoutes(router:Router, access:Access) {
  const uploads=new UploadSessions(),libraryUploads=new UploadSessions((encoded,name,data)=>{const {root,folder}=JSON.parse(encoded);return saveStorageFile(root,name,data,folder);}),images=new ThumbnailCache();let previews=0,downloads=0;
  const query=(c:Koa.Context,key:string)=>{const v=c.query[key];if(typeof v!=="string"||!v||v.length>4096)throw new ConsoleError(400,"INVALID_PARAMETER","Invalid "+key);return v;};
  const body=(c:Koa.Context)=>{const b=c.request.body as any;if(!b||typeof b!=="object"||Array.isArray(b))throw new ConsoleError(400,"INVALID_BODY","A JSON object is required.");return b;};
  router.get("/files/options",access.wrap(async(c,who)=>{const id=query(c,"projectId");await access.root(who,id,"files");return {downloadHosts:access.project(who,id).downloadHosts||[],uploadBytes:4*1024*1024,downloadBytes:512*1024*1024};}));
  router.get("/files/content",access.wrap(async(c,who)=>{
    const name=query(c,"path"),root=await access.root(who,query(c,"projectId"),"files");
    const file=await openProjectDownload(root,name,{range:c.get("range"),ifRange:c.get("if-range"),ifNoneMatch:c.get("if-none-match")});
    c.set("ETag",file.etag);c.set("Last-Modified",file.modified);c.set("Accept-Ranges","bytes");c.set("Cache-Control","private, no-cache");
    const type=contentType(name),inline=c.query.inline==="1"&&(type==="application/pdf"||isMediaType(type));
    c.type=inline?type:"application/octet-stream";
    if(!inline)c.attachment(file.name);else c.set("Content-Disposition","inline");
    c.type=inline?type:"application/octet-stream"; // attachment() infers MIME; override after it.
    // Documents never gain same-origin script authority, even with a forged filename.
    c.set("Content-Security-Policy","default-src 'none'; sandbox");
    if(file.status===304){file.stream.destroy();c.status=304;return;}
    if(file.contentRange)c.set("Content-Range",file.contentRange);
    if(c.method==="HEAD"){file.stream.destroy();c.body="";}else c.body=file.stream;
    c.status=file.status;c.length=file.size;
  }));
  router.get("/files/preview",access.wrap(async(c,who)=>{
    const root=await access.root(who,query(c,"projectId"),"files");if(previews>=2)throw new ConsoleError(429,"PREVIEW_BUSY","文件预览繁忙。");
    previews++;try{return await projectPreview(root,query(c,"path"));}finally{previews--;}
  }));
  router.get("/files/image",access.wrap(async(c,who)=>{
    const file=await images.read(await access.root(who,query(c,"projectId"),"files"),query(c,"path"),c.query.full==="1");
    c.set("Cache-Control","private, no-cache");c.set("ETag",file.etag);
    if(c.get("if-none-match").split(",").map(v=>v.trim()).includes(file.etag)){c.status=304;return;}
    c.type=file.type;c.body=file.data;
  }));
  router.get('/files/generated-image',access.wrap(async(c,who)=>{
    const projectId=query(c,'projectId');await access.root(who,projectId,'files');
    const snapshot=await access.snapshot(who,projectId,query(c,'threadId'));
    const index=Number(query(c,'index')),item=snapshot.items.find((i:any)=>i.id===query(c,'itemId'));
    const name=Number.isInteger(index)&&index>=0&&index<8?item?.images?.[index]?.generated:undefined;
    if(!name)throw new ConsoleError(404,'IMAGE_NOT_FOUND','此对话中没有该图片。');
    const file=await images.read(generatedImagesRoot(),name,c.query.full==='1');
    c.set('Cache-Control','private, no-cache');c.set('ETag',file.etag);
    if(c.get('if-none-match').split(',').map(v=>v.trim()).includes(file.etag)){c.status=304;return;}
    c.type=file.type;c.body=file.data;
  }));
  const uploadRoot=async(who:Identity,projectId:string,folder:unknown)=>{const root=await access.root(who,projectId,'files');if(projectId!==STORAGE_ID)return root;await storageDirectory(root,folder||'.');return JSON.stringify({root,folder:folder||'.'});};
  const transfer=(projectId:string)=>projectId===STORAGE_ID?libraryUploads:uploads;
  router.post('/files/directory',access.wrap(async(c,who)=>{const b=body(c);if(b.projectId!==STORAGE_ID)throw new ConsoleError(400,'STORAGE_REQUIRED','请在我的文件库中新建文件夹。');return makeStorageDirectory(await access.root(who,b.projectId,'files'),b.path||'.',b.name);}));
  router.post('/uploads',access.wrap(async(c,who)=>{const b=body(c);return transfer(b.projectId).begin(who.uuid,await uploadRoot(who,b.projectId,b.path),b.name,b.size,b.hash);}));
  router.get('/uploads/:id',access.wrap(async(c,who)=>{const id=query(c,'projectId');return transfer(id).status(who.uuid,await uploadRoot(who,id,c.query.path),c.params.id);}));
  router.put('/uploads/:id',access.wrap(async(c,who)=>{const id=query(c,'projectId'),root=await uploadRoot(who,id,c.query.path),data=c.request.body;if(!Buffer.isBuffer(data))throw new ConsoleError(415,'BINARY_REQUIRED','Binary chunk required.');return transfer(id).append(who.uuid,root,c.params.id,Number(query(c,'offset')),data);}));
  router.post('/uploads/:id/commit',access.wrap(async(c,who)=>{const b=body(c),result=await transfer(b.projectId).commit(who.uuid,await uploadRoot(who,b.projectId,b.path),c.params.id);return b.projectId===STORAGE_ID&&b.path&&b.path!=='.'?{...result,path:b.path+'/'+result.path}:result;}));
  router.post("/files/external",access.wrap(async(c,who)=>{
    const b=body(c),root=await access.root(who,b.projectId,"files");
    if(typeof b.url!=="string"||typeof b.name!=="string")throw new ConsoleError(400,"INVALID_DOWNLOAD","A URL and filename are required.");
    if(downloads>=2)throw new ConsoleError(429,"DOWNLOAD_BUSY","外部下载繁忙，请稍后重试。");
    downloads++;try{return await downloadExternal(root,b.name,b.url,access.project(who,b.projectId).downloadHosts||[]);}finally{downloads--;}
  }));
  return {close(){uploads.clear();libraryUploads.clear();images.clear();}};
}
